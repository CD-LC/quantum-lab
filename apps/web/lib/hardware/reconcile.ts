/**
 * reconcile.ts — sweep hardware jobs whose last observed state is stale.
 *
 * SERVER ONLY. Never import this from a client component: it builds the
 * service-role Supabase client and it presents the upstream shared secret.
 *
 * ── The hole this fills ─────────────────────────────────────────────────────
 *
 * `GET /api/hardware/job/{provider}/{job_id}` is the ONLY thing on this
 * platform that has ever observed a hardware job. Submission is asynchronous
 * at the vendor and nothing calls us back, so the job's row in
 * `public.hardware_usage` only learns what happened if a browser tab is open
 * and polling when it happens. Submit a circuit, close the tab, and the row
 * says `queued` for as long as the row exists — however long ago IBM actually
 * finished it. `components/hardware/JobHistory` renders that honestly as
 * "never checked" rather than guessing, which is the right call for a
 * renderer and no fix at all for the data.
 *
 * This module is the fix: find the rows nobody is watching, ask the vendor,
 * write down the answer.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * EXPECTATION VALUES ARE NOT RECONCILED. An Estimator job's numbers are
 * meaningless without the observable labels in submission order — IBM stores
 * the operators but not our names for them, which is why the poll route
 * accepts `?observables=` from the caller, who is the only party that has
 * them. WE DO NOT STORE THOSE LABELS ANYWHERE (there is no column for them on
 * `hardware_usage`, and none for the values either). So an estimator job is
 * reconciled to its STATUS and nothing more, and the report counts those rows
 * separately so an operator can see that a class of job is being half-served.
 * The rejected alternative was synthesising positional labels ("obs_0",
 * "obs_1"): that would produce a stored record that looks like a result and
 * cannot be matched back to the Hamiltonian terms it came from, which is worse
 * than an honest gap. Fixing this properly needs a column — see the note at
 * the bottom of this file.
 *
 * BYOK JOBS ARE POLLED WITH THEIR OWNER'S CREDENTIAL. A job submitted on a
 * user's own vendor token (`credential_owner = 'user'`) is invisible to the
 * operator's token — the vendor answers "no such job" — exactly as the poll
 * route's own comment explains. So for those rows the sweep opens the stored
 * credential (`resolveSubmissionCredential`, the same decision the submit and
 * poll routes make) and presents it for that one request. When the credential
 * is gone (removed, or the encryption key rotated) or the store refuses, the
 * row is counted `unreachable` and left untouched: polling it with the
 * operator's token could only produce a misleading 404.
 *
 * A 404 FROM THE VENDOR IS NOT WRITTEN DOWN as an error. A job id the vendor
 * no longer serves and an upstream that is misconfigured for five minutes look
 * identical from here, and recording the second one as a permanent `error`
 * would destroy a real result. Those rows are counted as `unreachable` and
 * left exactly as they were.
 *
 * NO WEBHOOK IS FIRED. The poll route dispatches `hardware_job_finished`
 * through lib/integrations/webhooks when it observes a terminal state; this
 * sweep does NOT, so a user with an integration configured is notified about
 * exactly the jobs they were already watching and not about the ones this
 * module exists for. That is backwards, and it is a gap rather than a
 * decision: wiring it needs a deliberate
 * answer to the first-sweep problem (the first pass after this ships will find
 * every historical `queued` row at once and would notify for jobs that
 * finished weeks ago, bounded only by the batch limit). Left unwired rather
 * than shipped quietly, because a burst of stale notifications is worse than a
 * documented silence.
 *
 * THE WALL-CLOCK BUDGET BELOW IS NOT ENFORCED BY THE PLATFORM. See
 * DEFAULT_DEADLINE_MS: if the hosting platform's function timeout is shorter
 * than the budget, the invocation is killed and no report is produced at all,
 * which is the outcome the budget was meant to avoid.
 *
 * ── Overlap safety (two crons, or a cron and a retry) ───────────────────────
 *
 * Three independent guards, because a sweep is the easiest thing in a codebase
 * to accidentally run twice:
 *
 *  1. The patch only ever carries fields that were actually observed. This is
 *     `recordHardwareResult`'s rule in lib/billing/usage.ts and it is copied
 *     here on purpose — a `counts: null` written by a poll that saw `queued`
 *     would erase the histogram of a job that has already finished.
 *  2. Every UPDATE is guarded to rows that are still non-terminal. So if run B
 *     wrote `done` while run A was in flight, A's late `queued` matches zero
 *     rows instead of dragging the job backwards.
 *  3. An in-process set of jobs currently being polled, so two overlapping
 *     runs IN THE SAME PROCESS do not both spend a vendor round trip on the
 *     same job. Across instances this is at-least-once, not at-most-once, and
 *     guard 2 is what makes that harmless rather than corrupting.
 */

