/**
 * orgsCreateRoute.test.ts — POST /api/orgs through the real handler, the real
 * gate (lib/orgs/access.ts) and the real store, against an in-memory Supabase.
 *
 * The hole under test (audit finding ORG-3, server half): the RLS policy
 * `orgs_insert_owner` requires the caller's own paid subscription, but this
 * route writes through the service-role client, which RLS does not see. So a
 * Free sign-up could POST itself a University org, take the owner seat, and be
 * handed the plan by lib/billing/entitlements.ts.
 *
 * Every refusal here also asserts that NOTHING was written: a 403 with an org
 * row behind it would be the same bug with a different status code.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const db: Record<string, Row[]> = {
  subscriptions: [],
  orgs: [],
  org_members: [],
}

/** token → the user Supabase would vouch for. */
const tokens = new Map<string, { id: string; email: string }>()

const FREE = '00000000-0000-0000-0000-0000000000f1'
const TEAM = '00000000-0000-0000-0000-0000000000f2'
const SEATED = '00000000-0000-0000-0000-0000000000f3'
const OTHER_ORG = 'org-someone-elses'

let idCounter = 0

function builder(table: string) {
  const filters: [string, unknown][] = []
  let op: 'select' | 'insert' | 'update' = 'select'
  let payload: Row = {}

  function rows(): Row[] {
    return db[table].filter((row) => filters.every(([c, v]) => row[c] === v))
  }
  function run(): { data: Row[]; error: null } {
    if (op === 'insert') {
      const row: Row = {
        id: `row-${++idCounter}`,
        created_at: new Date().toISOString(),
        joined_at: new Date().toISOString(),
        ...payload,
      }
      db[table].push(row)
      return { data: [row], error: null }
    }
    if (op === 'update') {
      const hit = rows()
      for (const row of hit) Object.assign(row, payload)
      return { data: hit, error: null }
    }
    return { data: rows(), error: null }
  }

  const chain = {
    select: () => chain,
    insert(value: Row) {
      op = 'insert'
      payload = value
      return chain
    },
    update(value: Row) {
      op = 'update'
      payload = value
      return chain
    },
    eq(column: string, value: unknown) {
      filters.push([column, value])
      return chain
    },
    order: () => chain,
    async maybeSingle() {
      return { data: run().data[0] ?? null, error: null }
    },
    async single() {
      const { data } = run()
      return data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }
    },
    then(resolve: (value: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve(run()).then(resolve)
    },
  }
  return chain
}

const fakeClient = { from: (table: string) => builder(table) }

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({
    auth: {
      getUser: async (token: string) => {
        const user = tokens.get(token)
        return user
          ? { data: { user }, error: null }
          : { data: { user: null }, error: { message: 'invalid token' } }
      },
    },
  }),
}))

// The service-role client — the one RLS does not apply to, and therefore the
// one on which this route must enforce the licence rule itself.
vi.mock('@/lib/billing/entitlements', () => ({
  getServiceSupabase: () => fakeClient,
}))

const route = await import('@/app/api/orgs/route')

let requestCounter = 0

function post(body: unknown, token?: string): Request {
  // A distinct client key per request keeps the per-instance limiter out of
  // the way: this file is about the licence rule, not the limiter.
  requestCounter += 1
  return new Request('https://q.test/api/orgs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.0.0.${requestCounter}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  for (const table of Object.keys(db)) db[table] = []
  tokens.clear()
  idCounter = 0

  tokens.set('t-free', { id: FREE, email: 'free@example.test' })
  tokens.set('t-team', { id: TEAM, email: 'lead@acme.test' })
  tokens.set('t-seated', { id: SEATED, email: 'student@uni.test' })

  db.subscriptions = [
    { user_id: TEAM, plan_id: 'team', status: 'active' },
    // SEATED pays for nothing personally …
  ]
  // … but holds an active University seat in someone else's org, which
  // getEntitlement() would report as plan 'edu'.
  db.org_members = [
    { org_id: OTHER_ORG, user_id: SEATED, email: 'student@uni.test', role: 'member', status: 'active', plan_id: 'edu' },
  ]
})

