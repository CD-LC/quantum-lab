/**
 * store.test.ts — the store's server-side identity (audit finding ORG-2).
 *
 * The bug: every function resolved the caller with
 * `getSupabase().auth.getSession()`, the BROWSER client. In a route handler
 * that is always null, so every call fell through to `readLocal()` — an empty
 * database on the server. The org API passed its authorisation checks and then
 * operated on nothing.
 *
 * These tests run in vitest's `node` environment, which has no `window` and no
 * `localStorage`, i.e. exactly the conditions a route handler runs in. So:
 *
 *   · without a context → the browser path, no session, empty results. This is
 *     the pre-fix behaviour, asserted so a regression is visible.
 *   · with a context    → real queries against the client it was handed, using
 *     the caller it was handed.
 *
 * The last two tests are the ones that matter most: the store must never let a
 * caller-supplied id select whose data is read or written.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// The browser client: configured, but with no session — a route handler.
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  }),
}))

import type { OrgContext } from '@/lib/orgs/store'

const { createOrg, listMembers, listOrgs } = await import('@/lib/orgs/store')

const CALLER = '00000000-0000-0000-0000-0000000000c1'
const VICTIM = '00000000-0000-0000-0000-0000000000c2'

interface Recorded {
  table: string
  filters: Record<string, unknown>
  inserted: Record<string, unknown> | null
}

/**
 * A Supabase stub that records what was asked for and answers from `rows`,
 * keyed by table name.
 */
function stubClient(rows: Record<string, Record<string, unknown>[]>): {
  client: SupabaseClient
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const client = {
    from(table: string) {
      const record: Recorded = { table, filters: {}, inserted: null }
      calls.push(record)
      const match = () =>
        (rows[table] ?? []).filter((row) =>
          Object.entries(record.filters).every(([k, v]) =>
            Array.isArray(v) ? v.includes(row[k]) : row[k] === v
          )
        )
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => Promise.resolve({ data: match(), error: null }),
        eq: (column: string, value: unknown) => {
          record.filters[column] = value
          return builder
        },
        in: (column: string, values: unknown[]) => {
          record.filters[column] = values
          return builder
        },
        insert: (values: Record<string, unknown>) => {
          record.inserted = values
          return builder
        },
        single: () => Promise.resolve({ data: { ...(record.inserted ?? {}), id: 'new' }, error: null }),
        maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: match(), error: null }),
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

function ctxFor(client: SupabaseClient, userId: string | null = CALLER): OrgContext {
  return { userId, client }
}

describe('the store without a context (the ORG-2 bug)', () => {
  it('returns nothing server-side, because there is no browser session', async () => {
    // No window, no session: this is precisely what every org route used to do.
    expect(await listMembers('org-acme')).toEqual([])
    expect(await listOrgs(CALLER)).toEqual([])
  })
})

describe('the store with a server context', () => {
  it('reads members through the client it was handed', async () => {
    const { client, calls } = stubClient({
      org_members: [
        {
          id: 'm1',
          org_id: 'org-acme',
          user_id: CALLER,
          email: 'a@acme.test',
          role: 'owner',
          status: 'active',
          plan_id: 'team',
          joined_at: '2020-01-01',
          last_active_at: null,
        },
      ],
    })
    const members = await listMembers('org-acme', ctxFor(client))
    expect(members).toHaveLength(1)
    expect(members[0].email).toBe('a@acme.test')
    expect(calls[0].filters.org_id).toBe('org-acme')
  })

  it('lists orgs for the VERIFIED caller, never the userId argument', async () => {
    const { client, calls } = stubClient({
      org_members: [{ org_id: 'org-mine', user_id: CALLER }],
      orgs: [
        {
          id: 'org-mine',
          name: 'Mine',
          slug: 'mine',
          plan_id: 'team',
          seats_total: 10,
          seats_used: 1,
          domain: null,
          created_at: 'x',
          owner_id: CALLER,
        },
      ],
    })

    // The caller asks for someone ELSE's organisations. The store must ignore
    // it: a user id in a request is a claim, never a credential.
    const orgs = await listOrgs(VICTIM, ctxFor(client))

    expect(calls[0].table).toBe('org_members')
    expect(calls[0].filters.user_id).toBe(CALLER)
    expect(calls[0].filters.user_id).not.toBe(VICTIM)
    expect(orgs.map((o) => o.id)).toEqual(['org-mine'])
  })

  it('creates an org owned by the verified caller, not by the supplied ownerId', async () => {
    const { client, calls } = stubClient({ orgs: [] })
    await createOrg(
      { name: 'Acme', planId: 'team', ownerId: VICTIM, ownerEmail: 'v@acme.test' },
      ctxFor(client)
    )
    const orgInsert = calls.find((c) => c.table === 'orgs' && c.inserted)
    expect(orgInsert?.inserted?.owner_id).toBe(CALLER)
    const memberInsert = calls.find((c) => c.table === 'org_members' && c.inserted)
    expect(memberInsert?.inserted?.user_id).toBe(CALLER)
  })

  it('refuses to create an org with a user-less (invite-lookup) context', async () => {
    const { client } = stubClient({ orgs: [] })
    await expect(
      createOrg(
        { name: 'Acme', planId: 'team', ownerId: VICTIM, ownerEmail: 'v@acme.test' },
        ctxFor(client, null)
      )
    ).rejects.toThrow(/signed-in caller/i)
  })

  it('returns nothing for a user-less context asked to list orgs', async () => {
    const { client } = stubClient({ org_members: [{ org_id: 'org-mine', user_id: CALLER }] })
    expect(await listOrgs(CALLER, ctxFor(client, null))).toEqual([])
  })
})
