/**
 * service.ts — everything the exam route handlers actually do.
 *
 * SERVER ONLY.
 *
 * The route files under `app/api/exams/**` are deliberately thin: parse, call
 * one function here, serialise. The gates live in this file so that "what does
 * it take to get a paper" and "what does it take to get a certificate" are two
 * functions someone can read end to end, rather than four handlers that have to
 * be diffed against each other.
 *
 * ── The chain, and why each link is where it is ─────────────────────────────
 *
 *  1. Rate limit, keyed on the caller. Before any Supabase round trip, so an
 *     anonymous flood cannot turn these routes into a load generator against
 *     our own auth service. (Same reasoning as /api/hardware/submit.)
 *  2. `resolveSubject` — a Supabase-verified user, or a guest cookie. Identity
 *     never comes from a body. There is no `userId` parameter anywhere in this
 *     file, and there must never be one.
 *  3. `requireFeature` for an exam that declares `requiresFeature`. This is the
 *     first time the `certification` FeatureId has meant anything: the check
 *     used to be a client component, i.e. decoration. A guest resolves to the
 *     free plan, so the advanced paper is refused before a question is drawn.
 *  4. Ownership. Every attempt operation re-reads the attempt and compares its
 *     `subjectId` to the resolved subject. An attempt id is a bearer token
 *     otherwise.
 *  5. The server clock. `expiresAt` was stamped at creation; a write that
 *     arrives after it plus `SUBMIT_GRACE_MS` is refused, and the attempt is
 *     closed with the answers that arrived in time.
 *
 * ── What is NOT trusted from the request ────────────────────────────────────
 *
 * `score`, `passed`, `submittedAt`, `startedAt`, `questionIds`, `certificateId`
 * and the subject. If a body contains any of them they are ignored — the
 * submit handler reads only `attemptId` and `answers`, and the score is
 * recomputed from the bank every time. `lib/exams/attemptRoutes.test.ts` posts
 * a body claiming a perfect score and asserts the stored attempt disagrees.
 */

import { apiError, failure } from '@/lib/apiError'
import { readBodyText } from '@/lib/security/validate'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'
import { getEntitlement } from '@/lib/billing/entitlements'
import { assertFeature, FeatureLockedError, PLAN_BY_ID } from '@/lib/plans'
import { newCertificateId, parseCertificateId } from '@/lib/certificate'
import { featureForExam } from './access'
import { getExam } from './catalogue'
import { isLate, isExpired, RETAKE_COOLDOWN_MS, retakeAvailableAt } from './clock'
import {
  gradeExam,
  questionsByIds,
  seedFrom,
  selectQuestions,
  shuffleOptionsFor,
  toPaperQuestion,
  toReviewQuestion,
} from './engine'
import { ExamStoreUnavailableError, getExamStore } from './store'
import { dispatchWebhookEvent } from '@/lib/integrations/webhooks'
import { resolveSubject, withSubjectCookie, type ResolvedSubject } from './session'
import type {
  AnswerState,
  AttemptSubject,
  CertificateVerification,
  ClientAttempt,
  Exam,
  ExamResultPayload,
  PaperQuestion,
  ServerAttempt,
} from './types'

/**
 * Per-caller limits. The answer-saving route is called on every click, hence
 * the wide window; the others are page-level actions.
 *
 * These bound a script, not a distributed attacker — see the header of
 * lib/rateLimit.ts, which is honest about what an IP-keyed limiter is worth.
 * For a signed-in candidate the key is the account id, which is not rotatable.
 */
const READ_LIMIT: RateLimitRule = { limit: 60, windowMs: 60_000 }
const START_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 }
const ANSWER_LIMIT: RateLimitRule = { limit: 240, windowMs: 60_000 }
const VERIFY_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 }

/** Bounds on what a browser may send back, so a body cannot be a memory bomb. */
const MAX_ANSWERS = 64
const MAX_SELECTED_IDS = 12
const MAX_ID_CHARS = 64
const MAX_NAME_CHARS = 60
/** 64 answers at a few hundred bytes each fit in a fraction of this. */
const MAX_BODY_BYTES = 64 * 1024

// ────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────

