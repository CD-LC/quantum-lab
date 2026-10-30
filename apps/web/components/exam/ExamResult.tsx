'use client'

/**
 * ExamResult — the screen a candidate spends the most time on.
 *
 * Two deliberate choices, both unchanged. A failed exam is amber, not rose: it
 * is a result, not an error, and colouring it like a stack trace would be both
 * inaccurate and unkind. And the full review is always shown, pass or fail —
 * the explanations are the most valuable thing the exam produces, and hiding
 * them behind a failure would waste them on everyone who passed.
 *
 * ── The certificate section is where this file changed ──────────────────────
 *
 * It used to draw a certificate the moment a name was typed, with a number that
 * was a hash of that name. Anyone could produce the same number for any name in
 * one line of JavaScript, and nothing anywhere could check one.
 *
 * Now the button posts to `/api/exams/<id>/certificate` and the server decides:
 * it must hold a submitted, passed attempt, owned by a Supabase-verified
 * account. What comes back is a random id it has written down, and
 * `/verify/<id>` resolves it. That is the difference between a picture of a
 * certificate and a certificate.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Certificate } from '@/components/lesson/Certificate'
import { authFetch } from '@/lib/authFetch'
import { TRACKS, getLesson } from '@/lib/lessons'
import type { Exam, ExamResultPayload } from '@/lib/exams/types'
import { QuestionCard } from './QuestionCard'
import { SignInLink } from '@/components/auth/SignInLink'

interface ExamResultProps {
  exam: Exam
  result: ExamResultPayload
  /** Set when the paper was closed by the server rather than by the candidate. */
  notice?: string | null
  onRetry: () => void
  /** Called with the new certificate id once one has been issued. */
  onCertificate?: (certificateId: string) => void
}

