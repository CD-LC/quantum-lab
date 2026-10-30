/**
 * /api/orgs/members — seat management.
 *
 * Two rules live here that must never be left to the browser:
 *
 *  1. THE SEAT CAP. addMember() in lib/orgs/store.ts throws a SeatLimitError as
 *     a courtesy so the UI can be helpful, but a caller can simply not run that
 *     code. Capacity is therefore re-checked here and answered with a 409.
 *
 *  2. THE LAST OWNER. Removing or demoting the final owner locks everyone out
 *     of their own licence — the classic org-management lockout bug. Both are
 *     refused with a 400 that names the reason.
 */

import { NextResponse } from 'next/server'
import {
  addMember,
  isSeatLimitError,
  listMembers,
  removeMember,
  seatUsage,
  setMemberRole,
  setMemberStatus,
} from '@/lib/orgs/store'
import { isOrgMemberStatus, isOrgRole, type OrgMember } from '@/lib/orgs/types'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCallerId } from '@/lib/security/auth'
import {
  MANAGE_ROLES,
  READ_ROLES,
  ownerOnlyDenied,
  requireOrgRole,
} from '@/lib/orgs/access'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { email as validEmail, readJsonBody, str } from '@/lib/security/validate'
import { apiError, errorForStatus } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'

/**
 * SECURITY FIX — missing authentication AND authorisation (audit finding ORG-1).
 *
 * Every method in this file was once reachable anonymously. The file header
 * claims two rules "must never be left to the browser" — the seat cap and the
 * last owner — but the rule it never enforced at all is WHO IS ASKING. An
 * anonymous caller could POST themselves into any org as `owner` with status
 * `active`, PATCH an existing owner down to `member`, DELETE members, and GET
 * the full membership list (an email harvest) of any org whose id they knew.
 *
 * The audit added AUTHENTICATION ("present a valid Supabase token") and left
 * AUTHORISATION open, so any signed-in user could still do all of the above to
 * an org they had nothing to do with. Both halves are now closed:
 *
 *   authentication — `verifiedCallerId` (lib/security/auth.ts): the caller is
 *                    whoever the token says, never whoever the body says.
 *   authorisation  — `requireOrgRole` (lib/orgs/access.ts): the caller must
 *                    hold an active, sufficiently privileged membership row for
 *                    THE ORG IN THE REQUEST. Reads need any active seat;
 *                    mutations need owner or admin; anything that grants or
 *                    removes the owner role needs owner.
 *
 * Only enforced when Supabase is configured: with an empty environment the
 * store is browser-localStorage-only, these handlers operate on an empty
 * server-side database, and requiring a token would break the demo path for no
 * security gain.
 */

/** Returns a 401 response when the caller cannot be identified, else null. */
async function requireCaller(req: Request): Promise<{ denied: Response } | { callerId: string | null }> {
  if (!isSupabaseConfigured) return { callerId: null }
  const caller = await verifiedCallerId(req)
  if (caller) return { callerId: caller }
  return { denied: signInRequired() }
}

function isDenied(
  result: { denied: Response } | { callerId: string | null }
): result is { denied: Response } {
  return 'denied' in result
}

/** Shared per-instance limiter for the mutating methods. See lib/security/ratelimit.ts. */
function rateLimit(req: Request): Response | null {
  const limit = check(clientKey(req.headers, 'orgs-members'), 30, 60_000)
  if (limit.allowed) return null
  return apiError('rate_limited', { headers: retryHeaders(limit) })
}

/** Reads searchParams — must not be prerendered during `next build`. */
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

function activeOwners(members: OrgMember[]): OrgMember[] {
  return members.filter((m) => m.role === 'owner' && m.status !== 'suspended')
}

const LAST_OWNER_MESSAGE =
  'This is the only owner of the organisation. Promote another member to owner ' +
  'first — removing the last owner would lock everyone out of the licence.'

