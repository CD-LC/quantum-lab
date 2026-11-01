/**
 * stripe.ts — OPTIONAL Stripe wiring.
 *
 * Qubit16 runs perfectly well with no Stripe account at all. With
 * STRIPE_SECRET_KEY absent (the default), `isStripeConfigured` is false,
 * `getStripe()` returns null, and every billing route answers with a friendly
 * "billing is not set up in this environment" payload instead of an error.
 *
 * NOTHING in this module throws at import time. It is safe to import from a
 * route handler that may run in a completely empty environment.
 */

import Stripe from 'stripe'
import {
  PLANS,
  type BillingPeriod,
  type PlanId,
  PLAN_BY_ID,
} from '@/lib/plans'

const SECRET_KEY = (process.env.STRIPE_SECRET_KEY ?? '').trim()

/** True only when STRIPE_SECRET_KEY is present and non-empty. */
export const isStripeConfigured: boolean = SECRET_KEY.length > 0

/**
 * Pinned to the API version the installed SDK (stripe 17.3.1) is typed
 * against. Bumping the SDK may require bumping this literal — a mismatch is a
 * compile error, which is exactly the early warning we want.
 */
export const STRIPE_API_VERSION = '2024-10-28.acacia'

let client: Stripe | null = null

/**
 * Lazily create (and memoise) the Stripe client.
 * Returns null when Stripe is not configured — callers must handle null.
 * Never throws.
 */
export function getStripe(): Stripe | null {
  if (!isStripeConfigured) return null
  if (client) return client
  try {
    client = new Stripe(SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  } catch {
    // A malformed key should degrade to "billing unavailable", not crash a route.
    client = null
  }
  return client
}

/** Read the env var a plan names for a period, e.g. STRIPE_PRICE_PRO_MONTHLY. */
export function priceIdFor(planId: PlanId, period: BillingPeriod): string | null {
  const plan = PLAN_BY_ID[planId]
  if (!plan) return null
  const envName = plan.stripePriceEnv[period]
  if (!envName) return null
  const value = (process.env[envName] ?? '').trim()
  return value.length > 0 ? value : null
}

/**
 * Reverse lookup used by the webhook: given the price id on an incoming
 * subscription item, which plan does it grant? Returns null for a price this
 * deployment does not know about.
 */
export function planIdForPriceId(priceId: string): PlanId | null {
  const wanted = priceId.trim()
  if (wanted.length === 0) return null
  for (const plan of PLANS) {
    const periods: BillingPeriod[] = ['monthly', 'yearly']
    for (const period of periods) {
      if (priceIdFor(plan.id, period) === wanted) return plan.id
    }
  }
  return null
}

/** Absolute origin used to build Stripe redirect URLs. */
// Same "" vs null/undefined gap as lib/seo.ts's SITE.url — `||` so a
// pass-1 build with NEXT_PUBLIC_APP_URL="" doesn't bake in an empty
// redirect origin.
export const APP_URL: string = (
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
).replace(/\/+$/, '')
