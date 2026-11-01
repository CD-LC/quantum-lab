/**
 * lib/workbench/experiments.ts — the experiment record and its storage.
 *
 * An Experiment is a lab notebook page an agent writes and a human reads the
 * next morning: a hypothesis stated up front, a sequence of steps that each
 * pin down the circuit, WHERE it ran (see lib/workbench/targets.ts), what came
 * back and a note, and a conclusion written once the steps are in. Steps are
 * append-only and never edited — a record whose history can be rewritten is
 * not a record.
 *
 * Storage is behind one interface with two implementations:
 *
 *   MemoryExperimentStore    A bounded in-process map. What the app uses when
 *                            no Supabase service role is configured — which
 *                            means records live as long as the server process
 *                            and are not shared between serverless instances.
 *                            The page says so.
 *   SupabaseExperimentStore  Two tables, `experiments` and `experiment_steps`
 *                            (supabase/schema-experiments.sql), accessed with
 *                            a client the caller hands in. Service-role only:
 *                            RLS is on and no policy exists, so the tables are
 *                            reachable solely from the route handlers and the
 *                            MCP tools, never from a browser session.
 *
 * This module has NO server-only imports (the client the Supabase store takes
 * is a type-only import) so the workbench page can import the types and the
 * memory store into the browser bundle for its built-in sample record.
 *
 * ── Who owns a record ──────────────────────────────────────────────────────
 * The MCP endpoint is unauthenticated by design for everything that does not
 * spend money, and writing a notebook entry does not spend money. So records
 * carry an `owner` — the verified caller id when the request had a bearer
 * token, otherwise null — for attribution only. There is no per-user privacy:
 * every record on a deployment is readable by everyone who can reach it. The
 * page states this plainly rather than implying otherwise.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report'
import type { StepResult, Target } from '@/lib/workbench/targets'

// ────────────────────────────────────────────────────────────
// Shapes
// ────────────────────────────────────────────────────────────

export interface ExperimentStep {
  /** 0-based position in the record. Assigned by the store, never the caller. */
  index: number
  /** ISO-8601 timestamp of when the step was recorded. */
  at: string
  /** The exact OpenQASM 3 that ran. */
  qasm: string
  target: Target
  shots: number
  seed: number | null
  result: StepResult
  /** The agent's note: why this step, what it expected. May be empty. */
  note: string
}

export interface Experiment {
  id: string
  title: string
  hypothesis: string
  steps: ExperimentStep[]
  /** Null until conclude() is called. */
  conclusion: string | null
  createdAt: string
  concludedAt: string | null
  /** Verified caller id when the creating request carried a token; else null. */
  owner: string | null
}

/** What list() returns: everything but the steps, plus a step count. */
export interface ExperimentSummary {
  id: string
  title: string
  hypothesis: string
  stepCount: number
  conclusion: string | null
  createdAt: string
  concludedAt: string | null
  owner: string | null
}

export interface CreateExperimentInput {
  title: string
  hypothesis: string
  owner?: string | null
}

export type NewStep = Omit<ExperimentStep, 'index' | 'at'>

/**
 * What leaves the process: the record without the author's account id.
 * `owner` is a Supabase user UUID; records are readable by anyone, so
 * publishing it would tie an account to everything it wrote. The id stays
 * inside the store (ownership checks need it); the wire gets a boolean.
 */
export type PublicExperiment = Omit<Experiment, 'owner'> & { signedInAuthor: boolean }
export type PublicExperimentSummary = Omit<ExperimentSummary, 'owner'> & { signedInAuthor: boolean }

export function toPublic(e: Experiment): PublicExperiment {
  const { owner, ...rest } = e
  return { ...rest, signedInAuthor: owner !== null }
}

export function toPublicSummary(s: ExperimentSummary): PublicExperimentSummary {
  const { owner, ...rest } = s
  return { ...rest, signedInAuthor: owner !== null }
}

// ────────────────────────────────────────────────────────────
// Limits — the same numbers whichever store is behind the interface
// ────────────────────────────────────────────────────────────

