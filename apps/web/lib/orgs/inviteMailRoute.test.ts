/**
 * POST /api/orgs/invite — the mail-relay guards: org name sanitised in the
 * subject and body, a per-recipient daily cap, and no mail to a seat that is
 * already active.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rateLimit'

const state = vi.hoisted(() => ({
  orgName: 'Acme',
  members: [] as { email: string; status: string }[],
  mail: [] as { to: string; subject: string; text: string }[],
}))

vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: true, getSupabase: () => null }))
vi.mock('@/lib/security/auth', () => ({
  SIGN_IN_REQUIRED: 'Sign in',
  verifiedCallerId: async () => 'user-admin',
}))
vi.mock('@/lib/orgs/access', () => ({
  MANAGE_ROLES: ['owner', 'admin'],
  inviteLookupContext: () => undefined,
  ownerOnlyDenied: () => null,
  requireOrgRole: async () => ({ ok: true, membership: { role: 'admin' }, context: { userId: 'user-admin' } }),
}))
vi.mock('@/lib/orgs/store', () => ({
  getOrg: async (id: string) => ({ id, name: state.orgName, seatsTotal: 50 }),
  seatUsage: async () => ({ used: 1, total: 50, available: 49 }),
  listMembers: async () => state.members,
  addMember: async (_o: string, email: string, role: string, status: string) => {
    const existing = state.members.find((m) => m.email === email)
    if (existing) return existing
    state.members.push({ email, status })
    return { id: 'm', email, role, status }
  },
  createInviteRecord: async (invite: unknown) => invite,
  getInviteByToken: async () => null,
  isSeatLimitError: () => false,
}))
vi.mock('@/lib/email/client', () => ({
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    state.mail.push(m)
    return { sent: true, id: 'x' }
  },
}))

const route = await import('@/app/api/orgs/invite/route')

let n = 0
function post(email: string): Promise<Response> {
  n += 1
  return route.POST(
    new Request('https://app.test/api/orgs/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${(n % 250) + 1}` },
      body: JSON.stringify({ orgId: 'org-1', email, role: 'member' }),
    })
  )
}

beforeEach(() => {
  state.orgName = 'Acme'
  state.members = []
  state.mail = []
  __resetRateLimitForTests()
})

describe('invite mail', () => {
  it('puts a sanitised org name in the subject and body', async () => {
    state.orgName = 'WIN A PRIZE at https://evil.example/claim call +1 555 123 4567'
    const res = await post('victim@example.com')
    expect(res.status).toBe(201)
    const mail = state.mail[0]
    expect(mail.subject).not.toMatch(/evil|555/)
    expect(mail.text).not.toMatch(/evil\.example|555 123/)
  })

  it('mails one address at most three times a day', async () => {
    for (let i = 0; i < 3; i += 1) expect((await post('same@example.com')).status).toBe(201)
    expect((await post('same@example.com')).status).toBe(429)
    expect(state.mail).toHaveLength(3)
  })

  it('sends no mail to an address that already holds an active seat', async () => {
    state.members = [{ email: 'active@example.com', status: 'active' }]
    const res = await post('active@example.com')
    expect(res.status).toBe(201)
    expect(state.mail).toHaveLength(0)
    const body = (await res.json()) as { emailSent: boolean }
    expect(body.emailSent).toBe(false)
  })
})
