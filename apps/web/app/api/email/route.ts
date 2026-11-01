/**
 * /api/email — render a known template and hand it to the provider.
 *
 * The template set is closed: `type` selects one of four functions and the
 * caller can never supply raw HTML. An endpoint that accepts arbitrary bodies
 * and arbitrary recipients is a spam relay wearing a product's sender
 * reputation, so the only inputs here are a type, a recipient, and typed data.
 *
 * A closed template set was never enough on its own, and this route has now
 * been holed twice for the same underlying reason — that "closed set" was
 * mistaken for "safe". MAIL-1: the templates put a caller-supplied URL behind a
 * "Sign in" button. And, until this change, the recipient was whoever the
 * caller named. Both fixes are marked in place below. The rule to keep: every
 * value that reaches a real inbox must be either written in this repository or
 * checked against something the server verified itself.
 *
 * Returns 400 for anything malformed and 200 for everything else — including a
 * failed send, which is reported as { sent: false, reason } rather than a 500,
 * because "email is off" is the default state of this app, not a server fault.
 */

import { NextResponse } from 'next/server'
import { NOT_CONFIGURED_REASON, sendEmail } from '@/lib/email/client'
import { reportError } from '@/lib/observability/report'
import { examPassed, magicLink, orgInvite, welcome, type EmailContent } from '@/lib/email/templates'
import { INVITE_TTL_DAYS } from '@/lib/orgs/invites'
import { APP_URL } from '@/lib/billing/stripe'
import { SIGN_IN_REQUIRED, verifiedCaller } from '@/lib/security/auth'
import { httpUrl, readJsonBody } from '@/lib/security/validate'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import type { ApiErrorBody } from '@/lib/apiError'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── rate limit ────────────────────────────────────────────────
//
// This endpoint is unauthenticated and sends mail from the app's own verified
// domain, so the thing being protected is the sending reputation as much as the
// provider quota — a burst of mail nobody asked for gets a domain blocklisted,
// and that is not undone by turning the endpoint off afterwards.
//
// The counter used to be a Map in this process, which reset on deploy and did
// not span instances. It is now lib/rateLimit.ts, which counts in Redis when
// one is configured. Read that module's header before treating this as a
// control: it is keyed on an IP and IP rotation is cheap. A daily ceiling is
// added below the per-minute one, because 5/minute alone is 7 200 messages a
// day from a single address.

const MAX_PER_MINUTE = 5
const MAX_PER_DAY = 100

/**
 * What a caller is told when the provider refuses or is unreachable. Fixed on
 * purpose — see the end of POST. Not exported: a route module may only export
 * handlers and segment config, so lib/email/route.test.ts asserts the literal.
 */
const SEND_FAILED_REASON = 'The message could not be sent right now.'

// ── request shape ─────────────────────────────────────────────

const TYPES = ['invite', 'magic-link', 'welcome', 'exam-passed'] as const
type EmailType = (typeof TYPES)[number]

function isEmailType(value: unknown): value is EmailType {
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlausibleEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) &&
    value.trim().length <= 254
  )
}