export const MAX_TITLE_CHARS = 200
export const MAX_HYPOTHESIS_CHARS = 4000
export const MAX_CONCLUSION_CHARS = 8000
export const MAX_NOTE_CHARS = 2000
export const MAX_STEPS_PER_EXPERIMENT = 200
/**
 * Bytes of JSON one step's result may occupy. A counts result (4,096 shots,
 * 256 amplitudes) is ~30 KB; this leaves room for a hardware job body and
 * refuses a payload that would bloat the table and every read of the record.
 */
export const MAX_STEP_RESULT_BYTES = 100_000
/** Characters of QASM a step may store (the same bound the run itself enforces). */
export const MAX_STEP_QASM_CHARS = 20_000
/** The memory store evicts the oldest record past this many. */
export const MEMORY_STORE_CAPACITY = 200
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200

// ────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────

/** Thrown by a store for a caller mistake the tool should report as a tool error. */
export class ExperimentError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'concluded' | 'too-many-steps' | 'too-large' | 'storage',
  ) {
    super(message)
    this.name = 'ExperimentError'
  }
}

// ────────────────────────────────────────────────────────────
// The interface
// ────────────────────────────────────────────────────────────

export interface ExperimentStore {
  /** Human-readable name for the page's "where did this go" line. */
  readonly kind: 'memory' | 'supabase'
  create(input: CreateExperimentInput): Promise<Experiment>
  get(id: string): Promise<Experiment | null>
  list(limit?: number): Promise<ExperimentSummary[]>
  /** Append a step; returns the updated record. Refuses on a concluded record. */
  appendStep(id: string, step: NewStep): Promise<Experiment>
  /** Set the conclusion; a concluded record may be re-concluded (the last word wins). */
  conclude(id: string, conclusion: string): Promise<Experiment>
}

// ────────────────────────────────────────────────────────────
// Helpers shared by both stores
// ────────────────────────────────────────────────────────────

/**
 * A v4-shaped id from whatever randomness the runtime offers. Node ≥ 19 and
 * every browser have crypto.randomUUID; the Math.random fallback is for the
 * odd test harness, and its ids are still 122 bits of entropy short of
 * colliding in any notebook a human will read.
 */
export function newExperimentId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const s = (n: number) => Array.from({ length: n }, hex).join('')
  return `${s(8)}-${s(4)}-4${s(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${s(3)}-${s(12)}`
}

export function summarise(e: Experiment): ExperimentSummary {
  return {
    id: e.id,
    title: e.title,
    hypothesis: e.hypothesis,
    stepCount: e.steps.length,
    conclusion: e.conclusion,
    createdAt: e.createdAt,
    concludedAt: e.concludedAt,
    owner: e.owner,
  }
}

/** Refuse a step whose stored form would be oversized. Shared by both stores. */
export function assertStepFits(step: NewStep): void {
  if (step.qasm.length > MAX_STEP_QASM_CHARS) {
    throw new ExperimentError(`A step's circuit may be at most ${MAX_STEP_QASM_CHARS} characters.`, 'too-large')
  }
  if (step.note.length > MAX_NOTE_CHARS) {
    throw new ExperimentError(`A step's note may be at most ${MAX_NOTE_CHARS} characters.`, 'too-large')
  }
  let bytes = 0
  try {
    bytes = JSON.stringify(step.result)?.length ?? 0
  } catch {
    bytes = Infinity
  }
  if (bytes > MAX_STEP_RESULT_BYTES) {
    throw new ExperimentError(
      `This step's result is too large to record (limit ${MAX_STEP_RESULT_BYTES} bytes of JSON).`,
      'too-large',
    )
  }
}

/**
 * A storage failure as the caller sees it: a fixed sentence. The backend's own
 * message (PostgREST text naming tables, columns, constraints) goes to
 * observability, never onto the wire.
 */
