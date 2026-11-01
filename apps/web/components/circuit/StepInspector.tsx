'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  BLOCK_GATES,
  GATE_BY_NAME,
  blockLabel,
  cAbs,
  cArg,
  formatComplex,
  formatKet,
  type Circuit,
  type GateOp,
  type StateVector,
} from '@/lib/quantum'
// A11Y: every spoken update from this control goes through the announcer —
// see scheduleAnnounce() for why it is this and not a rendered live region.
import { announce } from '@/lib/a11y/announce'
import { clampTransportStep, maxFrameStep } from '@/lib/step-transport'

/**
 * Amplitudes this small are numerical dust, not physics. Same cutoff
 * StateInspector uses, for the same reason: a 1e-17 residue left by a rotation
 * is not a basis state a learner should see listed.
 */
const EPS = 1e-9

/**
 * Rows in the before/after table. Deliberately half of StateInspector's 16:
 * this table sits ABOVE that one and is meant to be read at a glance ("this
 * gate moved probability from here to there"), not scrolled.
 */
const MAX_ROWS = 8

/**
 * How long the transport must sit still before anything is spoken.
 *
 * A11Y: holding an arrow key fires the OS key-repeat at roughly 30 Hz, and a
 * live region re-written at 30 Hz is not a fast reader — it is a screen reader
 * that says nothing intelligible for as long as the key is down, and then a
 * backlog. Each move cancels the pending message and re-arms this timer, so no
 * matter how fast the user scrubs, exactly one sentence is spoken, about the
 * step they actually landed on. 400ms is under the ~500ms gap that reads as
 * lag on a single deliberate press, and comfortably slower than the "no more
 * than twice a second" ceiling.
 */
const ANNOUNCE_SETTLE_MS = 400

interface DeltaRow {
  index: number
  ket: string
  /** Amplitude after the step — the sign/phase is the point, so it is shown raw. */
  amp: string
  /** Phase in π units, or null when the amplitude is zero and has no phase. */
  phase: string | null
  before: number
  after: number
}

/**
 * A short label for a gate — "H on q0", "CX q0→q1", "+7 mod 15 on q1–q3".
 *
 * Deliberately NOT the sentence CircuitGrid.describeOp() builds. That one is a
 * spoken description for a screen reader landing on a cell ("Hadamard gate on
 * qubit 0, step 3") and is far too long for the two chips this control shows
 * side by side. Both are read here: the chip carries the short form, and the
 * grid column highlight plus its own cell labels carry the full one.
 */
function opSummary(op: GateOp): string {
  const spec = GATE_BY_NAME[op.name]
  const label = spec?.label ?? op.name
  if (op.name === 'BARRIER') return 'Barrier'
  if (op.name === 'MEASURE') {
    return `Measure q${op.qubits[0]}${op.clbit === undefined ? '' : ` → c${op.clbit}`}`
  }
  if (op.name === 'SWAP') return `Swap q${op.qubits[0]}↔q${op.qubits[1]}`
  if (op.name === 'CSWAP') {
    return `Fredkin q${op.qubits[0]} · q${op.qubits[1]}↔q${op.qubits[2]}`
  }
  if (op.name === 'CX' || op.name === 'CY' || op.name === 'CZ' || op.name === 'CCX' || op.name === 'MCX') {
    const target = op.qubits[op.qubits.length - 1]
    const controls = op.qubits.slice(0, -1)
    return `${label} q${controls.join(',q')}→q${target}`
  }
  if (BLOCK_GATES.has(op.name)) {
    const n = op.controls ?? 0
    const register = op.qubits.slice(n)
    // A malformed block (controls >= qubits) would make Math.min() of an empty
    // list return Infinity and render "on qInfinity–q-Infinity". Rare, but a
    // shared or imported circuit is the one place it could reach a learner.
    if (register.length === 0) return blockLabel(op)
    return `${blockLabel(op)} on q${Math.min(...register)}–q${Math.max(...register)}`
  }
  const angle = spec?.hasAngle && op.theta !== undefined ? `(${(op.theta / Math.PI).toFixed(2)}π)` : ''
  return `${label}${angle} on q${op.qubits[0]}`
}

/**
 * The one-sentence "where am I" for a given cursor position.
 *
 * A free function rather than a value derived inside the component because the
 * transport has to speak the step it is MOVING TO, before React has re-rendered
 * with it. Computing both the rendered sentence and the spoken one from here is
 * what stops the two from drifting into saying different things.
 *
 * One sentence on purpose: the table below is reachable on its own, and hearing
 * it re-read on every arrow press would be unbearable.
 */
