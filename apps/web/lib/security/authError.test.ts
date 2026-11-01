import { describe, expect, it } from 'vitest'
import {
  AUTH_ERROR_DENIED,
  AUTH_ERROR_EXPIRED,
  AUTH_ERROR_GENERIC,
  authErrorMessage,
} from '@/components/auth/authError'

describe('authErrorMessage', () => {
  it('maps expired codes to the fixed expired message', () => {
    expect(authErrorMessage({ code: 'otp_expired' })).toBe(AUTH_ERROR_EXPIRED)
    expect(authErrorMessage({ description: 'Email link is invalid or has expired' })).toBe(
      AUTH_ERROR_EXPIRED,
    )
  })

  it('maps denial codes to the fixed denied message', () => {
    expect(authErrorMessage({ code: 'access_denied' })).toBe(AUTH_ERROR_DENIED)
    expect(authErrorMessage({ error: 'access_denied' })).toBe(AUTH_ERROR_DENIED)
  })

  it('never echoes attacker-chosen text from the URL', () => {
    const spoof = 'Your account is suspended. Call +1-555-0100 to restore access'
    for (const input of [
      { code: 'x', description: spoof },
      { error: spoof },
      { code: spoof },
      { code: 'x', error: spoof, description: spoof },
    ]) {
      const out = authErrorMessage(input)
      expect(out).toBe(AUTH_ERROR_GENERIC)
      expect(out).not.toContain('suspended')
      expect(out).not.toContain('555')
    }
  })
})
