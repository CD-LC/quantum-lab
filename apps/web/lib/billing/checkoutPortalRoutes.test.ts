/**
 * checkoutPortalRoutes.test.ts — one subscription per account, and no purchase
 * path from inside the store apps.
 *
 * FAKED: `@/lib/billing/stripe`, the service-role Supabase client, the caller
 * check. Real: the route handlers' decisions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER = '11111111-1111-4111-8111-111111111111'

const world = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  rowError: false,
  created: [] as Array<Record<string, unknown>>,
  portals: [] as Array<Record<string, unknown>>,
  customers: [] as Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>,
  writes: [] as Array<Record<string, unknown>>,
  /** What the verified token says the caller's email is. */
  verifiedEmail: 'verified@example.com',
}))

vi.mock('@/lib/billing/stripe', () => ({
  isStripeConfigured: true,
  APP_URL: 'http://app.test',
  priceIdFor: (plan: string) => `price_${plan}`,
  planIdForPriceId: () => null,
  getStripe: () => ({
    customers: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        world.customers.push({ params, options })
        return { id: 'cus_new' }
      },
    },
    checkout: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          world.created.push(args)
          return { url: 'https://stripe.test/checkout' }
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          world.portals.push(args)
          return { url: 'https://stripe.test/portal' }
        },
      },
    },
  }),
}))

vi.mock('@/lib/billing/entitlements', () => ({
  getServiceSupabase: () => ({
    from: () => {
      const api = {
        select: () => api,
        eq: () => api,
        is: async () => ({ error: null }),
        update: (values: Record<string, unknown>) => {
          world.writes.push({ op: 'update', ...values })
          return api
        },
        upsert: async (values: Record<string, unknown>) => {
          world.writes.push({ op: 'upsert', ...values })
          return { error: null }
        },
        maybeSingle: async () =>
          world.rowError
            ? { data: null, error: { message: 'boom' } }
            : { data: world.row, error: null },
      }
      return api
    },
  }),
}))

vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: true, getSupabase: () => ({}) }))
vi.mock('@/lib/security/auth', () => ({
  SIGN_IN_REQUIRED: 'Sign in.',
  verifiedCallerId: async () => USER,
  verifiedCaller: async () => ({ id: USER, email: world.verifiedEmail }),
}))

const { POST: checkoutPOST } = await import('@/app/api/billing/checkout/route')
const { POST: portalPOST } = await import('@/app/api/billing/portal/route')
const { __resetRateLimitForTests } = await import('@/lib/rateLimit')

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.9', ...headers },
    body: JSON.stringify(body),
  })
}

const checkout = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  checkoutPOST(
    post('http://app.test/api/billing/checkout', { planId: 'team', period: 'monthly', userId: USER, ...body }, headers)
  )
const portal = (headers: Record<string, string> = {}) =>
  portalPOST(post('http://app.test/api/billing/portal', { userId: USER }, headers))

beforeEach(() => {
  world.row = null
  world.rowError = false
  world.created.length = 0
  world.portals.length = 0
  world.customers.length = 0
  world.writes.length = 0
  world.verifiedEmail = 'verified@example.com'
  __resetRateLimitForTests()
})

describe('POST /api/billing/checkout — one subscription per account', () => {
  it('refuses a second subscription for an account that has a live one', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      world.row = { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status }
      const response = await checkout()
      expect(response.status).toBe(409)
    }
    expect(world.created).toHaveLength(0)
  })

  it('reuses the existing Stripe customer after a cancellation', async () => {
    world.row = { stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', status: 'canceled' }

    const response = await checkout({ email: 'a@example.com' })

    expect(response.status).toBe(200)
    expect(world.created[0]).toMatchObject({ customer: 'cus_1' })
    // Stripe refuses both together.
    expect(world.created[0]).not.toHaveProperty('customer_email')
  })

  it('creates and records the Stripe customer before the first session', async () => {
    const response = await checkout()

    expect(response.status).toBe(200)
    expect(world.customers).toHaveLength(1)
    expect(world.customers[0]!.params).toMatchObject({
      email: 'verified@example.com',
      metadata: { userId: USER },
    })
    // Stable per user, so two concurrent first clicks share one customer.
    expect(String(world.customers[0]!.options.idempotencyKey)).toContain(USER)
    // Recorded so the reconciler can find a buyer whose webhook never landed.
    expect(world.writes).toContainEqual(
      expect.objectContaining({ op: 'upsert', user_id: USER, stripe_customer_id: 'cus_new', plan_id: 'free' })
    )
    // The session uses that customer — and so cannot also carry an email.
    expect(world.created[0]).toMatchObject({ customer: 'cus_new' })
    expect(world.created[0]).not.toHaveProperty('customer_email')
  })

  it('binds the customer to the verified email, not the request body', async () => {
    await checkout({ email: 'attacker@example.com' })

    expect(world.customers[0]!.params.email).toBe('verified@example.com')
  })

  it('records the customer on an existing Free row, but not on a hand-provisioned one', async () => {
    world.row = { stripe_customer_id: null, stripe_subscription_id: null, plan_id: 'free', status: 'none' }
    await checkout()
    expect(world.writes).toContainEqual(
      expect.objectContaining({ op: 'update', stripe_customer_id: 'cus_new' })
    )

    world.writes.length = 0
    world.row = { stripe_customer_id: null, stripe_subscription_id: null, plan_id: 'edu', status: 'active' }
    await checkout()
    // A row holding a customer but no subscription reads as "cancelled" to the
    // reconciler; an invoiced seat must not be exposed to that.
    expect(world.writes).toHaveLength(0)
    expect(world.created[1]).toMatchObject({ customer: 'cus_new' })
  })

  it('refuses rather than proceeding blind when the row cannot be read', async () => {
    world.rowError = true
    const response = await checkout()
    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(world.created).toHaveLength(0)
  })

  it('is still refused inside the iOS app', async () => {
    const response = await checkout({}, { 'user-agent': 'Mozilla Qubit16App/1.0' })
    expect(response.status).toBe(403)
  })
})

describe('POST /api/billing/portal', () => {
  it('opens the portal for a customer', async () => {
    world.row = { stripe_customer_id: 'cus_1' }
    const response = await portal()
    expect(response.status).toBe(200)
    expect(world.portals[0]).toMatchObject({ customer: 'cus_1' })
  })

  it('answers 403 to the iOS app, which must not reach a plan-switching portal', async () => {
    world.row = { stripe_customer_id: 'cus_1' }
    const response = await portal({ 'user-agent': 'Mozilla Qubit16App/1.0' })
    expect(response.status).toBe(403)
    expect(world.portals).toHaveLength(0)
  })
})
