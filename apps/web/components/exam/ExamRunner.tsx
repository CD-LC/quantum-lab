'use client'

/**
 * ExamRunner — the sitting itself.
 *
 * ── What changed, and why the old invariant had to go ───────────────────────
 *
 * This component used to hold the whole exam: it imported the question bank
 * (answers included), reconstructed the paper from a seed, ran the clock,
 * graded the paper and wrote the result to localStorage. Every one of those is
 * now a server responsibility, and this file is a view over four fetches:
 *
 *   GET  /api/exams/<id>/attempt      → what is my situation
 *   POST /api/exams/<id>/attempt      → start (or resume) a paper
 *   PUT  /api/exams/<id>/answers      → persist answers as they are given
 *   POST /api/exams/<id>/submit       → grade
 *
 * The paper arrives WITHOUT correct answers and WITHOUT explanations. There is
 * nothing in this component's memory that a devtools console could read to
 * learn an answer, and nothing it writes that a devtools console could edit to
 * fake a pass.
 *
 * THE CLOCK ON SCREEN IS ADVISORY. It is drawn from `attempt.expiresAt`, an
 * ISO stamp the server made, against the browser's own `Date.now()` — a clock
 * the candidate controls. Setting it back buys nothing: the server compares its
 * own clock on every write and refuses a late one (see lib/exams/clock.ts).
 * What this countdown is for is telling an honest candidate how long they have.
 *
 * ── Accessibility that must survive any future edit ─────────────────────────
 *
 * The threshold announcements, the non-live `role="timer"`, the aria-hidden
 * digits and the navigator's per-button labels are all WCAG fixes from an
 * earlier audit (findings 7 and 18). They are preserved verbatim below and
 * their reasoning is inline. Do not "simplify" them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { authFetch } from '@/lib/authFetch'
import { clockOffsetMs, formatClock, isAnswered, remainingMs } from '@/lib/exams/clock'
// A11Y: the countdown is deliberately NOT a live region (see the threshold
// effect below) — a per-second announcement makes the paper unusable. Thresholds
// and the auto-submit are announced through the shared live regions instead.
import { announce } from '@/lib/a11y/announce'
import type {
  AnswerState,
  ClientAttempt,
  Exam,
  ExamResultPayload,
  PaperQuestion,
} from '@/lib/exams/types'
import { track } from '@/lib/analytics/track'
import { QuestionCard } from './QuestionCard'
import { ExamResult } from './ExamResult'
import { SignInLink } from '@/components/auth/SignInLink'

interface ExamRunnerProps {
  exam: Exam
}

type Phase =
  | 'loading'
  | 'idle'
  | 'answering'
  | 'confirming'
  | 'submitting'
  | 'finished'
  | 'locked'
  | 'error'

/**
 * Whole minutes remaining at which the clock speaks, descending. Anything
 * finer-grained is noise: the point is "there is less time than you think",
 * not a running commentary. 5 and below interrupt (see the effect below).
 */
const TIME_GATES_MINUTES = [30, 15, 10, 5, 2, 1] as const

/**
 * How long a keystroke or click waits before it is sent to the server.
 *
 * 700ms, chosen against the one case that matters: typing a numeric answer.
 * A PUT per character would be ~12 requests for "0.70710678"; a debounce this
 * long collapses that to one and still lands the write long before a candidate
 * can move to the next question. The submit body carries the full answer map
 * as well, so a debounce that is still pending when the paper is submitted
 * costs nothing.
 */
const SYNC_DEBOUNCE_MS = 700

interface LockedInfo {
  status: number
  message: string
  requiredPlan?: string
}

