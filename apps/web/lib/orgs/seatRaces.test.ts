/**
 * seatRaces.test.ts — seat-cap enforcement and invite revocation in the store,
 * against an in-memory Supabase handed over as a server context (the
 * service-role path, which the database's cap trigger does not guard).
 *
 *   · a suspended seat cannot be set back to 'invited' past the licence cap
 *     (setMemberStatus used to check capacity only for 'active');
 *   · two concurrent invites that both pass the pre-check cannot overshoot:
 *     the loser takes its own row back out and gets a SeatLimitError;
 *   · removing or suspending a seat burns the invite still outstanding for it;
 *   · releaseInvite hands a burned invite back after a failed claim.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => null,
}))

import type { OrgContext } from '@/lib/orgs/store'

const {
  addMember,
  claimSeat,
  isSeatLimitError,
  releaseInvite,
  removeMember,
  setMemberStatus,
} = await import('@/lib/orgs/store')

type Row = Record<string, unknown>

const ORG = 'org-1'
const db: Record<string, Row[]> = { orgs: [], org_members: [], org_invites: [] }
/** Runs right after a row is inserted into org_members — a concurrent writer. */
let afterInsert: ((row: Row) => void) | null = null
let idCounter = 0

function builder(table: string) {
  const filters: [string, unknown][] = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: Row = {}

  const rows = () => db[table].filter((row) => filters.every(([c, v]) => row[c] === v))
  function run(): { data: Row[]; error: null } {
    if (op === 'insert') {
      const row: Row = {
        id: `row-${++idCounter}`,
        joined_at: `2026-01-01T00:00:${String(idCounter).padStart(2, '0')}.000Z`,
        user_id: null,
        ...payload,
      }
      db[table].push(row)
      if (table === 'org_members') afterInsert?.(row)
      return { data: [row], error: null }
    }
    if (op === 'update') {
      const hit = rows()
      for (const row of hit) Object.assign(row, payload)
      return { data: hit, error: null }
    }
    if (op === 'delete') {
      const hit = rows()
      db[table] = db[table].filter((row) => !hit.includes(row))
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
    delete() {
      op = 'delete'
      return chain
    },
    eq(column: string, value: unknown) {
      filters.push([column, value])
      return chain
    },
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

const ctx: OrgContext = {
  userId: 'caller',
  client: { from: (table: string) => builder(table) } as unknown as SupabaseClient,
}

function member(id: string, email: string, status: string, role = 'member'): Row {
  return {
    id,
    org_id: ORG,
    user_id: null,
    email,
    role,
    status,
    plan_id: 'team',
    joined_at: `2026-01-01T00:00:0${id.length}.000Z`,
    last_active_at: null,
  }
}

function invite(email: string): Row {
  return {
    id: `invite-${email}`,
    org_id: ORG,
    email,
    role: 'member',
    token_hash: `hash-${email}`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    accepted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

beforeEach(() => {
  idCounter = 0
  afterInsert = null
  db.orgs = [
    {
      id: ORG,
      name: 'Acme',
      slug: 'acme',
      plan_id: 'team',
      seats_total: 2,
      seats_used: 2,
      domain: null,
      created_at: '2026-01-01T00:00:00.000Z',
      owner_id: 'owner',
    },
  ]
  db.org_members = [
    member('m1', 'owner@acme.test', 'active', 'owner'),
    member('m22', 'second@acme.test', 'active'),
    member('m333', 'gone@acme.test', 'suspended'),
  ]
  db.org_invites = []
})

describe('seat cap on status changes', () => {
  it('refuses to set a suspended seat to invited when the licence is full', async () => {
    let caught: unknown
    try {
      await setMemberStatus(ORG, 'm333', 'invited', ctx)
    } catch (err) {
      caught = err
    }
    expect(isSeatLimitError(caught)).toBe(true)
    expect(db.org_members.find((m) => m.id === 'm333')?.status).toBe('suspended')
  })

  it('allows it when a seat is free', async () => {
    db.orgs[0].seats_total = 3
    const updated = await setMemberStatus(ORG, 'm333', 'invited', ctx)
    expect(updated?.status).toBe('invited')
  })

  it('rolls a claim back if a concurrent write filled the last seat meanwhile', async () => {
    db.orgs[0].seats_total = 3
    db.org_members.push(member('m4444', 'held@acme.test', 'suspended'))
    // Pretend a second request activates another seat right after our pre-check
    // passed: the first status write we make triggers it.
    const original = db.org_members.find((m) => m.id === 'm333')!
    const builderFrom = ctx.client.from.bind(ctx.client)
    let raced = false
    const racing = {
      from: (table: string) => {
        const b = builderFrom(table) as unknown as { update: (v: Row) => unknown }
        if (table === 'org_members' && !raced) {
          const realUpdate = b.update.bind(b)
          b.update = (value: Row) => {
            if (!raced && value.status === 'active') {
              raced = true
              original.status = 'active' // the concurrent winner takes the last seat
            }
            return realUpdate(value)
          }
        }
        return b
      },
    } as unknown as SupabaseClient
    let caught: unknown
    try {
      await claimSeat(ORG, 'm4444', 'user-x', { userId: 'caller', client: racing })
    } catch (err) {
      caught = err
    }
    expect(isSeatLimitError(caught)).toBe(true)
    expect(db.org_members.find((m) => m.id === 'm4444')?.status).toBe('suspended')
  })
})

describe('seat cap on concurrent invites', () => {
  it('takes its own row back out when a concurrent insert filled the licence', async () => {
    db.org_members = [member('m1', 'owner@acme.test', 'active', 'owner')]
    // Both requests pass the pre-check (1 of 2 used). Ours inserts, and a rival
    // lands in the same instant, so the licence is now over by one.
    afterInsert = (row) => {
      if (row.email === 'late@acme.test') {
        afterInsert = null
        db.org_members.push(member('m55555', 'rival@acme.test', 'invited'))
      }
    }
    db.orgs[0].seats_total = 2
    let caught: unknown
    try {
      await addMember(ORG, 'late@acme.test', 'member', 'invited', ctx)
    } catch (err) {
      caught = err
    }
    expect(isSeatLimitError(caught)).toBe(true)
    expect(db.org_members.some((m) => m.email === 'late@acme.test')).toBe(false)
    expect(db.org_members.some((m) => m.email === 'rival@acme.test')).toBe(true)
  })

  it('keeps the row when there is room', async () => {
    db.org_members = [member('m1', 'owner@acme.test', 'active', 'owner')]
    const added = await addMember(ORG, 'fine@acme.test', 'member', 'invited', ctx)
    expect(added.email).toBe('fine@acme.test')
    expect(db.org_members.some((m) => m.email === 'fine@acme.test')).toBe(true)
  })
})

describe('invite revocation', () => {
  it('burns the outstanding invite when the seat is removed', async () => {
    db.org_invites = [invite('gone@acme.test'), invite('other@acme.test')]
    expect(await removeMember(ORG, 'm333', ctx)).toBe(true)
    expect(db.org_invites.find((i) => i.email === 'gone@acme.test')?.accepted_at).toBeTruthy()
    expect(db.org_invites.find((i) => i.email === 'other@acme.test')?.accepted_at).toBeNull()
  })

  it('burns the outstanding invite when the seat is suspended', async () => {
    db.org_invites = [invite('second@acme.test')]
    await setMemberStatus(ORG, 'm22', 'suspended', ctx)
    expect(db.org_invites[0].accepted_at).toBeTruthy()
  })

  it('releaseInvite hands a burned invite back', async () => {
    db.org_invites = [{ ...invite('second@acme.test'), accepted_at: '2026-02-01T00:00:00.000Z' }]
    expect(await releaseInvite('invite-second@acme.test', ctx)).toBe(true)
    expect(db.org_invites[0].accepted_at).toBeNull()
  })
})