function storageFailure(cause: unknown, operation: string, sentence: string): ExperimentError {
  reportError(cause, { module: 'workbench/experiments', operation })
  return new ExperimentError(sentence, 'storage')
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)))
}

/** Deep-copy through JSON so a caller can never mutate the store's own object. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ────────────────────────────────────────────────────────────
// In-memory store
// ────────────────────────────────────────────────────────────

export class MemoryExperimentStore implements ExperimentStore {
  readonly kind = 'memory' as const
  private readonly records = new Map<string, Experiment>()

  constructor(
    private readonly capacity: number = MEMORY_STORE_CAPACITY,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateExperimentInput): Promise<Experiment> {
    const record: Experiment = {
      id: newExperimentId(),
      title: input.title,
      hypothesis: input.hypothesis,
      steps: [],
      conclusion: null,
      createdAt: this.now().toISOString(),
      concludedAt: null,
      owner: input.owner ?? null,
    }
    this.records.set(record.id, record)
    // Map iteration is insertion-ordered, so the first key is the oldest.
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value
      if (oldest === undefined) break
      this.records.delete(oldest)
    }
    return clone(record)
  }

  async get(id: string): Promise<Experiment | null> {
    const record = this.records.get(id)
    return record ? clone(record) : null
  }

  async list(limit?: number): Promise<ExperimentSummary[]> {
    const n = clampLimit(limit)
    return Array.from(this.records.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, n)
      .map(summarise)
  }

  async appendStep(id: string, step: NewStep): Promise<Experiment> {
    assertStepFits(step)
    const record = this.records.get(id)
    if (!record) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
    if (record.conclusion !== null) {
      throw new ExperimentError(
        `Experiment "${record.title}" is concluded; create a new experiment to keep running.`,
        'concluded',
      )
    }
    if (record.steps.length >= MAX_STEPS_PER_EXPERIMENT) {
      throw new ExperimentError(
        `Experiment "${record.title}" already holds ${MAX_STEPS_PER_EXPERIMENT} steps, the ceiling.`,
        'too-many-steps',
      )
    }
    record.steps.push({ ...clone(step), index: record.steps.length, at: this.now().toISOString() })
    return clone(record)
  }

  async conclude(id: string, conclusion: string): Promise<Experiment> {
    const record = this.records.get(id)
    if (!record) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
    record.conclusion = conclusion
    record.concludedAt = this.now().toISOString()
    return clone(record)
  }
}

// ────────────────────────────────────────────────────────────
// Supabase store — row shapes mirror supabase/schema-experiments.sql
// ────────────────────────────────────────────────────────────

export interface ExperimentRow {
  id: string
  title: string
  hypothesis: string
  conclusion: string | null
  created_at: string
  concluded_at: string | null
  owner: string | null
}

export interface ExperimentStepRow {
  experiment_id: string
  position: number
  created_at: string
  qasm: string
  target: Target
  shots: number
  seed: number | null
  result: StepResult
  note: string
}

/** Pure mapping, exported so the round trip is testable without a database. */
export function experimentToRows(e: Experiment): { experiment: ExperimentRow; steps: ExperimentStepRow[] } {
  return {
    experiment: {
      id: e.id,
      title: e.title,
      hypothesis: e.hypothesis,
      conclusion: e.conclusion,
      created_at: e.createdAt,
      concluded_at: e.concludedAt,
      owner: e.owner,
    },
    steps: e.steps.map((s) => ({
      experiment_id: e.id,
      position: s.index,
      created_at: s.at,
      qasm: s.qasm,
      target: s.target,
      shots: s.shots,
      seed: s.seed,
      result: s.result,
      note: s.note,
    })),
  }
}

/** Inverse of experimentToRows. Steps are sorted by position, whatever order they arrived in. */
export function rowsToExperiment(row: ExperimentRow, steps: ExperimentStepRow[]): Experiment {
  return {
    id: row.id,
    title: row.title,
    hypothesis: row.hypothesis,
    conclusion: row.conclusion,
    createdAt: row.created_at,
    concludedAt: row.concluded_at,
    owner: row.owner,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        index: s.position,
        at: s.created_at,
        qasm: s.qasm,
        target: s.target,
        shots: s.shots,
        seed: s.seed,
        result: s.result,
        note: s.note,
      })),
  }
}

