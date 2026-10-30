/**
 * webhook.test.ts — Stripe retries, and Stripe does not deliver in order.
 *
 * (Under lib/ rather than beside the route because vitest.config.ts only
 * collects `lib/**`. `submitGate.test.ts` does the same for its routes.)
 *
 * ── What is faked ──────────────────────────────────────────────────────────
 *
 * `@/lib/billing/stripe` (so no real key or network is involved) and
 * `@supabase/supabase-js` (an in-memory store with an `rpc` that emulates
 * `public.apply_stripe_subscription`). Everything between the route handler and
 * those runs for real: the event dispatch, the plan mapping through
 * `planIdForPriceId`, `stateFromStripe`, the idempotency ledger and the
 * decision about which stamp to send.
 *
 * ── WHAT THESE TESTS DO NOT PROVE ──────────────────────────────────────────
 *
 * The ordering guard itself lives in Postgres, and the emulation of it lives in
 * THIS FILE. So "an out-of-order event is dropped" is verified here as WIRING —
 * that the route reaches a guard at all, hands it Stripe's `event.created`
 * rather than our own clock, and does not fall back to a blind upsert. Whether
 * the SQL is correct is verification query 4 at the bottom of
 * supabase/schema-billing.sql, which an operator runs by hand against a live
 * project. Nothing in this repository has ever run against Postgres.
 *
 * Signature verification is real in the sense that it is `constructEvent` that
 * decides, and the fake raises for a bad signature exactly as the SDK does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'

interface SubRow {
  user_id: string
  plan_id: string
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  last_event_id: string | null
  last_event_at: string | null
}

const db = vi.hoisted(() => {
  const state = {
    subscriptions: [] as SubRow[],
    stripe_events: [] as Array<{ id: string; type: string; event_created_at: string | null }>,
    /** Every rpc the route made, so a test can assert what was sent. */
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    /** Bare upserts — the un-guarded fallback path. Should be 0. */
    directUpserts: 0,
  }

  function rows(name: string): Record<string, unknown>[] {
    if (name === 'subscriptions') return state.subscriptions as unknown as Record<string, unknown>[]
    if (name === 'stripe_events') return state.stripe_events as unknown as Record<string, unknown>[]
    return []
  }

  function table(name: string) {
    const q = {
      op: 'select' as 'select' | 'upsert',
      eqs: [] as Array<[string, unknown]>,
      payload: null as Record<string, unknown> | null,
    }
    const matches = (row: Record<string, unknown>) => q.eqs.every(([c, v]) => row[c] === v)

    function run(mode: 'many' | 'maybe'): Promise<unknown> {
      if (q.op === 'upsert') {
        if (name === 'subscriptions') state.directUpserts += 1
        const all = rows(name)
        const key = name === 'subscriptions' ? 'user_id' : 'id'
        const existing = all.find((r) => r[key] === (q.payload ?? {})[key])
        if (existing) Object.assign(existing, q.payload ?? {})
        else all.push({ ...(q.payload as Record<string, unknown>) })
        return Promise.resolve({ data: null, error: null })
      }
      const hits = rows(name).filter(matches)
      if (mode === 'maybe') return Promise.resolve({ data: hits[0] ?? null, error: null })
      return Promise.resolve({ data: hits, error: null })
    }

    const api = {
      select: () => api,
      eq(col: string, val: unknown) {
        q.eqs.push([col, val])
        return api
      },
      upsert(payload: Record<string, unknown>) {
        q.op = 'upsert'
        q.payload = payload
        return run('many')
      },
      maybeSingle: () => run('maybe'),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        run('many').then(resolve, reject),
    }
    return api
  }

  /** `public.apply_stripe_subscription`, emulated. See the file header. */
  function applyStripeSubscription(args: Record<string, unknown>) {
    const userId = args.p_user_id as string
    const eventAt = args.p_event_at as string | null
    const existing = state.subscriptions.find((r) => r.user_id === userId)
    const next: SubRow = {
      user_id: userId,
      plan_id: String(args.p_plan_id ?? 'free'),
      status: String(args.p_status ?? 'none'),
      current_period_end: (args.p_current_period_end as string | null) ?? null,
      cancel_at_period_end: args.p_cancel_at_period_end === true,
      last_event_id: (args.p_event_id as string | null) ?? existing?.last_event_id ?? null,
      last_event_at: eventAt ?? existing?.last_event_at ?? null,
    }
    if (!existing) {
      state.subscriptions.push(next)
      return { data: [{ applied: true }], error: null }
    }
    // The guard: an event older than the last one applied is dropped.
    if (existing.last_event_at && eventAt && eventAt < existing.last_event_at) {
      return { data: [{ applied: false }], error: null }
    }
    Object.assign(existing, next, {
      last_event_at:
        eventAt && existing.last_event_at && existing.last_event_at > eventAt
          ? existing.last_event_at
          : (eventAt ?? existing.last_event_at),
    })
    return { data: [{ applied: true }], error: null }
  }

  const client = {
    from: (name: string) => table(name),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      if (name === 'apply_stripe_subscription') return applyStripeSubscription(args)
      return { data: null, error: { code: 'PGRST202', message: 'unknown function' } }
    },
  }
  return { state, client }
})

