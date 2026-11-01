/**
 * entitlements.ts — the resolution layer: "what can THIS user do right now".
 *
 * SERVER ONLY. Never import this from a client component: it reads the
 * service-role key when one is present.
 *
 * The single rule of this module: a billing lookup failure degrades to FREE.
 * A user must never see an error page because the subscriptions table was
 * unreachable — they see the free tier, and support fixes it.
 */

import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { usagePeriodStart } from './period'
import { applyLaunchTrial, launchTrialDays, launchTrialUntil } from './launchTrial'
import {
  assertFeature,
  FREE_ENTITLEMENT,
  type Entitlement,
  type FeatureId,
  type FeatureLockedError,
  PLAN_BY_ID,
  type PlanId,
  type SubscriptionStatus,
} from '@/lib/plans'

// ────────────────────────────────────────────────────────────
// Row shapes — mirror supabase/schema-billing.sql
// ────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  user_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_id: PlanId
  status: SubscriptionStatus
  current_period_end: string | null
  cancel_at_period_end: boolean | null
  created_at?: string
  updated_at?: string
}

/** A seat granted by an organisation, from the optional org_members table. */
interface OrgMemberRow {
  org_id: string
  plan_id: PlanId
  status: SubscriptionStatus | null
}

// ────────────────────────────────────────────────────────────
// Clients
// ────────────────────────────────────────────────────────────

const SERVICE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

/** True when a service-role key is available for privileged writes. */
export const isServiceRoleConfigured: boolean =
  SERVICE_URL.length > 0 && SERVICE_KEY.length > 0

let serviceClient: SupabaseClient | null = null

/**
 * The privileged client used by the Stripe webhook and usage recorder.
 * RLS deliberately forbids users from writing their own subscription row, so
 * these writes MUST go through the service role. Returns null when unset.
 * Never throws.
 */
export function getServiceSupabase(): SupabaseClient | null {
  if (!isServiceRoleConfigured) return null
  if (serviceClient) return serviceClient
  try {
    serviceClient = createClient(SERVICE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  } catch {
    serviceClient = null
  }
  return serviceClient
}

/** Prefer the privileged client when present, else the ordinary anon client. */
function readClient(): SupabaseClient | null {
  return getServiceSupabase() ?? getSupabase()
}

// ────────────────────────────────────────────────────────────
// Plan ranking
// ────────────────────────────────────────────────────────────

const PLAN_RANK: Record<PlanId, number> = { free: 0, pro: 1, team: 2, edu: 3 }

function isGoodStanding(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due'
}

const VALID_STATUSES: SubscriptionStatus[] = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
]

function toStatus(value: unknown): SubscriptionStatus {
  return typeof value === 'string' && (VALID_STATUSES as string[]).includes(value)
    ? (value as SubscriptionStatus)
    : 'none'
}

function toPlanId(value: unknown): PlanId {
  return value === 'pro' || value === 'team' || value === 'edu' ? value : 'free'
}

// `startOfUtcMonth` used to live here and is now in ./period alongside the
// billing-anchor window that replaced it as the quota boundary. Re-exported
// because it is still the right answer for an account with no anchor.
export { startOfUtcMonth, usagePeriodEnd, usagePeriodStart } from './period'

// ────────────────────────────────────────────────────────────
// Account age, for the launch-trial policy
// ────────────────────────────────────────────────────────────

/**
 * created_at is not in the session JWT and auth.users is not readable with the
 * anon key, so the only source is the auth admin API — one round trip, service
 * role only. It never changes for a given user, so it is cached for the life
 * of the process; the cap keeps a scan of random ids from growing the map
 * without bound. `null` (unknown) is deliberately NOT cached, so a service key
 * added later takes effect on the next request rather than after a restart.
 */
const CREATED_AT_CACHE = new Map<string, Date>()
const CREATED_AT_CACHE_MAX = 5_000

async function accountCreatedAt(userId: string): Promise<Date | null> {
  const cached = CREATED_AT_CACHE.get(userId)
  if (cached) return cached
  const admin = getServiceSupabase()
  if (!admin) return null
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId)
    const iso = data?.user?.created_at
    if (error || !iso) return null
    const created = new Date(iso)
    if (Number.isNaN(created.getTime())) return null
    if (CREATED_AT_CACHE.size >= CREATED_AT_CACHE_MAX) {
      const oldest = CREATED_AT_CACHE.keys().next().value
      if (oldest !== undefined) CREATED_AT_CACHE.delete(oldest)
    }
    CREATED_AT_CACHE.set(userId, created)
    return created
  } catch {
    return null
  }
}

/** Test seam: forget cached account ages. */
export function resetAccountAgeCacheForTests(): void {
  CREATED_AT_CACHE.clear()
}

// ────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────