async function limitOrNull(
  req: Request,
  prefix: string,
  rule: RateLimitRule,
  subject?: string | null
): Promise<Response | null> {
  const decision = await rateLimit(callerKey(req.headers, prefix, subject), rule)
  if (decision.allowed) return null
  return apiError('rate_limited', { headers: retryAfterHeaders(decision) })
}

/**
 * The key these limits may safely be counted under.
 *
 * SECURITY FIX. Passing `resolved.subject.id` unconditionally made every one of
 * these limits unenforceable against exactly the caller they exist to bound.
 * `resolveSubject` MINTS a fresh `guest_<128 bits>` for a request that carries
 * no cookie, so an anonymous caller was handed a brand-new rate-limit bucket on
 * every single request: `callerKey` saw a truthy subject, keyed on it, and the
 * counter it incremented was one nobody would ever look at again. Measured
 * against the running app before this change: fourteen consecutive
 * `POST /api/exams/foundations-cert/attempt` from one IP with no cookie
 * returned fourteen 201s and created fourteen `exam_attempts` rows, against a
 * documented limit of ten a minute. The same fourteen requests carrying one
 * fixed guest cookie were refused from the eleventh, which is the limiter
 * working — it was only ever the freshly-minted identity that escaped it.
 *
 * "Only key on it once the caller has PRESENTED the cookie" is not enough
 * either, and it is worth saying why so nobody weakens this back to it: a guest
 * id is `guest_` + 32 hex, unsigned, self-asserted and never checked against
 * anything (session.ts says so, correctly — it protects nothing). A caller who
 * mints their own cookie value per request presents a cookie every time and is
 * still in a fresh bucket every time.
 *
 * So the rule is the only one that holds: A RATE LIMIT MAY ONLY BE KEYED ON AN
 * IDENTITY THE SERVER VERIFIED. That is a Supabase-checked account id and
 * nothing else. Guests fall back to the address, which is what `callerKey` does
 * for a null subject — weak, rotatable, and honestly described in the header of
 * lib/rateLimit.ts, but it is a bound, and the guest id was not one.
 */
function limitKeyFor(resolved: ResolvedSubject): string | null {
  return resolved.subject.kind === 'user' ? resolved.subject.id : null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A store outage is a 503 that says so, never a silent empty result.
 * See `orThrow` in store.ts for why that direction is the safe one here.
 */
function storeFailure(err: unknown, what: string): Response {
  if (err instanceof ExamStoreUnavailableError) {
    return failure('not_configured', err, { scope: 'exams', what }, {
      message:
        'The exam service cannot reach its records right now. Your attempt has not been lost — try again in a moment.',
    })
  }
  return failure('internal', err, { scope: 'exams', what })
}

function featureLocked(err: FeatureLockedError): Response {
  return json(
    {
      error: `This exam is included with ${PLAN_BY_ID[err.requiredPlan].name}.`,
      code: 'feature_locked',
      feature: err.feature,
      requiredPlan: err.requiredPlan,
      upgradeUrl: '/pricing',
    },
    402
  )
}

/**
 * Read a JSON object body, refusing anything over `MAX_BODY_BYTES`.
 *
 * `req.json()` buffers and parses whatever it is given, so before this cap an
 * anonymous caller could make the process parse a multi-megabyte body on every
 * write route. The declared length is checked first (cheap), and the stream is
 * then counted as it is read so a lying or absent `content-length` cannot get
 * past it. Callers run the rate limit BEFORE calling this.
 *
 * An unparseable body is `{}`, as before; only an oversized one is refused.
 */
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  const read = await readBodyText(req, MAX_BODY_BYTES)
  if (!read.ok) return read.tooLarge ? apiError('payload_too_large') : {}
  const raw = read.value

  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Normalise the answer map a browser sent.
 *
 * Rebuilt key by key rather than accepted wholesale, for the same reason
 * `toPaperQuestion` is: a client that posts `{questionId, selectedIds, score}`
 * must not be able to smuggle `score` into a stored row. Anything that is not
 * one of the four known fields is dropped, and anything oversized is refused
 * by the caps above.
 */
function normalizeAnswers(
  raw: unknown,
  allowedIds: ReadonlySet<string>
): Record<string, AnswerState> {
  const out: Record<string, AnswerState> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, MAX_ANSWERS)
  for (const [key, value] of entries) {
    if (!allowedIds.has(key)) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const rec = value as Record<string, unknown>
    const selectedIds = Array.isArray(rec.selectedIds)
      ? rec.selectedIds
          .filter((v): v is string => typeof v === 'string' && v.length <= MAX_ID_CHARS)
          .slice(0, MAX_SELECTED_IDS)
      : []
    const answer: AnswerState = {
      questionId: key,
      selectedIds,
      flagged: rec.flagged === true,
    }
    if (typeof rec.numberValue === 'number' && Number.isFinite(rec.numberValue)) {
      answer.numberValue = rec.numberValue
    }
    out[key] = answer
  }
  return out
}

