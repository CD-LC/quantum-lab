/**
 * quantum.ts — Zero-dependency quantum statevector simulator for the browser.
 *
 * This is the SHARED CONTRACT used by every visualization and the circuit
 * builder. It runs entirely client-side so visualizations work with no backend.
 *
 * Conventions:
 *  - Qubit 0 is the LEAST significant bit. Basis state index i has qubit q
 *    set when (i >> q) & 1 === 1. Bitstring labels are printed MSB-first
 *    (i.e. "q_{n-1} ... q_1 q_0") to match Qiskit's display convention.
 *  - Amplitudes are stored as a flat Float64Array of [re, im] pairs.
 *
 * Invalid input throws; it is never silently tolerated. Every bad input this
 * module used to accept produced a plausible-looking but wrong answer — a NaN
 * statevector that renders as an empty chart, or a controlled gate that
 * quietly did nothing — and those reach the learner as a claim about physics.
 * The one exception is fromQasm(), which is total by contract because three
 * call sites parse during render; it drops instructions it cannot accept.
 *
 * lib/quantum.adversarial.test.ts holds the property-based and edge-case
 * suite; lib/quantum.crosscheck.test.ts pins this module's output against
 * Qiskit and PennyLane through services/api/tests/test_js_crosscheck.py.
 */

import {
  applyCswap,
  applyMatrixOnRegister,
  applyPermutationOnRegister,
  applyQft,
  modularAddPermutation,
  modularMulPermutation,
  oneQubitToQasmBody,
  permutationToQasmBody,
  qftToQasmBody,
  sxMatrix,
  sxdgMatrix,
  twoQubitToQasmBody,
  u3Matrix,
  unitarityError,
  unitaryQubitCount,
  MAX_BLOCK_WIDTH,
  UNITARY_TOLERANCE,
} from './quantum/gates-extended'

// ────────────────────────────────────────────────────────────
// Complex numbers
// ────────────────────────────────────────────────────────────

export interface Complex {
  re: number
  im: number
}

export const c = (re: number, im = 0): Complex => ({ re, im })
export const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im })
export const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im })
export const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
export const cScale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s })
export const cAbs2 = (a: Complex): number => a.re * a.re + a.im * a.im
export const cAbs = (a: Complex): number => Math.sqrt(cAbs2(a))
export const cArg = (a: Complex): number => Math.atan2(a.im, a.re)
export const cConj = (a: Complex): Complex => ({ re: a.re, im: -a.im })

/** e^{i*theta} */
export const cExp = (theta: number): Complex => ({ re: Math.cos(theta), im: Math.sin(theta) })

// ────────────────────────────────────────────────────────────
// Gate definitions
// ────────────────────────────────────────────────────────────

export type GateName =
  | 'H' | 'X' | 'Y' | 'Z' | 'S' | 'SDG' | 'T' | 'TDG'
  | 'RX' | 'RY' | 'RZ' | 'P'
  | 'CX' | 'CY' | 'CZ' | 'SWAP' | 'CCX'
  | 'MEASURE' | 'BARRIER'
  // Wave 2 — the gap against Quirk. Engine code lives in lib/quantum/gates-extended.ts.
  | 'SX' | 'SXDG' | 'CSWAP' | 'MCX' | 'UNITARY'
  | 'ADDK' | 'MULK' | 'QFT' | 'IQFT'
  // Wave 3 — trajectory-only ops (RESET, POSTSELECT), the universal
  // single-qubit gate (U3), and generic per-control-basis controls
  // (GateOp.extraControls). See the header note above hasClassicalControl and
  // the doc comment on GateOp.extraControls for the physics.
  | 'RESET' | 'POSTSELECT' | 'U3'

/**
 * Ordinary single-qubit gates whose 2×2 matrix `singleQubitMatrix` (or, for
 * U3, `u3Matrix`) can produce — the set `GateOp.extraControls` is valid on,
 * together with a 1-qubit UNITARY. Everything else (already-named-controlled
 * gates, the register blocks, a 2-qubit UNITARY) has its own, different
 * notion of "controls" and rejects this field — see the doc comment on
 * `GateOp.extraControls`.
 */
const SINGLE_QUBIT_UNITARY_GATES: ReadonlySet<GateName> = new Set<GateName>([
  'H', 'X', 'Y', 'Z', 'S', 'SDG', 'T', 'TDG',
  'RX', 'RY', 'RZ', 'P', 'SX', 'SXDG', 'U3',
])

/** The register blocks: act on a run of qubits, optionally behind control qubits. */
export const BLOCK_GATES: ReadonlySet<GateName> = new Set<GateName>(['ADDK', 'MULK', 'QFT', 'IQFT'])
/** Blocks whose permutation is fixed by (k, modulus). */
export const ARITHMETIC_GATES: ReadonlySet<GateName> = new Set<GateName>(['ADDK', 'MULK'])

/**
 * "Apply this gate only if classical bit `bit` currently holds `value`."
 *
 * A single bit, not a mask: every protocol this app teaches — teleportation's
 * two corrections, superdense decoding, an error-correction round that actually
 * corrects — conditions one gate on one measured bit, and a mask-valued
 * condition would let the UI express circuits the QASM round trip cannot.
 * Condition on 0 as well as 1 because it costs nothing and makes the
 * "did the bit arrive?" question symmetric.
 */
export interface ClassicalCondition {
  /** Index into the classical register. */
  bit: number
  /** The value that lets the gate run. */
  value: 0 | 1
}

export interface GateOp {
  /** Gate identifier */
  name: GateName
  /** Target qubit indices. For CX: [control, target]. For CCX: [c1, c2, target]. */
  qubits: number[]
  /** Rotation angle in radians, for RX/RY/RZ/P */
  theta?: number
  /**
   * MEASURE only: the classical bit the outcome is written to.
   *
   * A MEASURE with no `clbit` is the old, purely destructive measurement —
   * `simulate()` still ignores it so the inspector can show the state before
   * the collapse. A MEASURE *with* a clbit is a real recorded measurement:
   * it collapses the qubit and stores the bit, and every execution path
   * honours it. That split is deliberate — it is what keeps every circuit
   * built before classical control existed behaving exactly as it did.
   */
  clbit?: number
  /** Run this gate only when the classical register says so. */
  condition?: ClassicalCondition
  /**
   * UNITARY only: the matrix, row-major, 4 entries (one qubit) or 16 (two).
   * For two qubits, row/column index j has qubits[0] as its least significant
   * bit — the same little-endian convention StateVector labels use.
   */
  matrix?: Complex[]
  /** UNITARY only: what the glyph says. Free text, kept short by the editor. */
  label?: string
  /** ADDK / MULK: the constant. Any integer; reduced mod `modulus`. */
  k?: number
  /** ADDK / MULK: the modulus N. Register values ≥ N pass through unchanged. */
  modulus?: number
  /**
   * Register blocks (ADDK, MULK, QFT, IQFT): how many LEADING entries of
   * `qubits` are control qubits. The rest is the register, least significant
   * qubit first. Absent means 0 — an unconditional block.
   */
  controls?: number
  /** POSTSELECT only: the value this qubit is projected onto. */
  postselectValue?: 0 | 1
  /** U3 only: the second and third Euler angle. `theta` (above) is the first. */
  phi?: number
  lambda?: number
  /**
   * Extra control qubits, each firing in its own basis, for an ordinary
   * single-qubit gate (H, X, Y, Z, S, SDG, T, TDG, RX, RY, RZ, P, SX, SXDG,
   * U3) or a 1-qubit UNITARY. `qubits` still names only the target, exactly
   * as it does for an uncontrolled single-qubit op.
   *
   * NOT the same thing as `controls` above: that field is a COUNT of leading
   * qubits, used only by the register blocks (ADDK/MULK/QFT/IQFT), which have
   * no notion of basis or anti-control. Reusing the name for this ARRAY would
   * have been a real, dangerous bug — a block's `controls: 1` and a single
   * qubit's `extraControls: [{ qubit: 0 }]` mean two different shapes, so they
   * get two different names.
   *
   * A control "fires" — lets the target gate apply — when the control reads
   * the +1 eigenstate of its basis (|1⟩ for Z, |+⟩ for X, |+i⟩ for Y), or the
   * −1 eigenstate (|0⟩, |−⟩, |−i⟩ respectively) when `anti` is set. `basis`
   * defaults to 'Z' (the ordinary CX/CY/CZ case) and `anti` defaults to
   * false. Invalid on CX/CY/CZ/CCX/MCX/SWAP/CSWAP (already controlled by
   * construction), on the register blocks (their `controls` count means
   * something else), and on a 2-qubit UNITARY — StateVector.apply() rejects
   * it there with a clear error rather than silently ignoring it.
   */
  extraControls?: { qubit: number; basis?: 'X' | 'Y' | 'Z'; anti?: boolean }[]
}

/** Human-facing metadata used by the gate palette UI. */
export interface GateSpec {
  name: GateName
  label: string
  /** Operand count. For a variadic gate this is the MINIMUM. */
  arity: number
  hasAngle: boolean
  description: string
  /** Categorical color slot — matches the app design tokens. */
  color: 'violet' | 'teal' | 'amber' | 'rose' | 'sky' | 'muted'
  /** Takes any number of operands ≥ arity (MCX, UNITARY, the register blocks). */
  variadic?: boolean
  /**
   * Part of the wave-2 extended set. The palette shows these only when asked
   * to (`extended`), so the guided onboarding and the challenge workbench —
   * whose par counts were verified against the original palette — are unchanged.
   */
  extended?: boolean
}

export const GATE_LIBRARY: GateSpec[] = [
  { name: 'H',  label: 'H',  arity: 1, hasAngle: false, color: 'violet', description: 'Hadamard — creates an equal superposition of |0⟩ and |1⟩.' },
  { name: 'X',  label: 'X',  arity: 1, hasAngle: false, color: 'teal',   description: 'Pauli-X — the quantum NOT gate. Flips |0⟩ ↔ |1⟩.' },
  { name: 'Y',  label: 'Y',  arity: 1, hasAngle: false, color: 'teal',   description: 'Pauli-Y — a bit flip and a phase flip together.' },
  { name: 'Z',  label: 'Z',  arity: 1, hasAngle: false, color: 'teal',   description: 'Pauli-Z — flips the phase of |1⟩, leaves |0⟩ alone.' },
  { name: 'S',  label: 'S',  arity: 1, hasAngle: false, color: 'amber',  description: 'Phase gate — a quarter turn (π/2) about the Z axis.' },
  { name: 'SDG',label: 'S†', arity: 1, hasAngle: false, color: 'amber',  description: 'Inverse of the S gate.' },
  { name: 'T',  label: 'T',  arity: 1, hasAngle: false, color: 'amber',  description: 'T gate — an eighth turn (π/4) about the Z axis.' },
  { name: 'TDG',label: 'T†', arity: 1, hasAngle: false, color: 'amber',  description: 'Inverse of the T gate.' },
  { name: 'RX', label: 'RX', arity: 1, hasAngle: true,  color: 'sky',    description: 'Rotation about the X axis by θ.' },
  { name: 'RY', label: 'RY', arity: 1, hasAngle: true,  color: 'sky',    description: 'Rotation about the Y axis by θ.' },
  { name: 'RZ', label: 'RZ', arity: 1, hasAngle: true,  color: 'sky',    description: 'Rotation about the Z axis by θ.' },
  { name: 'P',  label: 'P',  arity: 1, hasAngle: true,  color: 'sky',    description: 'Phase shift — multiplies |1⟩ by e^{iθ}.' },
  { name: 'CX', label: 'CX', arity: 2, hasAngle: false, color: 'rose',   description: 'Controlled-NOT — flips the target when the control is |1⟩. Creates entanglement.' },
  { name: 'CY', label: 'CY', arity: 2, hasAngle: false, color: 'rose',   description: 'Controlled-Y.' },
  { name: 'CZ', label: 'CZ', arity: 2, hasAngle: false, color: 'rose',   description: 'Controlled-Z — flips the phase when both qubits are |1⟩.' },
  { name: 'SWAP', label: 'SWAP', arity: 2, hasAngle: false, color: 'rose', description: 'Exchanges the states of two qubits.' },
  { name: 'CCX', label: 'CCX', arity: 3, hasAngle: false, color: 'rose', description: 'Toffoli — flips the target when both controls are |1⟩.' },
  { name: 'MEASURE', label: 'M', arity: 1, hasAngle: false, color: 'muted', description: 'Measure the qubit in the computational basis, collapsing it.' },
  // ── Wave 2: the gap against Quirk. Appended, never reordered — the MCP gate
  //    reference and the search corpus index this array by position.
  { name: 'SX',  label: '√X', arity: 1, hasAngle: false, color: 'teal', extended: true, description: 'Square root of X — half a bit flip. Two in a row make an X.' },
  { name: 'SXDG', label: '√X†', arity: 1, hasAngle: false, color: 'teal', extended: true, description: 'Inverse of √X. Undoes half a bit flip.' },
  { name: 'CSWAP', label: 'CSWAP', arity: 3, hasAngle: false, color: 'rose', extended: true, description: 'Fredkin — swaps two qubits when the control is |1⟩. Reversible logic’s universal gate.' },
  { name: 'MCX', label: 'MCX', arity: 2, hasAngle: false, color: 'rose', extended: true, variadic: true, description: 'Multi-controlled X — flips the target only when EVERY control is |1⟩. Pick how many controls.' },
  { name: 'UNITARY', label: 'U', arity: 1, hasAngle: false, color: 'violet', extended: true, variadic: true, description: 'Custom matrix — type any 2×2 or 4×4. It is a gate only if it passes the unitarity check.' },
  { name: 'ADDK', label: '+k', arity: 1, hasAngle: false, color: 'amber', extended: true, variadic: true, description: 'Modular add — |x⟩ becomes |x + k mod N⟩ on a register. A permutation of basis states.' },
  { name: 'MULK', label: '×k', arity: 1, hasAngle: false, color: 'amber', extended: true, variadic: true, description: 'Modular multiply — |x⟩ becomes |k·x mod N⟩. With a control, this is the U_a of Shor’s algorithm.' },
  { name: 'QFT', label: 'QFT', arity: 1, hasAngle: false, color: 'sky', extended: true, variadic: true, description: 'Quantum Fourier transform on a register — turns a periodic register into peaks at multiples of 2^m / period.' },
  { name: 'IQFT', label: 'QFT†', arity: 1, hasAngle: false, color: 'sky', extended: true, variadic: true, description: 'Inverse quantum Fourier transform — the last step before measuring in phase estimation and Shor.' },
  { name: 'BARRIER', label: '┆', arity: 0, hasAngle: false, color: 'muted', extended: true, description: 'Barrier — a dashed line for grouping steps visually. The engine ignores it.' },
  // ── Wave 3: trajectory-only ops and the universal single-qubit gate.
  //    Appended, same reason as wave 2 above — never reordered.
  { name: 'RESET', label: 'R', arity: 1, hasAngle: false, color: 'muted', extended: true, description: 'Reset — measures the qubit and flips it back to |0⟩ if it read 1. Deterministic: it always leaves the qubit at |0⟩.' },
  { name: 'POSTSELECT', label: '⟨ψ|', arity: 1, hasAngle: false, color: 'muted', extended: true, description: 'Postselect — idealized projective filter. Keeps only the branches where this qubit reads the chosen value, and renormalizes. Not a physical operation on real hardware; a simulator-only tool for algorithms like HHL that rely on discarding failed branches.' },
  { name: 'U3', label: 'U3', arity: 1, hasAngle: true, color: 'sky', extended: true, description: 'U3(θ,φ,λ) — the universal single-qubit gate. Every single-qubit unitary, up to global phase, is some U3.' },
]