function stepSummary(ops: readonly GateOp[], step: number): string {
  const total = ops.length
  if (total === 0) return 'No gates placed yet.'
  const justApplied = step > 0 ? ops[step - 1] : undefined
  const nextOp = step < total ? ops[step] : undefined
  const next = nextOp ? ` Next: ${opSummary(nextOp)}.` : ''
  if (!justApplied) {
    return `Step 0 of ${total}. The starting state, before any gate has run.${next}`
  }
  return (
    `Step ${step} of ${total}. ${opSummary(justApplied)} has just run.` +
    (nextOp ? next : ' This is the final state.')
  )
}

/** "+12.4" / "−12.4" in percentage points, or null when nothing moved. */
function formatDelta(before: number, after: number): string | null {
  const d = (after - before) * 100
  // Below a tenth of a point the rendered "0.0" would claim a change that the
  // two percentages beside it do not show.
  if (Math.abs(d) < 0.05) return null
  return `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`
}

/**
 * Step through a circuit one gate at a time and watch the state evolve.
 *
 * WHY THIS EXISTS: run-to-completion shows a distribution and nothing else, so
 * a four-gate circuit is a black box with a number on the end — the single
 * most consistent finding in quantum-education research is that learners
 * cannot connect an algorithm to the state it produces. This control makes the
 * intermediate states the thing you look at.
 *
 * THE STEP MODEL, which is the page's and not a second one:
 *   `step` counts gates APPLIED, so it indexes `frames` directly —
 *   simulateSteps() returns frames[0] = |0…0⟩ then one frame per op, which is
 *   exactly the prefix simulation this needs; nothing is re-simulated here and
 *   no op list is sliced.
 *   `step === null` means "not stepping — showing the end", which is the state
 *   page.tsx starts in and returns to after any edit. It is rendered as the
 *   last step rather than as a separate mode, so the transport always has a
 *   position; the only visible difference is that the grid draws no column
 *   highlight, which is right — no single gate is current.
 *
 * Driving the page's own `stepIndex` (rather than holding a second cursor) is
 * what guarantees the grid's violet column and this readout can never disagree.
 */
