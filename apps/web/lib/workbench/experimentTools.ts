/**
 * lib/workbench/experimentTools.ts — the five experiment tools for the MCP
 * registry: create_experiment, run_step, conclude_experiment,
 * list_experiments, get_experiment.
 *
 * Built by a factory that takes the store and the hardware submitter, so the
 * whole surface is testable against a MemoryExperimentStore and a scripted
 * fake with no environment, no database and no network. The registry in
 * lib/mcp/server.ts appends `EXPERIMENT_TOOLS`, which is the same factory
 * bound to the process store (lib/workbench/experimentStore.ts) and the real
 * route submitter.
 *
 * What these tools do and do not do, in one place:
 *   · They write nothing except the record. A step's result is computed by
 *     lib/workbench/targets.ts — the ideal simulator, the noise model, or the
 *     hardware route with the caller's own bearer token and every gate intact.
 *   · A record's `owner` is the verified caller when the request carried a
 *     token (resolved by the caller of this module, never from a tool
 *     argument). Records are readable by anyone who can reach the deployment,
 *     but the owner's account id is never part of what is returned (only
 *     `signedInAuthor`), and an owned record can be written to only by its
 *     owner. Writes are rate-limited per caller (account when verified, else
 *     the transport-trusted address) so the shared notebook cannot be flooded.
 *   · A hardware step that is refused (no token, wrong plan, quota) records
 *     nothing: the tool error carries the route's own message, and the
 *     notebook stays a record of things that happened.
 */

import type { McpToolDef, ToolCallContext, ToolResult } from '@/lib/mcp/server'
import { str, optionalStr } from '@/lib/security/validate'
import {
  ExperimentError,
  MAX_CONCLUSION_CHARS,
  MAX_HYPOTHESIS_CHARS,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_STEPS_PER_EXPERIMENT,
  MAX_TITLE_CHARS,
  summarise,
  toPublic,
  toPublicSummary,
  type Experiment,
  type ExperimentStore,
} from '@/lib/workbench/experiments'
import { getExperimentStore } from '@/lib/workbench/experimentStore'
import { verifiedCallerId } from '@/lib/security/auth'
import { callerKey, rateLimit, type RateLimitRule } from '@/lib/rateLimit'
import { reportError } from '@/lib/observability/report'
import {
  DEFAULT_NOISE,
  DEFAULT_SHOTS,
  MAX_QUBITS_NOISY,
  MAX_QUBITS_SIMULATOR,
  MAX_SHOTS,
  TARGET_KINDS,
  describeTarget,
  parseTarget,
  runOnTarget,
  type HardwareSubmitter,
} from '@/lib/workbench/targets'
import { routeHardwareSubmitter } from '@/lib/workbench/hardwareSubmitter'
import { EXPERIMENT_TOOL_NAMES } from '@/lib/workbench/toolNames'

function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Attribution from the transport header. The tools do not verify the token
 * themselves (that is a network call to Supabase, and a wrong owner label is
 * harmless); an `ownerResolver` can be supplied to do so. Default: null owner.
 */
export type OwnerResolver = (ctx: ToolCallContext) => Promise<string | null>

/** Per-caller write ceilings, one rule per write tool. */
export interface ExperimentWriteLimits {
  create: RateLimitRule
  step: RateLimitRule
  conclude: RateLimitRule
}

/**
 * Per hour, per caller. A person working through an experiment makes a few
 * dozen calls; an unauthenticated loop at the transport's 1,000/hour would
 * otherwise insert ~1,000 public records an hour per address.
 */
export const DEFAULT_WRITE_LIMITS: ExperimentWriteLimits = {
  create: { limit: 20, windowMs: 3_600_000 },
  step: { limit: 150, windowMs: 3_600_000 },
  conclude: { limit: 40, windowMs: 3_600_000 },
}

export interface ExperimentToolsOptions {
  store: ExperimentStore
  hardware?: HardwareSubmitter
  resolveOwner?: OwnerResolver
  limits?: ExperimentWriteLimits
}

/**
 * The record as tools return it: the public shape (no account id) plus a link
 * a human can open.
 */
function present(e: Experiment): Record<string, unknown> {
  const pub = toPublic(e)
  return {
    ...pub,
    steps: pub.steps.map((s) => ({ ...s, targetLabel: describeTarget(s.target) })),
    url: `/workbench/experiments/${e.id}`,
  }
}

function storeFailure(cause: unknown): ToolResult {
  if (cause instanceof ExperimentError) return err(cause.message)
  // The raw cause can carry backend text (table, column, host); it goes to
  // observability and the caller gets a fixed sentence.
  reportError(cause, { module: 'workbench/experimentTools', stage: 'store' })
  return err('The experiment store is unavailable right now; try again later.')
}

