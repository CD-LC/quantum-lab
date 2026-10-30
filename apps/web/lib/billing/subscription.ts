/**
 * subscription.ts — the ONE writer of `public.subscriptions`, and the ONE
 * translation from a Stripe subscription object into our row.
 *
 * SERVER ONLY: it holds the service-role client.
 *
 * Two things write this table — the webhook (Stripe pushed) and the
 * reconciler (we pulled). Before this module existed there was one, and its
 * mapping lived inline in the route. Splitting it out is not tidiness: a
 * reconciler with its own copy of "which Stripe status means past_due" is a
 * reconciler that will eventually disagree with the webhook, and the symptom
 * of that is an account whose plan flips back and forth depending on which
 * path last touched it.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * Every write carries the `event.created` of the Stripe event that justified
 * it, and `public.apply_stripe_subscription` drops a write whose stamp is older
 * than the last one applied to that row. Stripe does not deliver in order and
 * retries for up to three days, so without this an old delivery silently
 * overwrites new state. A reconciliation passes `null`, which means "I read
 * Stripe live just now, apply unconditionally" — see `applySubscription`.
 */

import type Stripe from 'stripe'
import { getServiceSupabase } from './entitlements'
import { planIdForPriceId } from './stripe'
import type { PlanId, SubscriptionStatus } from '@/lib/plans'

/** Thrown when the database write fails, so a handler can answer 500. */
export class PersistError extends Error {}

/** The row as this codebase thinks of it, before it becomes snake_case. */
export interface SubscriptionState {
  userId: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  planId: PlanId
  status: SubscriptionStatus
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

/**
 * When Stripe decided the thing that justifies this write. Null for a
 * reconciliation, which read the live object and is therefore never stale.
 */
export interface EventStamp {
  id: string
  /** ISO instant from `event.created`. */
  at: string
}

/**
 * Map a Stripe subscription status onto our narrower union.
 *
 * `past_due` is the ONLY status that keeps paid access without a payment
 * (grace for dunning — see `effectivePlan`). `unpaid` used to map onto it too,
 * and that was wrong: in Stripe, `unpaid` means dunning has FINISHED and the
 * subscription will not be retried or charged again. The operator's dunning
 * setting "mark the subscription as unpaid" (the alternative to the default
 * cancel) leaves it in that state permanently, so an account that stopped
 * paying kept Pro/Team — the live tutor and real-hardware jobs included — for
 * as long as it existed, and neither the webhook nor reconcile ever downgraded
 * it. It is now the end of the subscription, like `canceled`. docs/BILLING.md §6.
 */
export function toStatus(status: Stripe.Subscription.Status | string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'unpaid':
    case 'canceled':
    case 'paused':
      return 'canceled'
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete'
    default:
      return 'none'
  }
}

export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

export function isoFromUnix(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000).toISOString()
}

export function firstPriceId(sub: Stripe.Subscription): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null
}

/** Our user id as Stripe carries it. Empty string when absent. */
export function userIdFromSubscription(sub: Stripe.Subscription): string {
  return (sub.metadata?.userId ?? '').trim()
}

/**
 * Our user id for a subscription whose Stripe metadata does not carry one.
 *
 * Checkout used to stamp `userId` on the checkout SESSION only, never on the
 * subscription, so every later `customer.subscription.updated/deleted` and
 * `invoice.payment_failed` for those customers was dropped: cancellations,
 * plan changes and past-due never reached the account. The row written at
 * checkout knows the mapping, so look it up — by subscription id, then by
 * customer id. Empty string when there is no match (or no service role).
 */
export async function userIdFromStoredSubscription(sub: Stripe.Subscription): Promise<string> {
  const supabase = getServiceSupabase()
  if (!supabase) return ''
  try {
    const bySub = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_subscription_id', sub.id)
      .limit(1)
      .maybeSingle()
    const fromSub = (bySub.data as { user_id?: string } | null)?.user_id
    if (!bySub.error && fromSub) return fromSub
    const customerId = idOf(sub.customer)
    if (!customerId) return ''
    const byCustomer = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .limit(1)
      .maybeSingle()
    const fromCustomer = (byCustomer.data as { user_id?: string } | null)?.user_id
    return !byCustomer.error && fromCustomer ? fromCustomer : ''
  } catch {
    return ''
  }
}

/**
 * Translate a live Stripe subscription into a row.
 *
 * `forcedStatus` exists for the two events that mean something the subscription
 * object itself may not say yet (`deleted` → canceled, `payment_failed` →
 * past_due). Everything else must come from the object, never from the event
 * type: inferring plan from an event name is how a customer who upgraded and
 * downgraded in the same minute ends up on the wrong one.
 */
