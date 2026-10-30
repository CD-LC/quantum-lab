/**
 * lib/mcp/server.ts — the Qubit16 MCP tool registry (roadmap stage A1).
 *
 * Every tool here is a THIN WRAPPER over code the product already ships:
 * `lib/quantum.ts` (the simulator and QASM importer), `lib/challenges` (the
 * grader and the verified generator), `lib/coach` (the session planner),
 * `lib/export/notebook.ts` (the .ipynb builders), `lib/lessons` (the course
 * metadata plus the server-only body module), and — for the one authenticated
 * tool — the real `/api/hardware/submit` route handler itself. No physics, no
 * grading rule, no paywall decision and no entitlement check lives in this
 * file — if a tool's answer looks wrong, the bug is in the module it wraps,
 * and the fix belongs there so the UI and the MCP surface stay in agreement.
 *
 * The registry is deliberately DEPENDENCY-FREE and TRANSPORT-FREE:
 *   · Tool input schemas are plain JSON Schema objects (what `tools/list`
 *     serialises anyway) and validation reuses `lib/security/validate`, the
 *     same dependency-free validators every other route uses. This repo has
 *     no schema library on purpose — see that module's header — and the MCP
 *     surface does not get to be the reason one appears.
 *   · The JSON-RPC / Streamable HTTP layer lives in
 *     `app/api/mcp/[transport]/route.ts`. Keeping it out of this module means
 *     `tools.test.ts` exercises every tool without an HTTP server, exactly the
 *     way the challenge and quantum tests already work.
 *
 * SECURITY POSTURE, stated once and relied on everywhere: every tool except
 * `submit_hardware_job` is READ/COMPUTE-ONLY over public or free content and
 * needs no identity. Simulation is deterministic and free, the challenge
 * catalogue, generator and grader are public, the session planner is stateless
 * over a caller-supplied snapshot, and lesson BODIES are only served for slugs
 * `isLessonFree` approves — the paid advanced track is metadata-only here,
 * same as the anonymous web preview. Nothing in this module touches billing,
 * orgs or user data.
 *
 * THE ONE EXCEPTION, `submit_hardware_job`, is not an exception to the gates —
 * it is a pass-through to them. Real-device submission spends money, so the
 * tool refuses outright unless the MCP request carried
 * `Authorization: Bearer <supabase access token>`, and when it did, the tool
 * dispatches an internal Request to the REAL /api/hardware/submit route
 * handler with that header attached. Every gate that route enforces — IP and
 * per-account rate limits, `requireCaller` (Supabase-verified identity),
 * shape validation, `requireFeature('hardware.real')`, the atomic quota
 * reservation — runs unchanged, because it is literally the same code path.
 * This module re-implements NONE of them and must never start to: if the gate
 * chain changes, this tool inherits the change by construction. The token is
 * forwarded for the one request and never stored; the server stays stateless.
 */

import {
  execute,
  fromQasm,
  hasClassicalControl,
  mulberry32,
  run,
  simulate,
  toQasm,
  GATE_LIBRARY,
  type Circuit,
  type Complex,
  type StateVector,
} from '@/lib/quantum'
import { reportError } from '@/lib/observability/report'
import { CHALLENGES, getChallenge } from '@/lib/challenges/catalogue'
import {
  GENERATED_KINDS,
  generateChallenge,
  type Difficulty,
  type GeneratedChallenge,
  type GeneratedKind,
} from '@/lib/challenges/generate'
import type { Challenge } from '@/lib/challenges/types'
import { grade } from '@/lib/challenges/grade'
import { buildSessionPlan } from '@/lib/coach/sessionPlan'
import type { ExamAttempt } from '@/lib/exams/types'
import { buildNotebook, notebookFilename, type NotebookVariant } from '@/lib/export/notebook'
import { LESSONS, TRACKS, getLesson as getLessonMeta } from '@/lib/lessons'
import { isLessonFree, trackForLesson } from '@/lib/lessons/access'
import type { Progress } from '@/lib/lessons/progress'
import { getLessonBody } from '@/lib/lessons/server'
import { int, isRecord, oneOf, str } from '@/lib/security/validate'
import { generateVerifiedCircuit, type ProviderAdapter } from '@/lib/workbench/generate'
import {
  GENERATE_TOOL_INPUT_SCHEMA,
  parseGenerateArgs,
  serializeGenerateResult,
} from '@/lib/workbench/mcpTool'
import { EXPERIMENT_TOOLS } from '@/lib/workbench/experimentTools'

// ────────────────────────────────────────────────────────────
// Limits
// ────────────────────────────────────────────────────────────

/**
 * Hard ceiling on register width. 16 matches `StateVector`'s own constructor
 * guard (2^16 complex doubles = 1 MB); the check is duplicated here only so a
 * caller gets a named, actionable error instead of a constructor throw
 * surfacing through three stack frames.
 */
export const MCP_MAX_QUBITS = 16

/**
 * Shot ceiling. 4096 keeps the worst case (16 qubits × 4096 samples) around a
 * millisecond of CPU, and no teaching purpose is served past it — sampling
 * noise at 4096 shots is already below every tolerance in the challenge
 * catalogue. Out-of-range values are CLAMPED, not rejected: an agent that
 * asks for a million shots wants "a lot", and 4096 is the honest maximum.
 */
export const MCP_MAX_SHOTS = 4096
export const MCP_DEFAULT_SHOTS = 1024

/** Same QASM size bound the tutor route applies to attached circuits. */
export const MCP_MAX_QASM_CHARS = 20_000

/**
 * Gate-count ceiling for any circuit a tool simulates. The QASM size cap alone
 * admits ~2,200 one-line gates, and every gate on a 16-qubit register is a
 * 65,536-amplitude sweep — a free CPU primitive against a 0.25-vCPU container,
 * and (before get_statevector_at_step kept a single vector) a 1 MB allocation
 * per gate. 1,000 gates is an order of magnitude past any teaching circuit and
 * keeps the worst case at well under a second of CPU and one statevector.
 */
export const MCP_MAX_OPS = 1_000

/**
 * Rate-limit namespace for the daily model-call quota generate_verified_circuit
 * charges. Shared with app/api/workbench/generate/route.ts ON PURPOSE: it is the
 * same loop spending the same budget, so the MCP tool and the web page draw
 * from one per-caller allowance instead of doubling it.
 */