export default function StepInspector({
  circuit,
  frames,
  finalState,
  step,
  onStepChange,
}: {
  circuit: Circuit
  /**
   * simulateSteps(circuit) — MUST come from the same `circuit` prop. page.tsx
   * memoizes both together; a mismatch would show the previous circuit's
   * amplitudes under this circuit's gate labels.
   */
  frames: StateVector[]
  /**
   * The exact state after the last gate. `frames` is only a prefix of the
   * circuit's steps when it was too long to keep every one (see
   * simulateStepsChecked), in which case this is the only honest "end" state.
   * Defaults to the last frame, which is right whenever nothing was cut.
   */
  finalState?: StateVector
  /** Gates applied so far, or null for "not stepping". */
  step: number | null
  onStepChange: (next: number | null) => void
}) {
  const total = circuit.ops.length
  /**
   * The furthest step a frame exists for. Equal to `total` unless the frames
   * were cut off; then the transport stops here, and only End (or a Forward
   * that lands exactly on `total`) reaches the final state, shown from
   * `finalState`. Without this, steps past the cut all read the last kept frame
   * under the label of a gate that never produced it.
   */
  const maxStep = maxFrameStep(total, frames.length)
  const frameCount = frames.length
  const clampStep = useCallback(
    (n: number) => clampTransportStep(n, total, frameCount),
    [total, frameCount]
  )
  const current = step === null ? total : clampStep(step)

  /** The gate whose effect you are looking at, and the one that runs next. */
  const justApplied = current > 0 ? circuit.ops[current - 1] : undefined
  const nextOp = current < total ? circuit.ops[current] : undefined

  const atEnd = current >= total
  const after = atEnd
    ? (finalState ?? frames[Math.min(total, frames.length - 1)])
    : frames[Math.min(current, frames.length - 1)]
  // The state before the last gate may itself be past the kept frames; then
  // there is no honest "before", and the table says so instead of guessing.
  const beforeIndex = Math.max(current - 1, 0)
  const before = beforeIndex <= frames.length - 1 ? frames[beforeIndex] : undefined
  const framesCut = maxStep < total

  /**
   * The before/after table.
   *
   * Scanned with a plain loop instead of building `dim` row objects and
   * filtering: at the 16-qubit plan ceiling `dim` is 65,536, and the rows worth
   * showing are almost always fewer than ten. Allocating 65,536 objects on
   * every arrow-key press to throw all but eight away is the kind of thing that
   * turns a step into a visible stutter.
   */
  const { rows, hiddenCount } = useMemo(() => {
    if (!after || !before) return { rows: [] as DeltaRow[], hiddenCount: 0 }
    const kept: DeltaRow[] = []
    for (let i = 0; i < after.dim; i++) {
      const pAfter = after.probability(i)
      const pBefore = before.probability(i)
      // A basis state that EMPTIED on this step is as informative as one that
      // filled — keeping only `pAfter > 0` would hide exactly the half of
      // interference a learner is here to see.
      if (pAfter < EPS && pBefore < EPS) continue
      const a = after.amplitude(i)
      kept.push({
        index: i,
        ket: formatKet(i, after.numQubits),
        amp: formatComplex(a),
        phase: cAbs(a) < EPS ? null : `${(cArg(a) / Math.PI).toFixed(2)}π`,
        before: pBefore,
        after: pAfter,
      })
    }
    if (kept.length <= MAX_ROWS) return { rows: kept, hiddenCount: 0 }
    // Rank by whichever side is larger so a state being emptied out survives
    // the cut, then restore index order — the table is read as a ket column.
    const top = [...kept]
      .sort((x, y) => Math.max(y.before, y.after) - Math.max(x.before, x.after))
      .slice(0, MAX_ROWS)
    const hidden = kept.length - top.length
    top.sort((x, y) => x.index - y.index)
    return { rows: top, hiddenCount: hidden }
  }, [after, before])

  /**
   * A11Y: the spoken version of everything the chips and the violet column say
   * visually, coalesced to one message per settle (see ANNOUNCE_SETTLE_MS).
   *
   * Deliberately the announcer module and NOT a rendered `role="status"`. Two
   * reasons a rendered region is wrong here: its text would be rewritten on
   * every key-repeat tick with no way to rate-limit it without also lagging the
   * visible sentence, and a refused move leaves the text IDENTICAL — and
   * setting a live region to the value it already holds announces nothing, so
   * pressing Back at step 0 would read as a dead key. announce() clears before
   * it writes, so the refusal is always heard.
   */
  const pending = useRef<number | null>(null)
  const scheduleAnnounce = useCallback((text: string) => {
    if (pending.current !== null) window.clearTimeout(pending.current)
    pending.current = window.setTimeout(() => {
      pending.current = null
      announce(text)
    }, ANNOUNCE_SETTLE_MS)
  }, [])

  // Without this, navigating away mid-scrub still speaks a step on a page the
  // user has already left.
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current)
    },
    []
  )

  const goTo = useCallback(
    (next: number, refusal: string) => {
      const clamped = clampStep(next)
      if (clamped === current) {
        scheduleAnnounce(refusal)
        return
      }
      onStepChange(clamped)
      scheduleAnnounce(stepSummary(circuit.ops, clamped))
    },
    [circuit.ops, clampStep, current, onStepChange, scheduleAnnounce]
  )

  const toStart = useCallback(
    () => goTo(0, 'Already at the start of the circuit, before any gate has run.'),
    [goTo]
  )
  const back = useCallback(
    () => goTo(current - 1, 'Already at the start of the circuit, before any gate has run.'),
    [current, goTo]
  )
  const forward = useCallback(
    () => goTo(current + 1, 'Already at the end of the circuit; every gate has run.'),
    [current, goTo]
  )
  const toEnd = useCallback(
    () => goTo(total, 'Already at the end of the circuit; every gate has run.'),
    [goTo, total]
  )

  /**
   * A11Y (WCAG 2.1.1): one handler for the whole transport — key events bubble
   * up from whichever button holds focus, so the arrows work from any of them
   * and nobody has to Tab back to a specific one between steps. Every
   * destination is also on a button of its own, so the control is fully
   * operable with Tab and Enter alone if the arrows are unavailable.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          back()
          return
        case 'ArrowRight':
          event.preventDefault()
          forward()
          return
        case 'Home':
          event.preventDefault() // would otherwise scroll the page to the top
          toStart()
          return
        case 'End':
          event.preventDefault()
          toEnd()
          return
        default:
      }
    },
    [back, forward, toEnd, toStart]
  )

  const summary = stepSummary(circuit.ops, current)

  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Step through the circuit. Left and right arrow keys move one gate; Home and End jump to the ends."
        className="flex flex-wrap items-center gap-2"
        onKeyDown={onKeyDown}
      >
        {/* Every button stays ENABLED at the ends. Disabling the one that has
            focus when you arrive at step 0 drops focus to the document body
            mid-interaction, which is the worse bug of the two; the refusal is
            announced instead (see goTo). */}
        <button
          type="button"
          className="btn-ghost focus-ring !px-2.5 !py-1 !text-xs"
          onClick={toStart}
          aria-label="Jump to the start, before any gate has run"
        >
          <span aria-hidden="true">⏮</span> Start
        </button>
        <button
          type="button"
          className="btn-ghost focus-ring !px-2.5 !py-1 !text-xs"
          onClick={back}
          aria-label="Step back one gate"
        >
          <span aria-hidden="true">◀</span> Back
        </button>
        <button
          type="button"
          className="btn-primary focus-ring !px-2.5 !py-1 !text-xs"
          onClick={forward}
          aria-label="Step forward one gate"
        >
          Forward <span aria-hidden="true">▶</span>
        </button>
        <button
          type="button"
          className="btn-ghost focus-ring !px-2.5 !py-1 !text-xs"
          onClick={toEnd}
          aria-label="Jump to the end, after every gate has run"
        >
          End <span aria-hidden="true">⏭</span>
        </button>
        <span className="pill ml-auto bg-q-violet/15 text-q-violet-text">
          {total === 0 ? 'No gates' : `Step ${current} / ${total}`}
        </span>
      </div>

      {/* The two halves of "where am I": what the highlighted column has
          already done, and what the next press will do. Colour alone does not
          carry that — each chip names itself in words first. */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-md border border-line bg-surface-2 px-2 py-1">
          <span className="text-ink-muted">Just applied </span>
          <span className="font-mono font-semibold text-q-teal-text">
            {justApplied ? opSummary(justApplied) : 'nothing yet'}
          </span>
        </span>
        <span className="rounded-md border border-line bg-surface-2 px-2 py-1">
          <span className="text-ink-muted">Next </span>
          <span className="font-mono font-semibold text-q-amber-text">
            {nextOp ? opSummary(nextOp) : 'end of circuit'}
          </span>
        </span>
      </div>

      {/* The same sentence scheduleAnnounce() speaks, shown. It updates on the
          spot rather than on the announcer's settle delay, because the pill and
          the chips beside it are already instant and a sentence lagging them by
          400ms would read as a stale readout. */}
      <p className="text-[11px] text-ink-secondary">{summary}</p>

      {framesCut ? (
        <p className="text-[11px] text-q-amber-text">
          Stepping stops at step {maxStep}: this circuit is too long to keep every step at this
          register size. End shows the exact final state.
        </p>
      ) : null}

      {total === 0 ? null : !before ? (
        <p className="text-[11px] text-ink-muted">
          The step before this one was not kept, so there is no before/after table here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <caption className="sr-only">
              Basis states before and after step {current} of {total}
            </caption>
            <thead className="bg-surface-2">
              <tr className="border-b border-line text-[10px] uppercase tracking-wider text-ink-muted">
                <th scope="col" className="px-3 py-2 text-left font-bold">
                  State
                </th>
                <th scope="col" className="px-3 py-2 text-right font-bold">
                  Amplitude
                </th>
                <th scope="col" className="px-3 py-2 text-right font-bold">
                  Phase
                </th>
                <th scope="col" className="px-3 py-2 text-right font-bold">
                  Before
                </th>
                <th scope="col" className="px-3 py-2 text-right font-bold">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const delta = formatDelta(r.before, r.after)
                const rose = r.after < r.before
                return (
                  <tr key={r.index} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5 font-mono text-q-violet-text">{r.ket}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink">{r.amp}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-muted">
                      {r.phase ?? '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-muted">
                      {(r.before * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink">
                      {(r.after * 100).toFixed(1)}%
                      {delta ? (
                        // The arrow is decoration; the signed number beside it
                        // carries the direction on its own, so a screen reader
                        // hears "12.4 percentage points more", not "triangle".
                        <span className={`ml-1.5 ${rose ? 'text-q-rose-text' : 'text-q-teal-text'}`}>
                          <span aria-hidden="true">{rose ? '▼' : '▲'}</span>
                          <span className="sr-only">{rose ? 'down ' : 'up '}</span>
                          {delta}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-center text-ink-muted">
                    Every amplitude is zero here.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {hiddenCount > 0 ? (
        <p className="text-[11px] text-ink-muted">
          {hiddenCount} more basis state{hiddenCount === 1 ? '' : 's'} with smaller amplitudes not
          shown. The full list is in the table below.
        </p>
      ) : null}
    </div>
  )
}
