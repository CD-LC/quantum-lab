/**
 * mcpTool.test.ts — generate_verified_circuit through the MCP registry.
 *
 * No model is ever called here: every case either passes a candidate that
 * verifies on its own (so the loop never asks for a provider) or runs in an
 * environment with no provider configured, where the tool must say so
 * plainly rather than pretend.
 */

import { describe, expect, it } from 'vitest'
import { callToolAsync, getTool } from '@/lib/mcp/server'
import { GENERATE_MAX_CANDIDATE_OPS, parseGenerateArgs } from './mcpTool'
import { presetById } from './specs'

const BELL_QASM = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];'
const X_QASM = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nx q[0];'

describe('parseGenerateArgs', () => {
  it('accepts a spec object or a JSON string, clamps attempts, parses the candidate', () => {
    const spec = presetById('bell')!.spec
    const a = parseGenerateArgs({ spec, max_attempts: 99, candidate_qasm: BELL_QASM })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.input.maxAttempts).toBe(6)
    expect(a.input.candidate?.ops).toHaveLength(2)
    const b = parseGenerateArgs({ spec: JSON.stringify(spec) })
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.input.maxAttempts).toBe(3)
  })

  it('refuses a candidate with more gates than the ceiling', () => {
    const spec = presetById('bell')!.spec
    const many = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\n' + 'h q[0];\n'.repeat(GENERATE_MAX_CANDIDATE_OPS + 1)
    const r = parseGenerateArgs({ spec, candidate_qasm: many })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/ceiling/)
  })

  it('rejects a bad spec with every error listed', () => {
    const r = parseGenerateArgs({ spec: { numQubits: 0, target: { kind: 'nope' } } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/numQubits/)
      expect(r.error).toMatch(/target.kind/)
    }
    expect(parseGenerateArgs({ spec: '{not json' }).ok).toBe(false)
    expect(parseGenerateArgs({ spec: presetById('bell')!.spec, candidate_qasm: 'hello' }).ok).toBe(false)
  })
})

describe('generate_verified_circuit (registry)', () => {
  it('is registered with a schema that requires spec', () => {
    const tool = getTool('generate_verified_circuit')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['spec'] })
  })

  it('verifies a passing candidate with max_attempts 1 and calls no model', async () => {
    const out = await callToolAsync('generate_verified_circuit', {
      spec: presetById('bell')!.spec,
      candidate_qasm: BELL_QASM,
      max_attempts: 1,
    })
    expect(out.isError).not.toBe(true)
    const s = out.structuredContent as Record<string, unknown>
    expect(s.ok).toBe(true)
    expect(s.stopped).toBe('passed')
    expect(s.modelCalls).toBe(0)
    expect(s.providerNote).toBeUndefined()
    const attempts = s.attempts as { source: string; verdict: { pass: boolean; score: number } }[]
    expect(attempts).toHaveLength(1)
    expect(attempts[0].source).toBe('candidate')
    expect(attempts[0].verdict.pass).toBe(true)
    expect(attempts[0].verdict.score).toBeCloseTo(1, 12)
    expect(String(s.caveat)).toMatch(/not that the spec is what you meant/)
  })

  it('fails a wrong candidate with actionable diagnostics and no model call', async () => {
    const out = await callToolAsync('generate_verified_circuit', {
      spec: presetById('bell')!.spec,
      candidate_qasm: X_QASM,
      max_attempts: 1,
    })
    expect(out.isError).not.toBe(true)
    const s = out.structuredContent as Record<string, unknown>
    expect(s.ok).toBe(false)
    expect(s.stopped).toBe('exhausted')
    expect(s.modelCalls).toBe(0)
    const attempts = s.attempts as { verdict: { diagnostics: { message: string }[] } }[]
    expect(attempts[0].verdict.diagnostics.map((d) => d.message).join(' ')).toContain('|01⟩ target 0.0% got 100.0%')
  })

  it('returns an isError result for an invalid spec', async () => {
    const out = await callToolAsync('generate_verified_circuit', { spec: { numQubits: 2 } })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/Invalid spec/)
  })
})
