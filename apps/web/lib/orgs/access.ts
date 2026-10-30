/**
 * orgs/access.ts — per-organisation AUTHORISATION for the /api/orgs* routes.
 *
 * SERVER ONLY. Do not import from a client component.
 *
 * ── Why this module exists ───────────────────────────────────
 * The audit (docs/SECURITY.md, finding ORG-1) closed authentication on the org
 * routes — "you must present a valid Supabase token" — but not authorisation:
 * "…and you must be an owner or admin OF THIS ORG". Any signed-in user could
 * still POST themselves into someone else's organisation as `owner`, demote the
 * real owner, or read every colleague's email address.
 *
 * It could not be fixed inside the handlers because `lib/orgs/store.ts` resolves
 * identity through `getSupabase().auth.getSession()` — the BROWSER client, which
 * is always null in a route handler (finding ORG-2). So the store cannot answer
 * "is this caller an owner of this org?" server-side at all.
 *
 * This module answers it directly, without going through the store:
 *
 *   1. The caller comes from `lib/security/auth.ts` — a Supabase-verified access
 *      token and nothing else. A `userId` in the body or the query string is a
 *      claim, never a credential.
 *   2. Their membership row is read server-side from `public.org_members`,
 *      keyed on (org_id, user_id). Preference order for the client mirrors
 *      `lib/billing/entitlements.ts`: the service-role client when configured,
 *      otherwise an anon client carrying the CALLER'S OWN token, so Postgres RLS
 *      evaluates the read as that user rather than as nobody.
 *   3. Every failure — no token, no membership, a query error, no usable client
 *      — denies. Fail closed: a caller who cannot be proven to be a member is
 *      treated as not a member.
 *
 * The 403 body is deliberately the same sentence whether the org does not exist,
 * the caller is not a member, or the caller is a member without the required
 * role. An error message must not become a membership oracle.
 *
 * ZERO-CONFIG PATH: when Supabase is not configured there is no server-side
 * storage at all (the store is browser-localStorage-only and these handlers
 * operate on an empty database), so the gate is skipped exactly as the
 * authentication check already skips it. Nothing is protected because nothing
 * is there.
 */

import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getServiceSupabase } from '@/lib/billing/entitlements'
import { isSupabaseConfigured } from '@/lib/supabase'
import { bearerToken, signInRequiredResponse, verifiedCallerId } from '@/lib/security/auth'
import type { OrgContext } from '@/lib/orgs/store'
import type { OrgMemberStatus, OrgRole } from '@/lib/orgs/types'
import type { PlanId } from '@/lib/plans'

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

/** One sentence for every denial. See the note above: no membership oracle. */
export const NOT_PERMITTED =
  'You do not have permission to manage this organisation.'

export interface OrgMembership {
  orgId: string
  userId: string
  role: OrgRole
  status: OrgMemberStatus
}

export type OrgAccess =
  | {
      ok: true
      callerId: string | null
      membership: OrgMembership | null
      /**
       * The verified caller and a client that acts for them, to hand to
       * lib/orgs/store.ts (audit finding ORG-2). Undefined on the zero-config
       * path, where the store has nothing server-side to read anyway.
       */
      context: OrgContext | undefined
    }
  | { ok: false; response: Response }

/** Roles that may change seats. `member` may use a seat, never manage one. */
export const MANAGE_ROLES: readonly OrgRole[] = ['owner', 'admin']
/** Roles that may see the membership list (every colleague's email address). */
export const READ_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member']

function forbidden(): Response {
  return NextResponse.json({ error: NOT_PERMITTED }, { status: 403 })
}

/**
 * A client that can read `public.org_members` from a route handler.
 *
 * Service role first (it bypasses RLS and is what the billing path already
 * uses); otherwise an anon client with the caller's own bearer token attached,
 * so an RLS-protected table is read AS THE CALLER. Returns null when neither is
 * possible — the caller then gets a 403, not an open door.
 */
function membershipClient(token: string): SupabaseClient | null {
  const service = getServiceSupabase()
  if (service) return service
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !token) return null
  try {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
  } catch {
    return null
  }
}

