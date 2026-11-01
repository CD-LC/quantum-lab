/**
 * POST /api/hardware/runs — publishing is irreversible and public, so an API
 * key (read scope) must not be able to do it; only a signed-in session can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ via: 'api-key' as 'api-key' | 'session' }))

vi.mock('@/lib/hardware/proxy', async () => {
  const { NextResponse } = await import('next/server')
  return {
    SUBMIT_LIMIT: { limit: 100, windowMs: 60_000 },
    limitOrNull: async () => null,
    quotaUnavailable: () => NextResponse.json({}, { status: 503 }),
    readJsonObject: async (req: Request) => ({ ok: true, value: await req.json() }),
    requireCaller: async () => ({ ok: true, id: 'user-1', via: state.via }),
  }
})
vi.mock('@/lib/billing/entitlements', () => ({
  getServiceSupabase: () => null,
  isServiceRoleConfigured: false,
}))

const route = await import('@/app/api/hardware/runs/route')

function post(): Promise<Response> {
  return route.POST(
    new Request('https://app.test/api/hardware/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rowId: 'row-1', optIn: true }),
    })
  )
}

beforeEach(() => {
  state.via = 'api-key'
})

describe('POST /api/hardware/runs', () => {
  it('refuses an API key, even with the opt-in', async () => {
    const res = await post()
    expect(res.status).toBe(403)
  })

  it('lets a session caller through to the next gate', async () => {
    state.via = 'session'
    const res = await post()
    // Past the credential gate; this stub deployment has no service-role key.
    expect(res.status).toBe(503)
  })
})
