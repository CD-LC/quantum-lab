/**
 * POST /api/billing/webhook — Stripe's view of the truth.
 *
 * This is the ONLY writer of public.subscriptions. RLS denies users write
 * access to their own subscription row precisely so that nobody can grant
 * themselves Pro; the row can only change because Stripe said so, through the
 * service-role key used here.
 *
 * Retry semantics: Stripe retries any non-2xx. So a *database* failure returns
 * 500 (please retry), and so does a failed call back INTO Stripe (an outage, a
 * 429, a timeout while re-reading the subscription — see `StripeReadError`),
 * while a verified-but-unusable event returns 200 (retrying will not help).
 *
 * ── What was already right, and what was not ────────────────────────────────
 *
 * ALREADY RIGHT, and do not undo either of them:
 *  · The signature IS verified, against the RAW body. `req.text()` is read
 *    before anything parses it, exactly as `constructEvent` requires, and a
 *    failure answers 400 with no detail. Nothing below this line runs for an
 *    event Stripe did not sign.
 *  · The user id comes from the event (`metadata.userId` /
 *    `client_reference_id`), never from a query string, and an event that
 *    cannot be attributed is acknowledged rather than guessed at.
 *
 * WRONG, and fixed here:
 *  · NO IDEMPOTENCY. Stripe redelivers — after any 5xx, after a timeout, and
 *    whenever an operator replays from the dashboard. Every delivery was
 *    processed again from scratch.
 *  · NO ORDERING. Deliveries are not ordered, and each handler wrote
 *    last-arrival-wins. The concrete failure: an upgrade created at 12:00:00
 *    times out, the customer's downgrade created at 12:00:10 is delivered and
 *    applied at 12:00:12, then Stripe retries the upgrade at 12:00:30 and it
 *    overwrites the downgrade. The account keeps a plan it no longer pays for
 *    until something else touches the row. With the events the other way round
 *    the same mechanism CANCELS a paying customer, which is the version that
 *    generates a support ticket rather than a loss.
 *  · `invoice.payment_failed` re-read the subscription live from Stripe and
 *    then forced `past_due` regardless of what that read said, so a stale
 *    retry could mark a recovered account delinquent.
 *
 * Both fixes live in Postgres, because both need a read and a write to be one
 * decision: `public.stripe_events` is the idempotency ledger and
 * `public.apply_stripe_subscription` refuses a write whose `event.created` is
 * older than the last one applied to that account. See
 * supabase/schema-billing.sql.
 */

import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import {
  getStripe,
  isStripeConfigured,
  planIdForPriceId,
  STRIPE_API_VERSION,
} from '@/lib/billing/stripe'
import {
  alreadyProcessed,
  applySubscription,
  firstPriceId,
  idOf,
  isoFromUnix,
  markProcessed,
  PersistError,
  stateFromStripe,
  toStatus,
  userIdFromStoredSubscription,
  userIdFromSubscription,
  type EventStamp,
} from '@/lib/billing/subscription'
import type { PlanId, SubscriptionStatus } from '@/lib/plans'
import { uuid } from '@/lib/security/validate'

