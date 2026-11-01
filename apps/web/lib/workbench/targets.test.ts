/**
 * targets.test.ts — the noise model against closed-form rates, the target
 * parser, and the hardware adapter's auth boundary.
 *
 * Every tolerance below is stated as a multiple of the binomial σ at the shot
 * count used, so a failure means broken physics or a broken sampler, not bad
 * luck: at 4096 shots, ±6σ of a p≈0.1 rate is about ±115 counts.
 */

import { describe, expect, it } from 'vitest'
import { fromQasm } from '@/lib/quantum'
import {
  DEFAULT_NOISE,
  MAX_NOISY_WORK,
  MAX_PERSISTED_AMPLITUDES,
  describeTarget,
  parseTarget,
  runNoisy,
  runOnTarget,
  type HardwareSubmitter,
} from './targets'

const HEADER = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'
const X_ON_ZERO = HEADER + 'qubit[1] q;\nx q[0];'
const IDLE_H_H = HEADER + 'qubit[1] q;\nh q[0];\nh q[0];' // identity, two gates
const BELL = HEADER + 'qubit[2] q;\nh q[0];\ncx q[0], q[1];'
const SHOTS = 4096

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

/** Binomial standard deviation at n shots and probability p. */
const sigma = (n: number, p: number) => Math.sqrt(n * p * (1 - p))

describe('runNoisy — closed-form error rates', () => {
  it('readout error r on |0⟩ reads 1 with probability r (no gates, no gate noise)', () => {
    const circuit = fromQasm(IDLE_H_H)
    const r = 0.1
    const out = runNoisy(circuit, SHOTS, { depolarizing1: 0, depolarizing2: 0, readoutError: r }, 7)
    expect(total(out.counts)).toBe(SHOTS)
    expect(out.erroredShots).toBe(0)
    const ones = out.counts['1'] ?? 0
    const expected = SHOTS * r
    expect(Math.abs(ones - expected)).toBeLessThan(6 * sigma(SHOTS, r))
  })

  it('single-qubit depolarising p after X gives P(0) = p/2', () => {
    // After X the qubit is |1⟩. With probability p it is replaced by the
    // maximally mixed state, which reads 0 half the time: P(0) = p/2 exactly.
    const circuit = fromQasm(X_ON_ZERO)
    const p = 0.2
    const out = runNoisy(circuit, SHOTS, { depolarizing1: p, depolarizing2: 0, readoutError: 0 }, 11)
    const zeros = out.counts['0'] ?? 0
    const expected = SHOTS * (p / 2)
    expect(Math.abs(zeros - expected)).toBeLessThan(6 * sigma(SHOTS, p / 2))
    // Shots that suffered an error: P = 3p/4 (the I branch fires no error op).
    expect(Math.abs(out.erroredShots - SHOTS * 0.75 * p)).toBeLessThan(6 * sigma(SHOTS, 0.75 * p))
  })

  it('two-qubit depolarising p2 on the Bell CX gives P(odd parity) = p2/2', () => {
    // The ideal Bell pair never reads 01 or 10. A two-qubit depolarising
    // event replaces the pair by I/4, which has odd parity half the time.
    const circuit = fromQasm(BELL)
    const p2 = 0.3
    const out = runNoisy(circuit, SHOTS, { depolarizing1: 0, depolarizing2: p2, readoutError: 0 }, 5)
    const odd = (out.counts['01'] ?? 0) + (out.counts['10'] ?? 0)
    const expected = SHOTS * (p2 / 2)
    expect(Math.abs(odd - expected)).toBeLessThan(6 * sigma(SHOTS, p2 / 2))
    // Even-parity outcomes stay balanced: the channel is symmetric in 00/11.
    const even00 = out.counts['00'] ?? 0
    const even11 = out.counts['11'] ?? 0
    expect(Math.abs(even00 - even11)).toBeLessThan(6 * sigma(SHOTS, 0.5))
  })

  it('zero noise reproduces the ideal distribution exactly in support', () => {
    const circuit = fromQasm(BELL)
    const out = runNoisy(circuit, 2048, { depolarizing1: 0, depolarizing2: 0, readoutError: 0 }, 3)
    expect(Object.keys(out.counts).sort()).toEqual(['00', '11'])
    expect(out.erroredShots).toBe(0)
  })

  it('is deterministic under a seed and differs across seeds', () => {
    const circuit = fromQasm(BELL)
    const a = runNoisy(circuit, 512, DEFAULT_NOISE, 42)
    const b = runNoisy(circuit, 512, DEFAULT_NOISE, 42)
    const c = runNoisy(circuit, 512, DEFAULT_NOISE, 43)
    expect(a).toEqual(b)
    expect(a.counts).not.toEqual(c.counts)
  })

  it('handles a circuit with recorded measurements (every shot is a trajectory)', () => {
    const circuit = fromQasm(HEADER + 'qubit[2] q;\nbit[2] c;\nh q[0];\ncx q[0], q[1];\nc = measure q;')
    const out = runNoisy(circuit, 1024, { depolarizing1: 0, depolarizing2: 0, readoutError: 0 }, 9)
    expect(Object.keys(out.counts).sort()).toEqual(['00', '11'])
    expect(total(out.counts)).toBe(1024)
  })
})

