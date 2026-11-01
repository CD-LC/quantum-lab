/**
 * generate.test.ts — the generate → verify → repair loop with a scripted
 * provider. No network: the "model" is a function that returns the next
 * canned reply and records every prompt it was sent.
 */

import { describe, expect, it } from 'vitest'
import type { Circuit } from '@/lib/quantum'
import { diffCircuits, formatDiff, opText } from './diff'
import {
  circuitFromJson,
  generateVerifiedCircuit,
  parseReply,
  repairPrompt,
  type CompletionRequest,
  type ProviderAdapter,
} from './generate'
import { presetById } from './specs'

const bellSpec = presetById('bell')!.spec

/** A provider that replays `replies` in order and remembers what it was asked. */
function scripted(replies: string[]): ProviderAdapter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  let i = 0
  return {
    label: 'scripted fake',
    requests,
    async complete(request) {
      requests.push(request)
      if (i >= replies.length) throw new Error('script exhausted')
      return replies[i++]
    },
  }
}

const X_ONLY_JSON = '```json\n{"numQubits": 2, "ops": [{"name": "X", "qubits": [0]}]}\n```'
const H_ONLY_JSON = 'Sure — here you go:\n```json\n{"numQubits": 2, "ops": [{"name": "h", "qubits": [0]}]}\n```\nThat should do it.'
const BELL_JSON = '{"numQubits": 2, "ops": [{"name": "H", "qubits": [0]}, {"name": "CX", "qubits": [0, 1]}]}'