export const GATE_BY_NAME: Record<string, GateSpec> = Object.fromEntries(
  GATE_LIBRARY.map((g) => [g.name, g])
)

/** Gates whose matrix depends on theta. Everything else ignores the angle. */
const ANGLE_GATES: ReadonlySet<GateName> = new Set<GateName>(['RX', 'RY', 'RZ', 'P'])

/** 2x2 single-qubit unitary as [a, b, c, d] row-major. */
function singleQubitMatrix(name: GateName, theta = 0): [Complex, Complex, Complex, Complex] {
  // A non-finite angle poisons every amplitude with NaN and normalize() cannot
  // recover it (0/0). Callers reached this with NaN by parsing an empty angle
  // field in the editor, so fail here rather than hand back a NaN statevector
  // that renders as a blank chart with no error anywhere.
  if (ANGLE_GATES.has(name) && !Number.isFinite(theta)) {
    throw new Error(`${name} angle must be a finite number, got ${theta}`)
  }
  const r = Math.SQRT1_2
  switch (name) {
    case 'H':   return [c(r), c(r), c(r), c(-r)]
    case 'X':   return [c(0), c(1), c(1), c(0)]
    case 'Y':   return [c(0), c(0, -1), c(0, 1), c(0)]
    case 'Z':   return [c(1), c(0), c(0), c(-1)]
    case 'S':   return [c(1), c(0), c(0), c(0, 1)]
    case 'SDG': return [c(1), c(0), c(0), c(0, -1)]
    case 'T':   return [c(1), c(0), c(0), cExp(Math.PI / 4)]
    case 'TDG': return [c(1), c(0), c(0), cExp(-Math.PI / 4)]
    case 'RX': {
      const ct = Math.cos(theta / 2), st = Math.sin(theta / 2)
      return [c(ct), c(0, -st), c(0, -st), c(ct)]
    }
    case 'RY': {
      const ct = Math.cos(theta / 2), st = Math.sin(theta / 2)
      return [c(ct), c(-st), c(st), c(ct)]
    }
    case 'RZ': {
      return [cExp(-theta / 2), c(0), c(0), cExp(theta / 2)]
    }
    case 'P':   return [c(1), c(0), c(0), cExp(theta)]
    case 'SX':  return sxMatrix()
    case 'SXDG': return sxdgMatrix()
    default:
      throw new Error(`${name} is not a single-qubit unitary`)
  }
}

/**
 * The 2×2 matrix of a fixed or rotation gate, row-major — exposed so tests and
 * the matrix editor's "start from" buttons can read the same table the engine
 * applies, rather than a second copy that can drift.
 */
export function gateMatrix(name: GateName, theta = 0): [Complex, Complex, Complex, Complex] {
  return singleQubitMatrix(name, theta)
}

/** Same NaN-poisoning guard as `singleQubitMatrix` above, for U3's three angles. */
function assertFiniteU3Angles(theta: number, phi: number, lambda: number): void {
  if (!Number.isFinite(theta) || !Number.isFinite(phi) || !Number.isFinite(lambda)) {
    throw new Error(`U3 angles must be finite numbers, got theta=${theta}, phi=${phi}, lambda=${lambda}`)
  }
}

/**
 * Split a register block's operands into its control qubits and its register
 * (least significant qubit first). Throws on a shape the block cannot act on.
 */
export function splitBlockOperands(op: GateOp): { controls: number[]; register: number[] } {
  const controls = op.controls ?? 0
  if (!Number.isInteger(controls) || controls < 0) {
    throw new Error(`${op.name} control count must be a non-negative integer, got ${controls}`)
  }
  const register = op.qubits.slice(controls)
  if (register.length < 1) throw new Error(`${op.name} needs at least one register qubit`)
  if (register.length > MAX_BLOCK_WIDTH) {
    throw new Error(`${op.name} register is limited to ${MAX_BLOCK_WIDTH} qubits, got ${register.length}`)
  }
  return { controls: op.qubits.slice(0, controls), register }
}

/** The permutation an ADDK / MULK op applies to a register of `width` qubits. */
export function blockPermutation(op: GateOp, width: number): number[] {
  if (op.k === undefined || op.modulus === undefined) {
    throw new Error(`${op.name} needs both k and modulus`)
  }
  return op.name === 'MULK'
    ? modularMulPermutation(op.k, op.modulus, width)
    : modularAddPermutation(op.k, op.modulus, width)
}

/** What the glyph and the palette call a block: "+7 mod 15", "×7 mod 15", "QFT", "QFT†". */
export function blockLabel(op: Pick<GateOp, 'name' | 'k' | 'modulus'>): string {
  switch (op.name) {
    case 'ADDK': return `+${op.k ?? '?'} mod ${op.modulus ?? '?'}`
    case 'MULK': return `×${op.k ?? '?'} mod ${op.modulus ?? '?'}`
    case 'QFT':  return 'QFT'
    case 'IQFT': return 'QFT†'
    default:     return op.name
  }
}

// ────────────────────────────────────────────────────────────
// Statevector
// ────────────────────────────────────────────────────────────

export class StateVector {
  readonly numQubits: number
  readonly dim: number
  /** Interleaved [re0, im0, re1, im1, ...] of length 2*dim */
  data: Float64Array

  constructor(numQubits: number) {
    if (!Number.isInteger(numQubits) || numQubits < 1 || numQubits > 16) {
      // 16 is the paid-tier ceiling in lib/plans.ts; 2^16 complex doubles is
      // 1 MB, which is the largest allocation that stays interactive in a
      // browser tab. A non-integer used to survive here and silently produce a
      // dim of 1 << 1.5 === 2 with a numQubits of 1.5 in every label.
      throw new Error('numQubits must be an integer between 1 and 16')
    }
    this.numQubits = numQubits
    this.dim = 1 << numQubits
    this.data = new Float64Array(2 * this.dim)
    this.data[0] = 1 // |00...0>
  }

  static fromAmplitudes(amps: Complex[]): StateVector {
    const n = Math.log2(amps.length)
    if (!Number.isInteger(n)) throw new Error('amplitude count must be a power of two')
    const sv = new StateVector(n)
    for (const a of amps) {
      if (!Number.isFinite(a.re) || !Number.isFinite(a.im)) {
        throw new Error('amplitudes must be finite')
      }
    }
    // Deliberately NOT normalized — tests build deliberately un-normalized
    // states here to exercise normalize(). Call .normalize() if you need a
    // physical state; simulate() always normalizes its own result.
    amps.forEach((a, i) => {
      sv.data[2 * i] = a.re
      sv.data[2 * i + 1] = a.im
    })
    return sv
  }

  clone(): StateVector {
    const sv = new StateVector(this.numQubits)
    sv.data.set(this.data)
    return sv
  }

  amplitude(i: number): Complex {
    this.assertBasisIndex(i)
    return { re: this.data[2 * i], im: this.data[2 * i + 1] }
  }

  amplitudes(): Complex[] {
    return Array.from({ length: this.dim }, (_, i) => this.amplitude(i))
  }

  /** Probability of measuring basis state i. */
  probability(i: number): number {
    this.assertBasisIndex(i)
    const re = this.data[2 * i], im = this.data[2 * i + 1]
    return re * re + im * im
  }

  probabilities(): number[] {
    return Array.from({ length: this.dim }, (_, i) => this.probability(i))
  }

  /** Marginal probability that qubit q reads 1. */
  qubitProbability(q: number): number {
    this.assertQubit(q)
    let p = 0
    for (let i = 0; i < this.dim; i++) {
      if ((i >> q) & 1) p += this.probability(i)
    }
    return p
  }