/**
 * Charge one write against the caller's bucket: their account when verified,
 * else the transport-trusted address (never a raw forwarded header).
 */
async function chargeWrite(
  ctx: ToolCallContext,
  owner: string | null,
  action: string,
  rule: RateLimitRule,
): Promise<ToolResult | null> {
  const headers = new Headers()
  const address = (ctx.clientIp ?? ctx.forwardedFor ?? '').trim().slice(0, 64)
  if (address) headers.set('cf-connecting-ip', address)
  const decision = await rateLimit(callerKey(headers, `exp-${action}`, owner), rule)
  if (decision.allowed) return null
  const minutes = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 60_000))
  return err(`Too many experiment writes from this caller; try again in about ${minutes} min.`)
}

/** An owned record is writable only by its owner. */
function notYours(record: Experiment, owner: string | null): ToolResult | null {
  if (record.owner === null || record.owner === owner) return null
  return err('This experiment belongs to another account; start your own with create_experiment.')
}

const TARGET_SCHEMA = {
  type: 'object',
  description:
    'Where to run. { "kind": "simulator" } for the ideal statevector simulator; ' +
    '{ "kind": "noisy-simulator", "depolarizing1": 0.001, "depolarizing2": 0.01, "readoutError": 0.02 } ' +
    'for a Pauli-error model (each parameter optional, those are the defaults); ' +
    '{ "kind": "hardware", "backend": "ibm_brisbane", "provider": "ibm" } to submit to a real device ' +
    '(requires the Authorization header submit_hardware_job requires, and spends real money). ' +
    'A bare string "simulator" is accepted too.',
  properties: {
    kind: { type: 'string', enum: [...TARGET_KINDS] },
    depolarizing1: { type: 'number', description: 'noisy-simulator: 1-qubit gate depolarising probability, 0–1.' },
    depolarizing2: { type: 'number', description: 'noisy-simulator: 2-qubit gate depolarising probability, 0–1.' },
    readoutError: { type: 'number', description: 'noisy-simulator: per-bit readout flip probability, 0–0.5.' },
    backend: { type: 'string', description: 'hardware: device id, e.g. "ibm_brisbane".' },
    provider: { type: 'string', enum: ['ibm', 'braket'], description: 'hardware: optional; derived from the backend id.' },
  },
  required: ['kind'],
}

