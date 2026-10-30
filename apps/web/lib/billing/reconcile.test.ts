/**
 * reconcile.test.ts — re-deriving an entitlement from Stripe when no webhook
 * arrived.
 *
 * (It lives under lib/ rather than beside the route because vitest.config.ts
 * only collects `lib/**`; `submitGate.test.ts` does the same.)
 *
 * FAKED: `@/lib/billing/stripe` and `@supabase/supabase-js`. Real: the
 * reconciler's own decisions — which subscription of several is authoritative,
 * what "the customer has none" means, when the automatic path is allowed to
 * fire, and whether the entitlement route actually calls it. That last one is
 * the test that matters most: this project has shipped an entire enforcement
 * layer with zero callers before, and a reconciler nothing invokes is the same
 * bug with a different name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface SubRow {
  user_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_id: string
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  last_event_id?: string | null
  last_event_at?: string | null
}

const db = vi.hoisted(() => {
  const state = {
    subscriptions: [] as SubRow[],
    hardware_usage: [] as Record<string, unknown>[],
    tokens: new Map<string, string>(),
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  }

  function rows(name: string): Record<string, unknown>[] {
    if (name === 'subscriptions') return state.subscriptions as unknown as Record<string, unknown>[]
    if (name === 'hardware_usage') return state.hardware_usage
    return []
  }

  function table(name: string) {
    const q = { eqs: [] as Array<[string, unknown]>, head: false }
    const matches = (row: Record<string, unknown>) => q.eqs.every(([c, v]) => row[c] === v)
    function run(mode: 'many' | 'maybe'): Promise<unknown> {
      const hits = rows(name).filter(matches)
      if (q.head) return Promise.resolve({ data: null, error: null, count: hits.length })
      if (mode === 'maybe') return Promise.resolve({ data: hits[0] ?? null, error: null })
      return Promise.resolve({ data: hits, error: null, count: hits.length })
    }
    const api = {
      select(_cols?: string, opts?: { head?: boolean }) {
        if (opts?.head) q.head = true
        return api
      },
      eq(col: string, val: unknown) {
        q.eqs.push([col, val])
        return api
      },
      gte: () => api,
      maybeSingle: () => run('maybe'),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        run('many').then(resolve, reject),
    }
    return api
  }

  const client = {
    from: (name: string) => table(name),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      if (name !== 'apply_stripe_subscription') {
        return { data: null, error: { code: 'PGRST202', message: 'unknown function' } }
      }
      const userId = args.p_user_id as string
      const existing = state.subscriptions.find((r) => r.user_id === userId)
      const next: SubRow = {
        user_id: userId,
        stripe_customer_id: (args.p_customer_id as string | null) ?? null,
        stripe_subscription_id: (args.p_subscription_id as string | null) ?? null,
        plan_id: String(args.p_plan_id ?? 'free'),
        status: String(args.p_status ?? 'none'),
        current_period_end: (args.p_current_period_end as string | null) ?? null,
        cancel_at_period_end: args.p_cancel_at_period_end === true,
        last_event_id: (args.p_event_id as string | null) ?? null,
        last_event_at: (args.p_event_at as string | null) ?? null,
      }
      if (existing) Object.assign(existing, next)
      else state.subscriptions.push(next)
      return { data: [{ applied: true }], error: null }
    },
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens.get(token)
        if (!id) return { data: { user: null }, error: { message: 'bad jwt' } }
        return { data: { user: { id } }, error: null }
      },
    },
  }
  return { state, client }
})

const stripe = vi.hoisted(() => {
  const state = {
    /** customer id → the subscriptions Stripe will report for it. */
    byCustomer: new Map<string, Array<Record<string, unknown>>>(),
    listCalls: 0,
    fail: false,
  }
  const client = {
    subscriptions: {
      list: async ({ customer }: { customer: string }) => {
        state.listCalls += 1
        if (state.fail) throw new Error('stripe timed out')
        return { data: state.byCustomer.get(customer) ?? [] }
      },
    },
  }
  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: true, getSupabase: () => db.client }))
