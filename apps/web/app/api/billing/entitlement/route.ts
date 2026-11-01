/**
 * GET /api/billing/entitlement?userId=...
 *
 * The client's read-only view of what the server thinks a user may do. It also
 * returns the derived plan, limits and feature list so the browser does not
 * recompute them.
 *
 * This endpoint is a COURTESY for the UI and it is NOT a gate. It once claimed
 * that "every route that grants a paid capability resolves the entitlement
 * itself, server-side"; that was false when it was written — `requireFeature`,
 * `recordHardwareJob` and `assertHardwareQuota` had zero callers, so the only
 * thing between a Free account and a real hardware job was `<UpgradeGate>` in
 * the browser. The callers exist now (POST /api/hardware/submit runs the whole
 * chain, and `lib/hardware/submitGate.test.ts` fails if any link is removed),
 * but that does not make THIS route a control: it reports, it does not refuse.
 * Nothing may be granted on the strength of what it returns. docs/BILLING.md §6.
 *
 * Always answers 200 — an unknown user is simply on the free tier.
 *
 * It does have one side effect, added deliberately: it is where a subscription
 * whose renewal webhook was missed gets repaired. See `reconcileIfStale` below
 * and docs/BILLING.md §8.
 */

import { NextResponse } from 'next/server'
import { getEntitlement } from '@/lib/billing/entitlements'
import { usagePeriodEnd } from '@/lib/billing/period'
import { reconcileIfStale } from '@/lib/billing/reconcile'
import { isStripeConfigured } from '@/lib/billing/stripe'
import { isSupabaseConfigured } from '@/lib/supabase'
import { verifiedCallerId } from '@/lib/security/auth'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { uuid } from '@/lib/security/validate'
import { apiError } from '@/lib/apiError'
import { reportError } from '@/lib/observability/report'
import {
  effectivePlan,
  FREE_ENTITLEMENT,
  limitsFor,
  type Entitlement,
} from '@/lib/plans'

export const runtime = 'nodejs'

/**
 * Reads searchParams, so it must never be statically prerendered at build time.
 * Without this Next tries to evaluate it during `next build` and fails with a
 * dynamic-server-usage error.
 */
export const dynamic = 'force-dynamic'

function payload(entitlement: Entitlement): Record<string, unknown> {
  const plan = effectivePlan(entitlement)
  const limits = limitsFor(entitlement)
  return {
    entitlement,
    plan: {
      id: plan.id,
      name: plan.name,
      tagline: plan.tagline,
      contactSales: plan.contactSales === true,
    },
    // JSON has no Infinity: unlimited limits serialise as null.
    limits: {
      maxQubits: limits.maxQubits,
      maxSavedCircuits: Number.isFinite(limits.maxSavedCircuits)
        ? limits.maxSavedCircuits
        : null,
      hardwareJobsPerMonth: limits.hardwareJobsPerMonth,
      tutorMessagesPerDay: Number.isFinite(limits.tutorMessagesPerDay)
        ? limits.tutorMessagesPerDay
        : null,
      seats: Number.isFinite(limits.seats) ? limits.seats : null,
    },
    features: plan.features,
    hardwareJobsRemaining: Math.max(
      0,
      limits.hardwareJobsPerMonth - entitlement.hardwareJobsUsed
    ),
    // When the hardware allowance next resets. NOT the first of next month:
    // the quota window is the subscription's monthly anniversary (see
    // lib/billing/period.ts and docs/BILLING.md §7), and "you are out until
    // some unspecified future date" is a support ticket. `hardwareJobsUsed`
    // above is counted over exactly the window this closes.
    hardwareJobsResetAt: usagePeriodEnd(entitlement.currentPeriodEnd),
    // Whether this deployment can sell or manage a subscription at all. The
    // account page used to render "Manage billing" unconditionally and learn
    // only on click — from the portal's `configured: false` — that there was
    // nothing behind it, so on production (Stripe deliberately off) every
    // signed-in user could read an operator message. With this the UI can
    // leave the button out. Not a secret: /api/health says the same thing.
    billingEnabled: isStripeConfigured,
  }
}

