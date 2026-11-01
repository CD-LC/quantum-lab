/**
 * quantum.measurement.test.ts — run() stays exact for the circuits people
 * actually build.
 *
 * The branch-memory and trajectory budgets once turned an ordinary 11-16 qubit
 * circuit that ends in "measure every qubit" into a ~27-trajectory estimate.
 * A measurement nothing reads again does not branch anything, so run() skips the
 * tree for it; these tests pin that, pin the equivalence with the old
 * enumeration, and pin that a genuine estimate says it is one.
 */

import { describe, expect, it } from 'vitest'
import {
  mulberry32,
  outcomeProbabilities,
  run,
  simulate,
  withoutTerminalMeasurements,
  type Circuit,
  type GateOp,
} from './quantum'

const measureAll = (n: number): GateOp[] =>
  Array.from({ length: n }, (_, q) => ({ name: 'MEASURE', qubits: [q], clbit: q }) as GateOp)

/** The same circuit with its measurements deleted: the ground truth for a terminal-measure circuit. */
const withoutMeasures = (c: Circuit): Circuit => ({ ...c, ops: c.ops.filter((o) => o.name !== 'MEASURE') })

function expectDistributionsClose(a: number[], b: number[], digits = 10) {
  expect(a).toHaveLength(b.length)
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], digits)
}

/** A Grover-flavoured circuit: superposition, a phase oracle, a diffusion layer, repeated. */
function groverLike(n: number, rounds: number): Circuit {
  const ops: GateOp[] = []
  for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] })
  for (let r = 0; r < rounds; r++) {
    for (let q = 0; q < n - 1; q++) ops.push({ name: 'CZ', qubits: [q, q + 1] })
    ops.push({ name: 'RZ', qubits: [r % n], theta: 0.37 + r })
    for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] })
    for (let q = 0; q < n; q++) ops.push({ name: 'X', qubits: [q] })
    ops.push({ name: 'CZ', qubits: [0, n - 1] })
    for (let q = 0; q < n; q++) ops.push({ name: 'X', qubits: [q] })
    for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] })
  }
  return { numQubits: n, ops }
}

describe('terminal measure-all is exact at every size', () => {
  it('16-qubit Grover-like circuit: exact probabilities, no estimate flag', () => {
    const body = groverLike(16, 2)
    const c: Circuit = { ...body, ops: [...body.ops, ...measureAll(16)] }
    const r = run(c, 2048, 0, 5)
    expect(r.approximate).toBeUndefined()
    expect(r.trajectories).toBeUndefined()
    expectDistributionsClose(r.probabilities, simulate(withoutMeasures(c)).probabilities(), 12)
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    expect(Object.values(r.counts).reduce((a, b) => a + b, 0)).toBe(2048)
  })

  it('16-qubit QFT with measure-all is exact and reproducible', () => {
    // The QFT block is at most 10 wide; the other six qubits sit in |+>.
    const register = Array.from({ length: 10 }, (_, q) => q)
    const c: Circuit = {
      numQubits: 16,
      ops: [
        { name: 'X', qubits: [3] },
        { name: 'X', qubits: [9] },
        ...[10, 11, 12, 13, 14, 15].map((q): GateOp => ({ name: 'H', qubits: [q] })),
        { name: 'QFT', qubits: register },
        ...measureAll(16),
      ],
    }
    const r = run(c, 1024, 0, 9)
    expect(r.approximate).toBeUndefined()
    expectDistributionsClose(r.probabilities, simulate(withoutMeasures(c)).probabilities(), 12)
    // The QFT of a basis state is uniform: every basis state at 2^-16.
    expect(r.probabilities[12345]).toBeCloseTo(1 / 65536, 12)
    // A uniform 16-qubit distribution fills the histogram: 27 spikes was the bug.
    expect(Object.keys(r.counts).length).toBeGreaterThan(900)
    expect(run(c, 1024, 0, 9).counts).toEqual(r.counts)
  })

  it('H on every qubit then measure-all gives a full histogram at 11, 12 and 16 qubits', () => {
    for (const n of [11, 12, 16]) {
      const ops: GateOp[] = []
      for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] })
      const r = run({ numQubits: n, ops: [...ops, ...measureAll(n)] }, 1024, 0, 1)
      expect(r.approximate).toBeUndefined()
      expect(r.probabilities[(1 << n) - 1]).toBeCloseTo(1 / 2 ** n, 12)
      const distinct = Object.keys(r.counts).length
      // Expected distinct outcomes in 1024 uniform draws over 2^n values.
      const expected = 2 ** n * (1 - Math.exp(-1024 / 2 ** n))
      expect(distinct).toBeGreaterThan(expected * 0.9)
    }
  })

  it('12-qubit circuit with measure-all matches the unitary simulation', () => {
    const body = groverLike(12, 3)
    const c: Circuit = { ...body, ops: [...body.ops, ...measureAll(12)] }
    const r = run(c, 4096, 0, 21)
    expect(r.approximate).toBeUndefined()
    expectDistributionsClose(r.probabilities, simulate(withoutMeasures(c)).probabilities(), 12)
  })

  it('measuring only some qubits at the end is exact too', () => {
    const c: Circuit = {
      numQubits: 13,
      ops: [
        { name: 'H', qubits: [0] },
        { name: 'CX', qubits: [0, 5] },
        { name: 'RY', qubits: [7], theta: 1.1 },
        { name: 'MEASURE', qubits: [0], clbit: 0 },
        { name: 'MEASURE', qubits: [7], clbit: 1 },
      ],
    }
    const r = run(c, 512, 0, 2)
    expect(r.approximate).toBeUndefined()
    expectDistributionsClose(r.probabilities, simulate(withoutMeasures(c)).probabilities(), 12)
  })
})

