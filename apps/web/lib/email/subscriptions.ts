/**
 * email/subscriptions.ts — the consent record behind the 7-day email course.
 *
 * SERVER ONLY. Reads the service-role key when one is present.
 *
 * This module is prerequisites 1 and 2 from docs/ONBOARDING.md ("Email:
 * nothing is sent, on purpose"): a durable record of "this person asked for
 * mail", and an unsubscribe that actually persists. It is NOT a sender —
 * prerequisite 3 (a scheduler) still does not exist, so no course email is
 * sent from anywhere. What this module makes possible is a future sender that
 * can prove consent and honour opt-out; what it refuses to make possible is
 * sending without either.
 *
 * ── The state machine ───────────────────────────────────────────────────────
 *
 *   signup     → row with consentedAt, confirmedAt null   (nothing sendable)
 *   confirm    → confirmedAt stamped                      (sendable, in theory)
 *   unsubscribe→ unsubscribedAt stamped                   (never sendable)
 *
 * Double opt-in is not a courtesy: anyone can type anyone's address into a
 * form, so the signup row alone proves nothing. Only a click on the link
 * mailed TO the address proves its owner asked. And an unsubscribed row is
 * never resurrected by a stray confirm click — re-subscribing requires a
 * fresh signup and a fresh confirmation, i.e. fresh consent.
 *
 * ── Tokens ──────────────────────────────────────────────────────────────────
 *
 * One 256-bit token per subscription, minted at signup, carried only in the
 * confirm and unsubscribe links mailed to the address. The store holds its
 * SHA-256 (same scheme and same reasoning as lib/orgs/invites.ts): a database
 * dump contains no usable link. The token space is not searchable at any
 * request rate, so possession of a valid token IS the authorisation for both
 * operations — no account, no session, which is exactly what a one-click
 * unsubscribe requires.
 *
 * ── Two backends, honestly ──────────────────────────────────────────────────
 *
 * `supabase` — rows in `email_subscriptions` (supabase/schema-email.sql),
 *   written with the service role; RLS denies all client access.
 * `memory` — a Map in one Node process, used when SUPABASE_SERVICE_ROLE_KEY is
 *   unset. Fine for the documented zero-config dev flow and for these tests.
 *   NOT a consent record: it forgets opt-outs on redeploy, and a forgotten
 *   opt-out is a broken promise. Any future sender must check `durable` and
 *   refuse to send from the memory backend.
 */

import { getServiceSupabase, isServiceRoleConfigured } from '@/lib/billing/entitlements'
import { reportError } from '@/lib/observability/report'

export const SUBSCRIPTIONS_TABLE = 'email_subscriptions'

/** The only purpose that exists. A new mailing needs a new literal here AND a new opt-in. */
export const PURPOSES = ['course-7day'] as const
export type SubscriptionPurpose = (typeof PURPOSES)[number]

export interface SubscriptionRecord {
  id: string
  /** Lower-cased. */
  email: string
  purpose: SubscriptionPurpose
  /** SHA-256 hex of the confirm/unsubscribe token. The token itself is never stored. */
  tokenHash: string
  consentedAt: string
  confirmedAt: string | null
  unsubscribedAt: string | null
  /**
   * Course days already claimed for sending — the sent_days column, owned by
   * the dispatcher (courseDispatch.ts). Carried here so that a REPLACED row
   * (re-signup after an unsubscribe or an abandoned signup) starts the course
   * again from day 1: a fresh consent is a fresh course, not a resumption.
   */
  sentDays: number[]
}

// ── token minting and hashing ───────────────────────────────────────────────
// Same construction as lib/orgs/invites.ts, and for the same reason; kept
// separate so the two features cannot silently start sharing token semantics.

const TOKEN_BYTES = 32

