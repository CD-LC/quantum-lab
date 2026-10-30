/**
 * lib/workbench/generate.ts — the generate → verify → repair loop.
 *
 * Ask a model for a circuit, run it through `verify()` against the spec, and
 * if it fails hand the diagnostics back and ask again — up to a fixed number
 * of rounds. Every round is recorded with the prompt that was sent, the raw
 * reply, the parsed circuit, the verdict and the diff against the previous
 * round, so the developer (or the test) can see exactly what the model was
 * told and what it changed.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The model is a `ProviderAdapter` the
 * caller injects: the web route and the MCP tool inject the live adapter
 * built from lib/llm/resolve.ts (see ./liveProvider.ts), and the tests inject
 * a scripted fake. The loop is therefore deterministic given the replies,
 * and every claim it makes — "this circuit passes" — is the simulator's, not
 * the model's.
 *
 * Two output formats are accepted from the model, because different models
 * are reliable at different ones: the app's own JSON circuit shape
 * ({ numQubits, ops: [{ name, qubits, theta? }] }) and OpenQASM 3. The prompt
 * asks for JSON in a fenced block; the parser takes either, fenced or bare.
 */

import {
  GATE_LIBRARY,
  fromQasm,
  toQasm,
  type Circuit,
  type GateName,
  type GateOp,
} from '@/lib/quantum'
import { reportError } from '@/lib/observability/report'
import { diffCircuits, type CircuitDiff } from './diff'
import { formatDiagnostics, verify, type CircuitSpec, type VerifyResult } from './verify'

// ────────────────────────────────────────────────────────────
// Provider adapter — the only seam to a model
// ────────────────────────────────────────────────────────────

/** What a caller is told when the model provider fails. Never the provider's own text. */
export const PROVIDER_FAILED = 'The model provider returned an error; try again later.'

export interface CompletionRequest {
  system: string
  user: string
  /** Ceiling on reply length. The loop never needs more than a few hundred tokens of circuit. */
  maxTokens: number
}

export interface ProviderAdapter {
  /** Human-readable name shown in the timeline ("Gemini", "scripted fake"). */
  label: string
  /** Resolve with the model's text. Reject to stop the loop with a provider error. */
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<string>
}

// ────────────────────────────────────────────────────────────
// Limits
// ────────────────────────────────────────────────────────────

export const DEFAULT_MAX_ATTEMPTS = 3
export const MAX_ATTEMPTS_CEILING = 6
/** Tokens the model may spend on one reply. A 16-qubit circuit of 60 gates is ~1k tokens as JSON. */
export const REPLY_MAX_TOKENS = 1_500
/** Characters of a reply the parser will look at. */
const REPLY_MAX_CHARS = 40_000
/** Ops accepted from one reply. */
const MAX_OPS = 400

// ────────────────────────────────────────────────────────────
// Records
// ────────────────────────────────────────────────────────────

export interface Attempt {
  /** 1-based position in the timeline. */
  index: number
  /** `candidate`: the developer's own circuit, checked before any model call. */
  source: 'candidate' | 'model'
  prompt: { system: string; user: string } | null
  reply: string | null
  circuit: Circuit | null
  qasm: string | null
  /** Why the reply produced no circuit, when it did not. */
  parseError: string | null
  verdict: VerifyResult | null
  /** Against the previous attempt's circuit (null when there is none). */
  diff: CircuitDiff | null
  durationMs: number
}

export type StopReason = 'passed' | 'exhausted' | 'aborted' | 'provider_error' | 'no_provider'

export interface GenerateResult {
  ok: boolean
  circuit: Circuit | null
  qasm: string | null
  attempts: Attempt[]
  modelCalls: number
  stopped: StopReason
  error: string | null
  provider: string | null
}

export interface GenerateOptions {
  /** Total rounds, including the candidate round if one is supplied. */
  maxAttempts?: number
  /** A circuit to verify first. If it passes, the model is never called. */
  candidate?: Circuit | null
  signal?: AbortSignal
  /** Called after each round with the record so a UI can stream the timeline. */
  onAttempt?: (attempt: Attempt) => void
  now?: () => number
}

