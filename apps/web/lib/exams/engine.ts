/**
 * engine.ts — the exam rules, as pure functions.
 *
 * SERVER ONLY (it imports the bank). No React, no storage, no `Date.now()`:
 * every function here is a pure transformation of its arguments, which is what
 * lets the whole grading path be tested without a browser or a database.
 *
 * The clock helpers that used to live here are in `lib/exams/clock.ts`, because
 * the browser is allowed to draw a countdown and is not allowed to see a
 * question bank.
 */

import { mulberry32 } from '@/lib/quantum'
import { QUESTION_POOL, questionsFor } from './questions'
import { isAnsweredKind } from './clock'
import type {
  AnswerState,
  Exam,
  ExamGrade,
  ExamQuestion,
  GradedQuestion,
  PaperQuestion,
  ReviewQuestion,
} from './types'

/**
 * Seeded Fisher-Yates. Returns a new array; the input is untouched, so callers
 * can safely hand it a module-level constant.
 */
function shuffled<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed)
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

/** FNV-1a, 32-bit — same one as lib/certificate.ts, six lines and no deps. */
export function seedFrom(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Draw the paper for one attempt.
 *
 * Still deterministic in `seed`, but the result is now WRITTEN DOWN on the
 * attempt row rather than re-derived on every request. The old design stored
 * only a seed and reconstructed the paper client-side; that was elegant while
 * grading was local and is unusable now, because the set of questions a
 * candidate sat has to survive a change to the pool. Add a question to the bank
 * with a seed-derived paper and every attempt in flight is silently re-dealt.
 */
export function selectQuestions(exam: Exam, seed: number): ExamQuestion[] {
  const pool = questionsFor(exam.id)
  return shuffled(pool, seed).slice(0, Math.min(exam.questionCount, pool.length))
}

/**
 * Resolve stored ids back to questions, in the stored order.
 *
 * Silently drops an id the bank no longer has. That is the honest behaviour for
 * a retired question: the candidate's other answers still grade, and the paper
 * gets shorter rather than throwing them out of an exam they are sitting. It is
 * also why ids are append-only (see the header of questions.ts) — a REUSED id
 * would not be dropped, it would be graded against a different question.
 */
export function questionsByIds(ids: string[]): ExamQuestion[] {
  const byId = new Map(QUESTION_POOL.map((q) => [q.id, q]))
  return ids.map((id) => byId.get(id)).filter((q): q is ExamQuestion => q !== undefined)
}

/**
 * Option order for one question within one attempt.
 *
 * Derived from the attempt id and the question id rather than stored, so it is
 * stable across a resume — including a resume in a different browser — without
 * a column. Option ids are preserved, so grading is unaffected either way.
 */
export function shuffleOptionsFor<T extends { id: string; options?: { id: string; text: string }[] }>(
  q: T,
  attemptId: string
): T {
  if (!q.options || q.options.length < 2) return q
  return { ...q, options: shuffled(q.options, seedFrom(`${attemptId}|${q.id}`)) }
}

/**
 * Strip a bank question down to what a candidate may hold.
 *
 * Built field by field, NOT by spreading and deleting. A spread-and-delete
 * leaks any key added to `ExamQuestion` later — the next `hintIds` or
 * `acceptedAliases` field would ride along into the browser and nobody would
 * notice. This way, a new answer-bearing field is simply absent until someone
 * deliberately adds it here.
 */
export function toPaperQuestion(q: ExamQuestion): PaperQuestion {
  const paper: PaperQuestion = {
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    lessonSlug: q.lessonSlug,
    points: q.points,
  }
  if (q.options) paper.options = q.options.map((o) => ({ id: o.id, text: o.text }))
  if (q.qasm !== undefined) paper.qasm = q.qasm
  return paper
}

/**
 * True when the candidate gave something gradeable for this graded item.
 * `given` is what `gradeQuestion` saw: a number or null for numeric, the
 * selected ids (possibly none) for everything else.
 */
export function wasAnswered(g: GradedQuestion): boolean {
  if (g.given === null) return false
  if (Array.isArray(g.given)) return g.given.length > 0
  return Number.isFinite(g.given)
}

/**
 * The post-submission view: the paper question plus its verdict, and — ONLY
 * for a question the candidate actually answered — its key and explanation.
 *
 * The condition is the fix for an answer-bank harvest. Before it, the review
 * carried the key for every item on the paper regardless of whether it was
 * attempted, so `start → submit {}` ten times a minute (the start limit) read
 * out the whole bank in about ten minutes with no account at all. Now a blank
 * item reveals nothing; a candidate who wants to learn the answer to a
 * question has to commit an answer to it, and a wrong one still costs them the
 * retake cooldown in service.ts. A genuinely sat paper is unaffected: every
 * question the candidate answered gets its full review, pass or fail.
 */
export function toReviewQuestion(g: GradedQuestion): ReviewQuestion {
  const answered = wasAnswered(g)
  const review: ReviewQuestion = {
    ...toPaperQuestion(g.question),
    correct: g.correct,
    earned: g.earned,
    answered,
  }
  if (!answered) return review
  review.explanation = g.question.explanation
  if (g.question.correctIds) review.correctIds = [...g.question.correctIds]
  if (g.question.correctNumber !== undefined) review.correctNumber = g.question.correctNumber
  if (g.question.tolerance !== undefined) review.tolerance = g.question.tolerance
  return review
}

/**
 * Inclusive of the boundary, plus a hair of slack for binary floating point:
 * |0.361 − 0.36| evaluates to 0.0010000000000000009, which would otherwise fail
 * a stated tolerance of 0.001 and mark a candidate wrong for typing exactly the
 * value the question allows.
 */
function withinTolerance(given: number, expected: number, tolerance: number): boolean {
  const slack = 1e-9 * Math.max(1, Math.abs(expected))
  return Math.abs(given - expected) <= Math.abs(tolerance) + slack
}

function sameSet(given: string[], expected: string[]): boolean {
  const g = new Set(given)
  const e = new Set(expected)
  if (g.size !== e.size) return false
  for (const id of e) if (!g.has(id)) return false
  return true
}

/**
 * Grade a single question. Unanswered is always wrong — there is no "skip"
 * credit, and treating a blank as neutral would let a candidate raise their
 * percentage by answering less.
 */
export function gradeQuestion(q: ExamQuestion, a: AnswerState | undefined): GradedQuestion {
  if (q.kind === 'numeric') {
    const given = typeof a?.numberValue === 'number' && Number.isFinite(a.numberValue)
      ? a.numberValue
      : null
    const expected = q.correctNumber
    const correct =
      given !== null &&
      typeof expected === 'number' &&
      withinTolerance(given, expected, q.tolerance ?? 0)
    return { question: q, correct, earned: correct ? q.points : 0, given }
  }

  const given = a?.selectedIds ?? []
  const expected = q.correctIds ?? []

  if (q.kind === 'single') {
    const correct = given.length === 1 && expected.length === 1 && given[0] === expected[0]
    return { question: q, correct, earned: correct ? q.points : 0, given }
  }

  // 'multi' and 'circuit-outcome' are graded the same way, and deliberately
  // all-or-nothing: no partial credit. Partial credit on a "select all that
  // apply" item rewards blanket-selecting every option, and these questions
  // are specifically testing whether the candidate can rule the wrong ones out.
  const correct = expected.length > 0 && sameSet(given, expected)
  return { question: q, correct, earned: correct ? q.points : 0, given }
}

export function gradeExam(
  exam: Exam,
  questions: ExamQuestion[],
  answers: Record<string, AnswerState>
): ExamGrade {
  const graded = questions.map((q) => gradeQuestion(q, answers[q.id]))
  const earned = graded.reduce((sum, g) => sum + g.earned, 0)
  const total = questions.reduce((sum, q) => sum + q.points, 0)
  const score = total > 0 ? earned / total : 0

  // Count misses per lesson, then order most-missed first. Ties keep the order
  // the questions appeared in, so the list is stable for a given paper.
  const misses = new Map<string, number>()
  for (const g of graded) {
    if (g.correct) continue
    misses.set(g.question.lessonSlug, (misses.get(g.question.lessonSlug) ?? 0) + 1)
  }
  const weakLessons = [...misses.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => slug)

  return { score, earned, total, passed: score >= exam.passMark, graded, weakLessons }
}

/** True when the candidate has supplied something gradeable for `q`. */
export function isAnswered(q: ExamQuestion, a: AnswerState | undefined): boolean {
  return isAnsweredKind(q.kind, a)
}
