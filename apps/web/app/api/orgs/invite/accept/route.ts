/**
 * /api/orgs/invite/accept — claim a seat with an invite token.
 *
 * ── Why this route exists (audit finding INV-1) ──────────────
 * Acceptance used to happen entirely in the browser. `app/admin/page.tsx` read
 * `?invite=<token>`, DECODED the org id and email straight out of it, and called
 * `addMember(orgId, email, 'member', 'active')` on the store. Every input to
 * that flow came from the URL, and the old token was forgeable in two lines, so
 * "claim a seat on any organisation, as any email address" was a link you could
 * type by hand.
 *
 * The rules now, in the order they are checked:
 *
 *   1. THE TOKEN IS THE CAPABILITY. 256 bits of randomness, stored only as a
 *      SHA-256 hash. The row it finds is the only source of the org and the
 *      role — neither is accepted from the request, because both were the
 *      forged fields in the old flow.
 *   2. THE INVITE MUST BE LIVE. Not already accepted, not expired. Both read
 *      from the stored row, never from the token.
 *   3. THE CALLER MUST BE SIGNED IN. Identity comes from a Supabase-verified
 *      access token, so the seat is bound to a real account.
 *   4. THE CALLER'S VERIFIED EMAIL MUST MATCH THE INVITE'S. This is what stops
 *      a leaked link — forwarded, logged by a mail scanner, pasted into a chat
 *      — from being usable by whoever found it. The email compared is the one
 *      Supabase returns for the token, never one from the request body.
 *   5. SINGLE USE. The invite is burned with a conditional update that only
 *      succeeds if it was still unclaimed, and the seat is written only if that
 *      update won. Two requests racing on one link cannot both take a seat.
 *
 * ZERO-CONFIG PATH: with no Supabase project there is no server-side storage,
 * so this answers 501 and the admin console falls back to the browser-local
 * flow. That path is a demo of the UI against localStorage, which contains only
 * what this browser put there — there is nothing to steal.
 */

import { NextResponse } from 'next/server'
import {
  claimSeat,
  getOrg,
  getInviteByToken,
  isSeatLimitError,
  listMembers,
  markInviteAccepted,
  releaseInvite,
} from '@/lib/orgs/store'
import { isInviteAccepted, isInviteExpired, isInviteToken } from '@/lib/orgs/invites'
import { inviteLookupContext } from '@/lib/orgs/access'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCaller } from '@/lib/security/auth'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import { apiError, errorForStatus } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** One sentence for every rejection. See the note below. */
const NOT_VALID = 'That invite link is not valid, has expired, or has already been used.'

/**
 * Every rejection from this file, in the one shape lib/apiError.ts defines:
 * `{ error, code }`. The status argument is kept because forty call sites pass
 * one; the machine-readable code is derived from it.
 */
function bad(message: string, status: number): Response {
  return errorForStatus(status, message)
}