vi.mock('@/lib/billing/stripe', () => ({
  isStripeConfigured: true,
  getStripe: () => stripe.client,
  planIdForPriceId: (id: string) => (id === 'price_pro' ? 'pro' : id === 'price_team' ? 'team' : null),
  priceIdFor: () => null,
  APP_URL: 'http://app.test',
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

const { reconcileEntitlement, reconcileIfStale, __resetReconcileCooldown } = await import(
  './reconcile'
)
const { GET: entitlementGET } = await import('@/app/api/billing/entitlement/route')
const { resetAll } = await import('@/lib/security/ratelimit')

// Read at module load by the route, so it must be set before the import below.
process.env.BILLING_RECONCILE_SECRET = 'operator-secret'
const { POST: reconcilePOST } = await import('@/app/api/billing/reconcile/route')
const { __resetRateLimitForTests } = await import('@/lib/rateLimit')

const USER = '11111111-1111-4111-8111-111111111111'

function stripeSub(
  id: string,
  priceId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1_750_000_000,
    created: 1_700_000_000,
    metadata: { userId: USER },
    items: { data: [{ price: { id: priceId } }] },
    ...overrides,
  }
}

function storedRow(overrides: Partial<SubRow> = {}): void {
  db.state.subscriptions.push({
    user_id: USER,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    plan_id: 'free',
    status: 'none',
    current_period_end: null,
    cancel_at_period_end: false,
    ...overrides,
  })
}

const row = () => db.state.subscriptions.find((r) => r.user_id === USER)

beforeEach(() => {
  db.state.subscriptions.length = 0
  db.state.hardware_usage.length = 0
  db.state.rpcCalls.length = 0
  db.state.tokens.clear()
  stripe.state.byCustomer.clear()
  stripe.state.listCalls = 0
  stripe.state.fail = false
  __resetReconcileCooldown()
  resetAll()
  __resetRateLimitForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('reconcileEntitlement', () => {
  it('picks up an upgrade whose webhook never arrived', async () => {
    storedRow({ plan_id: 'free', status: 'none' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    const outcome = await reconcileEntitlement(USER)

    expect(outcome).toMatchObject({ status: 'reconciled', planId: 'pro', changed: true })
    expect(row()?.plan_id).toBe('pro')
    expect(row()?.status).toBe('active')
  })

  it('picks up a cancellation whose webhook never arrived', async () => {
    storedRow({ plan_id: 'pro', status: 'active' })
    // The customer exists at Stripe and holds nothing. That is a cancellation,
    // and it is the case that costs the operator money if it is missed.
    stripe.state.byCustomer.set('cus_1', [])

    const outcome = await reconcileEntitlement(USER)

    expect(outcome).toMatchObject({ status: 'reconciled', planId: 'free', changed: true })
    expect(row()?.plan_id).toBe('free')
    expect(row()?.status).toBe('canceled')
  })

  it('takes the entitling subscription when a customer holds several', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [
      stripeSub('sub_old', 'price_team', { status: 'canceled', created: 1_800_000_000 }),
      stripeSub('sub_new', 'price_pro', { status: 'active', created: 1_700_000_000 }),
    ])

    const outcome = await reconcileEntitlement(USER)

    // Newest-by-created would have picked the canceled Team one and locked a
    // paying customer out.
    expect(outcome).toMatchObject({ planId: 'pro' })
    expect(row()?.stripe_subscription_id).toBe('sub_new')
  })

  it('does not keep paid access for an unpaid subscription', async () => {
    storedRow({ plan_id: 'pro', status: 'active' })
    // Stripe's `unpaid`: dunning finished, no further charges. It used to map
    // onto past_due (grace) and so kept Pro for as long as the account existed.
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro', { status: 'unpaid' })])

    await reconcileEntitlement(USER)

    expect(row()?.status).toBe('canceled')
  })

  it('prefers a canceled subscription over an unpaid one', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [
      stripeSub('sub_unpaid', 'price_pro', { status: 'unpaid', created: 1_800_000_000 }),
      stripeSub('sub_canceled', 'price_team', { status: 'canceled', created: 1_700_000_000 }),
    ])

    await reconcileEntitlement(USER)

    expect(row()?.stripe_subscription_id).toBe('sub_canceled')
  })

  it('writes with a null stamp, so it is never dropped as stale', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    await reconcileEntitlement(USER)

    const call = db.state.rpcCalls.find((c) => c.name === 'apply_stripe_subscription')
    // A live read cannot be stale relative to any event, so it carries no
    // ordering stamp — see apply_stripe_subscription.
    expect(call?.args.p_event_at).toBeNull()
  })

  it('leaves the row alone when Stripe cannot be reached', async () => {
    storedRow({ plan_id: 'pro', status: 'active' })
    stripe.state.fail = true

    const outcome = await reconcileEntitlement(USER)

    expect(outcome.status).toBe('failed')
    // Downgrading someone because Stripe timed out is the expensive mistake.
    expect(row()?.plan_id).toBe('pro')
    expect(db.state.rpcCalls).toHaveLength(0)
  })

  it('does nothing for an account that has never checked out', async () => {
    const outcome = await reconcileEntitlement(USER)

    expect(outcome.status).toBe('unknown_customer')
    expect(stripe.state.listCalls).toBe(0)
  })
})

describe('reconcileIfStale', () => {
  it('fires only when the period end is more than a day in the past', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])
    const now = new Date('2025-06-10T00:00:00Z')

    // Current period: nothing to do.
    expect(await reconcileIfStale(USER, '2025-06-20T00:00:00Z', now)).toBe(false)
    // Ended an hour ago: Stripe may simply not have got to the renewal yet.
    expect(await reconcileIfStale(USER, '2025-06-09T23:00:00Z', now)).toBe(false)
    // No period at all (a free account): never.
    expect(await reconcileIfStale(USER, null, now)).toBe(false)
    expect(stripe.state.listCalls).toBe(0)

    // Two days past its end: the renewal was missed.
    expect(await reconcileIfStale(USER, '2025-06-08T00:00:00Z', now)).toBe(true)
    expect(stripe.state.listCalls).toBe(1)
    expect(row()?.plan_id).toBe('pro')
  })

  it('never re-queries Stripe for a lapsed ex-subscriber', async () => {
    storedRow({ plan_id: 'pro', status: 'canceled' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro', { status: 'canceled' })])
    const now = new Date('2025-06-10T00:00:00Z')
    const longAgo = '2025-01-01T00:00:00Z'

    // The period end of a cancelled row is in the past for good, so the age
    // test alone matches forever. The status stops it.
    for (const status of ['canceled', 'none', 'incomplete'] as const) {
      expect(await reconcileIfStale(USER, longAgo, now, status)).toBe(false)
    }
    expect(stripe.state.listCalls).toBe(0)

    // A row that still claims access is the case worth repairing.
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      __resetReconcileCooldown()
      await reconcileIfStale(USER, longAgo, now, status)
    }
    expect(stripe.state.listCalls).toBe(3)
  })

  it('does not call Stripe again within the cooldown', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])
    const now = new Date('2025-06-10T00:00:00Z')
    const stale = '2025-06-01T00:00:00Z'

    await reconcileIfStale(USER, stale, now)
    await reconcileIfStale(USER, stale, new Date(now.getTime() + 60_000))
    await reconcileIfStale(USER, stale, new Date(now.getTime() + 5 * 60_000))

    // Stripe rate-limits the ACCOUNT, so a hot page must not be able to turn
    // one stale row into a Stripe incident for every customer.
    expect(stripe.state.listCalls).toBe(1)

    await reconcileIfStale(USER, stale, new Date(now.getTime() + 11 * 60_000))
    expect(stripe.state.listCalls).toBe(2)
  })
})