// ────────────────────────────────────────────────────────────
// Prompt construction
// ────────────────────────────────────────────────────────────

const JSON_GATES = GATE_LIBRARY.filter((g) => g.name !== 'MEASURE')

function gateTable(allowed: GateName[] | undefined): string {
  const set = allowed ? new Set<string>(allowed) : null
  return JSON_GATES.filter((g) => !set || set.has(g.name))
    .map((g) => `  ${g.name}: ${g.arity} qubit(s)${g.hasAngle ? ', takes theta (radians)' : ''} — ${g.description}`)
    .join('\n')
}

const fmtNum = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6
  return String(r)
}

function fmtSpecNumber(z: number | { re: number; im: number }): string {
  if (typeof z === 'number') return fmtNum(z)
  if (Math.abs(z.im) < 1e-12) return fmtNum(z.re)
  if (Math.abs(z.re) < 1e-12) return `${fmtNum(z.im)}i`
  return `${fmtNum(z.re)}${z.im >= 0 ? '+' : ''}${fmtNum(z.im)}i`
}

/** The spec as a model should read it: formal target, then intent, then limits. */
export function describeSpec(spec: CircuitSpec): string {
  const lines: string[] = []
  const n = spec.numQubits
  if (spec.name) lines.push(`Name: ${spec.name}`)
  lines.push(`Register: exactly ${n} qubit(s), q[0] … q[${n - 1}].`)
  const t = spec.target
  if (t.kind === 'distribution') {
    lines.push(
      `Target: a measurement distribution over all ${n} qubits in the computational basis. ` +
        `Labels are MSB-first (the rightmost character is q[0]). Tolerance ±${t.tolerance ?? 0.02} per basis state. ` +
        'Every label not listed must have probability 0.',
    )
    for (const [label, p] of Object.entries(t.probabilities)) lines.push(`  |${label}⟩: ${fmtNum(p)}`)
  } else if (t.kind === 'statevector') {
    lines.push(
      `Target: prepare this state from |${'0'.repeat(n)}⟩ (global phase does not matter, relative phases do). ` +
        'Amplitudes in basis order 0 … 2^n−1, index i has q[k] = 1 when bit k of i is set:',
    )
    t.amplitudes.forEach((a, i) => {
      const s = fmtSpecNumber(a)
      if (s !== '0') lines.push(`  |${i.toString(2).padStart(n, '0')}⟩: ${s}`)
    })
  } else {
    lines.push(
      `Target: implement this ${1 << n}×${1 << n} unitary (global phase does not matter). ` +
        'Row-major; row = output basis index, column = input basis index, index bit k = q[k]:',
    )
    t.matrix.forEach((row, r) => {
      lines.push(`  row |${r.toString(2).padStart(n, '0')}⟩: [${row.map(fmtSpecNumber).join(', ')}]`)
    })
  }
  if (spec.description) lines.push(`Intent: ${spec.description}`)
  const c = spec.constraints
  if (c) {
    const parts: string[] = []
    if (c.maxQubits !== undefined) parts.push(`at most ${c.maxQubits} qubits`)
    if (c.allowedGates) parts.push(`only these gates: ${c.allowedGates.join(', ')}`)
    if (c.maxDepth !== undefined) parts.push(`depth at most ${c.maxDepth}`)
    if (c.maxGates !== undefined) parts.push(`at most ${c.maxGates} gates`)
    if (parts.length) lines.push(`Constraints: ${parts.join('; ')}.`)
  }
  return lines.join('\n')
}