export function ExamRunner({ exam }: ExamRunnerProps) {
  const [attempt, setAttempt] = useState<ClientAttempt | null>(null)
  const [paper, setPaper] = useState<PaperQuestion[]>([])
  const [result, setResult] = useState<ExamResultPayload | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [index, setIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  /**
   * How far this device's clock is ahead of the server's (ms), measured once
   * per adopt from the attempt's `serverNow`. Every countdown below uses
   * `now - clockOffset`, so a skewed system clock cannot shorten or lengthen
   * the sitting relative to the deadline the server enforces.
   */
  const [clockOffset, setClockOffset] = useState(0)
  const [locked, setLocked] = useState<LockedInfo | null>(null)
  const [durable, setDurable] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)

  /** Latest answers, for the debounced sync and the submit flush. */
  const answersRef = useRef<Record<string, AnswerState>>({})
  const syncTimer = useRef<number | null>(null)
  /** Guards the submit path against a double click and the expiry effect. */
  const submittingRef = useRef(false)

  /**
   * A11Y (WCAG 4.1.3, audit finding 7): the highest whole-minute threshold that
   * has already been spoken. The clock re-renders once a second and React may
   * re-run an effect for reasons of its own, so "have I already said this?" has
   * to be state that survives a render — hence a ref, not a comparison against
   * the previous `left`. Reset only when a NEW attempt starts.
   */
  const lastAnnouncedGateRef = useRef<number | null>(null)

  const base = `/api/exams/${encodeURIComponent(exam.id)}`

  /** Turn a non-OK response into the right screen. Never throws. */
  const handleFailure = useCallback(async (res: Response): Promise<void> => {
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      // A response with no JSON body is still a failure with a status.
    }
    const message =
      typeof body.error === 'string'
        ? body.error
        : 'Something went wrong talking to the exam service. Try again in a moment.'

    if (res.status === 402 || res.status === 401) {
      setLocked({
        status: res.status,
        message,
        requiredPlan: typeof body.requiredPlan === 'string' ? body.requiredPlan : undefined,
      })
      setPhase('locked')
      return
    }
    setNotice(message)
    setPhase('error')
  }, [])

  const adopt = useCallback((body: Record<string, unknown>): void => {
    const state = body.state
    if (typeof body.durable === 'boolean') setDurable(body.durable)

    if (state === 'open') {
      const open = body.attempt as ClientAttempt
      answersRef.current = open.answers ?? {}
      setClockOffset(clockOffsetMs(open.serverNow, Date.now()))
      setNow(Date.now())
      setAttempt(open)
      setPaper((body.paper as PaperQuestion[]) ?? [])
      setResult(null)
      setPhase('answering')
      return
    }
    if (state === 'submitted') {
      setResult(body.result as ExamResultPayload)
      setAttempt(null)
      setPaper([])
      setPhase('finished')
      return
    }
    setAttempt(null)
    setPaper([])
    setResult(null)
    setPhase('idle')
  }, [])

  // ── Mount: ask the server where we stand ──────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await authFetch(`${base}/attempt`, { cache: 'no-store' })
        if (cancelled) return
        if (!res.ok) {
          await handleFailure(res)
          return
        }
        adopt((await res.json()) as Record<string, unknown>)
      } catch {
        if (cancelled) return
        setNotice('Could not reach the exam service. Check your connection and reload.')
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, adopt, handleFailure])

  // ── Starting ──────────────────────────────────────────────────────
  const start = useCallback(async () => {
    setPhase('loading')
    setNotice(null)
    lastAnnouncedGateRef.current = null
    submittingRef.current = false
    setIndex(0)
    try {
      const res = await authFetch(`${base}/attempt`, { method: 'POST' })
      if (!res.ok) {
        await handleFailure(res)
        return
      }
      const body = (await res.json()) as Record<string, unknown>
      adopt(body)
      setNow(Date.now())
      // 201 means the server CREATED an attempt. A 200 here is a resume — a
      // double-clicked Begin, or a retried request — and counting that as a
      // start would inflate the funnel, which is the analytics equivalent of
      // the localStorage double-mount bug this replaced.
      if (res.status === 201) {
        track('exam.started', {
          examId: exam.id,
          questionCount: ((body.paper as PaperQuestion[]) ?? []).length,
        })
      }
    } catch {
      setNotice('Could not start the exam. Check your connection and try again.')
      setPhase('error')
    }
  }, [base, adopt, handleFailure, exam.id])

  // ── Answer sync ───────────────────────────────────────────────────
  const flush = useCallback(async (): Promise<void> => {
    if (!attempt) return
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current)
      syncTimer.current = null
    }
    try {
      await authFetch(`${base}/answers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: attempt.id, answers: answersRef.current }),
      })
      // A failed or refused sync is not surfaced here: the submit body carries
      // the same answers, and interrupting a candidate mid-question with a
      // network warning they cannot act on is worse than the risk it flags.
      // A late PUT is refused server-side, which the submit path then reports.
    } catch {
      // Same reasoning.
    }
  }, [attempt, base])

  const handleChange = useCallback(
    (next: AnswerState) => {
      answersRef.current = { ...answersRef.current, [next.questionId]: next }
      setAttempt((prev) => (prev ? { ...prev, answers: answersRef.current } : prev))
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
      syncTimer.current = window.setTimeout(() => {
        syncTimer.current = null
        void flush()
      }, SYNC_DEBOUNCE_MS)
    },
    [flush]
  )

  useEffect(
    () => () => {
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current)
    },
    []
  )

  // ── Submitting ────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    if (!attempt || submittingRef.current) return
    submittingRef.current = true
    setPhase('submitting')
    try {
      const res = await authFetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: attempt.id, answers: answersRef.current }),
      })
      const body = (await res.json()) as Record<string, unknown>

      // 409 is the late submission. The server graded the paper against what it
      // had at the deadline and sent the marks with the refusal, so the
      // candidate sees a result rather than an error with no way forward.
      if (res.status === 409 && body.result) {
        setNotice(typeof body.error === 'string' ? body.error : null)
        setResult(body.result as ExamResultPayload)
        setPhase('finished')
        return
      }
      if (!res.ok) {
        submittingRef.current = false
        await handleFailure(res)
        return
      }
      const payload = body.result as ExamResultPayload
      setResult(payload)
      setPhase('finished')
      track('exam.completed', { examId: exam.id, score: payload.score, passed: payload.passed })
    } catch {
      submittingRef.current = false
      setNotice('Could not submit. Your answers are saved — try again.')
      setPhase('error')
    }
  }, [attempt, base, handleFailure, exam.id])

  // ── The clock ─────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'answering' && phase !== 'confirming') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  const left = attempt ? remainingMs(attempt.expiresAt, now - clockOffset) : 0

  useEffect(() => {
    if (!attempt) return
    if (phase !== 'answering' && phase !== 'confirming') return
    if (left > 0) return
    // A11Y: the paper submitting itself is the single most surprising thing
    // that can happen in this UI, and until an earlier audit it happened in
    // silence. Assertive: it interrupts, because the sitting is over either way.
    announce('Time is up. Your paper has been submitted for grading.', 'assertive')
    void submit()
  }, [left, attempt, phase, submit])

  /**
   * A11Y (WCAG 4.1.3 / 2.2.1, audit finding 7): a sighted candidate watches the
   * clock and sees it turn amber at 5 minutes and rose at 1. A screen-reader
   * user got nothing at all, then the paper submitted itself.
   *
   * The countdown is NOT made a live region: announcing "24:59, 24:58, …" once a
   * second would drown out the question and make the exam unsittable. Instead
   * only these thresholds speak, at most once each per attempt, and only the
   * last two interrupt.
   */
  useEffect(() => {
    if (phase !== 'answering' && phase !== 'confirming') return
    if (left <= 0) return
    const minutes = Math.ceil(left / 60_000)
    const gate = TIME_GATES_MINUTES.find((g) => g === minutes)
    if (gate === undefined) return
    // Ticking is monotonic, so "the last gate spoken" is a complete record of
    // what has been said; a re-render at the same minute cannot repeat it.
    if (lastAnnouncedGateRef.current === gate) return
    lastAnnouncedGateRef.current = gate
    announce(
      `${gate} ${gate === 1 ? 'minute' : 'minutes'} remaining in this exam.`,
      gate <= 5 ? 'assertive' : 'polite'
    )
  }, [left, phase])

  const answeredCount = useMemo(
    () => (attempt ? paper.filter((q) => isAnswered(q, attempt.answers[q.id])).length : 0),
    [paper, attempt]
  )
  const flaggedCount = useMemo(
    () => (attempt ? paper.filter((q) => attempt.answers[q.id]?.flagged === true).length : 0),
    [paper, attempt]
  )

  // ── Screens that are not the paper ────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="card p-8 text-center text-sm text-ink-secondary" role="status">
        Preparing your paper…
      </div>
    )
  }

  if (phase === 'locked' && locked) {
    return (
      <section className="card p-8">
        <p className="section-label">Certification exam</p>
        <h1 className="section-title mt-1 text-2xl">{exam.title}</h1>
        <p className="section-desc mt-3 max-w-2xl">{exam.subtitle}</p>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-secondary">{locked.message}</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {locked.status === 402 ? (
            <Link href="/pricing" className="btn-primary focus-ring">
              See plans
            </Link>
          ) : (
            <SignInLink className="btn-primary focus-ring" />
          )}
          <Link href="/certify" className="btn-ghost focus-ring">
            All certifications
          </Link>
        </div>
      </section>
    )
  }

  if (phase === 'error') {
    return (
      <section className="card border-q-rose/50 p-6" role="alert">
        <h1 className="text-base font-bold text-ink">The exam service did not answer</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
          {notice ?? 'Try again in a moment.'}
        </p>
        <button type="button" onClick={() => window.location.reload()} className="btn-primary focus-ring mt-4">
          Reload
        </button>
      </section>
    )
  }

  if (phase === 'finished' && result) {
    return (
      <ExamResult
        exam={exam}
        result={result}
        notice={notice}
        onRetry={() => {
          setNotice(null)
          void start()
        }}
        onCertificate={(cert) => setResult((prev) => (prev ? { ...prev, certificateId: cert } : prev))}
      />
    )
  }

  if (phase === 'idle' || !attempt) {
    return (
      <section className="card p-6 md:p-8">
        <p className="section-label">Certification exam</p>
        <h1 className="section-title mt-1 text-2xl">{exam.title}</h1>
        <p className="section-desc mt-3 max-w-2xl">{exam.subtitle}</p>
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
          <Fact label="Questions" value={String(exam.questionCount)} />
          <Fact label="Time limit" value={`${exam.timeLimitMinutes} min`} />
          <Fact label="Pass mark" value={`${Math.round(exam.passMark * 100)}%`} />
        </dl>
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-secondary">
          {/* The clock starts on the click, not on the page load. Stated here
              because the server stamps the deadline at that moment and will not
              move it afterwards. */}
          The clock starts when you press Begin and is kept by our server, so closing the tab does
          not pause it. Your answers are saved as you go and the paper resumes on any device you
          are signed in on.
        </p>
        {!durable ? <DurabilityWarning /> : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => void start()} className="btn-primary focus-ring">
            Begin exam
          </button>
          <Link href="/certify" className="btn-ghost focus-ring">
            All certifications
          </Link>
        </div>
      </section>
    )
  }

  const current = paper[index]
  const total = paper.length
  const unanswered = total - answeredCount
  const timerTone =
    left < 60_000 ? 'text-q-rose-text' : left < 5 * 60_000 ? 'text-q-amber-text' : 'text-ink'

  return (
    <div className="space-y-5">
      {/* ── Header: title, clock, progress ──────────────────────────── */}
      <header className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="section-label">Certification exam</p>
            <h1 className="section-title mt-1 text-xl">{exam.title}</h1>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
              Time remaining
            </p>
            {/* A11Y: the element stays a `timer` so the role is discoverable,
                but it never speaks — aria-live="off", and the digits themselves
                are aria-hidden so a screen reader that walks the page does not
                read a number that is stale by the time it finishes. The spoken
                channel is the threshold effect above. */}
            <p
              className={`font-mono text-2xl font-bold tabular-nums ${timerTone}`}
              role="timer"
              aria-live="off"
              aria-label="Time remaining"
            >
              <span aria-hidden="true">{formatClock(left)}</span>
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
            <span>
              {answeredCount} / {total} answered
            </span>
            <span>Pass mark {Math.round(exam.passMark * 100)}%</span>
          </div>
          <div
            className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={answeredCount}
            aria-label="Questions answered"
          >
            <div
              className="h-full rounded-full bg-q-violet transition-[width] duration-300"
              style={{ width: total > 0 ? `${(answeredCount / total) * 100}%` : '0%' }}
            />
          </div>
        </div>

        {/* ── Navigator strip ──────────────────────────────────────── */}
        <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Question navigator">
          {paper.map((q, i) => {
            const state = attempt.answers[q.id]
            const done = isAnswered(q, state)
            const flagged = state?.flagged === true
            const tone = flagged
              ? 'border-q-amber/60 bg-q-amber/15 text-q-amber-text'
              : done
                ? 'border-q-violet/60 bg-q-violet/15 text-q-violet-text'
                : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong'
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === index ? 'true' : undefined}
                aria-label={`Question ${i + 1}${done ? ', answered' : ''}${flagged ? ', flagged' : ''}`}
                className={`focus-ring h-7 w-7 rounded-md border text-[11px] font-bold transition-colors duration-150 ${tone} ${
                  i === index ? 'ring-2 ring-q-violet ring-offset-2 ring-offset-bg' : ''
                }`}
              >
                {i + 1}
              </button>
            )
          })}
        </nav>

        {!attempt.certifiable ? (
          <p className="mt-4 rounded-card border border-q-amber/40 bg-surface-2 p-3 text-[12px] leading-relaxed text-q-amber-text">
            You are sitting this anonymously. It is graded exactly the same way, but a certificate
            names a person, so this attempt cannot become one.{' '}
            <SignInLink className="focus-ring underline" />{' '}
            and start again if you want the credential.
          </p>
        ) : null}
        {!durable ? <DurabilityWarning /> : null}
      </header>

      {/* ── The question ────────────────────────────────────────────── */}
      {current ? (
        <QuestionCard
          question={current}
          index={index}
          total={total}
          answer={attempt.answers[current.id]}
          onChange={handleChange}
        />
      ) : (
        <div className="card p-6 text-sm text-ink-secondary">
          This exam has no questions available. Please try again later.
        </div>
      )}

      {/* ── Confirm step ────────────────────────────────────────────── */}
      {phase === 'confirming' ? (
        <section className="card border-q-amber/50 p-5" aria-label="Confirm submission">
          <h2 className="text-base font-bold text-ink">Submit for grading?</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
            {unanswered === 0
              ? 'Every question is answered.'
              : `${unanswered} ${unanswered === 1 ? 'question is' : 'questions are'} unanswered, and unanswered questions are marked wrong.`}{' '}
            {flaggedCount > 0
              ? `${flaggedCount} ${flaggedCount === 1 ? 'question is' : 'questions are'} flagged for review.`
              : 'Nothing is flagged for review.'}{' '}
            You cannot change your answers after submitting.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => void submit()} className="btn-primary focus-ring">
              Yes, submit and grade
            </button>
            <button
              type="button"
              onClick={() => setPhase('answering')}
              className="btn-ghost focus-ring"
            >
              Keep working
            </button>
          </div>
        </section>
      ) : null}

      {/* ── Footer controls ─────────────────────────────────────────── */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="btn-ghost focus-ring disabled:opacity-40"
          >
            ← Previous
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
            disabled={index >= total - 1}
            className="btn-ghost focus-ring disabled:opacity-40"
          >
            Next →
          </button>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/certify"
            onClick={() => void flush()}
            className="focus-ring text-[12px] text-ink-muted hover:text-ink"
          >
            Exit
          </Link>
          <button
            type="button"
            onClick={() => {
              void flush()
              setPhase('confirming')
            }}
            disabled={phase !== 'answering'}
            className="btn-primary focus-ring disabled:opacity-40"
          >
            {phase === 'submitting' ? 'Submitting…' : 'Submit exam'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-bold text-ink">{value}</dd>
    </div>
  )
}

/**
 * Shown when the server is keeping attempts in process memory because no
 * `SUPABASE_SERVICE_ROLE_KEY` is set. Saying this to the candidate is the
 * point: they are about to spend twenty-five minutes, and on this deployment a
 * redeploy loses the paper. See the header of lib/exams/store.ts.
 */
function DurabilityWarning() {
  return (
    <p className="mt-4 rounded-card border border-q-amber/40 bg-surface-2 p-3 text-[12px] leading-relaxed text-q-amber-text">
      This deployment has no database configured for exams, so attempts are held in the server&rsquo;s
      memory and will be lost if it restarts. Grading is still done server-side, but do not rely on
      resuming a paper here.
    </p>
  )
}

export default ExamRunner
