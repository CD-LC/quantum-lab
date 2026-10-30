/**
 * session.ts — who is sitting this paper.
 *
 * SERVER ONLY.
 *
 * There are two kinds of candidate and the difference between them is the whole
 * point of this file:
 *
 *   A SIGNED-IN USER is identified by a Supabase access token, verified by
 *   Supabase, exactly as `/api/billing/*` and `/api/orgs/*` do it. Their
 *   attempts are keyed on their account id, which is why an attempt resumes on
 *   a different machine, in a different browser, after the laptop died — the
 *   thing localStorage could never do. Only a user can be issued a certificate.
 *
 *   A GUEST is identified by an httpOnly cookie holding 128 bits of random.
 *   This is a PRACTICE identity and nothing more. It is not signed, and it does
 *   not need to be: forging one gets you somebody else's anonymous practice
 *   attempt, which contains no answer key (the server holds those), grants no
 *   entitlement (a guest resolves to the free plan, so the advanced paper is
 *   refused with a 402 before a single question is drawn), and can never become
 *   a certificate. What guest mode preserves is the property that actually
 *   matters: the questions are still served without answers and the score is
 *   still computed on the server from stored answers.
 *
 * Guest mode is why `/certify/foundations-cert` still works on a deployment
 * with no auth configured. It is not a loophole in the credential — the
 * credential requires an account, and `issueCertificate` refuses a guest.
 */

import { apiError } from '@/lib/apiError'
import { verifyCallerOutcome } from '@/lib/security/auth'
import type { AttemptSubject } from './types'

const GUEST_COOKIE = 'ql_exam_guest'

/** One year. A practice identity that expired mid-sitting would be worse. */
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** `guest_` + 32 hex chars. Anything else in the cookie is ignored. */
const GUEST_ID = /^guest_[0-9a-f]{32}$/

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      // A malformed escape (`%E0%A4%A`, a lone `%`) is a cookie we did not
      // write. It must read as "no cookie" — a 500 on every exam route for
      // anyone whose browser or a proxy mangled the header is not acceptable.
      continue
    }
  }
  return null
}

function isHttps(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0]?.trim().toLowerCase() === 'https'
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

function newGuestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `guest_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export interface ResolvedSubject {
  subject: AttemptSubject
  /** Set when a new guest cookie has to be sent back with the response. */
  setCookie?: string
  /**
   * Set when the caller PRESENTED an access token that could not be accepted.
   * A route MUST return this response instead of carrying on:
   *
   *   · 401 — the auth service said the token is expired, revoked or forged.
   *     The client refreshes its session and retries.
   *   · 503 (with Retry-After) — the auth service could not be reached. The
   *     token may be fine; the client retries.
   *
   * Carrying on is exactly the bug this field exists to prevent: a signed-in
   * candidate would be dealt a guest attempt that can never become a
   * certificate, and a later request would 404 on their own attempt. `subject`
   * is still populated (as a guest) only so a caller that has not yet been
   * taught to check this field behaves as it always did rather than crashing.
   */
  denied?: Response
}

/** The 401/503 for a presented token that did not verify. Fresh each call. */
function deniedResponse(kind: 'invalid' | 'unavailable'): Response {
  if (kind === 'invalid') {
    return apiError('unauthorized', {
      message: 'Your session has expired or is no longer valid. Sign in again to continue.',
    })
  }
  return apiError('upstream_unavailable', {
    status: 503,
    message: 'We could not check your sign-in just now. Try again in a moment.',
    headers: { 'Retry-After': '5' },
  })
}

/**
 * Resolve the caller.
 *
 * A valid access token always wins over a guest cookie: someone who signs in
 * mid-visit becomes themselves, and their old guest attempts stay behind rather
 * than being adopted. Adopting them would mean a certificate could be earned
 * under an identity that was anonymous when the questions were answered.
 */
export async function resolveSubject(req: Request): Promise<ResolvedSubject> {
  const outcome = await verifyCallerOutcome(req)
  if (outcome.kind === 'ok') return { subject: { kind: 'user', id: outcome.caller.id } }

  // A token was presented and could not be accepted. Not the same as no token:
  // see `ResolvedSubject.denied`.
  const denied =
    outcome.kind === 'invalid' || outcome.kind === 'unavailable'
      ? deniedResponse(outcome.kind)
      : undefined

  const existing = readCookie(req, GUEST_COOKIE)
  if (existing && GUEST_ID.test(existing)) {
    return { subject: { kind: 'guest', id: existing }, ...(denied ? { denied } : {}) }
  }

  const id = newGuestId()
  // `Secure` is added whenever the request arrived over https (directly or via
  // the proxy's x-forwarded-proto), so the one-year identity never travels in
  // plaintext in production. It is left off for plain http://localhost, where a
  // Secure cookie would be dropped and guest mode would stop working in
  // development. SameSite=Lax keeps it off cross-site requests; httpOnly keeps
  // it out of any script that manages to run.
  const secure = isHttps(req) ? '; Secure' : ''
  const setCookie = `${GUEST_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_COOKIE_MAX_AGE}${secure}`
  return { subject: { kind: 'guest', id }, setCookie, ...(denied ? { denied } : {}) }
}

/** Attach a pending guest cookie to a response. No-op when there is none. */
export function withSubjectCookie(res: Response, resolved: ResolvedSubject): Response {
  if (!resolved.setCookie) return res
  res.headers.append('set-cookie', resolved.setCookie)
  return res
}