describe('parseTarget', () => {
  it('accepts a bare kind string and fills noise defaults', () => {
    expect(parseTarget('simulator')).toEqual({ ok: true, value: { kind: 'simulator' } })
    const noisy = parseTarget({ kind: 'noisy-simulator' })
    expect(noisy).toEqual({ ok: true, value: { kind: 'noisy-simulator', noise: DEFAULT_NOISE } })
  })

  it('accepts flat and nested noise parameters', () => {
    const flat = parseTarget({ kind: 'noisy-simulator', readoutError: 0.1 })
    const nested = parseTarget({ kind: 'noisy-simulator', noise: { readoutError: 0.1 } })
    expect(flat).toEqual(nested)
    if (flat.ok && flat.value.kind === 'noisy-simulator') {
      expect(flat.value.noise.readoutError).toBe(0.1)
      expect(flat.value.noise.depolarizing1).toBe(DEFAULT_NOISE.depolarizing1)
    }
  })

  it('refuses out-of-range noise rather than clamping it', () => {
    expect(parseTarget({ kind: 'noisy-simulator', readoutError: 0.7 }).ok).toBe(false)
    expect(parseTarget({ kind: 'noisy-simulator', depolarizing2: -0.1 }).ok).toBe(false)
    expect(parseTarget({ kind: 'noisy-simulator', depolarizing1: Number.NaN }).ok).toBe(false)
  })

  it('refuses unknown kinds and hardware without a backend', () => {
    expect(parseTarget('gpu').ok).toBe(false)
    expect(parseTarget({ kind: 'hardware' }).ok).toBe(false)
    expect(parseTarget({ kind: 'hardware', backend: 'ibm_brisbane', provider: 'rigetti' }).ok).toBe(false)
    expect(parseTarget({ kind: 'hardware', backend: 'ibm_brisbane', provider: 'ibm' })).toEqual({
      ok: true,
      value: { kind: 'hardware', backend: 'ibm_brisbane', provider: 'ibm' },
    })
  })

  it('describes each target in one readable line', () => {
    expect(describeTarget({ kind: 'simulator' })).toBe('ideal simulator')
    expect(describeTarget({ kind: 'noisy-simulator', noise: DEFAULT_NOISE })).toBe(
      'noisy simulator (1q 0.1%, 2q 1%, readout 2%)',
    )
    expect(describeTarget({ kind: 'hardware', backend: 'ibm_brisbane', provider: 'ibm' })).toBe(
      'hardware · ibm_brisbane (ibm)',
    )
  })
})