/**
 * Build the storage context for an already-verified caller (audit finding ORG-2).
 *
 * This is the ONLY way lib/orgs/store.ts gets a server-side identity, and it is
 * built from the same `membershipClient` this module already uses to answer
 * "is this caller an owner of this org?". One mechanism, one place where a
 * caller id and a client are paired — the store never resolves either itself.
 *
 * `callerId` must come from `verifiedCallerId` / `requireOrgRole`. Passing a
 * value read out of a request body would defeat the entire module.
 *
 * Returns undefined when there is no caller or no usable client. The store then
 * behaves exactly as before: no server-side backend, nothing found. Undefined is
 * always the safe answer here — it can only make a call see less, never more.
 */
export function orgContext(req: Request, callerId: string | null): OrgContext | undefined {
  if (!callerId) return undefined
  const client = membershipClient(bearerToken(req))
  if (!client) return undefined
  return { userId: callerId, client }
}

/**
 * The one context with no user attached: invite resolution and acceptance.
 *
 * ── Why this exists, and why it is narrow ────────────────────
 * An invite link is clicked by someone who, by definition, is not yet a member
 * of the org — and may not have an account at all. There is therefore no caller
 * whose RLS view contains the invite row, and an anon client would find
 * nothing. The credential on this path is THE TOKEN, which is now 256 bits of
 * randomness stored only as a hash (audit finding INV-1). That is what makes
 * "no user id" acceptable here and nowhere else.
 *
 * Rules for using it, which the callers follow:
 *   · only for lookups keyed on the token hash, and the single-statement
 *     `accepted_at` burn that follows one;
 *   · the acceptance handler still requires a signed-in caller and still
 *     matches their VERIFIED email against the invite's before writing a seat.
 *     This context supplies reach, never permission;
 *   · `userId` is null, so `listOrgs` returns nothing for it and `createOrg`
 *     refuses it — see the note on OrgContext.
 *
 * Returns undefined when no service-role key is configured, in which case the
 * server-side invite path is simply unavailable (the browser-local demo flow
 * still works). Failing closed, as everywhere else in this module.
 */
export function inviteLookupContext(): OrgContext | undefined {
  const service = getServiceSupabase()
  if (!service) return undefined
  return { userId: null, client: service }
}

/**
 * Subscription statuses in good standing. The SAME set `orgs_insert_owner` in
 * supabase/schema-hardening.sql and lib/billing/entitlements.ts honour, so the
 * server route and the browser's RLS path agree on what "paid" means.
 */
const LICENCE_GOOD_STATUSES: readonly string[] = ['active', 'trialing', 'past_due']

/**
 * Does the verified caller hold a PERSONAL subscription to exactly `planId`?
 *
 * ── Why this exists (audit finding ORG-3, server half) ───────
 * supabase/schema-hardening.sql closes "a Free account creates a University
 * org for itself" with the `orgs_insert_owner` RLS policy — which only binds
 * the anon-key path. POST /api/orgs writes through `orgContext()`, which
 * prefers the SERVICE-ROLE client, so RLS never ran there and any signed-in
 * caller could mint an org on a paid plan and take its owner seat. This is the
 * same rule, enforced where the service role is in play.
 *
 * The subscription row is read directly rather than through getEntitlement():
 * the entitlement is the STRONGER of the personal plan and any org seat, so a
 * caller sitting on someone else's University org would look like an edu
 * licence-holder, and a Team subscriber on an edu seat would look like they
 * had no Team plan. A seat in someone else's org never licenses a new one.
 *
 * Fails closed: no context, no user, a query error or no row all answer false.
 */
export async function holdsPersonalLicence(
  ctx: OrgContext | undefined,
  planId: PlanId
): Promise<boolean> {
  if (!ctx || !ctx.userId) return false
  try {
    const { data, error } = await ctx.client
      .from('subscriptions')
      .select('plan_id, status')
      .eq('user_id', ctx.userId)
      .maybeSingle()
    if (error || !data) return false
    const row = data as Record<string, unknown>
    return (
      row.plan_id === planId &&
      typeof row.status === 'string' &&
      LICENCE_GOOD_STATUSES.includes(row.status)
    )
  } catch {
    return false
  }
}