const RING = 54
const CIRCUMFERENCE = 2 * Math.PI * RING

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export function ExamResult({ exam, result, notice, onRetry, onCertificate }: ExamResultProps) {
  const [name, setName] = useState('')
  const [certificateId, setCertificateId] = useState<string | null>(result.certificateId ?? null)
  const [issuedName, setIssuedName] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [certError, setCertError] = useState<string | null>(null)

  const hue = result.passed ? 'var(--q-teal)' : 'var(--q-amber)'
  const hueBorder = result.passed
    ? 'rgb(var(--q-teal-rgb) / 0.4)'
    : 'rgb(var(--q-amber-rgb) / 0.4)'
  const hueLight = result.passed ? 'var(--q-teal-text)' : 'var(--q-amber-text)'

  const correctCount = result.review.filter((g) => g.correct).length
  const questionCount = result.review.length

  /** How many more questions, at the average weight, would have cleared the bar. */
  const shortfall = useMemo(() => {
    if (result.passed || result.total === 0) return 0
    const needed = exam.passMark * result.total - result.earned
    const averagePoints = result.total / Math.max(1, questionCount)
    return Math.max(1, Math.ceil(needed / averagePoints))
  }, [result, exam.passMark, questionCount])

  const missesByLesson = useMemo(() => {
    const counts = new Map<string, number>()
    for (const g of result.review) {
      if (g.correct) continue
      counts.set(g.lessonSlug, (counts.get(g.lessonSlug) ?? 0) + 1)
    }
    return counts
  }, [result.review])

  const trackLessonCount =
    TRACKS.find((track) => track.id === exam.trackId)?.lessonSlugs.length ?? questionCount

  const dash = result.total > 0 ? (result.earned / result.total) * CIRCUMFERENCE : 0

  async function issueCertificate(): Promise<void> {
    setIssuing(true)
    setCertError(null)
    try {
      const res = await authFetch(`/api/exams/${encodeURIComponent(exam.id)}/certificate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: result.attemptId, name }),
      })
      const body = (await res.json()) as Record<string, unknown>
      if (!res.ok) {
        setCertError(
          typeof body.error === 'string'
            ? body.error
            : 'The certificate could not be issued. Try again in a moment.'
        )
        return
      }
      const cert = body.certificate as { id: string; name?: string }
      setCertificateId(cert.id)
      setIssuedName(cert.name ?? name)
      onCertificate?.(cert.id)
    } catch {
      setCertError('Could not reach the certificate service. Try again in a moment.')
    } finally {
      setIssuing(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* The server closed this paper rather than the candidate. Said plainly:
          a candidate who clicked Submit and got a score computed from an
          earlier snapshot of their answers is owed an explanation. */}
      {notice ? (
        <p className="card border-q-amber/50 p-4 text-[13px] leading-relaxed text-q-amber-text" role="status">
          {notice}
        </p>
      ) : null}

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section
        className="card p-6 md:p-8"
        style={{ borderColor: hueBorder }}
        aria-label="Exam result"
      >
        <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="section-label" style={{ color: hueLight }}>
              {result.passed ? 'Passed' : 'Not passed'}
            </p>
            <h1 className="section-title mt-2 text-3xl md:text-4xl" style={{ color: hueLight }}>
              {percent(result.score)}
            </h1>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-secondary">
              {result.passed ? (
                <>
                  Congratulations — you have earned the {exam.title}. You scored {correctCount} of{' '}
                  {questionCount} questions correct ({result.earned} of {result.total} points),
                  clear of the {percent(exam.passMark)} pass mark.
                </>
              ) : (
                <>
                  You scored {result.earned} of {result.total} points across {questionCount}{' '}
                  questions. The pass mark is {percent(exam.passMark)} — roughly {shortfall} more{' '}
                  {shortfall === 1 ? 'question' : 'questions'} would have cleared it. The full
                  review below explains every item, and a retake draws a fresh paper.
                </>
              )}
            </p>
            <p className="mt-3 text-[12px] text-ink-muted">
              Time taken {formatDuration(result.timeSpentMs)} · {correctCount}/{questionCount}{' '}
              correct · graded on our server
            </p>
          </div>

          {/* Single-series donut: earned of total, one hue. */}
          <div className="shrink-0 self-center">
            <svg
              width="140"
              height="140"
              viewBox="0 0 140 140"
              role="img"
              aria-label={`${result.earned} of ${result.total} points earned`}
            >
              <circle
                cx="70"
                cy="70"
                r={RING}
                fill="none"
                stroke="var(--surface-3)"
                strokeWidth="14"
              />
              <circle
                cx="70"
                cy="70"
                r={RING}
                fill="none"
                stroke={hue}
                strokeWidth="14"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
                transform="rotate(-90 70 70)"
              />
              <text
                x="70"
                y="66"
                textAnchor="middle"
                fill="var(--ink)"
                fontSize="24"
                fontWeight="700"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
              >
                {result.earned}
              </text>
              <text
                x="70"
                y="88"
                textAnchor="middle"
                fill="var(--ink-secondary)"
                fontSize="13"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
              >
                of {result.total} pts
              </text>
            </svg>
          </div>
        </div>
      </section>

      {/* ── Certificate, on a pass ──────────────────────────────────── */}
      {result.passed && result.certifiable ? (
        <section className="card p-6" aria-label="Your certificate">
          <h2 className="section-title text-xl">Your certificate</h2>
          {certificateId ? (
            <>
              <p className="section-desc mt-1.5">
                Issued and recorded. Anyone can check this number at{' '}
                <Link href={`/verify/${certificateId}`} className="focus-ring underline">
                  /verify/{certificateId}
                </Link>
                , which confirms the name, the exam and the date and discloses nothing else.
              </p>
              <div className="mt-6">
                <Certificate
                  name={issuedName ?? name}
                  trackName={exam.title}
                  completedAt={result.submittedAt}
                  lessonCount={trackLessonCount}
                  id={certificateId}
                />
              </div>
            </>
          ) : (
            <>
              <p className="section-desc mt-1.5">
                Type the name you would like on it. The name is yours to state and is recorded as
                given; the certificate number is issued by our server against this attempt, and is
                the part a third party can check.
              </p>
              <div className="mt-4 max-w-sm">
                <label
                  htmlFor="cert-name"
                  className="block text-[12px] font-semibold text-ink-secondary"
                >
                  Name on certificate
                </label>
                <input
                  id="cert-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ada Lovelace"
                  maxLength={60}
                  className="focus-ring mt-1.5 w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-muted"
                />
                <p className="mt-2 text-[12px] text-ink-muted">
                  This cannot be changed once issued.
                </p>
              </div>
              {certError ? (
                <p className="mt-3 text-[13px] text-q-rose-text" role="alert">
                  {certError}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => void issueCertificate()}
                disabled={issuing || name.trim().length < 2}
                className="btn-primary focus-ring mt-4 disabled:opacity-40"
              >
                {issuing ? 'Issuing…' : 'Issue my certificate'}
              </button>
            </>
          )}
        </section>
      ) : null}

      {result.passed && !result.certifiable ? (
        <section className="card border-q-amber/40 p-6" aria-label="About this pass">
          <h2 className="section-title text-xl">This pass is not certified</h2>
          <p className="section-desc mt-1.5 max-w-2xl">
            You sat this anonymously, so there is no account to name on a certificate. The grading
            was identical and the review below is complete. Sign in and sit it again to earn the
            credential.
          </p>
          <SignInLink className="btn-primary focus-ring mt-4 inline-block" />
        </section>
      ) : null}

      {/* ── Where to focus, on a fail ───────────────────────────────── */}
      {!result.passed && result.weakLessons.length > 0 ? (
        <section aria-label="Where to focus">
          <h2 className="section-title text-xl">Where to focus</h2>
          <p className="section-desc mt-1.5">
            Ordered by how many questions you missed from each lesson.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {result.weakLessons.map((slug) => {
              const missed = missesByLesson.get(slug) ?? 0
              const lesson = getLesson(slug)
              return (
                <Link
                  key={slug}
                  href={`/learn/${slug}`}
                  className="card card-hover focus-ring block p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-sm font-bold text-ink">{lesson?.title ?? slug}</span>
                    <span className="pill shrink-0 border-q-amber/60 text-q-amber-text">
                      {missed} missed
                    </span>
                  </div>
                  {lesson ? (
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
                      {lesson.subtitle}
                    </p>
                  ) : null}
                </Link>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* ── Full review ─────────────────────────────────────────────── */}
      <section aria-label="Question review">
        <h2 className="section-title text-xl">Review every question</h2>
        <p className="section-desc mt-1.5">
          Your answer, the correct answer, and why — for all {questionCount} questions.
        </p>
        <div className="mt-4 space-y-4">
          {result.review.map((g, index) => (
            <QuestionCard
              key={g.id}
              question={g}
              index={index}
              total={questionCount}
              answer={result.answers[g.id]}
              onChange={() => undefined}
              reviewMode
              graded={g}
            />
          ))}
        </div>
      </section>

      {/* ── Retake ──────────────────────────────────────────────────── */}
      <section className="card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-base font-bold text-ink">Want another go?</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            A new attempt draws a different set of questions from the pool, in a different order.
            Your best score is kept.
            {result.retakeAvailableAt
              ? ` After a paper that does not pass there is a short wait: you can sit again from ${new Date(result.retakeAvailableAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
              : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRetry} className="btn-ghost focus-ring">
            Retake exam
          </button>
          <Link href="/certify" className="btn-ghost focus-ring">
            All certifications
          </Link>
        </div>
      </section>
    </div>
  )
}

export default ExamResult