  /**
   * Reject a qubit index this state cannot address.
   *
   * Out-of-range indices used to be tolerated by the bit arithmetic and turned
   * the whole statevector into NaN: `i | (1 << 5)` on a 2-qubit state reads
   * past the Float64Array, JavaScript returns `undefined`, and every arithmetic
   * result from then on is NaN. `simulate()` then called `normalize()`, which
   * divides NaN by NaN and hides the cause. A negative index is worse — it
   * wraps to bit 31 — and a non-integer index silently truncates in `1 << q`.
   * Every entry point that turns a qubit number into a bit mask goes through
   * here. Do not remove these for speed without profiling first: at 16 qubits
   * the check runs once per gate, not once per amplitude.
   */
  /**
   * Reject a basis-state index outside [0, dim). Out of range, `amplitude()`
   * returned `{re: undefined, im: undefined}` typed as numbers and
   * `probability()` returned NaN, so a bad index reached charts as an empty
   * bar rather than an error.
   */
  private assertBasisIndex(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.dim) {
      throw new Error(`basis index ${i} is out of range for a ${this.numQubits}-qubit state`)
    }
  }

  private assertQubit(q: number, role = 'qubit'): void {
    if (!Number.isInteger(q) || q < 0 || q >= this.numQubits) {
      throw new Error(
        `${role} index ${q} is out of range for a ${this.numQubits}-qubit state`
      )
    }
  }

  /** Basis label for index i, MSB-first (Qiskit convention). */
  label(i: number): string {
    // Guarded because an out-of-range index produced a longer-than-numQubits
    // string (label(99) on a 2-qubit state returned "1100011"), which reads as
    // a valid label everywhere downstream.
    this.assertBasisIndex(i)
    return i.toString(2).padStart(this.numQubits, '0')
  }

  /** Renormalize in place — guards against float drift. */
  normalize(): this {
    let norm = 0
    for (let i = 0; i < this.data.length; i++) norm += this.data[i] * this.data[i]
    norm = Math.sqrt(norm)
    if (norm > 0 && Math.abs(norm - 1) > 1e-12) {
      for (let i = 0; i < this.data.length; i++) this.data[i] /= norm
    }
    return this
  }

  // ── Gate application ──

  /**
   * The core of every single-qubit gate application: multiply an explicit 2×2
   * matrix into the (|…0…⟩, |…1…⟩) pair of amplitudes for qubit `q`, for
   * every other-qubit assignment. `applySingle` is a thin lookup-then-delegate
   * on top of this — the one body of gate-application math both it and the
   * generic-control path (`applyGeneralControlled`) share, so a change to the
   * arithmetic cannot drift between two copies.
   */
  applySingleMatrix(matrix: readonly [Complex, Complex, Complex, Complex], q: number): this {
    this.assertQubit(q)
    const [m00, m01, m10, m11] = matrix
    const bit = 1 << q
    for (let i = 0; i < this.dim; i++) {
      if (i & bit) continue
      const j = i | bit
      const a = { re: this.data[2 * i], im: this.data[2 * i + 1] }
      const b = { re: this.data[2 * j], im: this.data[2 * j + 1] }
      const na = cAdd(cMul(m00, a), cMul(m01, b))
      const nb = cAdd(cMul(m10, a), cMul(m11, b))
      this.data[2 * i] = na.re; this.data[2 * i + 1] = na.im
      this.data[2 * j] = nb.re; this.data[2 * j + 1] = nb.im
    }
    return this
  }

  applySingle(name: GateName, q: number, theta = 0): this {
    return this.applySingleMatrix(singleQubitMatrix(name, theta), q)
  }

  /**
   * The core of every all-controls-must-read-1 gate application: multiply an
   * explicit 2×2 matrix into the target qubit's amplitude pair, but only on
   * the sub-block where every control bit is 1. `applyControlled` is a thin
   * lookup-then-delegate on top of this, same relationship as
   * `applySingleMatrix` has to `applySingle` — see its doc comment.
   *
   * A control that equals the target is rejected. It is not a physical gate —
   * you cannot condition an operation on a qubit you are also rotating — and
   * the old code turned it into a silent identity: the target bit is part of
   * the control mask, so the "control is 1" branch and the "target is 0"
   * branch were mutually exclusive and the loop body never ran. `cx q[0],
   * q[0];` pasted into the QASM box therefore simulated as a no-op with no
   * warning. Qiskit raises CircuitError for the same input.
   */
  applyControlledMatrix(matrix: readonly [Complex, Complex, Complex, Complex], controls: number[], target: number): this {
    this.assertQubit(target, 'target qubit')
    const seen = new Set<number>()
    for (const q of controls) {
      this.assertQubit(q, 'control qubit')
      if (q === target) throw new Error(`control qubit ${q} cannot also be the target`)
      if (seen.has(q)) throw new Error(`control qubit ${q} is listed twice`)
      seen.add(q)
    }
    const [m00, m01, m10, m11] = matrix
    const tbit = 1 << target
    const cmask = controls.reduce((m, q) => m | (1 << q), 0)
    for (let i = 0; i < this.dim; i++) {
      if (i & tbit) continue
      if ((i & cmask) !== cmask) continue
      const j = i | tbit
      const a = { re: this.data[2 * i], im: this.data[2 * i + 1] }
      const b = { re: this.data[2 * j], im: this.data[2 * j + 1] }
      const na = cAdd(cMul(m00, a), cMul(m01, b))
      const nb = cAdd(cMul(m10, a), cMul(m11, b))
      this.data[2 * i] = na.re; this.data[2 * i + 1] = na.im
      this.data[2 * j] = nb.re; this.data[2 * j + 1] = nb.im
    }
    return this
  }

  applyControlled(name: GateName, controls: number[], target: number, theta = 0): this {
    return this.applyControlledMatrix(singleQubitMatrix(name, theta), controls, target)
  }

  /**
   * Generalization of `applyControlledMatrix`: each control has its OWN
   * required bit rather than every control needing to read 1. Same loop,
   * same matrix arithmetic — the mask-equality test
   * `(i & cmask) === cmask` (all-must-be-1) becomes a per-control
   * `((i >> qubit) & 1) === requiredBit` check.
   *
   * This is the primitive `extraControls` (see GateOp) is built on: a control
   * in the X or Y basis is a Z-basis control on the qubit AFTER a basis-change
   * gate (H, or Sdg-then-H) has been applied to it, so the caller applies
   * those, computes each control's required bit in the ROTATED basis, calls
   * this once, and then undoes the basis-change gates — see
   * `applyExtraControls` below, which does exactly that.
   */
  applyGeneralControlled(
    matrix: readonly [Complex, Complex, Complex, Complex],
    controlSpecs: readonly { qubit: number; requiredBit: 0 | 1 }[],
    target: number
  ): this {
    this.assertQubit(target, 'target qubit')
    const seen = new Set<number>()
    for (const spec of controlSpecs) {
      this.assertQubit(spec.qubit, 'control qubit')
      if (spec.qubit === target) throw new Error(`control qubit ${spec.qubit} cannot also be the target`)
      if (seen.has(spec.qubit)) throw new Error(`control qubit ${spec.qubit} is listed twice`)
      seen.add(spec.qubit)
    }
    const [m00, m01, m10, m11] = matrix
    const tbit = 1 << target
    for (let i = 0; i < this.dim; i++) {
      if (i & tbit) continue
      let fires = true
      for (const spec of controlSpecs) {
        if (((i >> spec.qubit) & 1) !== spec.requiredBit) { fires = false; break }
      }
      if (!fires) continue
      const j = i | tbit
      const a = { re: this.data[2 * i], im: this.data[2 * i + 1] }
      const b = { re: this.data[2 * j], im: this.data[2 * j + 1] }
      const na = cAdd(cMul(m00, a), cMul(m01, b))
      const nb = cAdd(cMul(m10, a), cMul(m11, b))
      this.data[2 * i] = na.re; this.data[2 * i + 1] = na.im
      this.data[2 * j] = nb.re; this.data[2 * j + 1] = nb.im
    }
    return this
  }

  /**
   * `GateOp.extraControls`, applied: any number of controls, each in the Z,
   * X, or Y basis, positive or anti. THE EXACT RECIPE (derived and verified —
   * see Task 4 of the spec this shipped against; do not re-derive):
   *
   * A control `c` "fires" (lets the target gate apply) when it reads the
   * named eigenstate: Z/no-anti → |1⟩, Z/anti → |0⟩, X/no-anti → |+⟩,
   * X/anti → |−⟩, Y/no-anti → |+i⟩, Y/anti → |−i⟩.
   *
   * Per control, before the (possibly multi-control) target gate:
   *   Z: no basis-change gate. Required post-change bit: anti ? 0 : 1.
   *   X: apply H. Required bit: anti ? 1 : 0. (H maps |+⟩ → |0⟩, so firing on
   *      |+⟩ — anti=false — must correspond to reading 0 after H: the
   *      OPPOSITE of anti's face value.)
   *   Y: apply Sdg, THEN H, in that order. Required bit: anti ? 1 : 0 (same
   *      rule as X — Sdg maps |+i⟩ to |+⟩, and H then maps that to |0⟩).
   *
   * Then `applyGeneralControlled` with every transformed control's own
   * required bit, then the basis-change gates are UNDONE in reverse order:
   *   X: apply H again (self-inverse).
   *   Y: apply H, THEN S (undoing "Sdg then H" in reverse: undo H with H,
   *      then undo Sdg with S).
   *   Z: nothing to undo.
   */
  applyExtraControls(
    matrix: readonly [Complex, Complex, Complex, Complex],
    extraControls: readonly { qubit: number; basis?: 'X' | 'Y' | 'Z'; anti?: boolean }[],
    target: number
  ): this {
    const seen = new Set<number>()
    for (const ec of extraControls) {
      this.assertQubit(ec.qubit, 'control qubit')
      if (ec.qubit === target) throw new Error(`control qubit ${ec.qubit} cannot also be the target`)
      if (seen.has(ec.qubit)) throw new Error(`control qubit ${ec.qubit} is listed twice`)
      seen.add(ec.qubit)
    }
    const specs: { qubit: number; requiredBit: 0 | 1 }[] = []
    for (const ec of extraControls) {
      const basis = ec.basis ?? 'Z'
      const anti = ec.anti ?? false
      if (basis === 'Z') {
        specs.push({ qubit: ec.qubit, requiredBit: anti ? 0 : 1 })
      } else if (basis === 'X') {
        this.applySingle('H', ec.qubit)
        specs.push({ qubit: ec.qubit, requiredBit: anti ? 1 : 0 })
      } else {
        this.applySingle('SDG', ec.qubit)
        this.applySingle('H', ec.qubit)
        specs.push({ qubit: ec.qubit, requiredBit: anti ? 1 : 0 })
      }
    }
    this.applyGeneralControlled(matrix, specs, target)
    for (let i = extraControls.length - 1; i >= 0; i--) {
      const ec = extraControls[i]
      const basis = ec.basis ?? 'Z'
      if (basis === 'X') {
        this.applySingle('H', ec.qubit)
      } else if (basis === 'Y') {
        this.applySingle('H', ec.qubit)
        this.applySingle('S', ec.qubit)
      }
    }
    return this
  }

  applySwap(a: number, b: number): this {
    this.assertQubit(a)
    this.assertQubit(b)
    // Unlike a controlled gate with control === target, SWAP(q, q) is a real
    // unitary — the identity — so it is accepted rather than thrown.
    if (a === b) return this
    const abit = 1 << a, bbit = 1 << b
    for (let i = 0; i < this.dim; i++) {
      const ai = (i & abit) !== 0, bi = (i & bbit) !== 0
      if (ai === bi) continue
      const j = i ^ abit ^ bbit
      if (j <= i) continue
      for (const k of [0, 1]) {
        const t = this.data[2 * i + k]
        this.data[2 * i + k] = this.data[2 * j + k]
        this.data[2 * j + k] = t
      }
    }
    return this
  }

  apply(op: GateOp): this {
    const { name, qubits, theta = 0, phi, lambda } = op
    // A statevector has no classical register, so it cannot answer "did c0 read
    // 1?". Applying the gate anyway would be the exact failure this module's
    // header warns about — a plausible-looking result that is not the circuit
    // the user drew. Conditional ops go through execute(), which carries the
    // register alongside the state.
    if (op.condition) {
      throw new Error(
        `${name} is conditioned on classical bit ${op.condition.bit}; use execute() rather than apply()`
      )
    }
    switch (name) {
      case 'BARRIER':
      case 'MEASURE':
        // Both are no-ops for the statevector. MEASURE is handled by run() and
        // measureQubit(); simulate() deliberately ignores it so the inspector
        // can show the pre-measurement state.
        return this
      case 'RESET':
        // Not a unitary: it measures, then conditionally flips. A statevector
        // has no coin to flip, exactly like a conditioned op above — execute()
        // and outcomeBranches() carry the trajectory/branch semantics this
        // needs.
        throw new Error('RESET has no fixed unitary; use execute() rather than apply()')
      case 'POSTSELECT':
        throw new Error('POSTSELECT has no fixed unitary; use execute() rather than apply()')
    }
    // Arity is checked before dispatch because a missing operand reads as
    // qubit 0, not as an error: `1 << undefined` is `1 << 0`, so a CX saved
    // with one qubit used to apply a controlled-X onto qubit 0.
    const spec = GATE_BY_NAME[name]
    if (!spec) throw new Error(`unknown gate ${name}`)
    if (spec.variadic) {
      if (qubits.length < spec.arity) {
        throw new Error(`${name} takes at least ${spec.arity} qubit(s), got ${qubits.length}`)
      }
    } else if (qubits.length !== spec.arity) {
      throw new Error(`${name} takes ${spec.arity} qubit(s), got ${qubits.length}`)
    }
    if (op.extraControls && op.extraControls.length) {
      const isSingleUnitary = name === 'UNITARY' && qubits.length === 1
      if (!SINGLE_QUBIT_UNITARY_GATES.has(name) && !isSingleUnitary) {
        throw new Error(
          `${name} does not accept extraControls — only an ordinary single-qubit gate or a 1-qubit UNITARY does`
        )
      }
      const matrix: [Complex, Complex, Complex, Complex] =
        name === 'U3'
          ? (assertFiniteU3Angles(theta, phi ?? 0, lambda ?? 0),
             u3Matrix(theta, phi ?? 0, lambda ?? 0) as [Complex, Complex, Complex, Complex])
          : isSingleUnitary
            ? (() => {
                const err = unitarityError(op.matrix as Complex[])
                if (!(err <= UNITARY_TOLERANCE)) {
                  throw new Error(`custom matrix is not unitary (‖U†U − I‖ = ${err.toExponential(2)})`)
                }
                return op.matrix as [Complex, Complex, Complex, Complex]
              })()
            : singleQubitMatrix(name, theta)
      return this.applyExtraControls(matrix, op.extraControls, qubits[0])
    }
    switch (name) {
      case 'CX':  return this.applyControlled('X', [qubits[0]], qubits[1])
      case 'CY':  return this.applyControlled('Y', [qubits[0]], qubits[1])
      case 'CZ':  return this.applyControlled('Z', [qubits[0]], qubits[1])
      case 'CCX': return this.applyControlled('X', [qubits[0], qubits[1]], qubits[2])
      case 'SWAP':return this.applySwap(qubits[0], qubits[1])
      case 'U3': {
        assertFiniteU3Angles(theta, phi ?? 0, lambda ?? 0)
        return this.applySingleMatrix(u3Matrix(theta, phi ?? 0, lambda ?? 0) as [Complex, Complex, Complex, Complex], qubits[0])
      }
      // ── Wave 2 ──
      case 'MCX': return this.applyControlled('X', qubits.slice(0, -1), qubits[qubits.length - 1])
      case 'CSWAP':
        applyCswap(this.data, this.numQubits, qubits[0], qubits[1], qubits[2])
        return this
      case 'UNITARY': {
        const width = unitaryQubitCount(op.matrix)
        if (qubits.length !== width) {
          throw new Error(`this ${width}-qubit matrix needs ${width} qubit(s), got ${qubits.length}`)
        }
        // Checked on every apply, not just in the editor: a matrix can arrive
        // from a saved circuit, a share link, or QASM, and a non-unitary one
        // produces a state that is not a state.
        const err = unitarityError(op.matrix as Complex[])
        if (!(err <= UNITARY_TOLERANCE)) {
          throw new Error(`custom matrix is not unitary (‖U†U − I‖ = ${err.toExponential(2)})`)
        }
        applyMatrixOnRegister(this.data, this.numQubits, qubits, op.matrix as Complex[])
        return this
      }
      case 'ADDK':
      case 'MULK':
      case 'QFT':
      case 'IQFT': {
        const { controls, register } = splitBlockOperands(op)
        if (name === 'QFT' || name === 'IQFT') {
          applyQft(this.data, this.numQubits, register, name === 'IQFT', controls)
          return this
        }
        const perm = blockPermutation(op, register.length)
        applyPermutationOnRegister(this.data, this.numQubits, register, perm, controls)
        return this
      }
      default:    return this.applySingle(name, qubits[0], theta)
    }
  }

  /**
   * Bloch vector (x, y, z) for a single qubit, tracing out the rest.
   * For a pure single-qubit state the vector lies on the unit sphere;
   * entangled qubits give a shorter vector (mixed state).
   */
  blochVector(q: number): { x: number; y: number; z: number } {
    this.assertQubit(q)
    // Reduced density matrix elements for qubit q
    let r00 = 0, r11 = 0
    const r01 = { re: 0, im: 0 }
    const bit = 1 << q
    for (let i = 0; i < this.dim; i++) {
      if (i & bit) continue
      const j = i | bit
      const a = this.amplitude(i)
      const b = this.amplitude(j)
      r00 += cAbs2(a)
      r11 += cAbs2(b)
      // rho_01 = sum a * conj(b)
      const t = cMul(a, cConj(b))
      r01.re += t.re
      r01.im += t.im
    }
    return {
      x: 2 * r01.re,
      y: -2 * r01.im,
      z: r00 - r11,
    }
  }

  /**
   * Von Neumann entropy of qubit q's reduced state, in bits.
   * 0 = unentangled (pure), 1 = maximally entangled.
   */
  entanglementEntropy(q: number): number {
    const { x, y, z } = this.blochVector(q)
    const r = Math.min(1, Math.sqrt(x * x + y * y + z * z))
    const l1 = (1 + r) / 2
    const l2 = (1 - r) / 2
    const h = (p: number) => (p <= 0 || p >= 1 ? 0 : -p * Math.log2(p))
    return h(l1) + h(l2)
  }

  /** Collapse qubit q, returning the observed bit. Mutates the state. */
  measureQubit(q: number, rng: () => number = Math.random): 0 | 1 {
    this.assertQubit(q)
    const p1 = this.qubitProbability(q)
    const outcome: 0 | 1 = rng() < p1 ? 1 : 0
    this.collapseQubit(q, outcome)
    return outcome
  }

  /**
   * Project qubit q onto a GIVEN outcome and renormalize. Mutates the state.
   *
   * This is the half of `measureQubit` that is not the coin flip, exposed
   * because two callers need the collapse without the randomness: branch
   * enumeration (`outcomeBranches`, which takes both outcomes) and the
   * visualizations, which let a reader pick which Bell result happened.
   *
   * Projecting onto an outcome that cannot occur throws. It used to be
   * reachable by handing `measureQubit` an rng that always returned 0: the
   * amplitudes were all zeroed, the norm was 0, the division was skipped, and
   * the caller got back an all-zero "statevector" that every downstream
   * probability reads as 0 — a state that is not a state, with no error.
   */
  collapseQubit(q: number, outcome: 0 | 1): this {
    this.assertQubit(q)
    const p1 = this.qubitProbability(q)
    const p = outcome === 1 ? p1 : 1 - p1
    if (!(p > 1e-12)) {
      throw new Error(
        `qubit ${q} cannot collapse to ${outcome}: that outcome has probability ${p.toExponential(2)}`
      )
    }
    const bit = 1 << q
    const norm = Math.sqrt(p)
    for (let i = 0; i < this.dim; i++) {
      const isOne = (i & bit) !== 0
      if ((outcome === 1) !== isOne) {
        this.data[2 * i] = 0
        this.data[2 * i + 1] = 0
      } else {
        this.data[2 * i] /= norm
        this.data[2 * i + 1] /= norm
      }
    }
    return this
  }
}