export function createExperimentTools(options: ExperimentToolsOptions): McpToolDef[] {
  const { store } = options
  const hardware = options.hardware ?? routeHardwareSubmitter
  const resolveOwner: OwnerResolver = options.resolveOwner ?? (async () => null)
  const limits = options.limits ?? DEFAULT_WRITE_LIMITS

  const createExperiment: McpToolDef = {
    name: 'create_experiment',
    title: 'Start an experiment record',
    description:
      'Open a new experiment: a lab-notebook record with a title and a hypothesis stated up front. ' +
      'Returns its id. Then call run_step for each circuit you run (the circuit, where it ran, the ' +
      'result and your note are appended, never edited) and conclude_experiment when you are done. ' +
      'A human reads the record at /workbench/experiments/<id>. Records on this deployment are ' +
      'readable by anyone who can reach that page; do not put secrets in them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `Short name for the record (≤ ${MAX_TITLE_CHARS} chars).` },
        hypothesis: {
          type: 'string',
          description:
            'What you expect and why, written before running anything ' +
            `(≤ ${MAX_HYPOTHESIS_CHARS} chars). A falsifiable sentence beats a paragraph.`,
        },
      },
      required: ['title', 'hypothesis'],
    },
    handler: async (args, ctx) => {
      const title = str(args.title, MAX_TITLE_CHARS, 'title')
      if (!title.ok) return err(title.error)
      const hypothesis = str(args.hypothesis, MAX_HYPOTHESIS_CHARS, 'hypothesis')
      if (!hypothesis.ok) return err(hypothesis.error)
      try {
        const owner = await resolveOwner(ctx)
        const limited = await chargeWrite(ctx, owner, 'create', limits.create)
        if (limited) return limited
        const record = await store.create({ title: title.value, hypothesis: hypothesis.value, owner })
        return ok({
          ...present(record),
          next:
            `Call run_step with experiment_id "${record.id}", a qasm string and a target for each ` +
            'circuit you run; then conclude_experiment.',
        })
      } catch (cause) {
        return storeFailure(cause)
      }
    },
  }

  const runStep: McpToolDef = {
    name: 'run_step',
    title: 'Run a circuit and record it as an experiment step',
    description:
      'Run an OpenQASM 3 circuit on a target and append the step — circuit, target parameters, ' +
      'result and your note — to an experiment record. Targets: "simulator" (ideal statevector; ' +
      `returns counts and amplitudes; ≤ ${MAX_QUBITS_SIMULATOR} qubits), "noisy-simulator" (a Pauli ` +
      'depolarising + readout-error model; returns counts and how many shots suffered a gate error; ' +
      `≤ ${MAX_QUBITS_NOISY} qubits), and "hardware" (submits through the same authenticated, ` +
      'quota-checked route as submit_hardware_job and records the job handle; a refused submission ' +
      `records nothing). Shots clamp to 1–${MAX_SHOTS}, default ${DEFAULT_SHOTS}; pass a seed for ` +
      'reproducible simulator counts. Steps are append-only and a concluded experiment refuses new ones.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'The id create_experiment returned.' },
        qasm: {
          type: 'string',
          description: 'OpenQASM 3 source. Supported gates: h x y z s sdg t tdg rx ry rz p cx cy cz swap ccx.',
        },
        target: TARGET_SCHEMA,
        shots: { type: 'integer', description: `Measurement samples, clamped to 1–${MAX_SHOTS}. Default ${DEFAULT_SHOTS}.` },
        seed: { type: 'integer', description: 'Optional PRNG seed (simulator targets) for reproducible counts.' },
        note: {
          type: 'string',
          description: `Why this step, what you expected (≤ ${MAX_NOTE_CHARS} chars). Shown in the record.`,
        },
      },
      required: ['experiment_id', 'qasm', 'target'],
    },
    handler: async (args, ctx) => {
      const id = str(args.experiment_id, 100, 'experiment_id')
      if (!id.ok) return err(id.error)
      const target = parseTarget(args.target)
      if (!target.ok) return err(target.error)
      const note = optionalStr(args.note, MAX_NOTE_CHARS, 'note')
      if (!note.ok) return err(note.error)
      const qasm = typeof args.qasm === 'string' ? args.qasm : ''
      const seed = typeof args.seed === 'number' && Number.isInteger(args.seed) ? args.seed : undefined

      // Check the record BEFORE spending compute (or money) on the run: a
      // hardware submission against a concluded or missing experiment would
      // otherwise be billed and then not recorded.
      let existing: Experiment | null
      let owner: string | null
      try {
        owner = await resolveOwner(ctx)
        const limited = await chargeWrite(ctx, owner, 'step', limits.step)
        if (limited) return limited
        existing = await store.get(id.value)
      } catch (cause) {
        return storeFailure(cause)
      }
      if (!existing) return err(`No experiment with id "${id.value}". Call create_experiment first.`)
      const foreign = notYours(existing, owner)
      if (foreign) return foreign
      if (existing.conclusion !== null) {
        return err(`Experiment "${existing.title}" is concluded; create a new experiment to keep running.`)
      }
      if (existing.steps.length >= MAX_STEPS_PER_EXPERIMENT) {
        return err(`Experiment "${existing.title}" already holds ${MAX_STEPS_PER_EXPERIMENT} steps, the ceiling.`)
      }

      const ran = await runOnTarget(qasm, target.value, {
        shots: typeof args.shots === 'number' ? args.shots : undefined,
        seed,
        authorization: ctx.authorization ?? null,
        forwardedFor: ctx.forwardedFor ?? null,
        hardware,
      })
      if (!ran.ok) return err(ran.error)

      try {
        const updated = await store.appendStep(id.value, {
          qasm,
          target: target.value,
          shots: ran.result.shots,
          seed: seed ?? null,
          result: ran.result,
          note: note.value ?? '',
        })
        const step = updated.steps[updated.steps.length - 1]
        return ok({
          experimentId: updated.id,
          stepIndex: step.index,
          stepCount: updated.steps.length,
          target: step.target,
          targetLabel: describeTarget(step.target),
          result: step.result,
          note: step.note,
          url: `/workbench/experiments/${updated.id}`,
          conventions:
            'Bitstring labels are MSB-first (qubit 0 is the rightmost character), matching Qiskit.',
        })
      } catch (cause) {
        return storeFailure(cause)
      }
    },
  }

  const concludeExperiment: McpToolDef = {
    name: 'conclude_experiment',
    title: 'Write the conclusion of an experiment',
    description:
      'Close an experiment with a conclusion: what the steps showed, whether the hypothesis ' +
      'survived, and what you would run next. After this no further steps can be added. ' +
      'The account that created the experiment can call it again to replace the conclusion (never the ' +
      'steps); an experiment created without a token keeps its first conclusion. Only the owning ' +
      'account can write to an experiment it created while signed in.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'The id create_experiment returned.' },
        conclusion: {
          type: 'string',
          description: `The write-up (≤ ${MAX_CONCLUSION_CHARS} chars). Cite step numbers and counts.`,
        },
      },
      required: ['experiment_id', 'conclusion'],
    },
    handler: async (args, ctx) => {
      const id = str(args.experiment_id, 100, 'experiment_id')
      if (!id.ok) return err(id.error)
      const conclusion = str(args.conclusion, MAX_CONCLUSION_CHARS, 'conclusion')
      if (!conclusion.ok) return err(conclusion.error)
      try {
        const owner = await resolveOwner(ctx)
        const limited = await chargeWrite(ctx, owner, 'conclude', limits.conclude)
        if (limited) return limited
        const existing = await store.get(id.value)
        if (!existing) return err(`No experiment with id "${id.value}".`)
        const foreign = notYours(existing, owner)
        if (foreign) return foreign
        // Only an account can revise its own write-up. An anonymous record has
        // no one to prove authorship, so its first conclusion is final.
        if (existing.conclusion !== null && existing.owner === null) {
          return err('This experiment is already concluded and was written anonymously, so it cannot be rewritten.')
        }
        const updated = await store.conclude(id.value, conclusion.value)
        return ok(present(updated))
      } catch (cause) {
        return storeFailure(cause)
      }
    },
  }

  const listExperiments: McpToolDef = {
    name: 'list_experiments',
    title: 'List experiment records',
    description:
      'Every experiment on this deployment, newest first: id, title, hypothesis, step count, ' +
      'whether it is concluded, and when. Fetch one with get_experiment.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: `How many to return, 1–${MAX_LIST_LIMIT}. Default 50.` },
      },
    },
    handler: async (args) => {
      try {
        const experiments = await store.list(typeof args.limit === 'number' ? args.limit : undefined)
        return ok({
          count: experiments.length,
          storage: store.kind,
          experiments: experiments.map((e) => ({ ...toPublicSummary(e), url: `/workbench/experiments/${e.id}` })),
        })
      } catch (cause) {
        return storeFailure(cause)
      }
    },
  }

  const getExperiment: McpToolDef = {
    name: 'get_experiment',
    title: 'Read an experiment record',
    description:
      'One experiment in full: hypothesis, every step with its circuit, target, result and note, ' +
      'and the conclusion if written.',
    inputSchema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'An id from list_experiments or create_experiment.' },
      },
      required: ['experiment_id'],
    },
    handler: async (args) => {
      const id = str(args.experiment_id, 100, 'experiment_id')
      if (!id.ok) return err(id.error)
      try {
        const record = await store.get(id.value)
        if (!record) return err(`No experiment with id "${id.value}".`)
        return ok({ ...present(record), summary: toPublicSummary(summarise(record)) })
      } catch (cause) {
        return storeFailure(cause)
      }
    },
  }

  return [createExperiment, runStep, concludeExperiment, listExperiments, getExperiment]
}