/**
 * Does the verified caller already OWN an organisation on `planId`?
 *
 * One Team subscription licenses one 10-seat organisation. Without this check a
 * single paid subscription could mint any number of organisations, each with
 * its own seat allowance (audit finding ORG-3, the multiplication half).
 *
 * Fails OPEN on a query error: this is an abuse limiter, not an authorisation
 * gate — the licence check beside it already failed closed — and refusing every
 * creation during a database blip would punish the legitimate first org.
 */
export async function ownsOrgOnPlan(
  ctx: OrgContext | undefined,
  planId: PlanId
): Promise<boolean> {
  if (!ctx || !ctx.userId) return false
  try {
    const { data, error } = await ctx.client
      .from('orgs')
      .select('id')
      .eq('owner_id', ctx.userId)
      .eq('plan_id', planId)
    if (error || !Array.isArray(data)) return false
    return data.length > 0
  } catch {
    return false
  }
}

function toRole(value: unknown): OrgRole | null {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : null
}

function toStatus(value: unknown): OrgMemberStatus {
  return value === 'active' || value === 'invited' || value === 'suspended'
    ? value
    : 'invited'
}

/**
 * Look up the caller's membership row for one org. Never throws; returns null
 * for "no row, no access, or the lookup failed" — all of which mean deny.
 */
export async function lookupMembership(
  req: Request,
  orgId: string,
  callerId: string
): Promise<OrgMembership | null> {
  const supabase = membershipClient(bearerToken(req))
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('org_members')
      .select('org_id, user_id, role, status')
      .eq('org_id', orgId)
      .eq('user_id', callerId)
      .maybeSingle()
    if (error || !data) return null
    const row = data as Record<string, unknown>
    const role = toRole(row.role)
    if (!role) return null
    return {
      orgId,
      userId: callerId,
      role,
      status: toStatus(row.status),
    }
  } catch {
    // A missing table, a network failure or a denied policy all mean the same
    // thing here: we cannot prove membership, so there is none.
    return null
  }
}

/**
 * The gate. Use at the top of every /api/orgs* handler that touches one org.
 *
 * 401 when the caller has no valid token; 403 when they are not an active
 * member of `orgId`, or their role is not in `allowed`. A suspended seat may
 * neither read nor manage — a suspended admin is a revoked admin.
 */
export async function requireOrgRole(
  req: Request,
  orgId: string,
  allowed: readonly OrgRole[],
  /**
   * A caller id already resolved by `requireCaller` earlier in the handler, so
   * a request costs one token verification rather than two. Omit it and this
   * function resolves the caller itself.
   */
  knownCallerId?: string | null
): Promise<OrgAccess> {
  // Zero-config deployments have no server-side org data to protect.
  if (!isSupabaseConfigured) {
    return { ok: true, callerId: null, membership: null, context: undefined }
  }

  const callerId = knownCallerId ?? (await verifiedCallerId(req))
  if (!callerId) return { ok: false, response: signInRequiredResponse() }

  const membership = await lookupMembership(req, orgId, callerId)
  if (!membership) return { ok: false, response: forbidden() }
  if (membership.status === 'suspended') return { ok: false, response: forbidden() }
  if (!allowed.includes(membership.role)) return { ok: false, response: forbidden() }

  // The context is handed out only AFTER the role check has passed, so a
  // handler cannot accidentally hold a working storage client for an org the
  // caller was refused (audit finding ORG-2).
  return { ok: true, callerId, membership, context: orgContext(req, callerId) }
}

/**
 * Extra rule layered on top of `requireOrgRole`: an admin may manage members,
 * but only an owner may create or unmake an owner. Without this an admin could
 * promote themselves to owner (a privilege escalation) or demote the person who
 * holds the billing relationship.
 *
 * `membership` is null only on the zero-config path, where there is nothing to
 * escalate to.
 */
export function ownerOnlyDenied(
  membership: OrgMembership | null,
  touchesOwner: boolean
): Response | null {
  if (!touchesOwner) return null
  if (!membership) return null
  if (membership.role === 'owner') return null
  return NextResponse.json(
    { error: 'Only an owner can grant, change or remove the owner role.' },
    { status: 403 }
  )
}