// ────────────────────────────────────────────────────────────
// Circuit
// ────────────────────────────────────────────────────────────

export interface Circuit {
  numQubits: number
  ops: GateOp[]
  /**
   * Width of the classical register. Optional: when it is absent the register
   * is sized from the circuit itself (one bit per qubit, widened to cover the
   * highest bit any op names), which is what keeps a classical bit index from
   * ever being out of range no matter how the UI edits the op list.
   */
  numClbits?: number
  /**
   * Sparse per-qubit starting state, applied before `ops` runs. A qubit not
   * listed starts at |0⟩ — today's universal default — so a Circuit value
   * with no `initialStates` field behaves EXACTLY as it did before this field
   * existed; that is what keeps every saved circuit, share link and preset
   * loading unchanged.
   */
  initialStates?: Record<number, '0' | '1' | '+' | '-' | 'i' | '-i'>
}

/**
 * The prep-gate sequence for each named initial state, in time order.
 * '-' is X then H; 'i' is H then S; '-i' is X, then H, then S. Shared by
 * simulate(), execute(), outcomeBranches() and simulateSteps() so the four
 * entry points agree on what "start qubit q in |+i⟩" means.
 */
const INITIAL_STATE_PREP: Record<NonNullable<Circuit['initialStates']>[number], GateName[]> = {
  '0': [],
  '1': ['X'],
  '+': ['H'],
  '-': ['X', 'H'],
  'i': ['H', 'S'],
  '-i': ['X', 'H', 'S'],
}

/** Apply `circuit.initialStates` to a fresh StateVector, in place. */
function prepInitialStates(sv: StateVector, circuit: Circuit): void {
  if (!circuit.initialStates) return
  for (const [qStr, state] of Object.entries(circuit.initialStates)) {
    const q = Number(qStr)
    for (const gate of INITIAL_STATE_PREP[state]) sv.applySingle(gate, q)
  }
}

export const emptyCircuit = (numQubits = 2): Circuit => ({ numQubits, ops: [] })

// ────────────────────────────────────────────────────────────
// Classical control
// ────────────────────────────────────────────────────────────
//
// A measurement writes a bit; a later gate reads it. That single sentence is
// the difference between a circuit that DETECTS an error and one that CORRECTS
// it, and between "teleportation" drawn with a CX standing in for a classical
// wire and the real protocol where two bits travel down a wire at the speed of
// light. Everything in this section exists to make that sentence executable.
//
// Two ways to run such a circuit, and they answer different questions:
//
//   execute()         ONE trajectory. The coin is flipped, the state collapses,
//                     the register fills in. This is what hardware does.
//   outcomeBranches() EVERY trajectory, with its exact probability. No sampling
//                     error, so it is the analytic ground truth the tests and
//                     the visualizations compare against.

/** The highest classical bit index this circuit names, or -1 if it names none. */
export function highestClassicalBit(circuit: Circuit): number {
  let max = -1
  for (const op of circuit.ops) {
    if (op.name === 'MEASURE' && op.clbit !== undefined) max = Math.max(max, op.clbit)
    if (op.condition) max = Math.max(max, op.condition.bit)
  }
  return max
}

/**
 * How many classical bits this circuit's register holds.
 *
 * Derived rather than stored so that editing the op list — the UI removes a
 * gate, the simulator page drops ops that fell outside a narrowed register —
 * can never leave a condition pointing past the end of the register. An
 * unwritten bit reads 0, which is a defined answer; an out-of-range one is not.
 */
export function classicalBitCount(circuit: Circuit): number {
  const declared = circuit.numClbits ?? circuit.numQubits
  return Math.max(declared, highestClassicalBit(circuit) + 1)
}

/**
 * True when the circuit needs TRAJECTORY/BRANCH semantics rather than a bare
 * unitary — it records a measurement into a bit, gates on one, or contains a
 * RESET or POSTSELECT (both measure-and-branch under the hood; see the
 * comments on those ops in outcomeBranches() and execute()). This is the one
 * predicate that decides, everywhere in this module and in
 * lib/workbench/verify.ts's circuitUnitary(), whether a circuit is "just
 * gates" (simulate() applies them to a bare StateVector, circuitUnitary()
 * extracts a matrix) or "needs execute()/outcomeBranches()" (there is no
 * single statevector, or no unitary, that describes the result).
 *
 * The name predates RESET/POSTSELECT — it started as "does this circuit read
 * or write the classical register" — but it is kept: every call site already
 * asks it the SAME question ("can I treat this circuit as a bare unitary?"),
 * and RESET/POSTSELECT answer that question the same way a recorded
 * measurement does, for the same underlying reason (a statevector alone
 * cannot describe what happens next).
 *
 * This is also the switch that keeps every pre-existing circuit behaving
 * exactly as it did: no circuit written before this feature sets `clbit`,
 * `condition`, or a RESET/POSTSELECT op, so no such circuit takes the new path.
 */
export function hasClassicalControl(circuit: Circuit): boolean {
  return circuit.ops.some(
    (op) =>
      op.condition !== undefined ||
      (op.name === 'MEASURE' && op.clbit !== undefined) ||
      op.name === 'RESET' ||
      op.name === 'POSTSELECT'
  )
}

/** Reject a classical bit index that is not a usable register slot. */
function assertClbit(bit: number, numClbits: number, role: string): void {
  if (!Number.isInteger(bit) || bit < 0 || bit >= numClbits) {
    throw new Error(`${role} ${bit} is out of range for a ${numClbits}-bit classical register`)
  }
}

/** One recorded measurement from a single execution. */
export interface MeasurementRecord {
  /** Index into circuit.ops of the MEASURE that produced this. */
  op: number
  qubit: number
  clbit: number
  outcome: 0 | 1
  /** P(qubit reads 1) immediately before the collapse — the honest coin. */
  p1: number
}

export interface ExecuteOptions {
  /** Source of randomness for measurement outcomes. Defaults to Math.random. */
  rng?: () => number
  /**
   * Pin the outcome of every measurement that writes a given classical bit,
   * e.g. `{ 0: 1, 1: 0 }` for "c0 came out 1, c1 came out 0". Forcing an
   * outcome that has probability zero throws — postselecting on the impossible
   * is not a thing the simulator will quietly pretend to do.
   */
  forceOutcomes?: Readonly<Record<number, 0 | 1>>
  /** Collect the statevector before op 0 and after every op, like simulateSteps. */
  collectFrames?: boolean
  /**
   * Stop storing frames once this many are held (frame 0 included). The run
   * still completes; `frames` is then a prefix of the full list. Each frame is
   * a full copy of the statevector, so this is what bounds memory.
   */
  maxFrames?: number
  /**
   * Treat a POSTSELECT whose outcome cannot happen as a defined result rather
   * than an error: the op and everything after it are skipped, and the failure
   * is reported on `postselectionFailure`. Off by default, where it throws.
   */
  tolerateImpossiblePostselect?: boolean
}

/** A POSTSELECT that could not be applied because its outcome has probability ~0. */
export interface PostselectionFailure {
  /** Index of the op in circuit.ops. */
  op: number
  qubit: number
  value: 0 | 1
  message: string
}

export interface ExecuteResult {
  /** The state after the last op, normalized. */
  state: StateVector
  /** The classical register. Bits never written read 0. */
  clbits: number[]
  measurements: MeasurementRecord[]
  /** Indices of ops skipped because their condition was false. */
  skipped: number[]
  /** frames[0] is the initial state; frames[i + 1] is the state after op i. */
  frames?: StateVector[]
  /** Set only with `tolerateImpossiblePostselect`: the first impossible POSTSELECT. */
  postselectionFailure?: PostselectionFailure
}

/** Outcomes at or below this probability are treated as impossible by collapseQubit. */
const COLLAPSE_EPSILON = 1e-12

/** Probability that measuring qubit q gives `outcome`, on a (normalized) state. */
function outcomeProbability(sv: StateVector, q: number, outcome: 0 | 1): number {
  const p1 = sv.qubitProbability(q)
  return outcome === 1 ? p1 : 1 - p1
}

/**
 * Draw a measurement outcome, never picking one collapseQubit would refuse.
 * With p1 = 1e-14 and a draw of 0.5e-14 the plain `rng() < p1` rule picks an
 * outcome that cannot be projected onto; clamp to the other one instead.
 */
function drawOutcome(sv: StateVector, q: number, rng: () => number): { outcome: 0 | 1; p1: number } {
  const p1 = sv.qubitProbability(q)
  let outcome: 0 | 1 = rng() < p1 ? 1 : 0
  if (!(outcomeProbability(sv, q, outcome) > COLLAPSE_EPSILON)) outcome = outcome === 1 ? 0 : 1
  return { outcome, p1 }
}

/**
 * Run one trajectory: gates apply, measurements collapse and record, and a
 * conditioned gate runs only when its bit reads the value it asked for.
 *
 * A skipped op still produces a frame (a copy of the unchanged state), so
 * `frames[i + 1]` means "after op i" whether or not op i ran — the grid's step
 * highlight and column probe index straight into that array.
 */
export function execute(circuit: Circuit, options: ExecuteOptions = {}): ExecuteResult {
  const { rng = Math.random, forceOutcomes, collectFrames = false } = options
  const numClbits = classicalBitCount(circuit)
  const sv = new StateVector(circuit.numQubits)
  prepInitialStates(sv, circuit)
  const clbits = new Array<number>(numClbits).fill(0)
  const measurements: MeasurementRecord[] = []
  const skipped: number[] = []
  const frames: StateVector[] | undefined = collectFrames ? [sv.clone()] : undefined
  const maxFrames = options.maxFrames ?? Infinity
  const pushFrame = () => {
    if (frames && frames.length < maxFrames) frames.push(sv.clone())
  }
  let postselectionFailure: PostselectionFailure | undefined

  circuit.ops.forEach((op, i) => {
    // After an impossible POSTSELECT (tolerant mode) nothing more runs: the
    // state stays what it was before that op, and each remaining op only
    // contributes its frame so frames[i + 1] still means "after op i".
    if (postselectionFailure) {
      pushFrame()
      return
    }
    if (op.condition) {
      assertClbit(op.condition.bit, numClbits, 'condition bit')
      if (op.condition.value !== 0 && op.condition.value !== 1) {
        throw new Error(`condition value must be 0 or 1, got ${op.condition.value}`)
      }
      if (clbits[op.condition.bit] !== op.condition.value) {
        skipped.push(i)
        pushFrame()
        return
      }
    }

    if (op.name === 'MEASURE' && op.clbit !== undefined) {
      const q = op.qubits[0]
      assertClbit(op.clbit, numClbits, 'classical bit')
      const forced = forceOutcomes?.[op.clbit]
      const drawn = forced !== undefined ? null : drawOutcome(sv, q, rng)
      const p1 = drawn ? drawn.p1 : sv.qubitProbability(q)
      const outcome: 0 | 1 = forced !== undefined ? forced : drawn!.outcome
      // collapseQubit throws when the forced outcome cannot happen.
      sv.collapseQubit(q, outcome)
      clbits[op.clbit] = outcome
      measurements.push({ op: i, qubit: q, clbit: op.clbit, outcome, p1 })
    } else if (op.name === 'RESET') {
      // Measure, then flip back to |0⟩ if the outcome was 1. No clbit is
      // written — RESET has none — so this is not recorded as a measurement,
      // but the trajectory it takes IS random, same coin as a MEASURE.
      const q = op.qubits[0]
      const { outcome } = drawOutcome(sv, q, rng)
      sv.collapseQubit(q, outcome)
      if (outcome === 1) sv.applySingle('X', q)
    } else if (op.name === 'POSTSELECT') {
      // Deterministic projection. Let collapseQubit throw when the chosen
      // outcome has ~0 probability — on a single trajectory, "this run's
      // postselection failed" is correct, expected behaviour, not a bug.
      const q = op.qubits[0]
      const value = op.postselectValue as 0 | 1
      if (options.tolerateImpossiblePostselect && !(outcomeProbability(sv, q, value) > COLLAPSE_EPSILON)) {
        postselectionFailure = {
          op: i,
          qubit: q,
          value,
          message: `Postselect q${q} = |${value}⟩ (step ${i + 1}) is impossible here: that outcome has probability 0, so the circuit cannot continue past it.`,
        }
      } else {
        sv.collapseQubit(q, value)
      }
    } else {
      // A conditioned op reaches apply() with its condition already satisfied,
      // so strip it rather than trip apply()'s guard.
      sv.apply(op.condition ? { ...op, condition: undefined } : op)
    }
    pushFrame()
  })

  sv.normalize()
  return { state: sv, clbits, measurements, skipped, frames, postselectionFailure }
}

/** One leaf of the measurement tree: a classical register and the state that goes with it. */
export interface OutcomeBranch {
  /** The classical register on this branch. */
  clbits: number[]
  /** Probability of taking this branch. The branches sum to 1. */
  probability: number
  /** The (pure, normalized) state at the end of this branch. */
  state: StateVector
}

/** Branches below this probability are dropped rather than carried as noise. */
const BRANCH_EPSILON = 1e-15
/** 2^12 leaves. Past this, enumeration stops being the cheap way to be exact. */
const MAX_BRANCHES = 4096
/**
 * Bytes of statevector the branch tree may hold at once (each branch owns a
 * 16 * 2^n byte copy). The count cap alone is not a memory bound: 4096 branches
 * at 16 qubits is 4 GiB. The live set can briefly reach twice the cap (the
 * branches being split plus their children), so the real peak is ~2x this.
 */
const BRANCH_BYTE_BUDGET = 32 * 1024 * 1024

/** Most branches enumeration may keep alive for `numQubits` qubits. */
export function branchLimit(numQubits: number, requested: number = MAX_BRANCHES): number {
  const bytesPerBranch = 16 * 2 ** numQubits
  return Math.max(1, Math.min(requested, Math.floor(BRANCH_BYTE_BUDGET / bytesPerBranch)))
}

/** Thrown by outcomeBranches() when the tree outgrows its branch or memory bound. */
export class BranchLimitError extends Error {
  constructor(readonly limit: number) {
    super(`circuit has more than ${limit} measurement branches; sample with execute() instead`)
    this.name = 'BranchLimitError'
  }
}

/**
 * Enumerate every measurement outcome with its exact probability.
 *
 * This is the deterministic, analytic counterpart to `execute()`: no rng, no
 * sampling error. A circuit with m recorded measurements has at most 2^m
 * branches, so this is only viable while m stays small — which it does for
 * every protocol on this site (teleportation has two). It throws past
 * MAX_BRANCHES rather than quietly grinding, and callers that might exceed it
 * sample trajectories instead.
 *
 * Branches are returned in a stable order (outcome 0 explored before 1 at every
 * measurement), so a UI can index into them and a test can pin them.
 */
