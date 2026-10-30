/**
 * /api/orgs — list and create organisations.
 *
 * The admin console talks to lib/orgs/store.ts directly (so it keeps working
 * with nothing but localStorage). This route is the SERVER-SIDE surface for the
 * same data: it is where a programmatic caller lands, and where the rules that
 * must not be client-enforceable live.
 *
 * With no Supabase project configured there is no server-side storage at all,
 * so GET answers 200 with an empty array rather than an error — an unconfigured
 * deployment is a supported state, not a fault.
 */

import { NextResponse } from 'next/server'
import { createOrg, listOrgs, planCanOwnSeats } from '@/lib/orgs/store'
import { PLAN_BY_ID, type PlanId } from '@/lib/plans'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCaller, verifiedCallerId } from '@/lib/security/auth'
import { holdsPersonalLicence, orgContext, ownsOrgOnPlan } from '@/lib/orgs/access'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { email as validEmail, readJsonBody, str, uuid } from '@/lib/security/validate'
import { apiError, errorForStatus } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'

export const runtime = 'nodejs'

/**
 * SECURITY FIX — unauthenticated org creation (audit finding ORG-1).
 *
 * POST created an organisation on a named plan with a caller-supplied
 * `ownerId`, anonymously. That is both a free `team`/`edu` licence and a way to
 * plant an org owned by someone else's user id. The caller must now present a
 * Supabase access token, and `ownerId` must be that caller.
 *
 * The token-verifying helper this used to keep privately now lives in
 * lib/security/auth.ts, shared byte-for-byte with the billing routes.
 */

/**
 * Reads searchParams, so it must never be statically prerendered at build time.
 * Without this Next tries to evaluate it during `next build` and fails with a
 * dynamic-server-usage error.
 */
export const dynamic = 'force-dynamic'

const PLAN_IDS: PlanId[] = ['free', 'pro', 'team', 'edu']

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

export async function GET(req: Request): Promise<Response> {
  try {
    // SECURITY FIX (audit finding ORG-1, authorisation half): `?userId=` used to
    // list any user's organisations to an anonymous caller. A user id is an
    // identifier, not a credential, so it can no longer select whose orgs are
    // returned: the caller is resolved from their token and only ever sees
    // their own memberships. A mismatched `?userId=` is refused rather than
    // silently answered, so a caller is never misled about whose list this is.
    const raw = new URL(req.url).searchParams.get('userId')
    const checked = raw && raw.trim() ? uuid(raw, 'userId') : null

    if (isSupabaseConfigured) {
      const caller = await verifiedCallerId(req)
      if (!caller) return signInRequired()
      if (checked && checked.ok && checked.value !== caller) {
        return bad('You can only list your own organisations.', 403)
      }
      // SECURITY FIX (audit finding ORG-2): the store is handed the verified
      // caller and a client that acts for them, so this actually reads the
      // database instead of falling through to an empty server-side store. The
      // context also pins the subject to the caller inside listOrgs.
      return NextResponse.json({ orgs: await listOrgs(caller, orgContext(req, caller)) })
    }

    // Zero-config: no server-side storage exists, so this is an empty list.
    const orgs = await listOrgs(checked && checked.ok ? checked.value : null)
    return NextResponse.json({ orgs })
  } catch (err) {
    // Never leak a stack trace to the client; the server log keeps the detail.
    console.error('[api/orgs GET]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs GET' })
    return NextResponse.json({ orgs: [] })
  }
}

