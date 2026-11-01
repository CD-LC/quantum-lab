/**
 * createOrg when the owner-seat insert fails after the org row landed.
 *
 * RLS gives non-service callers no DELETE on public.orgs, so the old rollback
 * (delete the org row) was a silent no-op and the one-org-per-plan rule then
 * blocked the retry. The org row is now left in place; ownsOrgOnPlan ignores an
 * owned org with no owner seat, and createOrg repairs it by seating the owner.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  }),
}))

const { createOrg } = await import('@/lib/orgs/store')
const { ownsOrgOnPlan } = await import('@/lib/orgs/access')

type Row = Record<string, unknown>
const OWNER = '00000000-0000-0000-0000-0000000000a1'

function fakeDb(opts: { failSeatInserts: number }) {
  const db: Record<string, Row[]> = { orgs: [], org_members: [] }
  let seatFailuresLeft = opts.failSeatInserts
  let n = 0
  const deletes: string[] = []
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      let op: 'select' | 'insert' | 'delete' = 'select'
      let payload: Row = {}
      const rows = () => db[table].filter((r) => filters.every(([c, v]) => r[c] === v))
      const run = (): { data: Row[]; error: { message: string } | null } => {
        if (op === 'insert') {
          if (table === 'org_members' && seatFailuresLeft > 0) {
            seatFailuresLeft -= 1
            return { data: [], error: { message: 'transient network failure' } }
          }
          const row = { id: `row-${++n}`, created_at: '2026-10-01T00:00:00.000Z', ...payload }
          db[table].push(row)
          return { data: [row], error: null }
        }
        if (op === 'delete') {
          // RLS: no delete policy on orgs, so nothing is removed.
          deletes.push(table)
          return { data: [], error: null }
        }
        return { data: rows(), error: null }
      }
      const chain = {
        select: () => chain,
        insert(v: Row) {
          op = 'insert'
          payload = v
          return chain
        },
        delete() {
          op = 'delete'
          return chain
        },
        eq(c: string, v: unknown) {
          filters.push([c, v])
          return chain
        },
        async single() {
          const r = run()
          return r.error || !r.data[0] ? { data: null, error: r.error ?? { message: 'none' } } : { data: r.data[0], error: null }
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve)
        },
      }
      return chain
    },
  }
  return { db, deletes, client: client as unknown as SupabaseClient }
}

const input = { name: 'Acme', planId: 'team' as const, ownerId: OWNER, ownerEmail: 'lead@acme.test' }

describe('createOrg owner-seat failure', () => {
  it('fails without deleting the org, and the retry seats the owner on the same org', async () => {
    const { db, client, deletes } = fakeDb({ failSeatInserts: 1 })
    const ctx = { userId: OWNER, client }

    await expect(createOrg(input, ctx)).rejects.toThrow(/transient/)
    expect(db.orgs).toHaveLength(1)
    expect(db.org_members).toHaveLength(0)
    expect(deletes).toEqual([])

    // The half-created org must not count as "already owns an org on this plan".
    expect(await ownsOrgOnPlan(ctx, 'team')).toBe(false)

    const org = await createOrg(input, ctx)
    expect(org.id).toBe(db.orgs[0].id)
    expect(db.orgs).toHaveLength(1)
    expect(db.org_members).toHaveLength(1)
    expect(db.org_members[0]).toMatchObject({ org_id: org.id, user_id: OWNER, role: 'owner', plan_id: 'team' })

    expect(await ownsOrgOnPlan(ctx, 'team')).toBe(true)
  })

  it('surfaces a repair failure and leaves the org for the next retry', async () => {
    const { db, client } = fakeDb({ failSeatInserts: 2 })
    const ctx = { userId: OWNER, client }
    await expect(createOrg(input, ctx)).rejects.toThrow()
    await expect(createOrg(input, ctx)).rejects.toThrow()
    expect(db.orgs).toHaveLength(1)
    await expect(createOrg(input, ctx)).resolves.toMatchObject({ id: db.orgs[0].id })
    expect(db.orgs).toHaveLength(1)
  })

  it('does not treat another plan or another owner as the orphan', async () => {
    const { db, client } = fakeDb({ failSeatInserts: 0 })
    db.orgs.push({ id: 'o-edu', name: 'U', slug: 'u', plan_id: 'edu', seats_total: null, seats_used: 1, owner_id: OWNER, created_at: 'x' })
    db.orgs.push({ id: 'o-other', name: 'O', slug: 'o', plan_id: 'team', seats_total: 10, seats_used: 1, owner_id: 'someone-else', created_at: 'x' })
    const org = await createOrg(input, { userId: OWNER, client })
    expect(org.id).not.toBe('o-edu')
    expect(org.id).not.toBe('o-other')
    expect(db.orgs).toHaveLength(3)
  })

  it('ownsOrgOnPlan is true for a seated org and false with none', async () => {
    const { db, client } = fakeDb({ failSeatInserts: 0 })
    const ctx = { userId: OWNER, client }
    expect(await ownsOrgOnPlan(ctx, 'team')).toBe(false)
    db.orgs.push({ id: 'o1', plan_id: 'team', owner_id: OWNER })
    db.org_members.push({ org_id: 'o1', user_id: OWNER, role: 'owner' })
    expect(await ownsOrgOnPlan(ctx, 'team')).toBe(true)
    expect(await ownsOrgOnPlan(ctx, 'edu')).toBe(false)
  })
})
