/**
 * types.ts — the data model for the certification exam engine.
 *
 * Deliberately separate from `lib/lessons/types.ts`: a lesson quiz is a
 * teaching device that reveals its answer immediately, whereas an exam question
 * is graded in bulk at the end and carries a point weight.
 *
 * ── The one distinction that matters in this file ───────────────────────────
 *
 *   `ExamQuestion`  is the SERVER's question. It carries `correctIds` /
 *                   `correctNumber` / `tolerance` and the `explanation`.
 *                   It is only ever constructed in `questions.ts`, which
 *                   refuses to load in a browser.
 *
 *   `PaperQuestion` is the CANDIDATE's question. Structurally it cannot hold
 *                   an answer key: the fields do not exist on the type, and
 *                   `toPaperQuestion` in `engine.ts` builds it field by field
 *                   rather than by spreading, so a new key added to
 *                   `ExamQuestion` does not silently ride along.
 *
 * Anything sent to the browser during a sitting is typed `PaperQuestion`. The
 * answer key reaches the browser exactly once — in the graded review, after the
 * server has closed the attempt, and only for the questions that were on that
 * candidate's paper.
 */

import type { FeatureId } from '@/lib/plans'

export type QuestionKind = 'single' | 'multi' | 'numeric' | 'circuit-outcome'

/** An option as the candidate sees it. No correctness marker, by construction. */
export interface QuestionOption {
  id: string
  text: string
}

/** SERVER-SIDE ONLY. Never serialise one of these into a response. */
export interface ExamQuestion {
  id: string
  kind: QuestionKind
  prompt: string
  /** Optional OpenQASM shown to the candidate for circuit-outcome questions. */
  qasm?: string
  options?: QuestionOption[]
  /** single: one id. multi: several ids. numeric: a number with a tolerance. */
  correctIds?: string[]
  correctNumber?: number
  tolerance?: number
  explanation: string
  /** Which lesson this is drawn from, for the "revise this" link on failure. */
  lessonSlug: string
  points: number
}

/**
 * What the browser is given while the exam is running.
 *
 * `lessonSlug` stays: it is on the review screen anyway, and knowing a question
 * came from the entanglement lesson is not the answer to it. `points` stays
 * because the candidate is entitled to know what an item is worth.
 */
export interface PaperQuestion {
  id: string
  kind: QuestionKind
  prompt: string
  qasm?: string
  options?: QuestionOption[]
  lessonSlug: string
  points: number
}

export interface Exam {
  id: string
  title: string
  subtitle: string
  trackId: string
  level: 'Beginner' | 'Intermediate' | 'Advanced'
  /** Questions drawn per attempt from the pool. */
  questionCount: number
  /** Fraction of available points needed to pass, 0..1. */
  passMark: number
  timeLimitMinutes: number
  requiresFeature?: FeatureId
  /** Ids of the questions this exam may draw from. */
  poolIds: string[]
}

export interface AnswerState {
  questionId: string
  selectedIds: string[]
  numberValue?: number
  flagged: boolean
}

/**
 * A pre-server attempt, as it was written into localStorage before grading
 * moved server-side. Retained ONLY so `lib/exams/attempts.ts` can read the
 * archive; nothing writes this shape any more. See that file for what happens
 * to those records.
 */
export interface ExamAttempt {
  id: string
  examId: string
  /** ISO-8601. The countdown is computed from this, not from a stored counter. */
  startedAt: string
  finishedAt?: string
  seed: number
  questionIds: string[]
  answers: Record<string, AnswerState>
  score?: number
  passed?: boolean
  timeSpentMs?: number
}

// ────────────────────────────────────────────────────────────
// The server record
// ────────────────────────────────────────────────────────────

/**
 * Who an attempt belongs to.
 *
 * `user`    — a Supabase-verified account id. The only kind that can be
 *             resumed from another browser and the only kind that can be
 *             issued a certificate.
 * `guest`   — an anonymous practice session, identified by an httpOnly cookie
 *             (see `lib/exams/session.ts`). Server-graded like any other, so
 *             the answer key still never reaches the browser early, but it
 *             names nobody and therefore certifies nobody.
 */
export type SubjectKind = 'user' | 'guest'

export interface AttemptSubject {
  kind: SubjectKind
  id: string
}

/**
 * The server's record of one sitting. This is the authority for every number
 * the candidate is shown, and the only place a score is ever computed.
 *
 * `expiresAt` is stamped at creation from the server clock and never
 * recalculated, so extending an exam's time limit does not retroactively hand
 * time to attempts that are already running out.
 */