function webCrypto(): Crypto {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (!c || typeof c.getRandomValues !== 'function' || !c.subtle) {
    throw new Error(
      'Web Crypto is unavailable, so a secure subscription token cannot be minted. ' +
        'This needs a browser or Node 18 or newer.'
    )
  }
  return c
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/** SHA-256 of a token, hex. This is the value that goes in the store. */
export async function hashSubscriptionToken(token: string): Promise<string> {
  const digest = await webCrypto().subtle.digest('SHA-256', new TextEncoder().encode(token))
  return toHex(new Uint8Array(digest))
}

/**
 * Cheap shape check before a token is hashed and looked up. Not a security
 * control — the lookup is — but it turns junk into a refusal without a
 * database round trip and bounds the work an anonymous GET can cause.
 */
export function isSubscriptionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

// ── store interface ─────────────────────────────────────────────────────────

/** Thrown when the durable store is configured but unreachable. Routes turn it into a 503. */
export class SubscriptionStoreUnavailableError extends Error {
  constructor(message = 'The subscription store is unreachable.') {
    super(message)
    this.name = 'SubscriptionStoreUnavailableError'
  }
}

export interface SubscriptionStore {
  /** 'supabase' when durable, 'memory' when this process is the only copy. */
  readonly kind: 'supabase' | 'memory'
  readonly durable: boolean
  getByEmail(email: string, purpose: SubscriptionPurpose): Promise<SubscriptionRecord | null>
  getByTokenHash(tokenHash: string): Promise<SubscriptionRecord | null>
  /** Insert or replace the row with this id. */
  upsert(record: SubscriptionRecord): Promise<SubscriptionRecord>
}

// ── memory backend ──────────────────────────────────────────────────────────

const memRecords = new Map<string, SubscriptionRecord>()

const memoryStore: SubscriptionStore = {
  kind: 'memory',
  durable: false,
  async getByEmail(email, purpose) {
    return (
      [...memRecords.values()].find((r) => r.email === email && r.purpose === purpose) ?? null
    )
  },
  async getByTokenHash(tokenHash) {
    return [...memRecords.values()].find((r) => r.tokenHash === tokenHash) ?? null
  },
  async upsert(record) {
    memRecords.set(record.id, { ...record })
    return record
  },
}

// ── Supabase backend ────────────────────────────────────────────────────────

/**
 * Row shape — mirrors supabase/schema-email.sql. snake_case on the wire,
 * camelCase in the app, converted in exactly these two functions.
 */
interface SubscriptionRow {
  id: string
  email: string
  purpose: string
  token_hash: string
  consented_at: string
  confirmed_at: string | null
  unsubscribed_at: string | null
  sent_days: unknown
}

/** int[] arrives as number[]; anything else (an old row, hand edits) reads as "nothing sent". */
function readSentDays(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((d): d is number => Number.isInteger(d)) : []
}

function rowToRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    email: row.email,
    // The schema's CHECK constraint admits only these literals; anything else
    // would mean the table was edited by hand, and 'course-7day' is the safe read.
    purpose: (PURPOSES as readonly string[]).includes(row.purpose)
      ? (row.purpose as SubscriptionPurpose)
      : 'course-7day',
    tokenHash: row.token_hash,
    consentedAt: row.consented_at,
    confirmedAt: row.confirmed_at,
    unsubscribedAt: row.unsubscribed_at,
    sentDays: readSentDays(row.sent_days),
  }
}

/**
 * CORRECTNESS FIX: sent_days is written too. It used to be left out, so the
 * upsert that REPLACES an unsubscribed row on re-signup kept the old send
 * record: a learner who left after day 4 and came back was served day 5
 * first, and one who had finished the course was excluded by the dispatcher
 * for ever — confirmed, told they were signed up, and sent nothing.
 * course_unsubscribe_token is deliberately NOT here: it stays as it was, so
 * the unsubscribe link in any already-delivered mail keeps working.
 */
function recordToRow(record: SubscriptionRecord): SubscriptionRow {
  return {
    id: record.id,
    email: record.email,
    purpose: record.purpose,
    token_hash: record.tokenHash,
    consented_at: record.consentedAt,
    confirmed_at: record.confirmedAt,
    unsubscribed_at: record.unsubscribedAt,
    sent_days: record.sentDays,
  }
}

function client() {
  const supabase = getServiceSupabase()
  if (!supabase) throw new SubscriptionStoreUnavailableError('No service-role client.')
  return supabase
}

/**
 * Any Postgres error is a 503, never an empty result. An unreadable consent
 * row must not look like "no consent row": on the signup path that would mint
 * a duplicate, and on the unsubscribe path it would return a confirmation
 * page for an opt-out that was NOT persisted — the one lie this feature
 * exists to never tell.
 */
function orThrow<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    reportError(result.error, { scope: 'email.subscriptions', what })
    throw new SubscriptionStoreUnavailableError()
  }
  return result.data
}

const supabaseStore: SubscriptionStore = {
  kind: 'supabase',
  durable: true,
  async getByEmail(email, purpose) {
    const data = orThrow(
      await client()
        .from(SUBSCRIPTIONS_TABLE)
        .select('*')
        .eq('email', email)
        .eq('purpose', purpose)
        .maybeSingle(),
      'getByEmail'
    )
    return data ? rowToRecord(data as SubscriptionRow) : null
  },
  async getByTokenHash(tokenHash) {
    const data = orThrow(
      await client()
        .from(SUBSCRIPTIONS_TABLE)
        .select('*')
        .eq('token_hash', tokenHash)
        .maybeSingle(),
      'getByTokenHash'
    )
    return data ? rowToRecord(data as SubscriptionRow) : null
  },
  async upsert(record) {
    orThrow(
      await client().from(SUBSCRIPTIONS_TABLE).upsert(recordToRow(record), { onConflict: 'id' }),
      'upsert'
    )
    return record
  },
}

