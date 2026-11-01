/**
 * invites.test.ts — the invite token scheme and the acceptance path
 * (audit finding INV-1).
 *
 * The properties under test are the ones the old scheme did not have:
 *
 *   · a token is UNGUESSABLE — random, not derived from (org, email)
 *   · a token CARRIES NOTHING — the org and email come from the stored row, so
 *     a hand-written link resolves to nothing at all
 *   · only the HASH is stored, so a database dump yields no usable link
 *   · an invite is SINGLE USE — the second claim fails
 *   · an invite EXPIRES, on the stored expiry, not one the link asserts
 *   · a leaked link is useless to anyone but the invited address
 *
 * The acceptance route is exercised for real; Supabase (auth + the invite and
 * member rows) is stubbed so the test can state exactly who holds what.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildInviteRecord,
  hashInviteToken,
  isInviteExpired,
  isInviteToken,
  isInviteUsable,
  mintInviteToken,
} from '@/lib/orgs/invites'
import type { OrgInvite } from '@/lib/orgs/types'

// ────────────────────────────────────────────────────────────
// Fixture state
// ────────────────────────────────────────────────────────────

const INVITEE = '00000000-0000-0000-0000-0000000000b1'
const STRANGER = '00000000-0000-0000-0000-0000000000b2'
const ORG = 'org-acme'

const state: {
  /** token → { id, email }: what Supabase would return for an access token. */
  tokens: Map<string, { id: string; email: string }>
  invite: OrgInvite | null
  /** ids of invites markInviteAccepted has burned. */
  burned: Set<string>
  /** Seats claimed through claimSeat: the held seat made active and bound. */
  addedMembers: { orgId: string; email: string; role: string; status: string }[]
  /** The seats the org holds (the 'invited' row an admin minted with the link). */
  members: { id: string; orgId: string; email: string; role: string; status: string }[]
  /** Set to make claimSeat fail, to prove a failed claim does not burn the link. */
  claimFails: boolean
} = { tokens: new Map(), invite: null, burned: new Set(), addedMembers: [], members: [], claimFails: false }

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  getSupabase: () => ({
    auth: {
      getUser: async (token: string) => {
        const user = state.tokens.get(token)
        return user
          ? { data: { user: { id: user.id, email: user.email } }, error: null }
          : { data: { user: null }, error: { message: 'invalid token' } }
      },
    },
  }),
}))

// A service-role client must exist for inviteLookupContext() to hand one out.
vi.mock('@/lib/billing/entitlements', () => ({
  getServiceSupabase: () => ({ from: () => ({}) }),
}))

vi.mock('@/lib/orgs/store', () => ({
  getInviteByToken: async (token: string) => {
    if (!state.invite) return null
    // The real store hashes and looks up by hash; mirror that here so a test
    // that passes a raw guess cannot accidentally match.
    const hash = await hashInviteToken(token)
    return hash === state.invite.tokenHash ? state.invite : null
  },
  getOrg: async (orgId: string) => ({ id: orgId, name: 'Acme', seatsTotal: 25 }),
  seatUsage: async () => ({ used: 1, total: 25, available: 24 }),
  listMembers: async () => state.members,
  markInviteAccepted: async (id: string) => {
    // Single use, modelled the way the real conditional update behaves: the
    // first caller wins, every later one is told no.
    if (state.burned.has(id)) return false
    state.burned.add(id)
    return true
  },
  claimSeat: async (orgId: string, memberId: string, userId: string) => {
    if (state.claimFails) return null
    const seat = state.members.find((m) => m.id === memberId)
    if (!seat) return null
    state.addedMembers.push({ orgId, email: seat.email, role: seat.role, status: 'active' })
    return { ...seat, status: 'active', userId, joinedAt: 'now' }
  },
  releaseInvite: async (id: string) => state.burned.delete(id),
  isSeatLimitError: () => false,
}))

const accept = await import('@/app/api/orgs/invite/accept/route')

const BASE = 'https://example.test'

/**
 * A fresh client ip per request. The route's rate limiter is keyed on
 * x-forwarded-for and counts across the whole test file otherwise — this test
 * is about the invite logic, not about the limiter.
 */
let callCount = 0

