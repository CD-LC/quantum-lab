/**
 * quantum.limits.test.ts — the engine's resource and failure bounds.
 *
 * Anonymous callers (MCP tools, share links) hand this engine arbitrary
 * circuits, so what matters here is that hostile or merely unlucky input ends
 * in a bounded amount of work and a readable message, never an OOM, a
 * minutes-long loop, or an exception thrown out of a React render.
 */

import { describe, it, expect } from 'vitest'
import {
  BranchLimitError,
  StateVector,
  branchLimit,
  execute,
  fromQasm,
  frameLimit,
  outcomeBranches,
  run,
  sampleBudget,
  simulate,
  simulateSteps,
  simulateStepsChecked,
  type Circuit,
  type GateOp,
} from './quantum'

/** n qubits, each Hadamarded and measured into its own bit: 2^n branches. */
function measuredSuperposition(n: number): Circuit {
  const ops: GateOp[] = []
  for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] })
  for (let q = 0; q < n; q++) ops.push({ name: 'MEASURE', qubits: [q], clbit: q })
  return { numQubits: n, ops }
}

describe('branch enumeration is bounded by memory, not just count', () => {
  it('shrinks the branch cap as the register grows', () => {
    expect(branchLimit(3)).toBe(4096)
    expect(branchLimit(10)).toBe(2048)
    expect(branchLimit(16)).toBe(32)
    expect(branchLimit(16, 8)).toBe(8)
  })

  it('refuses a 16-qubit, 12-measurement tree before allocating it', () => {
    const circuit = measuredSuperposition(12)
    const wide: Circuit = { ...circuit, numQubits: 16 }
    const before = process.memoryUsage().arrayBuffers
    expect(() => outcomeBranches(wide)).toThrow(BranchLimitError)
    // 4096 x 1 MB would be 4 GiB; the bound stops it at a few dozen MiB.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(256 * 1024 * 1024)
  })

  it('still enumerates what fits, exactly as before', () => {
    const branches = outcomeBranches(measuredSuperposition(8))
    expect(branches).toHaveLength(256)
    for (const b of branches) expect(b.probability).toBeCloseTo(1 / 256, 12)
  })

  it('run() falls back to sampling instead of throwing when the tree is too big', () => {
    const wide: Circuit = { ...measuredSuperposition(7), numQubits: 16 }
    const r = run(wide, 64, 0, 7)
    expect(r.shots).toBe(64)
    expect(r.probabilities).toHaveLength(2 ** 16)
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })

  it('counts RESET branches: 13 H;RESET pairs plus a measurement does not throw', () => {
    const ops: GateOp[] = []
    for (let i = 0; i < 13; i++) ops.push({ name: 'H', qubits: [0] }, { name: 'RESET', qubits: [0] })
    ops.push({ name: 'H', qubits: [0] }, { name: 'MEASURE', qubits: [0], clbit: 0 })
    const r = run({ numQubits: 1, ops }, 128, 0, 3)
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    expect(r.probabilities[1]).toBeCloseTo(0.5, 1)
  })
})

describe('sampled run() work is bounded', () => {
  it('keeps full trajectories on small circuits and shrinks them on wide ones', () => {
    const small = measuredSuperposition(4)
    expect(sampleBudget(small, 4096)).toBe(4096)
    const wide: Circuit = { ...measuredSuperposition(13), numQubits: 16 }
    expect(sampleBudget(wide, 4096)).toBeLessThan(64)
    expect(sampleBudget(wide, 4096)).toBeGreaterThanOrEqual(1)
  })

  it('finishes a 16-qubit, 13-measurement circuit at 4096 shots in bounded time', () => {
    const circuit: Circuit = { ...measuredSuperposition(13), numQubits: 16 }
    const t0 = Date.now()
    const r = run(circuit, 4096, 0, 11)
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(4096)
  })
})

describe('an impossible POSTSELECT is a message, not an exception', () => {
  const impossible: Circuit = {
    numQubits: 2,
    ops: [
      { name: 'H', qubits: [1] },
      { name: 'POSTSELECT', qubits: [0], postselectValue: 1 },
      { name: 'X', qubits: [1] },
    ],
  }

  it('execute() still throws by default', () => {
    expect(() => execute(impossible)).toThrow(/probability/)
  })

  it('tolerant execute() freezes the state at the failing op and reports it', () => {
    const r = execute(impossible, { collectFrames: true, tolerateImpossiblePostselect: true })
    expect(r.postselectionFailure).toMatchObject({ op: 1, qubit: 0, value: 1 })
    expect(r.frames).toHaveLength(4)
    // The X after the failed POSTSELECT never ran.
    expect(r.state.probability(0b00)).toBeCloseTo(0.5, 12)
    expect(r.state.probability(0b10)).toBeCloseTo(0.5, 12)
  })

  it('simulate() and simulateSteps() do not throw', () => {
    expect(() => simulate(impossible)).not.toThrow()
    expect(simulateSteps(impossible)).toHaveLength(4)
    const checked = simulateStepsChecked(impossible)
    expect(checked.notice).toMatch(/impossible/i)
  })

  it('a decoded share-link style circuit (postselect |1> on a fresh wire) renders safely', () => {
    const c = fromQasm(
      'OPENQASM 3;\nqubit[2] q;\nh q[1];\n// qubit16:postselect q[0]==1 (idealized, simulator-only, not standard OpenQASM)'
    )
    expect(() => simulateStepsChecked(c)).not.toThrow()
    expect(simulateStepsChecked(c).notice).not.toBeNull()
  })

  it('run() on it throws one readable error the page can show', () => {
    expect(() => run(impossible, 16, 0, 1)).toThrow(/impossible/i)
  })

  it('a possible POSTSELECT yields no notice', () => {
    const ok: Circuit = {
      numQubits: 1,
      ops: [{ name: 'H', qubits: [0] }, { name: 'POSTSELECT', qubits: [0], postselectValue: 1 }],
    }
    expect(simulateStepsChecked(ok).notice).toBeNull()
  })
})