const GENERATE_QUOTA_PREFIX = 'workbench-day'

/**
 * Statevector entries below this magnitude are omitted from tool output.
 * A 16-qubit state has 65 536 amplitudes and almost all of them are exactly
 * zero in every teaching circuit; serialising them would bloat a reply to
 * megabytes for no information. The omission is always reported in
 * `omittedNearZeroAmplitudes`, so a caller can tell "sparse" from "missing".
 */
const AMPLITUDE_FLOOR = 1e-10

// ────────────────────────────────────────────────────────────
// Tool result / definition shapes (the MCP subset this server uses)
// ────────────────────────────────────────────────────────────

export interface ToolTextContent {
  type: 'text'
  text: string
}

/**
 * The `CallToolResult` shape from the MCP spec, narrowed to what this server
 * emits: text content mirroring `structuredContent` for pre-2025-06-18
 * clients, and `isError` for tool-level failures (bad QASM, unknown slug).
 * Protocol-level failures (unknown tool, malformed JSON-RPC) are the route's
 * job and become JSON-RPC errors, not results.
 */
export interface ToolResult {
  content: ToolTextContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Plain JSON Schema — serialised verbatim into `tools/list`. */
export type JsonSchema = Record<string, unknown>

/**
 * Per-request context the route hands to `callTool`. Almost every tool ignores
 * it; `submit_hardware_job` reads the caller's `Authorization` header from it
 * (identity must come from a header the transport carried, never from a tool
 * argument an agent could fabricate) and `generate_verified_circuit` uses both
 * fields to resolve the caller's tier and charge their daily model quota.
 *
 * `clientIp` is the ONE address the transport trusted — what its own rate
 * limiter keyed on (`clientAddressFrom`), never a header copied verbatim. A
 * raw `x-forwarded-for` has a client-chosen first hop (Cloudflare only appends
 * to it), so forwarding that downstream let a caller pick the hardware route's
 * rate-limit bucket per request.
 */
export interface ToolCallContext {
  /** Verbatim `Authorization` header of the MCP request, or null. */
  authorization?: string | null
  /** The transport-trusted client address, for downstream rate-limit keying. */
  clientIp?: string | null
  /**
   * Same value as `clientIp`, kept under its historical name for consumers in
   * lib/workbench that forward it as `x-forwarded-for`. Set it to the trusted
   * address, never to the raw header.
   */
  forwardedFor?: string | null
}

/**
 * The client address a transport should put in `ToolCallContext`, resolved
 * with the SAME precedence lib/rateLimit's `callerKey` uses — Cloudflare's
 * `cf-connecting-ip` (edge-written, not rotatable), else the first hop of
 * `x-forwarded-for`, else `x-real-ip` — so the bucket a downstream route
 * derives from it is the bucket this transport already limited. Bounded to 64
 * chars like callerKey; null when no address is present.
 */
export function clientAddressFrom(headers: Headers): string | null {
  const cf = headers.get('cf-connecting-ip')?.trim() ?? ''
  const firstHop = (headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? ''
  const real = headers.get('x-real-ip')?.trim() ?? ''
  const address = (cf || firstHop || real).slice(0, 64)
  return address || null
}

/** Headers that make a downstream route's `callerKey` resolve to `address`. */
function trustedAddressHeaders(ctx: ToolCallContext): Record<string, string> {
  const address = (ctx.clientIp ?? ctx.forwardedFor ?? '').trim().slice(0, 64)
  if (!address) return {}
  // Both headers, one value: callerKey prefers cf-connecting-ip, and a
  // single-hop x-forwarded-for has no client-chosen first hop left to trust.
  return { 'cf-connecting-ip': address, 'x-forwarded-for': address }
}

export interface McpToolDef {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  handler: (
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => ToolResult | Promise<ToolResult>
}

/** Success: structured data plus its JSON as text for older clients. */
function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

/** Tool-level failure: `isError: true`, message in the text content. */
function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────

/**
 * Parse QASM and enforce the qubit ceiling, returning either a circuit or a
 * ToolResult error. `fromQasm` is total by contract (see its header), so the
 * failure modes here are "parsed to nothing" and "too wide", both of which
 * deserve a message an agent can act on rather than an empty histogram.
 */
function circuitFromArgs(args: Record<string, unknown>): { circuit: Circuit } | { error: ToolResult } {
  const qasm = str(args.qasm, MCP_MAX_QASM_CHARS, 'qasm')
  if (!qasm.ok) return { error: err(qasm.error) }

  const circuit = fromQasm(qasm.value)
  if (circuit.numQubits > MCP_MAX_QUBITS) {
    return {
      error: err(
        `This circuit uses ${circuit.numQubits} qubits; the simulator's ceiling is ` +
          `${MCP_MAX_QUBITS}. Reduce the register (qubit[${MCP_MAX_QUBITS}] q; at most).`,
      ),
    }
  }
  if (circuit.ops.length > MCP_MAX_OPS) {
    return {
      error: err(
        `This circuit has ${circuit.ops.length} gates; the ceiling is ${MCP_MAX_OPS}. ` +
          'Split it into shorter circuits or drop the repeated section.',
      ),
    }
  }
  if (circuit.ops.length === 0 && qasm.value.length > 0) {
    // fromQasm drops instructions it cannot accept rather than throwing. An
    // empty op list from non-empty text almost always means the text was not
    // QASM at all, and running |0…0⟩ silently would report physics the caller
    // never asked about.
    return {
      error: err(
        'No gates could be parsed from that input. Expected OpenQASM 3, e.g.:\n' +
          'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];',
      ),
    }
  }
  return { circuit }
}

/** Clamp an arbitrary value into an integer in [min, max], with a default. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

interface AmplitudeEntry {
  state: string
  re: number
  im: number
  probability: number
}

/**
 * The statevector as sparse labelled entries — the payload most MCP quantum
 * simulators do NOT return (they stop at counts). Near-zero amplitudes are
 * dropped (see AMPLITUDE_FLOOR) and the drop count reported.
 */
function sparseAmplitudes(sv: StateVector): { entries: AmplitudeEntry[]; omitted: number } {
  const entries: AmplitudeEntry[] = []
  let omitted = 0
  const amps: Complex[] = sv.amplitudes()
  for (let i = 0; i < amps.length; i++) {
    const a = amps[i]
    const probability = a.re * a.re + a.im * a.im
    if (Math.sqrt(probability) < AMPLITUDE_FLOOR) {
      omitted += 1
      continue
    }
    entries.push({ state: sv.label(i), re: a.re, im: a.im, probability })
  }
  return { entries, omitted }
}

/**
 * A seed derived from the whole circuit, so every step of one circuit replays
 * the same measurement outcomes: `execute` draws from the rng in op order, so
 * running a prefix with the same seed reproduces exactly the frame the full
 * run would have passed through. FNV-1a over the ops; mirrors the private
 * `circuitSeed` in lib/quantum.ts in purpose, not necessarily in value.
 */
function stepSeed(circuit: Circuit): number {
  let h = 0x811c9dc5
  const push = (n: number) => {
    h ^= n | 0
    h = Math.imul(h, 0x01000193)
  }
  push(circuit.numQubits)
  const text = JSON.stringify([circuit.initialStates ?? null, circuit.ops])
  for (let i = 0; i < text.length; i++) push(text.charCodeAt(i))
  return h >>> 0
}

/**
 * The state after the first `step` ops, computed with ONE statevector.
 *
 * `simulateSteps` clones the vector after every gate and returns all frames —
 * right for the UI's scrubber, wrong here: at 16 qubits each clone is 1 MB,
 * so a 2,000-gate circuit (well inside the QASM size cap) held 2 GB of
 * Float64Arrays at once and could OOM the single web replica from one
 * unauthenticated request. Simulating the prefix keeps exactly one vector.
 */
function stateAfterStep(circuit: Circuit, step: number): StateVector {
  const prefix: Circuit = { ...circuit, ops: circuit.ops.slice(0, step) }
  if (hasClassicalControl(circuit)) {
    return execute(prefix, { rng: mulberry32(stepSeed(circuit)) }).state.normalize()
  }
  return simulate(prefix)
}

// ────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────

const runCircuit: McpToolDef = {
  name: 'run_circuit',
  title: 'Run a quantum circuit',
  description:
    'Simulate an OpenQASM 3 circuit on an ideal statevector simulator and sample measurement ' +
    'outcomes. Returns the shot counts AND the final statevector amplitudes (most simulators ' +
    'return counts only) so you can reason about phases, not just probabilities. ' +
    `Limits: ${MCP_MAX_QUBITS} qubits, shots clamped to 1–${MCP_MAX_SHOTS}. ` +
    'Pass a seed for reproducible sampling.',
  inputSchema: {
    type: 'object',
    properties: {
      qasm: {
        type: 'string',
        description:
          'OpenQASM 3 source. Supported gates: h x y z s sdg t tdg rx ry rz p cx cy cz swap ccx.',
      },
      shots: {
        type: 'integer',
        description: `Measurement samples, clamped to 1–${MCP_MAX_SHOTS}. Default ${MCP_DEFAULT_SHOTS}.`,
      },
      seed: {
        type: 'integer',
        description: 'Optional PRNG seed for reproducible counts.',
      },
    },
    required: ['qasm'],
  },
  handler: (args) => {
    const parsed = circuitFromArgs(args)
    if ('error' in parsed) return parsed.error
    const shots = clampInt(args.shots, 1, MCP_MAX_SHOTS, MCP_DEFAULT_SHOTS)
    const seed =
      typeof args.seed === 'number' && Number.isInteger(args.seed) ? args.seed : undefined

    let result
    try {
      result = run(parsed.circuit, shots, 0, seed)
    } catch (cause) {
      return err(`Simulation failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    const sparse: { state: string; re: number; im: number; probability: number }[] = []
    let omitted = 0
    for (let i = 0; i < result.statevector.length; i++) {
      const a = result.statevector[i]
      const probability = result.probabilities[i]
      if (Math.sqrt(probability) < AMPLITUDE_FLOOR) {
        omitted += 1
        continue
      }
      sparse.push({ state: result.labels[i], re: a.re, im: a.im, probability })
    }

    return ok({
      numQubits: parsed.circuit.numQubits,
      gateCount: parsed.circuit.ops.length,
      shots,
      counts: result.counts,
      statevector: sparse,
      omittedNearZeroAmplitudes: omitted,
      conventions:
        'Bitstring labels are MSB-first (qubit 0 is the rightmost character), matching Qiskit.',
    })
  },
}

const getStatevectorAtStep: McpToolDef = {
  name: 'get_statevector_at_step',
  title: 'Inspect the state mid-circuit',
  description:
    'Step-through inspector: simulate an OpenQASM 3 circuit and return the statevector AFTER ' +
    'step N (step 0 is the initial |0…0⟩ state, step k is the state after the k-th gate). ' +
    'Also returns each qubit’s Bloch vector at that step. Use it to watch superposition and ' +
    'entanglement appear gate by gate.',
  inputSchema: {
    type: 'object',
    properties: {
      qasm: { type: 'string', description: 'OpenQASM 3 source (same gate set as run_circuit).' },
      step: {
        type: 'integer',
        description: 'Which state to return: 0 = before any gate, k = after the k-th gate.',
      },
    },
    required: ['qasm', 'step'],
  },
  handler: (args) => {
    const parsed = circuitFromArgs(args)
    if ('error' in parsed) return parsed.error
    const totalSteps = parsed.circuit.ops.length
    const step = int(args.step, 0, totalSteps, 'step')
    if (!step.ok) {
      return err(`${step.error} This circuit has ${totalSteps} step(s), so valid steps are 0–${totalSteps}.`)
    }

    let frame: StateVector
    try {
      frame = stateAfterStep(parsed.circuit, step.value)
    } catch (cause) {
      return err(`Simulation failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }

    const { entries, omitted } = sparseAmplitudes(frame)
    const appliedOp = step.value === 0 ? null : parsed.circuit.ops[step.value - 1]

    return ok({
      numQubits: parsed.circuit.numQubits,
      step: step.value,
      totalSteps,
      appliedGate: appliedOp
        ? { name: appliedOp.name, qubits: appliedOp.qubits, theta: appliedOp.theta ?? null }
        : null,
      statevector: entries,
      omittedNearZeroAmplitudes: omitted,
      blochVectors: Array.from({ length: frame.numQubits }, (_, q) => ({
        qubit: q,
        ...frame.blochVector(q),
        entanglementEntropy: frame.entanglementEntropy(q),
      })),
      conventions:
        'Bitstring labels are MSB-first (qubit 0 is the rightmost character), matching Qiskit.',
    })
  },
}

const listChallenges: McpToolDef = {
  name: 'list_challenges',
  title: 'List circuit challenges',
  description:
    'The full challenge catalogue: id, brief, difficulty, register size, and — where the ' +
    'challenge provides fixed apparatus — the starting circuit as QASM. Grade an attempt with ' +
    'grade_challenge. Hints are withheld here so a solver earns them; a failed grade returns one.',
  inputSchema: { type: 'object', properties: {} },
  handler: () =>
    ok({
      count: CHALLENGES.length,
      challenges: CHALLENGES.map((ch) => ({
        id: ch.id,
        title: ch.title,
        brief: ch.brief,
        kind: ch.kind,
        level: ch.level,
        numQubits: ch.numQubits,
        lessonSlug: ch.lessonSlug,
        maxGates: ch.maxGates ?? null,
        hintCount: ch.hints.length,
        startingCircuitQasm: ch.startingCircuit ? toQasm(ch.startingCircuit) : null,
      })),
    }),
}

/**
 * A generated challenge's id encodes everything needed to rebuild it:
 * `gen-<kind>-d<difficulty>-s<seed>` (the exact format generateChallenge
 * emits). This is how grade_challenge grades attempts against challenges that
 * are not in the static catalogue: the id IS the inline challenge params, and
 * regenerating from it is strictly safer than trusting caller-supplied target
 * probabilities — the regenerated challenge is verified-solvable by execution,
 * whereas a free-form target could be fiction the grader then "authoritatively"
 * fails every attempt against. Generation is pure and deterministic, so the
 * regrade sees bit-for-bit the same challenge generate_challenge returned.
 */
const GENERATED_ID_RE = /^gen-(target-state|target-distribution|fix-the-bug)-d([123])-s(\d{1,10})$/

function challengeFromGeneratedId(id: string): GeneratedChallenge | null {
  const match = GENERATED_ID_RE.exec(id)
  if (!match) return null
  const kind = match[1] as GeneratedKind
  const difficulty = Number(match[2]) as Difficulty
  const seed = Number(match[3])
  if (!Number.isSafeInteger(seed) || seed > 0xffffffff) return null
  return generateChallenge(kind, difficulty, seed)
}

function resolveChallenge(id: string): Challenge | null {
  return getChallenge(id) ?? challengeFromGeneratedId(id)
}

const gradeChallenge: McpToolDef = {
  name: 'grade_challenge',
  title: 'Grade a challenge attempt',
  description:
    'Run a submitted OpenQASM 3 circuit through the same deterministic grader the Qubit16 ' +
    'UI uses and return pass/fail, a score, and per-check feedback. Grading is phase-aware ' +
    'where the challenge demands it and never compares raw amplitudes (global phase is ignored). ' +
    'Accepts catalogue ids from list_challenges AND generated ids from generate_challenge ' +
    '(gen-<kind>-d<difficulty>-s<seed> — the challenge is deterministically rebuilt from the id).',
  inputSchema: {
    type: 'object',
    properties: {
      challenge_id: {
        type: 'string',
        description: 'A challenge id from list_challenges or generate_challenge.',
      },
      qasm: { type: 'string', description: 'The attempted circuit as OpenQASM 3.' },
    },
    required: ['challenge_id', 'qasm'],
  },
  handler: (args) => {
    const id = str(args.challenge_id, 100, 'challenge_id')
    if (!id.ok) return err(id.error)
    const challenge = resolveChallenge(id.value)
    if (!challenge) {
      return err(
        `Unknown challenge id "${id.value}". Valid ids: ${CHALLENGES.map((c) => c.id).join(', ')}, ` +
          'or a generated id of the form gen-<kind>-d<difficulty>-s<seed> from generate_challenge.',
      )
    }
    const parsed = circuitFromArgs(args)
    if ('error' in parsed) return parsed.error

    const verdict = grade(challenge, parsed.circuit)
    return ok({
      challengeId: challenge.id,
      passed: verdict.passed,
      score: verdict.score,
      summary: verdict.summary,
      checks: verdict.checks,
      gateCount: verdict.gateCount,
      parCount: verdict.parCount ?? null,
      // The same escalation the UI offers: a success note on a pass, the first
      // hint on a fail. Further hints stay in the app, on purpose.
      successNote: verdict.passed ? challenge.successNote : null,
      hint: verdict.passed ? null : challenge.hints[0] ?? null,
    })
  },
}

const listLessons: McpToolDef = {
  name: 'list_lessons',
  title: 'List course lessons',
  description:
    'Metadata for every lesson in the Qubit16 course: slug, title, level, minutes, ' +
    'prerequisites, objectives, and whether the full body is free. Fetch one with get_lesson.',
  inputSchema: { type: 'object', properties: {} },
  handler: () =>
    ok({
      tracks: TRACKS.map((track) => ({
        id: track.id,
        name: track.name,
        blurb: track.blurb,
        lessonSlugs: track.lessonSlugs,
      })),
      lessons: LESSONS.map((lesson) => ({
        slug: lesson.slug,
        title: lesson.title,
        subtitle: lesson.subtitle,
        level: lesson.level,
        minutes: lesson.minutes,
        prerequisites: lesson.prerequisites,
        objectives: lesson.objectives,
        track: trackForLesson(lesson.slug),
        free: isLessonFree(lesson.slug),
      })),
    }),
}

const getLessonTool: McpToolDef = {
  name: 'get_lesson',
  title: 'Read a lesson',
  description:
    'One lesson by slug. Free (foundations) lessons include the full body — prose, code, ' +
    'quizzes, key points. Paid (advanced track) lessons return metadata only; their bodies are ' +
    'never served on this surface.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'A lesson slug from list_lessons.' },
    },
    required: ['slug'],
  },
  handler: (args) => {
    const slug = str(args.slug, 100, 'slug')
    if (!slug.ok) return err(slug.error)
    const meta = getLessonMeta(slug.value)
    if (!meta) {
      return err(
        `Unknown lesson slug "${slug.value}". Valid slugs: ${LESSONS.map((l) => l.slug).join(', ')}.`,
      )
    }

    const free = isLessonFree(meta.slug)
    // THE PAYWALL, restated as control flow: the body module is not even asked
    // for a paid slug. Do not weaken this to "fetch then filter" — the whole
    // point is that paid text cannot reach the serialiser on this surface.
    const body = free ? getLessonBody(meta.slug) ?? null : null

    return ok({
      slug: meta.slug,
      title: meta.title,
      subtitle: meta.subtitle,
      level: meta.level,
      minutes: meta.minutes,
      prerequisites: meta.prerequisites,
      objectives: meta.objectives,
      track: trackForLesson(meta.slug),
      free,
      body,
      bodyWithheld: !free,
      ...(free
        ? {}
        : {
            note:
              'This lesson is part of the paid Advanced track. Its body is not available over ' +
              'MCP; read it in the app at /learn/' + meta.slug + ' with a Pro subscription.',
          }),
    })
  },
}

const getGateReference: McpToolDef = {
  name: 'get_gate_reference',
  title: 'Quantum gate reference',
  description:
    'The full gate library this simulator supports — the same entries the circuit builder ' +
    'palette shows — with arity, whether the gate takes an angle, the QASM name to use in ' +
    'run_circuit, and a teaching description.',
  inputSchema: { type: 'object', properties: {} },
  handler: () =>
    ok({
      count: GATE_LIBRARY.length,
      gates: GATE_LIBRARY.map((gate) => ({
        name: gate.name,
        label: gate.label,
        qasmName: MCP_QASM_NAME[gate.name] ?? gate.name.toLowerCase(),
        arity: gate.arity,
        variadic: gate.variadic === true,
        takesAngle: gate.hasAngle,
        description: gate.description,
      })),
      usage:
        'Angle gates are written rx(pi/2) q[0]; multi-qubit gates list control(s) first, ' +
        'e.g. cx q[0], q[1]; and ccx q[0], q[1], q[2];. A multi-controlled X is ' +
        'ctrl(n) @ x q[c1], ..., q[t];. Register blocks are gate definitions named ' +
        'qb16_add_<k>_mod_<N>_w<width>, qb16_mul_<k>_mod_<N>_w<width>, qb16_qft_w<width> and ' +
        'qb16_iqft_w<width> (register listed least-significant qubit first; prefix ctrl(1) @ ' +
        'for a control); export a circuit from the app to see their bodies.',
    }),
}

/** QASM spellings that are not simply the lower-cased gate name. */
const MCP_QASM_NAME: Partial<Record<string, string>> = {
  MEASURE: 'measure',
  BARRIER: 'barrier',
  MCX: 'ctrl(n) @ x',
  UNITARY: 'gate qb16_u<n> … (custom definition; see usage)',
  ADDK: 'qb16_add_<k>_mod_<N>_w<width>',
  MULK: 'qb16_mul_<k>_mod_<N>_w<width>',
  QFT: 'qb16_qft_w<width>',
  IQFT: 'qb16_iqft_w<width>',
  RESET: 'reset',
  U3: 'U',
  POSTSELECT: '// qubit16:postselect (idealized, simulator-only; see usage)',
}

// ────────────────────────────────────────────────────────────
// Generated practice challenges
// ────────────────────────────────────────────────────────────

const generateChallengeTool: McpToolDef = {
  name: 'generate_challenge',
  title: 'Generate a practice challenge',
  description:
    'Generate a fresh, verified-solvable practice challenge. Deterministic: the same ' +
    '(kind, difficulty, seed) always yields the same challenge, and every challenge was ' +
    'verified by execution before being returned — the generator ran its own reference ' +
    'solution through the real simulator and grader and confirmed a full pass, that the ' +
    'empty circuit fails, and that every solution gate matters (so par is tight). Grade ' +
    'attempts with grade_challenge using the returned id. Hints and the reference solution ' +
    'are withheld here; a failed grade earns the first hint.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...GENERATED_KINDS],
        description:
          'target-state: reach an exact distribution. target-distribution: match a histogram ' +
          'within tolerance. fix-the-bug: repair a circuit with exactly one corrupted gate.',
      },
      difficulty: {
        type: 'integer',
        description: '1 = one qubit / 2 gates, 2 = two qubits / 2-3 gates, 3 = three qubits / 3 gates.',
      },
      seed: {
        type: 'integer',
        description:
          'Reproducibility seed, 0 to 4294967295. Default 0. Same seed, same challenge — vary ' +
          'it for a new puzzle.',
      },
    },
    required: ['kind', 'difficulty'],
  },
  handler: (args) => {
    const kind = oneOf(args.kind, GENERATED_KINDS, 'kind')
    if (!kind.ok) return err(kind.error)
    const difficulty = int(args.difficulty, 1, 3, 'difficulty')
    if (!difficulty.ok) return err(difficulty.error)
    const seed = args.seed === undefined ? { ok: true as const, value: 0 } : int(args.seed, 0, 0xffffffff, 'seed')
    if (!seed.ok) return err(seed.error)

    const challenge = generateChallenge(
      kind.value as GeneratedKind,
      difficulty.value as Difficulty,
      seed.value
    )

    // What is returned mirrors list_challenges: everything a solver needs, and
    // NOT the hints or the reference solution — those would hand over the
    // answer with the puzzle. grade_challenge rebuilds them from the id.
    return ok({
      id: challenge.id,
      title: challenge.title,
      brief: challenge.brief,
      kind: challenge.kind,
      level: challenge.level,
      difficulty: challenge.difficulty,
      seed: challenge.seed,
      numQubits: challenge.numQubits,
      lessonSlug: challenge.lessonSlug,
      maxGates: challenge.maxGates ?? null,
      tolerance: challenge.tolerance ?? null,
      targetProbabilities: challenge.targetProbabilities ?? null,
      startingCircuitQasm: challenge.startingCircuit ? toQasm(challenge.startingCircuit) : null,
      hintCount: challenge.hints.length,
      grading:
        `Submit attempts via grade_challenge with challenge_id "${challenge.id}". ` +
        'Basis-state order for targetProbabilities is MSB-first labels 0…2^n-1, matching run_circuit.',
    })
  },
}