export { EXPERIMENT_TOOL_NAMES }

/**
 * The registry's copy: bound lazily to the process store so importing the
 * registry does not resolve the environment. The store is looked up per call,
 * which is also what lets tests swap it with setExperimentStore.
 */
const lazyStore: ExperimentStore = {
  get kind() {
    return getExperimentStore().kind
  },
  create: (input) => getExperimentStore().create(input),
  get: (id) => getExperimentStore().get(id),
  list: (limit) => getExperimentStore().list(limit),
  appendStep: (id, step) => getExperimentStore().appendStep(id, step),
  conclude: (id, conclusion) => getExperimentStore().conclude(id, conclusion),
}

/**
 * Attribution for the registry copy: the verified Supabase user behind the
 * transport's Authorization header, or null. A missing or bad token is null,
 * never an error — attribution is not a gate here.
 */
const headerOwner: OwnerResolver = async (ctx) => {
  if (!ctx.authorization) return null
  try {
    return await verifiedCallerId(
      new Request('http://localhost/mcp', { headers: { authorization: ctx.authorization } }),
    )
  } catch {
    return null
  }
}

export const EXPERIMENT_TOOLS: McpToolDef[] = createExperimentTools({
  store: lazyStore,
  resolveOwner: headerOwner,
})

/** Re-exported so the page can show the defaults it describes. */
export { DEFAULT_NOISE }
