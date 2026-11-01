/**
 * hardening.test.ts — resource and exposure bounds on the anonymous MCP surface.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({
  calls: [] as { identity: unknown; prefix: string }[],
  result: { kind: 'none', tier: 'anonymous', userId: null, reason: 'quota_spent', note: 'No model: used up.' } as unknown,
}))

vi.mock('@/lib/llm/callerAccess', () => ({
  liveModelForCaller: async (identity: unknown, prefix: string) => {
    gate.calls.push({ identity, prefix })
    return gate.result
  },
}))

import {
  MCP_MAX_OPS,
  callToolAsync,
  clientAddressFrom,
  getTool,
  scrubProviderErrors,
  withOpCeiling,
  type McpToolDef,
} from './server'
import { presetById } from '@/lib/workbench/specs'
import { POST } from '@/app/api/mcp/[transport]/route'
import { simulateSteps } from '@/lib/quantum'

function qasmWithGates(qubits: number, gates: number): string {
  return [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
    `qubit[${qubits}] q;`,
    ...Array.from({ length: gates }, (_, i) => `h q[${i % qubits}];`),
  ].join('\n')
}

describe('gate-count ceiling', () => {
  it('refuses a 16-qubit circuit over MCP_MAX_OPS on every simulating tool', async () => {
    const qasm = qasmWithGates(16, MCP_MAX_OPS + 1)
    expect(qasm.length).toBeLessThan(20_000)
    for (const name of ['run_circuit', 'get_statevector_at_step', 'grade_challenge', 'export_notebook']) {
      const result = await callToolAsync(name, { qasm, step: 1, challenge_id: 'bell-state', variant: 'qiskit' })
      // grade_challenge may reject on an unknown id first; the others must hit the ceiling.
      if (name !== 'grade_challenge') {
        expect(result.isError, name).toBe(true)
        expect(result.content[0].text, name).toContain('ceiling')
      }
    }
  })

  it('accepts a circuit exactly at the ceiling', async () => {
    const result = await callToolAsync('run_circuit', { qasm: qasmWithGates(4, MCP_MAX_OPS), shots: 8 })
    expect(result.isError).toBeFalsy()
  })

  it('withOpCeiling guards run_step-style handlers and passes everything else through', async () => {
    const inner = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'ran' }] }))
    const tool: McpToolDef = { name: 'run_step', title: '', description: '', inputSchema: {}, handler: inner }
    const guarded = withOpCeiling(tool)
    const refused = await guarded.handler({ qasm: qasmWithGates(16, MCP_MAX_OPS + 1) }, {})
    expect(refused.isError).toBe(true)
    expect(inner).not.toHaveBeenCalled()
    expect((await guarded.handler({ qasm: qasmWithGates(2, 3) }, {})).content[0].text).toBe('ran')
    expect((await guarded.handler({ qasm: 'not qasm at all' }, {})).content[0].text).toBe('ran')
    expect((await guarded.handler({}, {})).content[0].text).toBe('ran')
  })
})

describe('get_statevector_at_step memory', () => {
  it('holds one statevector, not one per gate', async () => {
    const qasm = qasmWithGates(16, MCP_MAX_OPS)
    if (global.gc) global.gc()
    const before = process.memoryUsage().arrayBuffers
    const result = await callToolAsync('get_statevector_at_step', { qasm, step: MCP_MAX_OPS })
    const after = process.memoryUsage().arrayBuffers
    expect(result.isError).toBeFalsy()
    // The old simulateSteps path held ~1 MB per gate: ~1,000 MB for this circuit.
    expect((after - before) / 1_048_576).toBeLessThan(20)
  })

  it('returns the same state the full frame list holds, including mid-circuit steps', async () => {
    const qasm = ['OPENQASM 3.0;', 'include "stdgates.inc";', 'qubit[3] q;', 'h q[0];', 'cx q[0], q[1];', 'rz(0.7) q[1];', 'cx q[1], q[2];'].join('\n')
    const { fromQasm } = await import('@/lib/quantum')
    const frames = simulateSteps(fromQasm(qasm))
    for (let step = 0; step < frames.length; step++) {
      const result = await callToolAsync('get_statevector_at_step', { qasm, step })
      expect(result.isError, `step ${step}`).toBeFalsy()
      const entries = (result.structuredContent as { statevector: { state: string; re: number; im: number }[] }).statevector
      expect(entries.length).toBeGreaterThan(0)
      const expected = frames[step].normalize().amplitudes()
      for (const entry of entries) {
        const index = parseInt(entry.state, 2)
        expect(entry.re).toBeCloseTo(expected[index].re, 6)
        expect(entry.im).toBeCloseTo(expected[index].im, 6)
      }
    }
  })
})

describe('get_statevector_at_step follows the run_circuit trajectory', () => {
  type Sparse = { state: string; re: number; im: number }[]
  const qasm = [
    'OPENQASM 3.0;',
    'include "stdgates.inc";',
    'qubit[3] q;',
    'bit[3] c;',
    'h q[0];',
    'h q[1];',
    'h q[2];',
    'c[0] = measure q[0];',
    'c[1] = measure q[1];',
    'c[2] = measure q[2];',
  ].join('\n')

  it('the last step equals the statevector run_circuit reports for a measured circuit', async () => {
    const ran = await callToolAsync('run_circuit', { qasm, shots: 8, seed: 1 })
    const last = await callToolAsync('get_statevector_at_step', { qasm, step: 6 })
    expect(ran.isError).toBeUndefined()
    expect(last.isError).toBeUndefined()
    // run_circuit lists states by their probability in the measurement mixture;
    // the amplitudes are the one trajectory, so compare the ones that are set.
    const live = (e: Sparse[number]) => Math.hypot(e.re, e.im) > 1e-9
    const a = (ran.structuredContent as { statevector: Sparse }).statevector.filter(live)
    const b = (last.structuredContent as { statevector: Sparse }).statevector.filter(live)
    expect(a).toHaveLength(1) // a collapsed trajectory: one basis state
    expect(b.map((e) => e.state)).toEqual(a.map((e) => e.state))
  })

  it('every step is a prefix of that one trajectory (step 6 is not a fresh draw)', async () => {
    const final = await callToolAsync('get_statevector_at_step', { qasm, step: 6 })
    const finalState = (final.structuredContent as { statevector: Sparse }).statevector[0].state
    // After measuring qubit k the state is collapsed on that qubit; the bit it
    // collapsed to must still be there at every later step.
    for (const [step, qubit] of [[4, 0], [5, 1]] as const) {
      const out = await callToolAsync('get_statevector_at_step', { qasm, step })
      const entries = (out.structuredContent as { statevector: Sparse }).statevector
      for (const e of entries) {
        expect(e.state[e.state.length - 1 - qubit]).toBe(finalState[finalState.length - 1 - qubit])
      }
    }
  })
})

describe('generate_verified_circuit quota', () => {
  beforeEach(() => {
    gate.calls.length = 0
    gate.result = { kind: 'none', tier: 'anonymous', userId: null, reason: 'quota_spent', note: 'No model: used up.' }
  })

  const SPEC = presetById('bell')!.spec

  it('asks the access gate with the caller identity and gives no model when the quota is spent', async () => {
    const result = await callToolAsync(
      'generate_verified_circuit',
      { spec: SPEC },
      { authorization: 'Bearer abc', clientIp: '203.0.113.5' },
    )
    expect(gate.calls).toHaveLength(1)
    expect(gate.calls[0].prefix).toBe('workbench-day')
    expect(gate.calls[0].identity).toMatchObject({ authorization: 'Bearer abc', clientIp: '203.0.113.5' })
    expect(JSON.stringify(result.structuredContent ?? result.content)).toContain('No model: used up.')
  })

  it('a candidate-only verification never touches the quota', async () => {
    await callToolAsync('generate_verified_circuit', {
      spec: SPEC,
      candidate_qasm: 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];',
      max_attempts: 1,
    })
    expect(gate.calls).toHaveLength(0)
  })
})

describe('provider error scrubbing', () => {
  it('replaces a provider failure with a fixed sentence', async () => {
    const adapter = scrubProviderErrors({
      label: 'x',
      complete: async () => {
        throw new Error('The API deployment `gpt-secret-deploy` does not exist at https://internal.openai.azure.com')
      },
    })
    await expect(adapter.complete({ system: '', user: '', maxTokens: 1 })).rejects.toThrow(
      'The model provider returned an error; try again later.',
    )
  })

  it('callToolAsync does not echo an unexpected exception message', async () => {
    const tool = getTool('list_challenges')!
    const spy = vi.spyOn(tool, 'handler').mockImplementation(() => {
      throw new Error('relation "public.experiments" violates constraint secret_fk')
    })
    try {
      const result = await callToolAsync('list_challenges', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('failed')
      expect(result.content[0].text).not.toContain('secret_fk')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('trusted client address', () => {
  it('uses the same precedence as callerKey', () => {
    expect(clientAddressFrom(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }))).toBe('1.1.1.1')
    expect(clientAddressFrom(new Headers({ 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }))).toBe('9.9.9.9')
    expect(clientAddressFrom(new Headers({ 'x-real-ip': '3.3.3.3' }))).toBe('3.3.3.3')
    expect(clientAddressFrom(new Headers())).toBeNull()
  })

  it('the route hands tools the trusted address, not the raw x-forwarded-for chain', async () => {
    let seen: unknown = null
    const spy = vi.spyOn(getTool('list_challenges')!, 'handler').mockImplementation((_args, ctx) => {
      seen = ctx
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    try {
      await POST(
        new Request('http://localhost:3000/api/mcp/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'cf-connecting-ip': '198.51.100.77',
            'x-forwarded-for': '6.6.6.6, 198.51.100.77',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_challenges', arguments: {} } }),
        }),
        { params: Promise.resolve({ transport: 'mcp' }) },
      )
    } finally {
      spy.mockRestore()
    }
    expect(seen).toMatchObject({ clientIp: '198.51.100.77', forwardedFor: '198.51.100.77' })
  })
})
