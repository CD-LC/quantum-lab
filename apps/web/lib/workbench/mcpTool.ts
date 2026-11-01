/**
 * lib/workbench/mcpTool.ts — the network-free half of the
 * `generate_verified_circuit` MCP tool: argument validation and result
 * serialisation. lib/mcp/server.ts wires this to the registry and supplies
 * the provider; the API route reuses the same serialiser so the page and an
 * agent see the same shape.
 */

import { fromQasm, type Circuit } from '@/lib/quantum'
import { formatDiff } from './diff'
import { MAX_ATTEMPTS_CEILING, type Attempt, type GenerateResult } from './generate'
import { validateSpec, type CircuitSpec, type VerifyResult } from './verify'

/** Same QASM size bound the rest of the MCP surface applies. */
export const GENERATE_MAX_QASM_CHARS = 20_000
/** Gates in a supplied candidate. Spec circuits are a handful of gates; ~1,300 cost ~5 s of event loop. */
export const GENERATE_MAX_CANDIDATE_OPS = 300
/** A spec is a small object; 32 KB is a 5-qubit unitary written out with room to spare. */
export const GENERATE_MAX_SPEC_CHARS = 32_000

export interface GenerateToolInput {
  spec: CircuitSpec
  maxAttempts: number
  candidate: Circuit | null
}

export type GenerateToolArgs = { ok: true; input: GenerateToolInput } | { ok: false; error: string }

/**
 * Validate the tool's arguments. `spec` may arrive as an object or as a JSON
 * string (some agent runtimes stringify nested objects). `candidate_qasm` is
 * optional; when present it is verified before any model call.
 */
export function parseGenerateArgs(args: Record<string, unknown>): GenerateToolArgs {
  let rawSpec: unknown = args.spec
  if (typeof rawSpec === 'string') {
    if (rawSpec.length > GENERATE_MAX_SPEC_CHARS) return { ok: false, error: 'spec is too large.' }
    try {
      rawSpec = JSON.parse(rawSpec)
    } catch {
      return { ok: false, error: 'spec is not valid JSON.' }
    }
  }
  const checked = validateSpec(rawSpec)
  if (!checked.ok) return { ok: false, error: `Invalid spec:\n- ${checked.errors.join('\n- ')}` }

  let maxAttempts = 3
  if (args.max_attempts !== undefined) {
    if (typeof args.max_attempts !== 'number' || !Number.isInteger(args.max_attempts)) {
      return { ok: false, error: 'max_attempts must be an integer.' }
    }
    maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, args.max_attempts))
  }

  let candidate: Circuit | null = null
  if (args.candidate_qasm !== undefined) {
    if (typeof args.candidate_qasm !== 'string' || args.candidate_qasm.length > GENERATE_MAX_QASM_CHARS) {
      return { ok: false, error: `candidate_qasm must be a string of at most ${GENERATE_MAX_QASM_CHARS} characters.` }
    }
    if (args.candidate_qasm.trim().length > 0) {
      candidate = fromQasm(args.candidate_qasm)
      if (candidate.ops.length === 0) {
        return { ok: false, error: 'candidate_qasm parsed to zero gates. Expected OpenQASM 3.' }
      }
      // The size cap alone admits ~2,000 one-line gates, and verification
      // enumerates measurement branches synchronously: bound the work.
      if (candidate.ops.length > GENERATE_MAX_CANDIDATE_OPS) {
        return {
          ok: false,
          error: `candidate_qasm has ${candidate.ops.length} gates; the ceiling is ${GENERATE_MAX_CANDIDATE_OPS}.`,
        }
      }
    }
  }

  return { ok: true, input: { spec: checked.spec, maxAttempts, candidate } }
}

// ────────────────────────────────────────────────────────────
// Serialisation — plain JSON for tool results and the API route
// ────────────────────────────────────────────────────────────

export interface SerializedVerdict {
  pass: boolean
  score: number
  fidelity: number | null
  summary: string
  diagnostics: VerifyResult['diagnostics']
  metrics: VerifyResult['metrics']
  stateDeviations: VerifyResult['stateDeviations']
  amplitudeDeviations: VerifyResult['amplitudeDeviations']
  entryDeviations: VerifyResult['entryDeviations']
}

