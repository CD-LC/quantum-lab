/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout Session for a self-serve plan.
 *
 * With no Stripe configured this returns 200 { configured: false, message }
 * rather than an error, so the pricing page can show a calm "billing is not
 * set up in this environment" state instead of a red toast.
 */

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { NATIVE_SHELL_UA_TOKEN } from '@/lib/app-shell'
import { APP_URL, getStripe, isStripeConfigured, priceIdFor } from '@/lib/billing/stripe'
import { getServiceSupabase } from '@/lib/billing/entitlements'
import { PLAN_BY_ID, type BillingPeriod, type PlanId } from '@/lib/plans'
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCaller } from '@/lib/security/auth'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { email as validEmail, isRecord, safeJson, uuid } from '@/lib/security/validate'
import { apiError, badRequest, failure } from '@/lib/apiError'

export const runtime = 'nodejs'

interface CheckoutBody {
  planId?: string
  period?: string
  userId?: string
  email?: string
}

const PERIODS: BillingPeriod[] = ['monthly', 'yearly']

function isPlanId(value: unknown): value is PlanId {
  return (
    value === 'free' || value === 'pro' || value === 'team' || value === 'edu'
  )
}

function isPeriod(value: unknown): value is BillingPeriod {
  return typeof value === 'string' && (PERIODS as string[]).includes(value)
}

/**
 * What the account page and pricing page show a CUSTOMER when billing is not
 * configured on this deployment. The operator detail that used to be here
 * ("set STRIPE_SECRET_KEY … see docs/BILLING.md") was rendered verbatim to
 * every real user on production, where Stripe is deliberately off; it now
 * travels in `hint`, which no UI renders.
 */
export const BILLING_NOT_OPEN =
  'Paid plans are not open on this deployment yet. Everything on the Free plan works, and nothing here is charged.'

/** A subscription in this state must be changed in the portal, not re-bought. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due'])

const ALREADY_SUBSCRIBED =
  'This account already has a subscription. Change plans from "Manage billing" on your account page, which keeps one subscription and prorates the difference.'

interface ExistingBilling {
  customerId: string | null
  /** Whether a subscriptions row exists at all, and the plan it holds. */
  hasRow: boolean
  planId: string | null
  /** True when the row holds a live subscription (active / trialing / past_due). */
  live: boolean
}

/**
 * The caller's existing Stripe state, from our own row.
 *
 * Checkout used to ignore it. `stripe.checkout.sessions.create` with only a
 * `customer_email` makes a NEW customer every time, so a Pro subscriber who
 * clicked "Upgrade to Team" was charged for two concurrent subscriptions on two
 * Stripe customers. `checkout.session.completed` then overwrote
 * `stripe_customer_id` with the newer one, so the portal could only ever reach
 * the second subscription and the customer had no self-serve way to cancel the
 * first — while every renewal event from either rewrote the same row, so the
 * plan flipped between Pro and Team depending on which fired last.
 *
 * @returns null when the row cannot be read. The caller refuses in that case:
 *   this is the one check that stands between a customer and a double charge,
 *   and "proceed blind" was the previous behaviour.
 */
async function existingBilling(userId: string): Promise<ExistingBilling | null> {
  const supabase = getServiceSupabase()
  // No service role: nothing was ever written, so there is nothing to reuse.
  if (!supabase) return { customerId: null, hasRow: false, planId: null, live: false }
  const { data, error } = await supabase
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, plan_id, status')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return null
  const row = data as {
    stripe_customer_id?: string | null
    stripe_subscription_id?: string | null
    plan_id?: string | null
    status?: string | null
  } | null
  return {
    customerId: row?.stripe_customer_id ?? null,
    hasRow: row !== null,
    planId: row?.plan_id ?? null,
    live: Boolean(row?.stripe_subscription_id) && LIVE_STATUSES.has(row?.status ?? ''),
  }
}

/**
 * Create the Stripe customer BEFORE the session and record it, for a first-time
 * buyer.
 *
 * A session created with only `customer_email` makes a NEW customer per
 * session. Two consequences: an abandoned Pro checkout followed by a Team one
 * could both be completed (two customers, two charged subscriptions, one row),
 * and when the first `checkout.session.completed` never landed there was no row
 * and no customer id, so `reconcileEntitlement` answered `unknown_customer`
 * forever. With the customer created here and its id stored, every later
 * session reuses it and the reconciler can list its subscriptions.
 *
 * The idempotency key makes two concurrent first clicks resolve to the SAME
 * customer. The email is the VERIFIED caller's, never the request body's.
 *
 * Recording is deliberately narrow: a new row, or the customer id of a Free
 * row. A hand-provisioned row (an invoiced University seat, say) is left alone,
 * because a row that holds a customer but no subscription is what the
 * reconciler reads as "cancelled" and downgrades. A persistence failure is
 * logged, not fatal: the session still proceeds on the customer, and the
 * webhook records it on completion.
 */
