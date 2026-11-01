/**
 * reconcile.ts — re-derive an account's entitlement from Stripe, on demand.
 *
 * SERVER ONLY: service-role client plus the Stripe secret key.
 *
 * ── Why a pull path exists at all ───────────────────────────────────────────
 *
 * The webhook is a PUSH, and a push is not a guarantee. Every one of these has
 * happened to somebody:
 *
 *  · The endpoint was down, or `STRIPE_WEBHOOK_SECRET` was rotated and not
 *    redeployed, so every delivery 400'd for a while. Stripe gives up after
 *    about three days of retries and the change is gone.
 *  · The subscription was edited in the Stripe DASHBOARD — a support refund, a
 *    coupon, a manual plan change, a cancellation on the customer's behalf.
 *    Those do emit events, but they also happen at exactly the times an
 *    operator is least likely to be watching a webhook log.
 *  · The webhook endpoint was not subscribed to an event type it needed.
 *  · `metadata.userId` was missing, so the event was verified, acknowledged and
 *    unattributable (the handler logs and moves on, deliberately — retrying
 *    cannot invent the id).
 *
 * The result is the same in each case: Stripe thinks one thing, we bill and
 * gate on another. This module makes Stripe authoritative again in one call.
 *
 * ── WHEN THIS SHOULD RUN ────────────────────────────────────────────────────
 *
 * 1. AUTOMATICALLY, when the row is provably stale. `GET /api/billing/
 *    entitlement` triggers it when `current_period_end` is more than a day in
 *    the past: a renewal that happened at the provider and never reached us.
 *    That is the case where a paying customer is being denied what they paid
 *    for, and it self-heals on their next page load. Bounded by a per-process
 *    cooldown (RECONCILE_COOLDOWN_MS) so a hot loop cannot turn into a Stripe
 *    rate-limit incident.
 * 2. ON DEMAND, `POST /api/billing/reconcile` — a signed-in user reconciling
 *    themselves ("I upgraded and it still says Free" is the single most common
 *    billing ticket, and this is its self-service answer), or an operator with
 *    the shared secret reconciling any user id.
 * 3. NIGHTLY, for every account with a `stripe_customer_id`, from cron. Not
 *    wired here: this repository has no scheduler and inventing one that never
 *    runs is exactly the kind of decoration this project has been burned by.
 *    docs/BILLING.md §8 gives the loop and the curl.
 * 4. AFTER ANY WEBHOOK OUTAGE, for everyone. Same loop as (3).
 *
 * A reconciliation writes with a null event stamp, which
 * `apply_stripe_subscription` treats as "unconditionally fresh" — it read the
 * live object, so it cannot be stale relative to any event. The one ordering
 * hazard that leaves is an in-flight event applied a moment later with an older
 * `created`; it will be dropped as stale, and dropping it is correct, because
 * the live read already includes whatever it was going to say.
 */

import type Stripe from 'stripe'
import { getStripe, isStripeConfigured } from './stripe'
import { getServiceSupabase } from './entitlements'
import { applySubscription, stateFromStripe, type SubscriptionState } from './subscription'
import type { PlanId, SubscriptionStatus } from '@/lib/plans'

export type ReconcileOutcome =
  /** Stripe is not configured in this environment; nothing to reconcile against. */
  | { status: 'unconfigured' }
  /** We hold no Stripe customer for this user — they have never checked out. */
  | { status: 'unknown_customer' }
  /** The store could not be read or written. */
  | { status: 'failed'; reason: string }
  /** Stripe was read and the row now matches it. */
  | { status: 'reconciled'; planId: PlanId; changed: boolean; subscriptionId: string | null }

interface StoredRow {
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_id: PlanId | null
  status: string | null
  current_period_end: string | null
}

/**
 * How entitling a Stripe status is. A customer can hold several subscriptions
 * (an old canceled one and a new active one is the normal shape after a
 * re-subscribe), and the row has space for exactly one, so we take the one that
 * actually grants access rather than the newest by id.
 *
 * `unpaid` sits BELOW `canceled`. Both mean the subscription is over (see
 * `toStatus`), but it used to rank above canceled, so a customer holding one
 * of each had their unpaid subscription chosen — and, through the old
 * `unpaid → past_due` mapping, kept paid access for a subscription Stripe had
 * stopped charging. Ranking it last means a reconciliation never prefers it.
 */
const STATUS_RANK: Record<string, number> = {
  active: 6,
  trialing: 5,
  past_due: 4,
  incomplete: 3,
  canceled: 2,
  unpaid: 1,
}

function rank(sub: Stripe.Subscription): number {
  return (STATUS_RANK[sub.status] ?? 0) * 1_000_000_000 + (sub.created ?? 0) / 1000
}

/** Read what we currently believe. Null when there is no row or no store. */
async function storedRow(userId: string): Promise<StoredRow | null> {
  const supabase = getServiceSupabase()
  if (!supabase) return null
  const { data, error } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_id, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  return data as StoredRow
}

