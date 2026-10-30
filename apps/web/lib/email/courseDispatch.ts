/**
 * email/courseDispatch.ts — one bounded pass of the 7-day course sender.
 *
 * SERVER ONLY. This is the machinery behind POST /api/email/dispatch, kept
 * out of the route file so the orchestration is testable with a fake store
 * and a fake sender: what the tests must be able to prove is ORDER — the
 * sent_days claim commits before the provider is called — and that proof
 * cannot depend on having a live Supabase.
 *
 * ── Why claim-before-send (at-most-once) ────────────────────────────────────
 *
 * Between "claim day N" and "provider accepted" the process can crash. The
 * two possible designs fail differently:
 *   • send-then-record: a crash re-sends day N on the next run — a stranger's
 *     inbox gets duplicate mail, and nothing in the system can tell.
 *   • record-then-send (this one): a crash drops day N for that subscriber —
 *     a gap in a free course, visible in the dispatch report's failure list.
 * For email, the second failure is strictly better, so the claim is an
 * atomic, guarded append to sent_days and the provider is only called after
 * it commits. A claim that finds the day already present means another run
 * got there first; the row is skipped without sending.
 *
 * ── The unsubscribe token ───────────────────────────────────────────────────
 *
 * Every course mail must carry a working one-click unsubscribe link, but the
 * signup token behind token_hash is never stored (by design — see
 * subscriptions.ts), so the dispatcher cannot reuse it. Instead the FIRST
 * claim for a subscription also mints and stores a dedicated plaintext
 * unsubscribe token (course_unsubscribe_token — schema-email.sql documents
 * the threat-model trade), and every subsequent day reuses it, so the link
 * in the day-2 mail still works when day 6 arrives. It is honoured by
 * GET /api/email/unsubscribe/course.
 */

import { getServiceSupabase } from '@/lib/billing/entitlements'
import { reportError } from '@/lib/observability/report'
import { sendEmail, type SendEmailInput, type SendResult } from '@/lib/email/client'
import { courseDayEmail } from '@/lib/email/templates'
import {
  COURSE_DAY_MS,
  COURSE_LENGTH_DAYS,
  dueCourseDay,
  normaliseSentDays,
  type CourseDay,
} from '@/lib/email/courseSchedule'
import {
  SUBSCRIPTIONS_TABLE,
  SubscriptionStoreUnavailableError,
} from '@/lib/email/subscriptions'

/** One subscription as the dispatcher sees it. */
export interface CourseCandidate {
  id: string
  email: string
  confirmedAt: string | null
  unsubscribedAt: string | null
  sentDays: number[]
  courseUnsubscribeToken: string | null
}

export type ClaimResult = { claimed: true; unsubscribeToken: string } | { claimed: false }

/**
 * What the orchestration needs from storage — two operations, so the tests
 * can substitute an in-memory fake WITHOUT that fake ever becoming a way to
 * run real dispatch against the non-durable store. The route refuses the
 * memory backend before this module is ever reached; nothing here re-checks,
 * and nothing here may be exported in a way that skips that refusal.
 */
export interface CourseDispatchStore {
  /**
   * Up to `limit` subscriptions that have a course day DUE at `now`, oldest
   * confirmation first. A store MUST NOT return caught-up rows: the batch is
   * bounded, so every slot a not-due row occupies is a due subscriber who
   * gets nothing this pass (see courseDueFilter below for how that went wrong).
   */
  listCandidates(limit: number, now: Date): Promise<CourseCandidate[]>
  /**
   * Atomically append `day` to sent_days (and set the unsubscribe token if
   * the row has none yet). MUST refuse — claimed: false — when the day is
   * already present or the row has been unsubscribed since it was listed.
   */
  claimDay(candidate: CourseCandidate, day: CourseDay, freshToken: string): Promise<ClaimResult>
  /**
   * Take `day` back out of sent_days after the provider DEFINITIVELY refused
   * the message (429 / 5xx, retries exhausted), so the next hourly pass sends
   * it. Optional: a store without it keeps the claim, as before. MUST only
   * remove `day` — never touch other days or the unsubscribe token — and MUST
   * be a no-op on a row that no longer contains it.
   */
  releaseDay?(candidate: CourseCandidate, day: CourseDay): Promise<void>
}

// ── the Supabase implementation ─────────────────────────────────────────────

interface CandidateRow {
  id: string
  email: string
  confirmed_at: string | null
  unsubscribed_at: string | null
  sent_days: unknown
  course_unsubscribe_token: string | null
}

const CANDIDATE_COLUMNS = 'id,email,confirmed_at,unsubscribed_at,sent_days,course_unsubscribe_token'

function client() {
  const supabase = getServiceSupabase()
  if (!supabase) throw new SubscriptionStoreUnavailableError('No service-role client.')
  return supabase
}

