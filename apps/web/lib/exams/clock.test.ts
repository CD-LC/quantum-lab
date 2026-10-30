import { describe, expect, it } from 'vitest'
import { clockOffsetMs, remainingMs, retakeAvailableAt, RETAKE_COOLDOWN_MS } from './clock'

describe('clockOffsetMs', () => {
  it('measures a fast device clock so the countdown can subtract it', () => {
    const server = Date.parse('2026-10-22T10:00:00Z')
    const offset = clockOffsetMs(new Date(server).toISOString(), server + 5 * 60_000)
    expect(offset).toBe(5 * 60_000)
    const deadline = new Date(server + 25 * 60_000).toISOString()
    // A device 5 minutes fast, one second in: the full ~25 minutes remain.
    expect(remainingMs(deadline, server + 5 * 60_000 + 1000 - offset)).toBe(25 * 60_000 - 1000)
  })

  it('is zero for missing or unparseable input', () => {
    expect(clockOffsetMs(undefined, 123)).toBe(0)
    expect(clockOffsetMs('nonsense', 123)).toBe(0)
  })
})

describe('retakeAvailableAt', () => {
  it('waits only after a failure', () => {
    const at = '2026-10-22T10:00:00.000Z'
    expect(retakeAvailableAt(at, false)).toBe(new Date(Date.parse(at) + RETAKE_COOLDOWN_MS).toISOString())
    expect(retakeAvailableAt(at, true)).toBeUndefined()
    expect(retakeAvailableAt(undefined, false)).toBeUndefined()
  })
})