function toClientAttempt(a: ServerAttempt, now: number = Date.now()): ClientAttempt {
  const client: ClientAttempt = {
    id: a.id,
    examId: a.examId,
    startedAt: a.startedAt,
    expiresAt: a.expiresAt,
    answers: a.answers,
    certifiable: a.subjectKind === 'user',
    serverNow: new Date(now).toISOString(),
  }
  if (a.submittedAt) client.submittedAt = a.submittedAt
  return client
}

/** The paper, stripped and with options in this attempt's stable order. */
function paperFor(attempt: ServerAttempt): PaperQuestion[] {
  return questionsByIds(attempt.questionIds).map((q) =>
    shuffleOptionsFor(toPaperQuestion(q), attempt.id)
  )
}

function newAttemptId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `att_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Grade and close an attempt. The ONLY place a score is written.
 *
 * `now` is the server's clock, passed in so the caller can pin it to the same
 * instant it used for the lateness check — reading `Date.now()` twice across a
 * database round trip is how an attempt gets a `submittedAt` a few milliseconds
 * past its own deadline.
 */
async function finalise(
  attempt: ServerAttempt,
  exam: Exam,
  closedBy: 'candidate' | 'expiry',
  now: number
): Promise<{ attempt: ServerAttempt; payload: ExamResultPayload }> {
  const questions = questionsByIds(attempt.questionIds)
  const grade = gradeExam(exam, questions, attempt.answers)

  // An expiry closes the paper AT the deadline, not at the moment somebody
  // happened to ask about it. A candidate who shuts the laptop and comes back a
  // week later is recorded as having used the time limit, not a week.
  const deadline = new Date(attempt.expiresAt).getTime()
  const submittedMs = closedBy === 'expiry' ? Math.min(now, deadline) : now

  const closed: ServerAttempt = {
    ...attempt,
    submittedAt: new Date(submittedMs).toISOString(),
    closedBy,
    score: grade.score,
    passed: grade.passed,
  }
  await getExamStore().updateAttempt(closed)

  // A5 integration seam: tell registered webhooks about a pass, AFTER the
  // score is durably written. Guests have no account and therefore no
  // endpoints, so only 'user' attempts fire. The dispatcher is fire-and-forget
  // and never throws, and the try/catch is belt-and-braces on top of that
  // promise: a webhook must never be able to break grading.
  try {
    if (grade.passed && closed.subjectKind === 'user') {
      dispatchWebhookEvent(
        'exam_passed',
        {
          examId: exam.id,
          attemptId: closed.id,
          score: grade.score,
          passed: true,
          submittedAt: closed.submittedAt,
          closedBy,
        },
        closed.subjectId
      )
    }
  } catch {
    // Deliberately swallowed — see above.
  }

  const started = new Date(attempt.startedAt).getTime()
  return {
    attempt: closed,
    payload: {
      attemptId: closed.id,
      examId: exam.id,
      score: grade.score,
      earned: grade.earned,
      total: grade.total,
      passed: grade.passed,
      submittedAt: closed.submittedAt as string,
      timeSpentMs: Math.max(0, submittedMs - started),
      closedBy,
      weakLessons: grade.weakLessons,
      review: grade.graded.map((g) => shuffleOptionsFor(toReviewQuestion(g), closed.id)),
      answers: closed.answers,
      certifiable: closed.subjectKind === 'user',
      ...retakeField(closed),
      ...(closed.certificateId ? { certificateId: closed.certificateId } : {}),
    },
  }
}

function retakeField(a: ServerAttempt): { retakeAvailableAt?: string } {
  const at = retakeAvailableAt(a.submittedAt, a.passed)
  return at ? { retakeAvailableAt: at } : {}
}

/** Rebuild the result payload for an attempt that is already closed. */
function replayResult(attempt: ServerAttempt, exam: Exam): ExamResultPayload {
  const questions = questionsByIds(attempt.questionIds)
  const grade = gradeExam(exam, questions, attempt.answers)
  const started = new Date(attempt.startedAt).getTime()
  const submitted = new Date(attempt.submittedAt ?? attempt.expiresAt).getTime()
  return {
    attemptId: attempt.id,
    examId: exam.id,
    // The STORED score wins. Regrading is only a fallback for a row written
    // before this column existed: if a recomputed score ever disagreed with the
    // stored one, the bank has changed underneath a closed attempt, and the
    // number that was certified is the one on the row — not the one today's
    // bank produces. `passed` follows the same rule.
    score: attempt.score ?? grade.score,
    earned: grade.earned,
    total: grade.total,
    passed: attempt.passed ?? grade.passed,
    submittedAt: attempt.submittedAt ?? attempt.expiresAt,
    timeSpentMs: Math.max(0, submitted - started),
    closedBy: attempt.closedBy ?? 'expiry',
    weakLessons: grade.weakLessons,
    review: grade.graded.map((g) => shuffleOptionsFor(toReviewQuestion(g), attempt.id)),
    answers: attempt.answers,
    certifiable: attempt.subjectKind === 'user',
    ...retakeField(attempt),
    ...(attempt.certificateId ? { certificateId: attempt.certificateId } : {}),
  }
}

/** The gate an exam's `requiresFeature` finally has teeth through. */
async function entitlementOrNull(exam: Exam, subject: AttemptSubject): Promise<Response | null> {
  const feature = featureForExam(exam)
  if (!feature) return null
  // A guest has no account, so no plan. Resolving the free entitlement rather
  // than special-casing keeps one code path for "what may this person do".
  const entitlement = await getEntitlement(subject.kind === 'user' ? subject.id : null)
  try {
    assertFeature(entitlement, feature)
  } catch (err) {
    if (err instanceof FeatureLockedError) return featureLocked(err)
    throw err
  }
  return null
}

interface Loaded {
  resolved: ResolvedSubject
  exam: Exam
  attempt: ServerAttempt
  body: Record<string, unknown>
}

/**
 * Load an attempt and prove the caller owns it.
 *
 * Order matters and is the chain at the top of this file: exam, subject, RATE
 * LIMIT, then the request body, then the store read. The body is parsed (and
 * size-capped) only after the limiter has let the request through, so a flood
 * of oversized bodies is refused before it costs a parse.
 *
 * A caller who names an attempt that is not theirs gets 404, not 403: 403 would
 * confirm the id exists. There is nothing sensitive in the existence of an
 * attempt id, but the habit is worth keeping and it costs nothing.
 */
async function loadOwned(
  req: Request,
  examId: string,
  prefix: string,
  rule: RateLimitRule
): Promise<Loaded | Response> {
  const exam = getExam(examId)
  if (!exam) return apiError('not_found', { message: 'There is no exam with that id.' })

  const resolved = await resolveSubject(req)
  // A token was presented but could not be accepted: 401 (invalid) or 503
  // (auth service unreachable), never a silent downgrade to a guest.
  if (resolved.denied) return resolved.denied
  // The limit runs BEFORE the body parse and the store read: every refused
  // request would otherwise have cost a JSON parse and one `getAttempt`
  // against the exam store, an unauthenticated amplifier.
  const limited = await limitOrNull(req, prefix, rule, limitKeyFor(resolved))
  if (limited) return withSubjectCookie(limited, resolved)

  const body = await readBody(req)
  if (body instanceof Response) return withSubjectCookie(body, resolved)

  const attemptId = body.attemptId
  if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId.length > MAX_ID_CHARS) {
    return withSubjectCookie(apiError('bad_request', { message: 'attemptId is required.' }), resolved)
  }

  const attempt = await getExamStore().getAttempt(attemptId)
  if (!attempt || attempt.subjectId !== resolved.subject.id || attempt.examId !== exam.id) {
    return withSubjectCookie(apiError('not_found', { message: 'That attempt does not exist.' }), resolved)
  }
  return { resolved, exam, attempt, body }
}

// ────────────────────────────────────────────────────────────
// The operations
// ────────────────────────────────────────────────────────────

export type AttemptState =
  | { state: 'none'; durable: boolean; certifiable: boolean }
  | { state: 'open'; attempt: ClientAttempt; paper: PaperQuestion[]; durable: boolean }
  | { state: 'submitted'; result: ExamResultPayload; durable: boolean; certifiable: boolean }

/**
 * "What is my situation with this exam?" — called on page load.
 *
 * Finalises an attempt whose clock ran out while the tab was closed, rather
 * than handing it back with time on it. That used to happen in a `useEffect`,
 * where a candidate who never reopened the tab simply never got graded.
 */
export async function currentState(req: Request, examId: string): Promise<Response> {
  const exam = getExam(examId)
  if (!exam) return apiError('not_found', { message: 'There is no exam with that id.' })

  const resolved = await resolveSubject(req)
  // A token was presented but could not be accepted: 401 (invalid) or 503
  // (auth service unreachable), never a silent downgrade to a guest.
  if (resolved.denied) return resolved.denied
  const limited = await limitOrNull(req, 'exam-state', READ_LIMIT, limitKeyFor(resolved))
  if (limited) return limited

  const locked = await entitlementOrNull(exam, resolved.subject)
  if (locked) return withSubjectCookie(locked, resolved)

  const store = getExamStore()
  try {
    const latest = await store.latestAttempt(resolved.subject.id, exam.id)
    const certifiable = resolved.subject.kind === 'user'

    if (!latest) {
      const body: AttemptState = { state: 'none', durable: store.durable, certifiable }
      return withSubjectCookie(json(body), resolved)
    }

    if (!latest.submittedAt) {
      const now = Date.now()
      if (isExpired(latest.expiresAt, now)) {
        const { payload } = await finalise(latest, exam, 'expiry', now)
        const body: AttemptState = {
          state: 'submitted',
          result: payload,
          durable: store.durable,
          certifiable,
        }
        return withSubjectCookie(json(body), resolved)
      }
      const body: AttemptState = {
        state: 'open',
        attempt: toClientAttempt(latest, now),
        paper: paperFor(latest),
        durable: store.durable,
      }
      return withSubjectCookie(json(body), resolved)
    }

    const body: AttemptState = {
      state: 'submitted',
      result: replayResult(latest, exam),
      durable: store.durable,
      certifiable,
    }
    return withSubjectCookie(json(body), resolved)
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'currentState'), resolved)
  }
}

/**
 * Start a paper, or hand back the one already running.
 *
 * Resuming rather than starting afresh is not a nicety: a double-clicked
 * button, a StrictMode double-mount or a retried request must not deal a second
 * paper and silently abandon the first with the clock still on it.
 */
export async function startAttempt(req: Request, examId: string): Promise<Response> {
  const exam = getExam(examId)
  if (!exam) return apiError('not_found', { message: 'There is no exam with that id.' })

  const resolved = await resolveSubject(req)
  // A token was presented but could not be accepted: 401 (invalid) or 503
  // (auth service unreachable), never a silent downgrade to a guest.
  if (resolved.denied) return resolved.denied
  const limited = await limitOrNull(req, 'exam-start', START_LIMIT, limitKeyFor(resolved))
  if (limited) return limited

  const locked = await entitlementOrNull(exam, resolved.subject)
  if (locked) return withSubjectCookie(locked, resolved)

  const store = getExamStore()
  try {
    const latest = await store.latestAttempt(resolved.subject.id, exam.id)
    const now = Date.now()

    if (latest && !latest.submittedAt && !isExpired(latest.expiresAt, now)) {
      const body: AttemptState = {
        state: 'open',
        attempt: toClientAttempt(latest, now),
        paper: paperFor(latest),
        durable: store.durable,
      }
      return withSubjectCookie(json(body), resolved)
    }

    let previous: ServerAttempt | undefined = latest ?? undefined
    if (latest && !latest.submittedAt) {
      // Its clock ran out before this request. Close it on the record before
      // dealing a new paper, so history shows a sat-and-expired attempt rather
      // than an attempt that dangles open forever.
      previous = (await finalise(latest, exam, 'expiry', now)).attempt
    }

    // Retake cooldown. A review shows the key for every question the candidate
    // answered, so "answer everything, read the key, start again" would harvest
    // the whole bank at the start limit. After a FAILED paper the next one is
    // dealt only once the cooldown has passed. A pass is never delayed, and
    // neither is a first attempt.
    const waitUntil = previous
      ? retakeAvailableAt(previous.submittedAt, previous.passed)
      : undefined
    if (waitUntil && Date.parse(waitUntil) > now) {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(waitUntil) - now) / 1000))
      const minutes = Math.ceil(RETAKE_COOLDOWN_MS / 60_000)
      return withSubjectCookie(
        new Response(
          JSON.stringify({
            error: `You can sit this exam again at ${waitUntil}. There is a ${minutes}-minute wait after a paper that did not pass — use it to revise the lessons the review names.`,
            code: 'rate_limited',
            retakeAvailableAt: waitUntil,
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
          }
        ),
        resolved
      )
    }

    const id = newAttemptId()
    // The paper is drawn from the attempt id, so two attempts started in the
    // same millisecond cannot get the same one — the old clock-derived seed
    // could, and did, under a double-click.
    const questions = selectQuestions(exam, seedFrom(id))
    const attempt: ServerAttempt = {
      id,
      examId: exam.id,
      subjectKind: resolved.subject.kind,
      subjectId: resolved.subject.id,
      startedAt: new Date(now).toISOString(),
      // Stamped once, from the server's clock, and never recomputed.
      expiresAt: new Date(now + exam.timeLimitMinutes * 60_000).toISOString(),
      questionIds: questions.map((q) => q.id),
      answers: {},
    }
    await store.insertAttempt(attempt)

    const body: AttemptState = {
      state: 'open',
      attempt: toClientAttempt(attempt, now),
      paper: paperFor(attempt),
      durable: store.durable,
    }
    return withSubjectCookie(json(body, 201), resolved)
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'startAttempt'), resolved)
  }
}

/**
 * Persist answers mid-sitting. Merged, not replaced, so a request that races
 * another cannot un-answer a question the candidate has already answered.
 */
export async function saveAnswers(req: Request, examId: string): Promise<Response> {
  const loaded = await loadOwned(req, examId, 'exam-answers', ANSWER_LIMIT)
  if (loaded instanceof Response) return loaded
  const { resolved, exam, attempt, body } = loaded

  if (attempt.submittedAt) {
    return withSubjectCookie(
      apiError('conflict', { message: 'This attempt has already been submitted.' }),
      resolved
    )
  }

  const now = Date.now()
  if (isLate(attempt.expiresAt, now)) {
    // Close it here rather than accepting the write and closing it on submit:
    // an answer that arrives after the deadline must not be stored at all, or
    // the auto-graded score would include it.
    try {
      const { payload } = await finalise(attempt, exam, 'expiry', now)
      return withSubjectCookie(
        json(
          {
            error: 'Time is up. This paper was submitted automatically and this answer was not counted.',
            code: 'conflict',
            result: payload,
          },
          409
        ),
        resolved
      )
    } catch (err) {
      return withSubjectCookie(storeFailure(err, 'saveAnswers.expire'), resolved)
    }
  }

  const allowed = new Set(attempt.questionIds)
  const incoming = normalizeAnswers(body.answers, allowed)
  const merged: ServerAttempt = { ...attempt, answers: { ...attempt.answers, ...incoming } }

  try {
    await getExamStore().updateAttempt(merged)
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'saveAnswers'), resolved)
  }
  return withSubjectCookie(json({ saved: true, answers: merged.answers }), resolved)
}

/**
 * Submit for grading.
 *
 * A LATE SUBMISSION IS REFUSED. Not clamped, not quietly accepted with a
 * penalty: the answers in a late request are discarded, the paper is closed
 * against what was on file at the deadline, and the response is a 409 that says
 * what happened. The result is included so the candidate sees their marks
 * rather than an error with no way forward.
 */
export async function submitAttempt(req: Request, examId: string): Promise<Response> {
  const loaded = await loadOwned(req, examId, 'exam-submit', START_LIMIT)
  if (loaded instanceof Response) return loaded
  const { resolved, exam, attempt, body } = loaded

  try {
    // Already graded: return the same marks rather than regrading. A retried
    // submit must be idempotent, or a flaky connection changes a score.
    if (attempt.submittedAt) {
      return withSubjectCookie(json({ result: replayResult(attempt, exam) }), resolved)
    }

    const now = Date.now()
    if (isLate(attempt.expiresAt, now)) {
      const { payload } = await finalise(attempt, exam, 'expiry', now)
      return withSubjectCookie(
        json(
          {
            error:
              'Time ran out before this submission arrived. Your paper was graded against the answers saved before the deadline.',
            code: 'conflict',
            result: payload,
          },
          409
        ),
        resolved
      )
    }

    // The final flush: whatever is in the body is merged first, then graded.
    const allowed = new Set(attempt.questionIds)
    const flushed: ServerAttempt = {
      ...attempt,
      answers: { ...attempt.answers, ...normalizeAnswers(body.answers, allowed) },
    }
    const { payload } = await finalise(flushed, exam, 'candidate', now)
    return withSubjectCookie(json({ result: payload }), resolved)
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'submitAttempt'), resolved)
  }
}

/**
 * Turn a passed attempt into a certificate.
 *
 * Four conditions, all checked here and none checkable in a browser: the
 * attempt exists and belongs to the caller, the caller is a signed-in user (a
 * guest cannot be named on a credential), the attempt is submitted and passed,
 * and no certificate has been issued for it already. The name is the one thing
 * the candidate supplies, it is self-attested, and `/verify` says so.
 */
export async function claimCertificate(req: Request, examId: string): Promise<Response> {
  const loaded = await loadOwned(req, examId, 'exam-cert', START_LIMIT)
  if (loaded instanceof Response) return loaded
  const { resolved, exam, attempt, body } = loaded

  if (attempt.subjectKind !== 'user') {
    return withSubjectCookie(
      apiError('unauthorized', {
        message:
          'Certificates are issued to accounts. Sign in and sit the exam again to earn one — this attempt was anonymous.',
      }),
      resolved
    )
  }
  if (!attempt.submittedAt || attempt.passed !== true) {
    return withSubjectCookie(
      apiError('conflict', { message: 'That attempt did not pass, so it cannot be certified.' }),
      resolved
    )
  }

  const rawName = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''
  if (rawName.length < 2 || rawName.length > MAX_NAME_CHARS) {
    return withSubjectCookie(
      apiError('bad_request', {
        message: `The name on a certificate must be between 2 and ${MAX_NAME_CHARS} characters.`,
      }),
      resolved
    )
  }

  const store = getExamStore()
  try {
    const existing =
      (attempt.certificateId ? await store.getCertificate(attempt.certificateId) : null) ??
      (await store.certificateForAttempt(attempt.id))
    if (existing) {
      // Issued once, immutable. Re-typing the name does not re-issue: a
      // credential whose holder's name can be changed after the fact is not one.
      return withSubjectCookie(json({ certificate: publicCertificate(existing, exam) }), resolved)
    }

    const record = {
      id: newCertificateId(),
      userId: attempt.subjectId,
      examId: exam.id,
      attemptId: attempt.id,
      displayName: rawName,
      score: attempt.score ?? 0,
      issuedAt: new Date().toISOString(),
    }
    await store.insertCertificate(record)
    await store.updateAttempt({ ...attempt, certificateId: record.id })
    return withSubjectCookie(json({ certificate: publicCertificate(record, exam) }, 201), resolved)
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'claimCertificate'), resolved)
  }
}

function publicCertificate(
  record: { id: string; displayName: string; examId: string; issuedAt: string },
  exam: Exam
): CertificateVerification {
  return {
    valid: true,
    id: record.id,
    name: record.displayName,
    examId: record.examId,
    examTitle: exam.title,
    level: exam.level,
    issuedAt: record.issuedAt,
  }
}

/**
 * The public verification. NO AUTHENTICATION — that is the point of it.
 *
 * It answers one question and returns one sentence's worth of fact: this name
 * passed this exam on this date. It does not return the score, the attempt, the
 * account, the email, or whether the holder has sat the exam before, because a
 * hiring manager checking a certificate number is not entitled to any of that.
 */
export async function verifyCertificate(req: Request, rawId: string): Promise<Response> {
  const limited = await limitOrNull(req, 'exam-verify', VERIFY_LIMIT)
  if (limited) return limited

  const result = await lookupCertificate(rawId)
  // 200 either way. A 404 for an unknown id turns this route into an oracle
  // that can be probed with a HEAD request and no body parsing; more to the
  // point, "we checked, and there is no such certificate" IS the successful
  // answer to the question the caller asked.
  return json(result)
}

/**
 * The shared lookup behind both the route and the `/verify` page.
 * Never throws: a store outage is reported as an unverifiable id, not a crash.
 */
export async function lookupCertificate(rawId: string): Promise<CertificateVerification> {
  const id = parseCertificateId(rawId ?? '')
  if (!id) {
    return {
      valid: false,
      id: (rawId ?? '').slice(0, 32),
      reason:
        'That is not the shape of a Qubit16 certificate number. They look like QL-4F2AH-9C31T-K.',
    }
  }

  try {
    const record = await getExamStore().getCertificate(id)
    if (!record) {
      return { valid: false, id, reason: 'No certificate has been issued with that number.' }
    }
    const exam = getExam(record.examId)
    if (!exam) {
      // The exam was retired. The pass still happened, so say so rather than
      // calling a real certificate invalid.
      return {
        valid: true,
        id,
        name: record.displayName,
        examId: record.examId,
        issuedAt: record.issuedAt,
        reason: 'The exam this certificate names is no longer offered.',
      }
    }
    return publicCertificate(record, exam)
  } catch {
    return {
      valid: false,
      id,
      reason:
        'Certificate records are temporarily unreachable, so this number could not be checked. This is not a statement about the certificate.',
    }
  }
}

/**
 * Per-exam history for `/certify`: best score, pass, certificate.
 *
 * Not exported: /certify is a client component and a type-only import from
 * this module would still be an import edge, which `boundary.test.ts` counts —
 * correctly, because a bundler is not obliged to notice that the edge carried
 * only a type. The page declares the same shape locally.
 */
interface ExamSummary {
  examId: string
  attempts: number
  bestScore: number | null
  passed: boolean
  certificateId?: string
  /** Set when a paper is running right now, so /certify can say "resume". */
  openAttemptExpiresAt?: string
}

export async function examSummary(req: Request): Promise<Response> {
  const resolved = await resolveSubject(req)
  // A token was presented but could not be accepted: 401 (invalid) or 503
  // (auth service unreachable), never a silent downgrade to a guest.
  if (resolved.denied) return resolved.denied
  const limited = await limitOrNull(req, 'exam-summary', READ_LIMIT, limitKeyFor(resolved))
  if (limited) return limited

  const store = getExamStore()
  try {
    const all = await store.listAttempts(resolved.subject.id, 100)
    const byExam = new Map<string, ExamSummary>()
    const now = Date.now()

    for (const attempt of all) {
      const summary = byExam.get(attempt.examId) ?? {
        examId: attempt.examId,
        attempts: 0,
        bestScore: null,
        passed: false,
      }
      summary.attempts += 1
      if (typeof attempt.score === 'number') {
        summary.bestScore = summary.bestScore === null ? attempt.score : Math.max(summary.bestScore, attempt.score)
      }
      if (attempt.passed === true) summary.passed = true
      if (attempt.certificateId && !summary.certificateId) summary.certificateId = attempt.certificateId
      if (!attempt.submittedAt && !isExpired(attempt.expiresAt, now)) {
        summary.openAttemptExpiresAt = attempt.expiresAt
      }
      byExam.set(attempt.examId, summary)
    }

    return withSubjectCookie(
      json({
        summaries: [...byExam.values()],
        durable: store.durable,
        signedIn: resolved.subject.kind === 'user',
      }),
      resolved
    )
  } catch (err) {
    return withSubjectCookie(storeFailure(err, 'examSummary'), resolved)
  }
}