export function outcomeBranches(
  circuit: Circuit,
  options: { maxBranches?: number } = {}
): OutcomeBranch[] {
  const maxBranches = branchLimit(circuit.numQubits, options.maxBranches ?? MAX_BRANCHES)
  const numClbits = classicalBitCount(circuit)

  type Partial = { state: StateVector; clbits: number[]; probability: number }
  const initialState = new StateVector(circuit.numQubits)
  prepInitialStates(initialState, circuit)
  let live: Partial[] = [
    { state: initialState, clbits: new Array<number>(numClbits).fill(0), probability: 1 },
  ]

  circuit.ops.forEach((op) => {
    const next: Partial[] = []
    for (const branch of live) {
      if (op.condition) {
        assertClbit(op.condition.bit, numClbits, 'condition bit')
        if (branch.clbits[op.condition.bit] !== op.condition.value) {
          next.push(branch)
          continue
        }
      }
      if (op.name === 'MEASURE' && op.clbit !== undefined) {
        assertClbit(op.clbit, numClbits, 'classical bit')
        const p1 = branch.state.qubitProbability(op.qubits[0])
        for (const outcome of [0, 1] as const) {
          const p = outcome === 1 ? p1 : 1 - p1
          const weight = branch.probability * p
          // `p` is the same quantity collapseQubit tests, against its own
          // threshold; skipping here keeps the two from disagreeing.
          if (weight <= BRANCH_EPSILON || !(p > COLLAPSE_EPSILON)) continue
          if (next.length >= maxBranches) throw new BranchLimitError(maxBranches)
          const state = branch.state.clone()
          state.collapseQubit(op.qubits[0], outcome)
          const clbits = branch.clbits.slice()
          clbits[op.clbit] = outcome
          next.push({ state, clbits, probability: weight })
        }
      } else if (op.name === 'RESET') {
        // Same branching shape as MEASURE-with-clbit — every outcome becomes
        // its own child branch, weighted by its probability — but RESET
        // writes no clbit, so `clbits` is carried through UNCHANGED (shared,
        // not copied: nothing downstream mutates a branch's clbits array in
        // place, every later MEASURE `.slice()`s before writing).
        const q = op.qubits[0]
        const p1 = branch.state.qubitProbability(q)
        for (const outcome of [0, 1] as const) {
          const p = outcome === 1 ? p1 : 1 - p1
          const weight = branch.probability * p
          if (weight <= BRANCH_EPSILON || !(p > COLLAPSE_EPSILON)) continue
          if (next.length >= maxBranches) throw new BranchLimitError(maxBranches)
          const state = branch.state.clone()
          state.collapseQubit(q, outcome)
          if (outcome === 1) state.applySingle('X', q)
          next.push({ state, clbits: branch.clbits, probability: weight })
        }
      } else if (op.name === 'POSTSELECT') {
        // Unlike RESET, only ONE outcome survives — the other world is
        // discarded outright, not carried forward as a branch. The dropped
        // weight is what the final renormalization step below corrects for.
        const q = op.qubits[0]
        const value = op.postselectValue as 0 | 1
        const p1 = branch.state.qubitProbability(q)
        const p = value === 1 ? p1 : 1 - p1
        if (p <= BRANCH_EPSILON || !(p > COLLAPSE_EPSILON)) continue // drop this branch entirely
        const state = branch.state.clone()
        state.collapseQubit(q, value) // renormalizes this branch's state
        next.push({ state, clbits: branch.clbits, probability: branch.probability * p })
      } else {
        branch.state.apply(op.condition ? { ...op, condition: undefined } : op)
        next.push(branch)
      }
    }
    live = next
  })

  // POSTSELECT's branch probabilities, as built above, are
  // P(this branch AND every postselection succeeded) — not conditioned on
  // success. The standard, correct convention for "the output distribution of
  // a postselected computation" is conditioned on success, so renormalize.
  if (circuit.ops.some((op) => op.name === 'POSTSELECT')) {
    const total = live.reduce((sum, b) => sum + b.probability, 0)
    if (!(total > BRANCH_EPSILON)) {
      throw new Error(
        'every postselection in this circuit is impossible from every branch (probability ~0); there is no conditional distribution to report'
      )
    }
    live = live.map((b) => ({ ...b, probability: b.probability / total }))
  }

  return live.map((b) => ({
    clbits: b.clbits,
    probability: b.probability,
    state: b.state.normalize(),
  }))
}

/**
 * Probability of each classical-register value, keyed MSB-first ("10" means
 * c1 = 1, c0 = 0 — the same bit order StateVector.label uses for qubits).
 */
export function clbitDistribution(branches: readonly OutcomeBranch[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const b of branches) {
    const key = b.clbits.map((v) => (v ? '1' : '0')).reverse().join('')
    out[key] = (out[key] ?? 0) + b.probability
  }
  return out
}

/**
 * Exact probability of each final basis state, averaged over every branch.
 *
 * The result of a circuit with measurements in it is a MIXED state, which no
 * statevector can represent — so this returns the observable thing (the
 * distribution) rather than pretending a single vector describes it.
 */
export function outcomeProbabilities(circuit: Circuit): number[] {
  const branches = outcomeBranches(circuit)
  const dim = 1 << circuit.numQubits
  const probs = new Array<number>(dim).fill(0)
  for (const b of branches) {
    const p = b.state.probabilities()
    for (let i = 0; i < dim; i++) probs[i] += b.probability * p[i]
  }
  return probs
}

/** Measurements that write a classical bit — the branching ones. */
export function recordedMeasurementCount(circuit: Circuit): number {
  return circuit.ops.filter((op) => op.name === 'MEASURE' && op.clbit !== undefined).length
}

/** 2^12 = MAX_BRANCHES. Past this, enumeration is replaced by sampling. */
const MAX_ENUMERABLE_MEASUREMENTS = 12

/**
 * Amplitude updates (trajectories x steps x 2^n) the sampled estimate may
 * spend. Measured at ~17M/s on a desktop core, so this is a couple of seconds
 * there; the number of trajectories shrinks to fit rather than the call running
 * for minutes. Circuits up to ~8 qubits keep the full max(256, shots)
 * trajectories; beyond that the estimate gets coarser as the register grows.
 */
const SAMPLED_WORK_BUDGET = 6e7

/** How many trajectories sampledProbabilities() may afford for this circuit. */
export function sampleBudget(circuit: Circuit, wanted: number): number {
  const workPerTrajectory = (circuit.ops.length + 1) * 2 ** circuit.numQubits
  return Math.max(1, Math.min(wanted, Math.floor(SAMPLED_WORK_BUDGET / workPerTrajectory)))
}

/**
 * Estimate the output distribution of a circuit with more measurements than
 * outcomeBranches() will enumerate, by averaging over independent trajectories.
 * Approximate by construction; used only where the exact path is out of reach.
 */
function sampledProbabilities(circuit: Circuit, samples: number, rng: () => number): number[] {
  const dim = 1 << circuit.numQubits
  const acc = new Array<number>(dim).fill(0)
  for (let s = 0; s < samples; s++) {
    const p = execute(circuit, { rng }).state.probabilities()
    for (let i = 0; i < dim; i++) acc[i] += p[i]
  }
  return acc.map((v) => v / samples)
}

/**
 * A seed derived from the circuit's own contents.
 *
 * `simulate()` has to return one statevector for a circuit whose result is
 * genuinely random, and React calls it on every render. Seeding from the
 * circuit makes that choice stable across renders (the inspector does not
 * flicker between branches while you drag an unrelated slider) while still
 * differing between circuits, so the displayed trajectory does not look
 * suspiciously like it is always the same outcome. Randomness the learner is
 * meant to SEE comes from run(), which samples properly.
 */
function circuitSeed(circuit: Circuit): number {
  let h = 0x811c9dc5
  const push = (n: number) => {
    h ^= n | 0
    h = Math.imul(h, 0x01000193)
  }
  push(circuit.numQubits)
  if (circuit.initialStates) {
    for (const [q, state] of Object.entries(circuit.initialStates)) {
      push(Number(q) * 17 + 3)
      for (let i = 0; i < state.length; i++) push(state.charCodeAt(i))
    }
  }
  for (const op of circuit.ops) {
    for (let i = 0; i < op.name.length; i++) push(op.name.charCodeAt(i))
    for (const q of op.qubits) push(q + 1)
    if (op.theta !== undefined) push(Math.round(op.theta * 1e6))
    if (op.clbit !== undefined) push(op.clbit * 31 + 7)
    if (op.condition) push(op.condition.bit * 131 + op.condition.value * 17)
    if (op.k !== undefined) push(op.k * 7 + 3)
    if (op.modulus !== undefined) push(op.modulus * 11 + 5)
    if (op.controls !== undefined) push(op.controls * 13 + 1)
    if (op.matrix) for (const z of op.matrix) { push(Math.round(z.re * 1e6)); push(Math.round(z.im * 1e6)) }
    if (op.phi !== undefined) push(Math.round(op.phi * 1e6) ^ 0x5a5a)
    if (op.lambda !== undefined) push(Math.round(op.lambda * 1e6) ^ 0xa5a5)
    if (op.postselectValue !== undefined) push(op.postselectValue * 97 + 41)
    if (op.extraControls) {
      for (const ec of op.extraControls) {
        push(ec.qubit * 211 + 3)
        push((ec.basis ?? 'Z').charCodeAt(0))
        push(ec.anti ? 1 : 0)
      }
    }
  }
  return h >>> 0
}

/**
 * Run the circuit and return the final statevector.
 *
 * Without classical control this is what it always was: gates only, MEASURE
 * ignored so the inspector can show the pre-measurement state.
 *
 * WITH classical control there is no such thing as "the" final statevector —
 * the circuit's result is a mixture — so this returns ONE trajectory, chosen
 * with a seed derived from the circuit so the choice is stable across renders.
 * For the exact answer use outcomeBranches() or outcomeProbabilities().
 */
export function simulate(circuit: Circuit): StateVector {
  if (hasClassicalControl(circuit)) {
    // An impossible POSTSELECT leaves the state as it was before that op
    // instead of throwing; simulateStepsChecked() is the call that says so.
    return execute(circuit, {
      rng: mulberry32(circuitSeed(circuit)),
      tolerateImpossiblePostselect: true,
    }).state
  }
  const sv = new StateVector(circuit.numQubits)
  prepInitialStates(sv, circuit)
  for (const op of circuit.ops) sv.apply(op)
  return sv.normalize()
}

/**
 * Bytes of frames simulateSteps() may hold. Every frame is a full 16 * 2^n byte
 * copy, so without this a long circuit on a wide register is gigabytes.
 */
const FRAME_BYTE_BUDGET = 192 * 1024 * 1024

/** Most frames (initial state included) simulateSteps() keeps for `numQubits`. */
export function frameLimit(numQubits: number): number {
  return Math.max(2, Math.floor(FRAME_BYTE_BUDGET / (16 * 2 ** numQubits)))
}

export interface StepsResult {
  /**
   * frames[0] is |0…0⟩ and frames[i + 1] is the state after op i. A prefix of
   * that list when `notice` says the circuit was too long to keep every frame.
   */
  frames: StateVector[]
  /** The state after the last op, whether or not every frame was kept. */
  finalState: StateVector
  /** A message for the person at the keyboard, or null when nothing is wrong. */
  notice: string | null
}

/**
 * simulateSteps() plus the things a page has to tell the user: a POSTSELECT
 * that cannot happen (the state stops evolving at that step) and a circuit too
 * long to keep every frame (the frames are cut off, the final state is not).
 */
export function simulateStepsChecked(circuit: Circuit): StepsResult {
  const limit = frameLimit(circuit.numQubits)
  const wanted = circuit.ops.length + 1
  let notice: string | null = null
  const truncated = wanted > limit
  if (truncated) {
    notice = `This circuit has ${circuit.ops.length} steps; step-through is limited to the first ${limit - 1} at ${circuit.numQubits} qubits. The final state is still exact.`
  }

  if (hasClassicalControl(circuit)) {
    // Same seed as simulate(), so the last frame IS what the inspector shows.
    const result = execute(circuit, {
      rng: mulberry32(circuitSeed(circuit)),
      collectFrames: true,
      maxFrames: limit,
      tolerateImpossiblePostselect: true,
    })
    if (result.postselectionFailure) notice = result.postselectionFailure.message
    return { frames: result.frames ?? [result.state], finalState: result.state, notice }
  }
  const sv = new StateVector(circuit.numQubits)
  prepInitialStates(sv, circuit)
  const frames: StateVector[] = [sv.clone()]
  for (const op of circuit.ops) {
    sv.apply(op)
    if (frames.length < limit) frames.push(sv.clone())
  }
  // simulate() normalizes; the frames are the raw per-step states.
  return { frames, finalState: truncated ? sv.normalize() : frames[frames.length - 1], notice }
}

/** Statevector after each step — used to animate circuit execution. */
export function simulateSteps(circuit: Circuit): StateVector[] {
  return simulateStepsChecked(circuit).frames
}

export interface RunResult {
  counts: Record<string, number>
  probabilities: number[]
  labels: string[]
  shots: number
  statevector: Complex[]
}

/**
 * Sample measurement outcomes from the circuit's final state.
 * If `noise` > 0, each measured bit is flipped with that probability —
 * a crude but pedagogically useful stand-in for hardware decoherence.
 *
 * With classical control the distribution is NOT `simulate().probabilities()` —
 * that is one branch out of several, so sampling from it would report a
 * teleportation circuit as though its Bell measurement always came out the same
 * way. The exact mixture from outcomeBranches() is used instead, and
 * `statevector` then carries the same single display trajectory `simulate()`
 * returns, which is a branch and not the mixture. It is here for the inspector,
 * not for arithmetic.
 */