export async function POST(req: Request): Promise<Response> {
  // A token is 256 bits and cannot be brute-forced at any request rate, so this
  // limiter is about the database work an anonymous caller can cause, not about
  // guessing. Per instance only — see lib/security/ratelimit.ts.
  const limit = check(clientKey(req.headers, 'orgs-invite-accept'), 10, 60_000)
  if (!limit.allowed) {
    return apiError('rate_limited', {
      message: 'Too many attempts. Wait a minute and try again.',
      headers: retryHeaders(limit),
    })
  }

  const parsed = await readJsonBody(req, 4_096)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  if (!isRecord(parsed.value)) return bad('Expected a JSON object.', 400)

  const tokenResult = str(parsed.value.token, 512, 'token')
  if (!tokenResult.ok) return bad(tokenResult.error, 400)
  const token = tokenResult.value
  // Cheap shape check before hashing and querying.
  if (!isInviteToken(token)) return bad(NOT_VALID, 404)

  if (!isSupabaseConfigured) {
    return bad(
      'Server-side invites are not configured on this deployment.',
      501
    )
  }

  // (3) Identity from a verified token. Note this runs BEFORE the invite is
  // looked up: an anonymous caller learns nothing about whether a token exists.
  const caller = await verifiedCaller(req)
  if (!caller) return signInRequired()

  const ctx = inviteLookupContext()
  if (!ctx) {
    // No service-role key: the seat write below cannot be made (RLS lets only
    // an owner or admin insert into org_members, and the invitee is neither
    // yet). Refuse rather than half-complete the claim.
    return bad(
      'Server-side invites need SUPABASE_SERVICE_ROLE_KEY to be configured.',
      501
    )
  }

  try {
    // (1) The token is the only key. Org and role come from the row.
    const invite = await getInviteByToken(token, ctx)
    // One sentence for "no such invite", "already used" and "expired". A
    // distinct message for each would tell a caller holding a random token
    // which of those it was, which is a small oracle for no benefit — the
    // person who legitimately holds the link gets the same sentence and asks
    // their admin either way.
    if (!invite) return bad(NOT_VALID, 404)
    // (2) Live, per the stored row.
    if (isInviteAccepted(invite) || isInviteExpired(invite)) return bad(NOT_VALID, 404)

    // (4) The verified email must be the invited one. Case-insensitive, because
    // mailbox capitalisation is not identity; trimmed, because the stored value
    // was normalised at mint time.
    const callerEmail = caller.email.trim().toLowerCase()
    if (!callerEmail || callerEmail !== invite.email.trim().toLowerCase()) {
      return NextResponse.json(
        {
          error:
            'This invitation was sent to a different email address. ' +
            'Sign in as the person it was sent to, or ask for a new invite.',
          code: 'forbidden',
        },
        { status: 403 }
      )
    }

    const org = await getOrg(invite.orgId, ctx)
    if (!org) return bad(NOT_VALID, 404)

    // Capacity is enforced by claimSeat (SeatLimitError, with a post-write
    // re-count). A held seat is converted, not added, so no new capacity here.
    const members = await listMembers(invite.orgId, ctx)
    const held = members.find((m) => m.email.toLowerCase() === callerEmail)
    // The invite is only good while the seat minted with it is still held.
    // POST /api/orgs/invite always creates the 'invited' seat alongside the
    // token, so a missing seat means an admin removed the pending invitee, and
    // a suspended one means an admin shut that seat. Neither may be revived by
    // an old link, and the role comes from the seat, which an admin may have
    // changed since the invite was minted. Same sentence as any dead link.
    if (!held || held.status === 'suspended') return bad(NOT_VALID, 404)

    // (5) Burn first, write second. If this loses the race it returns false and
    // nothing is written — better a claim that has to be retried than two seats
    // taken by one link.
    const burned = await markInviteAccepted(invite.id, ctx)
    if (!burned) return bad(NOT_VALID, 404)

    // The role comes from the INVITE ROW, never from the request.
    //
    // FIX (invite acceptance): the seat is BOUND TO THE ACCOUNT, not merely
    // flipped to 'active'. Every authorisation check keys on
    // `org_members.user_id` — requireOrgRole, getEntitlement, the RLS helper
    // is_org_member, the progress routes — and an invited seat is held by
    // email with user_id NULL. Writing only `status` left every invitee with a
    // green seat they could not use: 403 from every /api/orgs route and a Free
    // entitlement. `caller.id` is the Supabase-verified account whose email
    // matched the invite in step (4); nothing from the request body names it.
    let member: Awaited<ReturnType<typeof claimSeat>> = null
    try {
      member = await claimSeat(invite.orgId, held.id, caller.id, ctx)
    } catch (claimErr) {
      // The invite was burned above. Hand it back so the invitee is not left
      // with a dead link after a failed claim (licence filled concurrently,
      // transient database error), then let the handler report the failure.
      await releaseInvite(invite.id, ctx)
      throw claimErr
    }
    // A null here means the bind did not happen. Reporting success would be
    // the exact bug this fixes, so say so, and keep the link usable.
    if (!member) {
      await releaseInvite(invite.id, ctx)
      return bad('Could not claim that seat. Try again in a moment.', 500)
    }

    return NextResponse.json({ member, org }, { status: 200 })
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
        },
        { status: 409 }
      )
    }
    // Never echo a PostgREST message: it names tables, columns and policies.
    console.error('[api/orgs/invite/accept POST]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/invite/accept POST' })
    return bad('Could not claim that seat. Try again in a moment.', 500)
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