export function systemPrompt(spec: CircuitSpec): string {
  return [
    'You write quantum circuits that will be checked by an exact statevector simulator. ' +
      'Only the circuit is read from your reply; explanations are discarded.',
    '',
    'Reply with ONE fenced ```json block containing the circuit in this shape and nothing else:',
    '{"numQubits": 2, "ops": [{"name": "H", "qubits": [0]}, {"name": "CX", "qubits": [0, 1]}, {"name": "RY", "qubits": [1], "theta": 1.5708}]}',
    '',
    'Conventions:',
    '- qubits are indexed 0 … numQubits−1; multi-qubit gates list control(s) first, target last: CX [control, target], CCX [c1, c2, target].',
    '- theta is in radians as a plain number.',
    '- basis-state labels are MSB-first: "01" on two qubits means q[1]=0, q[0]=1.',
    '- global phase is ignored by the checker; relative phases are not.',
    '- do not add measurements; the checker looks at the state before measurement.',
    '',
    'Available gates:',
    gateTable(spec.constraints?.allowedGates),
  ].join('\n')
}

/** Prompt for the first model round: just the spec. */
export function initialPrompt(spec: CircuitSpec): string {
  return `Write a circuit that meets this spec.\n\n${describeSpec(spec)}`
}

/**
 * Prompt for a repair round: the spec again, the previous circuit, and the
 * verifier's diagnostics verbatim. Earlier rounds are summarised in one line
 * each so the model does not resubmit something it already tried.
 */
export function repairPrompt(spec: CircuitSpec, previous: Attempt, earlier: Attempt[]): string {
  const lines: string[] = [
    'Your previous circuit FAILED verification. Fix it and reply with the corrected circuit in the same JSON format.',
    '',
    describeSpec(spec),
    '',
  ]
  if (previous.circuit) {
    lines.push('Previous circuit (OpenQASM 3):', '```qasm', previous.qasm ?? toQasm(previous.circuit), '```', '')
  } else {
    lines.push(`Previous reply could not be parsed: ${previous.parseError ?? 'no circuit found'}.`, '')
  }
  if (previous.verdict) {
    lines.push('Verifier diagnostics:', formatDiagnostics(previous.verdict), '')
  }
  const history = earlier.filter((a) => a.verdict || a.parseError)
  if (history.length > 0) {
    lines.push('Earlier attempts (do not repeat them):')
    for (const a of history) {
      lines.push(`  ${a.index}. ${a.verdict ? a.verdict.summary : `unparseable: ${a.parseError}`}`)
    }
  }
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// Reply parsing
// ────────────────────────────────────────────────────────────

const GATE_NAME_SET: ReadonlySet<string> = new Set(GATE_LIBRARY.map((g) => g.name).concat('BARRIER'))

/** `pi/2`, `-pi`, `3*pi/4`, `1.5708` → radians. Null on anything else. */
function parseAngle(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase().replace(/π/g, 'pi').replace(/\s+/g, '')
  if (!s) return null
  const plain = Number(s)
  if (Number.isFinite(plain)) return plain
  // [sign][k*]pi[*k][/d]
  const m = s.match(/^([-+]?)(?:(\d+(?:\.\d+)?)\*)?pi(?:\*(\d+(?:\.\d+)?))?(?:\/(\d+(?:\.\d+)?))?$/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const value =
    (Math.PI * (m[2] ? Number(m[2]) : 1) * (m[3] ? Number(m[3]) : 1)) / (m[4] ? Number(m[4]) : 1)
  return Number.isFinite(value) ? sign * value : null
}

export type ParseOutcome = { ok: true; circuit: Circuit; format: 'json' | 'qasm' } | { ok: false; error: string }

/** Validate a JSON object as a circuit. Names are case-insensitive; angles may be "pi/2". */
export function circuitFromJson(value: unknown): ParseOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'JSON is not an object' }
  }
  const rec = value as Record<string, unknown>
  const numQubits = rec.numQubits ?? rec.num_qubits ?? rec.qubits
  if (!Number.isInteger(numQubits) || (numQubits as number) < 1 || (numQubits as number) > 16) {
    return { ok: false, error: 'numQubits must be an integer from 1 to 16' }
  }
  const rawOps = rec.ops ?? rec.gates
  if (!Array.isArray(rawOps)) return { ok: false, error: 'ops must be an array' }
  if (rawOps.length > MAX_OPS) return { ok: false, error: `too many ops (${rawOps.length} > ${MAX_OPS})` }
  const ops: GateOp[] = []
  for (let i = 0; i < rawOps.length; i++) {
    const raw = rawOps[i]
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `ops[${i}] is not an object` }
    const r = raw as Record<string, unknown>
    const nameRaw = r.name ?? r.gate
    if (typeof nameRaw !== 'string') return { ok: false, error: `ops[${i}].name is missing` }
    const name = nameRaw.toUpperCase().replace(/^CNOT$/, 'CX').replace(/^TOFFOLI$/, 'CCX').replace(/^SDAG$/, 'SDG').replace(/^TDAG$/, 'TDG')
    if (!GATE_NAME_SET.has(name)) return { ok: false, error: `ops[${i}]: unknown gate "${nameRaw}"` }
    const qubitsRaw = r.qubits ?? r.targets ?? (typeof r.qubit === 'number' ? [r.qubit] : undefined)
    if (!Array.isArray(qubitsRaw) || !qubitsRaw.every((q) => Number.isInteger(q))) {
      return { ok: false, error: `ops[${i}].qubits must be an array of integers` }
    }
    const op: GateOp = { name: name as GateName, qubits: qubitsRaw as number[] }
    const thetaRaw = r.theta ?? r.angle ?? (Array.isArray(r.params) ? r.params[0] : undefined)
    if (thetaRaw !== undefined) {
      const theta = parseAngle(thetaRaw)
      if (theta === null) return { ok: false, error: `ops[${i}].theta "${String(thetaRaw)}" is not an angle` }
      op.theta = theta
    }
    if (name === 'MEASURE' && Number.isInteger(r.clbit)) op.clbit = r.clbit as number
    ops.push(op)
  }
  return { ok: true, circuit: { numQubits: numQubits as number, ops }, format: 'json' }
}