export function run(circuit: Circuit, shots = 1024, noise = 0, seed?: number): RunResult {
  const sv = simulate(circuit)
  const rng = seed === undefined ? Math.random : mulberry32(seed)
  let probs: number[]
  if (!hasClassicalControl(circuit)) {
    probs = sv.probabilities()
  } else {
    let exact: number[] | null = null
    if (recordedMeasurementCount(circuit) <= MAX_ENUMERABLE_MEASUREMENTS) {
      try {
        exact = outcomeProbabilities(circuit)
      } catch (e) {
        // RESET also forks, and the memory bound is lower at wide registers, so
        // a circuit that looked enumerable by its measurement count can still
        // outgrow the tree. Sample it; any other error is a real one.
        if (!(e instanceof BranchLimitError)) throw e
      }
    }
    // Too many branches to enumerate: estimate the mixture from trajectories
    // instead. Approximate — but the shape of the answer is right, which
    // sampling one branch would not be.
    probs = exact ?? sampledProbabilities(circuit, sampleBudget(circuit, Math.max(256, shots)), rng)
  }
  const labels = probs.map((_, i) => sv.label(i))

  // Cumulative distribution for inverse-transform sampling
  const cdf: number[] = []
  let acc = 0
  for (const p of probs) { acc += p; cdf.push(acc) }

  const counts: Record<string, number> = {}
  for (let s = 0; s < shots; s++) {
    const u = rng() * acc
    let lo = 0, hi = cdf.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < u) lo = mid + 1
      else hi = mid
    }
    let idx = lo
    if (noise > 0) {
      for (let q = 0; q < circuit.numQubits; q++) {
        if (rng() < noise) idx ^= 1 << q
      }
    }
    const key = sv.label(idx)
    counts[key] = (counts[key] ?? 0) + 1
  }

  return { counts, probabilities: probs, labels, shots, statevector: sv.amplitudes() }
}

/** Deterministic PRNG so demos and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Standard normal by Box–Muller from a uniform generator. Consumes exactly
 * two draws (the first is re-drawn only on the 2^-32 chance it is 0, since
 * log(0) is −∞). Shared by every workbench module that adds Gaussian noise.
 */
