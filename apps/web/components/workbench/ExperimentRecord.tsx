'use client'

import { useMemo } from 'react'
import { Histogram } from '@/components/ui/Histogram'
import type { Experiment, ExperimentStep } from '@/lib/workbench/experiments'
import { describeTarget } from '@/lib/workbench/targets'

/**
 * ExperimentRecord — the readable record: hypothesis at the top, the steps as
 * a timeline (target, circuit, result, note), the conclusion at the bottom.
 * Purely presentational: it renders whatever Experiment it is handed, whether
 * that came from the API or was built in the browser as the sample.
 */

const ACCENT_BY_KIND: Record<string, string> = {
  simulator: 'text-q-teal-text',
  'noisy-simulator': 'text-q-amber-text',
  hardware: 'text-q-rose-text',
}

const RGB_BY_KIND: Record<string, string> = {
  simulator: 'var(--q-teal-rgb)',
  'noisy-simulator': 'var(--q-amber-rgb)',
  hardware: 'var(--q-rose-rgb)',
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** The line under a counts result: shots, distinct outcomes, error rate. */
function countsSummary(step: ExperimentStep): string | null {
  if (step.result.kind !== 'counts') return null
  const r = step.result
  const outcomes = Object.keys(r.counts).length
  const parts = [`${r.shots.toLocaleString('en-US')} shots`, `${outcomes} outcome${outcomes === 1 ? '' : 's'}`]
  if (typeof r.erroredShots === 'number') {
    parts.push(`${r.erroredShots.toLocaleString('en-US')} shots (${((100 * r.erroredShots) / r.shots).toFixed(1)}%) had at least one gate error`)
  }
  if (step.seed !== null) parts.push(`seed ${step.seed}`)
  return parts.join(' · ')
}

function StepCard({ step }: { step: ExperimentStep }) {
  const label = describeTarget(step.target)
  const kind = step.target.kind
  const data = useMemo(
    () =>
      step.result.kind === 'counts'
        ? Object.entries(step.result.counts).map(([label, value]) => ({ label, value }))
        : [],
    [step.result],
  )
  const summary = countsSummary(step)
  const qasmId = `step-${step.index}-qasm`

  return (
    <li className="relative pl-8">
      {/* Timeline marker: the dot is decorative, the number is in the heading. */}
      <span
        aria-hidden="true"
        className="absolute left-0 top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface-2 text-[10px] font-bold"
        style={{ color: `rgb(${RGB_BY_KIND[kind] ?? 'var(--q-violet-rgb)'})` }}
      >
        {step.index + 1}
      </span>
      <article className="card p-5" aria-labelledby={`step-${step.index}-title`}>
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h3 id={`step-${step.index}-title`} className="text-base font-bold text-ink">
            Step {step.index + 1}
            <span className={`ml-2 pill ${ACCENT_BY_KIND[kind] ?? 'text-q-violet-text'}`} style={{ backgroundColor: `rgb(${RGB_BY_KIND[kind] ?? 'var(--q-violet-rgb)'} / 0.15)` }}>
              {label}
            </span>
          </h3>
          <time dateTime={step.at} className="text-xs text-ink-muted">
            {formatWhen(step.at)}
          </time>
        </header>

        {step.note ? <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">{step.note}</p> : null}

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-muted" id={qasmId}>
              Circuit (OpenQASM 3)
            </p>
            {/* Wide circuits scroll inside their own box, never the page. */}
            <pre
              className="focus-ring max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink"
              tabIndex={0}
              aria-labelledby={qasmId}
            >
              {step.qasm}
            </pre>
          </div>

          <div className="min-w-0">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-muted">Result</p>
            {step.result.kind === 'counts' ? (
              <div className="rounded-lg border border-line bg-surface-2 p-3">
                <Histogram data={data} total={step.result.shots} unit="shots" maxBars={16} />
                {summary ? <p className="mt-2 text-xs text-ink-muted">{summary}</p> : null}
                <CountsTable counts={step.result.counts} shots={step.result.shots} />
              </div>
            ) : (
              <HardwareJob step={step} />
            )}
          </div>
        </div>
      </article>
    </li>
  )
}

/** Exact numbers for the reader who wants them; collapsed so the chart leads. */
function CountsTable({ counts, shots }: { counts: Record<string, number>; shots: number }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return (
    <details className="mt-2">
      <summary className="focus-ring cursor-pointer rounded text-xs text-ink-secondary">Exact counts</summary>
      <div className="mt-2 max-h-48 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-muted">
              <th scope="col" className="py-1 pr-3 font-semibold">State</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Count</th>
              <th scope="col" className="py-1 font-semibold">Share</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink">
            {rows.map(([state, n]) => (
              <tr key={state}>
                <td className="py-0.5 pr-3">{state}</td>
                <td className="py-0.5 pr-3">{n.toLocaleString('en-US')}</td>
                <td className="py-0.5">{((100 * n) / shots).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function HardwareJob({ step }: { step: ExperimentStep }) {
  if (step.result.kind !== 'hardware-job') return null
  const r = step.result
  const jobId = r.job && typeof r.job.job_id === 'string' ? r.job.job_id : null
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink-secondary">
      <p>
        Submitted to <span className="font-mono text-ink">{r.backend}</span>
        {r.provider ? ` via ${r.provider}` : ''} for {r.shots.toLocaleString('en-US')} shots (HTTP {r.status}).
      </p>
      {jobId ? (
        <p className="mt-1">
          Job <span className="font-mono text-ink">{jobId}</span> — counts are not stored here; poll the job from{' '}
          <a href="/hardware" className="focus-ring rounded underline">
            /hardware
          </a>
          .
        </p>
      ) : (
        <p className="mt-1">The route returned no job id; see the raw response below.</p>
      )}
      <details className="mt-2">
        <summary className="focus-ring cursor-pointer rounded text-xs">Raw response</summary>
        <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs">{JSON.stringify(r.job, null, 2)}</pre>
      </details>
    </div>
  )
}

/**
 * The record as the API serves it: no account id, only whether a signed-in
 * account wrote it. The in-browser sample (a full Experiment with a null owner)
 * is accepted too.
 */
export type RecordExperiment = Omit<Experiment, 'owner'> & { owner?: string | null; signedInAuthor?: boolean }

export function ExperimentRecord({ experiment, storageNote }: { experiment: RecordExperiment; storageNote?: string }) {
  const concluded = experiment.conclusion !== null
  return (
    <div>
      <header className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`pill border ${concluded ? 'border-q-teal/30 bg-q-teal/15 text-q-teal-text' : 'border-q-amber/30 bg-q-amber/15 text-q-amber-text'}`}
          >
            {concluded ? 'Concluded' : 'Open — no conclusion yet'}
          </span>
          <span className="text-xs text-ink-muted">
            {experiment.steps.length} step{experiment.steps.length === 1 ? '' : 's'} · started{' '}
            <time dateTime={experiment.createdAt}>{formatWhen(experiment.createdAt)}</time>
            {(experiment.signedInAuthor ?? Boolean(experiment.owner)) ? ' · signed-in author' : ' · anonymous author'}
          </span>
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink md:text-4xl">{experiment.title}</h1>
        <p className="mt-1 font-mono text-xs text-ink-muted">id {experiment.id}</p>
        {storageNote ? <p className="mt-2 text-xs text-ink-muted">{storageNote}</p> : null}
      </header>

      <section className="card mb-8 p-6" aria-labelledby="hypothesis-title">
        <p className="section-label">Hypothesis</p>
        <h2 id="hypothesis-title" className="sr-only">
          Hypothesis
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink">{experiment.hypothesis}</p>
      </section>

      <section aria-labelledby="steps-title">
        <p className="section-label">Steps</p>
        <h2 id="steps-title" className="sr-only">
          Steps
        </h2>
        {experiment.steps.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No steps recorded yet.</p>
        ) : (
          <ol className="relative mt-3 space-y-4">
            {/* The timeline rail. Decorative; the numbers carry the order. */}
            <div aria-hidden="true" className="absolute bottom-3 left-[9px] top-3 w-px bg-line" />
            {experiment.steps.map((step) => (
              <StepCard key={step.index} step={step} />
            ))}
          </ol>
        )}
      </section>

      <section className="card mt-8 p-6" aria-labelledby="conclusion-title">
        <p className="section-label">Conclusion</p>
        <h2 id="conclusion-title" className="sr-only">
          Conclusion
        </h2>
        {concluded ? (
          <>
            <p className="mt-2 text-[15px] leading-relaxed text-ink">{experiment.conclusion}</p>
            {experiment.concludedAt ? (
              <p className="mt-2 text-xs text-ink-muted">
                Written <time dateTime={experiment.concludedAt}>{formatWhen(experiment.concludedAt)}</time>
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-ink-muted">
            Not written yet. The agent calls <code className="font-mono">conclude_experiment</code> when it is done; until then
            new steps can still be appended.
          </p>
        )}
      </section>
    </div>
  )
}