export interface ServerAttempt {
  id: string
  examId: string
  subjectKind: SubjectKind
  subjectId: string
  /** ISO-8601, server clock. */
  startedAt: string
  /** ISO-8601, server clock: startedAt + timeLimitMinutes. Immutable. */
  expiresAt: string
  /** ISO-8601, server clock, once graded. */
  submittedAt?: string
  /** How the sitting ended. Absent while it is still open. */
  closedBy?: 'candidate' | 'expiry'
  /** The paper, resolved once at creation. NOT re-derived from a seed. */
  questionIds: string[]
  answers: Record<string, AnswerState>
  /** Points earned over points available, 0..1. Server-computed, always. */
  score?: number
  passed?: boolean
  certificateId?: string
}

/** The attempt as the candidate's browser sees it. No score until submitted. */
export interface ClientAttempt {
  id: string
  examId: string
  startedAt: string
  expiresAt: string
  submittedAt?: string
  answers: Record<string, AnswerState>
  /**
   * False for a guest sitting. The runner uses it to say, before the candidate
   * spends 25 minutes, that this attempt cannot become a certificate.
   */
  certifiable: boolean
  /**
   * ISO-8601, the SERVER's clock when this body was built. The runner takes its
   * offset from the device clock once per adopt, so the countdown and the
   * auto-submit do not depend on the candidate's system time being right.
   */
  serverNow?: string
}

// ────────────────────────────────────────────────────────────
// Grading
// ────────────────────────────────────────────────────────────

export interface GradedQuestion {
  question: ExamQuestion
  correct: boolean
  earned: number
  /** What the candidate actually gave: ids, a number, or nothing at all. */
  given: string[] | number | null
}

export interface ExamGrade {
  score: number
  earned: number
  total: number
  passed: boolean
  graded: GradedQuestion[]
  /** Distinct lesson slugs of missed questions, most-missed first. */
  weakLessons: string[]
}

/**
 * One reviewed question, as sent to the browser AFTER submission.
 *
 * This is the only payload in the product that carries an answer key, and it
 * carries it for at most `exam.questionCount` items — the ones this candidate
 * actually sat — rather than for the whole bank.
 *
 * "Sat" means ANSWERED. A question the candidate left blank comes back with its
 * verdict (`correct: false`, `answered: false`) and nothing else: no
 * `correctIds`, no `correctNumber`, no `tolerance`, no `explanation`. Without
 * that rule an empty submission was a free dump of the key for fifteen bank
 * items, repeatable ten times a minute (see `toReviewQuestion` in engine.ts).
 */
export interface ReviewQuestion extends PaperQuestion {
  correct: boolean
  earned: number
  /** False when the candidate gave nothing gradeable; the key is then withheld. */
  answered: boolean
  correctIds?: string[]
  correctNumber?: number
  tolerance?: number
  /** Absent for an unanswered question. */
  explanation?: string
}

/** The graded result, as the browser receives it. */
export interface ExamResultPayload {
  attemptId: string
  examId: string
  score: number
  earned: number
  total: number
  passed: boolean
  submittedAt: string
  /** Milliseconds between the server's start stamp and its submit stamp. */
  timeSpentMs: number
  closedBy: 'candidate' | 'expiry'
  weakLessons: string[]
  review: ReviewQuestion[]
  answers: Record<string, AnswerState>
  /** Present when a certificate has been claimed for this attempt. */
  certificateId?: string
  /** True when a pass on this attempt could be turned into a certificate. */
  certifiable: boolean
  /**
   * ISO-8601, server clock. Set on a failed attempt: the moment from which the
   * server will deal this subject a fresh paper at this exam. Advisory for the
   * browser; `startAttempt` enforces it.
   */
  retakeAvailableAt?: string
}

// ────────────────────────────────────────────────────────────
// Certificates
// ────────────────────────────────────────────────────────────

export interface CertificateRecord {
  id: string
  userId: string
  examId: string
  attemptId: string
  /** Self-attested at issue, immutable afterwards. See `app/verify`. */
  displayName: string
  score: number
  issuedAt: string
}

/**
 * What `/verify/<id>` and its route hand to the public.
 *
 * The whole design constraint of this shape is what is NOT in it: no user id,
 * no email, no attempt id, no answers, and no score. It answers exactly one
 * question — did this person pass this exam on this date — because that is the
 * only question a verifier is entitled to ask.
 */
export interface CertificateVerification {
  valid: boolean
  id: string
  name?: string
  examId?: string
  examTitle?: string
  level?: Exam['level']
  issuedAt?: string
  /** Why an invalid id is invalid, in a sentence safe to show anybody. */
  reason?: string
}
