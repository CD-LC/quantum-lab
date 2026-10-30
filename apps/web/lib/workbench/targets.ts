/**
 * lib/workbench/targets.ts — WHERE a circuit runs, as data.
 *
 * An experiment step names its target the way a lab notebook names the
 * apparatus: "ideal simulator", "simulator with these error rates", or "this
 * device". The three kinds share one entry point, `runOnTarget`, so the
 * experiment tools never branch on the target themselves and the record of a
 * step carries the exact parameters it ran with.
 *
 *   simulator        `run()` from lib/quantum.ts. Exact statevector, sampled
 *                    counts, deterministic under a seed.
 *   noisy-simulator  A stochastic Pauli-error model layered on the same
 *                    engine (see `runNoisy` below). Parameterised, seeded,
 *                    and tested against the closed-form error rates it
 *                    should reproduce.
 *   hardware         A pass-through to the existing /api/hardware/submit
 *                    route with the caller's bearer token attached — the
 *                    same code path `submit_hardware_job` uses, so every gate
 *                    that route enforces (identity, plan, quota, rate limit)
 *                    runs unchanged. The submission is injected as an adapter
 *                    (lib/workbench/hardwareSubmitter.ts in production, a
 *                    scripted fake in tests) so nothing in this module ever
 *                    opens a socket — and so the page can import the
 *                    simulator targets into the browser bundle.
 *
 * ── The noise model, precisely ────────────────────────────────────────────
 *
 * After every gate that acts on one qubit, that qubit is depolarised with
 * probability p1: with probability p1 the state is replaced by the maximally
 * mixed state, which in a trajectory unravelling means applying X, Y or Z with
 * probability p1/4 each (and nothing with probability 1 − 3p1/4). After a
 * two-qubit gate each of the 15 non-identity two-qubit Paulis is applied with
 * probability p2/16. Readout: each measured bit is flipped independently with
 * probability r. These are the three numbers a device calibration sheet leads
 * with, and they produce the rates the tests check:
 *
 *   |0⟩ → X → measure, depolarising p1:      P(0) = p1/2
 *   |0⟩, readout error r:                    P(1) = r
 *   Bell pair, two-qubit depolarising p2:    P(odd parity) = p2/2
 *
 * It is a model, not a device: no T1/T2 decay, no crosstalk, no leakage, no
 * correlated readout error. It is honest enough to make "is this circuit
 * fragile?" a question an agent can ask overnight.
 */

import {
  execute,
  fromQasm,
  hasClassicalControl,
  mulberry32,
  run,
  simulate,
  type Circuit,
  type GateName,
  type GateOp,
} from '@/lib/quantum'
import { reportError } from '@/lib/observability/report'

// ────────────────────────────────────────────────────────────
// Target shapes
// ────────────────────────────────────────────────────────────