/**
 * The PostgREST `or` filter selecting exactly the rows with a course day due
 * at `now` — the database-side twin of courseSchedule.dueCourseDay.
 *
 * ── Why this exists (RELIABILITY FIX) ───────────────────────────────────────
 *
 * The query used to list the `limit` OLDEST confirmed, not-finished rows and
 * let runCourseDispatch work out which were due. A confirmed subscriber who is
 * caught up (today's day already sent) is still "confirmed and not finished",
 * so once more than `limit` people were mid-course the same oldest rows filled
 * every batch, were all counted as notDue, and every newer subscriber received
 * nothing until those finished day 7 — a confirmed learner could wait a week
 * for day 1. Caught-up rows must therefore be excluded BY THE QUERY.
 *
 * ── The predicate ───────────────────────────────────────────────────────────
 *
 * PostgREST cannot compare a column against an expression of another column,
 * so "confirmed_at <= now − cardinality(sent_days) days" is unrolled into one
 * clause per course day:
 *
 *   day N is sendable  ⇔  N ∉ sent_days  AND  confirmed_at <= now − (N−1) days
 *
 * and a row is due iff ANY clause holds. This is exactly dueCourseDay ≠ null:
 * if the lowest unsent day d is due, clause d holds; conversely, if clause N
 * holds then the lowest unsent day is ≤ N and therefore also due, because
 * N−1 days have already elapsed. courseDispatchStore.test.ts checks the two
 * agree over a grid of rows. No schema change is needed — the filter runs on
 * the columns the table already has.
 */
export function courseDueFilter(now: Date): string {
  const clauses: string[] = []
  for (let day = 1; day <= COURSE_LENGTH_DAYS; day += 1) {
    const dueAt = new Date(now.getTime() - (day - 1) * COURSE_DAY_MS).toISOString()
    clauses.push(`and(sent_days.not.cs.{${day}},confirmed_at.lte.${dueAt})`)
  }
  return clauses.join(',')
}

export const supabaseDispatchStore: CourseDispatchStore = {
  /**
   * Only rows with a day due at `now` (courseDueFilter), oldest confirmation
   * first, completed courses (day 7 sent) excluded by the `not cs {7}` filter.
   * Because nothing caught-up is listed, `limit` bounds the number of
   * MESSAGES a pass sends, and a backlog larger than `limit` drains across
   * successive passes instead of starving the newest subscribers.
   */
  async listCandidates(limit, now) {
    const { data, error } = await client()
      .from(SUBSCRIPTIONS_TABLE)
      .select(CANDIDATE_COLUMNS)
      .eq('purpose', 'course-7day')
      .not('confirmed_at', 'is', null)
      .is('unsubscribed_at', null)
      .not('sent_days', 'cs', '{7}')
      .or(courseDueFilter(now))
      .order('confirmed_at', { ascending: true })
      .limit(limit)
    if (error) {
      reportError(error, { scope: 'email.dispatch', what: 'listCandidates' })
      throw new SubscriptionStoreUnavailableError()
    }
    return ((data ?? []) as CandidateRow[]).map((row) => ({
      id: row.id,
      email: row.email,
      confirmedAt: row.confirmed_at,
      unsubscribedAt: row.unsubscribed_at,
      sentDays: normaliseSentDays(row.sent_days),
      courseUnsubscribeToken: row.course_unsubscribe_token,
    }))
  },

  /**
   * The atomicity lives in the WHERE clause, not in this process: the update
   * only lands on a row that is still not unsubscribed and does NOT already
   * contain `day`. Zero rows updated = another run won the race (or an
   * opt-out arrived after listing) = do not send. The token is written only
   * when the listed row had none; day-claims for one subscription are
   * mutually exclusive, so no later claim can overwrite a token an earlier
   * mail already carries.
   */
  async claimDay(candidate, day, freshToken) {
    const nextSentDays = [...new Set([...candidate.sentDays, day])].sort((a, b) => a - b)
    const payload: Record<string, unknown> = { sent_days: nextSentDays }
    if (!candidate.courseUnsubscribeToken) payload.course_unsubscribe_token = freshToken

    const { data, error } = await client()
      .from(SUBSCRIPTIONS_TABLE)
      .update(payload)
      .eq('id', candidate.id)
      .is('unsubscribed_at', null)
      .not('sent_days', 'cs', `{${day}}`)
      .select('course_unsubscribe_token')
    if (error) {
      reportError(error, { scope: 'email.dispatch', what: 'claimDay' })
      throw new SubscriptionStoreUnavailableError()
    }
    const row = (data ?? [])[0] as { course_unsubscribe_token: string | null } | undefined
    if (!row || !row.course_unsubscribe_token) return { claimed: false }
    return { claimed: true, unsubscribeToken: row.course_unsubscribe_token }
  },

  /**
   * Re-read the row and write back its sent_days without `day`, guarded on the
   * value read so a concurrent claim of another day is not clobbered (a lost
   * race leaves the claim in place, which is the old, safe behaviour).
   */
  async releaseDay(candidate, day) {
    const db = client()
    const { data, error } = await db
      .from(SUBSCRIPTIONS_TABLE)
      .select('sent_days')
      .eq('id', candidate.id)
      .maybeSingle()
    if (error || !data) return
    const current = normaliseSentDays((data as { sent_days: unknown }).sent_days)
    if (!current.includes(day)) return
    const next = current.filter((d) => d !== day)
    await db
      .from(SUBSCRIPTIONS_TABLE)
      .update({ sent_days: next })
      .eq('id', candidate.id)
      .eq('sent_days', `{${current.join(',')}}`)
  },
}

