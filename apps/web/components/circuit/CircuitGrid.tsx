'use client'

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  BLOCK_GATES,
  GATE_BY_NAME,
  blockLabel,
  highestClassicalBit,
  type Circuit,
  type GateName,
  type GateOp,
  type GateSpec,
  type StateVector,
} from '@/lib/quantum'
// A11Y: placing or removing a gate changes the SVG only. Nothing in that change
// reaches a screen reader on its own, so every mutation is also announced.
import { announce } from '@/lib/a11y/announce'
import { columnProbeReadout, describeColumnProbe } from '@/lib/column-probe'
import { insertOpAt, moveOp, removeOpAt, retargetOp } from '@/lib/quantum/circuitEdit'
import ColumnProbe from './ColumnProbe'
import { postselectPlacementProblem } from './postselectGuard'
import {
  BlockEditor,
  DEFAULT_BLOCK_DRAFT,
  DEFAULT_MATRIX_DRAFT,
  MatrixEditor,
  McxEditor,
  ExtraControlsEditor,
  PostselectEditor,
  U3AngleEditor,
  blockDraftProblem,
  effectiveArity,
  pendingHint,
  resolveMatrixDraft,
  type BlockDraft,
  type MatrixDraft,
} from './GateOptions'
import { BOX, COL_W, CROW_H, LABEL_W, PAD_BOTTOM, PAD_TOP, ROW_H, TRAILING_COLS, colX, rowY } from '@/lib/quantum/circuitLayout'

// Colours resolve through CSS custom properties (see docs/THEMING.md) so this
// SVG re-themes for free — no runtime JS needed, since `fill`/`stroke` accept
// `var(...)` directly and the browser re-resolves it whenever `<html>`'s
// class (`.light` / `.dark`) changes.
const HUES: Record<GateSpec['color'], { base: string; light: string }> = {
  violet: { base: 'var(--q-violet)', light: 'var(--q-violet-text)' },
  teal: { base: 'var(--q-teal)', light: 'var(--q-teal-text)' },
  amber: { base: 'var(--q-amber)', light: 'var(--q-amber-text)' },
  rose: { base: 'var(--q-rose)', light: 'var(--q-rose-text)' },
  sky: { base: 'var(--q-sky)', light: 'var(--q-sky-text)' },
  muted: { base: 'var(--ink-muted)', light: 'var(--ink-secondary)' },
}

/**
 * Fade any CSS custom property toward transparent. `color-mix()` works on any
 * `var()` (hex or already-rgba) without needing a decomposed channel triple,
 * so it covers tokens like `--ink-muted` that aren't in `CHANNEL_TOKENS`.
 */
function withAlpha(cssVar: string, alpha: number): string {
  return `color-mix(in srgb, ${cssVar} ${Math.round(alpha * 100)}%, transparent)`
}

/** θ rendered in π units, e.g. "0.50π". */
const piLabel = (theta: number) => `${(theta / Math.PI).toFixed(2)}π`

/**
 * Drag-and-drop MIME types. Two kinds of thing get dragged onto this grid —
 * an already-placed glyph (carries the column it came from) and a palette
 * tile (carries the gate name) — and they need different drop handling, so
 * they get different types rather than one payload the drop handler has to
 * sniff. GatePalette.tsx sets DRAG_GATE_MIME on its buttons' dragstart; keep
 * the string in sync there if it ever changes here.
 */
const DRAG_OP_MIME = 'application/x-qubit16-op'
const DRAG_GATE_MIME = 'application/x-qubit16-gate'

/**
 * A11Y: spoken description of a placed gate.
 *
 * The glyphs carry meaning entirely in shape and colour — a filled dot for a
 * control, ⊕ for a CX target, a dashed rule for a barrier. None of that is
 * available non-visually, so each placed gate gets a sentence instead.
 */
/**
 * A11Y: the extra controls a single-qubit gate carries (see GateOp.extra
 * Controls) — narrated the same way CX/CCX/MCX narrate their controls above,
 * just with the basis and anti-ness spelled out since neither is visible in
 * a spoken sentence.
 */
function describeExtraControls(op: GateOp): string {
  if (!op.extraControls || !op.extraControls.length) return ''
  const parts = op.extraControls.map((ctrl) => {
    const basis = ctrl.basis ?? 'Z'
    const anti = ctrl.anti ?? false
    const basisText = basis === 'Z' ? '' : ` in the ${basis} basis`
    const antiText = anti ? ', anti (fires on the opposite eigenstate)' : ''
    return `qubit ${ctrl.qubit}${basisText}${antiText}`
  })
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `, plus extra control${parts.length > 1 ? 's' : ''} ${list}`
}

function describeOp(op: GateOp, index: number): string {
  const spec = GATE_BY_NAME[op.name]
  const label = spec?.label ?? op.name
  const at = `step ${index + 1}`
  // A11Y: the classical link is drawn as a thin double line down to a wire
  // below the circuit. Nothing about that is available non-visually, and it is
  // the difference between a gate that always runs and one that sometimes does.
  const cond = op.condition
    ? `, conditioned on classical bit ${op.condition.bit} being ${op.condition.value}`
    : ''
  const extra = describeExtraControls(op)
  if (op.name === 'BARRIER') return `Barrier at ${at}`
  if (op.name === 'MEASURE' && op.clbit !== undefined) {
    return `Measure qubit ${op.qubits[0]} into classical bit ${op.clbit}, ${at}`
  }
  if (op.name === 'RESET') {
    return `Reset qubit ${op.qubits[0]} to |0⟩ — measures it and flips it back if it read 1, ${at}${cond}`
  }
  if (op.name === 'POSTSELECT') {
    return `Postselect qubit ${op.qubits[0]} on |${op.postselectValue ?? 0}⟩ — keeps only branches that read this value, ${at}${cond}`
  }
  if (op.name === 'SWAP') return `Swap between qubit ${op.qubits[0]} and qubit ${op.qubits[1]}, ${at}${cond}`
  if (op.name === 'CSWAP') {
    return `Fredkin gate, control qubit ${op.qubits[0]}, swapping qubit ${op.qubits[1]} and qubit ${op.qubits[2]}, ${at}${cond}`
  }
  if (op.name === 'CX' || op.name === 'CY' || op.name === 'CZ' || op.name === 'CCX' || op.name === 'MCX') {
    const target = op.qubits[op.qubits.length - 1]
    const controls = op.qubits.slice(0, -1)
    const controlText = controls.length === 1 ? `control qubit ${controls[0]}` : `control qubits ${controls.join(' and ')}`
    return `${label} gate, ${controlText}, target qubit ${target}, ${at}${cond}`
  }
  if (op.name === 'UNITARY') {
    const size = op.qubits.length === 1 ? '2 by 2' : '4 by 4'
    return `Custom ${size} matrix ${op.label ?? 'U'} on qubit${op.qubits.length === 1 ? '' : 's'} ${op.qubits.join(' and ')}${extra}, ${at}${cond}`
  }
  if (BLOCK_GATES.has(op.name)) {
    const n = op.controls ?? 0
    const register = op.qubits.slice(n)
    const controls = op.qubits.slice(0, n)
    const ctl = controls.length ? `, controlled by qubit ${controls.join(' and ')}` : ''
    return `${blockLabel(op)} block on register qubits ${register.join(', ')} (least significant first)${ctl}, ${at}${cond}`
  }
  if (op.name === 'U3') {
    const t = op.theta ?? 0, phi = op.phi ?? 0, lambda = op.lambda ?? 0
    return `U3 gate on qubit ${op.qubits[0]}, angles θ ${piLabel(t)}, φ ${piLabel(phi)}, λ ${piLabel(lambda)}${extra}, ${at}${cond}`
  }
  const angle = spec?.hasAngle && op.theta !== undefined ? `, angle ${piLabel(op.theta)}` : ''
  return `${label} gate on qubit ${op.qubits[0]}${angle}${extra}, ${at}${cond}`
}

const PENDING_HINTS: Record<string, string[]> = {
  // index = how many qubits already picked
  CX: ['Pick the control qubit', 'Pick the target qubit'],
  CY: ['Pick the control qubit', 'Pick the target qubit'],
  CZ: ['Pick the first qubit', 'Pick the second qubit'],
  SWAP: ['Pick the first qubit', 'Pick the second qubit'],
  CCX: ['Pick the first control', 'Pick the second control', 'Pick the target qubit'],
}

/** Gates whose next-pick hint depends on the drafts, not on a fixed table. */
const DRAFT_HINTED: ReadonlySet<GateName> = new Set<GateName>(['MCX', 'UNITARY', 'CSWAP', 'ADDK', 'MULK', 'QFT', 'IQFT'])