/** The only plans this app sells through Checkout. */
function paidPlanId(value: unknown): PlanId | null {
  return value === 'pro' || value === 'team' ? value : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export const runtime = 'nodejs'

const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim()

/**
 * Thrown when a call back into Stripe failed for a reason a retry can fix.
 *
 * Two handlers re-read the subscription live (`checkout.session.completed`,
 * `invoice.payment_failed`). That call used to sit inside the same try as the
 * "verified but unusable event" catch, so a Stripe outage, 429 or timeout was
 * ACKNOWLEDGED WITH 200 — and Stripe does not retry a 2xx. The event was not
 * in the ledger either, so nothing said "come back for this". A paying
 * customer whose checkout landed during a Stripe blip stayed on Free with no
 * record of why.
 */
class StripeReadError extends Error {}

/**
 * Stripe error types a retry cannot fix: the request itself is wrong (a
 * subscription id that does not exist, a bad key, a permission problem). Those
 * stay "unusable" and get a 200. Everything else — connection errors, 5xx
 * `api_error`s, rate limits, and any non-Stripe exception such as a socket
 * timeout — is retryable and becomes a 500. Unknown is treated as retryable:
 * the cost of one more delivery is nothing, the cost of a dropped one is a
 * customer on the wrong plan until a reconciliation happens to run.
 */
const NON_RETRYABLE_STRIPE_TYPES: ReadonlySet<string> = new Set([
  'StripeInvalidRequestError',
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeIdempotencyError',
  'StripeCardError',
])

async function retrieveSubscription(stripe: Stripe, id: string): Promise<Stripe.Subscription> {
  try {
    return await stripe.subscriptions.retrieve(id)
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && NON_RETRYABLE_STRIPE_TYPES.has(err.type)) {
      throw err
    }
    throw new StripeReadError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * The subscription an event is about, in the shape the pinned SDK is typed for.
 *
 * The shape of `event.data.object` follows the API version the Dashboard
 * ENDPOINT was created with, not the one `stripe.ts` pins for outgoing calls.
 * An endpoint on a newer version (2025-03-31.basil and later) delivers
 * subscriptions without a top-level `current_period_end`, which would write a
 * null renewal date over a good one on every event. So when the event's
 * `api_version` is not the pinned one, the subscription is re-read through the
 * pinned client, whose answer has the shape the rest of this module reads.
 * When the versions agree the payload is used as delivered (no extra call).
 */
async function subscriptionInPinnedShape(
  stripe: Stripe,
  event: Stripe.Event
): Promise<Stripe.Subscription | null> {
  const object = event.data?.object as Stripe.Subscription | undefined
  if (!isObject(object) || typeof object.id !== 'string' || object.id.length === 0) {
    console.warn('[billing/webhook] subscription event without an object', event.id)
    return null
  }
  if (event.api_version && event.api_version !== STRIPE_API_VERSION) {
    if (!versionWarned) {
      versionWarned = true
      console.warn(
        `[billing/webhook] endpoint API version ${event.api_version} differs from the pinned ` +
          `${STRIPE_API_VERSION}; subscriptions are re-read through the pinned client. ` +
          'Create the webhook endpoint with the pinned version (docs/BILLING.md §4).'
      )
    }
    return retrieveSubscription(stripe, object.id)
  }
  return object
}

let versionWarned = false

/**
 * The subscription id on an `invoice.*` event. Older API versions carry it at
 * `invoice.subscription`; 2025-03-31.basil and later moved it to
 * `invoice.parent.subscription_details.subscription`.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const direct = idOf((invoice as { subscription?: string | { id: string } | null }).subscription)
  if (direct) return direct
  const parent = (invoice as unknown as { parent?: unknown }).parent
  if (!isObject(parent) || !isObject(parent.subscription_details)) return null
  const nested = parent.subscription_details.subscription
  return typeof nested === 'string' ? nested : isObject(nested) && typeof nested.id === 'string' ? nested.id : null
}

async function handleSubscriptionEvent(
  sub: Stripe.Subscription,
  stamp: EventStamp,
  forcedStatus?: SubscriptionStatus
): Promise<void> {
  const userId = userIdFromSubscription(sub) || (await userIdFromStoredSubscription(sub))
  if (!userId) {
    // Verified, but we cannot attribute it to an account. Retrying will not help.
    console.warn('[billing/webhook] subscription event without metadata.userId', sub.id)
    return
  }
  await applySubscription(stateFromStripe(sub, userId, forcedStatus), stamp)
}

export async function POST(req: Request): Promise<Response> {
  const stripe = getStripe()
  if (!isStripeConfigured || !stripe) {
    return NextResponse.json({
      configured: false,
      message: 'Billing is not set up in this environment — set STRIPE_SECRET_KEY.',
    })
  }
  if (!WEBHOOK_SECRET) {
    return NextResponse.json({
      configured: false,
      message:
        'STRIPE_WEBHOOK_SECRET is not set, so webhook signatures cannot be verified. See docs/BILLING.md.',
    })
  }

  // Stripe signs the RAW request body. It MUST be read as text and passed to
  // constructEvent untouched — parsing it first (req.json()) re-serialises the
  // bytes and the signature check will fail.
  const rawBody = await req.text()
  const signature = req.headers.get('stripe-signature') ?? ''

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET)
  } catch {
    // Deliberately no detail beyond the fact of it: signature failures are
    // attacker-facing, and the only reader is Stripe, which acts on the status.
    // Now JSON in the canonical shape so the webhook log greps like every other
    // route; the sentence carries no more information than the old plain text.
    return NextResponse.json(
      { error: 'Invalid signature.', code: 'bad_request' },
      { status: 400 }
    )
  }

  // IDEMPOTENCY. Checked after the signature (an unsigned body must never cost
  // a database round trip) and before any work. A redelivery of an event we
  // finished is a no-op with a 200, which is what stops Stripe retrying.
  if (await alreadyProcessed(event.id)) {
    console.info('[billing/webhook] duplicate delivery ignored', event.id, event.type)
    return NextResponse.json({ received: true, duplicate: true })
  }

  // Stripe's own clock, not ours. This is the ordering key every write below
  // carries; see the header for the interleaving it defends against.
  const stamp: EventStamp = { id: event.id, at: new Date(event.created * 1000).toISOString() }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data?.object as Stripe.Checkout.Session | undefined
        if (!isObject(session)) {
          console.warn('[billing/webhook] checkout.session.completed without an object')
          break
        }
        // Only a session THIS app created is applied. A Payment Link or a
        // one-off Checkout the operator makes on the same Stripe account
        // lets the buyer choose `client_reference_id` in the link URL, and
        // /api/billing/checkout creates nothing but subscription-mode sessions
        // that stamp the same user id into both fields.
        if (session.mode !== 'subscription') {
          console.info('[billing/webhook] ignoring non-subscription checkout session', event.id)
          break
        }
        const reference = (session.client_reference_id ?? '').trim()
        const stamped = (session.metadata?.userId ?? '').trim()
        if (!reference || reference !== stamped) {
          console.warn(
            '[billing/webhook] checkout.session.completed without a matching user id',
            event.id
          )
          break
        }
        // A non-UUID would make the rpc fail with a non-"missing object" error
        // and turn into a permanent 500 retry loop for three days.
        const checkedUser = uuid(reference, 'userId')
        if (!checkedUser.ok) {
          console.warn('[billing/webhook] checkout session user id is not a UUID', event.id)
          break
        }
        const userId = checkedUser.value
        const subscriptionId = idOf(session.subscription)
        if (!subscriptionId) {
          console.warn('[billing/webhook] subscription checkout without a subscription', event.id)
          break
        }
        // Fetch the subscription so plan, period end and status come from
        // Stripe rather than being inferred from the session.
        const sub = await retrieveSubscription(stripe, subscriptionId)
        const priceId = firstPriceId(sub)
        const planId =
          (priceId ? planIdForPriceId(priceId) : null) ?? paidPlanId(session.metadata?.planId)
        if (!planId) {
          console.error('[billing/webhook] checkout session has no known paid plan', event.id)
          break
        }
        await applySubscription(
          {
            userId,
            stripeCustomerId: idOf(session.customer) ?? idOf(sub.customer),
            stripeSubscriptionId: sub.id,
            planId,
            status: toStatus(sub.status),
            currentPeriodEnd: isoFromUnix(sub.current_period_end),
            cancelAtPeriodEnd: sub.cancel_at_period_end === true,
          },
          stamp
        )
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = await subscriptionInPinnedShape(stripe, event)
        if (sub) await handleSubscriptionEvent(sub, stamp)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = await subscriptionInPinnedShape(stripe, event)
        if (sub) await handleSubscriptionEvent(sub, stamp, 'canceled')
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data?.object as Stripe.Invoice | undefined
        const subscriptionId = isObject(invoice) ? invoiceSubscriptionId(invoice) : null
        if (!subscriptionId) {
          console.warn('[billing/webhook] invoice.payment_failed without a subscription')
          break
        }
        // The subscription is re-read LIVE, so `sub.status` is current. Forcing
        // past_due on top of it is still right at the moment the invoice fails
        // — Stripe can take a beat to move the subscription — but the ordering
        // stamp is what stops a late retry of this event from marking an
        // account delinquent after it has already recovered.
        const sub = await retrieveSubscription(stripe, subscriptionId)
        await handleSubscriptionEvent(sub, stamp, 'past_due')
        break
      }

      default:
        // Stripe retries non-2xx responses, so an event type we do not care
        // about must still be acknowledged.
        console.info('[billing/webhook] unhandled event type', event.type)
        break
    }

    // Recorded only now, after the work succeeded. See `markProcessed`.
    await markProcessed(event.id, event.type, stamp.at)
    return NextResponse.json({ received: true })
  } catch (err) {
    if (err instanceof PersistError) {
      // A database failure is transient: ask Stripe to retry.
      console.error('[billing/webhook] persist failed', err.message)
      // Stripe reads the STATUS and retries any non-2xx; the body is for a
      // human reading the webhook log in the dashboard. Same shape as every
      // other route so that log is greppable by code.
      return NextResponse.json(
        { error: 'Could not persist the subscription.', code: 'internal' },
        { status: 500 }
      )
    }
    if (err instanceof StripeReadError) {
      // Stripe itself could not be read (outage, 429, timeout). Transient, so
      // it is asked to retry exactly like a database failure — a 200 here
      // would drop the event for good. Not in the ledger, so the retry does
      // the work rather than being skipped as a duplicate.
      console.error('[billing/webhook] stripe read failed', err.message)
      return NextResponse.json(
        { error: 'Could not read the subscription from Stripe.', code: 'upstream_error' },
        { status: 500 }
      )
    }
    // A verified but malformed/unusable event: retrying will not help.
    console.error('[billing/webhook] unusable event', err)
    return NextResponse.json({ received: true, handled: false })
  }
}