export function gaussian(rng: () => number): number {
  let u = rng()
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ────────────────────────────────────────────────────────────
// OpenQASM 3 export / import
// ────────────────────────────────────────────────────────────

const QASM_NAMES: Partial<Record<GateName, string>> = {
  H: 'h', X: 'x', Y: 'y', Z: 'z', S: 's', SDG: 'sdg', T: 't', TDG: 'tdg',
  RX: 'rx', RY: 'ry', RZ: 'rz', P: 'p',
  CX: 'cx', CY: 'cy', CZ: 'cz', SWAP: 'swap', CCX: 'ccx',
  SX: 'sx', SXDG: 'sxdg', CSWAP: 'cswap',
}

/**
 * Gates the exporter must DEFINE before it can call them.
 *
 * stdgates.inc has no sxdg (Qiskit's exporter defines it too), and nothing in
 * OpenQASM names "add 7 mod 15" — so every block, and every custom matrix, is
 * emitted as a `gate` definition whose body is real stdgates code (a
 * multi-controlled-X ladder for a permutation, the H/cp ladder for the QFT, a
 * Givens synthesis for a 4×4). Another simulator runs the body; this module's
 * own importer recognises the NAME and rebuilds the block from it, which is
 * what makes the round trip exact rather than a pile of ctrl(3) @ x ops.
 */
const SXDG_DEF = 'gate sxdg a { h a; sdg a; h a; }'

/** Normalise k into [0, N) so the def name is canonical. */
const canonicalK = (k: number, modulus: number) => ((k % modulus) + modulus) % modulus

function blockGateName(op: GateOp, width: number): string {
  switch (op.name) {
    case 'ADDK': return `qb16_add_${canonicalK(op.k as number, op.modulus as number)}_mod_${op.modulus}_w${width}`
    case 'MULK': return `qb16_mul_${canonicalK(op.k as number, op.modulus as number)}_mod_${op.modulus}_w${width}`
    case 'QFT':  return `qb16_qft_w${width}`
    case 'IQFT': return `qb16_iqft_w${width}`
    default: throw new Error(`${op.name} is not a register block`)
  }
}

function blockGateDef(op: GateOp, width: number): string {
  const name = blockGateName(op, width)
  const operands = Array.from({ length: width }, (_, i) => `r${i}`).join(', ')
  const body =
    op.name === 'QFT' || op.name === 'IQFT'
      ? qftToQasmBody(width, op.name === 'IQFT', formatAngle)
      : permutationToQasmBody(blockPermutation(op, width), width)
  return `gate ${name} ${operands} { ${body.join(' ')} }`
}

/** The trailing annotation that lets fromQasm rebuild a custom matrix exactly. */
function unitaryAnnotation(op: GateOp): string {
  const matrix = (op.matrix as Complex[]).map((z) => [z.re, z.im])
  return `// qubit16 ${JSON.stringify({ label: op.label ?? 'U', matrix })}`
}

/** Parse a `qb16_*` gate name back into the op it encodes, or null. */
function parseBlockGateName(name: string): Pick<GateOp, 'name' | 'k' | 'modulus'> & { width: number } | null {
  const arith = name.match(/^qb16_(add|mul)_(\d+)_mod_(\d+)_w(\d+)$/)
  if (arith) {
    return {
      name: arith[1] === 'add' ? 'ADDK' : 'MULK',
      k: parseInt(arith[2], 10),
      modulus: parseInt(arith[3], 10),
      width: parseInt(arith[4], 10),
    }
  }
  const qft = name.match(/^qb16_(qft|iqft)_w(\d+)$/)
  if (qft) return { name: qft[1] === 'qft' ? 'QFT' : 'IQFT', width: parseInt(qft[2], 10) }
  return null
}

/**
 * Serialise a rotation angle without losing precision.
 *
 * Angles are almost always rational multiples of π, so emit them that way when
 * we can — `ry(pi/3)` is both exact and readable. Otherwise fall back to a
 * round-trip-safe decimal. A fixed number of decimal places would silently
 * change the physics: `(π/3).toFixed(6)` shifts a teleportation circuit's
 * probabilities by ~5e-8 on every export/import cycle.
 *
 * The fraction match is a snap, not an equality test: an angle within 1e-12
 * (on ratio*d) of n*π/d is written as that fraction, so an angle that close to
 * a fraction but not equal to it moves by up to π*1e-12 ≈ 3.2e-12 rad on the
 * round trip. That is deliberate — it keeps `pi/3` readable when the angle was
 * accumulated by a slider — and it is four orders of magnitude below the
 * 1e-8-scale drift it replaced. Exactness for the fractions themselves is
 * still bit-for-bit, and that is what the round-trip tests assert.
 *
 * The pi form is what Qiskit's own qasm3.dumps emits, but services/api cannot
 * parse it today: qiskit_qasm3_import is missing from its requirements.txt and
 * Qiskit's native OpenQASM 3 parser folds no arithmetic in an angle. See
 * services/api/tests/test_js_crosscheck.py. Emitting decimals here would work
 * around that at the cost of readability; the parser is the wrong side to fix.
 */
function formatAngle(theta: number): string {
  // `String(NaN)` is "NaN" and `String(Infinity)` is "Infinity"; both used to
  // be emitted straight into the QASM, producing a file no parser accepts and
  // that this module's own fromQasm() silently read back as 0.
  if (!Number.isFinite(theta)) throw new Error(`angle must be finite, got ${theta}`)
  if (theta === 0) return '0'
  const ratio = theta / Math.PI
  for (const d of [1, 2, 3, 4, 6, 8, 12, 16]) {
    const n = ratio * d
    const rounded = Math.round(n)
    if (rounded !== 0 && Math.abs(n - rounded) < 1e-12) {
      const num = rounded === 1 ? 'pi' : rounded === -1 ? '-pi' : `${rounded}*pi`
      return d === 1 ? num : `${num}/${d}`
    }
  }
  // Shortest decimal that parses back to exactly the same double.
  return String(theta)
}

/** The computational-basis bit a control must read AFTER any basis-change gate — see applyExtraControls's doc comment. */
function requiredBitForQasm(basis: 'X' | 'Y' | 'Z', anti: boolean): 0 | 1 {
  if (basis === 'Z') return anti ? 0 : 1
  return anti ? 1 : 0
}

/**
 * QASM for `op.extraControls`, applied to a base gate call already formatted
 * with its angle (e.g. "h", "rx(pi/2)", "U(pi/2, 0, pi)").
 *
 * A Z-basis control has a real OpenQASM 3 modifier (`ctrl @` / `negctrl @`),
 * chained one per control with the controls listed before the target — this
 * is what the spec calls out as the common case, and it round-trips exactly
 * through fromQasm()'s own modifier-chain parsing below.
 *
 * An X or Y basis control has no native modifier, so it is COMPILED DOWN:
 * the basis-change gate(s), the Z-basis-reduced ctrl/negctrl call, and the
 * undo gate(s), as separate, literal QASM lines — valid, executable OpenQASM
 * that another tool can run. fromQasm() reads those lines back as ordinary
 * gates plus one Z-basis extraControls op, NOT as the original single
 * X/Y-basis op: that high-level information is legitimately lost once
 * compiled to standard gates (the same honesty tradeoff as the POSTSELECT
 * comment-encoding below). Only the all-Z-basis case is guaranteed to
 * round-trip as a single high-level op.
 */
/** How many basis-change lines extraControlledQasmLines writes AFTER the call. */
function extraControlPostLines(extraControls: NonNullable<GateOp['extraControls']>): number {
  return extraControls.reduce((n, ec) => n + (ec.basis === 'X' ? 1 : ec.basis === 'Y' ? 2 : 0), 0)
}

function extraControlledQasmLines(
  extraControls: NonNullable<GateOp['extraControls']>,
  target: number,
  gateCall: string,
): string[] {
  const pre: string[] = []
  const post: string[] = []
  const mods: string[] = []
  const controlArgs: string[] = []
  for (const ec of extraControls) {
    const basis = ec.basis ?? 'Z'
    const anti = ec.anti ?? false
    if (basis === 'X') {
      pre.push(`h q[${ec.qubit}];`)
      post.unshift(`h q[${ec.qubit}];`)
    } else if (basis === 'Y') {
      pre.push(`sdg q[${ec.qubit}];`, `h q[${ec.qubit}];`)
      post.unshift(`h q[${ec.qubit}];`, `s q[${ec.qubit}];`)
    }
    const bit = requiredBitForQasm(basis, anti)
    mods.push(bit === 1 ? 'ctrl @' : 'negctrl @')
    controlArgs.push(`q[${ec.qubit}]`)
  }
  const call = `${mods.join(' ')} ${gateCall} ${[...controlArgs, `q[${target}]`].join(', ')};`
  return [...pre, call, ...post]
}

export function toQasm(circuit: Circuit): string {
  // At least one bit per qubit: the file ends with `c = measure q;`, which
  // writes the whole register, and a `bit[2] c` beside a `qubit[3] q` is a
  // width mismatch no OpenQASM parser accepts.
  const numClbits = Math.max(classicalBitCount(circuit), circuit.numQubits)
  const header = [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
  ]
  // Definitions the body needs, in first-use order, each emitted once.
  const defs = new Map<string, string>()
  const lines: string[] = [
    '',
    `qubit[${circuit.numQubits}] q;`,
    `bit[${numClbits}] c;`,
    '',
  ]
  // The high-level "start this qubit in |+⟩" picker has no OpenQASM
  // equivalent, so it is folded into the literal prep gates it means — an
  // exported circuit reproduces the exact physical state, even though the
  // "this was chosen from a picker" metadata does not survive the round trip.
  if (circuit.initialStates) {
    for (const q of Object.keys(circuit.initialStates).map(Number).sort((a, b) => a - b)) {
      const state = circuit.initialStates[q]
      for (const gate of INITIAL_STATE_PREP[state]) lines.push(`${QASM_NAMES[gate]} q[${q}];`)
    }
  }
  let unitaryCount = 0
  const unitaryNames = new Map<string, string>()
  /**
   * The `qb16_uN` gate for a custom matrix, defined once per distinct matrix.
   * Its body carries the matrix's global phase (`gphase`), which is what makes
   * it safe to put behind `ctrl @`: under a control that phase is a relative
   * phase, not a global one.
   */
  const unitaryGateName = (matrix: Complex[]): string => {
    const width = unitaryQubitCount(matrix)
    const err = unitarityError(matrix)
    if (!(err <= UNITARY_TOLERANCE)) {
      throw new Error(`custom matrix is not unitary (‖U†U − I‖ = ${err.toExponential(2)})`)
    }
    const key = JSON.stringify(matrix.map((z) => [z.re, z.im]))
    let name = unitaryNames.get(key)
    if (!name) {
      name = `qb16_u${unitaryCount++}`
      unitaryNames.set(key, name)
      const gateBody =
        width === 1 ? oneQubitToQasmBody(matrix, formatAngle) : twoQubitToQasmBody(matrix, formatAngle)
      defs.set(name, `gate ${name} ${width === 1 ? 'a' : 'a, b'} { ${gateBody.join(' ')} }`)
    }
    return name
  }
  for (const op of circuit.ops) {
    if (op.name === 'BARRIER') { lines.push('barrier q;'); continue }
    // A MEASURE that records into a classical bit IS the circuit — drop it and
    // every conditional below it becomes a gate that reads a bit nobody wrote.
    // A MEASURE with no clbit is still dropped: the file ends with a
    // measure-all, and the API's runner (_ensure_measured) needs every qubit
    // measured to return counts. Round-tripping a circuit therefore loses its
    // bare MEASURE ops — the statevector is identical, the op list is not.
    // (Barriers DO survive: `barrier q;` is written and read back.)
    if (op.name === 'MEASURE') {
      if (op.clbit !== undefined) lines.push(`c[${op.clbit}] = measure q[${op.qubits[0]}];`)
      continue
    }
    // POSTSELECT has no OpenQASM equivalent — it is idealized and
    // simulator-only (see the doc comment on ExecuteOptions.forceOutcomes and
    // on the POSTSELECT GATE_LIBRARY entry). Documented as a comment in our
    // own, clearly-marked format; fromQasm() below recognises EXACTLY this
    // format on re-import and does not attempt to guess postselection
    // semantics from any other tool's QASM. (A conditioned POSTSELECT is not
    // representable this way — the comment carries no classical-control
    // wrapper — so the condition is dropped from the export; a rare enough
    // combination that this is documented rather than solved.)
    if (op.name === 'POSTSELECT') {
      lines.push(`// qubit16:postselect q[${op.qubits[0]}]==${op.postselectValue} (idealized, simulator-only, not standard OpenQASM)`)
      continue
    }
    const args = op.qubits.map((i) => `q[${i}]`).join(', ')
    let body: string
    let trailer = ''
    if (op.extraControls && op.extraControls.length) {
      // See extraControlledQasmLines's doc comment for the Z vs X/Y-basis
      // round-trip tradeoff.
      const gateCall =
        op.name === 'U3'
          ? `U(${formatAngle(op.theta ?? 0)}, ${formatAngle(op.phi ?? 0)}, ${formatAngle(op.lambda ?? 0)})`
          : op.name === 'UNITARY'
            ? (() => {
                if (op.qubits.length !== 1) throw new Error('extraControls needs a 1-qubit UNITARY')
                // NOT a bare `U(θ,φ,λ)`: that drops the matrix's global phase,
                // which under a control becomes a relative phase — the exported
                // circuit then computed a different state from the simulator
                // (fidelity as low as 0.02 against Qiskit). The named gate keeps
                // `gphase(γ)` in its body, so `ctrl @` controls it too.
                return unitaryGateName(op.matrix as Complex[])
              })()
            : (() => {
                const g = QASM_NAMES[op.name]
                if (!g) throw new Error(`${op.name} does not export to QASM`)
                if (op.name === 'SXDG' && !defs.has('sxdg')) defs.set('sxdg', SXDG_DEF)
                return op.theta !== undefined && ['RX', 'RY', 'RZ', 'P'].includes(op.name)
                  ? `${g}(${formatAngle(op.theta)})`
                  : g
              })()
      const controlled = extraControlledQasmLines(op.extraControls, op.qubits[0], gateCall)
      // The matrix rides on the controlled call's own line, where fromQasm reads it.
      if (op.name === 'UNITARY') controlled[controlled.length - 1 - extraControlPostLines(op.extraControls)] += ` ${unitaryAnnotation(op)}`
      for (const l of controlled) lines.push(l)
      continue
    } else if (op.name === 'RESET') {
      // A real OpenQASM 3 statement — no compilation needed. Routed through
      // the common `body` path (rather than an early continue, like MEASURE
      // and POSTSELECT above) so a conditioned RESET still gets the
      // `if (...) { reset q[i]; }` wrapper below.
      body = `reset q[${op.qubits[0]}];`
    } else if (op.name === 'U3') {
      body = `U(${formatAngle(op.theta ?? 0)}, ${formatAngle(op.phi ?? 0)}, ${formatAngle(op.lambda ?? 0)}) ${args};`
    } else if (op.name === 'MCX') {
      // The spec's own form for "any number of controls": a gate modifier.
      if (op.qubits.length < 2) throw new Error('MCX needs at least one control and a target')
      body = `ctrl(${op.qubits.length - 1}) @ x ${args};`
    } else if (op.name === 'UNITARY') {
      const width = unitaryQubitCount(op.matrix)
      if (op.qubits.length !== width) {
        throw new Error(`this ${width}-qubit matrix needs ${width} qubit(s), got ${op.qubits.length}`)
      }
      body = `${unitaryGateName(op.matrix as Complex[])} ${args};`
      trailer = ` ${unitaryAnnotation(op)}`
    } else if (BLOCK_GATES.has(op.name)) {
      const { controls, register } = splitBlockOperands(op)
      const name = blockGateName(op, register.length)
      if (!defs.has(name)) defs.set(name, blockGateDef(op, register.length))
      const modifier = controls.length > 0 ? `ctrl(${controls.length}) @ ` : ''
      body = `${modifier}${name} ${args};`
    } else {
      const g = QASM_NAMES[op.name]
      if (!g) continue
      if (op.name === 'SXDG' && !defs.has('sxdg')) defs.set('sxdg', SXDG_DEF)
      body =
        op.theta !== undefined && ['RX', 'RY', 'RZ', 'P'].includes(op.name)
          ? `${g}(${formatAngle(op.theta)}) ${args};`
          : `${g} ${args};`
    }
    /*
     * A conditioned gate, braced, comparing the bit against a BOOLEAN.
     *
     * `if (c[0] == 1) x q[2];` is what this emitted first, and it reads fine —
     * but no Qiskit parser accepts it, so every circuit with classical control
     * was rejected by services/api the moment it was posted: qiskit_qasm3_import
     * answers "conditions must be 'bit == const bool' or 'bitarray == const
     * int', not 'bit == const int'", and Qiskit's native reader answers
     * "expected a block". A single `bit` compares against `true`/`false`; only
     * a whole bit REGISTER compares against an integer. The braces are the
     * other half of that fix and are what qiskit.qasm3.dumps emits.
     *
     * services/api/tests/test_js_random_crosscheck.py parses every circuit this
     * function produces and fails on any the service cannot read, which is how
     * the original form was caught.
     */
    lines.push(
      (op.condition
        ? `if (c[${op.condition.bit}] == ${op.condition.value === 1 ? 'true' : 'false'}) { ${body} }`
        : body) + trailer,
    )
  }
  // Unconditional measure-all. Both arms of the ternary that used to sit here
  // were the same string; the behaviour is kept, not the pretence of a choice.
  lines.push('', 'c = measure q;')
  return [...header, ...(defs.size ? ['', ...defs.values()] : []), ...lines].join('\n')
}

/** Longest QASM line fromQasm will read; anything longer is skipped. */
const MAX_QASM_LINE_CHARS = 4096

/**
 * Minimal OpenQASM parser — enough for circuits this app produces.
 *
 * Total by contract: garbage in gives an empty circuit, never a throw. Three
 * call sites (app/circuits/page.tsx, components/circuit/SaveLoadPanel.tsx,
 * lib/share-link.ts) call it during render with no try/catch, so a throw here
 * is a blank page. Instructions the simulator would now reject — a repeated
 * qubit as in `cx q[0], q[0];`, or the wrong operand count — are dropped here
 * instead, which is why an imported circuit can have fewer ops than the file
 * has lines. If you make this stricter, make those call sites catch first.
 */
export function fromQasm(qasm: string): Circuit {
  const reverse: Record<string, GateName> = Object.fromEntries(
    Object.entries(QASM_NAMES).map(([k, v]) => [v as string, k as GateName])
  )
  let numQubits = 0
  let numClbits = 0
  const ops: GateOp[] = []

  /**
   * A custom-matrix annotation (`// qubit16 {...}`) on the current line, if
   * any. Read before the comment is stripped; the matrix has no other home in
   * the file, since the gate body is a decomposition other tools run.
   */
  let annotation: { label?: string; matrix?: unknown } | null = null

  /** The current line's annotation matrix, validated as a 2×2 or 4×4 unitary, or null. */
  const annotationMatrix = (): Complex[] | null => {
    const ann = annotation
    if (!ann || !Array.isArray(ann.matrix)) return null
    const matrix: Complex[] = []
    for (const entry of ann.matrix as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) return null
      const [re, im] = entry as unknown[]
      if (typeof re !== 'number' || typeof im !== 'number' || !Number.isFinite(re) || !Number.isFinite(im)) return null
      matrix.push({ re, im })
    }
    if (matrix.length !== 4 && matrix.length !== 16) return null
    if (!(unitarityError(matrix) <= UNITARY_TOLERANCE)) return null
    return matrix
  }
  const annotationLabel = (): string =>
    annotation && typeof annotation.label === 'string' ? annotation.label.slice(0, 12) : 'U'

  /** Parse one gate statement (no `if`, no trailing semicolon). */
  const parseGate = (stmt: string): GateOp | null => {
    // Gate modifier chain: `ctrl(k) @ x …` is a multi-controlled X (backward
    // compatible with what this exporter has always written); `ctrl(k) @
    // qb16_… …` is a controlled block; one or more `ctrl(k) @` / `negctrl(k)
    // @` in front of an ORDINARY single-qubit gate name (or `U`/`u3`) is our
    // OWN Z-basis-extraControls export, round-tripped back into a single
    // extraControls op below. Only ctrl/negctrl are read — inv/pow are not
    // something this app writes.
    const mods: { neg: boolean; count: number }[] = []
    let rest = stmt
    for (;;) {
      const m = rest.match(/^(negctrl|ctrl)(?:\((\d+)\))?\s*@\s*(.+)$/i)
      if (!m) break
      mods.push({ neg: m[1].toLowerCase() === 'negctrl', count: m[2] ? parseInt(m[2], 10) : 1 })
      rest = m[3]
    }
    const totalMods = mods.reduce((s, x) => s + x.count, 0)
    const core = rest
    const m = core.match(/^(\w+)(?:\(([^)]*)\))?\s+(.*)$/)
    if (!m) return null
    const qubits = Array.from(m[3].matchAll(/\[(\d+)\]/g)).map((x) => parseInt(x[1], 10))
    if (!qubits.length) return null
    const distinct = new Set(qubits).size === qubits.length
    const lower = m[1].toLowerCase()

    const blockOp = (controlCount: number): GateOp | null => {
      const block = parseBlockGateName(lower)
      if (!block || !distinct || qubits.length !== controlCount + block.width) return null
      const op: GateOp = { name: block.name, qubits }
      if (block.k !== undefined) op.k = block.k
      if (block.modulus !== undefined) op.modulus = block.modulus
      if (controlCount > 0) op.controls = controlCount
      return op
    }

    /** theta/phi/lambda for a `U(...)`/`u3(...)` core, or a single theta otherwise. */
    const angleArgsOf = (name: GateName): { theta?: number; phi?: number; lambda?: number } | null => {
      if (name === 'U3') {
        const parts = (m[2] ?? '').split(',').map((s) => s.trim())
        if (parts.length !== 3) return null
        return { theta: evalAngle(parts[0]), phi: evalAngle(parts[1]), lambda: evalAngle(parts[2]) }
      }
      return { theta: m[2] ? evalAngle(m[2]) : undefined }
    }

    if (totalMods > 0) {
      if (!distinct || qubits.length <= totalMods) return null
      // Backward compatible: a single positive ctrl on plain X is MCX, and on
      // a qb16_ block name is a controlled block — neither ever carries a
      // negctrl or a mixed chain, since this exporter never wrote one for
      // those two forms.
      if (mods.length === 1 && !mods[0].neg) {
        if (lower === 'x') return { name: 'MCX', qubits }
        const block = blockOp(totalMods)
        if (block) return block
      }
      // Otherwise: an ordinary single-qubit gate (or U3, or one of our own
      // 1-qubit qb16_uN custom matrices) with Z-basis extraControls — our own
      // compiled-down export, reduced back to one op.
      if (/^qb16_u\d+$/.test(lower)) {
        const matrix = annotationMatrix()
        if (!matrix || matrix.length !== 4 || qubits.length !== totalMods + 1) return null
        const target = qubits[qubits.length - 1]
        const extraControls = mods.flatMap((mod, mi) =>
          Array.from({ length: mod.count }, (_, k) => ({
            qubit: qubits[mods.slice(0, mi).reduce((n, x) => n + x.count, 0) + k],
            anti: mod.neg,
          })),
        )
        return { name: 'UNITARY', qubits: [target], matrix, label: annotationLabel(), extraControls }
      }
      const gname = lower === 'u' || lower === 'u3' ? 'U3' : reverse[lower]
      if (!gname) return null
      if ((GATE_BY_NAME[gname]?.arity ?? 1) !== 1) return null
      const target = qubits[qubits.length - 1]
      const controlQubits = qubits.slice(0, totalMods)
      let idx = 0
      const extraControls: NonNullable<GateOp['extraControls']> = []
      for (const mod of mods) {
        for (let k = 0; k < mod.count; k++) {
          // ctrl @ fires when the control reads 1 (anti=false); negctrl @
          // fires when it reads 0 (anti=true) — both are Z-basis, exactly the
          // inverse of requiredBitForQasm's mapping for basis 'Z'.
          extraControls.push({ qubit: controlQubits[idx], anti: mod.neg })
          idx++
        }
      }
      const angles = angleArgsOf(gname)
      if (!angles) return null
      return { name: gname, qubits: [target], extraControls, ...angles }
    }

    if (lower.startsWith('qb16_') && !/^qb16_u\d+$/.test(lower)) return blockOp(0)
    if (/^qb16_u\d+$/.test(lower)) {
      // Rebuilt from the annotation only; a hand-edited file without one is
      // dropped rather than guessed at.
      const matrix = annotationMatrix()
      if (!matrix || !distinct) return null
      if ((matrix.length === 4 && qubits.length !== 1) || (matrix.length === 16 && qubits.length !== 2)) return null
      return { name: 'UNITARY', qubits, matrix, label: annotationLabel() }
    }

    // U3: OpenQASM 3's own `U(theta, phi, lambda)`, or OpenQASM 2's `u3(...)`
    // spelling, read for compatibility. Always exported as `U(` — see toQasm.
    if (lower === 'u' || lower === 'u3') {
      if (!distinct || qubits.length !== 1) return null
      const angles = angleArgsOf('U3')
      if (!angles) return null
      return { name: 'U3', qubits, ...angles }
    }

    const name = reverse[lower]
    if (!name) return null
    const theta = m[2] ? evalAngle(m[2]) : undefined
    const arity = GATE_BY_NAME[name]?.arity ?? 1
    if (qubits.length !== arity) return null
    // SWAP is exempt: swap(q, q) is the identity, not an invalid gate.
    if (name !== 'SWAP' && !distinct) return null
    return theta === undefined ? { name, qubits } : { name, qubits, theta }
  }

  for (const raw of qasm.split('\n')) {
    // No statement this importer reads is anywhere near this long (the longest
    // legitimate line is a two-qubit UNITARY annotation, well under 1 KB). A
    // line past the cap is skipped like any other unrecognised line, which
    // keeps every regex below bounded on hostile input.
    if (raw.length > MAX_QASM_LINE_CHARS) continue
    const annMatch = raw.match(/\/\/\s*qubit16\s+(\{.*\})\s*$/)
    annotation = null
    if (annMatch) {
      try {
        const parsed: unknown = JSON.parse(annMatch[1])
        if (parsed && typeof parsed === 'object') annotation = parsed as { label?: string; matrix?: unknown }
      } catch {
        annotation = null
      }
    }
    // POSTSELECT has no OpenQASM statement — only our own comment encoding
    // (see toQasm). Checked against the RAW line (before comments are
    // stripped below, which would delete this entirely) and matched against
    // EXACTLY the format this module writes; a postselect comment from
    // anywhere else is not something this importer guesses at.
    const psMatch = raw.match(
      /\/\/\s*qubit16:postselect\s+q\[(\d+)\]==([01])\s*\(idealized, simulator-only, not standard OpenQASM\)/
    )
    if (psMatch) {
      const q = parseInt(psMatch[1], 10)
      numQubits = Math.max(numQubits, q + 1)
      ops.push({ name: 'POSTSELECT', qubits: [q], postselectValue: psMatch[2] === '1' ? 1 : 0 })
      continue
    }
    const line = raw.split('//')[0].trim().replace(/;$/, '')
    if (!line) continue

    const decl = line.match(/^qubit\[(\d+)\]/) ?? line.match(/^qreg\s+\w+\[(\d+)\]/)
    if (decl) { numQubits = Math.max(numQubits, parseInt(decl[1], 10)); continue }
    const cdecl = line.match(/^bit\[(\d+)\]/) ?? line.match(/^creg\s+\w+\[(\d+)\]/)
    if (cdecl) { numClbits = Math.max(numClbits, parseInt(cdecl[1], 10)); continue }
    // `gate name … { … }` definitions are skipped whole: the exporter writes
    // them for other tools, and the CALL is what this importer rebuilds from.
    if (/^(OPENQASM|include|bit|creg|gate\s)/.test(line)) continue
    if (/^barrier\b/.test(line)) {
      // Every barrier — full-register or partial — becomes the one BARRIER the
      // grid draws, a dashed line across every wire.
      ops.push({ name: 'BARRIER', qubits: [] })
      continue
    }
    const resetMatch = line.match(/^reset\s+\w+\[(\d+)\]$/i)
    if (resetMatch) {
      const q = parseInt(resetMatch[1], 10)
      numQubits = Math.max(numQubits, q + 1)
      ops.push({ name: 'RESET', qubits: [q] })
      continue
    }

    // ── A measurement that records a bit ──────────────────────────────────
    // `c[1] = measure q[1]` (OpenQASM 3) and `measure q[1] -> c[1]` (2.0).
    // Checked before the blanket `measure` skip below, which still swallows
    // the whole-register `c = measure q;` the exporter ends every file with.
    const assign = line.match(/^\w+\[(\d+)\]\s*=\s*measure\s+\w+\[(\d+)\]$/i)
    const legacy = line.match(/^measure\s+\w+\[(\d+)\]\s*->\s*\w+\[(\d+)\]$/i)
    const rec: [string, string] | null = assign
      ? [assign[1], assign[2]]
      : legacy
        ? [legacy[2], legacy[1]]
        : null
    if (rec) {
      const clbit = parseInt(rec[0], 10)
      const qubit = parseInt(rec[1], 10)
      numQubits = Math.max(numQubits, qubit + 1)
      numClbits = Math.max(numClbits, clbit + 1)
      ops.push({ name: 'MEASURE', qubits: [qubit], clbit })
      continue
    }
    if (/measure/.test(line)) continue

    // ── A gate conditioned on a classical bit ─────────────────────────────
    // `if (c[0] == true) { x q[2]; }` is what toQasm now writes and what Qiskit
    // emits. `== 1` is still read: it is what this app wrote before the boolean
    // form landed, so it is sitting in saved circuits and in shared links.
    // The prefix is matched with a regex and the body is peeled with plain
    // string operations: a lazy `(.+?)\s*\}?$` after it backtracks
    // quadratically on a long run of whitespace.
    const cond = line.match(/^if\s*\(\s*\w+\[(\d+)\]\s*==\s*(1|0|true|false)\s*\)/i)
    if (cond) {
      let body = line.slice(cond[0].length).trim()
      if (body.startsWith('{')) body = body.slice(1).trim()
      if (body.endsWith('}')) body = body.slice(0, -1).trim()
      if (!body) continue
      const inner = parseGate(body.replace(/;$/, '').trim())
      if (!inner) continue
      const bit = parseInt(cond[1], 10)
      numClbits = Math.max(numClbits, bit + 1)
      numQubits = Math.max(numQubits, ...inner.qubits.map((q) => q + 1))
      const truthy = cond[2] === '1' || cond[2].toLowerCase() === 'true'
      ops.push({ ...inner, condition: { bit, value: truthy ? 1 : 0 } })
      continue
    }

    const op = parseGate(line)
    if (!op) continue
    numQubits = Math.max(numQubits, ...op.qubits.map((q) => q + 1))
    ops.push(op)
  }

  const circuit: Circuit = { numQubits: Math.max(1, numQubits), ops }
  // Only carried when the file actually declares more bits than the derived
  // default would give, so a plain circuit round-trips to the same shape it had.
  if (numClbits > circuit.numQubits) circuit.numClbits = numClbits
  return circuit
}