// ── the fake Stripe ─────────────────────────────────────────────────────────

const stripe = vi.hoisted(() => {
  const state = {
    /** Subscriptions the fake will hand back from `retrieve`. */
    subs: new Map<string, Record<string, unknown>>(),
  }
  const client = {
    webhooks: {
      // The route passes the raw body and the signature header. The fake
      // accepts only the literal signature 'good' and raises otherwise, which
      // is the SDK's contract as far as this handler is concerned.
      constructEvent(body: string, signature: string) {
        if (signature !== 'good') throw new Error('No signatures found matching the expected signature')
        return JSON.parse(body) as unknown
      },
    },
    subscriptions: {
      retrieve: async (id: string) => state.subs.get(id) ?? null,
    },
  }
  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => db.client }))
vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: true, getSupabase: () => db.client }))
vi.mock('@/lib/billing/stripe', () => ({
  isStripeConfigured: true,
  getStripe: () => stripe.client,
  // Two known prices; anything else is an unknown plan and maps to free.
  planIdForPriceId: (id: string) =>
    id === 'price_pro' ? 'pro' : id === 'price_team' ? 'team' : null,
  priceIdFor: () => null,
  APP_URL: 'http://app.test',
  STRIPE_API_VERSION: '2024-10-28.acacia',
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'

const { POST } = await import('@/app/api/billing/webhook/route')

// ── helpers ─────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111'

function subscriptionObject(
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
    metadata: { userId: USER },
    items: { data: [{ price: { id: priceId } }] },
    ...overrides,
  }
}

/** An event envelope. `created` is Stripe's clock, in seconds. */
function event(
  id: string,
  type: string,
  object: unknown,
  created: number
): Record<string, unknown> {
  return { id, type, created, data: { object } }
}

function deliver(payload: Record<string, unknown>, signature = 'good'): Promise<Response> {
  return POST(
    new Request('http://app.test/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  )
}

const row = () => db.state.subscriptions.find((r) => r.user_id === USER)

beforeEach(() => {
  db.state.subscriptions.length = 0
  db.state.stripe_events.length = 0
  db.state.rpcCalls.length = 0
  db.state.directUpserts = 0
  stripe.state.subs.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── signature ───────────────────────────────────────────────────────────────

describe('POST /api/billing/webhook — signature', () => {
  it('refuses an unsigned body and does no work (this was already right)', async () => {
    const response = await deliver(
      event('evt_1', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_pro'), 1000),
      'forged'
    )

    expect(response.status).toBe(400)
    expect(db.state.rpcCalls).toHaveLength(0)
    expect(row()).toBeUndefined()
    // Nothing about WHY: the only reader is Stripe, which acts on the status.
    expect(await response.json()).toEqual({ error: 'Invalid signature.', code: 'bad_request' })
  })

  it('grants a plan from the price id, not from anything the body asserts', async () => {
    await deliver(
      event(
        'evt_1',
        'customer.subscription.updated',
        // The payload claims Team in its metadata. Only the PRICE decides.
        subscriptionObject('sub_1', 'price_pro', {
          metadata: { userId: USER, planId: 'team' },
        }),
        1000
      )
    )

    expect(row()?.plan_id).toBe('pro')
  })
})

// ── idempotency ─────────────────────────────────────────────────────────────

describe('POST /api/billing/webhook — replays', () => {
  it('processes a redelivered event as a no-op', async () => {
    const payload = event(
      'evt_1',
      'customer.subscription.updated',
      subscriptionObject('sub_1', 'price_pro'),
      1000
    )

    const first = await deliver(payload)
    const before = db.state.rpcCalls.length
    const second = await deliver(payload)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ received: true, duplicate: true })
    // The second delivery did no work at all — no write was even attempted.
    expect(db.state.rpcCalls).toHaveLength(before)
    expect(db.state.stripe_events).toHaveLength(1)
  })

  it('records the event only after the work succeeded', async () => {
    // The ledger must not be a claim: if it were written first, a crash between
    // the claim and the write would make Stripe's retry a skipped duplicate and
    // the subscription change would be lost with nothing to say so.
    const failing = event(
      'evt_boom',
      'invoice.payment_failed',
      { subscription: 'sub_missing' },
      1000
    )
    stripe.client.subscriptions.retrieve = async () => {
      throw new Error('stripe is down')
    }

    const response = await deliver(failing)

    // Not persisted, so the retry will be processed rather than skipped.
    expect(db.state.stripe_events).toHaveLength(0)
    // A Stripe outage is transient: 500 so Stripe redelivers. A 200 here dropped
    // the event for good.
    expect(response.status).toBe(500)
    stripe.client.subscriptions.retrieve = async (id: string) =>
      stripe.state.subs.get(id) ?? null
  })

  it('retries on a Stripe rate limit or connection error', async () => {
    const failing = event('evt_429', 'invoice.payment_failed', { subscription: 'sub_x' }, 1000)
    stripe.client.subscriptions.retrieve = async () => {
      throw new Stripe.errors.StripeRateLimitError({ message: 'slow down', type: 'rate_limit_error' })
    }
    const limited = await deliver(failing)
    stripe.client.subscriptions.retrieve = async () => {
      throw new Stripe.errors.StripeConnectionError({ message: 'socket hang up', type: 'api_error' })
    }
    const dropped = await deliver(failing)
    stripe.client.subscriptions.retrieve = async (id: string) =>
      stripe.state.subs.get(id) ?? null

    expect(limited.status).toBe(500)
    expect(dropped.status).toBe(500)
  })

  it('acknowledges a request Stripe will always refuse (no such subscription)', async () => {
    const failing = event('evt_gone', 'invoice.payment_failed', { subscription: 'sub_gone' }, 1000)
    stripe.client.subscriptions.retrieve = async () => {
      throw new Stripe.errors.StripeInvalidRequestError({
        message: 'No such subscription',
        type: 'invalid_request_error',
      })
    }
    const response = await deliver(failing)
    stripe.client.subscriptions.retrieve = async (id: string) =>
      stripe.state.subs.get(id) ?? null

    // A retry cannot fix it, so 200 rather than 3 days of redeliveries.
    expect(response.status).toBe(200)
  })
})

// ── ordering ────────────────────────────────────────────────────────────────

describe('POST /api/billing/webhook — out-of-order delivery', () => {
  it('does not let a late upgrade retry undo a newer downgrade', async () => {
    // The scenario from the route header, in order of ARRIVAL:
    //   1. upgrade to Team, created 12:00:00 — times out on first delivery
    //   2. downgrade to Pro, created 12:00:10 — delivered and applied
    //   3. Stripe retries (1) at 12:00:30
    // Last-arrival-wins leaves the customer on Team, paying for Pro.
    await deliver(
      event('evt_down', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_pro'), 1_000_010)
    )
    expect(row()?.plan_id).toBe('pro')

    const late = await deliver(
      event('evt_up', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_team'), 1_000_000)
    )

    expect(late.status).toBe(200)
    expect(row()?.plan_id).toBe('pro')
    // And the guard was reached with STRIPE's clock, not ours.
    const stamps = db.state.rpcCalls.map((c) => c.args.p_event_at)
    expect(stamps).toEqual([
      new Date(1_000_010_000).toISOString(),
      new Date(1_000_000_000).toISOString(),
    ])
  })

  it('does not let a late cancellation retry cancel a re-subscribed account', async () => {
    // The expensive direction of the same bug: this one takes a paying
    // customer's access away.
    await deliver(
      event('evt_new', 'customer.subscription.created', subscriptionObject('sub_2', 'price_pro'), 2_000_000)
    )
    const stale = await deliver(
      event(
        'evt_cancel',
        'customer.subscription.deleted',
        subscriptionObject('sub_1', 'price_pro', { status: 'canceled' }),
        1_999_000
      )
    )

    expect(stale.status).toBe(200)
    expect(row()?.status).toBe('active')
    expect(row()?.plan_id).toBe('pro')
  })

  it('applies a newer event over an older one', async () => {
    await deliver(
      event('evt_a', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_pro'), 1_000_000)
    )
    await deliver(
      event('evt_b', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_team'), 1_000_010)
    )

    expect(row()?.plan_id).toBe('team')
    expect(row()?.last_event_id).toBe('evt_b')
  })

  it('never writes through the un-guarded upsert when the function is present', async () => {
    await deliver(
      event('evt_a', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_pro'), 1_000_000)
    )

    // The bare `.upsert()` is the pre-change path and the fallback for an
    // un-migrated project. On a project that has the function it must never
    // run: it has no ordering guard.
    expect(db.state.directUpserts).toBe(0)
  })
})

// ── checkout ────────────────────────────────────────────────────────────────

describe('POST /api/billing/webhook — checkout.session.completed', () => {
  it('reads the subscription from Stripe and stamps the event', async () => {
    stripe.state.subs.set('sub_9', subscriptionObject('sub_9', 'price_pro'))

    const response = await deliver(
      event(
        'evt_checkout',
        'checkout.session.completed',
        {
          mode: 'subscription',
          client_reference_id: USER,
          customer: 'cus_1',
          subscription: 'sub_9',
          metadata: { userId: USER, planId: 'pro' },
        },
        3_000_000
      )
    )

    expect(response.status).toBe(200)
    expect(row()?.plan_id).toBe('pro')
    expect(row()?.status).toBe('active')
    expect(row()?.last_event_at).toBe(new Date(3_000_000_000).toISOString())
  })

  it('ignores a session it cannot attribute to a user', async () => {
    const response = await deliver(
      event('evt_anon', 'checkout.session.completed', { customer: 'cus_1', metadata: {} }, 3_000_000)
    )

    expect(response.status).toBe(200)
    expect(db.state.subscriptions).toHaveLength(0)
  })

  // The session's own claims are not trusted on their own: only a session this
  // app created is applied.
  const goodSession = (over: Record<string, unknown> = {}) => ({
    mode: 'subscription',
    client_reference_id: USER,
    customer: 'cus_1',
    subscription: 'sub_9',
    metadata: { userId: USER, planId: 'pro' },
    ...over,
  })

  it.each([
    ['a payment-mode session', { mode: 'payment' }],
    ['a session with no mode', { mode: undefined }],
    ['a client_reference_id that disagrees with metadata.userId', {
      client_reference_id: '22222222-2222-4222-8222-222222222222',
    }],
    ['a client_reference_id with no metadata.userId', { metadata: { planId: 'pro' } }],
    ['a user id that is not a UUID', {
      client_reference_id: 'not-a-uuid',
      metadata: { userId: 'not-a-uuid' },
    }],
    ['a paid session with no subscription', { subscription: null }],
  ])('ignores %s', async (_label, over) => {
    stripe.state.subs.set('sub_9', subscriptionObject('sub_9', 'price_pro'))

    const response = await deliver(
      event('evt_x', 'checkout.session.completed', goodSession(over), 3_000_000)
    )

    // Acknowledged (a retry cannot help) but nothing is written.
    expect(response.status).toBe(200)
    expect(db.state.rpcCalls).toHaveLength(0)
    expect(db.state.subscriptions).toHaveLength(0)
  })

  it('falls back to a known paid plan from metadata, never to free or an unknown plan', async () => {
    stripe.state.subs.set('sub_9', subscriptionObject('sub_9', 'price_unmapped'))

    await deliver(
      event('evt_a', 'checkout.session.completed', goodSession({ metadata: { userId: USER, planId: 'team' } }), 3_000_000)
    )
    expect(row()?.plan_id).toBe('team')

    db.state.subscriptions.length = 0
    db.state.rpcCalls.length = 0
    await deliver(
      event('evt_b', 'checkout.session.completed', goodSession({ metadata: { userId: USER, planId: 'edu' } }), 3_000_001)
    )
    // 'edu' is contact-sales, not self-serve: nothing is granted from the metadata.
    expect(db.state.subscriptions).toHaveLength(0)
  })

  it('tolerates a malformed event payload without throwing', async () => {
    const response = await deliver({ id: 'evt_bad', type: 'checkout.session.completed', created: 1 })
    expect(response.status).toBe(200)
    expect(db.state.subscriptions).toHaveLength(0)
  })
})

// ── endpoint API version ────────────────────────────────────────────────────

describe('POST /api/billing/webhook — endpoint API version', () => {
  it('re-reads a subscription delivered by an endpoint on another API version', async () => {
    // A newer-version payload has no top-level current_period_end. The pinned
    // re-read does, and that is what must be written.
    const delivered = subscriptionObject('sub_1', 'price_pro', { current_period_end: undefined })
    stripe.state.subs.set('sub_1', subscriptionObject('sub_1', 'price_pro'))

    await deliver({
      ...event('evt_v', 'customer.subscription.updated', delivered, 1_000_000),
      api_version: '2025-03-31.basil',
    })

    expect(row()?.current_period_end).toBe(new Date(1_750_000_000 * 1000).toISOString())
  })

  it('uses the payload as delivered when the versions agree', async () => {
    // Nothing in the fake store: a re-read would find null and fail.
    await deliver({
      ...event('evt_v', 'customer.subscription.updated', subscriptionObject('sub_1', 'price_team'), 1_000_000),
      api_version: '2024-10-28.acacia',
    })

    expect(row()?.plan_id).toBe('team')
  })

  it('finds the subscription of a failed invoice under the newer parent shape', async () => {
    stripe.state.subs.set('sub_1', subscriptionObject('sub_1', 'price_pro'))

    await deliver(
      event(
        'evt_inv',
        'invoice.payment_failed',
        { parent: { subscription_details: { subscription: 'sub_1' } } },
        1_000_000
      )
    )

    expect(row()?.status).toBe('past_due')
  })
})
