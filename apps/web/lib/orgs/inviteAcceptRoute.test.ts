/**
 * inviteAcceptRoute.test.ts — POST /api/orgs/invite/accept through the real
 * handler and the real store, against an in-memory Supabase.
 *
 * The bug under test: accepting an invite flipped the held seat to 'active'
 * but never wrote `org_members.user_id`. Every authorisation check keys on
 * that column — `requireOrgRole`/`lookupMembership` in lib/orgs/access.ts,
 * `getEntitlement`, the `is_org_member` RLS helper — so every invitee got a
 * "Seat claimed" message and then a 403 from every /api/orgs route.
 *
 * So the assertion that matters is not the 200: it is that the row now names
 * the caller, and that the gate the rest of the API uses then lets them in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const db: Record<string, Row[]> = {
  orgs: [],
  org_members: [],
  org_invites: [],
}

const tokens = new Map<string, { id: string; email: string }>()

const ORG = 'org-acme'
const OWNER = '00000000-0000-0000-0000-0000000000e1'
const INVITEE = '00000000-0000-0000-0000-0000000000e2'
const STRANGER = '00000000-0000-0000-0000-0000000000e3'

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
        user_id: null,
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
    /** `.is('accepted_at', null)` — the single-use burn in markInviteAccepted. */
    is(column: string, value: unknown) {
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

vi.mock('@/lib/billing/entitlements', () => ({
  getServiceSupabase: () => fakeClient,
}))

const accept = await import('@/app/api/orgs/invite/accept/route')
const { lookupMembership } = await import('@/lib/orgs/access')
const { hashInviteToken, mintInviteToken } = await import('@/lib/orgs/invites')

let requestCounter = 0

function post(body: unknown, token?: string): Request {
  requestCounter += 1
  return new Request('https://q.test/api/orgs/invite/accept', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.1.0.${requestCounter}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** Mint a live invite row for `email` and return the raw token from the link. */
async function invite(email: string, role = 'member'): Promise<string> {
  const minted = await mintInviteToken()
  db.org_invites.push({
    id: `invite-${(await hashInviteToken(minted.token)).slice(0, 16)}`,
    org_id: ORG,
    email,
    role,
    token_hash: minted.tokenHash,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    accepted_at: null,
    created_at: new Date().toISOString(),
  })
  return minted.token
}

beforeEach(() => {
  for (const table of Object.keys(db)) db[table] = []
  tokens.clear()
  idCounter = 0

  tokens.set('t-invitee', { id: INVITEE, email: 'new.hire@acme.test' })
  tokens.set('t-stranger', { id: STRANGER, email: 'stranger@elsewhere.test' })

  db.orgs = [
    {
      id: ORG,
      name: 'Acme',
      slug: 'acme',
      plan_id: 'team',
      seats_total: 10,
      seats_used: 1,
      domain: null,
      created_at: '2026-01-01T00:00:00.000Z',
      owner_id: OWNER,
    },
  ]
  db.org_members = [
    {
      id: 'm-owner',
      org_id: ORG,
      user_id: OWNER,
      email: 'owner@acme.test',
      role: 'owner',
      status: 'active',
      plan_id: 'team',
      joined_at: '2026-01-01T00:00:00.000Z',
      last_active_at: null,
    },
  ]
})

describe('accepting an invite binds the seat to the account', () => {
  it('writes user_id onto the seat held for the invitee, and the gate then admits them', async () => {
    const token = await invite('new.hire@acme.test')
    // The seat an admin held when minting the link: email only, no account yet.
    db.org_members.push({
      id: 'm-held',
      org_id: ORG,
      user_id: null,
      email: 'new.hire@acme.test',
      role: 'member',
      status: 'invited',
      plan_id: 'team',
      joined_at: '2026-01-02T00:00:00.000Z',
      last_active_at: null,
    })

    const res = await accept.POST(post({ token }, 't-invitee'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { member: { userId: string; status: string } }
    expect(body.member.userId).toBe(INVITEE)
    expect(body.member.status).toBe('active')

    const held = db.org_members.find((m) => m.id === 'm-held')
    expect(held?.status).toBe('active')
    expect(held?.user_id).toBe(INVITEE)
    // No duplicate row was added for the same person.
    expect(db.org_members.filter((m) => m.email === 'new.hire@acme.test')).toHaveLength(1)

    // The check every /api/orgs route runs must now find them.
    const membership = await lookupMembership(post({}, 't-invitee'), ORG, INVITEE)
    expect(membership).not.toBeNull()
    expect(membership?.role).toBe('member')
    expect(membership?.status).toBe('active')
  })

  it('refuses an invite whose held seat was removed (a revoked invite stays revoked)', async () => {
    const token = await invite('new.hire@acme.test', 'admin')

    const res = await accept.POST(post({ token }, 't-invitee'))
    expect(res.status).toBe(404)
    expect(db.org_members.some((m) => m.email === 'new.hire@acme.test')).toBe(false)
    // Nothing was burned either: the link is simply dead for this org.
    expect(db.org_invites[0].accepted_at).toBeNull()
  })

  it('refuses an invite whose held seat was suspended', async () => {
    const token = await invite('new.hire@acme.test')
    db.org_members.push({
      id: 'm-held', org_id: ORG, user_id: null, email: 'new.hire@acme.test', role: 'member',
      status: 'suspended', plan_id: 'team', joined_at: '2026-01-02T00:00:00.000Z', last_active_at: null,
    })
    const res = await accept.POST(post({ token }, 't-invitee'))
    expect(res.status).toBe(404)
    expect(db.org_members.find((m) => m.id === 'm-held')?.status).toBe('suspended')
  })

  it('still refuses a caller whose verified email is not the invited one, writing nothing', async () => {
    const token = await invite('new.hire@acme.test')

    const res = await accept.POST(post({ token }, 't-stranger'))
    expect(res.status).toBe(403)
    expect(db.org_members.some((m) => m.user_id === STRANGER)).toBe(false)
    expect(db.org_invites[0].accepted_at).toBeNull()
    expect(await lookupMembership(post({}, 't-stranger'), ORG, STRANGER)).toBeNull()
  })

  it('is single use: the second claim of one link fails and binds nothing new', async () => {
    const token = await invite('new.hire@acme.test')
    db.org_members.push({
      id: 'm-held', org_id: ORG, user_id: null, email: 'new.hire@acme.test', role: 'member',
      status: 'invited', plan_id: 'team', joined_at: '2026-01-02T00:00:00.000Z', last_active_at: null,
    })
    expect((await accept.POST(post({ token }, 't-invitee'))).status).toBe(200)
    expect((await accept.POST(post({ token }, 't-invitee'))).status).toBe(404)
    expect(db.org_members.filter((m) => m.user_id === INVITEE)).toHaveLength(1)
  })
})