describe('equivalence with the old branch enumeration (6 qubits)', () => {
  /** A random 6-qubit circuit; `style` decides how its measurements are used. */
  function randomCircuit(seed: number, style: 'terminal' | 'midcircuit' | 'feedforward' | 'reset'): Circuit {
    const rng = mulberry32(seed)
    const n = 6
    const ops: GateOp[] = []
    const pick = (k: number) => Math.floor(rng() * k)
    const gate = () => {
      const kind = pick(6)
      const a = pick(n)
      let b = pick(n)
      if (b === a) b = (a + 1) % n
      if (kind === 0) ops.push({ name: 'H', qubits: [a] })
      else if (kind === 1) ops.push({ name: 'T', qubits: [a] })
      else if (kind === 2) ops.push({ name: 'RX', qubits: [a], theta: rng() * 6 })
      else if (kind === 3) ops.push({ name: 'CX', qubits: [a, b] })
      else if (kind === 4) ops.push({ name: 'CZ', qubits: [a, b] })
      else ops.push({ name: 'RY', qubits: [a], theta: rng() * 6 })
    }
    for (let i = 0; i < 14; i++) gate()
    if (style === 'midcircuit') {
      ops.push({ name: 'MEASURE', qubits: [1], clbit: 0 }, { name: 'MEASURE', qubits: [4], clbit: 1 })
      for (let i = 0; i < 8; i++) gate()
    } else if (style === 'feedforward') {
      ops.push({ name: 'MEASURE', qubits: [2], clbit: 0 })
      ops.push({ name: 'X', qubits: [3], condition: { bit: 0, value: 1 } })
      ops.push({ name: 'H', qubits: [5], condition: { bit: 0, value: 0 } })
      for (let i = 0; i < 6; i++) gate()
      ops.push({ name: 'MEASURE', qubits: [0], clbit: 1 })
      ops.push({ name: 'Z', qubits: [1], condition: { bit: 1, value: 1 } })
    } else if (style === 'reset') {
      ops.push({ name: 'RESET', qubits: [0] })
      for (let i = 0; i < 6; i++) gate()
      ops.push({ name: 'RESET', qubits: [3] })
    }
    // Measure-all at the end for every style: some of these are terminal, some are not.
    for (let q = 0; q < n; q++) ops.push({ name: 'MEASURE', qubits: [q], clbit: 2 + q })
    return { numQubits: n, ops }
  }

  for (const style of ['terminal', 'midcircuit', 'feedforward', 'reset'] as const) {
    it(`${style}: run() probabilities equal outcomeProbabilities()`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const c = randomCircuit(seed * 7919, style)
        const r = run(c, 64, 0, seed)
        expect(r.approximate).toBeUndefined()
        expectDistributionsClose(r.probabilities, outcomeProbabilities(c), 10)
      }
    })
  }

  it('a postselected circuit renormalises exactly as the enumeration does', () => {
    const c: Circuit = {
      numQubits: 3,
      ops: [
        { name: 'H', qubits: [0] },
        { name: 'H', qubits: [1] },
        { name: 'CX', qubits: [0, 2] },
        { name: 'MEASURE', qubits: [1], clbit: 0 },
        { name: 'POSTSELECT', qubits: [0], postselectValue: 1 },
        { name: 'H', qubits: [1] },
        { name: 'MEASURE', qubits: [0], clbit: 1 },
        { name: 'MEASURE', qubits: [2], clbit: 2 },
      ],
    }
    expectDistributionsClose(run(c, 32, 0, 1).probabilities, outcomeProbabilities(c), 12)
  })

  it('still throws one readable error when every postselection is impossible', () => {
    const c: Circuit = {
      numQubits: 2,
      ops: [
        { name: 'MEASURE', qubits: [1], clbit: 0 },
        { name: 'X', qubits: [1], condition: { bit: 0, value: 1 } },
        { name: 'POSTSELECT', qubits: [0], postselectValue: 1 },
      ],
    }
    expect(() => run(c, 16, 0, 1)).toThrow(/impossible/i)
  })
})