import { getServiceSupabase, isServiceRoleConfigured } from '@/lib/billing/entitlements'
import { resolveSubmissionCredential } from '@/lib/hardware/byok'
import { forward, forwardedJson } from '@/lib/hardware/proxy'
import { isTerminalStatus } from '@/lib/hardware/types'
import type { ResolvedCredential } from '@/lib/security/providerCredentials'

/**
 * Default rows per pass. Bounded because a sweep with no bound is a way to
 * turn one cron tick into several hundred vendor round trips; also because a
 * serverless invocation has a wall-clock limit and a half-finished unbounded
 * pass reports nothing.
 */
export const DEFAULT_BATCH_LIMIT = 50

/** Hard ceiling on a caller-supplied batch size. */
export const MAX_BATCH_LIMIT = 200

/**
 * How long a job must have been SUBMITTED before the sweep touches it.
 *
 * SAY WHAT THIS IS, BECAUSE IT IS NOT WHAT IT LOOKS LIKE. There is no column
 * recording when a row was last observed (see the note at the bottom), so this
 * grace runs from `created_at` — submission — and nothing else. It therefore
 * does NOT mean "unobserved for a minute": a job a browser tab is actively
 * polling right now is swept anyway, one minute after it was submitted, and
 * the sweep and the tab poll it in parallel for as long as it runs. That costs
 * a duplicated vendor round trip per cron tick per watched job; it cannot
 * corrupt anything (both writers obey the observed-fields-only and
 * non-terminal-guard rules) and it is the price of having no `reconciled_at`.
 *
 * A minute is short enough that a closed tab costs at most one cron interval,
 * and long enough that the submit → first-poll handoff is not raced.
 */
export const DEFAULT_GRACE_MS = 60_000

/**
 * Rows older than this are not swept, and this is an ANTI-STARVATION measure
 * rather than a policy about old data.
 *
 * The batch is ordered oldest-first (the jobs most likely to be finished and
 * most likely to have been forgotten). Without a floor, a row that can never
 * be resolved — the vendor purged the job, the id was stamped from an account
 * whose credentials are gone — sits at the head of that ordering forever and
 * consumes a slot on every single pass, so the newer rows behind it are never
 * reached. There is no `reconciled_at` column to back off on (see the note at
 * the bottom), so the floor is the cheap version of that backoff. Thirty days
 * is past every vendor's result-retention window we know of.
 */
export const STALE_FLOOR_DAYS = 30

/** Vendor polls run in parallel; small, because each one is a paid API's RPS. */
const DEFAULT_CONCURRENCY = 4

/**
 * Wall-clock budget for one pass. `forward` gives each poll up to 8s, so a
 * batch of slow jobs could otherwise run for minutes. Stopping early and
 * SAYING SO is strictly better than being terminated silently.
 *
 * TWO LIMITS ON THAT PROMISE, both real:
 *
 *  · The budget is checked BETWEEN polls, never inside one, so a pass can
 *    overrun it by up to one `forward` timeout (8s) before it stops.
 *  · It is only a promise against the PLATFORM's timeout if the platform
 *    allows at least 28s. This route declares no `maxDuration`, and a serverless
 *    default below that (Vercel Hobby is 10s) kills the invocation before this
 *    check ever fires — the cron then gets a platform error instead of a
 *    report, and the rows are simply left for the next tick. Nothing is
 *    corrupted by that (every write is a single guarded statement), but the
 *    operator learns nothing, which is the failure this constant was supposed
 *    to prevent. An operator whose platform caps below 28s should lower this
 *    and raise the cron frequency.
 */
const DEFAULT_DEADLINE_MS = 20_000