describe('GET /api/billing/entitlement — the reconciler has a caller', () => {
  function request(userId: string, token: string | null): Request {
    const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.9' }
    if (token) headers.authorization = `Bearer ${token}`
    return new Request(`http://app.test/api/billing/entitlement?userId=${userId}`, { headers })
  }

  it('self-heals a subscription whose renewal webhook was missed', async () => {
    db.state.tokens.set('jwt', USER)
    // The row says the period ended a week ago and it is still Pro/active. Stripe
    // says the customer moved to Team. Only a row still claiming access can be
    // provably behind Stripe, and that is the one worth repairing.
    storedRow({
      plan_id: 'pro',
      status: 'active',
      current_period_end: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_team')])

    const response = await entitlementGET(request(USER, 'jwt'))
    const body = (await response.json()) as { entitlement: { planId: string } }

    expect(stripe.state.listCalls).toBe(1)
    // The response reflects the RE-READ row, not the stale one it started with.
    expect(body.entitlement.planId).toBe('team')
    expect(row()?.plan_id).toBe('team')
  })

  it('does not hit Stripe for a lapsed ex-subscriber on every fetch', async () => {
    db.state.tokens.set('jwt', USER)
    storedRow({
      plan_id: 'pro',
      status: 'canceled',
      current_period_end: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro', { status: 'canceled' })])

    await entitlementGET(request(USER, 'jwt'))
    __resetReconcileCooldown()
    await entitlementGET(request(USER, 'jwt'))

    expect(stripe.state.listCalls).toBe(0)
  })

  it('tells the UI whether billing exists on this deployment', async () => {
    db.state.tokens.set('jwt', USER)
    storedRow({ plan_id: 'free', status: 'none' })

    const response = await entitlementGET(request(USER, 'jwt'))
    const body = (await response.json()) as { billingEnabled?: boolean }

    // The account page hides "Manage billing" on false, so production (Stripe
    // off) does not show every user an operator message.
    expect(body.billingEnabled).toBe(true)
  })

  it('does not reconcile for a caller who cannot prove who they are', async () => {
    storedRow({
      plan_id: 'pro',
      status: 'active',
      current_period_end: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    const response = await entitlementGET(request(USER, null))

    // An anonymous caller is answered as a stranger — free tier, no lookup —
    // so this route cannot be used to make the server call Stripe for any
    // account id somebody happens to know.
    expect(response.status).toBe(200)
    expect(stripe.state.listCalls).toBe(0)
  })

  it('does not touch Stripe for an account whose period is current', async () => {
    db.state.tokens.set('jwt', USER)
    storedRow({
      plan_id: 'pro',
      status: 'active',
      current_period_end: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })

    await entitlementGET(request(USER, 'jwt'))

    expect(stripe.state.listCalls).toBe(0)
  })
})

describe('POST /api/billing/reconcile — who may ask', () => {
  const STRANGER = '22222222-2222-4222-8222-222222222222'

  function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://app.test/api/billing/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.20', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('refuses an anonymous caller', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    const response = await reconcilePOST(post({ userId: USER }))

    expect(response.status).toBe(401)
    // No Stripe call, so this cannot be used to make the server do work on any
    // account id a stranger has seen.
    expect(stripe.state.listCalls).toBe(0)
    expect(row()?.plan_id).toBe('free')
  })

  it('refuses a signed-in caller asking about somebody else', async () => {
    db.state.tokens.set('jwt', STRANGER)
    storedRow({ plan_id: 'free' })

    const response = await reconcilePOST(
      post({ userId: USER }, { authorization: 'Bearer jwt' })
    )

    expect(response.status).toBe(403)
    expect(stripe.state.listCalls).toBe(0)
  })

  it('lets a caller reconcile themselves', async () => {
    db.state.tokens.set('jwt', USER)
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    const response = await reconcilePOST(
      post({ userId: USER }, { authorization: 'Bearer jwt' })
    )
    const body = (await response.json()) as { reconciled: boolean; planId: string }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ reconciled: true, planId: 'pro', changed: true })
    expect(row()?.plan_id).toBe('pro')
  })

  it('lets an operator secret reconcile anyone', async () => {
    storedRow({ plan_id: 'free' })
    stripe.state.byCustomer.set('cus_1', [stripeSub('sub_1', 'price_pro')])

    const response = await reconcilePOST(
      post({ userId: USER }, { 'x-reconcile-secret': 'operator-secret' })
    )

    expect(response.status).toBe(200)
    expect(row()?.plan_id).toBe('pro')
  })

  it('does not rate-limit an operator sweep across accounts from one host', async () => {
    // docs/BILLING.md §8 runs one call per subscriber from one host. Under the
    // per-IP limit (5/min) the sixth account onwards was refused with a 429 that
    // `curl -sS` reports as success.
    const statuses: number[] = []
    for (let i = 0; i < 8; i += 1) {
      const id = `33333333-3333-4333-8333-33333333333${i}`
      const response = await reconcilePOST(post({ userId: id }, { 'x-reconcile-secret': 'operator-secret' }))
      statuses.push(response.status)
    }
    expect(statuses).not.toContain(429)
  })

  it('still limits an anonymous caller per IP', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await reconcilePOST(post({ userId: USER }))).status)
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses.slice(5)).toEqual([429, 429])
  })

  it('bounds repeated operator calls for one account', async () => {
    let last = 0
    for (let i = 0; i < 25; i += 1) {
      last = (await reconcilePOST(post({ userId: USER }, { 'x-reconcile-secret': 'operator-secret' }))).status
    }
    expect(last).toBe(429)
  })

  it('refuses a wrong secret, and one of the wrong length', async () => {
    storedRow({ plan_id: 'free' })

    const wrong = await reconcilePOST(
      post({ userId: USER }, { 'x-reconcile-secret': 'operator-secrez' })
    )
    const short = await reconcilePOST(post({ userId: USER }, { 'x-reconcile-secret': 'x' }))

    // Both fall through to the token check and find no token. The length case
    // is here because `timingSafeEqual` throws on a length mismatch rather than
    // returning false, and an exception on this path would be a 500 instead of
    // a refusal.
    expect(wrong.status).toBe(401)
    expect(short.status).toBe(401)
  })

  it('answers 401, not 500, to a secret with multi-byte characters of the same length', async () => {
    // 'operator-secret' is 15 characters. This is 15 characters too, but 16
    // bytes in UTF-8: the old character-length guard passed it and
    // timingSafeEqual then threw a RangeError.
    const offered = 'operator-secrét'
    expect(offered.length).toBe('operator-secret'.length)
    expect(Buffer.byteLength(offered)).not.toBe(Buffer.byteLength('operator-secret'))

    const response = await reconcilePOST(post({ userId: USER }, { 'x-reconcile-secret': offered }))

    expect(response.status).toBe(401)
  })

  it('refuses a junk user id before touching anything', async () => {
    const response = await reconcilePOST(post({ userId: 'not-a-uuid' }))
    expect(response.status).toBe(400)
  })
})