// ────────────────────────────────────────────────────────────
// Session planning — stateless over a caller-supplied snapshot
// ────────────────────────────────────────────────────────────

/** Coerce an untrusted progress payload into the exact Progress shape. Junk
 *  fields are dropped rather than rejected: a partial snapshot still yields a
 *  useful plan, and buildSessionPlan treats missing data as "not started". */
function coerceProgress(value: unknown): Progress {
  const record = isRecord(value) ? value : {}
  const completed = Array.isArray(record.completed)
    ? record.completed.filter((slug): slug is string => typeof slug === 'string').slice(0, 200)
    : []
  const quizScores: Record<string, number> = {}
  if (isRecord(record.quizScores)) {
    for (const [slug, score] of Object.entries(record.quizScores)) {
      if (typeof score === 'number' && Number.isFinite(score)) quizScores[slug] = score
    }
  }
  return { completed, quizScores }
}

/** Keep only record-shaped attempts; the planner reads `examId` and `score`
 *  and ignores everything else, so this is the whole shape that matters. */
function coerceExamAttempts(value: unknown): ExamAttempt[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).slice(0, 100) as unknown as ExamAttempt[]
}

const getSessionPlan: McpToolDef = {
  name: 'get_session_plan',
  title: 'Build a study session plan',
  description:
    'Turn a learner progress snapshot into a structured study plan: weak skills (started but ' +
    'below the mastery bar), next unlocked concepts, and a diagnose → teach → practice → check ' +
    'session with concrete lesson slugs, challenge ids and app routes. STATELESS: the plan is ' +
    'computed from the arguments alone using the same recommender as the /coach page — nothing ' +
    'is stored, and the same snapshot always yields the same plan. Pass an empty progress ' +
    'object for a start-here plan.',
  inputSchema: {
    type: 'object',
    properties: {
      progress: {
        type: 'object',
        description:
          'The learner snapshot: { completed: string[] (lesson slugs), quizScores: ' +
          '{ [lessonSlug]: fraction 0..1 } }. Unknown fields are ignored.',
        properties: {
          completed: { type: 'array', items: { type: 'string' } },
          quizScores: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
      exam_attempts: {
        type: 'array',
        description:
          'Optional certification-exam attempts: [{ examId: string, score: fraction 0..1 }]. ' +
          'Scores set a mastery floor for the concepts each exam covers.',
        items: { type: 'object' },
      },
      goal: {
        type: 'string',
        description: "Optional goal lesson slug to steer the plan towards (from list_lessons).",
      },
    },
    required: ['progress'],
  },
  handler: (args) => {
    const progress = coerceProgress(args.progress)
    const attempts = coerceExamAttempts(args.exam_attempts)
    let goal: string | undefined
    if (args.goal !== undefined) {
      const checked = str(args.goal, 100, 'goal')
      if (!checked.ok) return err(checked.error)
      goal = checked.value
    }
    const plan = buildSessionPlan(progress, attempts, goal)
    return ok({
      weakSkills: plan.weakSkills,
      nextConcepts: plan.nextConcepts,
      suggestedSession: plan.suggestedSession,
      stateless: 'Computed from the supplied snapshot only; nothing was stored.',
    })
  },
}

// ────────────────────────────────────────────────────────────
// Notebook export
// ────────────────────────────────────────────────────────────

const NOTEBOOK_VARIANTS = ['qiskit', 'pennylane'] as const

const exportNotebook: McpToolDef = {
  name: 'export_notebook',
  title: 'Export a circuit as a Jupyter notebook',
  description:
    'Build a runnable Jupyter notebook (.ipynb, nbformat 4.5) from an OpenQASM 3 circuit — the ' +
    'same export the app offers. The qiskit variant loads the QASM via qiskit.qasm3 and runs it ' +
    'on Aer or the reference Sampler; the pennylane variant rebuilds the circuit gate by gate ' +
    '(PennyLane has no QASM 3 importer). The result is deterministic: the same circuit exports ' +
    'byte-identical notebooks. Save the `notebook` string as a .ipynb file.',
  inputSchema: {
    type: 'object',
    properties: {
      qasm: { type: 'string', description: 'OpenQASM 3 source (same gate set as run_circuit).' },
      variant: {
        type: 'string',
        enum: [...NOTEBOOK_VARIANTS],
        description: 'Target framework: "qiskit" or "pennylane".',
      },
      name: {
        type: 'string',
        description: 'Optional notebook title, also used for the suggested filename.',
      },
    },
    required: ['qasm', 'variant'],
  },
  handler: (args) => {
    const variant = oneOf(args.variant, NOTEBOOK_VARIANTS, 'variant')
    if (!variant.ok) return err(variant.error)
    const parsed = circuitFromArgs(args)
    if ('error' in parsed) return parsed.error
    let name = 'Qubit16 circuit'
    if (args.name !== undefined) {
      const checked = str(args.name, 200, 'name')
      if (!checked.ok) return err(checked.error)
      name = checked.value
    }
    const notebook = buildNotebook(parsed.circuit, variant.value as NotebookVariant, name)
    return ok({
      variant: variant.value,
      filename: notebookFilename(name, variant.value as NotebookVariant),
      numQubits: parsed.circuit.numQubits,
      gateCount: parsed.circuit.ops.length,
      notebook,
    })
  },
}

// ────────────────────────────────────────────────────────────
// Hardware submission — the ONE authenticated tool
// ────────────────────────────────────────────────────────────

const HW_PROVIDERS = ['ibm', 'braket'] as const

const submitHardwareJob: McpToolDef = {
  name: 'submit_hardware_job',
  title: 'Submit a circuit to real quantum hardware',
  description:
    'Submit an OpenQASM 3 circuit to a real quantum device (IBM or AWS Braket). THIS SPENDS ' +
    'REAL MONEY AND REQUIRES AUTHENTICATION: the MCP request must carry an ' +
    '"Authorization: Bearer <supabase access token>" header for a signed-in Qubit16 ' +
    'account on a plan that includes hardware.real (Pro or above). The submission goes ' +
    'through the exact /api/hardware/submit gate chain the web app uses — rate limits, ' +
    'identity, entitlement, and the monthly job quota — and refuses with the same errors. ' +
    'Unauthenticated calls are refused without contacting any provider.',
  inputSchema: {
    type: 'object',
    properties: {
      qasm: { type: 'string', description: 'OpenQASM 3 source to run on hardware.' },
      backend: {
        type: 'string',
        description: 'Device id, e.g. "ibm_brisbane" (see the app’s /hardware page).',
      },
      shots: { type: 'integer', description: 'Measurement shots, 1–20000. Default 1024.' },
      provider: {
        type: 'string',
        enum: [...HW_PROVIDERS],
        description: 'Optional; derived from the backend id when omitted.',
      },
    },
    required: ['qasm', 'backend'],
  },
  handler: async (args, ctx) => {
    // The auth boundary, enforced FIRST: no token, no work, no upstream call.
    // The token comes from the transport header only — an "authorization"
    // argument in the tool call would be a claim, not an identity.
    const authorization = ctx.authorization ?? null
    if (!authorization || !/^bearer\s+\S+/i.test(authorization)) {
      return err(
        'submit_hardware_job requires authentication: connect to this MCP server with an ' +
          '"Authorization: Bearer <supabase access token>" header for your Qubit16 account. ' +
          'Sign in at the app to obtain a session token. Running on real hardware is a Pro ' +
          'feature; nothing was submitted.'
      )
    }

    // Cheap presence checks for readable errors; the route re-validates
    // authoritatively (sizes, provider enum, shots bounds).
    const qasm = typeof args.qasm === 'string' ? args.qasm : ''
    if (qasm.trim().length === 0) return err('qasm must be a non-empty OpenQASM 3 string.')
    const backend = str(args.backend, 64, 'backend')
    if (!backend.ok) return err(backend.error)

    // Dynamically import the REAL route handler and dispatch an internal
    // Request to it. Every gate in that file runs: IP limit, requireCaller,
    // per-account limit, shape validation, requireFeature('hardware.real'),
    // the atomic quota reservation, and only then the upstream forward. The
    // import is dynamic so the unauthenticated refusal above never loads the
    // billing stack at all.
    const { POST } = await import('@/app/api/hardware/submit/route')
    // The hardware route's IP limiter must land in the bucket the MCP route
    // already limited, so it gets the transport-trusted address under both
    // header names — never the request's raw x-forwarded-for.
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization,
      ...trustedAddressHeaders(ctx),
    }
    const body: Record<string, unknown> = {
      qasm,
      backend: backend.value,
      shots: typeof args.shots === 'number' ? args.shots : 1024,
    }
    if (args.provider !== undefined) body.provider = args.provider

    const response = await POST(
      new Request('http://localhost/api/hardware/submit', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    )

    let payload: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await response.json()
      payload = isRecord(parsed) ? parsed : null
    } catch {
      payload = null
    }

    if (response.status >= 200 && response.status < 300) {
      return ok({
        submitted: true,
        status: response.status,
        job: payload,
        note: 'The job is queued at the provider; poll it from the app’s /hardware page.',
      })
    }
    const detail =
      (payload && typeof payload.detail === 'string' && payload.detail) ||
      (payload && typeof payload.error === 'string' && payload.error) ||
      'Submission refused.'
    return err(`Hardware submission refused (HTTP ${response.status}): ${detail}`)
  },
}

// ────────────────────────────────────────────────────────────
// Verified circuit generation — the workbench loop, for agents
// ────────────────────────────────────────────────────────────

/**
 * Wrap a live adapter so a provider failure reaches the caller as a fixed
 * sentence. The loop in lib/workbench/generate.ts copies a rejection's message
 * into the structured result (`error`, `attempts[].parseError`); for an
 * AI SDK call error that message is the provider's response text — deployment
 * and model names, quota wording, hostnames. The real error goes to
 * observability instead.
 */
export function scrubProviderErrors(adapter: ProviderAdapter): ProviderAdapter {
  return {
    label: adapter.label,
    complete: async (request, signal) => {
      try {
        return await adapter.complete(request, signal)
      } catch (cause) {
        reportError(cause, { route: 'mcp', tool: 'generate_verified_circuit', stage: 'complete' })
        throw new Error('The model provider returned an error; try again later.')
      }
    },
  }
}

/**
 * The generate → verify → repair loop from lib/workbench/generate.ts. The
 * loop itself is pure; the model behind it is resolved HERE, at call time,
 * exactly as app/api/workbench/generate/route.ts resolves it: the caller's
 * verified identity (from the transport's Authorization header) → entitlement
 * → tier → the admin-configured policy for that tier → ONE unit of that
 * tier's daily model quota, charged before any model is built. Anonymous
 * callers therefore get what the admin allows anonymous callers, including
 * the same `messagesPerDay` cap the tutor applies — before this gate an
 * anonymous MCP client could run up to MAX_ATTEMPTS_CEILING paid completions
 * per call at the transport's 1,000/hour, with no daily bound at all. When
 * the caller gets no model the tool still verifies a supplied candidate and
 * says plainly that no model was called.
 *
 * The access and provider modules are imported dynamically so that the
 * registry (and its tests) load without the AI SDK or Supabase, and so the
 * candidate-only path never touches identity, quota or provider configuration.
 */
const generateVerifiedCircuitTool: McpToolDef = {
  name: 'generate_verified_circuit',
  title: 'Generate a circuit verified against a spec',
  description:
    'Turn a SPEC — a target measurement distribution, a target statevector, or a target unitary ' +
    '(each up to global phase where that applies), with optional gate-set / depth / gate-count ' +
    'constraints — into a circuit that PASSES that spec on an exact statevector simulator. Runs a ' +
    'generate → verify → repair loop: a model proposes a circuit, the simulator checks it, and on ' +
    'failure the diagnostics (which basis states are off and by how much, fidelity, which gates ' +
    'violate constraints) are fed back for another round. Every attempt is returned with its ' +
    'circuit, verdict and diff. Pass candidate_qasm to check your own circuit first (with ' +
    'max_attempts: 1 this is a pure verifier and calls no model). ' +
    'A pass means the circuit matches YOUR spec on an ideal simulator — not that the spec is what ' +
    'you meant, and nothing about hardware.',
  inputSchema: GENERATE_TOOL_INPUT_SCHEMA as unknown as JsonSchema,
  handler: async (args, ctx) => {
    const parsed = parseGenerateArgs(args)
    if (!parsed.ok) return err(parsed.error)
    const { spec, maxAttempts, candidate } = parsed.input

    // Only look for a model if one could be needed: no candidate, or more
    // rounds than the candidate alone accounts for. Asking charges the quota.
    let provider: ProviderAdapter | null = null
    let providerNote: string | null = null
    if (!candidate || maxAttempts > 1) {
      try {
        const { liveModelForCaller } = await import('@/lib/llm/callerAccess')
        const access = await liveModelForCaller(
          { authorization: ctx.authorization ?? null, clientIp: ctx.clientIp ?? ctx.forwardedFor ?? null },
          GENERATE_QUOTA_PREFIX,
        )
        if (access.kind === 'live') {
          const { adapterFor } = await import('@/lib/workbench/liveProvider')
          provider = scrubProviderErrors(adapterFor(access.resolution))
        } else {
          providerNote = access.note
        }
      } catch (cause) {
        // The cause can name a provider host, deployment or key problem; that
        // belongs in observability, not in an anonymous caller's reply.
        reportError(cause, { route: 'mcp', tool: 'generate_verified_circuit', stage: 'provider' })
        providerNote = 'No model: provider setup failed; only the candidate (if any) was verified.'
      }
    }

    const result = await generateVerifiedCircuit(spec, provider, { maxAttempts, candidate })
    const payload = serializeGenerateResult(result, spec)
    return ok({
      ...payload,
      ...(providerNote ? { providerNote } : {}),
      conventions:
        'Bitstring labels are MSB-first (qubit 0 is the rightmost character), matching run_circuit.',
    })
  },
}

// ────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────

/**
 * Refuse a tool call whose `qasm` argument holds more than MCP_MAX_OPS gates,
 * before the wrapped handler simulates it. Text over the size cap or that does
 * not parse is left for the handler to reject with its own, more specific
 * message.
 */
export function withOpCeiling(tool: McpToolDef): McpToolDef {
  return {
    ...tool,
    handler: (args, ctx) => {
      const qasm = args.qasm
      if (typeof qasm === 'string' && qasm.length <= MCP_MAX_QASM_CHARS) {
        let ops = 0
        try {
          ops = fromQasm(qasm).ops.length
        } catch {
          ops = 0
        }
        if (ops > MCP_MAX_OPS) {
          return err(
            `This circuit has ${ops} gates; the ceiling is ${MCP_MAX_OPS}. ` +
              'Split it into shorter circuits or drop the repeated section.',
          )
        }
      }
      return tool.handler(args, ctx)
    },
  }
}

export const MCP_TOOLS: McpToolDef[] = [
  runCircuit,
  getStatevectorAtStep,
  listChallenges,
  gradeChallenge,
  generateChallengeTool,
  getSessionPlan,
  exportNotebook,
  submitHardwareJob,
  listLessons,
  getLessonTool,
  getGateReference,
  generateVerifiedCircuitTool,
  // Workbench: experiment records (lib/workbench/experimentTools.ts). run_step
  // simulates the caller's QASM through lib/workbench/targets.ts, which has no
  // gate-count bound of its own, so it gets the same ceiling here.
  ...EXPERIMENT_TOOLS.map((tool) => (tool.name === 'run_step' ? withOpCeiling(tool) : tool)),
]

const TOOL_BY_NAME: ReadonlyMap<string, McpToolDef> = new Map(
  MCP_TOOLS.map((tool) => [tool.name, tool]),
)

/** Lookup for the route's `tools/call` dispatch. Unknown name → undefined. */
export function getTool(name: string): McpToolDef | undefined {
  return TOOL_BY_NAME.get(name)
}

/** The exact `tools/list` result payload. */
export function listToolsResult(): { tools: Omit<McpToolDef, 'handler'>[] } {
  return {
    tools: MCP_TOOLS.map(({ name, title, description, inputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
    })),
  }
}

/**
 * Execute one tool. A handler that THROWS is converted to an `isError` tool
 * result rather than crashing the request — per the MCP spec, execution
 * failures are results the model can read, not protocol errors. The caller is
 * responsible for rejecting unknown names first (that IS a protocol error).
 */
export async function callToolAsync(
  name: string,
  args: unknown,
  ctx: ToolCallContext = {}
): Promise<ToolResult> {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool) {
    // Defence in depth for direct library callers; the route never gets here.
    return err(`Unknown tool "${name}".`)
  }
  const record: Record<string, unknown> =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  try {
    return await tool.handler(record, ctx)
  } catch (cause) {
    return toolFailure(name, cause)
  }
}