/**
 * The five states `_normalise_ibm_status` / `_normalise_braket_status` in
 * services/api/app/quantum/hardware.py map every vendor status onto, and the
 * only values this module will write.
 *
 * WHY IT IS A HARD FILTER AND NOT A CAST. The sweep's own SELECT asks for rows
 * whose status is null, `queued` or `running`. Writing any other string —
 * a vendor state that slipped through unnormalised, a future upstream that
 * grows a sixth state — makes the row invisible to this sweep FOREVER while
 * also not being terminal: it would never be swept again, never finish, and
 * `isTerminalStatus` would keep calling it live. So an unrecognised status is
 * counted and dropped rather than stored. The rejected alternative was writing
 * it through and letting the reader cope, which is how a row becomes
 * permanently stuck in a state nothing in this codebase understands.
 */
const KNOWN_STATES = new Set(['queued', 'running', 'done', 'error', 'cancelled'])

/** Providers `poll_job()` in services/api/app/quantum/hardware.py dispatches on. */
const PROVIDERS = new Set(['ibm', 'braket', 'azure'])

/**
 * The shape of a real job handle. Same charset as the poll route's, and for
 * the same reason: no dot means `..` cannot be spelled, so a poisoned row
 * cannot aim `forward` — which carries the operator's shared secret — at some
 * other upstream path such as `/api/circuits/run`. These values came out of
 * our own database, but they were originally vendor-supplied strings, and a
 * traversal guard that trusts its own storage is not a guard.
 */
const JOB_SEGMENT = /^[A-Za-z0-9:_-]+$/

/**
 * PostgREST filter for "not yet finished", used on BOTH the select and the
 * update. Spelled as an `or` rather than `status.not.in.(...)` because SQL's
 * `NOT IN` against a NULL yields NULL, which would exclude precisely the rows
 * this sweep exists for: the ones no poll has ever seen.
 */
const NON_TERMINAL_FILTER = 'status.is.null,status.in.(queued,running)'

/** Columns the sweep needs, and only those. `qasm` is deliberately not among
 *  them — it is the largest column in the table and nothing here reads it.
 *  `user_id` and `credential_owner` ARE here, and only for one purpose: a job
 *  submitted on a user's own vendor credential can only be read back with that
 *  credential, so the sweep has to know whose it is. Neither is written back
 *  or reported. */
const SWEEP_COLUMNS = 'id, provider, job_id, status, created_at, user_id, credential_owner'

/** The same select for a database that predates `credential_owner`
 *  (supabase/schema-byok.sql not applied yet): every row is then operator
 *  funded, which is also how `usage.ts` reads such a row. */
const LEGACY_SWEEP_COLUMNS = 'id, provider, job_id, status, created_at'

/**
 * The service-role client, non-null.
 *
 * Named because the poll loop below captures it inside a closure, and TypeScript
 * does not carry a null-check's narrowing into a function that is called later —
 * so the narrowed value is re-bound once, under this type, rather than cast at
 * each use.
 */
type ServiceClient = NonNullable<ReturnType<typeof getServiceSupabase>>

/** One `hardware_usage` row as the sweep reads it. */
interface SweepRow {
  id: string
  provider: string
  jobId: string
  status: string | null
  createdAt: string
  /** Whose vendor credential the job was submitted with. */
  credentialOwner: 'operator' | 'user'
  /** The owning account; only ever used to open a BYOK credential. */
  userId: string
}

/** Why a pass stopped where it did. Never absent — silence reads as "done". */
export type ReconcileStop =
  /** Every eligible row in the snapshot was attempted. */
  | 'complete'
  /** The batch bound was reached; `remaining` says how many were left. */
  | 'batch_limit'
  /** The wall-clock budget ran out mid-pass. */
  | 'deadline'
  /** No service-role Supabase client, so nothing was read or written. */
  | 'not_configured'
  /** The store refused the query. Nothing was polled. */
  | 'store_unavailable'