// ── token minting ───────────────────────────────────────────────────────────

/** 256-bit hex, the same shape subscriptions.ts mints — isSubscriptionToken accepts it. */
export function mintCourseUnsubscribeToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

// ── one dispatch pass ───────────────────────────────────────────────────────

export interface DispatchReport {
  /** Rows the batch looked at. */
  examined: number
  /** Messages the provider accepted. */
  sent: number
  /** Rows with nothing due (or fully caught up). */
  notDue: number
  /** Claims refused by the store — a concurrent run or a fresh opt-out. Not sent. */
  lostClaims: number
  /**
   * Days CLAIMED but not delivered (provider refusal). A definitive refusal
   * (429 / 5xx after retries) is RELEASED (`released: true`) and goes out on
   * the next pass; any other failure keeps the claim, so it is a permanent gap
   * unless an operator intervenes — surfaced here precisely so it is an
   * operator's problem and never a duplicate send.
   */
  failures: { subscriptionId: string; day: number; reason: string; released?: boolean }[]
}

/** Gap between provider calls: Resend's default limit is about 2 requests a second. */
export const SEND_PACE_MS = 500
/** Backoff before each retry of a definitively refused (429/5xx) send. */
export const SEND_RETRY_BACKOFF_MS = [1_000, 3_000] as const

export type SendFn = (input: SendEmailInput) => Promise<SendResult>

/**
 * Process up to `limit` subscriptions once. Sends AT MOST ONE message per
 * subscription per call (courseSchedule.ts drains backlogs one day per run),
 * so `limit` bounds both the query and the provider calls.
 */
export async function runCourseDispatch(input: {
  limit: number
  baseUrl: string
  now?: Date
  store?: CourseDispatchStore
  send?: SendFn
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}): Promise<DispatchReport> {
  const now = input.now ?? new Date()
  const store = input.store ?? supabaseDispatchStore
  const send = input.send ?? sendEmail
  const base = input.baseUrl.replace(/\/+$/, '')
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let sentSomething = false

  const report: DispatchReport = { examined: 0, sent: 0, notDue: 0, lostClaims: 0, failures: [] }
  const candidates = await store.listCandidates(input.limit, now)

  for (const candidate of candidates) {
    report.examined += 1
    const day = dueCourseDay(candidate, now)
    if (day === null) {
      report.notDue += 1
      continue
    }

    // The claim commits BEFORE the provider is called — see the file header.
    const claim = await store.claimDay(candidate, day, mintCourseUnsubscribeToken())
    if (!claim.claimed) {
      report.lostClaims += 1
      continue
    }

    const content = courseDayEmail({
      day,
      baseUrl: base,
      unsubscribeUrl: `${base}/api/email/unsubscribe/course?token=${claim.unsubscribeToken}`,
    })
    const message = {
      to: candidate.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
    }

    // Pace the provider calls, and retry a DEFINITIVE refusal (429 / 5xx) a
    // couple of times. An ambiguous failure (a thrown network error) is never
    // retried or released: the provider may have accepted it.
    if (sentSomething) await sleep(SEND_PACE_MS)
    sentSomething = true
    let result = await send(message)
    for (const backoff of SEND_RETRY_BACKOFF_MS) {
      if (result.sent || !result.retryable) break
      await sleep(backoff)
      result = await send(message)
    }

    if (result.sent) {
      report.sent += 1
      continue
    }
    // Definitively refused after the retries: hand the day back so the next
    // pass sends it, instead of leaving a permanent gap in the course.
    let released = false
    if (result.retryable && store.releaseDay) {
      try {
        await store.releaseDay(candidate, day)
        released = true
      } catch (err) {
        reportError(err, { scope: 'email.dispatch', what: 'releaseDay' })
      }
    }
    report.failures.push({
      subscriptionId: candidate.id,
      day,
      reason: result.reason,
      ...(released ? { released: true } : {}),
    })
  }

  return report
}
