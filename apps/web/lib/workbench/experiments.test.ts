/**
 * experiments.test.ts — the whole experiment tool surface against the
 * in-memory adapter, the record round trip, and the noisy-vs-clean contrast.
 *
 * No environment, no database, no network: the tools are built by the factory
 * with a MemoryExperimentStore and a scripted hardware fake, and the registry
 * copy is exercised through setExperimentStore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import {
  MemoryExperimentStore,
  ExperimentError,
  experimentToRows,
  rowsToExperiment,
  MAX_STEPS_PER_EXPERIMENT,
  type Experiment,
} from './experiments'
import { createExperimentTools, EXPERIMENT_TOOL_NAMES } from './experimentTools'
import { setExperimentStore } from './experimentStore'
import type { HardwareSubmitter } from './targets'
import type { McpToolDef, ToolResult } from '@/lib/mcp/server'
import { callToolAsync, listToolsResult } from '@/lib/mcp/server'

const HEADER = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'
const BELL = HEADER + 'qubit[2] q;\nh q[0];\ncx q[0], q[1];'

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError, result.content[0]?.text).not.toBe(true)
  return result.structuredContent as Record<string, unknown>
}

function harness(hardware?: HardwareSubmitter) {
  const store = new MemoryExperimentStore()
  const tools = createExperimentTools({ store, hardware, resolveOwner: async (ctx) => (ctx.authorization ? 'user-1' : null) })
  const byName = new Map(tools.map((t) => [t.name, t]))
  const call = (name: string, args: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
    const tool = byName.get(name) as McpToolDef
    return Promise.resolve(tool.handler(args, ctx))
  }
  return { store, tools, call }
}

// ────────────────────────────────────────────────────────────
// The tool surface
// ────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetRateLimitForTests()
})

describe('experiment tools (memory adapter)', () => {
  it('registers exactly the five documented tools with object schemas', () => {
    const { tools } = harness()
    expect(tools.map((t) => t.name)).toEqual([...EXPERIMENT_TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('create → run_step → conclude produces a readable record, and the record refuses more steps', async () => {
    const { call, store } = harness()
    const created = structured(
      await call('create_experiment', { title: 'Bell fidelity', hypothesis: 'Noise adds odd-parity counts.' }),
    )
    const id = created.id as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.steps).toEqual([])
    expect(created.conclusion).toBeNull()
    expect(created.url).toBe(`/workbench/experiments/${id}`)

    const step = structured(
      await call('run_step', {
        experiment_id: id,
        qasm: BELL,
        target: 'simulator',
        shots: 512,
        seed: 1,
        note: 'baseline',
      }),
    )
    expect(step.stepIndex).toBe(0)
    expect(step.stepCount).toBe(1)
    expect(step.targetLabel).toBe('ideal simulator')
    const result = step.result as { kind: string; counts: Record<string, number> }
    expect(result.kind).toBe('counts')
    expect(Object.keys(result.counts).sort()).toEqual(['00', '11'])

    const concluded = structured(
      await call('conclude_experiment', { experiment_id: id, conclusion: 'Step 0 is clean.' }),
    )
    expect(concluded.conclusion).toBe('Step 0 is clean.')
    expect(typeof concluded.concludedAt).toBe('string')

    const refused = await call('run_step', { experiment_id: id, qasm: BELL, target: 'simulator' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('concluded')

    // The store agrees with the tool output.
    const record = await store.get(id)
    expect(record?.steps).toHaveLength(1)
    expect(record?.steps[0]).toMatchObject({ index: 0, qasm: BELL, shots: 512, seed: 1, note: 'baseline' })
  })

  it('run_step with the noisy target changes the counts the clean target gives', async () => {
    const { call } = harness()
    const { id } = structured(await call('create_experiment', { title: 't', hypothesis: 'h' })) as { id: string }

    const clean = structured(
      await call('run_step', { experiment_id: id, qasm: BELL, target: 'simulator', shots: 4096, seed: 7 }),
    ).result as { counts: Record<string, number> }
    const noisy = structured(
      await call('run_step', {
        experiment_id: id,
        qasm: BELL,
        target: { kind: 'noisy-simulator', depolarizing1: 0, depolarizing2: 0.2, readoutError: 0 },
        shots: 4096,
        seed: 7,
      }),
    ).result as { counts: Record<string, number>; erroredShots: number }

    // Clean: only even parity, ever. Noisy: odd parity at p2/2 = 10 % of
    // 4096 ≈ 410 (σ ≈ 19), so anything under 300 would be a broken channel.
    expect((clean.counts['01'] ?? 0) + (clean.counts['10'] ?? 0)).toBe(0)
    const odd = (noisy.counts['01'] ?? 0) + (noisy.counts['10'] ?? 0)
    expect(odd).toBeGreaterThan(300)
    expect(odd).toBeLessThan(520)
    expect(noisy.erroredShots).toBeGreaterThan(0)
    expect(noisy.counts).not.toEqual(clean.counts)
  })

  it('run_step validates before running: unknown experiment, bad target, junk QASM', async () => {
    const { call } = harness()
    const missing = await call('run_step', { experiment_id: 'nope', qasm: BELL, target: 'simulator' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('create_experiment')

    const { id } = structured(await call('create_experiment', { title: 't', hypothesis: 'h' })) as { id: string }
    const badTarget = await call('run_step', { experiment_id: id, qasm: BELL, target: { kind: 'gpu' } })
    expect(badTarget.isError).toBe(true)
    expect(badTarget.content[0].text).toContain('target.kind')

    const junk = await call('run_step', { experiment_id: id, qasm: 'not qasm', target: 'simulator' })
    expect(junk.isError).toBe(true)

    // None of those recorded a step.
    const record = structured(await call('get_experiment', { experiment_id: id }))
    expect(record.steps).toEqual([])
  })

  it('list_experiments is newest first with step counts; get_experiment returns steps with labels', async () => {
    const store = new MemoryExperimentStore(200, (() => {
      let t = Date.UTC(2026, 0, 1)
      return () => new Date((t += 1000))
    })())
    const tools = createExperimentTools({ store })
    const byName = new Map(tools.map((t) => [t.name, t]))
    const call = (name: string, args: Record<string, unknown>) =>
      Promise.resolve((byName.get(name) as McpToolDef).handler(args, {}))

    const a = structured(await call('create_experiment', { title: 'A', hypothesis: 'a' })).id as string
    const b = structured(await call('create_experiment', { title: 'B', hypothesis: 'b' })).id as string
    await call('run_step', { experiment_id: a, qasm: BELL, target: 'simulator', shots: 8, seed: 1 })

    const listed = structured(await call('list_experiments', {}))
    expect(listed.storage).toBe('memory')
    const rows = listed.experiments as { id: string; stepCount: number; title: string }[]
    expect(rows.map((r) => r.title)).toEqual(['B', 'A'])
    expect(rows.find((r) => r.id === a)?.stepCount).toBe(1)
    expect(rows.find((r) => r.id === b)?.stepCount).toBe(0)

    const one = structured(await call('get_experiment', { experiment_id: a }))
    const steps = one.steps as { targetLabel: string; at: string }[]
    expect(steps[0].targetLabel).toBe('ideal simulator')
    expect(steps[0].at).toBe('2026-01-01T00:00:03.000Z')

    const unknown = await call('get_experiment', { experiment_id: 'missing' })
    expect(unknown.isError).toBe(true)
  })

  it('records the verified owner internally, and never puts the account id in tool output', async () => {
    const { call, store } = harness()
    const anon = structured(await call('create_experiment', { title: 't', hypothesis: 'h' }))
    expect(anon.signedInAuthor).toBe(false)
    expect(anon).not.toHaveProperty('owner')
    const signed = structured(await call('create_experiment', { title: 't', hypothesis: 'h' }, { authorization: 'Bearer x' }))
    expect(signed.signedInAuthor).toBe(true)
    expect(JSON.stringify(signed)).not.toContain('user-1')
    expect((await store.get(signed.id as string))?.owner).toBe('user-1')

    const listed = structured(await call('list_experiments', {}))
    expect(JSON.stringify(listed)).not.toContain('user-1')
    const one = structured(await call('get_experiment', { experiment_id: signed.id as string }))
    expect(JSON.stringify(one)).not.toContain('user-1')
  })

  it('an owned record is writable only by its owner; an anonymous conclusion is final', async () => {
    const { call } = harness()
    const mine = structured(await call('create_experiment', { title: 't', hypothesis: 'h' }, { authorization: 'Bearer x' }))
    const id = mine.id as string
    const anonStep = await call('run_step', { experiment_id: id, qasm: BELL, target: 'simulator' })
    expect(anonStep.isError).toBe(true)
    expect(anonStep.content[0].text).toMatch(/belongs to another account/)
    const anonConclude = await call('conclude_experiment', { experiment_id: id, conclusion: 'defaced' })
    expect(anonConclude.isError).toBe(true)
    expect((await call('run_step', { experiment_id: id, qasm: BELL, target: 'simulator' }, { authorization: 'Bearer x' })).isError).not.toBe(true)
    expect((await call('conclude_experiment', { experiment_id: id, conclusion: 'one' }, { authorization: 'Bearer x' })).isError).not.toBe(true)
    expect((await call('conclude_experiment', { experiment_id: id, conclusion: 'two' }, { authorization: 'Bearer x' })).isError).not.toBe(true)

    const open = structured(await call('create_experiment', { title: 't', hypothesis: 'h' }))
    expect((await call('conclude_experiment', { experiment_id: open.id as string, conclusion: 'first' })).isError).not.toBe(true)
    const second = await call('conclude_experiment', { experiment_id: open.id as string, conclusion: 'rewritten' })
    expect(second.isError).toBe(true)
  })

  it('rate-limits writes per caller: the 4th create from one address is refused, another address is not', async () => {
    const store = new MemoryExperimentStore()
    const tools = createExperimentTools({
      store,
      limits: {
        create: { limit: 3, windowMs: 3_600_000 },
        step: { limit: 3, windowMs: 3_600_000 },
        conclude: { limit: 3, windowMs: 3_600_000 },
      },
    })
    const create = tools.find((t) => t.name === 'create_experiment') as McpToolDef
    const a = { clientIp: '203.0.113.7' }
    for (let i = 0; i < 3; i++) {
      expect((await create.handler({ title: 't', hypothesis: 'h' }, a)).isError, `create ${i + 1}`).not.toBe(true)
    }
    const fourth = await create.handler({ title: 't', hypothesis: 'h' }, a)
    expect(fourth.isError).toBe(true)
    expect(fourth.content[0].text).toMatch(/Too many experiment writes/)
    expect((await create.handler({ title: 't', hypothesis: 'h' }, { clientIp: '203.0.113.8' })).isError).not.toBe(true)
    expect((await store.list()).length).toBe(4)
  })

  it('a storage failure reaches the caller as a fixed sentence, not the backend text', async () => {
    const store = new MemoryExperimentStore()
    vi.spyOn(store, 'create').mockRejectedValue(new Error('relation "public.experiments" violates constraint secret_fk'))
    const create = createExperimentTools({ store }).find((t) => t.name === 'create_experiment') as McpToolDef
    const result = await create.handler({ title: 't', hypothesis: 'h' }, {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('secret_fk')
    expect(result.content[0].text).toMatch(/unavailable/)
  })

  it('refuses to store a step whose result is oversized', async () => {
    const store = new MemoryExperimentStore()
    const record = await store.create({ title: 't', hypothesis: 'h' })
    const huge = { kind: 'counts', counts: { '0': 1 }, shots: 1, numQubits: 1, gateCount: 1, junk: 'x'.repeat(200_000) }
    await expect(
      store.appendStep(record.id, {
        qasm: BELL,
        target: { kind: 'simulator' },
        shots: 1,
        seed: null,
        result: huge as never,
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'too-large' })
    expect((await store.get(record.id))?.steps).toHaveLength(0)
  })

  it('hardware target: no token → refusal and no step; token → job recorded via the injected submitter', async () => {
    const seen: unknown[] = []
    const fake: HardwareSubmitter = async (s) => {
      seen.push(s)
      return { status: 202, payload: { job_id: 'job-9', provider: 'ibm' } }
    }
    const { call } = harness(fake)
    const { id } = structured(await call('create_experiment', { title: 'hw', hypothesis: 'h' })) as { id: string }

    const refused = await call('run_step', { experiment_id: id, qasm: BELL, target: { kind: 'hardware', backend: 'ibm_brisbane' } })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('no step was recorded')
    expect(seen).toHaveLength(0)

    const accepted = structured(
      await call(
        'run_step',
        { experiment_id: id, qasm: BELL, target: { kind: 'hardware', backend: 'ibm_brisbane', provider: 'ibm' }, shots: 100, note: 'real run' },
        { authorization: 'Bearer tok', forwardedFor: '1.2.3.4' },
      ),
    )
    expect(accepted.targetLabel).toBe('hardware · ibm_brisbane (ibm)')
    expect(accepted.result).toMatchObject({ kind: 'hardware-job', status: 202, job: { job_id: 'job-9' } })
    expect(seen[0]).toMatchObject({ authorization: 'Bearer tok', forwardedFor: '1.2.3.4', shots: 100 })

    const record = structured(await call('get_experiment', { experiment_id: id }))
    expect(record.steps).toHaveLength(1)
  })

  it('a hardware refusal from the route records nothing', async () => {
    const fake: HardwareSubmitter = async () => ({ status: 402, payload: { detail: 'quota spent' } })
    const { call } = harness(fake)
    const { id } = structured(await call('create_experiment', { title: 'hw', hypothesis: 'h' })) as { id: string }
    const refused = await call(
      'run_step',
      { experiment_id: id, qasm: BELL, target: { kind: 'hardware', backend: 'ibm_brisbane' } },
      { authorization: 'Bearer tok' },
    )
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('HTTP 402')
    expect(structured(await call('get_experiment', { experiment_id: id })).steps).toEqual([])
  })

  it('validation: empty title, oversize hypothesis, bad conclusion', async () => {
    const { call } = harness()
    expect((await call('create_experiment', { title: '', hypothesis: 'h' })).isError).toBe(true)
    expect((await call('create_experiment', { title: 't', hypothesis: 'x'.repeat(4001) })).isError).toBe(true)
    const { id } = structured(await call('create_experiment', { title: 't', hypothesis: 'h' })) as { id: string }
    expect((await call('conclude_experiment', { experiment_id: id, conclusion: '' })).isError).toBe(true)
    expect((await call('conclude_experiment', { experiment_id: 'missing', conclusion: 'c' })).isError).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// The registry copy
// ────────────────────────────────────────────────────────────

describe('registry integration', () => {
  afterEach(() => setExperimentStore(null))

  it('the MCP registry lists the five tools and dispatches them to the configured store', async () => {
    const names = listToolsResult().tools.map((t) => t.name)
    for (const name of EXPERIMENT_TOOL_NAMES) expect(names).toContain(name)

    const store = new MemoryExperimentStore()
    setExperimentStore(store)
    const created = structured(await callToolAsync('create_experiment', { title: 'via registry', hypothesis: 'h' }))
    expect(await store.get(created.id as string)).not.toBeNull()
    const listed = structured(await callToolAsync('list_experiments', { limit: 5 }))
    expect(listed.count).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────
// The adapter itself
// ────────────────────────────────────────────────────────────

describe('MemoryExperimentStore', () => {
  it('round-trips a record: what goes in comes back equal, and callers cannot mutate the stored copy', async () => {
    const store = new MemoryExperimentStore()
    const created = await store.create({ title: 'rt', hypothesis: 'h', owner: 'u' })
    const withStep = await store.appendStep(created.id, {
      qasm: BELL,
      target: { kind: 'noisy-simulator', noise: { depolarizing1: 0.01, depolarizing2: 0.02, readoutError: 0.03 } },
      shots: 16,
      seed: 4,
      result: { kind: 'counts', counts: { '00': 8, '11': 8 }, shots: 16, numQubits: 2, gateCount: 2, erroredShots: 1 },
      note: 'n',
    })
    const done = await store.conclude(created.id, 'c')
    const fetched = await store.get(created.id)
    expect(fetched).toEqual(done)
    expect(fetched?.steps).toEqual(withStep.steps)
    expect(JSON.parse(JSON.stringify(fetched))).toEqual(fetched)

    // Mutating a returned copy does not touch the store.
    fetched!.steps[0].note = 'tampered'
    fetched!.title = 'tampered'
    expect((await store.get(created.id))?.steps[0].note).toBe('n')
    expect((await store.get(created.id))?.title).toBe('rt')
  })

  it('throws typed errors for a missing id, a concluded record and the step ceiling', async () => {
    const store = new MemoryExperimentStore()
    await expect(store.appendStep('missing', stepFixture())).rejects.toBeInstanceOf(ExperimentError)
    const e = await store.create({ title: 't', hypothesis: 'h' })
    await store.conclude(e.id, 'done')
    await expect(store.appendStep(e.id, stepFixture())).rejects.toMatchObject({ code: 'concluded' })

    const f = await store.create({ title: 't', hypothesis: 'h' })
    for (let i = 0; i < MAX_STEPS_PER_EXPERIMENT; i++) await store.appendStep(f.id, stepFixture())
    await expect(store.appendStep(f.id, stepFixture())).rejects.toMatchObject({ code: 'too-many-steps' })
  })

  it('evicts the oldest record past its capacity', async () => {
    const store = new MemoryExperimentStore(2)
    const a = await store.create({ title: 'a', hypothesis: 'h' })
    const b = await store.create({ title: 'b', hypothesis: 'h' })
    const c = await store.create({ title: 'c', hypothesis: 'h' })
    expect(await store.get(a.id)).toBeNull()
    expect(await store.get(b.id)).not.toBeNull()
    expect(await store.get(c.id)).not.toBeNull()
    expect((await store.list()).map((s) => s.title)).toHaveLength(2)
  })
})

describe('Supabase row mapping', () => {
  it('experimentToRows / rowsToExperiment round-trip, and re-sort steps by position', () => {
    const record: Experiment = {
      id: '2a4f9d3e-1c2b-4e5f-8a9b-0c1d2e3f4a5b',
      title: 'rows',
      hypothesis: 'h',
      conclusion: 'c',
      createdAt: '2026-01-01T00:00:00.000Z',
      concludedAt: '2026-01-01T01:00:00.000Z',
      owner: null,
      steps: [
        { index: 0, at: '2026-01-01T00:10:00.000Z', ...stepFixture() },
        { index: 1, at: '2026-01-01T00:20:00.000Z', ...stepFixture(), note: 'second' },
      ],
    }
    const rows = experimentToRows(record)
    expect(rows.steps.map((s) => s.position)).toEqual([0, 1])
    const back = rowsToExperiment(rows.experiment, [rows.steps[1], rows.steps[0]])
    expect(back).toEqual(record)
  })
})

function stepFixture() {
  return {
    qasm: BELL,
    target: { kind: 'simulator' as const },
    shots: 8,
    seed: null,
    result: { kind: 'counts' as const, counts: { '00': 4, '11': 4 }, shots: 8, numQubits: 2, gateCount: 2 },
    note: '',
  }
}

describe('the built-in sample record', () => {
  it('is a real four-step run whose noisy steps agree with p₂/2 to within 3σ', async () => {
    const { buildSampleExperiment, SAMPLE_EXPERIMENT_ID } = await import('./sampleExperiment')
    const sample = await buildSampleExperiment()
    expect(sample.id).toBe(SAMPLE_EXPERIMENT_ID)
    expect(sample.steps).toHaveLength(4)
    expect(sample.conclusion).toContain('Hypothesis held')
    const baseline = sample.steps[0].result
    if (baseline.kind !== 'counts') throw new Error('expected counts')
    expect(Object.keys(baseline.counts).sort()).toEqual(['00', '11'])
    for (const step of sample.steps.slice(1)) {
      if (step.target.kind !== 'noisy-simulator' || step.result.kind !== 'counts') throw new Error('shape')
      const p = step.target.noise.depolarizing2 / 2
      const odd = (step.result.counts['01'] ?? 0) + (step.result.counts['10'] ?? 0)
      const sigma = Math.sqrt(step.shots * p * (1 - p))
      expect(Math.abs(odd - p * step.shots)).toBeLessThan(3 * sigma)
    }
  })
})