async function ensureCustomer(
  stripe: Stripe,
  supabase: SupabaseClient,
  userId: string,
  email: string | undefined,
  existing: ExistingBilling
): Promise<string> {
  const customer = await stripe.customers.create(
    { ...(email ? { email } : {}), metadata: { userId } },
    // Stripe rejects a reused key whose parameters differ, so the email is part
    // of the key: an address change within the key's 24h life must not 500.
    { idempotencyKey: `qubit16-customer-${userId}-${createHash('sha256').update(email ?? '').digest('hex').slice(0, 12)}` }
  )
  try {
    if (!existing.hasRow) {
      const { error } = await supabase
        .from('subscriptions')
        .upsert(
          { user_id: userId, stripe_customer_id: customer.id, plan_id: 'free', status: 'none' },
          { onConflict: 'user_id', ignoreDuplicates: true }
        )
      if (error) console.error('[billing/checkout] could not record customer', error.message)
    } else if ((existing.planId ?? 'free') === 'free') {
      const { error } = await supabase
        .from('subscriptions')
        .update({ stripe_customer_id: customer.id })
        .eq('user_id', userId)
        .is('stripe_customer_id', null)
      if (error) console.error('[billing/checkout] could not record customer', error.message)
    }
  } catch (err) {
    console.error('[billing/checkout] could not record customer', err)
  }
  return customer.id
}

