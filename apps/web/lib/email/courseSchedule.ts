/**
 * email/courseSchedule.ts — which course day is due, as arithmetic.
 *
 * Pure on purpose: no store, no clock, no environment. The dispatch route
 * (app/api/email/dispatch) supplies a subscription row and "now", and this
 * module answers one question — "which day of the 7-day course, if any,
 * should be sent to this subscriber right now?" — so the answer is testable
 * without a database and identical however it is invoked.
 *
 * ── The schedule ────────────────────────────────────────────────────────────
 *
 * Day N becomes due at confirmed_at + (N−1) × 24h. Day 1 is due the moment
 * the confirmation is clicked. The launch doc asks for "07:00 local"; the
 * server cannot know a subscriber's timezone from an email address, so the
 * delivery HOUR is set by when the operator runs dispatch (the schedule they
 * put it on), and this module only guarantees "never early": day N is not
 * offered before N−1 whole days have passed since confirmation.
 *
 * ── Idempotency and catch-up ────────────────────────────────────────────────
 *
 * `sentDays` is the send record (the sent_days column on the subscription
 * row). dueCourseDay returns the LOWEST unsent day that is due, so:
 *   • a day already in sentDays is never offered again — a re-run of
 *     dispatch after a crash sends nothing twice;
 *   • a backlog (subscriber confirmed a week ago, dispatch just switched on)
 *     drains ONE message per dispatch run, in order, never a seven-mail
 *     burst into one inbox.
 * Days are always offered in order: day 3 is not sendable while day 2 is
 * unsent, even if both are due.
 */

/** The course length. The template array in templates.ts must match. */
export const COURSE_LENGTH_DAYS = 7

export type CourseDay = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** One course day, in milliseconds. Exported so the dispatcher's due filter uses the same clock arithmetic. */
export const COURSE_DAY_MS = 24 * 60 * 60 * 1000
const DAY_MS = COURSE_DAY_MS

export function isCourseDay(value: unknown): value is CourseDay {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= COURSE_LENGTH_DAYS
  )
}

/**
 * Normalise a sent_days value read from the store. Postgres int[] arrives as
 * number[]; anything malformed (duplicates, out-of-range, junk types) is
 * dropped rather than crashing the whole dispatch batch on one bad row —
 * dropping an invalid entry can only cause a re-send attempt, which the
 * atomic claim in courseDispatch.ts refuses anyway.
 */
export function normaliseSentDays(value: unknown): CourseDay[] {
  if (!Array.isArray(value)) return []
  const days = new Set<CourseDay>()
  for (const entry of value) {
    if (isCourseDay(entry)) days.add(entry)
  }
  return [...days].sort((a, b) => a - b)
}

export interface CourseScheduleInput {
  /** ISO timestamp of the double-opt-in click, or null when unconfirmed. */
  confirmedAt: string | null
  /** ISO timestamp of the opt-out, or null. Any value at all means: never send. */
  unsubscribedAt: string | null
  /** Days already sent (or claimed for sending) — the sent_days column. */
  sentDays: readonly number[]
}

/**
 * The highest day the calendar alone permits: 0 before confirmation (and for
 * an unparseable timestamp — an unreadable consent date must fail closed,
 * not default to "everything is due"), N after N−1 whole days.
 */
export function highestDueDay(confirmedAt: string | null, now: Date): number {
  if (!confirmedAt) return 0
  const confirmed = Date.parse(confirmedAt)
  if (Number.isNaN(confirmed)) return 0
  const elapsed = now.getTime() - confirmed
  if (elapsed < 0) return 0
  return Math.min(COURSE_LENGTH_DAYS, Math.floor(elapsed / DAY_MS) + 1)
}

/**
 * The one day to send this subscriber in this dispatch run, or null.
 *
 * null means one of: unconfirmed, unsubscribed, nothing due yet, or every
 * due day already sent (including "course complete"). The caller does not
 * need to distinguish — in every case the correct action is to send nothing.
 */
export function dueCourseDay(input: CourseScheduleInput, now: Date): CourseDay | null {
  if (input.unsubscribedAt) return null
  const highest = highestDueDay(input.confirmedAt, now)
  if (highest === 0) return null
  const sent = new Set(normaliseSentDays(input.sentDays))
  for (let day = 1; day <= highest; day += 1) {
    if (!sent.has(day as CourseDay)) return day as CourseDay
  }
  return null
}

/** True once every day of the course is in sentDays. */
export function isCourseComplete(sentDays: readonly number[]): boolean {
  return normaliseSentDays(sentDays).length === COURSE_LENGTH_DAYS
}