export class SupabaseExperimentStore implements ExperimentStore {
  readonly kind = 'supabase' as const

  constructor(private readonly client: SupabaseClient) {}

  async create(input: CreateExperimentInput): Promise<Experiment> {
    const record: Experiment = {
      id: newExperimentId(),
      title: input.title,
      hypothesis: input.hypothesis,
      steps: [],
      conclusion: null,
      createdAt: new Date().toISOString(),
      concludedAt: null,
      owner: input.owner ?? null,
    }
    const { error } = await this.client.from('experiments').insert(experimentToRows(record).experiment)
    if (error) throw storageFailure(error, 'create', 'The experiment store is unavailable; the record was not saved.')
    return record
  }

  async get(id: string): Promise<Experiment | null> {
    const head = await this.client.from('experiments').select('*').eq('id', id).maybeSingle()
    if (head.error) throw storageFailure(head.error, 'get', 'The experiment store is unavailable; the record could not be read.')
    if (!head.data) return null
    const steps = await this.client
      .from('experiment_steps')
      .select('*')
      .eq('experiment_id', id)
      .order('position', { ascending: true })
    if (steps.error) throw storageFailure(steps.error, 'get-steps', 'The experiment store is unavailable; the record could not be read.')
    return rowsToExperiment(head.data as ExperimentRow, (steps.data ?? []) as ExperimentStepRow[])
  }

  async list(limit?: number): Promise<ExperimentSummary[]> {
    const n = clampLimit(limit)
    const { data, error } = await this.client
      .from('experiment_summaries')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(n)
    if (error) throw storageFailure(error, 'list', 'The experiment store is unavailable; the list could not be read.')
    return ((data ?? []) as (ExperimentRow & { step_count: number })[]).map((row) => ({
      id: row.id,
      title: row.title,
      hypothesis: row.hypothesis,
      stepCount: Number(row.step_count ?? 0),
      conclusion: row.conclusion,
      createdAt: row.created_at,
      concludedAt: row.concluded_at,
      owner: row.owner,
    }))
  }

  async appendStep(id: string, step: NewStep): Promise<Experiment> {
    // One RPC, one transaction: position is assigned under a row lock on the
    // parent so two agents appending at once cannot both claim step 7, and the
    // concluded / step-ceiling checks happen in the same statement.
    assertStepFits(step)
    const { data, error } = await this.client.rpc('append_experiment_step', {
      p_experiment_id: id,
      p_qasm: step.qasm,
      p_target: step.target,
      p_shots: step.shots,
      p_seed: step.seed,
      p_result: step.result,
      p_note: step.note,
      p_max_steps: MAX_STEPS_PER_EXPERIMENT,
    })
    if (error) {
      const message = error.message ?? ''
      if (/not found/i.test(message)) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
      if (/concluded/i.test(message)) {
        throw new ExperimentError('This experiment is concluded; create a new experiment to keep running.', 'concluded')
      }
      if (/ceiling/i.test(message)) {
        throw new ExperimentError(`This experiment already holds ${MAX_STEPS_PER_EXPERIMENT} steps, the ceiling.`, 'too-many-steps')
      }
      throw storageFailure(error, 'append-step', 'The experiment store is unavailable; the step was not recorded.')
    }
    void data
    const updated = await this.get(id)
    if (!updated) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
    return updated
  }

  async conclude(id: string, conclusion: string): Promise<Experiment> {
    const { data, error } = await this.client
      .from('experiments')
      .update({ conclusion, concluded_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) throw storageFailure(error, 'conclude', 'The experiment store is unavailable; the conclusion was not saved.')
    if (!data || data.length === 0) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
    const updated = await this.get(id)
    if (!updated) throw new ExperimentError(`No experiment with id "${id}".`, 'not-found')
    return updated
  }
}