describe('runOnTarget', () => {
  it('ideal simulator returns counts, amplitudes and the qubit ceiling message', async () => {
    const ran = await runOnTarget(BELL, { kind: 'simulator' }, { shots: 4096, seed: 42 })
    expect(ran.ok).toBe(true)
    if (!ran.ok || ran.result.kind !== 'counts') throw new Error('expected counts')
    expect(Object.keys(ran.result.counts).sort()).toEqual(['00', '11'])
    expect(ran.result.statevector?.map((a) => a.state).sort()).toEqual(['00', '11'])
    expect(ran.result.statevector?.[0].re).toBeCloseTo(Math.SQRT1_2, 12)

    const wide = await runOnTarget(HEADER + 'qubit[17] q;\nh q[0];', { kind: 'simulator' })
    expect(wide.ok).toBe(false)
    if (!wide.ok) expect(wide.error).toContain('ceiling is 16')
  })

  it('the noisy target has a lower qubit ceiling and reports errored shots', async () => {
    const wide = await runOnTarget(HEADER + 'qubit[11] q;\nh q[0];', { kind: 'noisy-simulator', noise: DEFAULT_NOISE })
    expect(wide.ok).toBe(false)
    if (!wide.ok) expect(wide.error).toContain('ceiling is 10')

    const ran = await runOnTarget(BELL, { kind: 'noisy-simulator', noise: { ...DEFAULT_NOISE, depolarizing2: 0.5 } }, { shots: 1024, seed: 1 })
    if (!ran.ok || ran.result.kind !== 'counts') throw new Error('expected counts')
    expect(ran.result.erroredShots).toBeGreaterThan(300)
    expect(ran.result.statevector).toBeUndefined()
  })

  it('refuses text that is not QASM and clamps shots', async () => {
    const junk = await runOnTarget('hello world', { kind: 'simulator' })
    expect(junk.ok).toBe(false)
    const many = await runOnTarget(BELL, { kind: 'simulator' }, { shots: 1_000_000, seed: 1 })
    if (!many.ok) throw new Error(many.error)
    expect(many.result.shots).toBe(4096)
  })

  it('hardware: refuses without a bearer token and never calls the submitter', async () => {
    let calls = 0
    const fake: HardwareSubmitter = async () => {
      calls += 1
      return { status: 200, payload: { job_id: 'x' } }
    }
    for (const authorization of [undefined, null, '', 'Bearer', 'Basic abc']) {
      const ran = await runOnTarget(BELL, { kind: 'hardware', backend: 'ibm_brisbane' }, { authorization, hardware: fake })
      expect(ran.ok).toBe(false)
      if (!ran.ok) expect(ran.error).toContain('Authorization: Bearer')
    }
    expect(calls).toBe(0)
  })

  it('hardware: forwards the token, records the job on 2xx and surfaces the refusal otherwise', async () => {
    const seen: unknown[] = []
    const accept: HardwareSubmitter = async (s) => {
      seen.push(s)
      return { status: 202, payload: { job_id: 'job-1', provider: 'ibm' } }
    }
    const ran = await runOnTarget(
      BELL,
      { kind: 'hardware', backend: 'ibm_brisbane', provider: 'ibm' },
      { authorization: 'Bearer tok', shots: 100, hardware: accept, forwardedFor: '10.0.0.1' },
    )
    expect(ran.ok).toBe(true)
    if (!ran.ok || ran.result.kind !== 'hardware-job') throw new Error('expected a job')
    expect(ran.result).toMatchObject({ backend: 'ibm_brisbane', provider: 'ibm', shots: 100, status: 202 })
    expect(ran.result.job).toEqual({ job_id: 'job-1', provider: 'ibm' })
    expect(seen[0]).toMatchObject({ authorization: 'Bearer tok', backend: 'ibm_brisbane', shots: 100, forwardedFor: '10.0.0.1' })

    const refuse: HardwareSubmitter = async () => ({ status: 402, payload: { detail: 'Plan lacks hardware.real' } })
    const refused = await runOnTarget(BELL, { kind: 'hardware', backend: 'ibm_brisbane' }, { authorization: 'Bearer tok', hardware: refuse })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toBe('Hardware submission refused (HTTP 402): Plan lacks hardware.real')
  })
})

describe('runOnTarget — bounded output and work', () => {
  const wide = (n: number) => HEADER + `qubit[${n}] q;\n` + Array.from({ length: n }, (_, i) => `h q[${i}];`).join('\n')

  it('caps the persisted statevector: a 16-qubit uniform state keeps the largest amplitudes and says how many it dropped', async () => {
    const ran = await runOnTarget(wide(16), { kind: 'simulator' }, { shots: 16, seed: 1 })
    expect(ran.ok).toBe(true)
    if (!ran.ok || ran.result.kind !== 'counts') return
    expect(ran.result.statevector).toHaveLength(MAX_PERSISTED_AMPLITUDES)
    expect(ran.result.statevectorOmitted).toBe(65_536 - MAX_PERSISTED_AMPLITUDES)
    expect(JSON.stringify(ran.result).length).toBeLessThan(100_000)
    const states = ran.result.statevector!.map((a) => a.state)
    expect([...states].sort()).toEqual(states) // basis order
  })

  it('leaves a small state whole and adds no omitted marker', async () => {
    const small = await runOnTarget(BELL, { kind: 'simulator' }, { shots: 8, seed: 1 })
    if (small.ok && small.result.kind === 'counts') {
      expect(small.result.statevectorOmitted).toBeUndefined()
      expect(small.result.statevector).toHaveLength(2)
    }
  })

  it('refuses a noisy run whose worst case would hold the event loop, and says how many shots would fit', async () => {
    const lines = Array.from({ length: 400 }, () => 'h q[0];').join('\n')
    const qasm = HEADER + 'qubit[10] q;\n' + lines
    const ran = await runOnTarget(qasm, { kind: 'noisy-simulator', noise: DEFAULT_NOISE }, { shots: 4096 })
    expect(ran.ok).toBe(false)
    if (!ran.ok) expect(ran.error).toMatch(/too large.*at most \d+ shots/s)
    expect(4096 * 400 * 2 ** 10).toBeGreaterThan(MAX_NOISY_WORK)
  })
})