/**
 * Resolve the effective entitlement for a user: the stronger of their personal
 * subscription and any organisation seat, plus this month's hardware usage.
 *
 * Returns FREE_ENTITLEMENT for a signed-out user, an unconfigured backend, or
 * any failure whatsoever.
 */
/**
 * Orgs whose licence has ENDED: the owner's own subscription is for this
 * org's plan and is no longer in good standing (canceled / incomplete / none).
 *
 * Without this, every seat in a Team org kept Team features forever after the
 * owner cancelled — the seat rows are never touched by the Stripe webhook.
 * An org whose owner has no subscription for its plan at all is a licence
 * provisioned by hand (University is sold by invoice) and is NOT treated as
 * lapsed. Any read failure answers "none lapsed", the status quo.
 */
async function lapsedOrgIds(supabase: SupabaseClient, orgIds: string[]): Promise<Set<string>> {
  const lapsed = new Set<string>()
  if (orgIds.length === 0) return lapsed
  try {
    const orgs = await supabase.from('orgs').select('id, plan_id, owner_id').in('id', orgIds)
    if (orgs.error || !Array.isArray(orgs.data)) return lapsed
    const rows = orgs.data as { id: string; plan_id: string; owner_id: string | null }[]
    const owners = Array.from(new Set(rows.map((o) => o.owner_id).filter((id): id is string => !!id)))
    if (owners.length === 0) return lapsed
    const subs = await supabase
      .from('subscriptions')
      .select('user_id, plan_id, status, stripe_customer_id, stripe_subscription_id')
      .in('user_id', owners)
    if (subs.error || !Array.isArray(subs.data)) return lapsed
    const byOwner = new Map(
      (
        subs.data as {
          user_id: string
          plan_id: string
          status: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
        }[]
      ).map((r) => [r.user_id, r])
    )
    for (const org of rows) {
      const sub = org.owner_id ? byOwner.get(org.owner_id) : undefined
      if (!sub) continue
      if (sub.plan_id !== org.plan_id) {
        // The owner's single subscription row now names a DIFFERENT plan.
        // For a self-serve org (Team) that row is Stripe's: an owner who
        // moved to Pro in the portal, or cancelled and bought Pro later, no
        // longer pays for this org, so it lapses. A row with no Stripe link
        // is hand-provisioned, and University (sold by invoice, contact
        // sales) is never governed by the owner's personal Stripe plan.
        const stripeLinked = !!(sub.stripe_customer_id || sub.stripe_subscription_id)
        if (stripeLinked && PLAN_BY_ID[toPlanId(org.plan_id)]?.contactSales !== true) {
          lapsed.add(org.id)
        }
        continue
      }
      const good = sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due'
      if (!good) lapsed.add(org.id)
    }
  } catch {
    // Status quo on failure.
  }
  return lapsed
}

/** True for "the hardware_usage.credential_owner column does not exist". */
function missingCredentialOwner(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  const message = (error.message ?? '').toLowerCase()
  return (
    (error.code === 'PGRST204' || error.code === '42703') && message.includes('credential_owner')
  )
}

/**
 * Operator-funded hardware jobs in the usage window: the SAME population
 * `reserve_hardware_job` counts. A job run on the user's own vendor credential
 * (credential_owner = 'user') is exempt there, so it must not inflate the
 * meter either. A project that has not applied supabase/schema-byok.sql has no
 * such column; that is retried unfiltered (every row was operator-funded then).
 * Returns null when the count cannot be read.
 */
async function operatorJobsUsed(
  supabase: SupabaseClient,
  userId: string,
  periodStart: string
): Promise<number | null> {
  const base = () =>
    supabase
      .from('hardware_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', periodStart)
  const filtered = await base().eq('credential_owner', 'operator')
  if (!filtered.error && typeof filtered.count === 'number') return filtered.count
  if (!missingCredentialOwner(filtered.error)) return null
  const plain = await base()
  return !plain.error && typeof plain.count === 'number' ? plain.count : null
}