// ── GET ?orgId= ───────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  try {
    // SECURITY FIX (audit finding ORG-1): the member list is every colleague's
    // email address. Reading it requires a signed-in caller (401) who holds an
    // active seat in THIS org (403) — not merely a seat somewhere.
    const auth = await requireCaller(req)
    if (isDenied(auth)) return auth.denied

    const orgIdParam = new URL(req.url).searchParams.get('orgId')
    // SECURITY FIX (audit finding VAL-1): bound the id before it reaches a query.
    const checked = str(orgIdParam, 128, 'orgId')
    if (!checked.ok) return bad(checked.error, 400)
    const orgId = checked.value

    const access = await requireOrgRole(req, orgId, READ_ROLES, auth.callerId)
    if (!access.ok) return access.response

    // SECURITY FIX (audit finding ORG-2): the store is handed the verified
    // caller and a client that acts for them. Without this the read ran with no
    // server-side identity at all and returned an empty list from localStorage.
    const ctx = access.context
    const [members, seats] = await Promise.all([
      listMembers(orgId, ctx),
      seatUsage(orgId, ctx),
    ])
    return NextResponse.json({
      members,
      // JSON has no Infinity: unlimited serialises as null.
      seats: {
        used: seats.used,
        total: Number.isFinite(seats.total) ? seats.total : null,
        available: Number.isFinite(seats.available) ? seats.available : null,
      },
    })
  } catch (err) {
    console.error('[api/orgs/members GET]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/members GET' })
    return NextResponse.json({ members: [], seats: { used: 0, total: null, available: null } })
  }
}

// ── POST { orgId, email, role } ───────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // SECURITY FIX (audit finding ORG-1): adding a seat — including adding
  // yourself as `owner` — required no credential at all before this line.
  const limited = rateLimit(req)
  if (limited) return limited
  const auth = await requireCaller(req)
  if (isDenied(auth)) return auth.denied

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
  const status = isOrgMemberStatus(body.status) ? body.status : 'invited'

  // SECURITY FIX (audit finding ORG-1): "POST {orgId, email, role:'owner'}
  // adds yourself as an owner of any org whose id you know" was the sharpest
  // edge of this finding. The caller must now hold an owner/admin seat in that
  // org, and only an owner may mint another owner.
  const access = await requireOrgRole(req, orgId, MANAGE_ROLES, auth.callerId)
  if (!access.ok) return access.response
  const escalation = ownerOnlyDenied(access.membership, role === 'owner')
  if (escalation) return escalation

  try {
    // Server-side capacity check. Deliberately duplicated with the store: the
    // store's check is a courtesy the client can skip, this one it cannot.
    const seats = await seatUsage(orgId, access.context)
    if (Number.isFinite(seats.total) && seats.used >= seats.total) {
      return NextResponse.json(
        {
          error:
            'All seats on this licence are in use. Suspend or remove a member, ' +
            'or add seats to your plan.',
          code: 'conflict',
          seatsUsed: seats.used,
          seatsTotal: seats.total,
          upgradeUrl: '/pricing',
        },
        { status: 409 }
      )
    }

    // SECURITY FIX (audit finding ORG-2): server-side identity, see GET above.
    const member = await addMember(orgId, email, role, status, access.context)
    return NextResponse.json({ member }, { status: 201 })
  } catch (err) {
    if (isSeatLimitError(err)) {
      // `err.message` is safe to forward here and ONLY here: isSeatLimitError
      // narrows to an error this codebase constructs, whose message is written
      // for the admin reading it. No provider error reaches this branch.
      return NextResponse.json(
        {
          error: err.message,
          code: 'conflict',
          seatsUsed: err.seatsUsed,
          seatsTotal: Number.isFinite(err.seatsTotal) ? err.seatsTotal : null,
          upgradeUrl: '/pricing',
        },
        { status: 409 }
      )
    }
    console.error('[api/orgs/members POST]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/members POST' })
    return bad('Could not add that member. Try again in a moment.', 500)
  }
}

// ── PATCH { orgId, memberId, role?, status? } ─────────────────