describe('generateVerifiedCircuit', () => {
  it('fails twice, then succeeds, in exactly three attempts with diagnostics fed forward', async () => {
    const provider = scripted([X_ONLY_JSON, H_ONLY_JSON, BELL_JSON])
    const seen: number[] = []
    const result = await generateVerifiedCircuit(bellSpec, provider, {
      maxAttempts: 5,
      onAttempt: (a) => seen.push(a.index),
    })

    expect(result.ok).toBe(true)
    expect(result.stopped).toBe('passed')
    expect(result.attempts).toHaveLength(3)
    expect(result.modelCalls).toBe(3)
    expect(seen).toEqual([1, 2, 3])
    expect(provider.requests).toHaveLength(3)

    // Attempt 1: X only → |01⟩ with certainty. Verdict recorded, not passed.
    const a1 = result.attempts[0]
    expect(a1.verdict?.pass).toBe(false)
    expect(a1.diff?.added).toBe(1)

    // The SECOND prompt carries the first verdict's diagnostics verbatim.
    const p2 = provider.requests[1].user
    expect(p2).toContain('FAILED verification')
    expect(p2).toContain(a1.verdict!.summary)
    expect(p2).toContain('|01⟩ target 0.0% got 100.0%')
    expect(p2).toContain('x q[0];') // the previous circuit as QASM

    // Attempt 2: H only → 50/50 on 00/01. Diff against attempt 1: -x, +h.
    const a2 = result.attempts[1]
    expect(a2.verdict?.pass).toBe(false)
    expect(a2.diff?.removed).toBe(1)
    expect(a2.diff?.added).toBe(1)
    const p3 = provider.requests[2].user
    expect(p3).toContain('Earlier attempts (do not repeat them):')
    expect(p3).toContain(`1. ${a1.verdict!.summary}`)
    expect(p3).toContain('|01⟩ target 0.0% got 50.0%')

    // Attempt 3 passes; the result is that circuit.
    const a3 = result.attempts[2]
    expect(a3.verdict?.pass).toBe(true)
    expect(a3.diff?.added).toBe(1) // +cx, h kept
    expect(a3.diff?.removed).toBe(0)
    expect(result.circuit).toEqual({ numQubits: 2, ops: [{ name: 'H', qubits: [0] }, { name: 'CX', qubits: [0, 1] }] })
    expect(result.qasm).toContain('cx q[0], q[1];')

    // Every prompt carries the spec and the system prompt names the format.
    for (const r of provider.requests) {
      expect(r.system).toContain('```json')
      expect(r.user).toContain('|00⟩: 0.5')
      expect(r.maxTokens).toBeGreaterThan(0)
    }
  })

  it('stops after maxAttempts and reports exhausted', async () => {
    const provider = scripted([X_ONLY_JSON, X_ONLY_JSON, X_ONLY_JSON, X_ONLY_JSON])
    const result = await generateVerifiedCircuit(bellSpec, provider, { maxAttempts: 2 })
    expect(result.ok).toBe(false)
    expect(result.stopped).toBe('exhausted')
    expect(result.attempts).toHaveLength(2)
    expect(result.modelCalls).toBe(2)
    expect(result.circuit).toBeNull()
  })

  it('never calls the model when the candidate already passes', async () => {
    const provider = scripted([])
    const bell: Circuit = { numQubits: 2, ops: [{ name: 'H', qubits: [0] }, { name: 'CX', qubits: [0, 1] }] }
    const result = await generateVerifiedCircuit(bellSpec, provider, { candidate: bell })
    expect(result.ok).toBe(true)
    expect(result.modelCalls).toBe(0)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0].source).toBe('candidate')
  })

  it('verifies a failing candidate first, then repairs it through the model', async () => {
    const provider = scripted([BELL_JSON])
    const xOnly: Circuit = { numQubits: 2, ops: [{ name: 'X', qubits: [0] }] }
    const result = await generateVerifiedCircuit(bellSpec, provider, { candidate: xOnly, maxAttempts: 3 })
    expect(result.ok).toBe(true)
    expect(result.attempts.map((a) => a.source)).toEqual(['candidate', 'model'])
    expect(provider.requests[0].user).toContain('FAILED verification')
    expect(result.attempts[1].diff?.removed).toBe(1)
  })

  it('records an unparseable reply and asks again with the parse error', async () => {
    const provider = scripted(['I cannot help with that.', BELL_JSON])
    const result = await generateVerifiedCircuit(bellSpec, provider, { maxAttempts: 3 })
    expect(result.ok).toBe(true)
    expect(result.attempts[0].parseError).toMatch(/no circuit found/)
    expect(provider.requests[1].user).toContain('could not be parsed')
  })

  it('reports a provider error without throwing', async () => {
    const provider: ProviderAdapter = {
      label: 'broken',
      complete: async () => {
        throw new Error('HTTP 503')
      },
    }
    const result = await generateVerifiedCircuit(bellSpec, provider)
    expect(result.ok).toBe(false)
    expect(result.stopped).toBe('provider_error')
    // The provider's own text (here 'HTTP 503') never reaches the caller.
    expect(result.error).toBe('The model provider returned an error; try again later.')
    expect(result.attempts[0].parseError).not.toContain('503')
    expect(result.attempts).toHaveLength(1)
  })

  it('reports no_provider when none is injected', async () => {
    const result = await generateVerifiedCircuit(bellSpec, null)
    expect(result.stopped).toBe('no_provider')
    expect(result.attempts).toHaveLength(0)
  })

  it('honours an abort signal between rounds', async () => {
    const controller = new AbortController()
    const provider: ProviderAdapter = {
      label: 'slow',
      complete: async () => {
        controller.abort()
        return X_ONLY_JSON
      },
    }
    const result = await generateVerifiedCircuit(bellSpec, provider, { maxAttempts: 4, signal: controller.signal })
    expect(result.stopped).toBe('aborted')
    expect(result.attempts).toHaveLength(1)
  })
})

