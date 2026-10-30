import { outcomeBranches, type Circuit, type GateOp } from '@/lib/quantum'

/**
 * Would appending / inserting this POSTSELECT make the circuit impossible?
 *
 * "Impossible" means every measurement branch is discarded by some postselect
 * (probability ~0), so there is no state to show and every downstream panel
 * (probabilities, Bloch spheres, run) would fall into its error path. The
 * engine already knows how to answer exactly this: `outcomeBranches` throws the
 * "every postselection ... is impossible" error. Running it as a dry run uses
 * the engine's own rule instead of re-deriving one here, and it follows
 * mid-circuit measurements branch by branch, so a postselect that is possible
 * on at least one branch is allowed.
 *
 * Returns a user-facing refusal, or null when the placement is fine. It never
 * blocks on anything it cannot decide: a circuit too large to enumerate, or
 * any other engine error, lets the placement through (the editor's own
 * notices then explain), and a circuit that was ALREADY impossible before this
 * op is not blamed on it.
 */
export function postselectPlacementProblem(
  circuit: Circuit,
  op: GateOp,
  index: number = circuit.ops.length
): string | null {
  if (op.name !== 'POSTSELECT') return null
  const at = Math.min(Math.max(index, 0), circuit.ops.length)
  const withOp: Circuit = { ...circuit, ops: [...circuit.ops.slice(0, at), op, ...circuit.ops.slice(at)] }
  if (!isImpossible(withOp)) return null
  if (isImpossible(circuit)) return null // already impossible: not this op's doing
  const q = op.qubits[0]
  const v = op.postselectValue ?? 0
  return `Cannot place: postselecting q${q} on |${v}⟩ here has probability 0, so the circuit could never continue past it. Postselect the other value, or move it to a point where that outcome can happen.`
}

function isImpossible(circuit: Circuit): boolean {
  try {
    outcomeBranches(circuit)
    return false
  } catch (err) {
    return err instanceof Error && /postselection .*impossible/.test(err.message)
  }
}
