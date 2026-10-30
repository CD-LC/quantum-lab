import { describe, expect, it } from 'vitest'
import { postselectPlacementProblem } from '../components/circuit/postselectGuard'
import type { Circuit, GateOp } from '@/lib/quantum'

const ps = (q: number, v: 0 | 1): GateOp => ({ name: 'POSTSELECT', qubits: [q], postselectValue: v })

describe('postselectPlacementProblem', () => {
  it('refuses a postselect on an outcome that cannot happen', () => {
    const c: Circuit = { numQubits: 1, ops: [] } // |0>: reading 1 has probability 0
    expect(postselectPlacementProblem(c, ps(0, 1))).toMatch(/probability 0/)
    expect(postselectPlacementProblem(c, ps(0, 0))).toBeNull()
  })

  it('allows it once a gate makes the outcome possible', () => {
    const c: Circuit = { numQubits: 1, ops: [{ name: 'H', qubits: [0] }] }
    expect(postselectPlacementProblem(c, ps(0, 1))).toBeNull()
  })

  it('judges the position the op will occupy, not the end of the circuit', () => {
    const c: Circuit = { numQubits: 1, ops: [{ name: 'X', qubits: [0] }] }
    expect(postselectPlacementProblem(c, ps(0, 1))).toBeNull() // after X: |1>
    expect(postselectPlacementProblem(c, ps(0, 1), 0)).toMatch(/probability 0/) // before X: |0>
  })

  it('does not blame the new op for a circuit that was already impossible', () => {
    const c: Circuit = { numQubits: 1, ops: [ps(0, 1)] }
    expect(postselectPlacementProblem(c, ps(0, 1))).toBeNull()
  })

  it('ignores every other gate', () => {
    expect(postselectPlacementProblem({ numQubits: 1, ops: [] }, { name: 'H', qubits: [0] })).toBeNull()
  })
})