export const TARGET_KINDS = ['simulator', 'noisy-simulator', 'hardware'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export const HARDWARE_PROVIDERS = ['ibm', 'braket'] as const
export type HardwareProvider = (typeof HARDWARE_PROVIDERS)[number]

export interface NoiseParams {
  /** Depolarising probability after every single-qubit gate, 0–1. */
  depolarizing1: number
  /** Depolarising probability after every two- or three-qubit gate, 0–1. */
  depolarizing2: number
  /** Probability each measured bit is read back flipped, 0–0.5. */
  readoutError: number
}

/**
 * Round numbers in the range a 2024-era superconducting device reports:
 * ~0.1 % single-qubit, ~1 % two-qubit, ~2 % readout.
 */
export const DEFAULT_NOISE: NoiseParams = {
  depolarizing1: 0.001,
  depolarizing2: 0.01,
  readoutError: 0.02,
}

export type Target =
  | { kind: 'simulator' }
  | { kind: 'noisy-simulator'; noise: NoiseParams }
  | { kind: 'hardware'; backend: string; provider?: HardwareProvider }

/** Register ceilings per target. The noisy model simulates one trajectory per
 *  shot that suffered an error, so its ceiling is lower than the ideal one. */
export const MAX_QUBITS_SIMULATOR = 16
export const MAX_QUBITS_NOISY = 10
export const MAX_SHOTS = 4096
export const DEFAULT_SHOTS = 1024
export const MAX_QASM_CHARS = 20_000
export const MAX_BACKEND_CHARS = 64

/** One line a human reads in the record: "noisy simulator (p1 0.1%, p2 1%, readout 2%)". */
export function describeTarget(target: Target): string {
  switch (target.kind) {
    case 'simulator':
      return 'ideal simulator'
    case 'noisy-simulator': {
      const pct = (x: number) => `${(x * 100).toPrecision(2).replace(/\.?0+$/, '')}%`
      const n = target.noise
      return `noisy simulator (1q ${pct(n.depolarizing1)}, 2q ${pct(n.depolarizing2)}, readout ${pct(n.readoutError)})`
    }
    case 'hardware':
      return `hardware · ${target.backend}${target.provider ? ` (${target.provider})` : ''}`
  }
}

// ────────────────────────────────────────────────────────────
// Parsing an untrusted target
// ────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function probability(v: unknown, max: number, fallback: number, label: string): ParseResult<number> {
  if (v === undefined || v === null) return { ok: true, value: fallback }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${label} must be a finite number.` }
  if (v < 0 || v > max) return { ok: false, error: `${label} must be between 0 and ${max}.` }
  return { ok: true, value: v }
}

/**
 * Coerce a caller-supplied target description into a Target. Accepts either a
 * bare kind string ("simulator") or an object { kind, ...params }. Unknown
 * fields are dropped; out-of-range noise is refused, not clamped, because an
 * experiment record with silently altered parameters is worse than no record.
 */
export function parseTarget(input: unknown): ParseResult<Target> {
  const record: Record<string, unknown> =
    typeof input === 'string' ? { kind: input } : isRecord(input) ? input : {}
  const kind = record.kind
  if (typeof kind !== 'string' || !(TARGET_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `target.kind must be one of: ${TARGET_KINDS.join(', ')}.` }
  }
  if (kind === 'simulator') return { ok: true, value: { kind: 'simulator' } }

  if (kind === 'noisy-simulator') {
    const noiseIn = isRecord(record.noise) ? record.noise : record
    const p1 = probability(noiseIn.depolarizing1, 1, DEFAULT_NOISE.depolarizing1, 'target.depolarizing1')
    if (!p1.ok) return p1
    const p2 = probability(noiseIn.depolarizing2, 1, DEFAULT_NOISE.depolarizing2, 'target.depolarizing2')
    if (!p2.ok) return p2
    const r = probability(noiseIn.readoutError, 0.5, DEFAULT_NOISE.readoutError, 'target.readoutError')
    if (!r.ok) return r
    return {
      ok: true,
      value: {
        kind: 'noisy-simulator',
        noise: { depolarizing1: p1.value, depolarizing2: p2.value, readoutError: r.value },
      },
    }
  }

  // hardware
  const backend = typeof record.backend === 'string' ? record.backend.trim() : ''
  if (backend.length === 0 || backend.length > MAX_BACKEND_CHARS) {
    return { ok: false, error: 'target.backend must name a device id, e.g. "ibm_brisbane".' }
  }
  let provider: HardwareProvider | undefined
  if (record.provider !== undefined) {
    if (
      typeof record.provider !== 'string' ||
      !(HARDWARE_PROVIDERS as readonly string[]).includes(record.provider)
    ) {
      return { ok: false, error: `target.provider must be one of: ${HARDWARE_PROVIDERS.join(', ')}.` }
    }
    provider = record.provider as HardwareProvider
  }
  return { ok: true, value: provider ? { kind: 'hardware', backend, provider } : { kind: 'hardware', backend } }
}

// ────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────

export interface AmplitudeEntry {
  state: string
  re: number
  im: number
  probability: number
}

export type StepResult =
  | {
      kind: 'counts'
      counts: Record<string, number>
      shots: number
      numQubits: number
      gateCount: number
      /** Ideal simulator only: the final statevector, near-zero entries dropped. */
      statevector?: AmplitudeEntry[]
      /**
       * Ideal simulator only: how many non-negligible amplitudes were left out
       * of `statevector` because it is capped at MAX_PERSISTED_AMPLITUDES (the
       * largest by probability are the ones kept). Absent when nothing was cut.
       */
      statevectorOmitted?: number
      /** Noisy simulator only: how many shots suffered at least one gate error. */
      erroredShots?: number
    }
  | {
      kind: 'hardware-job'
      backend: string
      provider: HardwareProvider | null
      shots: number
      /** HTTP status the submit route answered with (2xx). */
      status: number
      /** The route's JSON body — job id, provider handle, queue position. */
      job: Record<string, unknown> | null
    }

const AMPLITUDE_FLOOR = 1e-10

/**
 * The most amplitudes a step keeps. A step is persisted (jsonb) and returned in
 * full to whoever reads the record; a 16-qubit uniform state has 65,536 of
 * them, ~6.5 MB of JSON from a 400-byte request. The record is a lab notebook,
 * not a state dump: the 256 largest amplitudes carry every circuit a person
 * reads by eye, and `counts` carries the rest. run_circuit /
 * get_statevector_at_step are the tools for a full state.
 */
export const MAX_PERSISTED_AMPLITUDES = 256

/**
 * Ceiling on the noisy simulator's worst-case work, in (shots x gates x
 * amplitudes). With the default error rates nearly every shot of a long
 * circuit re-runs the whole circuit, so cost is shots x gates x 2^qubits
 * sweeps: measured at ~2.7 ns each, 4e9 of them held the event loop for 11 s.
 * 4e8 is about a second, which no teaching circuit approaches (10 qubits, 100
 * gates, 4096 shots is exactly that).
 */
export const MAX_NOISY_WORK = 4e8

// ────────────────────────────────────────────────────────────
// Noisy simulation
// ────────────────────────────────────────────────────────────

const SINGLE_PAULIS: GateName[] = ['X', 'Y', 'Z']
/** The 15 non-identity two-qubit Paulis as (first, second) with 'I' = none. */
type PauliLetter = 'I' | 'X' | 'Y' | 'Z'
const TWO_QUBIT_PAULIS: [PauliLetter, PauliLetter][] = []
for (const a of ['I', 'X', 'Y', 'Z'] as const) {
  for (const b of ['I', 'X', 'Y', 'Z'] as const) {
    if (a === 'I' && b === 'I') continue
    TWO_QUBIT_PAULIS.push([a, b])
  }
}

/** Sample the error ops that follow one gate, or [] when no error fires. */
function sampleErrors(op: GateOp, noise: NoiseParams, rng: () => number): GateOp[] {
  if (op.name === 'MEASURE' || op.name === 'BARRIER') return []
  const carry = op.condition ? { condition: op.condition } : {}
  if (op.qubits.length === 1) {
    // P(any Pauli) = 3p/4; pick uniformly among the three.
    if (rng() >= (3 * noise.depolarizing1) / 4) return []
    const pauli = SINGLE_PAULIS[Math.floor(rng() * 3)]
    return [{ name: pauli, qubits: [op.qubits[0]], ...carry }]
  }
  // Two-qubit depolarising on the first two qubits of the gate. CCX gets the
  // same channel on its (control, target) pair — a crude but bounded stand-in
  // for a gate that compiles to several two-qubit gates on real hardware.
  if (rng() >= (15 * noise.depolarizing2) / 16) return []
  const [a, b] = TWO_QUBIT_PAULIS[Math.floor(rng() * 15)]
  const ops: GateOp[] = []
  const pair = op.name === 'CCX' ? [op.qubits[0], op.qubits[2]] : [op.qubits[0], op.qubits[1]]
  if (a !== 'I') ops.push({ name: a, qubits: [pair[0]], ...carry })
  if (b !== 'I') ops.push({ name: b, qubits: [pair[1]], ...carry })
  return ops
}

/** Inverse-transform sample of a basis-state index from a CDF. */
function sampleIndex(cdf: number[], u: number): number {
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] < u) lo = mid + 1
    else hi = mid
  }
  return lo
}

function cumulative(probs: number[]): { cdf: number[]; total: number } {
  const cdf: number[] = []
  let acc = 0
  for (const p of probs) {
    acc += p
    cdf.push(acc)
  }
  return { cdf, total: acc }
}

export interface NoisyRunResult {
  counts: Record<string, number>
  shots: number
  erroredShots: number
}

/**
 * Sample `shots` measurement outcomes under the Pauli-error model described in
 * the header. One trajectory is simulated per shot in which at least one gate
 * error fired; shots with no gate error reuse the ideal final distribution
 * (exact, since the trajectory is then the ideal circuit) unless the circuit
 * carries classical control, in which case every shot is a fresh trajectory.
 */
export function runNoisy(
  circuit: Circuit,
  shots: number,
  noise: NoiseParams,
  seed?: number,
): NoisyRunResult {
  const rng = seed === undefined ? Math.random : mulberry32(seed)
  const classical = hasClassicalControl(circuit)
  const clean = classical ? null : cumulative(simulate(circuit).probabilities())
  const labelOf = (idx: number) => idx.toString(2).padStart(circuit.numQubits, '0')

  const counts: Record<string, number> = {}
  let erroredShots = 0

  for (let s = 0; s < shots; s++) {
    const noisyOps: GateOp[] = []
    let errored = false
    for (const op of circuit.ops) {
      noisyOps.push(op)
      const errors = sampleErrors(op, noise, rng)
      if (errors.length > 0) {
        errored = true
        noisyOps.push(...errors)
      }
    }
    if (errored) erroredShots += 1

    let idx: number
    if (!errored && clean) {
      idx = sampleIndex(clean.cdf, rng() * clean.total)
    } else {
      const state = execute({ ...circuit, ops: noisyOps }, { rng }).state
      const dist = cumulative(state.probabilities())
      idx = sampleIndex(dist.cdf, rng() * dist.total)
    }

    if (noise.readoutError > 0) {
      for (let q = 0; q < circuit.numQubits; q++) {
        if (rng() < noise.readoutError) idx ^= 1 << q
      }
    }
    const key = labelOf(idx)
    counts[key] = (counts[key] ?? 0) + 1
  }

  return { counts, shots, erroredShots }
}

// ────────────────────────────────────────────────────────────
// Hardware adapter
// ────────────────────────────────────────────────────────────

export interface HardwareSubmission {
  qasm: string
  backend: string
  provider?: HardwareProvider
  shots: number
  /** Verbatim Authorization header of the calling request. */
  authorization: string
  forwardedFor?: string | null
}

export interface HardwareSubmitOutcome {
  status: number
  payload: Record<string, unknown> | null
}

/** Anything that can present a submission to the hardware gate chain. */
export type HardwareSubmitter = (submission: HardwareSubmission) => Promise<HardwareSubmitOutcome>

// ────────────────────────────────────────────────────────────
// The one entry point
// ────────────────────────────────────────────────────────────

export interface RunOnTargetOptions {
  shots?: number
  seed?: number
  /** Required for the hardware target; ignored otherwise. */
  authorization?: string | null
  forwardedFor?: string | null
  /**
   * Who presents a hardware submission. The real one lives in
   * lib/workbench/hardwareSubmitter.ts (server only); tests pass a scripted
   * fake. With none supplied, a hardware step is refused — this module is
   * imported by the browser bundle and must never reach the billing stack.
   */
  hardware?: HardwareSubmitter
}

export type RunOnTargetResult = { ok: true; result: StepResult } | { ok: false; error: string }

/** Clamp an arbitrary value into an integer in [min, max], with a default. */
export function clampShots(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SHOTS
  return Math.min(MAX_SHOTS, Math.max(1, Math.floor(value)))
}

/**
 * Parse the QASM, check the register against the target's ceiling, and run.
 * Never throws for caller-shaped input: every refusal is a message naming what
 * to change. A hardware refusal is returned verbatim from the route's own
 * error body, so the agent sees the same words the web app would show.
 */
export async function runOnTarget(
  qasm: string,
  target: Target,
  options: RunOnTargetOptions = {},
): Promise<RunOnTargetResult> {
  if (typeof qasm !== 'string' || qasm.trim().length === 0) {
    return { ok: false, error: 'qasm must be a non-empty OpenQASM 3 string.' }
  }
  if (qasm.length > MAX_QASM_CHARS) {
    return { ok: false, error: `qasm must be at most ${MAX_QASM_CHARS} characters.` }
  }
  const shots = clampShots(options.shots)
  const seed =
    typeof options.seed === 'number' && Number.isInteger(options.seed) ? options.seed : undefined

  if (target.kind === 'hardware') {
    const authorization = options.authorization ?? null
    if (!authorization || !/^bearer\s+\S+/i.test(authorization)) {
      return {
        ok: false,
        error:
          'The hardware target requires authentication: connect to this MCP server with an ' +
          '"Authorization: Bearer <supabase access token>" header for a Qubit16 account on a ' +
          'plan that includes hardware.real. Nothing was submitted and no step was recorded.',
      }
    }
    const submit = options.hardware
    if (!submit) {
      return { ok: false, error: 'The hardware target is not available on this surface.' }
    }
    const outcome = await submit({
      qasm,
      backend: target.backend,
      provider: target.provider,
      shots,
      authorization,
      forwardedFor: options.forwardedFor ?? null,
    })
    if (outcome.status >= 200 && outcome.status < 300) {
      return {
        ok: true,
        result: {
          kind: 'hardware-job',
          backend: target.backend,
          provider: target.provider ?? null,
          shots,
          status: outcome.status,
          job: outcome.payload,
        },
      }
    }
    const p = outcome.payload
    const detail =
      (p && typeof p.detail === 'string' && p.detail) ||
      (p && typeof p.error === 'string' && p.error) ||
      'Submission refused.'
    return { ok: false, error: `Hardware submission refused (HTTP ${outcome.status}): ${detail}` }
  }

  const circuit = fromQasm(qasm)
  if (circuit.ops.length === 0) {
    return {
      ok: false,
      error:
        'No gates could be parsed from that input. Expected OpenQASM 3, e.g.:\n' +
        'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];',
    }
  }
  const ceiling = target.kind === 'simulator' ? MAX_QUBITS_SIMULATOR : MAX_QUBITS_NOISY
  if (circuit.numQubits > ceiling) {
    return {
      ok: false,
      error:
        `This circuit uses ${circuit.numQubits} qubits; the ${describeTarget(target)} ceiling is ` +
        `${ceiling}. Reduce the register (qubit[${ceiling}] q; at most).`,
    }
  }

  if (target.kind === 'noisy-simulator') {
    const work = shots * circuit.ops.length * 2 ** circuit.numQubits
    if (work > MAX_NOISY_WORK) {
      const affordable = Math.max(1, Math.floor(MAX_NOISY_WORK / (circuit.ops.length * 2 ** circuit.numQubits)))
      return {
        ok: false,
        error:
          `This noisy run is too large (${shots} shots x ${circuit.ops.length} gates on ${circuit.numQubits} qubits). ` +
          (affordable < shots
            ? `Use at most ${affordable} shots for this circuit, or a shorter or narrower circuit.`
            : 'Use a shorter or narrower circuit.'),
      }
    }
  }

  try {
    if (target.kind === 'simulator') {
      const out = run(circuit, shots, 0, seed)
      let statevector: AmplitudeEntry[] = []
      const kept: { index: number; probability: number }[] = []
      for (let i = 0; i < out.statevector.length; i++) {
        const probability = out.probabilities[i]
        if (Math.sqrt(probability) < AMPLITUDE_FLOOR) continue
        kept.push({ index: i, probability })
      }
      const omitted = Math.max(0, kept.length - MAX_PERSISTED_AMPLITUDES)
      // Keep the largest by probability (ties by basis index), shown in basis order.
      const chosen =
        omitted > 0
          ? kept
              .sort((a, b) => b.probability - a.probability || a.index - b.index)
              .slice(0, MAX_PERSISTED_AMPLITUDES)
              .sort((a, b) => a.index - b.index)
          : kept
      statevector = chosen.map(({ index, probability }) => ({
        state: out.labels[index],
        re: out.statevector[index].re,
        im: out.statevector[index].im,
        probability,
      }))
      return {
        ok: true,
        result: {
          kind: 'counts',
          counts: out.counts,
          shots,
          numQubits: circuit.numQubits,
          gateCount: circuit.ops.length,
          statevector,
          ...(omitted > 0 ? { statevectorOmitted: omitted } : {}),
        },
      }
    }
    const out = runNoisy(circuit, shots, target.noise, seed)
    return {
      ok: true,
      result: {
        kind: 'counts',
        counts: out.counts,
        shots,
        numQubits: circuit.numQubits,
        gateCount: circuit.ops.length,
        erroredShots: out.erroredShots,
      },
    }
  } catch (cause) {
    // An engine exception's text is internal; it goes to observability.
    reportError(cause, { module: 'workbench/targets', stage: 'simulate', target: target.kind })
    return { ok: false, error: 'Simulation failed on the server; check the circuit and try again.' }
  }
}