/** What one pass did. Every field is a count of something that happened. */
export interface ReconcileReport {
  /** False when there is no service-role client; every count is then zero. */
  configured: boolean
  /** Why the pass ended. */
  stoppedBecause: ReconcileStop
  /**
   * Eligible rows at the moment the pass STARTED, or null when the count query
   * was refused. A snapshot: jobs submitted during the pass are not in it.
   */
  eligible: number | null
  /** Rows selected for this pass (at most `limit`). */
  claimed: number
  /** Rows a vendor was actually asked about. */
  polled: number
  /** Rows whose row was updated with a freshly observed status. */
  updated: number
  /**
   * Rows polled successfully whose state had NOT moved, so no write was
   * issued.
   *
   * Reported separately for the same reason `raced` is: a batch of fifty jobs
   * that have been stuck in a vendor queue for a week would otherwise report
   * `updated: 50` on every single tick, forever, and an operator reading that
   * number would conclude the sweep was doing fifty units of work a minute.
   */
  unchanged: number
  /** Of those, the ones that reached done/error/cancelled. */
  finished: number
  /** Rows the upstream could not answer for. Left untouched. */
  unreachable: number
  /** Estimator jobs reconciled to status only, for want of stored labels. */
  estimatorWithoutLabels: number
  /**
   * Rows whose write matched nothing because the non-terminal guard held —
   * another pass (or a user's own poll) had already finished the job. Harmless
   * by construction; a persistently large number means two sweeps are
   * overlapping and one of them is redundant.
   */
  raced: number
  /**
   * Rows polled successfully whose write the store then refused.
   *
   * Counted because the alternative is an accounting hole: every other outcome
   * of a poll lands in exactly one counter, so without this one a pass in which
   * the database refused all fifty writes reported `polled: 50` with every
   * other number at zero and `stoppedBecause: 'complete'` — a green cron over a
   * store that is not accepting writes. The per-row reason is in the server log
   * (it names Postgres internals and is not for the wire).
   */
  writeFailed: number
  /** Rows skipped because another pass in this process held them. */
  skippedInFlight: number
  /** Rows whose provider or job id did not look like a real handle. */
  skippedMalformed: number
  /**
   * Rows the upstream answered for with a status outside the five normalised
   * states. Nothing was written. See KNOWN_STATES: writing one of these would
   * drop the row out of this sweep's own filter permanently.
   */
  skippedUnknownStatus: number
  /**
   * Eligible rows NOT attempted this pass, or null when the count was refused.
   * Reported because a silent cap reads as "everything is reconciled".
   */
  remaining: number | null
  /** Operator-facing sentence. Safe to log; names no user data. */
  note: string
}

/** Knobs, all optional. Defaults are the constants above. */
export interface ReconcileOptions {
  /** Rows per pass, clamped to `MAX_BATCH_LIMIT`. */
  limit?: number
  /** How long a row must have been unobserved. */
  graceMs?: number
  /** Wall-clock budget for the whole pass. */
  deadlineMs?: number
  /** Vendor polls in flight at once. */
  concurrency?: number
  /**
   * Injectable clock for the ELIGIBILITY WINDOW ONLY — it shifts `staleBefore`
   * and the stale floor, and nothing else.
   *
   * It deliberately does NOT move the deadline, which is anchored to the real
   * `Date.now()`. An earlier version anchored both here, which meant a test (or
   * a caller) passing a fixed epoch silently produced a deadline in the past:
   * the pass then polled nothing, reported `deadline`, and looked like a
   * working sweep with a slow upstream.
   */
  now?: number
}

/**
 * Jobs currently being polled by this process, keyed `provider/jobId`.
 *
 * Module scope, so it spans overlapping calls within one instance. It is NOT a
 * distributed lock and must not be mistaken for one: a second instance sweeps
 * the same rows quite happily. The non-terminal guard on the UPDATE is what
 * makes that safe; this set only saves the duplicated vendor round trip.
 */
const inFlight = new Set<string>()

/** Clears the in-flight set. Tests only — a leak here would skip real rows. */
export function __resetReconcileForTests(): void {
  inFlight.clear()
}

/** An empty report, so every early return has the same shape. */
function emptyReport(stop: ReconcileStop, note: string, configured = true): ReconcileReport {
  return {
    configured,
    stoppedBecause: stop,
    eligible: null,
    claimed: 0,
    polled: 0,
    updated: 0,
    unchanged: 0,
    finished: 0,
    unreachable: 0,
    estimatorWithoutLabels: 0,
    raced: 0,
    writeFailed: 0,
    skippedInFlight: 0,
    skippedMalformed: 0,
    skippedUnknownStatus: 0,
    remaining: null,
    note,
  }
}