describe('POST /api/orgs: an org on a paid plan needs the caller’s own licence', () => {
  it('refuses an anonymous caller with 401 and writes nothing', async () => {
    const res = await route.POST(
      post({ name: 'Nope', ownerId: FREE, ownerEmail: 'free@example.test', planId: 'edu' })
    )
    expect(res.status).toBe(401)
    expect(db.orgs).toHaveLength(0)
  })

  it('refuses a Free account asking for a University org — the ORG-3 attack', async () => {
    const res = await route.POST(
      post({ name: 'Free Uni', ownerId: FREE, ownerEmail: 'free@example.test', planId: 'edu' }, 't-free')
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('forbidden')
    expect(body.error).toMatch(/subscription/i)
    expect(db.orgs).toHaveLength(0)
    expect(db.org_members.filter((m) => m.user_id === FREE)).toHaveLength(0)
  })

  it('refuses a Free account asking for a Team org', async () => {
    const res = await route.POST(
      post({ name: 'Free Team', ownerId: FREE, ownerEmail: 'free@example.test', planId: 'team' }, 't-free')
    )
    expect(res.status).toBe(403)
    expect(db.orgs).toHaveLength(0)
  })

  it('refuses a Team subscriber asking for a University org: the plan must match', async () => {
    const res = await route.POST(
      post({ name: 'Upgrade', ownerId: TEAM, ownerEmail: 'lead@acme.test', planId: 'edu' }, 't-team')
    )
    expect(res.status).toBe(403)
    expect(db.orgs).toHaveLength(0)
  })

  it('does not count a seat in someone else’s org as a licence', async () => {
    const res = await route.POST(
      post({ name: 'Borrowed', ownerId: SEATED, ownerEmail: 'student@uni.test', planId: 'edu' }, 't-seated')
    )
    expect(res.status).toBe(403)
    expect(db.orgs).toHaveLength(0)
  })

  it('refuses a lapsed subscription', async () => {
    db.subscriptions = [{ user_id: TEAM, plan_id: 'team', status: 'canceled' }]
    const res = await route.POST(
      post({ name: 'Lapsed', ownerId: TEAM, ownerEmail: 'lead@acme.test', planId: 'team' }, 't-team')
    )
    expect(res.status).toBe(403)
    expect(db.orgs).toHaveLength(0)
  })

  it('creates the org for a caller with an active subscription to that plan', async () => {
    const res = await route.POST(
      post({ name: 'Acme', ownerId: TEAM, ownerEmail: 'lead@acme.test', planId: 'team' }, 't-team')
    )
    expect(res.status).toBe(201)
    expect(db.orgs).toHaveLength(1)
    expect(db.orgs[0].owner_id).toBe(TEAM)
    expect(db.orgs[0].plan_id).toBe('team')
    // The seat count comes from the plan table, never from the request.
    expect(db.orgs[0].seats_total).toBe(10)
    const owner = db.org_members.find((m) => m.org_id === db.orgs[0].id)
    expect(owner?.user_id).toBe(TEAM)
    expect(owner?.role).toBe('owner')
    expect(owner?.status).toBe('active')
  })

  it('refuses a second organisation on the same subscription', async () => {
    const make = (name: string) =>
      route.POST(post({ name, ownerId: TEAM, ownerEmail: 'lead@acme.test', planId: 'team' }, 't-team'))
    expect((await make('First')).status).toBe(201)
    const second = await make('Second')
    expect(second.status).toBe(409)
    expect(db.orgs).toHaveLength(1)
  })

  it('accepts past_due as still in good standing', async () => {
    db.subscriptions = [{ user_id: TEAM, plan_id: 'team', status: 'past_due' }]
    const res = await route.POST(
      post({ name: 'Grace', ownerId: TEAM, ownerEmail: 'lead@acme.test', planId: 'team' }, 't-team')
    )
    expect(res.status).toBe(201)
  })
})

describe('POST /api/orgs: the owner seat carries the VERIFIED email', () => {
  it('refuses an ownerEmail that is not the caller’s own address', async () => {
    const res = await route.POST(
      post({ name: 'Acme', ownerId: TEAM, ownerEmail: 'victim@elsewhere.test', planId: 'team' }, 't-team')
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/ownerEmail/)
    expect(db.orgs).toHaveLength(0)
    expect(db.org_members.some((m) => m.email === 'victim@elsewhere.test')).toBe(false)
  })

  it('writes the verified address, compared case-insensitively', async () => {
    const res = await route.POST(
      post({ name: 'Acme', ownerId: TEAM, ownerEmail: 'Lead@Acme.test', planId: 'team' }, 't-team')
    )
    expect(res.status).toBe(201)
    const owner = db.org_members.find((m) => m.user_id === TEAM && m.role === 'owner')
    expect(owner?.email).toBe('lead@acme.test')
  })
})