describe('withoutTerminalMeasurements', () => {
  const H0: GateOp = { name: 'H', qubits: [0] }

  it('returns the same circuit when nothing is terminal', () => {
    const c: Circuit = { numQubits: 2, ops: [H0, { name: 'MEASURE', qubits: [0], clbit: 0 }, H0] }
    expect(withoutTerminalMeasurements(c)).toBe(c)
  })

  it('drops a measurement nothing touches afterwards, even with a barrier after it', () => {
    const c: Circuit = {
      numQubits: 2,
      ops: [H0, { name: 'MEASURE', qubits: [0], clbit: 0 }, { name: 'BARRIER', qubits: [] }, { name: 'X', qubits: [1] }],
    }
    expect(withoutTerminalMeasurements(c).ops.map((o) => o.name)).toEqual(['H', 'BARRIER', 'X'])
  })

  it('keeps a measurement whose qubit is used again, including as an extra control', () => {
    const c: Circuit = {
      numQubits: 2,
      ops: [
        H0,
        { name: 'MEASURE', qubits: [0], clbit: 0 },
        { name: 'X', qubits: [1], extraControls: [{ qubit: 0 }] },
      ],
    }
    expect(withoutTerminalMeasurements(c)).toBe(c)
  })

  it('keeps a measurement whose bit a later gate reads, and one before a RESET', () => {
    const fed: Circuit = {
      numQubits: 2,
      ops: [H0, { name: 'MEASURE', qubits: [0], clbit: 0 }, { name: 'X', qubits: [1], condition: { bit: 0, value: 1 } }],
    }
    expect(withoutTerminalMeasurements(fed)).toBe(fed)
    const reset: Circuit = { numQubits: 1, ops: [H0, { name: 'MEASURE', qubits: [0], clbit: 0 }, { name: 'RESET', qubits: [0] }] }
    expect(withoutTerminalMeasurements(reset)).toBe(reset)
  })

  it('drops a chain of terminal measurements on one qubit', () => {
    const c: Circuit = {
      numQubits: 1,
      ops: [H0, { name: 'MEASURE', qubits: [0], clbit: 0 }, { name: 'MEASURE', qubits: [0], clbit: 1 }],
    }
    expect(withoutTerminalMeasurements(c).ops).toEqual([H0])
  })
})

describe('mid-circuit measurement: exact as far as it fits, a flagged estimate beyond', () => {
  /** H then measure q0, `rounds` times, then one more H: every measurement forks. */
  function repeatedMeasure(n: number, rounds: number): Circuit {
    const ops: GateOp[] = []
    for (let i = 0; i < rounds; i++) {
      ops.push({ name: 'H', qubits: [0] }, { name: 'MEASURE', qubits: [0], clbit: i })
    }
    ops.push({ name: 'H', qubits: [0] })
    return { numQubits: n, ops, numClbits: rounds }
  }

  it('12 qubits and 10 forking mid-circuit measurements is exact (it was a 512-branch cut-off)', () => {
    const r = run(repeatedMeasure(12, 10), 256, 0, 3)
    expect(r.approximate).toBeUndefined()
    expect(r.probabilities[0]).toBeCloseTo(0.5, 12)
    expect(r.probabilities[1]).toBeCloseTo(0.5, 12)
  })

  it('16 qubits with five forking mid-circuit measurements is exact', () => {
    const r = run(repeatedMeasure(16, 5), 256, 0, 3)
    expect(r.approximate).toBeUndefined()
    expect(r.probabilities[0]).toBeCloseTo(0.5, 12)
    expect(r.probabilities[1]).toBeCloseTo(0.5, 12)
  })

  it('more measurement than can be enumerated is an estimate, and says so', () => {
    const r = run(repeatedMeasure(1, 14), 512, 0, 3)
    expect(r.approximate).toBe(true)
    expect(r.trajectories).toBeGreaterThanOrEqual(256)
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    // Still the right shape, which one trajectory would not be.
    expect(r.probabilities[0]).toBeGreaterThan(0.3)
    expect(r.probabilities[1]).toBeGreaterThan(0.3)
  })
})