export async function PATCH(req: Request): Promise<Response> {
  // SECURITY FIX (audit finding ORG-1): role changes are privilege changes.
  const limited = rateLimit(req)
  if (limited) return limited
  const auth = await requireCaller(req)
  if (isDenied(auth)) return auth.denied

  // SECURITY FIX (audit finding VAL-1): byte-capped parse instead of req.json().
  const parsed = await readJsonBody(req, 8_192)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  const body: unknown = parsed.value
  if (!isRecord(body)) return bad('Expected a JSON object.', 400)

  const orgIdResult = str(body.orgId, 128, 'orgId')
  if (!orgIdResult.ok) return bad(orgIdResult.error, 400)
  const orgId = orgIdResult.value

  const memberIdResult = str(body.memberId, 128, 'memberId')
  if (!memberIdResult.ok) return bad(memberIdResult.error, 400)
  const memberId = memberIdResult.value

  const role = isOrgRole(body.role) ? body.role : undefined
  const status = isOrgMemberStatus(body.status) ? body.status : undefined

  if (!role && !status) return bad('Provide a role or a status to change.', 400)

  // SECURITY FIX (audit finding ORG-1): a role change is a privilege change, so
  // it needs an owner/admin seat IN THIS ORG, not merely a valid token.
  const access = await requireOrgRole(req, orgId, MANAGE_ROLES, auth.callerId)
  if (!access.ok) return access.response
  const escalation = ownerOnlyDenied(access.membership, role === 'owner')
  if (escalation) return escalation

  try {
    // SECURITY FIX (audit finding ORG-2): server-side identity for every store call.
    const ctx = access.context
    const members = await listMembers(orgId, ctx)
    const target = members.find((m) => m.id === memberId)
    if (!target) return bad('That member is not part of this organisation.', 404)

    // …and an admin may not demote, suspend or otherwise touch an owner.
    const touchingOwner = ownerOnlyDenied(access.membership, target.role === 'owner')
    if (touchingOwner) return touchingOwner

    // Lockout guard: demoting or suspending the final owner is refused.
    const owners = activeOwners(members)
    const isLastOwner = target.role === 'owner' && owners.length <= 1
    if (isLastOwner && role && role !== 'owner') return bad(LAST_OWNER_MESSAGE, 400)
    if (isLastOwner && status === 'suspended') return bad(LAST_OWNER_MESSAGE, 400)

    let member = target
    if (role) {
      const updated = await setMemberRole(orgId, memberId, role, ctx)
      if (updated) member = updated
    }
    if (status) {
      const updated = await setMemberStatus(orgId, memberId, status, ctx)
      if (updated) member = updated
    }
    return NextResponse.json({ member })
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
    console.error('[api/orgs/members PATCH]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/members PATCH' })
    return bad('Could not update that member. Try again in a moment.', 500)
  }
}

// ── DELETE ?orgId=&memberId= ──────────────────────────────────

export async function DELETE(req: Request): Promise<Response> {
  try {
    // SECURITY FIX (audit finding ORG-1): removing a member is a destructive,
    // privileged action; it required no credential before this line.
    const limited = rateLimit(req)
    if (limited) return limited
    const auth = await requireCaller(req)
    if (isDenied(auth)) return auth.denied

    const params = new URL(req.url).searchParams
    // SECURITY FIX (audit finding VAL-1): bound both ids.
    const orgIdResult = str(params.get('orgId'), 128, 'orgId')
    if (!orgIdResult.ok) return bad(orgIdResult.error, 400)
    const orgId = orgIdResult.value
    const memberIdResult = str(params.get('memberId'), 128, 'memberId')
    if (!memberIdResult.ok) return bad(memberIdResult.error, 400)
    const memberId = memberIdResult.value

    // SECURITY FIX (audit finding ORG-1): removing a seat is destructive and
    // privileged — owner/admin in THIS org only, and only an owner may remove
    // another owner.
    const access = await requireOrgRole(req, orgId, MANAGE_ROLES, auth.callerId)
    if (!access.ok) return access.response

    // SECURITY FIX (audit finding ORG-2): server-side identity for every store call.
    const ctx = access.context
    const members = await listMembers(orgId, ctx)
    const target = members.find((m) => m.id === memberId)
    if (!target) return bad('That member is not part of this organisation.', 404)
    const escalation = ownerOnlyDenied(access.membership, target.role === 'owner')
    if (escalation) return escalation
    if (target.role === 'owner' && activeOwners(members).length <= 1) {
      return bad(LAST_OWNER_MESSAGE, 400)
    }

    const removed = await removeMember(orgId, memberId, ctx)
    return NextResponse.json({ removed })
  } catch (err) {
    console.error('[api/orgs/members DELETE]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs/members DELETE' })
    return bad('Could not remove that member. Try again in a moment.', 500)
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