/**
 * Ordinary single-qubit gates `extraControls` is valid on — mirrors
 * lib/quantum.ts's SINGLE_QUBIT_UNITARY_GATES (kept as a small local copy
 * rather than exported machinery, since this side only needs it to decide
 * whether to SHOW the editor; the engine is the one place that enforces it).
 */
const SINGLE_QUBIT_UNITARY_GATE_NAMES: ReadonlySet<GateName> = new Set<GateName>([
  'H', 'X', 'Y', 'Z', 'S', 'SDG', 'T', 'TDG', 'RX', 'RY', 'RZ', 'P', 'SX', 'SXDG', 'U3',
])

export default function CircuitGrid({
  circuit,
  selectedGate,
  theta,
  onChange,
  activeStep = null,
  frames,
  finalState,
  classicalControl = true,
}: {
  circuit: Circuit
  selectedGate: GateName | null
  theta: number
  onChange: (c: Circuit) => void
  activeStep?: number | null
  /**
   * Show the classical-binding row (which bit a MEASURE records into, which bit
   * a gate waits on). On by default — it is how the feature is discovered — but
   * the onboarding walkthrough turns it off, because a guided "place an H, now
   * place a CX" tour should not offer a third choice nobody asked for. Circuits
   * that already carry classical bits still draw their wires either way; this
   * only controls the editing affordance.
   */
  classicalControl?: boolean
  /**
   * Per-step statevectors from simulateSteps(circuit) — MUST be derived from
   * the same `circuit` prop (page.tsx memoizes both together). When present
   * they power the inline column probe: hovering or parking the keyboard
   * cursor on a column shows each qubit's P(|1⟩) after that column, Quirk
   * style. Optional so other embedders of the grid pay nothing for it.
   */
  frames?: StateVector[]
  /**
   * The exact state after the last gate. A long circuit on a wide register
   * keeps only a prefix of `frames`; with this, a column past the last gate
   * still reads the true final state, and a column whose frame was cut off
   * reads nothing instead of an earlier state mislabelled as that column's.
   */
  finalState?: StateVector
}) {
  const [pending, setPending] = useState<number[]>([])
  /**
   * Classical binding for the NEXT placement.
   *
   * `measureClbit` is the bit a MEASURE records into; `condition` is the bit a
   * gate waits on. Both are grid-local because they are properties of the
   * placement gesture, not of the page — the same way `theta` is a property of
   * the palette. Kept between placements on purpose: teleportation needs two
   * measurements into two bits and two corrections off those bits, and being
   * made to re-pick from a menu after each one is the difference between a
   * feature and a chore.
   */
  const [measureClbit, setMeasureClbit] = useState(0)
  const [condition, setCondition] = useState<{ bit: number; value: 0 | 1 } | null>(null)
  /**
   * Wave-2 placement drafts — the settings a gate needs before it can be
   * placed (see GateOptions.tsx). Grid-local for the same reason the classical
   * binding is: they belong to the placement gesture, and they persist between
   * placements so Shor's three controlled multiplications are three clicks
   * apart, not three trips through a form.
   */
  const [mcxControls, setMcxControls] = useState(2)
  const [matrixDraft, setMatrixDraft] = useState<MatrixDraft>(DEFAULT_MATRIX_DRAFT)
  const [blockDraft, setBlockDraft] = useState<BlockDraft>(DEFAULT_BLOCK_DRAFT)
  const drafts = useMemo(
    () => ({ mcxControls, matrix: matrixDraft, block: blockDraft }),
    [blockDraft, matrixDraft, mcxControls]
  )
  /**
   * Wave-3 placement drafts. U3's φ and λ (θ is the page-level "Angle θ"
   * slider every hasAngle gate already shares — see U3AngleEditor's doc
   * comment); which value POSTSELECT keeps; and the extra controls an
   * eligible single-qubit gate carries — see GateOp.extraControls.
   */
  const [u3Phi, setU3Phi] = useState(0)
  const [u3Lambda, setU3Lambda] = useState(0)
  const [postselectValue, setPostselectValue] = useState<0 | 1>(1)
  const [extraControlsDraft, setExtraControlsDraft] = useState<NonNullable<GateOp['extraControls']>>([])
  const extraControlsEligible =
    !!selectedGate &&
    (SINGLE_QUBIT_UNITARY_GATE_NAMES.has(selectedGate) || (selectedGate === 'UNITARY' && matrixDraft.qubits === 1))
  // Stale drafts from a previous gate selection must not leak onto the next
  // placement — a POSTSELECT value chosen while POSTSELECT was selected
  // should not silently ride along onto the next H just because the state
  // was never reset.
  useEffect(() => {
    setExtraControlsDraft([])
  }, [selectedGate])
  const [hovered, setHovered] = useState<number | null>(null)
  /** Column under the mouse (any cell, not just a gate) — drives the probe. */
  const [hoveredCol, setHoveredCol] = useState<number | null>(null)
  /**
   * A11Y (roving tabindex): the grid cursor. Exactly one cell — this one —
   * carries `tabIndex={0}`; every other cell is `-1`, so the whole editor is a
   * single tab stop and the arrow keys move within it. Previously each wire and
   * each placed gate was its own tab stop, which made a 30-gate circuit 30+
   * extra stops (audit §2, "operable but not efficient").
   */
  const [cursor, setCursor] = useState<{ q: number; col: number }>({ q: 0, col: 0 })
  // Whether the cursor cell actually holds DOM focus — the focus outline is
  // drawn by us, because a UA ring on an SVG <rect> is unreliable.
  const [gridFocused, setGridFocused] = useState(false)
  // Stable prefix for cell ids, so moving the cursor can move DOM focus.
  const gridId = useId()

  /**
   * Drag-and-drop state — an ADDITION alongside the click/keyboard flow
   * above, never a replacement for it.
   *
   * `draggingOp` is set while an already-placed glyph is the drag source, so
   * the drop handlers know whether a same-column drop means "retarget" and
   * whether that op is even eligible (only a genuinely single-qubit op can
   * be retargeted by a one-cell drop — a multi-qubit op's drop would leave
   * "which operand?" ambiguous, so that combination is rejected instead of
   * guessed at).
   *
   * `dragOverCell` / `dragOverOccupiedCol` are pure presentation — which
   * cell (or, for a drag hovering an occupied glyph, which whole column) to
   * paint as a valid or invalid drop target right now.
   */
  const [draggingOp, setDraggingOp] = useState<{ col: number; singleQubit: boolean } | null>(null)
  const [dragOverCell, setDragOverCell] = useState<{ q: number; col: number; valid: boolean } | null>(null)
  const [dragOverOccupiedCol, setDragOverOccupiedCol] = useState<number | null>(null)

  // However a drag ends — a successful drop, Escape, or the pointer simply
  // being released outside any drop target — `dragend` always fires on the
  // source element and bubbles to window, and a native `drop` anywhere does
  // too. One global listener guarantees the highlight never gets stuck,
  // regardless of whether the drag started on a glyph in THIS component or a
  // palette tile in a different one.
  useEffect(() => {
    const clear = () => {
      setDraggingOp(null)
      setDragOverCell(null)
      setDragOverOccupiedCol(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  const isPending = pending.length > 0

  // Escape cancels an in-progress multi-qubit placement.
  useEffect(() => {
    if (!isPending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPending([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPending])

  // Abandon a partial placement if the chosen gate — or the operand count a
  // draft implies — changes under it.
  useEffect(() => {
    setPending([])
  }, [selectedGate, circuit.numQubits, mcxControls, matrixDraft.qubits, blockDraft.width, blockDraft.controlled])

  const numCols = circuit.ops.length + TRAILING_COLS
  const width = LABEL_W + numCols * COL_W + 12

  // ── The classical register ────────────────────────────────────────────────
  //
  // One bit per qubit is offered, which is what the QASM export declares. Rows
  // are drawn only for bits the circuit actually touches (plus the one the
  // binding control is currently armed with, so you can see where a placement
  // is about to land) — a circuit that uses no classical bits looks exactly as
  // it always did, with no empty wires under it.
  const numClbits = circuit.numQubits
  const armedBit = !classicalControl
    ? -1
    : selectedGate === 'MEASURE'
      ? measureClbit
      : condition && selectedGate && selectedGate !== 'BARRIER'
        ? condition.bit
        : -1
  const classicalRows = Math.min(
    numClbits,
    Math.max(highestClassicalBit(circuit) + 1, armedBit + 1)
  )
  const showClassical = classicalRows > 0

  const clRowY = useCallback(
    (bit: number) => PAD_TOP + circuit.numQubits * ROW_H + bit * CROW_H + CROW_H / 2,
    [circuit.numQubits]
  )

  const height =
    PAD_TOP + circuit.numQubits * ROW_H + (showClassical ? classicalRows * CROW_H : 0) + PAD_BOTTOM

  // The condition survives a change of register width; clamp it rather than
  // clearing it, so narrowing to 2 qubits and back does not lose the binding.
  // With the binding row hidden there is no condition to apply — an embedder
  // that did not ask for classical control must not get it by default.
  const activeCondition =
    classicalControl && condition && condition.bit < numClbits ? condition : null

  /**
   * The op for a completed pick list, with whatever the gate carries beyond its
   * qubits — angle, matrix, k / N / controls, classical binding. Returns a
   * message instead when the drafts do not describe a gate (a non-unitary
   * matrix, a modulus that does not fit), so the placement is refused out loud
   * rather than producing an op the engine will throw on.
   */
  const buildOp = useCallback(
    (qubits: number[], atIndex: number = circuit.ops.length): GateOp | string => {
      if (!selectedGate) return 'Choose a gate first.'
      const spec = GATE_BY_NAME[selectedGate]
      if (!spec) return `Unknown gate ${selectedGate}.`
      let op: GateOp = spec.hasAngle ? { name: selectedGate, qubits, theta } : { name: selectedGate, qubits }
      if (selectedGate === 'U3') {
        op = { ...op, phi: u3Phi, lambda: u3Lambda }
      }
      if (selectedGate === 'POSTSELECT') {
        op = { ...op, postselectValue }
      }
      if (selectedGate === 'UNITARY') {
        const verdict = resolveMatrixDraft(matrixDraft)
        if (!verdict.ok) return `Cannot place the matrix: ${verdict.message}`
        op = { ...op, matrix: verdict.matrix, label: matrixDraft.label.trim() || 'U' }
      } else if (BLOCK_GATES.has(selectedGate)) {
        const problem = blockDraftProblem(selectedGate, blockDraft, circuit.numQubits)
        if (problem) return `Cannot place the block: ${problem}`
        if (selectedGate === 'ADDK' || selectedGate === 'MULK') {
          op = { ...op, k: blockDraft.k, modulus: blockDraft.modulus }
        }
        if (blockDraft.controlled) op = { ...op, controls: 1 }
      }
      if (extraControlsEligible && extraControlsDraft.length) {
        if (extraControlsDraft.some((c) => qubits.includes(c.qubit))) {
          return `Cannot place: qubit ${extraControlsDraft.find((c) => qubits.includes(c.qubit))!.qubit} is already used as an extra control.`
        }
        op = { ...op, extraControls: extraControlsDraft }
      }
      if (classicalControl && selectedGate === 'MEASURE') {
        return { ...op, clbit: Math.min(measureClbit, numClbits - 1) }
      }
      const placed = activeCondition && selectedGate !== 'BARRIER' ? { ...op, condition: activeCondition } : op
      // A postselect on an outcome that cannot happen at that point would leave
      // a circuit with no state to show: refuse it out loud, like the drafts above.
      if (selectedGate === 'POSTSELECT') {
        const problem = postselectPlacementProblem(circuit, placed, atIndex)
        if (problem) return problem
      }
      return placed
    },
    [
      activeCondition,
      blockDraft,
      circuit,
      circuit.numQubits,
      classicalControl,
      extraControlsDraft,
      extraControlsEligible,
      matrixDraft,
      measureClbit,
      numClbits,
      postselectValue,
      selectedGate,
      theta,
      u3Lambda,
      u3Phi,
    ]
  )

  const placeOn = useCallback(
    (q: number) => {
      if (!selectedGate) return
      const spec = GATE_BY_NAME[selectedGate]
      if (!spec) return
      const arity = spec.variadic || selectedGate === 'BARRIER' ? effectiveArity(selectedGate, drafts) : spec.arity

      const commit = (qubits: number[]) => {
        const op = buildOp(qubits)
        if (typeof op === 'string') {
          // A11Y: the refusal has to be heard as well as seen in the editor.
          announce(op)
          setPending([])
          return
        }
        onChange({ ...circuit, ops: [...circuit.ops, op] })
        setPending([])
        // A11Y: confirm the placement out loud — the only other feedback is a
        // new glyph appearing in the SVG.
        announce(
          `${describeOp(op, circuit.ops.length)} added. ${circuit.ops.length + 1} gates in the circuit.`
        )
      }

      // A barrier crosses every wire: the cell you pressed does not matter.
      if (arity === 0) { commit([]); return }
      if (arity === 1) { commit([q]); return }

      if (pending.includes(q)) {
        // A11Y: silently ignoring the keystroke reads as a broken control.
        announce(`Qubit ${q} is already used by this gate. Pick a different qubit.`)
        return // a qubit cannot play two roles
      }
      const next = [...pending, q]
      if (next.length >= arity) {
        commit(next)
      } else {
        setPending(next)
        const steps = PENDING_HINTS[selectedGate]
        const nextHint = DRAFT_HINTED.has(selectedGate)
          ? pendingHint(selectedGate, next.length, drafts)
          : steps ? steps[Math.min(next.length, steps.length - 1)] : 'Pick the next qubit'
        announce(`Qubit ${q} selected for ${spec.label}. ${nextHint}. Press Escape to cancel.`)
      }
    },
    [buildOp, circuit, drafts, onChange, pending, selectedGate]
  )

  /**
   * Drag-and-drop counterpart of `placeOn`, for a palette tile dropped
   * directly onto grid cell `(q, atCol)` — the alternative to
   * click-a-gate-then-click-a-wire.
   *
   * A gate that places in one step (arity 0, e.g. BARRIER, or arity 1) is
   * inserted AT `atCol` via `insertOpAt`, splicing it into the middle of the
   * circuit instead of appending — that is the whole point of dropping it on
   * a specific column rather than clicking the palette. A gate that needs
   * more than one operand cannot be finished by a single drop, so this only
   * picks the first operand/anchor (`q`) and falls through to the ordinary
   * `placeOn` pending flow for the rest — exactly the same multi-click
   * completion an ordinary click-to-place start already uses, appended at
   * the end like every other click-started placement. Inventing a
   * multi-cell drag gesture instead would be a second, inconsistent way to
   * finish a multi-qubit placement.
   */
  const placeOnAt = useCallback(
    (q: number, atCol: number) => {
      if (!selectedGate) return
      const spec = GATE_BY_NAME[selectedGate]
      if (!spec) return
      const arity = spec.variadic || selectedGate === 'BARRIER' ? effectiveArity(selectedGate, drafts) : spec.arity

      if (arity <= 1) {
        const insertIndex = Math.min(Math.max(atCol, 0), circuit.ops.length)
        const op = buildOp(arity === 0 ? [] : [q], insertIndex)
        if (typeof op === 'string') {
          announce(op)
          return
        }
        onChange(insertOpAt(circuit, insertIndex, op))
        setPending([])
        announce(
          `${describeOp(op, insertIndex)} added at column ${insertIndex + 1}. ${circuit.ops.length + 1} gates in the circuit.`
        )
        return
      }

      placeOn(q)
    },
    [buildOp, circuit, drafts, onChange, placeOn, selectedGate]
  )

  const removeAt = useCallback(
    (index: number) => {
      const op = circuit.ops[index]
      // Same array-splice removeAt always did — now factored into
      // lib/quantum/circuitEdit.ts so the drag-and-drop paths below share it.
      // removeOpAt throws on an out-of-range index; the old inline `filter`
      // silently no-op'd there instead, so that case is preserved here too.
      onChange(op !== undefined ? removeOpAt(circuit, index) : { ...circuit, ops: circuit.ops.slice() })
      // A11Y: focus is destroyed along with the removed glyph, so say what went.
      if (op) announce(`${describeOp(op, index)} removed. ${circuit.ops.length - 1} gates remain.`)
    },
    [circuit, onChange]
  )

  const hint = (() => {
    if (!selectedGate) return null
    if (!isPending) return null
    if (DRAFT_HINTED.has(selectedGate)) return pendingHint(selectedGate, pending.length, drafts)
    const steps = PENDING_HINTS[selectedGate]
    return steps ? steps[Math.min(pending.length, steps.length - 1)] : 'Pick the next qubit'
  })()

  const selectedLabel = !selectedGate
    ? null
    : selectedGate === 'BARRIER'
      ? 'a barrier' // the glyph "┆" is not a word a screen reader can say
      : (GATE_BY_NAME[selectedGate]?.label ?? selectedGate)

  // ── The grid model ────────────────────────────────────────────────────────
  //
  // `circuit.ops` is an ordered list, not a grid: op *i* is drawn in column *i*
  // and spans whichever qubits it acts on (a BARRIER spans all of them). That
  // list IS the coordinate model — `opAt` is the only translation needed.

  /** The op occupying cell (q, col), or undefined if the cell is empty. */
  const opAt = useCallback(
    (q: number, col: number): GateOp | undefined => {
      const op = col < circuit.ops.length ? circuit.ops[col] : undefined
      if (!op) return undefined
      if (op.name === 'BARRIER') return op // a barrier crosses every wire
      return op.qubits.includes(q) ? op : undefined
    },
    [circuit.ops]
  )

  const cellId = useCallback(
    (q: number, col: number) => `${gridId}-cell-${q}-${col}`,
    [gridId]
  )

  /**
   * Whether dropping onto cell `(q, col)` right now would be accepted.
   *
   *   - Dragging an existing glyph onto its OWN column, a different row:
   *     only a genuinely single-qubit op can be retargeted this way (a
   *     multi-qubit op's operand to replace would be ambiguous), and the
   *     landing row must not already be occupied.
   *   - Dragging an existing glyph onto a DIFFERENT column: a move, valid
   *     wherever that cell is currently empty.
   *   - Dragging a palette tile (or anything else): valid on any empty cell
   *     — `insertOpAt` only needs a column in range, which every rendered
   *     column already is.
   */
  const isDropValid = useCallback(
    (q: number, col: number): boolean => {
      if (draggingOp) {
        if (col === draggingOp.col) return draggingOp.singleQubit && opAt(q, col) === undefined
        return opAt(q, col) === undefined
      }
      return opAt(q, col) === undefined
    },
    [draggingOp, opAt]
  )

  /** Shared by every gridcell's onDragOver — a `dragenter`/`dragover` must
   *  call `preventDefault()` or the browser refuses the drop entirely. */
  const onCellDragOver = useCallback(
    (e: ReactDragEvent, q: number, col: number) => {
      if (!e.dataTransfer.types.includes(DRAG_OP_MIME) && !e.dataTransfer.types.includes(DRAG_GATE_MIME)) return
      e.preventDefault()
      const valid = isDropValid(q, col)
      e.dataTransfer.dropEffect = valid ? 'move' : 'none'
      setDragOverOccupiedCol(null)
      setDragOverCell({ q, col, valid })
    },
    [isDropValid]
  )

  const onCellDrop = useCallback(
    (e: ReactDragEvent, q: number, col: number) => {
      e.preventDefault()
      const opColStr = e.dataTransfer.getData(DRAG_OP_MIME)
      const gateName = e.dataTransfer.getData(DRAG_GATE_MIME)
      setDragOverCell(null)
      setDragOverOccupiedCol(null)

      if (opColStr !== '') {
        const fromCol = parseInt(opColStr, 10)
        const op = circuit.ops[fromCol]
        if (!op) return
        if (!isDropValid(q, col)) {
          announce('That cell is occupied. Drop the gate on an empty cell instead.')
          return
        }
        try {
          if (col === fromCol) {
            const next = retargetOp(circuit, fromCol, [q])
            onChange(next)
            announce(
              `Moved ${GATE_BY_NAME[op.name]?.label ?? op.name} gate from qubit ${op.qubits[0]} to qubit ${q}, column ${col + 1}.`
            )
          } else {
            const next = moveOp(circuit, fromCol, col)
            onChange(next)
            announce(
              `Moved ${GATE_BY_NAME[op.name]?.label ?? op.name} gate from column ${fromCol + 1} to column ${col + 1}.`
            )
          }
        } catch (err) {
          announce(err instanceof Error ? err.message : 'Could not move that gate.')
        }
        return
      }

      if (gateName) {
        if (!isDropValid(q, col)) {
          announce('That cell is occupied. Drop the gate on an empty cell instead.')
          return
        }
        placeOnAt(q, col)
      }
    },
    [circuit, isDropValid, onChange, placeOnAt]
  )

  /** A drag hovering an OCCUPIED glyph — always an invalid drop, but still
   *  needs `preventDefault()` to show the "not allowed" cursor instead of
   *  silently falling through to whatever is under the pointer. */
  const onGlyphDragOver = useCallback((e: ReactDragEvent, col: number) => {
    if (!e.dataTransfer.types.includes(DRAG_OP_MIME) && !e.dataTransfer.types.includes(DRAG_GATE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
    setDragOverCell(null)
    setDragOverOccupiedCol(col)
  }, [])

  const onGlyphDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    setDragOverOccupiedCol(null)
    // A11Y: a drop that silently does nothing reads as a broken control.
    announce('That cell is occupied. Drop the gate on an empty cell instead.')
  }, [])

  // The cursor is clamped on read rather than in an effect, so shrinking the
  // circuit (Clear, or removing the last gate) can never leave it off-grid.
  const cursorQ = Math.min(Math.max(cursor.q, 0), circuit.numQubits - 1)
  const cursorCol = Math.min(Math.max(cursor.col, 0), numCols - 1)

  /** Move the cursor and take DOM focus with it — that is what makes it roving. */
  const moveCursor = useCallback(
    (q: number, col: number) => {
      const nextQ = Math.min(Math.max(q, 0), circuit.numQubits - 1)
      const nextCol = Math.min(Math.max(col, 0), numCols - 1)
      setCursor({ q: nextQ, col: nextCol })
      // The target cell is already rendered; only its tabIndex is about to
      // change, so it is safe to focus it in the same tick.
      const node = document.getElementById(cellId(nextQ, nextCol))
      if (node instanceof SVGElement || node instanceof HTMLElement) node.focus()
    },
    [cellId, circuit.numQubits, numCols]
  )

  /**
   * A11Y (WCAG 2.1.1 Keyboard): one handler for the whole grid — key events
   * bubble up from the focused cell.
   *
   *   Arrow keys      move between wires (up/down) and columns (left/right),
   *                   clamped, no wrapping.
   *   Home / End      first / last column of this wire.
   *   Ctrl+Home/End   first / last cell of the whole grid.
   *   Enter / Space   place the selected gate on this wire, or remove the gate
   *                   under the cursor (the same two actions clicking has).
   *   Delete / Back   remove the gate under the cursor.
   *   Escape          cancels a pending multi-qubit placement (handled by the
   *                   window listener above; kept, not replaced).
   */
  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGGElement>) => {
      const { key, ctrlKey, metaKey } = event
      const jump = ctrlKey || metaKey

      switch (key) {
        case 'ArrowUp':
          event.preventDefault()
          moveCursor(cursorQ - 1, cursorCol)
          return
        case 'ArrowDown':
          event.preventDefault()
          moveCursor(cursorQ + 1, cursorCol)
          return
        case 'ArrowLeft':
          event.preventDefault()
          moveCursor(cursorQ, cursorCol - 1)
          return
        case 'ArrowRight':
          event.preventDefault()
          moveCursor(cursorQ, cursorCol + 1)
          return
        case 'Home':
          event.preventDefault()
          moveCursor(jump ? 0 : cursorQ, 0)
          return
        case 'End':
          event.preventDefault()
          moveCursor(jump ? circuit.numQubits - 1 : cursorQ, numCols - 1)
          return
        case 'Enter':
        case ' ':
        case 'Spacebar': {
          event.preventDefault() // Space would otherwise scroll the page
          const op = opAt(cursorQ, cursorCol)
          if (op) removeAt(cursorCol)
          else placeOn(cursorQ)
          return
        }
        case 'Delete':
        case 'Backspace': {
          event.preventDefault()
          const op = opAt(cursorQ, cursorCol)
          if (op) removeAt(cursorCol)
          // A11Y: a key that does nothing reads as a broken control.
          else announce(`Qubit ${cursorQ}, column ${cursorCol + 1} is empty. Nothing to remove.`)
          return
        }
        default:
      }
    },
    [circuit.numQubits, cursorCol, cursorQ, moveCursor, numCols, opAt, placeOn, removeAt]
  )

  /**
   * A11Y: what a screen reader says when the cursor lands on a cell. Position
   * first (it is what changed), then contents, then what Enter will do — the
   * glyphs themselves carry all of this in shape and colour alone.
   */
  const cellLabel = useCallback(
    (q: number, col: number): string => {
      const where = `Qubit ${q}, column ${col + 1}`
      const op = opAt(q, col)
      if (op) return `${where}, ${describeOp(op, col)}. Press Enter to remove.`
      if (!selectedLabel) return `${where}, empty. Choose a gate from the palette before placing.`
      const action = hint
        ? `${hint.replace(/^Pick the /, 'use this qubit as the ')} for ${selectedLabel}`
        : `place ${selectedLabel} as step ${circuit.ops.length + 1}`
      return `${where}, empty. Press Enter to ${action}.`
    },
    [circuit.ops.length, hint, opAt, selectedLabel]
  )

  // ── Inline column probe (Quirk's "point at the pipe" readout) ─────────────
  //
  // Priority: an explicit mouse hover wins, then a hovered gate glyph (glyphs
  // sit on top of the cells and eat their mouseenter), then the keyboard
  // cursor while the grid holds focus. Clamped because a hover can survive a
  // re-render that shrank the circuit (Clear while the mouse is parked).
  const probeCol =
    hoveredCol ?? hovered ?? (gridFocused ? cursorCol : null)
  const probeReadout = useMemo(() => {
    if (!frames || probeCol === null) return null
    return columnProbeReadout(frames, Math.min(probeCol, numCols - 1), {
      opCount: circuit.ops.length,
      finalState,
    })
  }, [frames, finalState, probeCol, numCols, circuit.ops.length])

  /**
   * A register block or a 2-qubit custom matrix draws ONE wide box spanning
   * every wire between its outermost qubits, with its label centred over the
   * MIDDLE of that box — see GateGlyph below. ColumnProbe's pill sits at
   * `rowY(q) + 18`, which is clear of any single-row 34px gate box, but for a
   * 3+-qubit span the middle lands on an interior wire and the pill's
   * percentage rendered right on top of the label, as one garbled string.
   * Those interior rows have no gap for this column, so their pill is
   * dropped rather than layered on the label.
   */
  const probeSkipRows = useMemo(() => {
    if (probeCol === null || probeCol >= circuit.ops.length) return null
    const op = circuit.ops[probeCol]
    if (!op || !(BLOCK_GATES.has(op.name) || (op.name === 'UNITARY' && op.qubits.length === 2))) {
      return null
    }
    const minQ = Math.min(...op.qubits)
    const maxQ = Math.max(...op.qubits)
    if (maxQ - minQ < 2) return null
    const skip = new Set<number>()
    for (let q = minQ + 1; q < maxQ; q++) skip.add(q)
    return skip
  }, [probeCol, circuit.ops])

  // A11Y: the keyboard path to the probe. The pills are aria-hidden visuals;
  // a screen-reader user gets the same numbers through the existing live
  // region whenever the grid cursor lands on a NEW column (vertical moves
  // keep the column, so they stay quiet — the cell label already speaks).
  const lastSpokenColRef = useRef<number | null>(null)
  useEffect(() => {
    if (!gridFocused || !frames) {
      lastSpokenColRef.current = null
      return
    }
    if (lastSpokenColRef.current === cursorCol) return
    lastSpokenColRef.current = cursorCol
    const readout = columnProbeReadout(frames, cursorCol, {
      opCount: circuit.ops.length,
      finalState,
    })
    if (readout) announce(describeColumnProbe(readout))
    // circuit.ops.length and finalState are read for the lookup only; a new
    // circuit must not re-announce the same column, which is what keying on
    // cursorCol and frames (both rebuilt with the circuit) already guarantees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorCol, frames, gridFocused])

  return (
    <div className="space-y-3">
      <div
        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${
          hint ? 'border-q-violet/50 bg-q-violet/[0.12] text-q-violet-text' : 'border-line bg-surface-2 text-ink-muted'
        }`}
        role="status"
      >
        <span>
          {hint
            ? `${hint} · press Esc to cancel`
            : selectedGate === 'BARRIER'
              ? 'Barrier selected — tap any cell, or press Enter on one, to drop a dashed line across every wire at that step. It groups steps visually; the engine skips it.'
              : selectedGate
                ? // A11Y: the old copy said "click", which told a keyboard user the
                  // feature was not for them. Name both routes.
                  `${GATE_BY_NAME[selectedGate]?.label ?? selectedGate} selected — tap or click a wire, or Tab into the grid and use the arrow keys, then press Enter, to place it. Enter, Delete, or tapping a placed gate removes it.`
                : 'Pick a gate from the palette to start building.'}
        </span>
        {isPending ? (
          <button type="button" className="focus-ring shrink-0 underline" onClick={() => setPending([])}>
            Cancel
          </button>
        ) : null}
      </div>

      {/* ── Wave-2 gate settings ────────────────────────────────────────────
          What a multi-controlled X, a custom matrix or a register block needs
          before the first wire is picked. Same bar, same reasoning as the
          classical binding below: native inputs, keyboard-first. */}
      {selectedGate === 'MCX' ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <McxEditor controls={mcxControls} numQubits={circuit.numQubits} onChange={setMcxControls} />
        </div>
      ) : selectedGate === 'UNITARY' ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-3">
          <MatrixEditor draft={matrixDraft} onChange={setMatrixDraft} />
        </div>
      ) : selectedGate && BLOCK_GATES.has(selectedGate) ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <BlockEditor name={selectedGate} draft={blockDraft} numQubits={circuit.numQubits} onChange={setBlockDraft} />
        </div>
      ) : null}

      {/* ── Wave-3 gate settings ──────────────────────────────────────────── */}
      {selectedGate === 'U3' ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-3">
          <U3AngleEditor
            phi={u3Phi}
            lambda={u3Lambda}
            onChange={({ phi, lambda }) => { setU3Phi(phi); setU3Lambda(lambda) }}
          />
        </div>
      ) : null}
      {selectedGate === 'POSTSELECT' ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <PostselectEditor value={postselectValue} onChange={setPostselectValue} />
        </div>
      ) : null}
      {extraControlsEligible ? (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
          <ExtraControlsEditor
            controls={extraControlsDraft}
            numQubits={circuit.numQubits}
            usedQubits={[]}
            onChange={setExtraControlsDraft}
          />
        </div>
      ) : null}

      {/* ── Classical binding ──────────────────────────────────────────────
          A measurement writes a bit; a later gate reads it. These two selects
          are where that link is made. They are plain <select>s and not a
          drag-and-drop affordance for the same reason the palette is buttons:
          the whole editor has to work from the keyboard, and a native select
          is operable, labelled and screen-reader-legible for free. */}
      {classicalControl && selectedGate && selectedGate !== 'BARRIER' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
          {selectedGate === 'MEASURE' ? (
            <label className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="font-semibold">Record result into</span>
              <select
                value={measureClbit}
                onChange={(e) => setMeasureClbit(parseInt(e.target.value, 10))}
                className="focus-ring rounded border border-line bg-surface-3 px-2 py-1 font-mono text-xs text-ink"
              >
                {Array.from({ length: numClbits }, (_, b) => (
                  <option key={b} value={b}>
                    c{b}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="font-semibold">Run this gate</span>
              <select
                value={activeCondition ? `${activeCondition.bit}:${activeCondition.value}` : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) {
                    setCondition(null)
                    announce('Gates will be placed unconditionally.')
                    return
                  }
                  const [bit, value] = v.split(':').map((n) => parseInt(n, 10))
                  setCondition({ bit, value: value === 1 ? 1 : 0 })
                  announce(`Next gate will run only when classical bit ${bit} is ${value}.`)
                }}
                className="focus-ring rounded border border-line bg-surface-3 px-2 py-1 font-mono text-xs text-ink"
              >
                <option value="">always</option>
                {Array.from({ length: numClbits }, (_, b) => [
                  <option key={`${b}-1`} value={`${b}:1`}>
                    only if c{b} = 1
                  </option>,
                  <option key={`${b}-0`} value={`${b}:0`}>
                    only if c{b} = 0
                  </option>,
                ])}
              </select>
            </label>
          )}
          <span className="text-[11px] text-ink-muted">
            {selectedGate === 'MEASURE'
              ? 'The outcome is stored, and the qubit collapses — the state inspector shows the collapsed state, not the one before it.'
              : activeCondition
                ? `Placed gates wait for c${activeCondition.bit}. A bit nobody has measured yet reads 0.`
                : 'Bind a gate to a measured bit to build teleportation, superdense coding, or a correcting error-correction round.'}
          </span>
        </div>
      ) : null}

      {/* RESPONSIVE: `overscroll-x-contain` stops a horizontal swipe that runs
          off the end of the circuit from continuing into the browser's
          back-navigation gesture — on a phone the SVG is wider than the
          viewport from about the sixth gate onwards (46 + n*52 + 12 px against
          342px of usable width), so that swipe is the normal way to read the
          circuit and it was quietly navigating people off the page.
          The grid's own geometry (COL_W 52, ROW_H 56) is NOT changed: cells
          measure 52x48 CSS px, already above the 44px minimum, and
          tests/e2e/helpers.ts hardcodes these four constants. */}
      <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line bg-surface-2">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          /*
           * A11Y (WCAG 1.3.1 / 4.1.2): this was role="img", which is what
           * axe-core's `nested-interactive` rule fires on here. role="img"
           * declares the whole subtree to be one flat graphic, so EVERY
           * descendant is made presentational — including the role="grid"
           * below and all of its focusable role="gridcell" rects. The effect
           * was that the carefully built keyboard grid (roving tabindex, per
           * cell aria-labels like "Qubit 0, column 1, empty. Press Enter to
           * place H as step 1.") was reachable by Tab and arrow keys but
           * announced as nothing: a screen-reader user could move the cursor
           * around the circuit in total silence, hearing only the one summary
           * string on this element. A negative tabindex does not undo that,
           * which is exactly what axe reports.
           *
           * role="group" labels the container without flattening it, so the
           * summary is still announced on entry AND the grid inside is exposed.
           */
          role="group"
          aria-label={`Quantum circuit with ${circuit.numQubits} qubits and ${circuit.ops.length} gates`}
          style={{ display: 'block' }}
          // The probe follows per-cell mouseenter; leaving the SVG entirely is
          // the only reliable "no column is hovered" signal.
          onMouseLeave={() => setHoveredCol(null)}
          onDragLeave={() => {
            setDragOverCell(null)
            setDragOverOccupiedCol(null)
          }}
        >
          {/* Active step column highlight */}
          {activeStep !== null && activeStep >= 0 && activeStep < circuit.ops.length ? (
            <rect
              x={LABEL_W + activeStep * COL_W}
              y={2}
              width={COL_W}
              height={height - 4}
              fill={withAlpha('var(--q-violet)', 0.18)}
              stroke={withAlpha('var(--q-violet)', 0.45)}
              rx={6}
            />
          ) : null}

          {/* Wires + labels. Purely decorative: every one of these is described
              by the gridcell labels below, so exposing them twice would just
              double the reading. */}
          <g aria-hidden="true">
            {Array.from({ length: circuit.numQubits }, (_, q) => {
              const y = rowY(q)
              const picked = pending.includes(q)
              return (
                <g key={`wire-${q}`}>
                  {picked ? (
                    <rect
                      x={LABEL_W - 6}
                      y={y - ROW_H / 2 + 4}
                      width={width - LABEL_W}
                      height={ROW_H - 8}
                      fill={withAlpha('var(--q-violet)', 0.1)}
                      rx={6}
                    />
                  ) : null}
                  <text
                    x={LABEL_W - 12}
                    y={y + 4}
                    textAnchor="end"
                    className="font-mono"
                    fontSize={12}
                    fill={picked ? 'var(--q-violet-text)' : 'var(--ink-secondary)'}
                  >
                    q{q}
                  </text>
                  <line
                    x1={LABEL_W}
                    y1={y}
                    x2={width - 6}
                    y2={y}
                    stroke={picked ? withAlpha('var(--q-violet)', 0.7) : 'var(--line-strong)'}
                    strokeWidth={picked ? 2 : 1.5}
                  />
                </g>
              )
            })}

            {/* Classical wires, drawn as the conventional double line so they
                read as "a bit, not a qubit" at a glance. Only bits the circuit
                touches get a wire — see `classicalRows`. */}
            {showClassical
              ? Array.from({ length: classicalRows }, (_, b) => {
                  const y = clRowY(b)
                  const armed = b === armedBit
                  const stroke = armed ? withAlpha('var(--q-amber)', 0.9) : 'var(--line-strong)'
                  return (
                    <g key={`cwire-${b}`}>
                      <text
                        x={LABEL_W - 12}
                        y={y + 4}
                        textAnchor="end"
                        className="font-mono"
                        fontSize={11}
                        fill={armed ? 'var(--q-amber-text)' : 'var(--ink-muted)'}
                      >
                        c{b}
                      </text>
                      <line x1={LABEL_W} y1={y - 1.6} x2={width - 6} y2={y - 1.6} stroke={stroke} strokeWidth={1.2} />
                      <line x1={LABEL_W} y1={y + 1.6} x2={width - 6} y2={y + 1.6} stroke={stroke} strokeWidth={1.2} />
                    </g>
                  )
                })
              : null}
          </g>

          {/* A11Y: the editor as a real grid widget — ONE tab stop, arrow keys
              inside it (roving tabindex; deliberately not combined with
              aria-activedescendant). Rows are wires, columns are steps. */}
          <g
            role="grid"
            aria-label={`Circuit editor grid, ${circuit.numQubits} ${
              circuit.numQubits === 1 ? 'qubit' : 'qubits'
            } by ${numCols} columns. Use the arrow keys to move, Enter to place or remove a gate.`}
            onKeyDown={onGridKeyDown}
          >
            {Array.from({ length: circuit.numQubits }, (_, q) => {
              const y = rowY(q)
              const top = y - ROW_H / 2 + 4
              return (
                <g key={`row-${q}`} role="row">
                  {Array.from({ length: numCols }, (_, col) => {
                    const isCursor = q === cursorQ && col === cursorCol
                    return (
                      <rect
                        key={`cell-${q}-${col}`}
                        id={cellId(q, col)}
                        x={LABEL_W + col * COL_W}
                        y={top}
                        width={COL_W}
                        height={ROW_H - 8}
                        fill="transparent"
                        style={{ cursor: selectedGate ? 'crosshair' : 'default' }}
                        role="gridcell"
                        // Roving tabindex: only the cursor cell is tabbable.
                        tabIndex={isCursor ? 0 : -1}
                        aria-label={cellLabel(q, col)}
                        onClick={() => {
                          // Clicking also moves the cursor, so the keyboard
                          // picks up where the mouse left off.
                          setCursor({ q, col })
                          const op = opAt(q, col)
                          if (op) removeAt(col)
                          else placeOn(q)
                        }}
                        onMouseEnter={() => setHoveredCol(col)}
                        onFocus={() => {
                          setCursor({ q, col })
                          setGridFocused(true)
                        }}
                        onBlur={() => setGridFocused(false)}
                        onDragOver={(e) => onCellDragOver(e, q, col)}
                        onDrop={(e) => onCellDrop(e, q, col)}
                      />
                    )
                  })}
                </g>
              )
            })}
          </g>

          {/* Placed gates */}
          {circuit.ops.map((op, i) => (
            <GateGlyph
              key={`op-${i}`}
              op={op}
              col={i}
              numQubits={circuit.numQubits}
              // A11Y: the grid cursor landing on a gate lights it up exactly as
              // a mouse hover does, so the remove badge appears for keyboard
              // users too.
              hovered={hovered === i || (gridFocused && cursorCol === i && opAt(cursorQ, i) !== undefined)}
              onHover={(on) => setHovered(on ? i : null)}
              onRemove={() => removeAt(i)}
              clRowY={showClassical ? clRowY : null}
              onDragStartOp={() => setDraggingOp({ col: i, singleQubit: op.qubits.length === 1 })}
              onDragEndOp={() => {
                setDraggingOp(null)
                setDragOverCell(null)
                setDragOverOccupiedCol(null)
              }}
              onDragOverOccupied={(e) => onGlyphDragOver(e, i)}
              onDropOccupied={onGlyphDrop}
            />
          ))}

          {/* A11Y: our own focus indicator for the cursor cell — the UA ring on
              an SVG <rect> is inconsistent across browsers. Drawn after the
              cells so it is never painted over, and pointer-transparent. */}
          {gridFocused ? (
            <rect
              x={LABEL_W + cursorCol * COL_W}
              y={rowY(cursorQ) - ROW_H / 2 + 4}
              width={COL_W}
              height={ROW_H - 8}
              fill={withAlpha('var(--q-violet)', 0.12)}
              stroke="var(--q-violet)"
              strokeWidth={2}
              rx={6}
              pointerEvents="none"
            />
          ) : null}

          {/* Drag-and-drop drop-target highlighting — an ADDITION to the
              keyboard focus ring above, drawn after it so a drag that is
              also over the cursor cell still shows valid/invalid colour.
              Pointer-transparent so it never steals the dragover/drop it is
              reacting to. */}
          {dragOverCell ? (
            <rect
              x={LABEL_W + dragOverCell.col * COL_W}
              y={rowY(dragOverCell.q) - ROW_H / 2 + 4}
              width={COL_W}
              height={ROW_H - 8}
              fill={withAlpha(dragOverCell.valid ? 'var(--q-teal)' : 'var(--q-rose)', 0.28)}
              stroke={dragOverCell.valid ? 'var(--q-teal)' : 'var(--q-rose)'}
              strokeWidth={2}
              rx={6}
              pointerEvents="none"
            />
          ) : null}
          {dragOverOccupiedCol !== null ? (
            <rect
              x={LABEL_W + dragOverOccupiedCol * COL_W}
              y={PAD_TOP - 4}
              width={COL_W}
              height={circuit.numQubits * ROW_H}
              fill={withAlpha('var(--q-rose)', 0.16)}
              stroke="var(--q-rose)"
              strokeWidth={2}
              strokeDasharray="4 3"
              rx={6}
              pointerEvents="none"
            />
          ) : null}

          {/* Inline probe: P(|1⟩) per qubit after the hovered/cursor column.
              Drawn last so the pills sit above gates; pointer-transparent so
              they never steal the hover that summoned them. */}
          {probeCol !== null ? (
            <ColumnProbe
              x={colX(Math.min(probeCol, numCols - 1))}
              rowYs={Array.from({ length: circuit.numQubits }, (_, q) =>
                probeSkipRows?.has(q) ? undefined : rowY(q)
              )}
              colWidth={COL_W}
              readout={probeReadout}
            />
          ) : null}

        </svg>

        {circuit.ops.length === 0 ? (
          <p className="border-t border-line px-4 py-3 text-center text-xs text-ink-muted">
            Pick a gate, then tap a cell — or Tab into the grid and use the arrow keys and
            Enter — to place it.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function GateGlyph({
  op,
  col,
  numQubits,
  hovered,
  onHover,
  onRemove,
  clRowY,
  onDragStartOp,
  onDragEndOp,
  onDragOverOccupied,
  onDropOccupied,
}: {
  op: GateOp
  col: number
  numQubits: number
  hovered: boolean
  onHover: (on: boolean) => void
  onRemove: () => void
  /** y of a classical wire, or null when no classical wires are drawn. */
  clRowY: ((bit: number) => number) | null
  /** Drag-and-drop (an ADDITION to click/keyboard removal above). */
  onDragStartOp: () => void
  onDragEndOp: () => void
  onDragOverOccupied: (e: ReactDragEvent) => void
  onDropOccupied: (e: ReactDragEvent) => void
}) {
  const spec = GATE_BY_NAME[op.name]
  const hue = HUES[spec?.color ?? 'muted']
  const x = colX(col)

  /**
   * The link between a gate and the classical wire it talks to.
   *
   * Two directions, drawn differently on purpose:
   *   MEASURE   a double line ending in an arrowhead ON the wire — the bit is
   *             being written down there.
   *   condition a dashed line ending in a filled dot with the value beside it —
   *             the gate is reading up from there, and the dot is the same
   *             control dot a CX uses, because it means the same thing.
   */
  const classicalLink = () => {
    if (!clRowY) return null
    if (op.name === 'MEASURE' && op.clbit !== undefined) {
      const y0 = rowY(op.qubits[0]) + BOX / 2
      const y1 = clRowY(op.clbit)
      return (
        <g pointerEvents="none">
          <line x1={x - 1.6} y1={y0} x2={x - 1.6} y2={y1} stroke="var(--ink-muted)" strokeWidth={1.2} />
          <line x1={x + 1.6} y1={y0} x2={x + 1.6} y2={y1} stroke="var(--ink-muted)" strokeWidth={1.2} />
          <path d={`M ${x - 4} ${y1 - 5} L ${x + 4} ${y1 - 5} L ${x} ${y1} Z`} fill="var(--ink-secondary)" />
        </g>
      )
    }
    if (!op.condition) return null
    const ys = op.qubits.map(rowY)
    const y0 = Math.max(...ys) + (op.name === 'SWAP' ? 9 : BOX / 2)
    const y1 = clRowY(op.condition.bit)
    return (
      <g pointerEvents="none">
        <line
          x1={x}
          y1={y0}
          x2={x}
          y2={y1}
          stroke={hue.base}
          strokeWidth={1.6}
          strokeDasharray="3 3"
        />
        <circle cx={x} cy={y1} r={4} fill={hue.base} />
        <text x={x + 7} y={y1 + 4} fontSize={9} className="font-mono" fill={hue.light}>
          ={op.condition.value}
        </text>
      </g>
    )
  }

  /**
   * A11Y: the glyph is now a MOUSE affordance only. Its content is exposed to
   * assistive tech by the gridcell underneath it (which names the gate and says
   * that Enter removes it), so exposing it a second time as a focusable button
   * would both duplicate the reading and put back the per-gate tab stops that
   * the roving-tabindex grid exists to remove. Removal by keyboard lives on the
   * grid: Enter or Delete on the cursor cell.
   */
  const interactive = {
    onClick: onRemove,
    onMouseEnter: () => onHover(true),
    onMouseLeave: () => onHover(false),
    style: { cursor: 'pointer' as const },
    'aria-hidden': true as const,
    // Drag-and-drop (an ADDITION alongside click/keyboard removal above):
    // every placed glyph can be dragged to move or retarget it, and — since
    // this cell is OCCUPIED — is also the drop target that rejects a drag
    // arriving from elsewhere instead of silently overwriting.
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(DRAG_OP_MIME, String(col))
      onDragStartOp()
    },
    onDragEnd: onDragEndOp,
    onDragOver: onDragOverOccupied,
    onDrop: onDropOccupied,
  }

  const badge = (bx: number, by: number) =>
    hovered ? (
      <g pointerEvents="none">
        <circle cx={bx} cy={by} r={7} fill="var(--q-rose)" />
        <path
          d={`M ${bx - 3} ${by - 3} L ${bx + 3} ${by + 3} M ${bx + 3} ${by - 3} L ${bx - 3} ${by + 3}`}
          stroke="#ffffff"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
    ) : null

  const title = <title>Click to remove</title>

  // ── BARRIER: dashed line across every wire ──
  if (op.name === 'BARRIER') {
    const top = PAD_TOP + 6
    const bottom = PAD_TOP + numQubits * ROW_H - 6
    return (
      <g {...interactive}>
        {title}
        <rect x={x - 10} y={top} width={20} height={bottom - top} fill="transparent" />
        <line
          x1={x}
          y1={top}
          x2={x}
          y2={bottom}
          stroke={hovered ? 'var(--q-rose-text)' : 'var(--line-strong)'}
          strokeWidth={2}
          strokeDasharray="5 4"
        />
        {badge(x + 11, top + 2)}
      </g>
    )
  }

  // ── MEASURE: box with a meter glyph ──
  if (op.name === 'MEASURE') {
    const y = rowY(op.qubits[0])
    return (
      <g {...interactive}>
        {title}
        <rect
          x={x - BOX / 2}
          y={y - BOX / 2}
          width={BOX}
          height={BOX}
          rx={7}
          fill="var(--surface-3)"
          stroke={hovered ? 'var(--q-rose-text)' : 'var(--line-strong)'}
          strokeWidth={1.5}
        />
        <path
          d={`M ${x - 9} ${y + 6} A 9 9 0 0 1 ${x + 9} ${y + 6}`}
          fill="none"
          stroke="var(--ink-secondary)"
          strokeWidth={1.6}
        />
        <line x1={x} y1={y + 6} x2={x + 6.5} y2={y - 4} stroke="var(--ink)" strokeWidth={1.6} strokeLinecap="round" />
        {classicalLink()}
        {badge(x + BOX / 2 - 2, y - BOX / 2 + 2)}
      </g>
    )
  }

  // ── POSTSELECT: a bra-style label showing the chosen value ──
  if (op.name === 'POSTSELECT') {
    const y = rowY(op.qubits[0])
    return (
      <g {...interactive}>
        {title}
        <rect
          x={x - BOX / 2}
          y={y - BOX / 2}
          width={BOX}
          height={BOX}
          rx={7}
          fill={withAlpha(hue.base, hovered ? 0.32 : 0.2)}
          stroke={hovered ? hue.light : withAlpha(hue.base, 0.7)}
          strokeWidth={1.6}
        />
        <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={hue.light} pointerEvents="none">
          {`⟨${op.postselectValue ?? 0}|`}
        </text>
        {classicalLink()}
        {badge(x + BOX / 2 - 2, y - BOX / 2 + 2)}
      </g>
    )
  }

  // ── SWAP: crosses on both wires ──
  if (op.name === 'SWAP') {
    const [a, b] = op.qubits
    const ya = rowY(a)
    const yb = rowY(b)
    const cross = (cy: number) => (
      <path
        d={`M ${x - 7} ${cy - 7} L ${x + 7} ${cy + 7} M ${x + 7} ${cy - 7} L ${x - 7} ${cy + 7}`}
        stroke={hue.light}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    )
    return (
      <g {...interactive}>
        {title}
        <rect x={x - BOX / 2} y={Math.min(ya, yb) - 12} width={BOX} height={Math.abs(yb - ya) + 24} fill="transparent" />
        <line x1={x} y1={ya} x2={x} y2={yb} stroke={hue.base} strokeWidth={2} />
        {cross(ya)}
        {cross(yb)}
        {classicalLink()}
        {badge(x + BOX / 2 - 4, Math.min(ya, yb) - 8)}
      </g>
    )
  }

  // ── CSWAP (Fredkin): a control dot and two crosses ──
  if (op.name === 'CSWAP') {
    const [ctl, a, b] = op.qubits
    const ys = op.qubits.map(rowY)
    const top = Math.min(...ys), bottom = Math.max(...ys)
    const cross = (cy: number) => (
      <path
        d={`M ${x - 7} ${cy - 7} L ${x + 7} ${cy + 7} M ${x + 7} ${cy - 7} L ${x - 7} ${cy + 7}`}
        stroke={hue.light}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    )
    return (
      <g {...interactive}>
        {title}
        <rect x={x - BOX / 2} y={top - 14} width={BOX} height={bottom - top + 28} fill="transparent" />
        <line x1={x} y1={top} x2={x} y2={bottom} stroke={hue.base} strokeWidth={2} />
        <circle cx={x} cy={rowY(ctl)} r={5} fill={hue.base} />
        {cross(rowY(a))}
        {cross(rowY(b))}
        {classicalLink()}
        {badge(x + BOX / 2 - 4, top - 10)}
      </g>
    )
  }

  // ── Register blocks and 2-qubit custom matrices: a tall box over the register ──
  if (BLOCK_GATES.has(op.name) || (op.name === 'UNITARY' && op.qubits.length === 2)) {
    const nControls = BLOCK_GATES.has(op.name) ? (op.controls ?? 0) : 0
    const controls = op.qubits.slice(0, nControls)
    const register = op.qubits.slice(nControls)
    const regYs = register.map(rowY)
    const top = Math.min(...regYs) - BOX / 2
    const bottom = Math.max(...regYs) + BOX / 2
    const allYs = op.qubits.map(rowY)
    const lineTop = Math.min(...allYs), lineBottom = Math.max(...allYs)
    const W = 46
    const label = op.name === 'UNITARY' ? (op.label ?? 'U') : blockLabel(op)
    // "+7 mod 15" is two lines in a 46px box; "QFT" and a custom label are one.
    const parts = label.includes(' mod ') ? label.split(' mod ').map((p, i) => (i ? `mod ${p}` : p)) : [label]
    const midY = (top + bottom) / 2
    return (
      <g {...interactive}>
        {title}
        <rect x={x - W / 2} y={lineTop - 14} width={W} height={lineBottom - lineTop + 28} fill="transparent" />
        {controls.length ? <line x1={x} y1={lineTop} x2={x} y2={lineBottom} stroke={hue.base} strokeWidth={2} /> : null}
        {controls.map((cq) => (
          <circle key={`c-${cq}`} cx={x} cy={rowY(cq)} r={5} fill={hue.base} />
        ))}
        <rect
          x={x - W / 2}
          y={top}
          width={W}
          height={bottom - top}
          rx={8}
          fill={withAlpha(hue.base, hovered ? 0.32 : 0.2)}
          stroke={hovered ? hue.light : withAlpha(hue.base, 0.7)}
          strokeWidth={1.6}
        />
        {/* Bit index beside each register wire: register[0] is the low bit.
            Read out in full by the gridcell label; here it is the visual cue. */}
        {register.map((rq, bit) => (
          <text
            key={`bit-${rq}`}
            x={x - W / 2 + 4}
            y={rowY(rq) + 3}
            fontSize={7}
            className="font-mono"
            fill={hue.light}
            opacity={0.8}
            pointerEvents="none"
          >
            {bit}
          </text>
        ))}
        {parts.map((part, i) => (
          <text
            key={part}
            x={x + 3}
            y={midY + (parts.length === 1 ? 4 : i === 0 ? -1 : 9)}
            textAnchor="middle"
            fontSize={parts.length === 1 && part.length <= 4 ? 11 : 8}
            fontWeight={700}
            fill={hue.light}
            pointerEvents="none"
          >
            {part}
          </text>
        ))}
        {classicalLink()}
        {badge(x + W / 2 - 4, lineTop - 10)}
      </g>
    )
  }

  // ── Controlled gates ──
  if (op.name === 'CX' || op.name === 'CY' || op.name === 'CZ' || op.name === 'CCX' || op.name === 'MCX') {
    const qs = op.qubits
    const target = qs[qs.length - 1]
    const controls = qs.slice(0, qs.length - 1)
    const ys = qs.map(rowY)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    const yTarget = rowY(target)

    const targetGlyph = () => {
      if (op.name === 'CZ') {
        // CZ is symmetric: a filled dot on both wires.
        return <circle cx={x} cy={yTarget} r={5} fill={hue.base} />
      }
      if (op.name === 'CY') {
        return (
          <g>
            <circle cx={x} cy={yTarget} r={12} fill="var(--surface-2)" stroke={hue.base} strokeWidth={2} />
            <text x={x} y={yTarget + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill={hue.light}>
              Y
            </text>
          </g>
        )
      }
      // CX / CCX use the ⊕ glyph
      return (
        <g>
          <circle cx={x} cy={yTarget} r={11} fill="var(--surface-2)" stroke={hue.base} strokeWidth={2} />
          <line x1={x - 11} y1={yTarget} x2={x + 11} y2={yTarget} stroke={hue.base} strokeWidth={2} />
          <line x1={x} y1={yTarget - 11} x2={x} y2={yTarget + 11} stroke={hue.base} strokeWidth={2} />
        </g>
      )
    }

    return (
      <g {...interactive}>
        {title}
        <rect x={x - BOX / 2} y={top - 14} width={BOX} height={bottom - top + 28} fill="transparent" />
        <line x1={x} y1={top} x2={x} y2={bottom} stroke={hue.base} strokeWidth={2} />
        {controls.map((cq) => (
          <circle key={`c-${cq}`} cx={x} cy={rowY(cq)} r={5} fill={hue.base} />
        ))}
        {targetGlyph()}
        {classicalLink()}
        {badge(x + BOX / 2 - 4, top - 10)}
      </g>
    )
  }

  // ── Single-qubit boxed gate ──
  const y = rowY(op.qubits[0])
  const angle = spec?.hasAngle ? op.theta : undefined
  const hasAngle = angle !== undefined
  const extraControls = op.extraControls ?? []
  /*
   * extraControls (Task 4): the SAME filled-dot control style CX already
   * uses for an ordinary Z-basis positive control — so a plain "always
   * controlled the usual way" op looks exactly like a CX's control dot at a
   * glance. Anti, X and Y controls are visually distinct: an open/ring dot
   * (the target gate fires on the OPPOSITE eigenstate of whatever's drawn),
   * plus a small basis-letter badge for X/Y. The connecting line reuses
   * CX/CCX's solid control-line style.
   */
  return (
    <g {...interactive}>
      {title}
      {extraControls.map((ctrl) => (
        <line
          key={`ec-line-${ctrl.qubit}`}
          x1={x}
          y1={y}
          x2={x}
          y2={rowY(ctrl.qubit)}
          stroke={hue.base}
          strokeWidth={2}
        />
      ))}
      <rect
        x={x - BOX / 2}
        y={y - BOX / 2}
        width={BOX}
        height={BOX}
        rx={8}
        fill={withAlpha(hue.base, hovered ? 0.32 : 0.2)}
        stroke={hovered ? hue.light : withAlpha(hue.base, 0.7)}
        strokeWidth={1.6}
      />
      <text
        x={x}
        y={hasAngle ? y + 1 : y + 5}
        textAnchor="middle"
        fontSize={13}
        fontWeight={700}
        fill={hue.light}
        pointerEvents="none"
      >
        {op.name === 'UNITARY' ? (op.label ?? 'U').slice(0, 4) : (spec?.label ?? op.name)}
      </text>
      {angle !== undefined ? (
        <text
          x={x}
          y={y + 12}
          textAnchor="middle"
          fontSize={8}
          fill={hue.light}
          opacity={0.85}
          pointerEvents="none"
        >
          {piLabel(angle)}
        </text>
      ) : null}
      {extraControls.map((ctrl) => {
        const basis = ctrl.basis ?? 'Z'
        const anti = ctrl.anti ?? false
        const cy = rowY(ctrl.qubit)
        // Z-basis, positive: the plain filled dot, matching CX. Anything else
        // (anti, or a rotated basis) is an open ring instead.
        const plain = basis === 'Z' && !anti
        return (
          <g key={`ec-dot-${ctrl.qubit}`}>
            {plain ? (
              <circle cx={x} cy={cy} r={5} fill={hue.base} />
            ) : (
              <circle cx={x} cy={cy} r={5} fill="var(--surface-2)" stroke={hue.base} strokeWidth={2} />
            )}
            {basis !== 'Z' ? (
              <text
                x={x + 9}
                y={cy + 3}
                fontSize={8}
                fontWeight={700}
                className="font-mono"
                fill={hue.light}
              >
                {basis}
              </text>
            ) : null}
          </g>
        )
      })}
      {classicalLink()}
      {badge(x + BOX / 2 - 2, y - BOX / 2 + 2)}
    </g>
  )
}