/**
 * SECURITY FIX — insecure direct object reference (audit finding BILL-2).
 *
 * `?userId=<anyone>` previously returned that person's plan, subscription
 * status, renewal date, cancellation flag and hardware-usage count to any
 * anonymous caller. User ids are identifiers, not secrets — they travel in
 * share links, org member lists and Stripe `client_reference_id` — so this was
 * a working subscription-state oracle for anybody who had ever seen one.
 *
 * The caller must now prove ownership with a Supabase access token. Returns
 * null when no valid token is present. The helper itself now lives in
 * lib/security/auth.ts, shared with the portal and org routes.
 */

export async function GET(req: Request): Promise<Response> {
  try {
    // SECURITY FIX (audit finding RATE-1): each miss costs two Supabase round
    // trips, so an unauthenticated caller could previously drive database load
    // for free. Per-instance limiter — see lib/security/ratelimit.ts.
    const limit = check(clientKey(req.headers, 'entitlement'), 60, 60_000)
    if (!limit.allowed) {
      return apiError('rate_limited', { headers: retryHeaders(limit) })
    }

    const raw = new URL(req.url).searchParams.get('userId')
    if (!raw || !raw.trim()) return NextResponse.json(payload(FREE_ENTITLEMENT))

    // SECURITY FIX (audit finding VAL-1): shape-check before it reaches a query.
    const checked = uuid(raw, 'userId')
    if (!checked.ok) return NextResponse.json(payload(FREE_ENTITLEMENT))

    // SECURITY FIX (audit finding BILL-2). Only enforced when Supabase is
    // configured: with an empty environment getEntitlement() returns FREE for
    // everyone regardless, so there is nothing to leak and the zero-config path
    // keeps its "always 200, always free" contract exactly as documented above.
    if (isSupabaseConfigured) {
      const caller = await verifiedCallerId(req)
      if (caller !== checked.value) {
        // Do not confirm or deny that the id exists: answer as for a stranger.
        return NextResponse.json(payload(FREE_ENTITLEMENT), {
          headers: { 'x-entitlement-authenticated': 'false' },
        })
      }
    }

    const entitlement = await getEntitlement(checked.value)

    // SELF-HEALING (the automatic half of §3, reconciliation). A
    // `current_period_end` more than a day in the past means a renewal happened
    // at Stripe and its webhook never reached us — the row says the customer's
    // period ended, so the product is denying someone who is still paying.
    // `reconcileIfStale` re-reads Stripe, rewrites the row and answers true
    // only when something actually changed; it is a no-op for everybody else,
    // including every free account and every account whose period is current.
    //
    // It runs on THIS route and not on a hot page render because this is the
    // one place the freshness of the row is already the question being asked,
    // and because the handler below already swallows every failure into the
    // free tier — a Stripe outage here cannot break the page. The cooldown and
    // the narrowness of the staleness test are in lib/billing/reconcile.ts;
    // both exist to bound Stripe calls, which are account-wide rate limited.
    // The stored status is passed so a lapsed ex-subscriber (canceled, whose
    // period end is in the past for good) is not re-queried every cooldown.
    const repaired = await reconcileIfStale(
      checked.value,
      entitlement.currentPeriodEnd,
      new Date(),
      entitlement.status
    )
    if (repaired) {
      return NextResponse.json(payload(await getEntitlement(checked.value)))
    }
    return NextResponse.json(payload(entitlement))
  } catch (err) {
    // Never fail: fall back to free. This is the ONE route in app/api that
    // deliberately answers 200 on an exception, because the alternative — the
    // UI treating an outage as "no plan information" — is what it already
    // renders anyway, and a paid user seeing an error box on every page load
    // because Supabase blipped is worse. The failure is not silent: it is
    // reported, so an outage here is visible in the error tracker even though
    // it is invisible in the browser.
    reportError(err, { route: 'billing/entitlement' })
    console.error('[billing/entitlement]', err)
    return NextResponse.json(payload(FREE_ENTITLEMENT))
  }
}
