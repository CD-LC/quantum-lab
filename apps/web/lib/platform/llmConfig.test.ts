/**
 * llmConfig.test.ts — the provider base-URL allowlist, and the admin LLM test
 * route that sends a key to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyLlmPatch, isAllowedProviderBaseUrl, type LlmSettings } from '@/lib/platform/llmConfig'

const AZURE = 'https://acme.openai.azure.com/'

describe('isAllowedProviderBaseUrl', () => {
  it('accepts Azure resource hosts over https', () => {
    expect(isAllowedProviderBaseUrl('azure', AZURE)).toBe(true)
    expect(isAllowedProviderBaseUrl('azure', 'https://x.cognitiveservices.azure.com/openai')).toBe(true)
    expect(isAllowedProviderBaseUrl('azure', 'https://x.services.ai.azure.com')).toBe(true)
  })

  it('refuses everything else', () => {
    for (const url of [
      'http://acme.openai.azure.com/',
      'https://evil.example.com/',
      'https://openai.azure.com.evil.example.com/',
      'https://openai.azure.com/', // the bare suffix, no resource name
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://user:pw@acme.openai.azure.com/',
      'https://acme.openai.azure.com:8443/',
      'not a url',
      '',
    ]) {
      expect(isAllowedProviderBaseUrl('azure', url), url).toBe(false)
    }
  })

  it('never allows a base URL for providers that use a fixed endpoint', () => {
    expect(isAllowedProviderBaseUrl('groq', AZURE)).toBe(false)
  })

  it('takes extra hosts from the optional env var', () => {
    vi.stubEnv('PLATFORM_LLM_ALLOWED_HOSTS', 'llm.corp.example, .gw.example.net')
    expect(isAllowedProviderBaseUrl('azure', 'https://llm.corp.example/v1')).toBe(true)
    expect(isAllowedProviderBaseUrl('azure', 'https://a.gw.example.net/')).toBe(true)
    expect(isAllowedProviderBaseUrl('azure', 'https://other.example/')).toBe(false)
    vi.unstubAllEnvs()
  })
})

describe('applyLlmPatch baseUrl', () => {
  const base = (): LlmSettings =>
    applyLlmPatch(
      {
        providers: {
          gemini: { apiKey: '', model: '', baseUrl: '', apiVersion: '', enabled: true },
          groq: { apiKey: '', model: '', baseUrl: '', apiVersion: '', enabled: true },
          anthropic: { apiKey: '', model: '', baseUrl: '', apiVersion: '', enabled: true },
          azure: { apiKey: 'k', model: 'dep', baseUrl: AZURE, apiVersion: '', enabled: true },
        },
        order: ['azure', 'gemini', 'groq', 'anthropic'],
        forceProvider: null,
        tiers: {} as LlmSettings['tiers'],
        note: '',
      },
      {}
    )

  it('keeps the current value when the patch names a disallowed host', () => {
    const next = applyLlmPatch(base(), { providers: { azure: { baseUrl: 'https://evil.example.com/' } } })
    expect(next.providers.azure.baseUrl).toBe(AZURE)
  })

  it('accepts an allowed host and an empty string (clear)', () => {
    const changed = applyLlmPatch(base(), { providers: { azure: { baseUrl: 'https://b.openai.azure.com' } } })
    expect(changed.providers.azure.baseUrl).toBe('https://b.openai.azure.com')
    const cleared = applyLlmPatch(base(), { providers: { azure: { baseUrl: '' } } })
    expect(cleared.providers.azure.baseUrl).toBe('')
  })
})

// ── the route ───────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  stored: { apiKey: 'STORED-SECRET', model: 'dep', baseUrl: 'https://acme.openai.azure.com/', apiVersion: '', enabled: true },
  azureCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/platform/routeGuard', () => ({
  guardPlatformAdmin: async () => ({ ok: true }),
}))
vi.mock('@/lib/platform/settings', () => ({
  invalidateLlmSettings: () => {},
  effectiveLlmSettings: async () => ({ settings: { providers: { azure: { ...state.stored } } } }),
}))
vi.mock('@ai-sdk/azure', () => ({
  createAzure: (opts: Record<string, unknown>) => {
    state.azureCalls.push(opts)
    return () => ({})
  },
}))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => () => ({}) }))
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => ({}) }))
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => ({}) }))
vi.mock('ai', () => ({
  APICallError: { isInstance: () => false },
  generateText: async () => ({ text: 'OK' }),
}))

const route = await import('@/app/api/platform/llm/test/route')

function call(body: unknown): Promise<Response> {
  return route.POST(
    new Request('https://app.test/api/platform/llm/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
}

describe('POST /api/platform/llm/test', () => {
  beforeEach(() => {
    state.azureCalls.length = 0
    state.stored = { apiKey: 'STORED-SECRET', model: 'dep', baseUrl: 'https://acme.openai.azure.com/', apiVersion: '', enabled: true }
  })

  it('never sends the stored key to an attacker-chosen host', async () => {
    const res = await call({ provider: 'azure', baseUrl: 'https://attacker.example.com/' })
    expect(res.status).toBe(400)
    expect(state.azureCalls).toHaveLength(0)
  })

  it('refuses metadata and loopback targets', async () => {
    for (const baseUrl of ['https://169.254.169.254/', 'http://localhost:8080/']) {
      expect((await call({ provider: 'azure', baseUrl, apiKey: 'typed' })).status).toBe(400)
    }
    expect(state.azureCalls).toHaveLength(0)
  })

  it('does not lend the stored key to a different (allowed) endpoint', async () => {
    const res = await call({ provider: 'azure', baseUrl: 'https://other.openai.azure.com/' })
    expect(res.status).toBe(400)
    expect(state.azureCalls).toHaveLength(0)
  })

  it('uses a key typed in the body for a new allowed endpoint', async () => {
    const res = await call({ provider: 'azure', baseUrl: 'https://other.openai.azure.com/', apiKey: 'typed' })
    expect(res.status).toBe(200)
    expect(state.azureCalls[0]).toMatchObject({ apiKey: 'typed', baseURL: 'https://other.openai.azure.com/' })
  })

  it('tests the saved endpoint with the saved key', async () => {
    const res = await call({ provider: 'azure' })
    expect(res.status).toBe(200)
    expect(state.azureCalls[0]).toMatchObject({ apiKey: 'STORED-SECRET', baseURL: 'https://acme.openai.azure.com/' })
  })

  it('refuses a saved endpoint that predates the allowlist', async () => {
    state.stored.baseUrl = 'https://attacker.example.com/'
    expect((await call({ provider: 'azure' })).status).toBe(400)
    expect(state.azureCalls).toHaveLength(0)
  })
})