export function stateFromStripe(
  sub: Stripe.Subscription,
  userId: string,
  forcedStatus?: SubscriptionStatus
): SubscriptionState {
  const priceId = firstPriceId(sub)
  return {
    userId,
    stripeCustomerId: idOf(sub.customer),
    stripeSubscriptionId: sub.id,
    planId: (priceId ? planIdForPriceId(priceId) : null) ?? 'free',
    status: forcedStatus ?? toStatus(sub.status),
    currentPeriodEnd: isoFromUnix(sub.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  }
}

/** PostgREST / Postgres codes for "that function or table is not here". */
const MISSING_OBJECT_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01'])

function isMissingObject(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code && MISSING_OBJECT_CODES.has(error.code)) return true
  const message = (error.message ?? '').toLowerCase()
  return message.includes('could not find') || message.includes('does not exist')
}

let orderingWarned = false
let ledgerWarned = false

/**
 * Write a subscription row, unless a newer event has already been applied.
 *
 * @param stamp The justifying Stripe event, or null for a live reconciliation.
 * @returns `applied: false` when the write was dropped as stale — an ordinary
 *          outcome that the caller should log and acknowledge, not retry.
 * @throws PersistError when the store failed. The webhook turns that into a
 *         500 so Stripe retries, which is the only case where a retry helps.
 */
export async function applySubscription(
  state: SubscriptionState,
  stamp: EventStamp | null
): Promise<{ applied: boolean }> {
  const supabase = getServiceSupabase()
  if (!supabase) {
    // No database configured: there is nowhere to store it. Not an error — the
    // whole billing layer is optional and the app runs on Free without it.
    console.warn('[billing/subscription] no service-role client; subscription not persisted')
    return { applied: false }
  }

  const { error } = await supabase.rpc('apply_stripe_subscription', {
    p_user_id: state.userId,
    p_customer_id: state.stripeCustomerId,
    p_subscription_id: state.stripeSubscriptionId,
    p_plan_id: state.planId,
    p_status: state.status,
    p_current_period_end: state.currentPeriodEnd,
    p_cancel_at_period_end: state.cancelAtPeriodEnd,
    p_event_id: stamp?.id ?? null,
    p_event_at: stamp?.at ?? null,
  })

  if (!error) {
    // The function reports whether it applied, but PostgREST hands back the
    // row set and we only need the failure signal — a dropped stale write and
    // an applied one are both "nothing more to do here". The distinction is
    // visible in `subscriptions.last_event_id` for anyone debugging.
    return { applied: true }
  }

  if (!isMissingObject(error)) throw new PersistError(error.message ?? 'rpc failed')

  // The project has not had supabase/schema-billing.sql applied since this
  // change. Fall back to the plain upsert this route always did — which means
  // NO ORDERING GUARD, so an out-of-order delivery can still overwrite newer
  // state. Loud, once, naming the fix; refusing every webhook instead would
  // strand real subscriptions.
  if (!orderingWarned) {
    orderingWarned = true
    console.error(
      '[billing/subscription] public.apply_stripe_subscription is missing, so Stripe events ' +
        'are being applied WITHOUT the out-of-order guard. Apply supabase/schema-billing.sql.'
    )
  }
  const { error: upsertError } = await supabase.from('subscriptions').upsert(
    {
      user_id: state.userId,
      stripe_customer_id: state.stripeCustomerId,
      stripe_subscription_id: state.stripeSubscriptionId,
      plan_id: state.planId,
      status: state.status,
      current_period_end: state.currentPeriodEnd,
      cancel_at_period_end: state.cancelAtPeriodEnd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (upsertError) throw new PersistError(upsertError.message)
  return { applied: true }
}

/**
 * Has this Stripe event id already been processed to completion?
 *
 * Returns false when the ledger cannot be read. That is deliberate: the cost of
 * a false "no" is doing idempotent work twice, and the cost of a false "yes" is
 * dropping a real subscription change on the floor forever.
 */
export async function alreadyProcessed(eventId: string): Promise<boolean> {
  const supabase = getServiceSupabase()
  if (!supabase || !eventId) return false
  const { data, error } = await supabase
    .from('stripe_events')
    .select('id')
    .eq('id', eventId)
    .maybeSingle()
  if (error) {
    if (isMissingObject(error) && !ledgerWarned) {
      ledgerWarned = true
      console.error(
        '[billing/subscription] public.stripe_events is missing, so webhook replays are NOT ' +
          'deduplicated. Apply supabase/schema-billing.sql.'
      )
    }
    return false
  }
  return Boolean(data)
}

/**
 * Record an event as processed. Called AFTER the work succeeded, never before:
 * claiming the id first means a crash between the claim and the write turns
 * Stripe's retry — our only recovery mechanism — into a skipped duplicate, and
 * the subscription change is lost with nothing to say so.
 *
 * Never throws. A failure here costs one repeated (idempotent) delivery; making
 * it a 500 would ask Stripe to redo work that already succeeded.
 */
export async function markProcessed(
  eventId: string,
  type: string,
  createdAt: string | null
): Promise<void> {
  const supabase = getServiceSupabase()
  if (!supabase || !eventId) return
  const { error } = await supabase
    .from('stripe_events')
    .upsert({ id: eventId, type, event_created_at: createdAt }, { onConflict: 'id' })
  if (error && !isMissingObject(error)) {
    console.error(`[billing/subscription] could not record event ${eventId}: ${error.message}`)
  }
}