/**
 * Evaluate a QASM gate angle: a chain of `*` and `/` over numbers and `pi`.
 *
 * Handles every form `formatAngle` emits (`pi`, `-pi`, `3*pi`, `pi/4`,
 * `2*pi/3`) as well as plain decimals from other toolchains. Evaluates
 * left to right, which is correct for a multiply/divide-only chain.
 */
function evalAngle(expr: string): number {
  const s = expr.trim().toLowerCase()
  if (!s) return 0

  const tokens = s.split(/\s*([*/])\s*/).filter((t) => t.length > 0)
  if (!tokens.length) return 0

  const valueOf = (tok: string): number => {
    const t = tok.trim()
    if (t === 'pi' || t === '+pi') return Math.PI
    if (t === '-pi') return -Math.PI
    const v = parseFloat(t)
    return Number.isFinite(v) ? v : NaN
  }

  let acc = valueOf(tokens[0])
  if (Number.isNaN(acc)) return 0

  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i]
    const rhs = valueOf(tokens[i + 1])
    if (Number.isNaN(rhs)) return 0
    if (op === '*') acc *= rhs
    else if (op === '/') {
      if (rhs === 0) return 0
      acc /= rhs
    }
  }
  return Number.isFinite(acc) ? acc : 0
}

// ────────────────────────────────────────────────────────────
// Preset circuits — used by the simulator UI and the AI tutor
// ────────────────────────────────────────────────────────────

export interface Preset {
  id: string
  name: string
  blurb: string
  circuit: Circuit
}

export const PRESETS: Preset[] = [
  {
    id: 'bell',
    name: 'Bell State (Φ+)',
    blurb: 'The simplest entangled state. Outcomes are always 00 or 11 — never 01 or 10.',
    circuit: { numQubits: 2, ops: [{ name: 'H', qubits: [0] }, { name: 'CX', qubits: [0, 1] }] },
  },
  {
    id: 'ghz',
    name: 'GHZ State (3 qubits)',
    blurb: 'Three-way entanglement. All three qubits agree, every single time.',
    circuit: {
      numQubits: 3,
      ops: [
        { name: 'H', qubits: [0] },
        { name: 'CX', qubits: [0, 1] },
        { name: 'CX', qubits: [1, 2] },
      ],
    },
  },
  {
    id: 'superposition',
    name: 'Uniform Superposition',
    blurb: 'Hadamard on every qubit — all basis states become equally likely.',
    circuit: {
      numQubits: 3,
      ops: [
        { name: 'H', qubits: [0] },
        { name: 'H', qubits: [1] },
        { name: 'H', qubits: [2] },
      ],
    },
  },
  {
    id: 'grover2',
    name: "Grover's Search (2 qubits, |11⟩)",
    blurb: 'One Grover iteration finds the marked state |11⟩ with certainty.',
    circuit: {
      numQubits: 2,
      ops: [
        { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] },
        { name: 'CZ', qubits: [0, 1] },
        { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] },
        { name: 'X', qubits: [0] }, { name: 'X', qubits: [1] },
        { name: 'CZ', qubits: [0, 1] },
        { name: 'X', qubits: [0] }, { name: 'X', qubits: [1] },
        { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] },
      ],
    },
  },
  {
    id: 'interference',
    name: 'Quantum Interference',
    blurb:
      'H, then Z, then H again. The phase flip in the middle turns cancellation into ' +
      'reinforcement: the qubit lands on |1⟩ every single time. H·Z·H is exactly X.',
    circuit: {
      numQubits: 1,
      ops: [{ name: 'H', qubits: [0] }, { name: 'Z', qubits: [0] }, { name: 'H', qubits: [0] }],
    },
  },
  {
    id: 'teleport',
    name: 'Quantum Teleportation',
    blurb:
      'Moves qubit 0’s state onto qubit 2 using entanglement — the coherent, deferred-measurement version, where two controlled gates stand in for the two classical bits. See teleport-classical for the version with real measurements.',
    circuit: {
      numQubits: 3,
      ops: [
        { name: 'RY', qubits: [0], theta: Math.PI / 3 },
        { name: 'H', qubits: [1] },
        { name: 'CX', qubits: [1, 2] },
        { name: 'CX', qubits: [0, 1] },
        { name: 'H', qubits: [0] },
        { name: 'CX', qubits: [1, 2] },
        { name: 'CZ', qubits: [0, 2] },
      ],
    },
  },
  {
    id: 'teleport-classical',
    name: 'Teleportation (real classical wires)',
    blurb:
      'The same protocol with the measurements actually performed: Alice’s two bits land in the ' +
      'classical register, and Bob’s corrections are conditioned on them. Run it — the ' +
      'Bell result changes shot to shot, and qubit 2 arrives correct every time.',
    circuit: {
      numQubits: 3,
      numClbits: 2,
      ops: [
        { name: 'RY', qubits: [0], theta: Math.PI / 3 },
        { name: 'H', qubits: [1] },
        { name: 'CX', qubits: [1, 2] },
        { name: 'CX', qubits: [0, 1] },
        { name: 'H', qubits: [0] },
        { name: 'MEASURE', qubits: [0], clbit: 0 },
        { name: 'MEASURE', qubits: [1], clbit: 1 },
        { name: 'X', qubits: [2], condition: { bit: 1, value: 1 } },
        { name: 'Z', qubits: [2], condition: { bit: 0, value: 1 } },
      ],
    },
  },
  {
    id: 'superdense',
    name: 'Superdense Coding (message 11)',
    blurb:
      'Two classical bits carried by one qubit. Alice encodes “11” with a Z then an X on her ' +
      'half of a Bell pair; Bob undoes the entanglement and reads both bits off with certainty.',
    circuit: {
      numQubits: 2,
      ops: [
        { name: 'H', qubits: [0] },
        { name: 'CX', qubits: [0, 1] },
        { name: 'Z', qubits: [0] },
        { name: 'X', qubits: [0] },
        { name: 'CX', qubits: [0, 1] },
        { name: 'H', qubits: [0] },
      ],
    },
  },
]

// ────────────────────────────────────────────────────────────
// Formatting helpers used across the UI
// ────────────────────────────────────────────────────────────

export function formatComplex(a: Complex, digits = 3): string {
  const re = a.re, im = a.im
  const r = Math.abs(re) < 1e-10 ? 0 : re
  const i = Math.abs(im) < 1e-10 ? 0 : im
  if (i === 0) return r.toFixed(digits)
  if (r === 0) return `${i.toFixed(digits)}i`
  return `${r.toFixed(digits)}${i >= 0 ? '+' : '-'}${Math.abs(i).toFixed(digits)}i`
}

/**
 * Pure formatting, deliberately unguarded: it is called from render paths with
 * indices that came from probabilities().map, and an index wider than
 * numQubits simply prints wider. StateVector.label() is the guarded version.
 */
export function formatKet(index: number, numQubits: number): string {
  return `|${index.toString(2).padStart(numQubits, '0')}⟩`
}

// ────────────────────────────────────────────────────────────
// Backend hook — run a circuit through a pluggable statevector engine
// ────────────────────────────────────────────────────────────
//
// Everything above simulates on a Float64Array inside StateVector. The GPU
// backend (lib/quantum/webgpu/) and any future WASM engine cannot reuse that
// array, but they CAN reuse the one thing that is genuinely shared: the map
// from a GateOp to "this 2×2 matrix, on this target, under these controls".
// runCircuitOn() is that map, and nothing else in this file depends on it.
// lib/quantum/backend.ts defines the full StatevectorBackend contract on top.

/** 2×2 single-qubit unitary as [m00, m01, m10, m11] (row-major). */
export type Matrix2x2 = [Complex, Complex, Complex, Complex]

/**
 * The minimal surface a statevector engine must expose for runCircuitOn().
 * Qubit indexing follows this module's convention (qubit 0 is the LSB).
 */
export interface GateSink {
  applyGate(matrix: Matrix2x2, target: number): void
  applyControlled(matrix: Matrix2x2, controls: readonly number[], target: number): void
  applySwap(a: number, b: number): void
}

/**
 * Feed a circuit's gates to a backend, one matrix at a time.
 *
 * Semantics match simulate() on a circuit WITHOUT classical control: MEASURE
 * and BARRIER are no-ops, so the backend ends up holding the pre-measurement
 * state. A conditioned op throws — a bare statevector has no classical
 * register to consult, exactly as StateVector.apply() refuses it — and the
 * arity check is the same one apply() performs, for the same reason (a missing
 * operand must not read as qubit 0).
 */
export function runCircuitOn(circuit: Circuit, sink: GateSink): void {
  for (const op of circuit.ops) {
    const { name, qubits, theta = 0 } = op
    if (op.condition) {
      throw new Error(
        `${name} is conditioned on classical bit ${op.condition.bit}; backends run gates only`
      )
    }
    if (name === 'BARRIER' || name === 'MEASURE') continue
    // TODO(GateSink backends): lib/quantum/webgpu/ and any future WASM engine
    // implement only "one matrix, one target, optionally all-controls-read-1"
    // — the general per-control-basis recipe applyExtraControls() added to
    // StateVector (Task 4) has no GateSink equivalent yet, and RESET/
    // POSTSELECT have no fixed unitary at all (see StateVector.apply()).
    // Refuse rather than silently drop the extra controls and run the bare
    // gate, or silently do nothing for a measure-and-branch op.
    if (op.extraControls && op.extraControls.length) {
      throw new Error(`${name} has extraControls; GateSink backends do not support them yet`)
    }
    if (name === 'RESET' || name === 'POSTSELECT') {
      throw new Error(`${name} has no fixed unitary; GateSink backends run gates only`)
    }
    const arity = GATE_BY_NAME[name]?.arity ?? 1
    if (qubits.length !== arity) {
      throw new Error(`${name} takes ${arity} qubit(s), got ${qubits.length}`)
    }
    switch (name) {
      case 'CX':   sink.applyControlled(singleQubitMatrix('X'), [qubits[0]], qubits[1]); break
      case 'CY':   sink.applyControlled(singleQubitMatrix('Y'), [qubits[0]], qubits[1]); break
      case 'CZ':   sink.applyControlled(singleQubitMatrix('Z'), [qubits[0]], qubits[1]); break
      case 'CCX':  sink.applyControlled(singleQubitMatrix('X'), [qubits[0], qubits[1]], qubits[2]); break
      case 'SWAP': sink.applySwap(qubits[0], qubits[1]); break
      default:     sink.applyGate(singleQubitMatrix(name, theta), qubits[0])
    }
  }
}