const FENCE_RE = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g

/**
 * Pull a circuit out of a model reply. Tries every fenced block (JSON first,
 * then QASM), then the bare text. The first block that yields a circuit with
 * at least one op wins; the error reported is the most specific one seen.
 */
export function parseReply(reply: string): ParseOutcome {
  const text = reply.slice(0, REPLY_MAX_CHARS)
  const candidates: string[] = []
  for (const m of text.matchAll(FENCE_RE)) candidates.push(m[2].trim())
  candidates.push(text.trim())

  let lastError = 'no circuit found in the reply'
  for (const block of candidates) {
    if (!block) continue
    const jsonStart = block.indexOf('{')
    const jsonEnd = block.lastIndexOf('}')
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        const parsed: unknown = JSON.parse(block.slice(jsonStart, jsonEnd + 1))
        const out = circuitFromJson(parsed)
        if (out.ok) return out
        lastError = out.error
      } catch (cause) {
        lastError = `JSON did not parse: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    }
    if (/OPENQASM|qubit\[|qreg\s/i.test(block)) {
      const circuit = fromQasm(block)
      if (circuit.ops.length > 0) return { ok: true, circuit, format: 'qasm' }
      lastError = 'QASM parsed to zero gates'
    }
  }
  return { ok: false, error: lastError }
}

// ────────────────────────────────────────────────────────────
// The loop
// ────────────────────────────────────────────────────────────

function safeQasm(circuit: Circuit): string | null {
  try {
    return toQasm(circuit)
  } catch {
    return null
  }
}

function safeVerify(circuit: Circuit, spec: CircuitSpec): VerifyResult {
  try {
    return verify(circuit, spec)
  } catch (cause) {
    // verify() catches its own simulator errors; this is belt and braces so a
    // loop never dies on a verdict.
    return {
      pass: false,
      score: 0,
      fidelity: null,
      diagnostics: [{ level: 'error', code: 'simulation_failed', message: String(cause instanceof Error ? cause.message : cause) }],
      metrics: { numQubits: circuit.numQubits, gateCount: circuit.ops.length, twoQubitGates: 0, depth: 0 },
      stateDeviations: [],
      amplitudeDeviations: [],
      entryDeviations: [],
      summary: 'Fail: verification threw',
    }
  }
}

/**
 * Run the loop. Resolves — never rejects — with a full record; a provider
 * failure or an abort is a `stopped` reason with the attempts so far.
 */
export async function generateVerifiedCircuit(
  spec: CircuitSpec,
  provider: ProviderAdapter | null,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = options.now ?? (() => Date.now())
  const maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)))
  const attempts: Attempt[] = []
  let modelCalls = 0
  let previousCircuit: Circuit | null = null

  const finish = (stopped: StopReason, error: string | null = null): GenerateResult => {
    const last = attempts[attempts.length - 1]
    const passed = stopped === 'passed' && last?.circuit ? last : null
    return {
      ok: passed !== null,
      circuit: passed?.circuit ?? null,
      qasm: passed?.qasm ?? null,
      attempts,
      modelCalls,
      stopped,
      error,
      provider: provider?.label ?? null,
    }
  }

  const record = (attempt: Attempt): Attempt => {
    attempts.push(attempt)
    options.onAttempt?.(attempt)
    return attempt
  }

  // ── Round 0: the developer's own candidate, if any.
  if (options.candidate) {
    const started = now()
    const verdict = safeVerify(options.candidate, spec)
    const attempt = record({
      index: attempts.length + 1,
      source: 'candidate',
      prompt: null,
      reply: null,
      circuit: options.candidate,
      qasm: safeQasm(options.candidate),
      parseError: null,
      verdict,
      diff: null,
      durationMs: now() - started,
    })
    previousCircuit = options.candidate
    if (verdict.pass) return finish('passed')
    if (attempts.length >= maxAttempts) return finish('exhausted')
    void attempt
  }

  if (!provider) return finish('no_provider', 'No model is configured for this caller.')

  const system = systemPrompt(spec)

  while (attempts.length < maxAttempts) {
    if (options.signal?.aborted) return finish('aborted', 'Stopped before the next model call.')
    const previous = attempts[attempts.length - 1]
    const user = previous ? repairPrompt(spec, previous, attempts.slice(0, -1)) : initialPrompt(spec)
    const started = now()
    let reply: string
    try {
      modelCalls += 1
      reply = await provider.complete({ system, user, maxTokens: REPLY_MAX_TOKENS }, options.signal)
    } catch (cause) {
      // A provider's failure text (AI SDK call errors carry the upstream
      // response body: deployment and model names, quota wording, hostnames)
      // is for observability. The result is returned to anonymous callers, so
      // it gets a fixed sentence.
      reportError(cause, { module: 'workbench/generate', stage: 'provider' })
      const message = PROVIDER_FAILED
      record({
        index: attempts.length + 1,
        source: 'model',
        prompt: { system, user },
        reply: null,
        circuit: null,
        qasm: null,
        parseError: `provider error: ${message}`,
        verdict: null,
        diff: null,
        durationMs: now() - started,
      })
      return finish(options.signal?.aborted ? 'aborted' : 'provider_error', message)
    }

    const parsed = parseReply(typeof reply === 'string' ? reply : String(reply))
    if (!parsed.ok) {
      record({
        index: attempts.length + 1,
        source: 'model',
        prompt: { system, user },
        reply: reply.slice(0, REPLY_MAX_CHARS),
        circuit: null,
        qasm: null,
        parseError: parsed.error,
        verdict: null,
        diff: null,
        durationMs: now() - started,
      })
      continue
    }

    const verdict = safeVerify(parsed.circuit, spec)
    record({
      index: attempts.length + 1,
      source: 'model',
      prompt: { system, user },
      reply: reply.slice(0, REPLY_MAX_CHARS),
      circuit: parsed.circuit,
      qasm: safeQasm(parsed.circuit),
      parseError: null,
      verdict,
      diff: diffCircuits(previousCircuit, parsed.circuit),
      durationMs: now() - started,
    })
    previousCircuit = parsed.circuit
    if (verdict.pass) return finish('passed')
  }

  return finish('exhausted')
}
