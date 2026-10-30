/**
 * /api/orgs/invite — mint and resolve seat invitations.
 *
 * POST creates the invite AND holds the seat (the new member row is added with
 * status 'invited'), so capacity is checked here exactly as it is in
 * /api/orgs/members — an invite that cannot become a seat is a broken promise.
 *
 * NOTE ON DELIVERY: the invite is emailed when RESEND_API_KEY is set, and the
 * response reports the outcome as { emailSent, emailReason? }. Delivery is best
 * effort — the response always carries the URL so an admin can share it by hand,
 * which is the only path that works with email unconfigured.
 */

import { NextResponse } from 'next/server'
import {
  addMember,
  createInviteRecord,
  getInviteByToken,
  getOrg,
  isSeatLimitError,
  listMembers,
  seatUsage,
} from '@/lib/orgs/store'
import {
  buildInviteRecord,
  buildInviteUrl,
  INVITE_TTL_DAYS,
  isInviteAccepted,
  isInviteExpired,
  isInviteToken,
  isPlausibleEmail,
  mailSafeOrgName,
  mintInviteToken,
} from '@/lib/orgs/invites'
import { isOrgRole, type OrgInvite } from '@/lib/orgs/types'
import { sendEmail } from '@/lib/email/client'
import { orgInvite } from '@/lib/email/templates'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCallerId } from '@/lib/security/auth'
import {
  MANAGE_ROLES,
  inviteLookupContext,
  ownerOnlyDenied,
  requireOrgRole,
} from '@/lib/orgs/access'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { email as validEmail, readJsonBody, str } from '@/lib/security/validate'
import { apiError, errorForStatus } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'

/**
 * SECURITY FIX — unauthenticated invite minting and mail sending
 * (audit finding ORG-1 / MAIL-1).
 *
 * POST here both HOLDS A SEAT on someone else's licence and SENDS AN EMAIL from
 * the app's verified sending domain to an address the caller chooses. Neither
 * needed a credential. Anonymous callers could therefore burn a paying team's
 * seats and use the product's sender reputation to deliver mail.
 *
 * Same shape as app/api/orgs/members/route.ts, and now with the same two halves:
 * AUTHENTICATION via `verifiedCallerId` (lib/security/auth.ts) and per-org
 * AUTHORISATION via `requireOrgRole` (lib/orgs/access.ts) — an invite may only
 * be minted by an owner or admin OF THE ORG BEING INVITED TO, and only an owner
 * may invite someone straight in as an owner.
 */

/** Reads searchParams and the request origin — never prerender this. */
export const dynamic = 'force-dynamic'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Every rejection from this file, in the one shape lib/apiError.ts defines:
 * `{ error, code }`. The status argument is kept because forty call sites pass
 * one; the machine-readable code is derived from it.
 */
function bad(message: string, status: number): Response {
  return errorForStatus(status, message)
}

/**
 * The invite, minus `tokenHash` (audit finding INV-1).
 *
 * The hash is not the secret and cannot be reversed, but it is a stored
 * credential-shaped value and a caller has no use for it — they are holding the
 * token already. Nothing that leaves this process needs it.
 */
function publicInvite(invite: OrgInvite): Omit<OrgInvite, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...rest } = invite
  return rest
}

function originOf(req: Request): string {
  try {
    return new URL(req.url).origin
  } catch {
    return ''
  }
}