export interface SerializedAttempt {
  index: number
  source: Attempt['source']
  circuit: Circuit | null
  qasm: string | null
  parseError: string | null
  verdict: SerializedVerdict | null
  /** Unified-diff text against the previous attempt, or null for the first. */
  diff: string | null
  diffCounts: { added: number; removed: number } | null
  /** The user prompt the model saw (system prompt omitted: it is the same every round). */
  prompt: string | null
  reply: string | null
  durationMs: number
}

export interface SerializedGenerateResult {
  ok: boolean
  stopped: GenerateResult['stopped']
  error: string | null
  provider: string | null
  modelCalls: number
  circuit: Circuit | null
  qasm: string | null
  attempts: SerializedAttempt[]
  spec: CircuitSpec
  caveat: string
}

export const GENERATE_CAVEAT =
  'Verified on an ideal statevector simulator against the spec YOU supplied: a pass means the circuit ' +
  'matches that spec, not that the spec is what you meant, and says nothing about noise or real hardware.'

export function serializeVerdict(v: VerifyResult): SerializedVerdict {
  return {
    pass: v.pass,
    score: v.score,
    fidelity: v.fidelity,
    summary: v.summary,
    diagnostics: v.diagnostics,
    metrics: v.metrics,
    stateDeviations: v.stateDeviations,
    amplitudeDeviations: v.amplitudeDeviations,
    entryDeviations: v.entryDeviations,
  }
}

export function serializeAttempt(a: Attempt): SerializedAttempt {
  return {
    index: a.index,
    source: a.source,
    circuit: a.circuit,
    qasm: a.qasm,
    parseError: a.parseError,
    verdict: a.verdict ? serializeVerdict(a.verdict) : null,
    diff: a.diff ? formatDiff(a.diff) : null,
    diffCounts: a.diff ? { added: a.diff.added, removed: a.diff.removed } : null,
    prompt: a.prompt?.user ?? null,
    reply: a.reply,
    durationMs: a.durationMs,
  }
}

export function serializeGenerateResult(result: GenerateResult, spec: CircuitSpec): SerializedGenerateResult {
  return {
    ok: result.ok,
    stopped: result.stopped,
    error: result.error,
    provider: result.provider,
    modelCalls: result.modelCalls,
    circuit: result.circuit,
    qasm: result.qasm,
    attempts: result.attempts.map(serializeAttempt),
    spec,
    caveat: GENERATE_CAVEAT,
  }
}

/** JSON Schema for the tool's input, shared with tools/list. */
export const GENERATE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      description:
        'The spec to verify against. { numQubits, target, constraints?, name?, description? }. ' +
        'target is one of: { kind: "distribution", probabilities: { "<MSB-first label>": p, … }, tolerance? } ' +
        '(labels not listed are 0; must sum to 1); { kind: "statevector", amplitudes: [2^n numbers or {re, im}], minFidelity? } ' +
        '(compared up to global phase, |⟨t|ψ⟩|²); { kind: "unitary", matrix: [[…], …] row-major 2^n×2^n, minFidelity? } ' +
        '(compared up to global phase, |Tr(V†U)|²/d²). constraints: { maxQubits?, allowedGates?: ["H","CX",…], maxDepth?, maxGates? }. ' +
        'Conventions: qubit 0 is the least significant bit; basis index i has qubit k set when bit k of i is set.',
    },
    max_attempts: {
      type: 'integer',
      description: `Rounds of generate → verify → repair, 1–${MAX_ATTEMPTS_CEILING}. Default 3. A supplied candidate counts as a round.`,
    },
    candidate_qasm: {
      type: 'string',
      description:
        'Optional OpenQASM 3 circuit to verify FIRST. If it passes, no model is called; if it fails, ' +
        'the diagnostics seed the first repair round. Pass this with max_attempts: 1 to use the tool as a pure verifier.',
    },
  },
  required: ['spec'],
} as const