/**
 * An unexpected throw from a handler, as a tool result. The exception text is
 * reported to observability and NOT echoed: on this anonymous surface a raw
 * message can carry provider, hostname, table or constraint detail (the same
 * reasoning app/api/agent/route.ts records for provider bodies). Tools that
 * have something actionable to say return `err(...)` themselves.
 */
function toolFailure(name: string, cause: unknown): ToolResult {
  reportError(cause, { route: 'mcp', tool: name, stage: 'handler' })
  return err(`Tool "${name}" failed; try again later.`)
}

/**
 * The original SYNCHRONOUS entry point, kept because callers outside this
 * module (app/api/tools/route.ts, the REST facade) call it without awaiting
 * and its contract — never throws, always a ToolResult — predates the async
 * tools. Every tool except `submit_hardware_job` has a synchronous handler and
 * behaves identically through either entry point. A handler that returns a
 * Promise cannot be answered synchronously, so the honest reply here is a
 * pointer at the transport that can run it — NOT a silent await-less unwrap.
 */
export function callTool(name: string, args: unknown, ctx: ToolCallContext = {}): ToolResult {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool) {
    return err(`Unknown tool "${name}".`)
  }
  const record: Record<string, unknown> =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  try {
    const result = tool.handler(record, ctx)
    if (result instanceof Promise) {
      // Detach the in-flight work so an eventual rejection cannot surface as
      // an unhandled rejection; its outcome is unrepresentable here anyway.
      result.catch(() => undefined)
      return err(
        `Tool "${name}" is asynchronous and only available over the MCP endpoint ` +
          '(/api/mcp/mcp), which carries the Authorization header it requires.'
      )
    }
    return result
  } catch (cause) {
    return toolFailure(name, cause)
  }
}
