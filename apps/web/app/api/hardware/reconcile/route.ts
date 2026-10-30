/**
 * POST /api/hardware/reconcile — one bounded sweep of unobserved hardware jobs.
 *
 * THIS IS A CRON ENDPOINT, NOT A USER ENDPOINT. There is no signed-in path
 * into it and there should never be one: a sweep reads and writes rows
 * belonging to EVERY account, so "the caller is signed in" is not a
 * permission that means anything here. The only credential is an operator
 * secret.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * `GET /api/hardware/job/{provider}/{job_id}` is the only thing that has ever
 * observed a hardware job, and it only runs while somebody has the page open.
 * Close the tab and the row stays `queued` forever, however long ago IBM
 * finished it. `lib/hardware/reconcile.ts` has the full account of what the
 * sweep does and — more importantly — what it deliberately cannot do
 * (estimator expectation values, for want of stored observable labels).
 *
 * ── Who may call it ─────────────────────────────────────────────────────────
 *
 * `Authorization: Bearer HARDWARE_RECONCILE_SECRET`, the same shape as
 * `EMAIL_DISPATCH_SECRET` on /api/email/dispatch. Two properties matter and
 * both are easy to get wrong:
 *
 *  · WITH THE VARIABLE UNSET THE ROUTE REFUSES EVERYONE. An empty secret must
 *    never authorise anything — "compare the header to the env var" with an
 *    empty env var is how a cron endpoint ends up open to the internet, and
 *    this one can spend vendor API quota on every account in the table.
 *  · The comparison is constant-time. `===` leaks the secret a byte at a time
 *    to anyone willing to measure a few thousand requests.
 *
 * Read per request rather than at module scope so a test can exercise the
 * unset case and the wrong-secret case in one file without module-cache games.
 *
 * ── Rate limited BEFORE the secret is checked ───────────────────────────────
 *
 * A guessing loop should not get cheaper than the limiter, and a sweep is
 * expensive downstream: every allowed call is up to `limit` vendor round
 * trips. The limit is deliberately low — a cron ticking every minute needs
 * one call per minute.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Two overlapping calls are safe. The sweep only writes fields it actually
 * observed and guards every UPDATE to rows that are still non-terminal, so a
 * slow pass cannot drag a job that a faster pass already finished back to
 * `queued`. Details, and the limits of that guarantee across instances, are in
 * lib/hardware/reconcile.ts.
 *
 * ── How long this may run, which this file does NOT declare ─────────────────
 *
 * The sweep's own budget is 20s and each vendor poll may take 8s, so a pass can
 * want ~28s. NO `maxDuration` IS SET HERE, so the platform's default applies —
 * 10s on Vercel Hobby, 15s on Pro at the time of writing. On such a plan the
 * invocation is killed before the sweep's own deadline fires: the cron sees a
 * platform error, no report is produced, and the operator learns nothing about
 * how far the pass got. Nothing is corrupted (every write is one guarded
 * statement and the next tick simply re-reads the same rows), but the
 * stop-early-and-say-so contract is void.
 *
 * It is left undeclared rather than guessed because the right value depends on
 * the plan this is deployed to. An operator MUST do one of two things: add
 * `export const maxDuration = 60` here, or pass a `limit` and rely on a shorter
 * `deadlineMs`. This is on the wiring checklist, not a decision this file made.
 */

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import {
  MAX_BATCH_LIMIT,
  reconcileHardwareJobs,
  type ReconcileReport,
} from '@/lib/hardware/reconcile'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { isRecord, readBodyText, safeJson } from '@/lib/security/validate'
import { apiError, badRequest } from '@/lib/apiError'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Does this request carry the operator secret?
 *
 * @param req The incoming request.
 * @returns True only when `HARDWARE_RECONCILE_SECRET` is set AND the bearer
 *   token matches it byte for byte. False whenever the variable is unset,
 *   whatever the header says.
 */
