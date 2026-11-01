/**
 * POST /api/billing/portal
 *
 * Opens the Stripe customer portal for an existing subscriber so they can
 * change card, switch plan, or cancel. Mirrors checkout's "never error out
 * when billing is unconfigured" contract.
 */

import { NextResponse } from 'next/server'
import { NATIVE_SHELL_UA_TOKEN } from '@/lib/app-shell'
import { APP_URL, getStripe, isStripeConfigured } from '@/lib/billing/stripe'
import { getServiceSupabase } from '@/lib/billing/entitlements'
import { isSupabaseConfigured } from '@/lib/supabase'
import { SIGN_IN_REQUIRED, verifiedCallerId } from '@/lib/security/auth'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { isRecord, safeJson, uuid } from '@/lib/security/validate'
import { apiError, badRequest, failure } from '@/lib/apiError'

export const runtime = 'nodejs'

/**
 * SECURITY FIX — broken object-level authorisation (audit finding BILL-1).
 *
 * Before this change the handler took `userId` straight from the request body
 * and opened a Stripe billing portal session for it. Anyone who learned any
 * user id could POST it here and receive a URL granting full control of that
 * person's subscription: their invoices (with billing name and address), their
 * card, and the cancel button. No credential of any kind was required.
 *
 * The caller's identity now comes from a verified Supabase access token and
 * nothing else. `getUser(token)` asks Supabase to validate the JWT, so a forged
 * or expired token fails.
 *
 * The helper itself now lives in lib/security/auth.ts so the org and billing
 * routes cannot drift apart; the behaviour is unchanged (bearer header, or the
 * `x-supabase-auth` fallback for cookie-based deployments; returns null when no
 * valid token is present; never throws).
 */

interface PortalBody {
  userId?: string
}

/**
 * Customer-facing. The operator detail ("set STRIPE_SECRET_KEY…") used to be
 * the `message`, and the account page renders `message` verbatim — so every
 * signed-in user on production, where Stripe is deliberately off, read
 * deployment instructions behind "Manage billing". Operators get `hint`.
 */
export const PORTAL_NOT_OPEN =
  'Billing is not open on this deployment yet, so there is nothing to manage. Your plan and usage above are accurate.'

export async function POST(req: Request): Promise<Response> {
  // Never from inside the App Store app. The portal is created with plan
  // changes enabled (docs/BILLING.md §2), so from a store app it is an outside
  // purchase path for a digital subscription — exactly what App Store guideline
  // 3.1.1 / Play's payments policy refuse. Same backstop as checkout; the UI
  // hides the button (lib/app-shell.ts) and this catches whatever it misses.
  // The Android app is real Chrome and cannot be told apart by user agent.
  if ((req.headers.get('user-agent') ?? '').includes(NATIVE_SHELL_UA_TOKEN)) {
    return NextResponse.json(
      { error: 'Billing is managed on the website, not in the app.', code: 'forbidden' },
      { status: 403 },
    )
  }
  if (!isStripeConfigured) {
    return NextResponse.json({
      configured: false,
      message: PORTAL_NOT_OPEN,
      hint: 'Set STRIPE_SECRET_KEY to enable the customer portal. See docs/BILLING.md.',
    })
  }

  // SECURITY FIX (audit finding RATE-1): portal session creation is an
  // authenticated, money-adjacent Stripe API call. Shared-store limiter — see
  // lib/rateLimit.ts. Keyed on the IP: this runs BEFORE the caller's token is
  // verified, deliberately, so an unauthenticated flood is refused without
  // spending a Supabase round trip on it.
  const limit = await rateLimit(callerKey(req.headers, 'billing-portal'), {
    limit: 10,
    windowMs: 60_000,
  })
  if (!limit.allowed) {
    return apiError('rate_limited', { headers: retryAfterHeaders(limit) })
  }

  // SECURITY FIX (audit finding VAL-1): bounded read + JSON.parse with a byte
  // ceiling, instead of an unbounded req.json().
  const parsed = safeJson(await req.text(), 4_096)
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value)) return badRequest('Expected a JSON object.')
  const body: PortalBody = { userId: typeof parsed.value.userId === 'string' ? parsed.value.userId : undefined }

  // SECURITY FIX (audit finding VAL-1): a userId is a Supabase UUID; anything
  // else was previously passed straight into a database filter.
  const checked = uuid(body.userId, 'userId')
  if (!checked.ok) return badRequest(checked.error)
  const userId = checked.value

  if (!isSupabaseConfigured) {
    return NextResponse.json({
      configured: false,
      message: PORTAL_NOT_OPEN,
      hint: 'No database is configured, so there is no stored Stripe customer to open a portal for.',
    })
  }

  // SECURITY FIX (audit finding BILL-1): the body may only ask about the caller.
  // This runs ONLY when Supabase is configured — with an empty environment the
  // branch above has already returned `configured: false`, so the zero-config
  // path is untouched and there are no accounts to protect anyway.
  const caller = await verifiedCallerId(req)
  if (caller === null) return signInRequired()
  if (caller !== userId) {
    return apiError('forbidden', { message: 'You can only manage your own billing.' })
  }

  try {
    const supabase = getServiceSupabase()
    if (!supabase) {
      return NextResponse.json({
        configured: false,
        message: PORTAL_NOT_OPEN,
        hint: 'SUPABASE_SERVICE_ROLE_KEY is not set, so the stored Stripe customer id cannot be read.',
      })
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      // Supabase hands back a PostgrestError whose `message` and `details` can
      // name the table, the column and the failing SQL. It never reaches the
      // browser; it goes to the error tracker with the route name attached.
      // This was also a 200 before, so the account page rendered "success" on a
      // database failure.
      return failure('internal', error, { route: 'billing/portal', stage: 'subscription-lookup' }, {
        message: 'Could not look up your billing record.',
      })
    }

    const customer = (data as { stripe_customer_id?: string | null } | null)
      ?.stripe_customer_id

    if (!customer) {
      // 409, not 500: nothing failed. The account simply has no Stripe customer
      // yet, and the fix is to subscribe. Kept distinguishable from a lookup
      // failure so the account page can offer the pricing page instead of a
      // retry button.
      return apiError('conflict', {
        message: 'No Stripe customer is linked to this account yet — subscribe first.',
      })
    }

    const stripe = getStripe()
    if (!stripe) {
      return NextResponse.json({
        configured: false,
        message: PORTAL_NOT_OPEN,
        hint: 'Stripe could not be initialised — check STRIPE_SECRET_KEY.',
      })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_URL}/account`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    // SECURITY FIX (audit finding LEAK-1): a Stripe SDK error message can carry
    // the request id, the account mode and occasionally a key fragment. Log the
    // detail server-side; tell the browser only that it failed.
    console.error('[billing/portal]', err)
    return failure('upstream_error', err, { route: 'billing/portal' }, {
      message: 'Could not open the billing portal.',
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