/**
 * Normalise a PostgREST row into a `SweepRow`, or null when it is unusable.
 *
 * @param row A `hardware_usage` row as PostgREST returned it.
 * @returns The row, or null when provider/job_id are missing or malformed.
 */
function toSweepRow(row: unknown): SweepRow | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const provider = typeof r.provider === 'string' ? r.provider : ''
  const jobId = typeof r.job_id === 'string' ? r.job_id : ''
  if (!id || !PROVIDERS.has(provider) || !jobId) return null
  // Braket task ids are ARNs and contain slashes; every segment must still
  // look like a handle. See JOB_SEGMENT.
  const segments = jobId.split('/')
  if (segments.length === 0 || segments.length > 8 || jobId.length > 512) return null
  if (!segments.every((segment) => JOB_SEGMENT.test(segment))) return null
  return {
    id,
    provider,
    jobId,
    status: typeof r.status === 'string' ? r.status : null,
    createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    credentialOwner: r.credential_owner === 'user' ? 'user' : 'operator',
    userId: typeof r.user_id === 'string' ? r.user_id : '',
  }
}

/** Is this a measurement histogram? Copied from the poll route's check, and
 *  for the same reason: the value is about to enter a `jsonb` column and be
 *  served back as somebody's experimental record, so an array or a string must
 *  not be stored happily and break every reader downstream. */
function isCountsRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(
    ([key, count]) =>
      /^[01]+$/.test(key) && typeof count === 'number' && Number.isFinite(count) && count >= 0
  )
}

/** What one vendor poll told us. Absent fields were NOT observed. */
interface Observation {
  status: string
  counts?: Record<string, number>
  error?: string
  qpuSeconds?: number
  backend?: string
  /** True when the payload is an Estimator result (we cannot store its values). */
  estimator: boolean
}

/**
 * Ask the upstream about one job.
 *
 * Polls WITHOUT `?observables=`: we do not store observable labels, so there
 * is nothing to send, and the upstream answers an estimator poll with
 * positional names. See the header — those values are not written down.
 *
 * @param row The row to poll.
 * @returns What the vendor said, or null when the upstream could not answer.
 */
async function pollUpstream(row: SweepRow): Promise<Observation | null> {
  const path = row.jobId
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  // A BYOK job is only visible to the vendor account it was submitted on, so
  // it is polled with that account's credential or not at all. A missing
  // credential or an unreadable store is "could not answer", never a fallback
  // to the operator's token (which would only get a misleading 404).
  let credential: ResolvedCredential | null = null
  if (row.credentialOwner === 'user') {
    if (!row.userId) return null
    try {
      credential = await resolveSubmissionCredential(row.userId, row.provider, null)
    } catch (err) {
      console.error(
        `[hardware/reconcile] could not open the BYOK credential for ${row.provider}/${row.jobId}: ` +
          String(err)
      )
      return null
    }
    if (!credential) return null
  }

  let data: Record<string, unknown> | null
  try {
    // `forward` presents the operator's shared secret. That is legitimate
    // here and only here: the job id was not supplied by any caller, it was
    // read out of our own `hardware_usage` table, and the cron secret has
    // already been checked by the route. Nothing from this response is
    // returned to the caller — it goes into the row.
    const response = await forward(
      `/api/hardware/job/${row.provider}/${path}`,
      undefined,
      undefined,
      credential
    )
    data = await forwardedJson(response)
  } catch {
    // `forward` swallows its own network failures into a 504, so reaching here
    // means something unexpected. Same outcome either way: leave the row.
    return null
  }
  if (!data) return null

  const status = typeof data.status === 'string' ? data.status : null
  if (!status) return null

  const observation: Observation = {
    status,
    estimator:
      data.primitive === 'estimator' ||
      (Array.isArray(data.expectation_values) && data.expectation_values.length > 0),
  }
  if (isCountsRecord(data.counts)) observation.counts = data.counts
  if (typeof data.error === 'string' && data.error.length > 0) observation.error = data.error
  if (typeof data.qpu_seconds === 'number' && Number.isFinite(data.qpu_seconds)) {
    observation.qpuSeconds = data.qpu_seconds
  }
  // The device the job actually RAN on, which IBM can change when the named
  // one is retired mid-queue.
  if (typeof data.backend === 'string' && data.backend.length > 0) {
    observation.backend = data.backend
  }
  return observation
}