/**
 * Re-derive `public.subscriptions` for one user from Stripe.
 *
 * Never throws: every failure is an outcome. Callers include a hot read path,
 * and reconciliation failing must never be the reason a page errors.
 */
export async function reconcileEntitlement(userId: string): Promise<ReconcileOutcome> {
  const stripe = getStripe()
  if (!isStripeConfigured || !stripe) return { status: 'unconfigured' }
  if (!userId) return { status: 'failed', reason: 'no user id' }

  const row = await storedRow(userId)
  if (!row) return { status: 'unknown_customer' }
  const customerId = row.stripe_customer_id
  if (!customerId) return { status: 'unknown_customer' }

  let chosen: Stripe.Subscription | null = null
  try {
    // Every subscription this customer has ever had, not just the active ones:
    // "there are none active" is a REAL and important answer (it is what a
    // missed cancellation looks like) and `status: 'all'` is the only way to
    // tell it apart from "the list call was filtered".
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    })
    for (const sub of list.data) {
      if (!chosen || rank(sub) > rank(chosen)) chosen = sub
    }
  } catch (err) {
    // Stripe unreachable, key revoked, customer deleted. Leave the row alone:
    // the last thing a webhook told us is a better guess than nothing, and
    // downgrading someone because Stripe timed out is the expensive mistake.
    return { status: 'failed', reason: String(err) }
  }

  const next: SubscriptionState = chosen
    ? stateFromStripe(chosen, userId)
    : {
        // The customer exists and holds no subscription at all. That is a
        // cancellation whose webhook never landed; Free is the truth.
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: null,
        planId: 'free',
        status: 'canceled',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      }

  const changed = next.planId !== (row.plan_id ?? 'free') || next.status !== (row.status ?? 'none')

  try {
    await applySubscription(next, null)
  } catch (err) {
    return { status: 'failed', reason: String(err) }
  }

  if (changed) {
    // Worth a line in the log either way: a reconciliation that CHANGES
    // something means a webhook was missed, and a run of these is an incident
    // rather than a curiosity.
    console.warn(
      `[billing/reconcile] ${userId}: ${row.plan_id ?? 'free'}/${row.status ?? 'none'} → ` +
        `${next.planId}/${next.status} (Stripe was authoritative; a webhook was missed)`
    )
  }

  return {
    status: 'reconciled',
    planId: next.planId,
    changed,
    subscriptionId: next.stripeSubscriptionId,
  }
}

/**
 * Per-process cooldown for the automatic path. In-memory on purpose: it does
 * not need to be exact, only to stop one stale row from generating a Stripe
 * call on every page load of every instance. N instances mean at most N calls
 * per window, which is a handful, not an incident.
 */
const RECONCILE_COOLDOWN_MS = 10 * 60_000

const ENTITLING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
])
const lastAttempt = new Map<string, number>()

/**
 * Reconcile only if this row looks provably stale and we have not tried
 * recently. Returns true when a reconciliation actually ran and changed
 * something, so the caller knows to re-read.
 *
 * "Provably stale" is deliberately narrow: `current_period_end` more than 24h
 * in the past. A renewal moves that field forward every period without fail, so
 * a value a day past its end means we missed the renewal — not that the
 * customer is between periods. Widening this test widens the Stripe traffic on
 * a hot path; do not widen it to "status is not active". It is also NARROWED to
 * rows whose stored status still grants access: a canceled row's period end is
 * in the past permanently and would otherwise match forever.
 */
export async function reconcileIfStale(
  userId: string,
  currentPeriodEnd: string | null | undefined,
  now: Date = new Date(),
  status?: SubscriptionStatus
): Promise<boolean> {
  if (!isStripeConfigured || !userId || !currentPeriodEnd) return false
  // A row that is already over (canceled / none / incomplete) keeps its past
  // period end forever, so without this every ex-subscriber re-queried Stripe
  // every cooldown for as long as they used the site, for no change. Only a row
  // still claiming access can be provably behind Stripe. A missed
  // RE-subscription on a canceled row is recovered by the account page's
  // post-checkout reconcile instead (POST /api/billing/reconcile).
  if (status !== undefined && !ENTITLING_STATUSES.has(status)) return false
  const end = Date.parse(currentPeriodEnd)
  if (Number.isNaN(end) || now.getTime() - end < 24 * 60 * 60_000) return false

  const last = lastAttempt.get(userId) ?? 0
  if (now.getTime() - last < RECONCILE_COOLDOWN_MS) return false
  lastAttempt.set(userId, now.getTime())

  const outcome = await reconcileEntitlement(userId)
  return outcome.status === 'reconciled' && outcome.changed
}

/** Test seam: the cooldown map is process-global and would leak between tests. */
export function __resetReconcileCooldown(): void {
  lastAttempt.clear()
}
