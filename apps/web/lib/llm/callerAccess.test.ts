import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLlmSettings } from '@/lib/platform/llmConfig'

const state = vi.hoisted(() => ({ settings: null as unknown }))

vi.mock('@/lib/platform/settings', () => ({
  effectiveLlmSettings: async () => ({ settings: state.settings }),
}))
vi.mock('@/lib/security/auth', () => ({
  verifiedCaller: async () => null,
}))
vi.mock('@/lib/billing/entitlements', () => ({
  getEntitlement: async () => null,
}))

import { liveModelForCaller, trustedHeaders } from './callerAccess'

function liveSettings(messagesPerDay: number | null) {
  const s = emptyLlmSettings()
  s.providers.gemini.apiKey = 'k'
  s.tiers.anonymous.access = 'live'
  s.tiers.anonymous.messagesPerDay = messagesPerDay
  return s
}

describe('liveModelForCaller', () => {
  beforeEach(() => {
    state.settings = liveSettings(10)
  })

  it('charges the anonymous daily quota: the 11th model-calling request gets no model', async () => {
    const identity = { authorization: null, clientIp: '198.51.100.20' }
    for (let i = 0; i < 10; i++) {
      const access = await liveModelForCaller(identity, 'test-quota-a')
      expect(access.kind, `call ${i + 1}`).toBe('live')
    }
    const eleventh = await liveModelForCaller(identity, 'test-quota-a')
    expect(eleventh.kind).toBe('none')
    if (eleventh.kind === 'none') {
      expect(eleventh.reason).toBe('quota_spent')
      expect(eleventh.note).not.toMatch(/gemini|key|http/i)
    }
  })

  it('keys the quota on the transport-trusted address: another address has its own allowance', async () => {
    state.settings = liveSettings(1)
    expect((await liveModelForCaller({ clientIp: '198.51.100.31' }, 'test-quota-b')).kind).toBe('live')
    expect((await liveModelForCaller({ clientIp: '198.51.100.31' }, 'test-quota-b')).kind).toBe('none')
    expect((await liveModelForCaller({ clientIp: '198.51.100.32' }, 'test-quota-b')).kind).toBe('live')
  })

  it('a zero allowance never reaches a model', async () => {
    state.settings = liveSettings(0)
    const access = await liveModelForCaller({ clientIp: '198.51.100.40' }, 'test-quota-c')
    expect(access).toMatchObject({ kind: 'none', reason: 'quota_zero' })
  })

  it('an unlimited tier is not charged', async () => {
    state.settings = liveSettings(null)
    for (let i = 0; i < 30; i++) {
      expect((await liveModelForCaller({ clientIp: '198.51.100.50' }, 'test-quota-d')).kind).toBe('live')
    }
  })

  it('reports a switched-off tier and a tier with no provider as no model', async () => {
    const off = liveSettings(10)
    off.tiers.anonymous.access = 'off'
    state.settings = off
    expect(await liveModelForCaller({}, 'test-quota-e')).toMatchObject({ kind: 'none', reason: 'off' })
    state.settings = emptyLlmSettings()
    expect(await liveModelForCaller({}, 'test-quota-e')).toMatchObject({ kind: 'none', reason: 'offline' })
  })
})

describe('trustedHeaders', () => {
  it('puts the address under cf-connecting-ip and bounds it', () => {
    expect(trustedHeaders('203.0.113.9').get('cf-connecting-ip')).toBe('203.0.113.9')
    expect(trustedHeaders('x'.repeat(200)).get('cf-connecting-ip')).toHaveLength(64)
    expect(trustedHeaders(null).get('cf-connecting-ip')).toBeNull()
  })
})