export async function getEntitlement(userId: string | null): Promise<Entitlement> {
  if (!userId || !isSupabaseConfigured) return FREE_ENTITLEMENT

  try {
    const supabase = readClient()
    if (!supabase) return FREE_ENTITLEMENT

    // ── Personal subscription ────────────────────────────────
    let planId: PlanId = 'free'
    let status: SubscriptionStatus = 'none'
    let currentPeriodEnd: string | undefined
    let cancelAtPeriodEnd: boolean | undefined

    const subResult = await supabase
      .from('subscriptions')
      .select(
        'user_id, stripe_customer_id, stripe_subscription_id, plan_id, status, current_period_end, cancel_at_period_end'
      )
      .eq('user_id', userId)
      .maybeSingle()

    if (!subResult.error && subResult.data) {
      const row = subResult.data as Partial<SubscriptionRow>
      planId = toPlanId(row.plan_id)
      status = toStatus(row.status)
      currentPeriodEnd = row.current_period_end ?? undefined
      cancelAtPeriodEnd = row.cancel_at_period_end ?? undefined
    }

    // ── Organisation seat (table is optional) ────────────────
    // org_members may not exist in this project yet. A query error here means
    // "no org", never a failed entitlement lookup.
    let viaOrgId: string | undefined
    try {
      const orgResult = await supabase
        .from('org_members')
        .select('org_id, plan_id, status')
        .eq('user_id', userId)

      if (!orgResult.error && Array.isArray(orgResult.data)) {
        const lapsed = await lapsedOrgIds(
          supabase,
          (orgResult.data as Partial<OrgMemberRow>[])
            .map((r) => r.org_id)
            .filter((id): id is string => typeof id === 'string')
        )
        // A personal subscription that is not in good standing (canceled,
        // incomplete, none) grants nothing, so it must not outrank a seat of
        // the same plan: stale {team, canceled} + a paid Team seat is Team.
        const personalGood = isGoodStanding(status)
        let effective: PlanId = personalGood ? planId : 'free'
        for (const raw of orgResult.data as Partial<OrgMemberRow>[]) {
          if (raw.org_id && lapsed.has(raw.org_id)) continue
          const seatPlan = toPlanId(raw.plan_id)
          const seatStatus = raw.status ? toStatus(raw.status) : 'active'
          if (!isGoodStanding(seatStatus)) continue
          if (PLAN_RANK[seatPlan] > PLAN_RANK[effective]) {
            effective = seatPlan
            planId = seatPlan
            status = seatStatus
            currentPeriodEnd = undefined
            cancelAtPeriodEnd = false
            viaOrgId = raw.org_id ?? undefined
          }
        }
      }
    } catch {
      // No org_members table (or no access). Personal subscription stands.
    }

    // ── Usage ────────────────────────────────────────────────
    // Counted over the SAME window the submit route enforces — the
    // subscription's monthly anchor, falling back to the calendar month when
    // there is no anchor (org seats, Free). Counting a calendar month here
    // while the gate counts a billing month produces "it says I have 8 left
    // but it refuses me", and the customer is right.
    let hardwareJobsUsed = 0
    const periodStart = usagePeriodStart(currentPeriodEnd)
    const used = await operatorJobsUsed(supabase, userId, periodStart)
    if (used !== null) hardwareJobsUsed = used

    const entitlement: Entitlement = { planId, status, hardwareJobsUsed }
    if (currentPeriodEnd) entitlement.currentPeriodEnd = currentPeriodEnd
    if (cancelAtPeriodEnd !== undefined) entitlement.cancelAtPeriodEnd = cancelAtPeriodEnd
    if (viaOrgId) entitlement.viaOrgId = viaOrgId

    // ── Launch trial (policy, not a row) ─────────────────────
    // Applied last so a real subscription or seat always wins; see
    // lib/billing/launchTrial.ts. Off unless NEXT_PUBLIC_LAUNCH_TRIAL_DAYS is
    // set, and then the only extra cost is one cached admin lookup per user.
    const trialDays = launchTrialDays()
    const trialUntil = launchTrialUntil()
    if (trialDays > 0 || trialUntil !== null) {
      // The account age lookup is only needed for the PER-ACCOUNT window. A
      // promotion configured with an absolute end date alone applies to
      // everybody regardless of when they signed up, so skipping the lookup
      // there is not an optimisation — it is the difference between the policy
      // working and it depending on a service-role key it does not need.
      const createdAt = trialDays > 0 ? await accountCreatedAt(userId) : null
      return applyLaunchTrial(entitlement, createdAt, trialDays, new Date(), trialUntil)
    }
    return entitlement
  } catch {
    // Billing is never allowed to break the app: degrade to free.
    return FREE_ENTITLEMENT
  }
}

/**
 * Resolve then gate. Lets FeatureLockedError propagate so the route handler can
 * turn it into a 402 with `featureLockedResponse`.
 */
export async function requireFeature(
  userId: string | null,
  feature: FeatureId
): Promise<Entitlement> {
  const entitlement = await getEntitlement(userId)
  assertFeature(entitlement, feature)
  return entitlement
}

/**
 * The canonical 402 body for a locked feature. During the launch trial the
 * honest next step for a signed-out visitor is to sign in, not to pay, and
 * `launchTrialDays` lets the client say so; the fields above it are unchanged.
 */
export function featureLockedResponse(err: FeatureLockedError): Response {
  const trialDays = launchTrialDays()
  return NextResponse.json(
    {
      error: err.message,
      feature: err.feature,
      requiredPlan: err.requiredPlan,
      upgradeUrl: '/pricing',
      ...(trialDays > 0 ? { launchTrialDays: trialDays } : {}),
    },
    { status: 402 }
  )
}