describe('tiny-probability branches no longer make Run throw', () => {
  it('ry(2e-7) then measure: run() returns a distribution', () => {
    const c: Circuit = {
      numQubits: 1,
      ops: [{ name: 'RY', qubits: [0], theta: 2e-7 }, { name: 'MEASURE', qubits: [0], clbit: 0 }],
    }
    // P(1) is ~1e-14: above BRANCH_EPSILON, below collapseQubit's threshold.
    expect(() => outcomeBranches(c)).not.toThrow()
    const r = run(c, 32, 0, 5)
    expect(r.probabilities[0]).toBeCloseTo(1, 9)
  })

  it('execute() never draws an outcome collapseQubit would refuse', () => {
    const c: Circuit = {
      numQubits: 1,
      ops: [{ name: 'RY', qubits: [0], theta: 2e-7 }, { name: 'MEASURE', qubits: [0], clbit: 0 }],
    }
    // A draw of exactly 0 would pick outcome 1 (p ~ 1e-14) under `rng() < p1`.
    const r = execute(c, { rng: () => 0 })
    expect(r.clbits[0]).toBe(0)
  })
})

describe('simulateSteps keeps a bounded number of frames', () => {
  it('limits frames by bytes, and still returns the exact final state', () => {
    expect(frameLimit(16)).toBe(192)
    const ops: GateOp[] = []
    for (let i = 0; i < 300; i++) ops.push({ name: 'H', qubits: [0] })
    ops.push({ name: 'X', qubits: [1] })
    const c: Circuit = { numQubits: 16, ops }
    const r = simulateStepsChecked(c)
    expect(r.frames).toHaveLength(192)
    expect(r.notice).toMatch(/limited to the first 191/)
    // 300 H on q0 is identity; X on q1 flips it.
    expect(r.finalState.probability(0b10)).toBeCloseTo(1, 9)
  })

  it('does not truncate a normal circuit', () => {
    const c: Circuit = { numQubits: 3, ops: [{ name: 'H', qubits: [0] }, { name: 'CX', qubits: [0, 1] }] }
    const r = simulateStepsChecked(c)
    expect(r.frames).toHaveLength(3)
    expect(r.notice).toBeNull()
    expect(r.finalState).toBe(r.frames[2])
  })

  it('collects a bounded prefix with execute({ maxFrames })', () => {
    const c: Circuit = {
      numQubits: 1,
      ops: [{ name: 'H', qubits: [0] }, { name: 'H', qubits: [0] }, { name: 'MEASURE', qubits: [0], clbit: 0 }],
    }
    expect(execute(c, { collectFrames: true, maxFrames: 2 }).frames).toHaveLength(2)
    expect(new StateVector(1).numQubits).toBe(1)
  })
})

describe('fromQasm if-conditions are linear-time', () => {
  it('parses a 20 KB whitespace-padded conditional quickly (it was ~4 s)', () => {
    const hostile = 'OPENQASM 3;\nqubit[2] q;\nbit[1] c;\nif (c[0]==1) {x' + ' '.repeat(3900) + 'y'
    const t0 = Date.now()
    fromQasm(hostile)
    // A 20 000-char single line: over the line cap, skipped outright.
    fromQasm('if (c[0]==1) {x' + ' '.repeat(20_000) + 'y')
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('still reads every accepted spelling of a conditional gate', () => {
    for (const text of [
      'if (c[0] == true) { x q[1]; }',
      'if (c[0]==1) x q[1];',
      'if(c[0]==1){x q[1];}',
      'IF (c[0] == 1) {  x q[1]  }',
    ]) {
      const c = fromQasm(`OPENQASM 3;\nqubit[2] q;\nbit[1] c;\n${text}`)
      expect(c.ops).toEqual([{ name: 'X', qubits: [1], condition: { bit: 0, value: 1 } }])
    }
    expect(fromQasm('qubit[2] q;\nbit[1] c;\nif (c[0] == false) { h q[0]; }').ops).toEqual([
      { name: 'H', qubits: [0], condition: { bit: 0, value: 0 } },
    ])
    expect(fromQasm('qubit[2] q;\nbit[1] c;\nif (c[0]==1) {}').ops).toEqual([])
  })
})