/**
 * The store this deployment is actually using. Resolved per call rather than
 * memoised, for the same reason as getExamStore in lib/exams/store.ts: tests
 * set the environment before importing.
 */
export function getSubscriptionStore(): SubscriptionStore {
  return isServiceRoleConfigured ? supabaseStore : memoryStore
}

// ── the state machine, as three operations ──────────────────────────────────
// Pure of HTTP on purpose: the route handlers translate these results into
// responses, and the tests exercise these directly against the memory store.

export type SignupOutcome =
  /** A confirm mail should be sent carrying this token. */
  | { kind: 'send-confirm'; token: string }
  /** Already confirmed and not opted out — send nothing, say nothing different. */
  | { kind: 'already-confirmed' }

/**
 * Record a signup and mint the token for its confirm mail.
 *
 * A repeat signup for an unconfirmed or unsubscribed row REPLACES the row:
 * new token, new consentedAt, confirmation and opt-out reset, and the course
 * send record (sentDays) emptied so the course starts again at day 1. That
 * is the only path back in after an unsubscribe, and it goes through a fresh
 * double-opt-in — the old row's state never silently becomes consent.
 *
 * An already-confirmed, not-unsubscribed row gets NO new mail: otherwise this
 * endpoint is a primitive for making the app repeatedly mail any confirmed
 * address a stranger happens to know. The caller must respond identically in
 * both cases so the outcome is not an address-probing oracle.
 */
export async function beginSubscription(
  email: string,
  purpose: SubscriptionPurpose,
  store: SubscriptionStore = getSubscriptionStore()
): Promise<SignupOutcome> {
  const normalised = email.trim().toLowerCase()
  const existing = await store.getByEmail(normalised, purpose)
  if (existing && existing.confirmedAt && !existing.unsubscribedAt) {
    return { kind: 'already-confirmed' }
  }

  const bytes = new Uint8Array(TOKEN_BYTES)
  webCrypto().getRandomValues(bytes)
  const token = toHex(bytes)

  await store.upsert({
    id: existing?.id ?? webCrypto().randomUUID(),
    email: normalised,
    purpose,
    tokenHash: await hashSubscriptionToken(token),
    consentedAt: new Date().toISOString(),
    confirmedAt: null,
    unsubscribedAt: null,
    sentDays: [],
  })
  return { kind: 'send-confirm', token }
}

export type ConfirmOutcome = 'confirmed' | 'already-confirmed' | 'invalid'

/**
 * Stamp confirmedAt for the row holding this token's hash.
 *
 * Idempotent: a second click reports 'already-confirmed' and changes nothing.
 * A token whose row has been unsubscribed is 'invalid' — a stale confirm link
 * must not undo an opt-out.
 */
export async function confirmSubscriptionByToken(
  token: unknown,
  store: SubscriptionStore = getSubscriptionStore()
): Promise<ConfirmOutcome> {
  if (!isSubscriptionToken(token)) return 'invalid'
  const record = await store.getByTokenHash(await hashSubscriptionToken(token))
  if (!record || record.unsubscribedAt) return 'invalid'
  if (record.confirmedAt) return 'already-confirmed'
  await store.upsert({ ...record, confirmedAt: new Date().toISOString() })
  return 'confirmed'
}

export type UnsubscribeOutcome = 'unsubscribed' | 'already-unsubscribed' | 'unknown'

/**
 * Stamp unsubscribedAt for the row holding this token's hash.
 *
 * Idempotent, and the caller shows the same confirmation page for all three
 * outcomes: the person clicking wants out, and "out" is true in every case —
 * including 'unknown', where there is no row to be subscribed by. The
 * distinction exists only so tests can assert the write actually happened.
 */
export async function unsubscribeByToken(
  token: unknown,
  store: SubscriptionStore = getSubscriptionStore()
): Promise<UnsubscribeOutcome> {
  if (!isSubscriptionToken(token)) return 'unknown'
  const record = await store.getByTokenHash(await hashSubscriptionToken(token))
  if (!record) return 'unknown'
  if (record.unsubscribedAt) return 'already-unsubscribed'
  await store.upsert({ ...record, unsubscribedAt: new Date().toISOString() })
  return 'unsubscribed'
}

/** Empties the in-process store. For tests only; a no-op against Supabase. */
export function __resetSubscriptionStoreForTests(): void {
  memRecords.clear()
}
