import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reported: Array<{ msg: string; level: string }> = []
vi.mock('@/lib/observability/report', () => ({
  reportMessage: (msg: string, level: string) => reported.push({ msg, level }),
}))

const { byokKeyIsFallback, open, resetFallbackWarningForTests, seal, secretBoxAvailable } = await import(
  '@/lib/platform/secretBox'
)

const ENV_KEYS = ['SETTINGS_ENCRYPTION_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const saved: Record<string, string | undefined> = {}
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  reported.length = 0
  resetFallbackWarningForTests()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  warn.mockRestore()
})

describe('secretBox key source', () => {
  it('is unavailable with an empty environment, and says nothing', () => {
    expect(secretBoxAvailable()).toBe(false)
    expect(byokKeyIsFallback()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses the explicit key silently and is not a fallback', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64)
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    expect(open(seal('hello'))).toBe('hello')
    expect(byokKeyIsFallback()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(reported).toEqual([])
  })

  it('still works on the derived key, so existing sealed credentials keep opening', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    expect(secretBoxAvailable()).toBe(true)
    const sealed = seal('vendor-token')
    expect(open(sealed)).toBe('vendor-token')
  })

  it('warns loudly, and reports, exactly once per process when the fallback is used', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    seal('a')
    seal('b')
    secretBoxAvailable()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('SETTINGS_ENCRYPTION_KEY')
    expect(reported).toHaveLength(1)
    expect(reported[0].level).toBe('warning')
    // The warning names the variable, never its value.
    expect(String(warn.mock.calls[0][0])).not.toContain('service-role"')
  })

  it('reports byokKeyIsFallback only when the derived key is the one in play', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    expect(byokKeyIsFallback()).toBe(true)
    // Asking is not using: no warning from the query alone.
    expect(warn).not.toHaveBeenCalled()
    process.env.SETTINGS_ENCRYPTION_KEY = 'explicit'
    expect(byokKeyIsFallback()).toBe(false)
  })

  it('keeps opening values sealed under the fallback once an explicit key is set', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    const legacy = seal('vendor-token')
    process.env.SETTINGS_ENCRYPTION_KEY = 'explicit'
    // Setting the key must not lock existing users out of BYOK.
    expect(open(legacy)).toBe('vendor-token')
  })

  it('seals NEW values under the explicit key only', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    process.env.SETTINGS_ENCRYPTION_KEY = 'explicit'
    const fresh = seal('new-token')
    delete process.env.SETTINGS_ENCRYPTION_KEY
    // A service-role-key holder cannot open it with the derived key.
    expect(open(fresh)).toBeNull()
  })

  it('does not open a value sealed under a different explicit key', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'old-explicit'
    const sealed = seal('x')
    process.env.SETTINGS_ENCRYPTION_KEY = 'new-explicit'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    expect(open(sealed)).toBeNull()
  })
})
