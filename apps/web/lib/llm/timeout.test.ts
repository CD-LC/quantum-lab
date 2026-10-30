import { describe, expect, it } from 'vitest'
import { LLM_CALL_TIMEOUT_MS, llmTimeoutSignal } from './model'

describe('llm call timeout', () => {
  it('is shorter than a typical platform proxy limit and leaves room after the 25 s agent attempt', () => {
    expect(LLM_CALL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(LLM_CALL_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('produces a signal that is not yet aborted and that aborts after the given time', async () => {
    const signal = llmTimeoutSignal(20)
    expect(signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(signal.aborted).toBe(true)
  })

  it('falls back to the default for a nonsense duration instead of aborting immediately', () => {
    expect(llmTimeoutSignal(0).aborted).toBe(false)
    expect(llmTimeoutSignal(Number.NaN).aborted).toBe(false)
    expect(llmTimeoutSignal(-5).aborted).toBe(false)
  })
})