// ── POST { orgId, email, role } ───────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // SECURITY FIX (audit finding RATE-1 / MAIL-1): an accepted request sends
  // mail. Tighter than the other org routes for that reason. PER INSTANCE only
  // — see the warning in lib/security/ratelimit.ts.
  const limit = check(clientKey(req.headers, 'orgs-invite'), 5, 60_000)
  if (!limit.allowed) {
    return apiError('rate_limited', {
      message: 'Too many invitations from this address. Wait a minute and retry.',
      headers: retryHeaders(limit),
    })
  }

  // SECURITY FIX (audit finding ORG-1): minting an invite is a privileged act.
  let callerId: string | null = null
  if (isSupabaseConfigured) {
    callerId = await verifiedCallerId(req)
    if (callerId === null) return signInRequired()
  }

  // SECURITY FIX (audit finding VAL-1): byte-capped parse instead of req.json().
  const parsed = await readJsonBody(req, 8_192)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  const body: unknown = parsed.value
  if (!isRecord(body)) return bad('Expected a JSON object.', 400)

  const orgIdResult = str(body.orgId, 128, 'orgId')
  if (!orgIdResult.ok) return bad(orgIdResult.error, 400)
  const orgId = orgIdResult.value

  const emailResult = validEmail(body.email)
  if (!emailResult.ok) return bad(emailResult.error, 400)
  const email = emailResult.value

  const role = isOrgRole(body.role) ? body.role : 'member'

  if (!isPlausibleEmail(email)) return bad('That does not look like an email address.', 400)

  // SECURITY FIX (audit finding ORG-1, authorisation half): burning a seat on
  // someone else's licence — and sending mail from the product's domain — now
  // requires an owner/admin seat in THAT org.
  const access = await requireOrgRole(req, orgId, MANAGE_ROLES, callerId)
  if (!access.ok) return access.response
  const escalation = ownerOnlyDenied(access.membership, role === 'owner')
  if (escalation) return escalation

  // SECURITY FIX (audit finding ORG-2): every store call below is made with the
  // verified caller's context. Without it the handler read and wrote an empty
  // server-side store, so a permitted invite silently did nothing.
  const ctx = access.context

  try {
    const org = await getOrg(orgId, ctx)
    if (!org) return bad('That organisation could not be found.', 404)

    const seats = await seatUsage(orgId, ctx)
    if (Number.isFinite(seats.total) && seats.used >= seats.total) {
      return NextResponse.json(
        {
          error:
            'All seats on this licence are in use, so the invite would have ' +
            'nowhere to land. Suspend or remove a member, or add seats.',
          code: 'conflict',
          seatsUsed: seats.used,
          seatsTotal: seats.total,
          upgradeUrl: '/pricing',
        },
        { status: 409 }
      )
    }

    // Mail-relay guards (audit finding MAIL-1, org-name half). Both limits use
    // the SHARED limiter, keyed on the verified caller and on the target
    // address, so neither resets on a cold start or spans instances:
    //   • per inviter: a manager can mint a few dozen invitations an hour;
    //   • per recipient address: the same mailbox is mailed at most 3 times a
    //     day from this product, whoever asks, so a Team org cannot be used to
    //     hammer one third party.
    // A resend to an address that already holds a seat is legitimate and is
    // allowed within those caps; mail is never sent to a seat that is already
    // active (nothing to accept), and the response still carries the link.
    const perCaller = await rateLimit(callerKey(req.headers, 'orgs-invite-mail', callerId), {
      limit: 30,
      windowMs: 60 * 60_000,
    })
    if (!perCaller.allowed) {
      return apiError('rate_limited', {
        message: 'Too many invitations sent recently. Try again later.',
        headers: retryAfterHeaders(perCaller),
      })
    }
    const perRecipient = await rateLimit(`orgs-invite-to:${email.toLowerCase()}`, {
      limit: 3,
      windowMs: 24 * 60 * 60_000,
    })
    if (!perRecipient.allowed) {
      return apiError('rate_limited', {
        message: 'That address has already been sent several invitations today.',
        headers: retryAfterHeaders(perRecipient),
      })
    }

    const existing = (await listMembers(orgId, ctx)).find(
      (m) => m.email.toLowerCase() === email.toLowerCase()
    )

    // Holding the seat and issuing the token are one action from the admin's
    // point of view, so they happen together.
    const member = await addMember(orgId, email, role, 'invited', ctx)

    // SECURITY FIX (audit finding INV-1): a 32-byte random token, of which only
    // the SHA-256 hash is persisted. The old scheme encoded (orgId, email)
    // reversibly with a djb2 checksum, so anyone could mint a token for any org
    // and email pair. The raw token exists only in this scope and in the URL
    // below — it is never stored, never logged, and cannot be recovered.
    const { token, tokenHash } = await mintInviteToken()
    const stored = await createInviteRecord(
      buildInviteRecord(orgId, email, role, tokenHash),
      ctx
    )
    const url = buildInviteUrl(token, originOf(req))

    // ── Email delivery ──────────────────────────────────────
    // Best effort, and deliberately after the invite exists. sendEmail never
    // throws and returns { sent: false, reason } when email is unconfigured or
    // the provider is down, so a delivery failure never invalidates a perfectly
    // good invite — the copyable `url` above remains the fallback.
    const message = orgInvite({
      orgName: mailSafeOrgName(org.name),
      inviterEmail: 'An administrator',
      role,
      acceptUrl: url,
      expiresInDays: INVITE_TTL_DAYS,
    })
    const delivery =
      existing?.status === 'active'
        ? ({ sent: false, reason: 'already_member' } as const)
        : await sendEmail({
            to: email,
            subject: message.subject,
            html: message.html,
            text: message.text,
          })

    return NextResponse.json(
      {
        // SECURITY (audit finding INV-1): `url` carries the raw token — it is
        // the whole point of the response and the only copy that will ever
        // exist. `stored` deliberately does not: publicInvite strips the hash.
        invite: publicInvite(stored),
        url,
        member,
        emailed: delivery.sent,
        emailSent: delivery.sent,
        ...(delivery.sent ? {} : { emailReason: delivery.reason }),
      },
      { status: 201 }
    )
  } catch (err) {
    if (isSeatLimitError(err)) {
      return NextResponse.json(
        {
          // `err.message` is safe to forward here and ONLY here: isSeatLimitError
          // narrows to an error this codebase constructs, whose message is
          // written for the admin reading it. No provider error reaches this.
          error: err.message,
          code: 'conflict',
          seatsUsed: err.seatsUsed,
          seatsTotal: Number.isFinite(err.seatsTotal) ? err.seatsTotal : null,
          upgradeUrl: '/pricing',
        },
        { status: 409 }
      )
    }
    console.error('[api/orgs/invite POST]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/invite POST' })
    return bad('Could not create that invite. Try again in a moment.', 500)
  }
}