/**
 * Write one observation onto its row.
 *
 * Two rules, both load-bearing, both inherited from `recordHardwareResult` in
 * lib/billing/usage.ts:
 *
 *  · The patch carries ONLY what was observed. A queued poll must not write a
 *    null over a finished job's counts.
 *  · The UPDATE is guarded to rows that are still non-terminal, so a late
 *    write from an overlapping pass matches nothing instead of reopening a
 *    job that another pass already closed.
 *
 * Keyed on the row's primary key rather than on (user_id, provider, job_id):
 * the row came from our own select, so its id is exact, and the sweep is
 * cross-account by nature so there is no caller identity to scope to.
 *
 * The update asks for the changed ids back (`.select('id')`) rather than
 * firing and forgetting. Without that, a write the guard blocked and a write
 * that landed are indistinguishable, and the report would count a race as an
 * update — which is exactly the kind of number that makes a sweep look busier
 * and more correct than it is.
 *
 * NEVER THROWS. One unwritable row must not end the pass.
 *
 * @param supabase Service-role client.
 * @param row The row being reconciled.
 * @param observation What the vendor said.
 * @returns 'updated' when a row changed, 'unchanged' when the observation
 *   matched what the row already said and no statement was issued, 'raced'
 *   when the guard matched nothing because another pass had already finished
 *   the job, 'failed' when the store refused the write.
 */
async function applyObservation(
  supabase: ServiceClient,
  row: SweepRow,
  observation: Observation
): Promise<'updated' | 'unchanged' | 'raced' | 'failed'> {
  const patch: Record<string, unknown> = { status: observation.status }
  if (observation.counts) patch.counts = observation.counts
  if (observation.error) patch.error = observation.error
  if (observation.qpuSeconds !== undefined) patch.qpu_seconds = observation.qpuSeconds
  if (observation.backend) patch.backend = observation.backend
  if (isTerminalStatus(observation.status)) {
    // Observed-at, not the vendor's completion time. We only learn of it now,
    // and claiming otherwise would put a precision on this column it does not
    // have (supabase/apply-2026-09-hardware.sql says the same).
    patch.completed_at = new Date().toISOString()
  }

  // Nothing moved: the job is in the same non-terminal state the row already
  // records and the poll produced no field the row does not have. Skipping the
  // statement is not only a saved write — it is what keeps `updated` honest. A
  // job stuck in IBM's queue for a week is polled on every tick, and issuing
  // `set status = 'queued'` where it already says `queued` would report fifty
  // reconciliations a minute for a table in which nothing at all is changing.
  // The row is still counted as polled, so the sweep does not look idle either.
  if (Object.keys(patch).length === 1 && observation.status === row.status) {
    return 'unchanged'
  }

  try {
    const { data, error } = await supabase
      .from('hardware_usage')
      .update(patch)
      .eq('id', row.id)
      .or(NON_TERMINAL_FILTER)
      .select('id')
    if (error) {
      console.error(
        `[hardware/reconcile] could not write ${row.provider}/${row.jobId}: ${error.message}`
      )
      return 'failed'
    }
    return Array.isArray(data) && data.length > 0 ? 'updated' : 'raced'
  } catch (err) {
    console.error(
      `[hardware/reconcile] could not write ${row.provider}/${row.jobId} ` +
        `(store unreachable): ${String(err)}`
    )
    return 'failed'
  }
}

/**
 * One bounded reconciliation pass over unobserved hardware jobs.
 *
 * NEVER THROWS: every failure is a field in the report. This runs from a cron,
 * and a cron that gets a 500 tells an operator nothing about how far it got.
 *
 * @param options Batch bound, grace period, deadline, concurrency, clock.
 * @returns What the pass did, including what it did NOT get to.
 */