function presentsReconcileSecret(req: Request): boolean {
  const secret = (process.env.HARDWARE_RECONCILE_SECRET ?? '').trim()
  // Belt and braces, and SAY WHICH. With the code exactly as it stands below
  // this line is unreachable as a refusal: the header is trimmed before the
  // `bearer ` test, so `offered` can never come out empty, so a zero-byte
  // secret can never match anything. The guard stays because that reasoning
  // depends on a `.trim()` three lines away — delete the trim and an empty
  // secret matching an empty token becomes live again, which is the single
  // most common way a cron endpoint ends up open to the internet. It is NOT
  // what the "unset refuses everyone" test is exercising; that test passes
  // with this line removed, and the byte comparison is what earns it today.
  if (secret.length === 0) return false
  const header = (req.headers.get('authorization') ?? '').trim()
  if (!header.toLowerCase().startsWith('bearer ')) return false
  const offered = header.slice('bearer '.length).trim()

  // COMPARE BYTES, NOT CHARACTERS. `timingSafeEqual` throws a RangeError on
  // unequal BYTE length, and `String.length` counts UTF-16 code units — so a
  // length check on the strings lets through a token that is the same number of
  // characters and a different number of bytes. 'ééé' and 'abc' are both
  // `.length === 3`; encoded they are 6 bytes and 3. The comparison then threw
  // out of an unauthenticated code path, which Next turns into a 500 with a
  // stack in the log instead of the 401 this function exists to return — an
  // anonymous caller could crash the handler at will. Encoding first makes the
  // check the same unit as the comparison.
  //
  // Leaking the byte length of the secret this way is accepted: the length of
  // the secret is not the secret, and there is no constant-time comparison of
  // differently sized buffers to have instead.
  const offeredBytes = Buffer.from(offered, 'utf8')
  const secretBytes = Buffer.from(secret, 'utf8')
  if (offeredBytes.length !== secretBytes.length) return false
  return timingSafeEqual(offeredBytes, secretBytes)
}

/**
 * Run one sweep.
 *
 * @param req A POST with an optional `{ limit }` body. An empty body means
 *   defaults, so a cron's `curl` needs no payload.
 * @returns 200 with the report, or one of the refusals in the header comment.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // Before auth, deliberately. See the header.
  const limited = await rateLimit(callerKey(req.headers, 'hardware-reconcile'), {
    limit: 6,
    windowMs: 60_000,
  })
  if (!limited.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limited) })

  if (!presentsReconcileSecret(req)) {
    return apiError('unauthorized', {
      message:
        'Reconciliation requires Authorization: Bearer HARDWARE_RECONCILE_SECRET. ' +
        'When that variable is unset, nothing authorises this endpoint.',
    })
  }

  const raw = await readBodyText(req, 1_024)
  if (!raw.ok) {
    return raw.tooLarge ? apiError('payload_too_large') : badRequest(raw.error)
  }
  const parsed =
    raw.value.trim().length === 0 ? { ok: true as const, value: {} } : safeJson(raw.value, 1_024)
  if (!parsed.ok) return badRequest(parsed.error)
  const body = isRecord(parsed.value) ? parsed.value : {}

  let limit: number | undefined
  if (body.limit !== undefined) {
    if (
      typeof body.limit !== 'number' ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > MAX_BATCH_LIMIT
    ) {
      return badRequest(`limit must be an integer between 1 and ${MAX_BATCH_LIMIT}.`)
    }
    limit = body.limit
  }

  const report: ReconcileReport = await reconcileHardwareJobs({ limit })

  if (!report.configured) {
    // 503 rather than 200: a cron that is told "ok" while nothing is being
    // reconciled will keep saying nothing is wrong for months.
    return apiError('not_configured', { message: report.note })
  }

  if (report.stoppedBecause === 'store_unavailable') {
    // The note names the Postgres error, which is not for the wire.
    console.error(`[hardware/reconcile] ${report.note}`)
    return apiError('upstream_unavailable', {
      message: 'The job store could not be read. Nothing was polled; a re-run is safe.',
    })
  }

  return NextResponse.json({ ok: true, ...report })
}