describe('parseReply', () => {
  it('reads the JSON circuit format, case-insensitively, with pi angles', () => {
    const out = parseReply('```json\n{"numQubits":1,"ops":[{"name":"ry","qubits":[0],"theta":"pi/2"},{"name":"cnot","qubits":[0,0]}]}\n```')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.format).toBe('json')
    expect(out.circuit.ops[0]).toEqual({ name: 'RY', qubits: [0], theta: Math.PI / 2 })
    expect(out.circuit.ops[1].name).toBe('CX')
  })

  it('reads OpenQASM 3 in a fence or bare', () => {
    const qasm = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];'
    for (const text of [qasm, '```qasm\n' + qasm + '\n```', 'Here:\n```\n' + qasm + '\n```']) {
      const out = parseReply(text)
      expect(out.ok).toBe(true)
      if (out.ok) {
        expect(out.format).toBe('qasm')
        expect(out.circuit.ops).toHaveLength(2)
      }
    }
  })

  it('reports the most specific error', () => {
    expect(parseReply('```json\n{"numQubits": 2, "ops": [{"name": "FOO", "qubits": [0]}]}\n```')).toEqual({
      ok: false,
      error: 'ops[0]: unknown gate "FOO"',
    })
    expect(circuitFromJson({ numQubits: 2, ops: [{ name: 'RX', qubits: [0], theta: 'twelve' }] })).toEqual({
      ok: false,
      error: 'ops[0].theta "twelve" is not an angle',
    })
    expect(parseReply('nothing here').ok).toBe(false)
  })
})

describe('diffCircuits', () => {
  it('finds the minimal edit between two gate lists', () => {
    const before: Circuit = { numQubits: 2, ops: [{ name: 'H', qubits: [0] }, { name: 'X', qubits: [1] }, { name: 'CX', qubits: [0, 1] }] }
    const after: Circuit = { numQubits: 2, ops: [{ name: 'H', qubits: [0] }, { name: 'CX', qubits: [0, 1] }, { name: 'Z', qubits: [1] }] }
    const d = diffCircuits(before, after)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.entries.map((e) => `${e.kind}:${e.text}`)).toEqual([
      'same:h q[0]',
      'removed:x q[1]',
      'same:cx q[0], q[1]',
      'added:z q[1]',
    ])
    expect(formatDiff(d)).toBe('  h q[0]\n- x q[1]\n  cx q[0], q[1]\n+ z q[1]')
  })

  it('treats a circuit with no predecessor as all additions', () => {
    const d = diffCircuits(null, { numQubits: 1, ops: [{ name: 'RY', qubits: [0], theta: Math.PI / 3 }] })
    expect(d.added).toBe(1)
    expect(d.entries[0].text).toBe('ry(pi/3) q[0]')
  })

  it('serialises classical bindings', () => {
    expect(opText({ name: 'MEASURE', qubits: [1], clbit: 0 })).toBe('measure q[1] -> c[0]')
    expect(opText({ name: 'X', qubits: [2], condition: { bit: 1, value: 1 } })).toBe('if c[1]==1 x q[2]')
  })
})

describe('repairPrompt', () => {
  it('includes the diagnostics of the previous attempt', () => {
    const attempt = {
      index: 1,
      source: 'model' as const,
      prompt: null,
      reply: null,
      circuit: { numQubits: 2, ops: [{ name: 'X' as const, qubits: [0] }] },
      qasm: 'x q[0];',
      parseError: null,
      verdict: {
        pass: false,
        score: 0,
        fidelity: null,
        diagnostics: [{ level: 'error' as const, code: 'distribution_off' as const, message: 'STATE 01 IS OFF' }],
        metrics: { numQubits: 2, gateCount: 1, twoQubitGates: 0, depth: 1 },
        stateDeviations: [],
        amplitudeDeviations: [],
        entryDeviations: [],
        summary: 'Fail: the summary',
      },
      diff: null,
      durationMs: 0,
    }
    const text = repairPrompt(bellSpec, attempt, [])
    expect(text).toContain('STATE 01 IS OFF')
    expect(text).toContain('Fail: the summary')
    expect(text).toContain('x q[0];')
  })
})
