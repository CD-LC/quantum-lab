import { afterEach, describe, expect, it, vi } from 'vitest'
import { OFFLINE_NOTE, devOnlyKeyHint, offlineReply } from '../app/api/agent/offlineFaq'

const DEV_ONLY = /ANTHROPIC_API_KEY|\.env\.local|dev server/i

afterEach(() => vi.unstubAllEnvs())

describe('offline tutor wording shown to learners', () => {
  it('never mentions developer setup in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(OFFLINE_NOTE).not.toMatch(DEV_ONLY)
    expect(OFFLINE_NOTE).toContain('live tutor is busy or unavailable')
    expect(devOnlyKeyHint()).toBe('')
    for (const q of ['what is a qubit?', 'zzzz unmatched question']) {
      expect(offlineReply(q)).not.toMatch(DEV_ONLY)
    }
  })

  it('keeps the developer hint for `next dev` only', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(devOnlyKeyHint()).toMatch(/ANTHROPIC_API_KEY/)
    expect(offlineReply('zzzz unmatched question')).toMatch(/ANTHROPIC_API_KEY/)
  })
})
