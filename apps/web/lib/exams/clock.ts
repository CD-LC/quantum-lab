/**
 * clock.ts — the bits of the exam clock that both sides may hold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CLIENT CLOCK IS ADVISORY. IT DECIDES NOTHING.
 *
 * Everything in this file runs in the browser as well as on the server, and in
 * the browser it exists for one purpose: to show the candidate a number and to
 * stop them typing into a paper whose time is gone. It is not a control.
 * `Date.now()` in a browser is whatever the operating system says it is, and a
 * candidate who wants more time can simply set their machine's clock back.
 *
 * The clock that DECIDES is the server's, and it decides in exactly two places:
 *
 *   · `ServerAttempt.expiresAt` is stamped from the server's clock when the
 *     attempt is created, and never recomputed.
 *   · `lib/exams/service.ts` compares `Date.now()` on the SERVER against that
 *     stamp before accepting an answer or a submission, and refuses a late one
 *     (`SUBMIT_GRACE_MS` below is the only allowance, and it is for the
 *     network, not for the candidate).
 *
 * A future editor removing the server-side check because "the client already
 * counts down" would reintroduce the exact hole this replaced. Do not.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { AnswerState, PaperQuestion, QuestionKind } from './types'

/**
 * Slack allowed on a submission that arrives after the deadline.
 *
 * 3 seconds, and the number is a round trip budget, not generosity: the
 * candidate clicks at T−0.2s, the browser serialises up to 15 answers, and the
 * request crosses a network. Measured against nothing more exotic than "a
 * mobile connection can add two seconds"; if you widen it, widen it for a
 * measured reason and say what you measured. It is deliberately far below the
 * value of one exam question's worth of thinking time.
 */
export const SUBMIT_GRACE_MS = 3_000

/** Milliseconds left before `deadlineIso`, floored at zero. */
export function remainingMs(deadlineIso: string, now: number): number {
  const deadline = new Date(deadlineIso).getTime()
  if (Number.isNaN(deadline)) return 0
  return Math.max(0, deadline - now)
}

/** True when `now` is past the deadline. No grace: grace is a server concept. */
export function isExpired(deadlineIso: string, now: number): boolean {
  return remainingMs(deadlineIso, now) <= 0
}

/**
 * True when `now` is past the deadline by more than the network allowance.
 * SERVER-SIDE MEANING ONLY — a browser calling this is telling itself a story.
 */
export function isLate(deadlineIso: string, now: number): boolean {
  const deadline = new Date(deadlineIso).getTime()
  if (Number.isNaN(deadline)) return true
  return now > deadline + SUBMIT_GRACE_MS
}

/**
 * How far the browser's clock is ahead of the server's, in milliseconds.
 *
 * `expiresAt` is a server stamp. Comparing it against a raw `Date.now()` in the
 * browser made the countdown only as good as the candidate's system clock: a
 * device five minutes fast auto-submitted a 25-minute paper at minute 20, and
 * one five minutes slow showed time left while the server was already refusing
 * answers. The attempt payload now carries `serverNow`; the runner takes this
 * offset once per adopt and subtracts it from every subsequent `Date.now()`.
 *
 * Unparseable input gives 0 — the old behaviour, not a NaN countdown. The
 * network delay between the server stamping `serverNow` and the browser reading
 * it is absorbed into the offset (it reads as the client being slightly fast),
 * which errs towards submitting a few hundred milliseconds early rather than
 * late; the server's `SUBMIT_GRACE_MS` covers the other direction.
 */
export function clockOffsetMs(serverNowIso: string | undefined, clientNow: number): number {
  if (typeof serverNowIso !== 'string') return 0
  const server = Date.parse(serverNowIso)
  if (Number.isNaN(server)) return 0
  return clientNow - server
}

/**
 * How long a subject waits after a FAILED paper before the server deals them
 * another at the same exam. Long enough that "answer everything, read the key,
 * start again" cannot be looped ten times a minute to harvest the bank; short
 * enough that a candidate who failed by a question can revise the lesson the
 * review named and sit again the same afternoon. A pass is never delayed.
 */
export const RETAKE_COOLDOWN_MS = 15 * 60_000

/**
 * ISO time from which a fresh paper may be dealt after a closed attempt, or
 * undefined when there is no wait (a pass, an open paper, or unparseable input).
 */
export function retakeAvailableAt(
  submittedAtIso: string | undefined,
  passed: boolean | undefined
): string | undefined {
  if (!submittedAtIso || passed !== false) return undefined
  const submitted = Date.parse(submittedAtIso)
  if (Number.isNaN(submitted)) return undefined
  return new Date(submitted + RETAKE_COOLDOWN_MS).toISOString()
}

/** "12:04", or "0:59". Kept here so the runner and the result agree. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

/**
 * True when the candidate has supplied something gradeable.
 *
 * Takes a kind rather than a whole question so the browser can call it on a
 * `PaperQuestion` and the grader can call it on an `ExamQuestion`.
 */
export function isAnsweredKind(kind: QuestionKind, a: AnswerState | undefined): boolean {
  if (!a) return false
  if (kind === 'numeric') {
    return typeof a.numberValue === 'number' && Number.isFinite(a.numberValue)
  }
  return a.selectedIds.length > 0
}

/** Convenience wrapper for the runner, which holds `PaperQuestion`s. */
export function isAnswered(q: PaperQuestion, a: AnswerState | undefined): boolean {
  return isAnsweredKind(q.kind, a)
}
