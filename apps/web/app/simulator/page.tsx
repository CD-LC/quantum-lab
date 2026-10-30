'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import GatePalette from '@/components/circuit/GatePalette'
import SaveLoadPanel from '@/components/circuit/SaveLoadPanel'
import ExportPanel from '@/components/circuit/ExportPanel'
import ResearchPanel from '@/components/circuit/ResearchPanel'
import { decodeCircuit } from '@/lib/share-link'
import CircuitGrid from '@/components/circuit/CircuitGrid'
import StateInspector from '@/components/circuit/StateInspector'
import StepInspector from '@/components/circuit/StepInspector'
import { Slider, Segmented, Toggle, ButtonRow } from '@/components/ui/Controls'
import { Histogram, HistogramTable, type HistogramDatum } from '@/components/ui/Histogram'
import { track } from '@/lib/analytics/track'
import { trackCircuitBuilt } from '@/lib/analytics/emitters'
import {
  GATE_BY_NAME,
  PRESETS,
  emptyCircuit,
  fromQasm,
  run,
  simulateStepsChecked,
  StateVector,
  toQasm,
  type Circuit,
  type GateName,
  type RunResult,
} from '@/lib/quantum'
import { EXTENDED_PRESETS } from '@/lib/quantum/gates-extended'
import { ALGORITHM_PRESETS } from '@/lib/quantum/algorithmPresets'
import {
  createHistory,
  push as pushHistory,
  undo as undoHistory,
  redo as redoHistory,
  canUndo as canUndoHistory,
  canRedo as canRedoHistory,
  type HistoryState,
} from '@/lib/quantum/history'
import { useEntitlement } from '@/components/billing/useEntitlement'
import QubitLimitNotice from '@/components/billing/QubitLimitNotice'
import { PLANS, maxQubitsFor, type Plan } from '@/lib/plans'
import { announce } from '@/lib/a11y/announce'

/** The highest qubit count any plan allows — the full range of the control. */
const QUBIT_CEILING = 16
const SHOT_OPTIONS = ['256', '1024', '4096'] as const
type ShotOption = (typeof SHOT_OPTIONS)[number]

/** Wave-1 presets plus the block-built ones (period finding, Shor) and the
 *  textbook algorithm presets (Deutsch-Jozsa, Bernstein-Vazirani, Simon,
 *  QPE, HHL, VQE, QAOA). */
const ALL_PRESETS = [...PRESETS, ...EXTENDED_PRESETS, ...ALGORITHM_PRESETS]

const formatPi = (v: number) => `${(v / Math.PI).toFixed(2)}π`
const formatPct = (v: number) => `${(v * 100).toFixed(1)}%`

/**
 * Drop ops that reference a qubit index outside the new register.
 *
 * Classical bits are deliberately NOT filtered here. lib/quantum.ts sizes the
 * classical register from the ops themselves, so a condition that survives a
 * narrowing still names a bit that exists — and a bit nobody measured reads 0,
 * which is a defined answer rather than an error.
 */
function clampCircuit(circuit: Circuit, numQubits: number): Circuit {
  return {
    numQubits,
    numClbits: circuit.numClbits === undefined ? undefined : Math.min(circuit.numClbits, numQubits),
    ops: circuit.ops.filter((op) => op.qubits.every((q) => q >= 0 && q < numQubits)),
  }
}

/** The cheapest self-serve plan that can simulate `n` qubits. */
function planForQubits(n: number): Plan | undefined {
  return PLANS.find((p) => !p.contactSales && p.limits.maxQubits >= n)
}

/** The message shown when a circuit is too wide for the current plan. */
function truncationMessage(needed: number, allowed: number): string {
  return `This circuit needs ${needed} qubits; your plan allows ${allowed}. Upgrade to load it in full.`
}

type HistoryAction<T> = { type: 'push'; value: T } | { type: 'undo' } | { type: 'redo' }