export async function POST(req: Request): Promise<Response> {
  // Never from inside the App Store app: Apple refuses apps that sell digital
  // subscriptions through an outside checkout (guideline 3.1.1). The UI hides
  // every way here (lib/app-shell.ts); this is the backstop. The Android app is
  // real Chrome and cannot be told apart by user agent, so it relies on the UI.
  if ((req.headers.get('user-agent') ?? '').includes(NATIVE_SHELL_UA_TOKEN)) {
    return NextResponse.json(
      { error: 'Subscriptions are not available in the app.' },
      { status: 403 },
    )
  }
  if (!isStripeConfigured) {
    return NextResponse.json({
      configured: false,
      message: BILLING_NOT_OPEN,
      hint: 'Set STRIPE_SECRET_KEY (and the STRIPE_PRICE_* ids) to enable checkout. See docs/BILLING.md.',
    })
  }

  // SECURITY FIX (audit finding RATE-1): every accepted request creates a real
  // Stripe Checkout Session. Shared-store limiter — see lib/rateLimit.ts, which
  // counts in Redis when one is configured and warns loudly when it cannot.
  // The message is fixed and reveals nothing about any other caller's bucket.
  const limit = await rateLimit(callerKey(req.headers, 'checkout'), {
    limit: 10,
    windowMs: 60_000,
  })
  if (!limit.allowed) {
    return apiError('rate_limited', {
      message: 'Too many checkout attempts. Wait a moment and try again.',
      headers: retryAfterHeaders(limit),
    })
  }

  // SECURITY FIX (audit finding VAL-1): bounded body, then a byte-capped parse.
  const parsed = safeJson(await req.text(), 4_096)
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value)) return badRequest('Expected a JSON object.')
  const raw = parsed.value

  // SECURITY FIX (audit finding VAL-1): `userId` and `email` were previously
  // copied unchecked into Stripe session metadata and `customer_email`. An
  // unbounded or malformed value there is a data-integrity problem in the
  // webhook (which reads metadata.userId back) and a way to attach arbitrary
  // text to a Stripe customer record.
  let userId: string | undefined
  if (raw.userId !== undefined && raw.userId !== null && raw.userId !== '') {
    const checked = uuid(raw.userId, 'userId')
    if (!checked.ok) return badRequest(checked.error)
    userId = checked.value
  }
  let email: string | undefined
  if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
    const checked = validEmail(raw.email)
    if (!checked.ok) return badRequest(checked.error)
    email = checked.value
  }

  // SECURITY FIX (audit findings BILL-1 / VAL-1, same principle): `userId` is
  // stamped into `client_reference_id` and session metadata, and the Stripe
  // webhook reads it back to decide WHOSE subscription row to write. So it is
  // identity, and identity may not come from a request body. When Supabase is
  // configured and a userId is supplied it must be the caller's own, proved by
  // a verified access token.
  //
  // And with accounts configured, a checkout REQUIRES a signed-in caller. An
  // anonymous checkout carried no user id, so the webhook could not attribute
  // it and dropped it: the customer was charged and stayed on Free. With no
  // Supabase at all there is no account to attach a plan to anyway, and the
  // zero-config path is unchanged.
  if (isSupabaseConfigured) {
    const caller = await verifiedCaller(req)
    if (caller === null) return signInRequired()
    if (userId && caller.id !== userId) {
      return apiError('forbidden', {
        message: 'You can only start a checkout for your own account.',
      })
    }
    userId = caller.id
    // The email Stripe is given is the one Supabase vouches for, not the one
    // in the body: a body email would let any signed-in caller attach an
    // arbitrary address to a Stripe customer record (receipts and dunning
    // mail go there).
    email = caller.email || undefined
  }

  const body: CheckoutBody = {
    planId: typeof raw.planId === 'string' ? raw.planId : undefined,
    period: typeof raw.period === 'string' ? raw.period : undefined,
    userId,
    email,
  }
  const { planId, period } = body

  if (!isPlanId(planId)) {
    return badRequest('Unknown planId.')
  }
  if (!isPeriod(period)) {
    return badRequest("period must be 'monthly' or 'yearly'.")
  }

  const plan = PLAN_BY_ID[planId]
  if (plan.id === 'free') {
    return badRequest('The Free plan does not require checkout.')
  }
  if (plan.contactSales) {
    return badRequest(`${plan.name} is sold through our team — please contact sales.`)
  }

  const price = priceIdFor(plan.id, period)
  if (!price) {
    const envName = plan.stripePriceEnv[period]
    return NextResponse.json({
      configured: false,
      message: `${plan.name} is not available for purchase on this deployment yet.`,
      hint: `No Stripe price is configured for ${plan.name} (${period}) — set ${envName || 'the plan price env var'} to the price id from your Stripe dashboard. See docs/BILLING.md.`,
    })
  }

  const stripe = getStripe()
  if (!stripe) {
    return NextResponse.json({
      configured: false,
      message: BILLING_NOT_OPEN,
      hint: 'Stripe could not be initialised — check STRIPE_SECRET_KEY.',
    })
  }

  // ONE customer, ONE subscription per account. See `existingBilling`.
  let customer: string | null = null
  if (userId) {
    const existing = await existingBilling(userId)
    if (existing === null) {
      return failure(
        'internal',
        new Error('subscriptions row unreadable before checkout'),
        { route: 'billing/checkout', stage: 'existing-subscription-lookup' },
        { message: 'Could not check your current subscription. Try again shortly.' }
      )
    }
    if (existing.live) {
      // 409, not 400: the request is well-formed, the account's state is what
      // refuses it. The portal (POST /api/billing/portal) already allows plan
      // changes — docs/BILLING.md §2 — and does so on the existing subscription.
      return apiError('conflict', { message: ALREADY_SUBSCRIBED })
    }
    customer = existing.customerId
    const service = getServiceSupabase()
    if (!customer && service) {
      try {
        customer = await ensureCustomer(stripe, service, userId, email, existing)
      } catch (err) {
        console.error('[billing/checkout]', err)
        return failure('upstream_error', err, { route: 'billing/checkout', stage: 'customer' }, {
          message: 'Could not start checkout right now.',
        })
      }
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_URL}/account?checkout=success`,
      cancel_url: `${APP_URL}/pricing?checkout=cancelled`,
      allow_promotion_codes: true,
      ...(userId ? { client_reference_id: userId } : {}),
      // Stripe refuses `customer` together with `customer_email`, and reusing
      // the customer is the point: a re-subscribe after a cancellation lands on
      // the same Stripe customer, so the portal, invoices and reconcile all
      // keep seeing one account. The email is only a prefill for a first-time
      // buyer.
      ...(customer ? { customer } : email ? { customer_email: email } : {}),
      metadata: {
        planId: plan.id,
        period,
        userId: userId ?? '',
      },
      // The SUBSCRIPTION carries the user id too: every later lifecycle event
      // (plan change, cancellation, past-due) arrives as a subscription object,
      // and the webhook attributes it by this metadata.
      ...(userId ? { subscription_data: { metadata: { planId: plan.id, userId } } } : {}),
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    // SECURITY FIX (audit finding LEAK-1): the comment said "never leak a Stripe
    // stack trace" but the code returned `err.message` verbatim, which can name
    // the account, the API version, a request id, or a misconfigured price env
    // var. The detail now stays server-side.
    //
    // AND IT USED TO GO OUT AS HTTP 200. `NextResponse.json({ error })` with no
    // second argument is a 200, so PricingTable's `res.ok` check passed and the
    // browser fell through to reading `body.url` — undefined — and did nothing
    // visible. A failed Stripe call is a 502: Stripe answered, badly.
    console.error('[billing/checkout]', err)
    return failure('upstream_error', err, { route: 'billing/checkout' }, {
      message: 'Could not start checkout right now.',
    })
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
