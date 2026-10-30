/**
 * evolveRoute.test.ts — POST/GET /api/workbench/evolve and the model budget.
 *
 * The identity, entitlement, settings and AI-SDK layers are mocked at their
 * module seams; the daily-quota gate (lib/llm/callerAccess) and the route are
 * real. No network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { emptyLlmSettings, type LlmSettings } from '@/lib/platform/llmConfig'

const state = vi.hoisted(() => ({
  settings: null as unknown,
  generateCalls: 0,
  failWith: null as unknown,
  signals: [] as unknown[],
}))

vi.mock('@/lib/security/auth', () => ({ verifiedCaller: async () => null }))
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlement: async () => null }))
vi.mock('@/lib/platform/settings', () => ({
  effectiveLlmSettings: async () => ({ settings: state.settings }),
}))
vi.mock('@/lib/llm/model', () => ({
  buildLanguageModel: () => ({}),
  llmTimeoutSignal: () => AbortSignal.timeout(60_000),
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateText: async (opts: { abortSignal?: unknown }) => {
      state.generateCalls += 1
      state.signals.push(opts.abortSignal)
      if (state.failWith) throw state.failWith
      return { text: '```\nH 0\n```' }
    },
  }
})

import { GET, POST } from '@/app/api/workbench/evolve/route'
import { PROBLEMS } from '@/lib/workbench/evolve'

function liveSettings(messagesPerDay: number | null): LlmSettings {
  const s = emptyLlmSettings()
  s.providers.gemini.apiKey = 'k'
  s.providers.groq.apiKey = 'k2'
  s.tiers.anonymous.access = 'live'
  s.tiers.anonymous.messagesPerDay = messagesPerDay
  return s
}

const problem = PROBLEMS[0]

function post(ip: string, extra: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/workbench/evolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ problemId: problem.id, generation: 1, elites: [], ...extra }),
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  state.generateCalls = 0
  state.failWith = null
  state.signals = []
  state.settings = liveSettings(3)
})

describe('/api/workbench/evolve — model budget', () => {
  it('counts every model call against the tier daily quota: the 4th anonymous call gets no model', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(post('198.51.100.50'))
      expect(res.status, `call ${i + 1}`).toBe(200)
    }
    expect(state.generateCalls).toBe(3)
    const fourth = await POST(post('198.51.100.50'))
    expect(fourth.status).toBe(429)
    expect(fourth.headers.get('retry-after')).toBeTruthy()
    expect(state.generateCalls).toBe(3)
    // Another address has its own allowance.
    expect((await POST(post('198.51.100.51'))).status).toBe(200)
  })

  it('a zero allowance never reaches the model', async () => {
    state.settings = liveSettings(0)
    const res = await POST(post('198.51.100.60'))
    expect(res.status).toBe(429)
    expect(state.generateCalls).toBe(0)
  })

  it('a request that fails validation does not spend the quota', async () => {
    const bad = await POST(post('198.51.100.70', { problemId: 'nope' }))
    expect(bad.status).toBe(400)
    for (let i = 0; i < 3; i++) expect((await POST(post('198.51.100.70'))).status).toBe(200)
  })

  it('refuses the model when the tier is off', async () => {
    const s = liveSettings(3)
    s.tiers.anonymous.access = 'off'
    state.settings = s
    const res = await POST(post('198.51.100.80'))
    expect(res.status).toBe(403)
    expect(state.generateCalls).toBe(0)
  })
})

describe('/api/workbench/evolve — provider choice follows the admin policy', () => {
  it('open policy: a caller may name any ready provider', async () => {
    const res = await POST(post('198.51.100.90', { provider: 'groq' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { providerId: string }).providerId).toBe('groq')
  })

  it('a pinned tier provider cannot be walked around by naming another', async () => {
    const s = liveSettings(5)
    s.tiers.anonymous.provider = 'gemini'
    state.settings = s
    const res = await POST(post('198.51.100.91', { provider: 'groq' }))
    expect(res.status).toBe(503)
    expect(state.generateCalls).toBe(0)

    const status = await GET(new Request('http://localhost/api/workbench/evolve', { headers: { 'cf-connecting-ip': '198.51.100.92' } }))
    const body = (await status.json()) as { providers: { id: string }[] }
    expect(body.providers.map((p) => p.id)).toEqual(['gemini'])
  })
})

describe('/api/workbench/evolve — failures', () => {
  it('a provider failure reaches the caller as a fixed sentence', async () => {
    state.failWith = new Error('deployment gpt-secret at https://internal.example')
    const res = await POST(post('198.51.100.95'))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const text = await res.text()
    expect(text).not.toContain('gpt-secret')
    expect(text).not.toContain('internal.example')
  })
})

describe('/api/workbench/evolve — provider call timeout and body cap', () => {
  it('passes a timeout abortSignal to generateText', async () => {
    const res = await POST(post('198.51.100.90'))
    expect(res.status).toBe(200)
    expect(state.signals).toHaveLength(1)
    expect(state.signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('refuses an oversized streamed body with 413 before the model', async () => {
    const big = new Uint8Array(2_000_000).fill(120)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big)
        controller.close()
      },
    })
    const req = new Request('http://localhost/api/workbench/evolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.91' },
      body,
      duplex: 'half',
    } as RequestInit)
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(state.generateCalls).toBe(0)
  })
})