export async function reconcileHardwareJobs(
  options: ReconcileOptions = {}
): Promise<ReconcileReport> {
  if (!isServiceRoleConfigured) {
    return emptyReport(
      'not_configured',
      'SUPABASE_SERVICE_ROLE_KEY is not set, so hardware_usage cannot be written ' +
        '(RLS denies the write to ordinary users). Nothing was swept.',
      false
    )
  }
  const client = getServiceSupabase()
  if (!client) {
    return emptyReport(
      'not_configured',
      'The service-role Supabase client could not be constructed. Nothing was swept.',
      false
    )
  }
  // See ServiceClient: the poll loop captures this, and the narrowing does not
  // survive the closure.
  const supabase: ServiceClient = client

  const limit = Math.min(
    MAX_BATCH_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_BATCH_LIMIT))
  )
  const now = options.now ?? Date.now()
  const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS)
  // Anchored to the REAL clock, never to `options.now` — see ReconcileOptions.
  const deadline = Date.now() + Math.max(1_000, options.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))

  const staleBefore = new Date(now - graceMs).toISOString()
  const floor = new Date(now - STALE_FLOOR_DAYS * 86_400_000).toISOString()

  // The count comes FIRST, so `remaining` is derived from the same snapshot the
  // batch is taken from. Its own round trip, because PostgREST cannot give an
  // exact total and a bounded page in one request without `count=exact` on the
  // page itself — which would make the expensive count run per pass anyway.
  let eligible: number | null = null
  try {
    const { count, error } = await supabase
      .from('hardware_usage')
      .select('id', { count: 'exact', head: true })
      .not('job_id', 'is', null)
      .or(NON_TERMINAL_FILTER)
      .lt('created_at', staleBefore)
      .gt('created_at', floor)
    eligible = error ? null : typeof count === 'number' ? count : null
  } catch {
    eligible = null
  }

  let rawRows: unknown[]
  try {
    const selectBatch = (columns: string) =>
      supabase
        .from('hardware_usage')
        .select(columns)
        .not('job_id', 'is', null)
        .or(NON_TERMINAL_FILTER)
        .lt('created_at', staleBefore)
        .gt('created_at', floor)
        // Oldest first: the jobs most likely to have finished, and the ones a
        // user is least likely to still have a tab open on. STALE_FLOOR_DAYS is
        // what stops an unresolvable old row from owning this slot forever.
        .order('created_at', { ascending: true })
        .limit(limit)
    let { data, error } = await selectBatch(SWEEP_COLUMNS)
    if (error && /credential_owner/i.test(error.message ?? '')) {
      // Pre-BYOK schema: no such column, so no row can be BYOK funded.
      ;({ data, error } = await selectBatch(LEGACY_SWEEP_COLUMNS))
    }
    if (error) {
      return emptyReport(
        'store_unavailable',
        `hardware_usage could not be read (${error.message}). Nothing was polled.`
      )
    }
    rawRows = Array.isArray(data) ? data : []
  } catch (err) {
    return emptyReport(
      'store_unavailable',
      `hardware_usage could not be read (${String(err)}). Nothing was polled.`
    )
  }

  const report: ReconcileReport = {
    configured: true,
    stoppedBecause: 'complete',
    eligible,
    claimed: rawRows.length,
    polled: 0,
    updated: 0,
    unchanged: 0,
    finished: 0,
    unreachable: 0,
    estimatorWithoutLabels: 0,
    raced: 0,
    writeFailed: 0,
    skippedInFlight: 0,
    skippedMalformed: 0,
    skippedUnknownStatus: 0,
    remaining: null,
    note: '',
  }

  const rows: SweepRow[] = []
  for (const raw of rawRows) {
    const row = toSweepRow(raw)
    if (!row) {
      // A row whose handle does not parse can never be polled. Counted rather
      // than silently dropped: a non-zero number here means either a schema
      // drift or a bad stamp on submit, and both are worth seeing.
      report.skippedMalformed += 1
      continue
    }
    rows.push(row)
  }

  let cursor = 0
  let attempted = 0
  let hitDeadline = false

  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() >= deadline) {
        hitDeadline = true
        return
      }
      const index = cursor
      cursor += 1
      if (index >= rows.length) return
      const row = rows[index]
      const key = `${row.provider}/${row.jobId}`
      if (inFlight.has(key)) {
        report.skippedInFlight += 1
        continue
      }
      inFlight.add(key)
      attempted += 1
      try {
        report.polled += 1
        const observation = await pollUpstream(row)
        if (!observation) {
          // Includes the vendor's own 404. See the header: a 404 is not
          // written down, because an upstream outage looks the same from here.
          report.unreachable += 1
          continue
        }
        if (!KNOWN_STATES.has(observation.status)) {
          // See KNOWN_STATES. Storing this would make the row invisible to
          // this sweep for good while leaving it non-terminal.
          console.error(
            `[hardware/reconcile] ${row.provider}/${row.jobId} answered with an ` +
              `unrecognised status; nothing was written. Upstream normalisation ` +
              `in services/api/app/quantum/hardware.py has drifted.`
          )
          report.skippedUnknownStatus += 1
          continue
        }
        if (observation.estimator) report.estimatorWithoutLabels += 1
        const wrote = await applyObservation(supabase, row, observation)
        if (wrote === 'updated') {
          report.updated += 1
          if (isTerminalStatus(observation.status)) report.finished += 1
        } else if (wrote === 'unchanged') {
          report.unchanged += 1
        } else if (wrote === 'raced') {
          report.raced += 1
        } else {
          report.writeFailed += 1
        }
      } finally {
        inFlight.delete(key)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()))

  const handled = attempted + report.skippedInFlight + report.skippedMalformed
  if (hitDeadline && handled < rawRows.length) {
    report.stoppedBecause = 'deadline'
  } else if (rawRows.length >= limit || (eligible !== null && eligible > rawRows.length)) {
    // TWO conditions, and the FIRST one is the one that matters. `eligible`
    // alone was the whole test, and it is null whenever the count query was
    // refused — so a pass that came back with a completely full batch, which is
    // the definitive sign that there is more, reported `complete` and the note
    // said "the eligible snapshot was exhausted" while the true remainder was
    // unknown and possibly hundreds. A full page is a capped page: PostgREST
    // returning exactly `limit` rows cannot distinguish "that was all of them"
    // from "there are more", so the honest reading is the pessimistic one. The
    // cost is that a table holding exactly `limit` eligible rows reports
    // `batch_limit` on a pass that did in fact finish, and one wasted extra
    // cron tick is a much cheaper error than a silent cap.
    report.stoppedBecause = 'batch_limit'
  }

  report.remaining = eligible === null ? null : Math.max(0, eligible - handled)

  // "Not attempted", NOT "left to do". A row that was polled and is still
  // `queued` is attempted and is also still eligible next pass, so the true
  // work left is `remaining` PLUS however many of this pass's polls did not
  // reach a terminal state. Wording it as a backlog would understate it.
  const left =
    report.remaining === null
      ? 'how many eligible rows went unattempted is unknown — the eligibility count was refused'
      : `${report.remaining} eligible row(s) were not attempted in this pass`
  report.note =
    `Polled ${report.polled}: ${report.updated} updated (${report.finished} finished), ` +
    `${report.unchanged} unchanged, ${report.unreachable} unreachable; ${left}. ` +
    (report.estimatorWithoutLabels > 0
      ? `${report.estimatorWithoutLabels} estimator job(s) were reconciled to status only: ` +
        'their observable labels are not stored, so their expectation values cannot be named. '
      : '') +
    (report.skippedUnknownStatus > 0
      ? `${report.skippedUnknownStatus} row(s) were left alone because the upstream reported a ` +
        'status outside the five normalised states — see the server log. '
      : '') +
    (report.writeFailed > 0
      ? `${report.writeFailed} observation(s) were read from the vendor and then REFUSED by the ` +
        'store, so that work is lost and will be redone next pass — see the server log. '
      : '') +
    (report.stoppedBecause === 'batch_limit'
      ? 'The batch bound was reached — run again, or raise the limit.'
      : report.stoppedBecause === 'deadline'
        ? 'The time budget ran out mid-pass — the unattempted rows are untouched.'
        : 'The eligible snapshot was exhausted.')

  return report
}

/*
 * ── The column this module wants and does not have ──────────────────────────
 *
 * 1. `observable_labels text[]` on `hardware_usage`, stamped by the submit
 *    route for an estimator job. Without it this sweep can never reconcile an
 *    expectation value, only its status, and the report says so on every pass.
 *    (A place to PUT the values is a second column, or a second table.)
 * 2. `reconciled_at timestamptz`, so a pass can back off from a row it has
 *    just polled instead of relying on STALE_FLOOR_DAYS to keep unresolvable
 *    rows from monopolising the batch. With it, the ordering becomes "least
 *    recently checked" and the floor can go.
 *
 * Both are schema changes, and this module was written under a rule that it
 * may not touch the schema. They are listed here rather than left as a comment
 * in someone's head.
 */
