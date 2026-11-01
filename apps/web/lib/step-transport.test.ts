/**
 * step-transport.test.ts — the step scrubber never reads a frame that was cut off.
 */

import { describe, expect, it } from 'vitest'
import { clampTransportStep, maxFrameStep } from './step-transport'
import { simulateStepsChecked, type Circuit, type GateOp } from './quantum'

describe('step transport bounds', () => {
  it('reaches every step when all frames were kept', () => {
    // 5 gates -> 6 frames.
    expect(maxFrameStep(5, 6)).toBe(5)
    for (let s = 0; s <= 5; s++) expect(clampTransportStep(s, 5, 6)).toBe(s)
    expect(clampTransportStep(99, 5, 6)).toBe(5)
    expect(clampTransportStep(-3, 5, 6)).toBe(0)
  })

  it('stops scrubbing at the last kept frame, but End still reaches the final state', () => {
    // 250 gates, 192 frames kept (indices 0..191).
    expect(maxFrameStep(250, 192)).toBe(191)
    expect(clampTransportStep(100, 250, 192)).toBe(100)
    expect(clampTransportStep(191, 250, 192)).toBe(191)
    expect(clampTransportStep(192, 250, 192)).toBe(191) // no frame for this step
    expect(clampTransportStep(249, 250, 192)).toBe(191)
    expect(clampTransportStep(250, 250, 192)).toBe(250) // End
    expect(clampTransportStep(999, 250, 192)).toBe(250)
  })

  it('matches what simulateStepsChecked really keeps at 16 qubits', () => {
    const ops: GateOp[] = []
    for (let i = 0; i < 250; i++) ops.push({ name: 'H', qubits: [i % 16] })
    ops.push({ name: 'X', qubits: [0] })
    const c: Circuit = { numQubits: 16, ops }
    const r = simulateStepsChecked(c)
    expect(r.frames.length).toBeLessThan(ops.length + 1)
    const max = maxFrameStep(ops.length, r.frames.length)
    expect(max).toBe(r.frames.length - 1)
    // The step the old End button landed on (total) maps to the exact final state...
    expect(clampTransportStep(ops.length, ops.length, r.frames.length)).toBe(ops.length)
    // ...which is NOT the last kept frame.
    const last = r.frames[r.frames.length - 1]
    let differs = false
    for (let i = 0; i < r.finalState.dim && !differs; i++) {
      differs = Math.abs(r.finalState.probability(i) - last.probability(i)) > 1e-9
    }
    expect(differs).toBe(true)
  })

  it('handles an empty circuit', () => {
    expect(maxFrameStep(0, 1)).toBe(0)
    expect(clampTransportStep(3, 0, 1)).toBe(0)
  })
})