function historyReducer<T>(state: HistoryState<T>, action: HistoryAction<T>): HistoryState<T> {
  switch (action.type) {
    case 'push':
      return pushHistory(state, action.value)
    case 'undo':
      return undoHistory(state)
    case 'redo':
      return redoHistory(state)
  }
}

/**
 * Thin React wrapper around lib/quantum/history.ts's pure undo-stack
 * functions. Every circuit-mutating call path (grid edits, Clear, presets,
 * loads, qubit-count changes, QASM imports) funnels its next `Circuit`
 * through `setCircuit` here so Ctrl+Z/Ctrl+Shift+Z genuinely undo/redo all
 * of them, not just diagram edits.
 */
function useCircuitHistory(initial: Circuit) {
  const [state, dispatch] = useReducer(historyReducer<Circuit>, initial, createHistory)
  const setCircuit = useCallback((value: Circuit) => dispatch({ type: 'push', value }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  return {
    circuit: state.present,
    setCircuit,
    undo,
    redo,
    canUndo: canUndoHistory(state),
    canRedo: canRedoHistory(state),
  }
}

export default function SimulatorPage() {
  const { entitlement, plan, loading: entitlementLoading } = useEntitlement()

  // While the entitlement is in flight we assume the ceiling: clamping first and
  // asking questions later would flash a downgraded UI at someone who pays.
  const allowedQubits = entitlementLoading ? QUBIT_CEILING : maxQubitsFor(entitlement)

  const [numQubits, setNumQubits] = useState(2)
  const { circuit, setCircuit, undo, redo, canUndo, canRedo } = useCircuitHistory(emptyCircuit(2))
  const [selectedGate, setSelectedGate] = useState<GateName | null>('H')
  const [theta, setTheta] = useState(Math.PI / 2)
  const [shots, setShots] = useState<ShotOption>('1024')
  const [noise, setNoise] = useState(0)
  const [result, setResult] = useState<RunResult | null>(null)
  const [stepIndex, setStepIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [presetId, setPresetId] = useState('')
  // The QASM pane's textarea text. It is the SAME string whether it is
  // currently mirroring the circuit (the common case) or holding the user's
  // in-progress edit — see the sync effect and handleQasmChange below.
  const [qasmInput, setQasmInput] = useState(() => toQasm(emptyCircuit(2)))
  const [qasmError, setQasmError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Qubit count the user asked for but their plan does not allow. */
  const [upsellQubits, setUpsellQubits] = useState<number | null>(null)
  const [loadNotice, setLoadNotice] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [qasmNotice, setQasmNotice] = useState<string | null>(null)
  const sharedAppliedRef = useRef(false)
  // 'qasm' for exactly one circuit-change cycle right after the QASM pane
  // itself committed a parsed edit — see the sync effect. Every other circuit
  // mutation (grid edit, Clear, preset, load, undo/redo, qubit resize)
  // leaves this at 'other', which is also its resting value.
  const qasmSourceRef = useRef<'qasm' | 'other'>('other')
  const qasmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // INSTANT FEEDBACK (Quirk's core UX): every gate placement/removal changes
  // `circuit`, which recomputes these memos in the same render — the state
  // inspector, phase disks, and the grid's inline column probe all update
  // live, no Run press needed. Run stays for what IS stochastic: shot
  // sampling and noise. One simulateSteps() pass feeds everything (the final
  // frame IS the full-circuit state, so the old extra simulate() call was
  // redundant work on the hot path). Deliberately NOT debounced: measured at
  // the worst case — 16 qubits, 20 gates — simulateSteps() takes ~50ms
  // (median 51.5ms over 10 runs, Node 22 / Float64Array), and a placement is
  // a discrete click, not a stream of input. Re-measure before adding gates
  // wider than the 16-qubit plan ceiling.
  //
  // This runs during render, so it must never throw: a POSTSELECT that cannot
  // happen (placed on a |0⟩ wire, or arriving in a share link) comes back as a
  // notice with the state frozen at that step, and anything unexpected falls
  // back to the blank register plus the error text, instead of reaching
  // error.tsx and discarding the learner's circuit.
  const stepsResult = useMemo(() => {
    try {
      return simulateStepsChecked(circuit)
    } catch (e) {
      const blank = new StateVector(Math.min(16, Math.max(1, Math.trunc(circuit.numQubits) || 1)))
      return {
        frames: [blank],
        finalState: blank,
        notice: e instanceof Error ? e.message : 'This circuit could not be simulated.',
      }
    }
  }, [circuit])
  const { frames, finalState, notice: simNotice } = stepsResult
  // `frames` can be a PREFIX of the circuit's steps (a long circuit on a wide
  // register keeps only so many), so frames[last] is the final state only when
  // nothing was cut. Anything at or past the last gate reads finalState, which
  // is always exact; a step in the cut-off range (the transport does not offer
  // one) clamps to the last kept frame rather than reading off the end.
  const displayState = useMemo(
    () =>
      stepIndex === null || stepIndex >= circuit.ops.length
        ? finalState
        : frames[Math.min(Math.max(stepIndex, 0), frames.length - 1)],
    [circuit.ops.length, frames, finalState, stepIndex]
  )
  const qasm = useMemo(() => toQasm(circuit), [circuit])

  const selectedSpec = selectedGate ? GATE_BY_NAME[selectedGate] : undefined
  const preset = ALL_PRESETS.find((p) => p.id === presetId)

  const histogramData = useMemo<HistogramDatum[]>(
    () =>
      result
        ? Object.entries(result.counts).map(([label, value]) => ({ label, value }))
        : [],
    [result]
  )

  const changeQubits = useCallback(
    (n: number) => {
      if (n > allowedQubits) {
        // Do not silently ignore the click — say why nothing happened.
        setUpsellQubits(n)
        return
      }
      setUpsellQubits(null)
      setNumQubits(n)
      setCircuit(clampCircuit(circuit, n))
      setResult(null)
      setStepIndex(null)
      setPresetId('')
      setLoadNotice(null)
    },
    [allowedQubits, circuit, setCircuit]
  )

  // The entitlement can drop under us (a subscription lapses, a sign-out). When
  // it does, bring the register back inside the new limit and keep the circuit
  // valid. Guarded on loading so it never runs against the free-tier default.
  useEffect(() => {
    if (entitlementLoading) return
    if (upsellQubits !== null && upsellQubits <= allowedQubits) setUpsellQubits(null)
    if (numQubits <= allowedQubits) return
    setNumQubits(allowedQubits)
    setCircuit(clampCircuit(circuit, allowedQubits))
    setResult(null)
    setStepIndex(null)
    // `circuit` and `setCircuit` are deliberately excluded: clamping creates a
    // new circuit reference every render once numQubits > allowedQubits, and
    // this effect must run once per over-limit transition, not loop on its
    // own output. `numQubits <= allowedQubits` above is what makes each
    // subsequent run a no-op once the clamp has landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedQubits, entitlementLoading, numQubits, upsellQubits])

  const handleCircuitChange = useCallback(
    (c: Circuit) => {
      setCircuit(c)
      setStepIndex(null)
      setResult(null)
      setRunError(null)
    },
    [setCircuit]
  )

  const handleRun = useCallback(() => {
    // run() throws for a circuit with no defined outcome (every POSTSELECT
    // impossible). Say so in the page rather than failing silently.
    try {
      setResult(run(circuit, parseInt(shots, 10), noise))
      setRunError(null)
    } catch (e) {
      setResult(null)
      setRunError(e instanceof Error ? e.message : 'This circuit could not be run.')
      return
    }
    // 'circuit.built' fires here (and on Step) rather than on every gate
    // placement: running is the first evidence a composed circuit was meant.
    // The emitter dedups per session per circuit shape, so re-running the same
    // circuit with different shots/noise counts once.
    trackCircuitBuilt(circuit)
    // The /insights dashboard charts 'circuit.run' as its second series; without
    // this call that chart is permanently empty. Counts and flags only — never
    // the circuit itself, which is user-authored content.
    track('circuit.run', {
      numQubits: circuit.numQubits,
      gateCount: circuit.ops.length,
      shots: parseInt(shots, 10),
      noisy: noise > 0,
    })
  }, [circuit, noise, shots])

  // StepInspector owns the transport (start / back / forward / end, plus the
  // arrow keys) and drives THIS state, so the grid's violet column and the
  // step readout are one cursor and cannot disagree. The old "Step" button in
  // the run row was a second, weaker path to the same state — it only moved
  // forward and wrapped round to null past the last gate, which under the new
  // readout looked like a press that did nothing — so it is gone rather than
  // left to compete.
  const handleStepChange = useCallback(
    (next: number | null) => {
      // Stepping through a circuit is the same "this was built on purpose"
      // signal as running it; the emitter ignores an empty grid and repeats.
      trackCircuitBuilt(circuit)
      setStepIndex(next)
    },
    [circuit]
  )

  const handleClear = useCallback(() => {
    setCircuit(emptyCircuit(numQubits))
    setResult(null)
    setStepIndex(null)
    setPresetId('')
  }, [numQubits, setCircuit])

  const handlePreset = useCallback(
    (id: string) => {
      setPresetId(id)
      const p = ALL_PRESETS.find((x) => x.id === id)
      if (!p) return
      const needed = Math.max(1, p.circuit.numQubits)
      const n = Math.min(allowedQubits, needed)
      setNumQubits(n)
      setCircuit(
        clampCircuit(
          { numQubits: needed, ops: p.circuit.ops.map((op) => ({ ...op })) },
          n
        )
      )
      setLoadNotice(needed > allowedQubits ? truncationMessage(needed, allowedQubits) : null)
      setResult(null)
      setStepIndex(null)
    },
    [allowedQubits, setCircuit]
  )

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(qasm)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard is unavailable (insecure context or denied permission) — fail quietly.
      setCopied(false)
    }
  }, [qasm])

  const handleLoadCircuit = useCallback(
    (c: Circuit) => {
      const needed = Math.max(1, c.numQubits)
      const n = Math.min(allowedQubits, needed)
      setNumQubits(n)
      setCircuit(clampCircuit(c, n))
      setLoadNotice(needed > allowedQubits ? truncationMessage(needed, allowedQubits) : null)
      setResult(null)
      setStepIndex(null)
      setPresetId('')
    },
    [allowedQubits, setCircuit]
  )

  // Load a shared circuit from ?c=<token> once, after the entitlement resolves so
  // the width it comes back with is the real one.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (entitlementLoading || sharedAppliedRef.current) return
    const token = new URLSearchParams(window.location.search).get('c')
    if (!token) return
    sharedAppliedRef.current = true
    const shared = decodeCircuit(token)
    if (shared) handleLoadCircuit(shared)
  }, [entitlementLoading, handleLoadCircuit])

  // Parse `text` as QASM and, if it describes a circuit that differs from the
  // one on screen, commit it through history. Used by both the debounced
  // live path (onChange) and the explicit "Import" button.
  //
  // On failure the circuit is deliberately left untouched — qasmError is set
  // and the diagram does not reset just because the user is mid-edit typing
  // invalid QASM.
  const applyQasmText = useCallback(
    (text: string) => {
      let parsed: Circuit
      try {
        parsed = fromQasm(text)
      } catch (err) {
        setQasmError(
          err instanceof Error
            ? err.message
            : 'That does not look like OpenQASM. Check the syntax and try again.'
        )
        return
      }
      if (parsed.ops.length === 0) {
        setQasmError('No gates were recognised. Include lines like "h q[0];" and "cx q[0], q[1];".')
        return
      }
      const needed = Math.max(1, parsed.numQubits)
      const n = Math.min(allowedQubits, needed)
      const clamped = clampCircuit(parsed, n)
      setQasmError(null)
      setQasmNotice(needed > allowedQubits ? truncationMessage(needed, allowedQubits) : null)
      // Structural no-op guard: if what the user typed already parses back to
      // the circuit that's on screen (e.g. they typed it back verbatim, or
      // the debounce fired again after a prior commit), skip pushing a
      // duplicate history entry and skip the re-render that would otherwise
      // re-run the sync effect below.
      if (JSON.stringify(clamped) === JSON.stringify(circuit)) return
      // Tell the sync effect this circuit change came from the QASM pane
      // itself, so it does NOT regenerate the textarea from toQasm() and
      // stomp the user's own formatting/whitespace with a re-serialized copy.
      qasmSourceRef.current = 'qasm'
      setCircuit(clamped)
      setNumQubits(n)
      setResult(null)
      setStepIndex(null)
      setPresetId('')
    },
    [allowedQubits, circuit, setCircuit]
  )

  // Debounced live sync: typing pauses for ~400ms before an edit is parsed
  // and (if valid and different) applied to the circuit.
  const handleQasmChange = useCallback(
    (text: string) => {
      setQasmInput(text)
      if (qasmDebounceRef.current !== null) clearTimeout(qasmDebounceRef.current)
      qasmDebounceRef.current = setTimeout(() => {
        qasmDebounceRef.current = null
        applyQasmText(text)
      }, 400)
    },
    [applyQasmText]
  )

  // An explicit, immediate alternative to waiting out the debounce — useful
  // for a screen-reader or keyboard user who wants a predictable, discrete
  // "apply now" action rather than trusting a timer. The debounced path
  // above is still the primary flow.
  const handleImportNow = useCallback(() => {
    if (qasmDebounceRef.current !== null) {
      clearTimeout(qasmDebounceRef.current)
      qasmDebounceRef.current = null
    }
    applyQasmText(qasmInput)
  }, [applyQasmText, qasmInput])

  useEffect(
    () => () => {
      if (qasmDebounceRef.current !== null) clearTimeout(qasmDebounceRef.current)
    },
    []
  )

  // Keep the QASM textarea mirroring the circuit whenever the circuit changed
  // for a reason OTHER than the QASM pane's own edit (diagram edit, undo/
  // redo, Clear, a preset, a load, a qubit-count change). When the change
  // DID come from the QASM pane (qasmSourceRef === 'qasm'), skip so the
  // user's exact keystrokes aren't replaced by a re-serialized copy — this
  // is what avoids the feedback loop.
  useEffect(() => {
    if (qasmSourceRef.current === 'qasm') {
      qasmSourceRef.current = 'other'
      return
    }
    setQasmInput(qasm)
    // A regenerated textarea is no longer an in-progress edit with an error.
    setQasmError(null)
  }, [circuit, qasm])

  // Keep numQubits following the circuit's own register size, which covers
  // undo/redo (they restore a Circuit whose numQubits may differ from the
  // current control) as well as every handler above that already sets both
  // explicitly — this is a harmless no-op re-assertion in that case.
  useEffect(() => {
    setNumQubits(circuit.numQubits)
  }, [circuit])

  const handleUndo = useCallback(() => {
    if (!canUndo) return
    undo()
    setResult(null)
    setStepIndex(null)
    setPresetId('')
    announce('Undo: circuit reverted')
  }, [canUndo, undo])

  const handleRedo = useCallback(() => {
    if (!canRedo) return
    redo()
    setResult(null)
    setStepIndex(null)
    setPresetId('')
    announce('Redo: circuit restored')
  }, [canRedo, redo])

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo — but not while
  // focus is in a text field, where the browser's own undo should apply
  // instead (e.g. inside the QASM textarea while composing an edit).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const key = e.key.toLowerCase()
      if (key === 'z' && e.shiftKey) {
        e.preventDefault()
        handleRedo()
      } else if (key === 'z') {
        e.preventDefault()
        handleUndo()
      } else if (key === 'y') {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-10">
      <header className="mb-7">
        <p className="section-label">Simulator</p>
        <h1 className="section-title mt-1">Quantum Circuit Simulator</h1>
        <p className="section-desc mt-2">
          Build a circuit, run it, and read the state — all computed in your browser. The palette
          covers the standard set plus √X, Fredkin, a multi-controlled X with any number of controls,
          a custom 2×2 or 4×4 matrix with a unitarity check, barriers, and register blocks — +k mod N,
          ×k mod N and the QFT — which is what lets you assemble Shor’s order-finding circuit from parts.
          Everything exports to OpenQASM 3 that reads back exactly.
        </p>
      </header>

      {/* items-start: the gate palette is ~700px tall and the editor card
          used to stretch to match it, leaving a 2-qubit grid floating in
          500px of empty card. The editor now sizes to its content. */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="card p-5">
          <div className="space-y-5">
            <div>
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-secondary">
                Qubits
              </span>
              <div
                role="group"
                aria-label="Qubits"
                // 6 per row, not 8: with a lock glyph beside each number, eight
                // columns squeezed "9🔒10🔒11🔒" into an unreadable run.
                className="grid grid-cols-6 gap-1 rounded-lg border border-line bg-surface-2 p-1.5"
              >
                {Array.from({ length: QUBIT_CEILING }, (_, i) => i + 1).map((n) => {
                  const locked = n > allowedQubits
                  const active = n === numQubits
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={active}
                      aria-label={locked ? `${n} qubits — locked on your plan` : `${n} qubits`}
                      onClick={() => changeQubits(n)}
                      className={`focus-ring rounded-md px-1 py-1.5 text-xs font-semibold tabular-nums transition-colors ${
                        active
                          ? 'bg-q-violet text-white'
                          : locked
                            ? // A11Y (WCAG 1.4.3): was `opacity-50`, which
                              // multiplied --ink-muted (#7d8cb0) down against
                              // --surface-2 to an effective #49536e — 2.26:1,
                              // half the required 4.5:1 (axe-core, /simulator).
                              // The 1.4.3 exemption for "inactive user interface
                              // components" does NOT cover these: a locked
                              // button is still enabled and still calls
                              // changeQubits on click (it drives the upsell), and
                              // the digit it shows is information. Locked now
                              // reads as recessed via the SURFACE instead of by
                              // draining the text: --ink-muted is kept at full
                              // strength (5.0:1 on --surface-2) and the lock
                              // glyph, which is aria-hidden decoration and
                              // therefore genuinely out of scope for 1.4.3,
                              // carries the rest of the signal.
                              'bg-bg/60 text-ink-muted hover:bg-surface-3 hover:text-ink-secondary'
                            : 'text-ink-muted hover:bg-surface-3 hover:text-ink-secondary'
                      }`}
                    >
                      {locked ? (
                        <span className="flex items-center justify-center gap-1">
                          {n}
                          <span aria-hidden="true" className="text-[8px] leading-none opacity-70">
                            🔒
                          </span>
                        </span>
                      ) : (
                        n
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="mt-1.5">
                <QubitLimitNotice
                  allowed={allowedQubits}
                  ceiling={QUBIT_CEILING}
                  planId={plan.id}
                />
              </div>
              {upsellQubits !== null ? (
                <div
                  // Was a literal rgba(245,166,35,0.08): the light theme's amber
                  // baked in, so the dark theme got a washed-out warm smear on a
                  // near-black card. The token tint tracks --q-amber-rgb per
                  // theme and is the same colour the notice's own copy uses.
                  className="mt-2 rounded-card border border-line bg-q-amber/10 p-3"
                  role="status"
                >
                  <p className="text-[13px] font-bold text-ink">
                    {upsellQubits} qubits needs{' '}
                    {planForQubits(upsellQubits)?.name ?? 'a paid'} plan
                  </p>
                  <p className="mt-1 text-[11px] text-ink-secondary">
                    Your {plan.name} plan simulates up to {allowedQubits} qubits, so the register
                    stayed where it was.
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Link href="/pricing" className="btn-primary focus-ring !px-3 !py-1 !text-xs">
                      See plans
                    </Link>
                    <button
                      type="button"
                      className="btn-ghost focus-ring !px-3 !py-1 !text-xs"
                      onClick={() => setUpsellQubits(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <GatePalette selected={selectedGate} onSelect={setSelectedGate} extended />
            {selectedSpec?.hasAngle ? (
              <Slider
                label="Angle θ"
                value={theta}
                min={0}
                max={Math.PI * 2}
                step={Math.PI / 32}
                onChange={setTheta}
                format={formatPi}
                hint="Applied to the next rotation gate you place."
              />
            ) : null}
          </div>
        </aside>

        <section className="card p-5">
          <CircuitGrid
            circuit={circuit}
            selectedGate={selectedGate}
            theta={theta}
            onChange={handleCircuitChange}
            activeStep={stepIndex === null ? null : stepIndex - 1}
            // Same memo the inspector reads — the grid's inline column probe
            // is a lookup into these frames, never a second simulation.
            frames={frames}
            finalState={finalState}
          />
        </section>
      </div>

      <div className="card mt-5 flex flex-wrap items-end gap-5 p-4">
        <div className="w-40">
          <Segmented
            label="Shots"
            value={shots}
            options={SHOT_OPTIONS.map((s) => ({ value: s, label: s }))}
            onChange={setShots}
          />
        </div>

        <div className="w-56">
          <Slider
            label="Readout noise"
            value={noise}
            min={0}
            max={0.15}
            step={0.005}
            onChange={setNoise}
            format={formatPct}
            hint="Readout error: each measured bit is flipped with this probability"
          />
        </div>

        <ButtonRow>
          <button type="button" className="btn-primary focus-ring" onClick={handleRun}>
            Run
          </button>
          <button type="button" className="btn-ghost focus-ring" onClick={handleClear}>
            Clear
          </button>
          <button
            type="button"
            className="btn-ghost focus-ring"
            onClick={handleUndo}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            className="btn-ghost focus-ring"
            onClick={handleRedo}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
        </ButtonRow>

        <div className="min-w-[240px] flex-1">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-secondary">Presets</span>
            <select
              value={presetId}
              onChange={(e) => handlePreset(e.target.value)}
              className="focus-ring w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
            >
              <option value="">Choose a circuit…</option>
              {ALL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {preset ? <p className="mt-1.5 text-[11px] text-ink-muted">{preset.blurb}</p> : null}
        </div>

        {simNotice ? (
          <p className="w-full text-xs text-q-amber-text" role="status">
            {simNotice}
          </p>
        ) : null}
        {runError ? (
          <p className="w-full text-xs text-q-rose-text" role="alert">
            {runError}
          </p>
        ) : null}

        {loadNotice ? (
          <p className="w-full text-xs text-q-amber-text" role="status">
            {loadNotice}{' '}
            <Link href="/pricing" className="focus-ring rounded font-semibold underline underline-offset-2">
              See plans
            </Link>
          </p>
        ) : null}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="card p-5">
          {result ? (
            <>
              {showTable ? (
                <>
                  <p className="mb-3 text-[13px] font-semibold text-ink-secondary">
                    Measurement outcomes
                    <span className="ml-2 font-normal text-ink-muted">
                      {result.shots.toLocaleString('en-US')} shots
                    </span>
                  </p>
                  <HistogramTable data={histogramData} total={result.shots} />
                </>
              ) : (
                <Histogram
                  data={histogramData}
                  title="Measurement outcomes"
                  total={result.shots}
                  unit="shots"
                />
              )}
              {result.approximate ? (
                // Mid-circuit measurement past what can be enumerated exactly:
                // say the chart is an estimate instead of presenting it as exact.
                <p className="mt-3 text-xs text-q-amber-text" role="status">
                  Estimate: this circuit measures and branches too much to enumerate exactly, so
                  these outcomes are averaged over {result.trajectories?.toLocaleString('en-US')}{' '}
                  sampled runs. Measuring only at the end of the circuit is always exact.
                </p>
              ) : null}
              <div className="mt-4">
                <Toggle label="Show as table" checked={showTable} onChange={setShowTable} />
              </div>
            </>
          ) : (
            <div className="grid h-full min-h-[16rem] place-items-center text-sm text-ink-muted">
              Press Run to sample this circuit.
            </div>
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-[13px] font-semibold text-ink-secondary">State inspector</h2>
          {/* The transport sits ABOVE the state it selects, and the "Step k of
              n" count it already renders is why the hardcoded pill that used to
              live in this header is gone — that pill also carried two literal
              hexes, which made it the dark theme's violet on a white card. */}
          <StepInspector
            circuit={circuit}
            frames={frames}
            finalState={finalState}
            step={stepIndex}
            onStepChange={handleStepChange}
          />
          <div className="mt-5">
            <StateInspector state={displayState} />
          </div>
        </section>
      </div>

      <section className="card mt-5 p-5">
        <h2 className="mb-3 text-[13px] font-semibold text-ink-secondary">OpenQASM 3</h2>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
                Export
              </span>
              <button type="button" className="btn-ghost focus-ring !px-3 !py-1" onClick={handleCopy}>
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <pre className="code-block max-h-64 overflow-auto">{qasm}</pre>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">
                Edit (live)
              </span>
              <button
                type="button"
                className="btn-primary focus-ring !px-3 !py-1"
                onClick={handleImportNow}
              >
                Import
              </button>
            </div>
            {/*
              This textarea always shows either the live QASM for the current
              circuit (regenerated from toQasm() whenever the circuit changes
              for a reason other than this box's own edit) or the user's
              in-progress edit. Typing debounces ~400ms, then re-parses and, if
              the result differs from the circuit on screen, applies it — same
              path Undo/Redo goes through. "Import" beside it applies
              immediately, for anyone who would rather not wait on the timer.
            */}
            <textarea
              value={qasmInput}
              onChange={(e) => handleQasmChange(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={'qubit[2] q;\nh q[0];\ncx q[0], q[1];'}
              aria-label="OpenQASM source to import"
              className="focus-ring w-full rounded border border-line bg-surface-3 p-3 font-mono text-xs text-ink"
            />
            {qasmError ? <p className="mt-2 text-xs text-q-rose-text">{qasmError}</p> : null}
            {qasmNotice ? (
              <p className="mt-2 text-xs text-q-amber-text" role="status">
                {qasmNotice}{' '}
                <Link
                  href="/pricing"
                  className="focus-ring rounded font-semibold underline underline-offset-2"
                >
                  See plans
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/*
        `result` and `noise` are passed, and that is load-bearing rather than
        tidy. SaveLoadPanel builds the reproducibility bundle, and a bundle
        assembled without them ships `"run": null`, no results.json, and a
        manifest reading `readoutNoise: 0` — which a reader takes to mean "run
        clean and unseeded" rather than "not recorded". A citation artifact
        that silently omits the very result it is citing is worse than no
        export button at all, so the wiring and the feature are the same thing.

        `seed` is deliberately NOT passed: this page runs no seeded RNG, so
        there is no seed to record and inventing one would be the same false
        provenance in the other direction. Add it here the day the page gains
        one, not before.
      */}
      <SaveLoadPanel
        circuit={circuit}
        onLoad={handleLoadCircuit}
        result={result}
        noise={noise}
        className="mt-5"
      />

      <ResearchPanel
        circuit={circuit}
        state={finalState}
        qasm={qasm}
        className="mt-5"
      />

      <ExportPanel circuit={circuit} numQubits={numQubits} className="mt-5" />
    </div>
  )
}