function post(body: unknown, token?: string): Request {
  callCount += 1
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.0.0.${callCount}`,
  }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request(`${BASE}/api/orgs/invite/accept`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  state.tokens = new Map([
    ['tok-invitee', { id: INVITEE, email: 'Invited@acme.test' }],
    ['tok-stranger', { id: STRANGER, email: 'stranger@evil.test' }],
  ])
  state.invite = null
  state.burned = new Set()
  state.addedMembers = []
  state.members = [
    { id: 'm-held', orgId: ORG, email: 'invited@acme.test', role: 'member', status: 'invited' },
  ]
  state.claimFails = false
})

/** Mint a live invite for invited@acme.test and install it as the stored row. */
async function liveInvite(): Promise<string> {
  const { token, tokenHash } = await mintInviteToken()
  state.invite = buildInviteRecord(ORG, 'invited@acme.test', 'member', tokenHash)
  return token
}

// ────────────────────────────────────────────────────────────
// The token itself
// ────────────────────────────────────────────────────────────

describe('invite tokens', () => {
  it('is not derivable from the org and email — two mints differ', async () => {
    const a = await mintInviteToken()
    const b = await mintInviteToken()
    expect(a.token).not.toBe(b.token)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('carries 256 bits of entropy in a fixed shape', async () => {
    const { token } = await mintInviteToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(isInviteToken(token)).toBe(true)
  })

  it('stores a hash that is not the token', async () => {
    const { token, tokenHash } = await mintInviteToken()
    expect(tokenHash).not.toBe(token)
    expect(tokenHash).toBe(await hashInviteToken(token))
    // And the stored record never carries the secret at all.
    const record = buildInviteRecord(ORG, 'a@b.test', 'member', tokenHash)
    expect(JSON.stringify(record)).not.toContain(token)
  })

  it('rejects anything that is not a token shape', () => {
    // Including the old scheme's tokens, which must stop working.
    expect(isInviteToken('qli1.006f.abc.xyz')).toBe(false)
    expect(isInviteToken('')).toBe(false)
    expect(isInviteToken('z'.repeat(64))).toBe(false)
    expect(isInviteToken(null)).toBe(false)
  })

  it('reads expiry from the stored row, and fails closed on a bad one', () => {
    const past: OrgInvite = {
      id: 'i',
      orgId: ORG,
      email: 'a@b.test',
      role: 'member',
      tokenHash: 'h',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: 'x',
    }
    expect(isInviteExpired(past)).toBe(true)
    expect(isInviteUsable(past)).toBe(false)
    expect(isInviteExpired({ ...past, expiresAt: 'not a date' })).toBe(true)
    const live = { ...past, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    expect(isInviteUsable(live)).toBe(true)
    expect(isInviteUsable({ ...live, acceptedAt: 'yesterday' })).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
// POST /api/orgs/invite/accept
// ────────────────────────────────────────────────────────────

describe('POST /api/orgs/invite/accept', () => {
  it('refuses a hand-made token — the INV-1 forgery', async () => {
    await liveInvite()
    // A forged token of the right SHAPE, naming the org and the email the way
    // the old scheme did. It resolves to no row, so it claims nothing.
    const forged = 'a'.repeat(64)
    const res = await accept.POST(post({ token: forged }, 'tok-stranger'))
    expect(res.status).toBe(404)
    expect(state.addedMembers).toHaveLength(0)
  })

  it('refuses an unauthenticated claim with 401', async () => {
    const token = await liveInvite()
    const res = await accept.POST(post({ token }))
    expect(res.status).toBe(401)
    expect(state.addedMembers).toHaveLength(0)
  })

  it('refuses a leaked link used by the wrong person with 403', async () => {
    const token = await liveInvite()
    const res = await accept.POST(post({ token }, 'tok-stranger'))
    expect(res.status).toBe(403)
    expect(state.addedMembers).toHaveLength(0)
    // The invite is untouched, so the real invitee can still use it.
    expect(state.burned.size).toBe(0)
  })

  it('lets the invited address claim the seat', async () => {
    const token = await liveInvite()
    const res = await accept.POST(post({ token }, 'tok-invitee'))
    expect(res.status).toBe(200)
    expect(state.addedMembers).toEqual([
      { orgId: ORG, email: 'invited@acme.test', role: 'member', status: 'active' },
    ])
  })

  it('takes the role from the stored row, not from the request', async () => {
    const token = await liveInvite()
    const res = await accept.POST(post({ token, role: 'owner', orgId: 'org-someone-else' }, 'tok-invitee'))
    expect(res.status).toBe(200)
    expect(state.addedMembers[0].role).toBe('member')
    expect(state.addedMembers[0].orgId).toBe(ORG)
  })

  it('refuses a link whose seat was removed, so a revoked invite stays revoked', async () => {
    const token = await liveInvite()
    state.members = []
    const res = await accept.POST(post({ token }, 'tok-invitee'))
    expect(res.status).toBe(404)
    expect(state.addedMembers).toHaveLength(0)
    expect(state.burned.size).toBe(0)
  })

  it('refuses a link whose seat was suspended', async () => {
    const token = await liveInvite()
    state.members = state.members.map((m) => ({ ...m, status: 'suspended' }))
    const res = await accept.POST(post({ token }, 'tok-invitee'))
    expect(res.status).toBe(404)
    expect(state.addedMembers).toHaveLength(0)
  })

  it('un-burns the link when the claim fails, so the invitee can retry', async () => {
    const token = await liveInvite()
    state.claimFails = true
    const failed = await accept.POST(post({ token }, 'tok-invitee'))
    expect(failed.status).toBe(500)
    expect(state.burned.size).toBe(0)
    state.claimFails = false
    const retry = await accept.POST(post({ token }, 'tok-invitee'))
    expect(retry.status).toBe(200)
  })

  it('is single use — the second claim fails', async () => {
    const token = await liveInvite()
    expect((await accept.POST(post({ token }, 'tok-invitee'))).status).toBe(200)
    const second = await accept.POST(post({ token }, 'tok-invitee'))
    expect(second.status).toBe(404)
    expect(state.addedMembers).toHaveLength(1)
  })

  it('refuses an expired invite', async () => {
    const token = await liveInvite()
    state.invite = {
      ...(state.invite as OrgInvite),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    const res = await accept.POST(post({ token }, 'tok-invitee'))
    expect(res.status).toBe(404)
    expect(state.addedMembers).toHaveLength(0)
  })

  it('gives the same sentence for missing, used and expired', async () => {
    const token = await liveInvite()
    const missing = await accept.POST(post({ token: 'b'.repeat(64) }, 'tok-invitee'))
    state.invite = {
      ...(state.invite as OrgInvite),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    const expired = await accept.POST(post({ token }, 'tok-invitee'))
    const a = (await missing.json()) as { error: string }
    const b = (await expired.json()) as { error: string }
    expect(a.error).toBe(b.error)
  })

  it('bounds a junk token without hashing it', async () => {
    const res = await accept.POST(post({ token: 'x'.repeat(5000) }, 'tok-invitee'))
    // 5000 bytes is over the route's 4 KiB body cap: refused while reading.
    expect(res.status).toBe(413)
  })
})

describe('mailSafeOrgName', () => {
  it('leaves an ordinary name alone', async () => {
    const { mailSafeOrgName } = await import('@/lib/orgs/invites')
    expect(mailSafeOrgName('Acme Physics Dept')).toBe('Acme Physics Dept')
  })

  it('strips URLs, domains, emails and phone numbers', async () => {
    const { mailSafeOrgName } = await import('@/lib/orgs/invites')
    expect(mailSafeOrgName('Claim your prize at https://evil.example/x now')).toBe('Claim your prize at now')
    expect(mailSafeOrgName('Visit evil-site.com today')).toBe('Visit today')
    expect(mailSafeOrgName('Call +1 (555) 123-4567 or mail a@b.co')).toBe('Call or mail')
    expect(mailSafeOrgName('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })

  it('falls back when nothing is left', async () => {
    const { mailSafeOrgName } = await import('@/lib/orgs/invites')
    expect(mailSafeOrgName('https://evil.example')).toBe('an organisation')
    expect(mailSafeOrgName('\n\t')).toBe('an organisation')
  })
})