function str(data: Record<string, unknown>, key: string, fallback = ''): string {
  const value = data[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function num(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A 400 in the canonical shape (`error` + `code`) plus the `sent: false` this
 * endpoint has always returned. The extra key is kept because it is the field
 * every caller of a mail endpoint actually wants to read, and dropping it would
 * be a breaking change for no benefit.
 */
function bad(error: string): NextResponse {
  const body: ApiErrorBody & { sent: false } = { sent: false, error, code: 'bad_request' }
  return NextResponse.json(body, { status: 400 })
}

/**
 * SECURITY FIX — open phishing relay (audit finding MAIL-1).
 *
 * The file header argues that a closed template set makes this endpoint safe.
 * It does not: the `invite` and `magic-link` templates put a CALLER-SUPPLIED
 * URL behind a "Accept invitation" / "Sign in" button, and the endpoint needs
 * no authentication. Anyone could therefore send "Sign in to Qubit16" to
 * any address, from Qubit16's own verified sending domain, pointing at
 * their own credential-harvesting page — a well-aligned, DKIM-signed,
 * SPF-passing phishing mail that no filter will flag.
 *
 * Links in transactional mail must point back at this app. The host allow-list
 * is derived from NEXT_PUBLIC_APP_URL (which defaults to http://localhost:3000,
 * so the zero-config developer flow is unaffected) plus the request's own
 * origin, which is what the org-invite route builds its URLs from.
 *
 * NOTE: `httpUrl` also rejects `javascript:` and `data:` schemes, which the
 * template's HTML-escaping did not — escaping a `javascript:` href produces a
 * perfectly functional `javascript:` href.
 */
function allowedLinkHosts(req: Request): string[] {
  const hosts = new Set<string>()
  const add = (raw: string): void => {
    try {
      hosts.add(new URL(raw).host.toLowerCase())
    } catch {
      /* a malformed origin simply contributes nothing */
    }
  }
  add(APP_URL)
  add(req.url)
  return [...hosts]
}

/** Validate one caller-supplied link, or return the 400 message to send back. */
function linkOrError(
  value: unknown,
  hosts: string[],
  label: string
): { ok: true; value: string } | { ok: false; error: string } {
  const result = httpUrl(value, 2_048, hosts, label)
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
}

/**
 * Build the message, or return an error string when the data is unusable.
 *
 * SECURITY FIX (audit finding MAIL-1): every caller-supplied URL now goes
 * through `linkOrError` against the app's own hosts. SECURITY FIX (audit
 * finding VAL-1): the free-text fields are length-capped — they are
 * interpolated into a mail body, and an unbounded `orgName` is an unbounded
 * outbound payload.
 */
function render(
  type: EmailType,
  data: Record<string, unknown>,
  hosts: string[]
): EmailContent | { error: string } | null {
  const cap = (value: string, max: number): string => value.slice(0, max)

  switch (type) {
    case 'invite': {
      const link = linkOrError(data.acceptUrl, hosts, 'data.acceptUrl')
      if (!link.ok) return { error: link.error }
      return orgInvite({
        orgName: cap(str(data, 'orgName', 'your team'), 120),
        inviterEmail: cap(str(data, 'inviterEmail', 'An administrator'), 254),
        role: cap(str(data, 'role', 'member'), 40),
        acceptUrl: link.value,
        expiresInDays: num(data, 'expiresInDays', INVITE_TTL_DAYS),
      })
    }
    case 'magic-link': {
      const link = linkOrError(data.url, hosts, 'data.url')
      if (!link.ok) return { error: link.error }
      return magicLink({ url: link.value, expiresInMinutes: num(data, 'expiresInMinutes', 15) })
    }
    case 'welcome':
      return welcome({ name: cap(str(data, 'name', 'there'), 120) })
    case 'exam-passed': {
      const link = linkOrError(data.certificateUrl, hosts, 'data.certificateUrl')
      if (!link.ok) return { error: link.error }
      const examTitle = str(data, 'examTitle')
      if (!examTitle) return null
      return examPassed({
        examTitle: cap(examTitle, 200),
        score: num(data, 'score', 0),
        certificateUrl: link.value,
      })
    }
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // The reason string is fixed and names no key, count or bucket — a caller
  // must not be able to use a 429 to learn anything about another caller.
  const key = callerKey(request.headers, 'email')
  const minute = await rateLimit(key, { limit: MAX_PER_MINUTE, windowMs: 60_000 })
  const day = minute.allowed
    ? await rateLimit(key, { limit: MAX_PER_DAY, windowMs: 86_400_000 })
    : minute
  if (!minute.allowed || !day.allowed) {
    // The message is fixed and names no key, count or bucket — a caller must
    // not be able to use a 429 to learn anything about another caller's bucket.
    // `reason` was the old key here and is gone: every non-2xx from app/api now
    // carries `error` + `code`. lib/rateLimitRoutes.test.ts asserts this body.
    return NextResponse.json(
      {
        sent: false,
        error: 'Too many messages from this address. Wait a while and retry.',
        code: 'rate_limited',
      },
      { status: 429, headers: retryAfterHeaders(minute.allowed ? day : minute) }
    )
  }

  // SECURITY FIX (audit finding VAL-1): cap the body before parsing it.
  const parsed = await readJsonBody(request, 32_768)
  if (!parsed.ok && parsed.tooLarge) {
    return NextResponse.json(
      { sent: false, error: parsed.error, code: 'payload_too_large' },
      { status: 413 }
    )
  }
  if (!parsed.ok) return bad(parsed.error)
  const body: unknown = parsed.value
  if (!isRecord(body)) return bad('Expected an object of the shape { type, to, data }.')

  if (!isEmailType(body.type)) {
    return bad(`\`type\` must be one of: ${TYPES.join(', ')}.`)
  }
  if (!isPlausibleEmail(body.to)) {
    return bad('`to` must be a single email address.')
  }

  // ── who is allowed to receive this ───────────────────────────
  //
  // FIX (this workstream): until now this endpoint would send a real message,
  // from the app's verified sending domain, to ANY address a stranger named.
  // The MAIL-1 fix closed the phishing-link hole by pinning caller-supplied
  // URLs to this app's hosts, but it left the delivery hole open: an anonymous
  // `curl` could put "Welcome to Qubit16" in 100 inboxes a day per IP, none
  // of which had asked for anything. Unsolicited mail is unsolicited mail
  // whether or not the body is one of four fixed templates.
  //
  // The rule now: a caller must present a Supabase token, and the only address
  // they may send to is the verified address on that token. There is no
  // consent record in this app, so "the person holding the account's session"
  // is the strongest available stand-in for "the person who asked" — and it
  // makes mailing a stranger structurally impossible rather than merely
  // rate-limited.
  //
  // This does NOT break org invites: /api/orgs/invite calls `sendEmail` from
  // lib/email/client directly, on the server, after its own authentication and
  // role check. It never went through this route. Nothing else in the product
  // calls this endpoint at all — see docs/ONBOARDING.md for why no lifecycle
  // email is sent from here either.
  //
  // Order matters: the rate limit above runs FIRST, so an unauthenticated
  // flood is still counted and refused rather than being handed a cheap 401
  // per request.
  const caller = await verifiedCaller(request)
  if (!caller) {
    const body401: ApiErrorBody & { sent: false } = {
      sent: false,
      error: SIGN_IN_REQUIRED,
      code: 'unauthorized',
    }
    return NextResponse.json(body401, { status: 401 })
  }
  if (body.to.trim().toLowerCase() !== caller.email) {
    // Deliberately the same message whether the account has no email at all or
    // simply a different one: a caller must not learn anything about an address
    // by probing this endpoint.
    const body403: ApiErrorBody & { sent: false } = {
      sent: false,
      error: 'This endpoint only sends to the signed-in account’s own verified address.',
      code: 'forbidden',
    }
    return NextResponse.json(body403, { status: 403 })
  }

  const data = isRecord(body.data) ? body.data : {}
  const content = render(body.type, data, allowedLinkHosts(request))
  if (!content) {
    return bad(`Missing required fields in \`data\` for the "${body.type}" template.`)
  }
  // SECURITY FIX (audit finding MAIL-1): a rejected link is reported precisely
  // so a legitimate caller can fix it, and refused so an attacker cannot use it.
  if ('error' in content) return bad(content.error)

  const result = await sendEmail({
    to: body.to.trim(),
    subject: content.subject,
    html: content.html,
    text: content.text,
  })

  if (result.sent) return NextResponse.json({ sent: true, id: result.id })

  // CONFIG-LEAK FIX: `reason` used to be the provider's own error text —
  // "API key is invalid", "domain is not verified", a fetch error naming the
  // upstream host. That is operator configuration state, and any signed-in
  // user could read it here (the same class of leak LEAK-1 closed on the
  // billing and analytics routes). It goes to the error reporter, where an
  // operator can act on it; the caller gets a fixed sentence. The one reason
  // still echoed is NOT_CONFIGURED_REASON, which is the app's own copy and
  // what the zero-config developer flow reads.
  if (result.reason === NOT_CONFIGURED_REASON) {
    return NextResponse.json({ sent: false, reason: result.reason })
  }
  reportError(new Error(result.reason), { scope: 'api.email', what: 'send', type: body.type })
  return NextResponse.json({ sent: false, reason: SEND_FAILED_REASON })
}