export async function POST(req: Request): Promise<Response> {
  // SECURITY FIX (audit finding RATE-1). Per-instance — see lib/security/ratelimit.ts.
  const limit = check(clientKey(req.headers, 'orgs-create'), 10, 60_000)
  if (!limit.allowed) {
    return apiError('rate_limited', { headers: retryHeaders(limit) })
  }

  // SECURITY FIX (audit finding VAL-1): byte-capped parse instead of req.json().
  const parsed = await readJsonBody(req, 8_192)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return bad(parsed.error, 400)
  const body: unknown = parsed.value

  if (!isRecord(body)) return bad('Expected a JSON object.', 400)

  // SECURITY FIX (audit finding VAL-1): every field is now length-bounded and
  // shape-checked. `name` in particular was an unbounded string on its way to
  // storage and to slugify().
  const nameResult = str(body.name, 120, 'name')
  if (!nameResult.ok) return bad(nameResult.error, 400)
  const name = nameResult.value

  const ownerIdResult = uuid(body.ownerId, 'ownerId')
  if (!ownerIdResult.ok) return bad(ownerIdResult.error, 400)
  const ownerId = ownerIdResult.value

  const ownerEmailResult = validEmail(body.ownerEmail, 'ownerEmail')
  if (!ownerEmailResult.ok) return bad(ownerEmailResult.error, 400)
  let ownerEmail = ownerEmailResult.value

  const planIdRaw = body.planId

  // SECURITY FIX (audit finding ORG-1): you may only create an org you own.
  // Skipped when Supabase is unconfigured — the store is then browser-local and
  // this handler has nowhere to write, so the zero-config demo path is intact.
  let callerId: string | null = null
  if (isSupabaseConfigured) {
    const caller = await verifiedCaller(req)
    if (!caller) {
      return bad(
        'Sign-in required. Send your Supabase access token as `Authorization: Bearer <token>`.',
        401
      )
    }
    callerId = caller.id
    if (callerId !== ownerId) return bad('ownerId must be your own user id.', 403)

    // SECURITY FIX: the owner's seat row carries the VERIFIED email, never one
    // from the body. addMember de-duplicates by email and invite acceptance
    // matches the held seat by email, so a planted address here would make a
    // later invite to that person silently resolve to the owner's row. A
    // mismatching body value is refused rather than quietly replaced, so a
    // client that sends the wrong address finds out. An account with no email
    // (phone sign-in) keeps the validated body value — there is nothing to
    // compare it against.
    if (caller.email) {
      if (ownerEmail !== caller.email) {
        return bad('ownerEmail must be the email address of your own account.', 403)
      }
      ownerEmail = caller.email
    }
  }

  if (typeof planIdRaw !== 'string' || !(PLAN_IDS as string[]).includes(planIdRaw)) {
    return bad(`planId must be one of: ${PLAN_IDS.join(', ')}.`, 400)
  }
  const planId = planIdRaw as PlanId

  if (!planCanOwnSeats(planId)) {
    return bad(
      `The ${PLAN_BY_ID[planId].name} plan is a single-person plan and cannot hold seats. ` +
        'Choose Team (10 seats) or University (unlimited seats).',
      400
    )
  }

  const ctx = orgContext(req, callerId)

  // SECURITY FIX (audit finding ORG-3, server half): an organisation on a paid
  // plan needs the caller's OWN active subscription to that plan. The RLS
  // policy `orgs_insert_owner` enforces exactly this for the browser, but this
  // route writes through the service-role client, which RLS does not see — so
  // without this check any Free sign-up could POST itself a University org and
  // be handed the plan by lib/billing/entitlements.ts. A seat in someone else's
  // org does not count (see holdsPersonalLicence). Fails closed when there is
  // no client to ask. Seat count is never taken from the body: createOrg
  // derives it from PLAN_BY_ID.
  if (isSupabaseConfigured && !(await holdsPersonalLicence(ctx, planId))) {
    return bad(
      `Creating a ${PLAN_BY_ID[planId].name} organisation needs an active ` +
        `${PLAN_BY_ID[planId].name} subscription on your own account. ` +
        'Subscribe first, or contact support for an invoiced licence.',
      403
    )
  }

  // One subscription, one organisation: a second org on the same plan would
  // carry a second seat allowance on a single payment.
  if (isSupabaseConfigured && (await ownsOrgOnPlan(ctx, planId))) {
    return bad(
      `You already own a ${PLAN_BY_ID[planId].name} organisation. One subscription licenses ` +
        'one organisation; add seats to it, or contact support for another licence.',
      409
    )
  }

  try {
    // SECURITY FIX (audit finding ORG-2): with a context the store writes as
    // the verified caller; without one (zero-config) it behaves as before.
    const org = await createOrg({ name, planId, ownerId, ownerEmail }, ctx)
    return NextResponse.json({ org }, { status: 201 })
  } catch (err) {
    console.error('[api/orgs POST]', err)
    // Reported as well as logged: a server log nobody tails is not
    // observability. Only the route name travels — no org, no email.
    reportError(err, { route: 'api/orgs POST' })
    return bad('Could not create the organisation. Try again in a moment.', 500)
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