// ── GET ?token= ───────────────────────────────────────────────

/**
 * SECURITY FIX (audit finding INV-1): resolution is a LOOKUP, never a decode.
 *
 * The old handler decoded the org and email out of the token and, if no row
 * existed, rebuilt a whole invite from the token alone — which is precisely why
 * a forged token worked: the flow never needed a row to exist. A token now
 * carries no data at all, so the only way to learn what an invite names is to
 * find its hash in storage. No row, no invite.
 *
 * Bounded to a fixed-shape token so an anonymous caller cannot make the server
 * hash a megabyte of text (audit finding VAL-1).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const tokenResult = str(new URL(req.url).searchParams.get('token'), 512, 'token')
    if (!tokenResult.ok) return bad(tokenResult.error, 400)
    const token = tokenResult.value
    if (!isInviteToken(token)) return bad('That invite link is not valid.', 404)

    // Resolving an invite is deliberately anonymous — the recipient clicks the
    // link before signing in — so the token is the only credential, which is
    // exactly why it had to become unguessable. See inviteLookupContext.
    const ctx = inviteLookupContext()
    const invite = await getInviteByToken(token, ctx)
    if (!invite) return bad('That invite link is not valid.', 404)

    if (isInviteAccepted(invite)) {
      return NextResponse.json({
        invite: publicInvite(invite),
        org: await getOrg(invite.orgId, ctx),
        alreadyAccepted: true,
      })
    }

    if (isInviteExpired(invite)) {
      return NextResponse.json(
        {
          error: 'This invite has expired. Ask an admin to send a new one.',
          // 410 Gone, not one of lib/apiError.ts's statuses, because "it
          // existed and is now permanently unusable" is exactly what 410 means
          // and the admin console distinguishes it from a bad token. The CODE
          // is `conflict`, which is the closest closed-set member — a caller
          // branching on the code gets the right behaviour either way.
          code: 'conflict',
          invite: publicInvite(invite),
        },
        { status: 410 }
      )
    }

    return NextResponse.json({
      invite: publicInvite(invite),
      org: await getOrg(invite.orgId, ctx),
    })
  } catch (err) {
    console.error('[api/orgs/invite GET]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/invite GET' })
    return bad('Could not resolve that invite. Try again in a moment.', 500)
  }
}

/**
 * 401 in the canonical shape.
 *
 * `signInRequiredResponse()` in lib/security/auth.ts returns `{ error }` with no
 * `code`, and that file belongs to another workstream — so this wraps it rather
 * than editing it, reusing SIGN_IN_REQUIRED so the sentence stays identical
 * across every route that refuses an anonymous caller. Delete this when
 * lib/security/auth.ts adopts lib/apiError.ts.
 */
function signInRequired(): Response {
  return apiError('unauthorized', { message: SIGN_IN_REQUIRED })
}
