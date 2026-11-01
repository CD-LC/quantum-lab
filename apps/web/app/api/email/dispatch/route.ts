/**
 * POST /api/email/dispatch — one bounded pass of the 7-day course sender.
 *
 * This is prerequisite 3 from docs/ONBOARDING.md §"Email: nothing is sent,
 * on purpose" — the scheduler. Deliberately NOT a background job: this
 * deployment has no job runner, so the design is an operator-triggered
 * endpoint the operator puts on whatever schedule they run (a cron hitting
 * it hourly gives every subscriber their next due day within the hour it
 * falls due). One call processes at most `limit` subscriptions and sends at
 * most one message to each; an idle call is cheap and returns zeros.
 *
 * ── Who may call it ─────────────────────────────────────────────────────────
 *
 * Operators only: `Authorization: Bearer EMAIL_DISPATCH_SECRET`. Same rules
 * as BILLING_RECONCILE_SECRET on /api/billing/reconcile — when the variable
 * is unset the header is ignored entirely (an empty secret must never
 * authorise anything), and the comparison is constant-time because this
 * secret is "mail every subscriber on demand". Rate limited before auth so
 * guessing attempts cost nothing downstream.
 *
 * ── The refusals, in order ──────────────────────────────────────────────────
 *
 *  1. No/wrong secret            → 401. Nothing examined.
 *  2. Store is the memory fallback → 503, HARD. See below.
 *  3. No RESEND_API_KEY          → 200 {configured:false}. Nothing CLAIMED:
 *     claiming a day whose send is known-impossible would burn the day.
 *
 * Refusal 2 is the one this route exists to make structural. The in-memory
 * subscription store forgets opt-outs on restart, and ONBOARDING.md's bar for
 * lifecycle email is "a one-click unsubscribe honoured before every send, and
 * a suppression list that outlives a redeploy" — a scheduler running over a
 * store that forgets who opted out is precisely the thing that section
 * forbids. So the check is here, in code, not in deployment notes: with no
 * durable store this endpoint sends nothing, whatever secrets are set.
 */

import { NextResponse } from 'next/server'
import { isEmailConfigured } from '@/lib/email/client'
import { runCourseDispatch } from '@/lib/email/courseDispatch'
import {
  SubscriptionStoreUnavailableError,
  getSubscriptionStore,
} from '@/lib/email/subscriptions'
import { secretMatches } from '@/lib/billing/secretCompare'
import { APP_URL } from '@/lib/billing/stripe'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { isRecord, safeJson } from '@/lib/security/validate'
import { apiError, badRequest } from '@/lib/apiError'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Batch bounds: one call never fans out unboundedly against the provider.
 *
 * The store lists only subscribers with a day actually due (courseDueFilter in
 * lib/email/courseDispatch.ts), so `limit` is a ceiling on MESSAGES per pass,
 * not on rows glanced at. The default is the maximum because the hourly cron
 * (infra/azure/email-cron/dispatch.sh) posts no body: with 25, a surge of 26
 * confirmations in one hour needs a further pass to clear, and an idle pass
 * costs the same whatever the ceiling.
 */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100

/**
 * Read per request, not at module scope, so tests can exercise both the
 * unset-secret and wrong-secret refusals without module-cache games. The
 * comparison itself follows /api/billing/reconcile: SHA-256 digests of both
 * sides, then constant-time equality (lib/billing/secretCompare.ts), so a
 * multi-byte character in the header cannot make it throw.
 */
function presentsDispatchSecret(req: Request): boolean {
  const secret = (process.env.EMAIL_DISPATCH_SECRET ?? '').trim()
  if (secret.length === 0) return false
  const header = (req.headers.get('authorization') ?? '').trim()
  if (!header.toLowerCase().startsWith('bearer ')) return false
  const offered = header.slice('bearer '.length).trim()
  return secretMatches(offered, secret)
}

export async function POST(req: Request): Promise<NextResponse> {
  // Before auth: a secret-guessing loop should never get cheaper than this.
  const limit = await rateLimit(callerKey(req.headers, 'email-dispatch'), {
    limit: 10,
    windowMs: 60_000,
  })
  if (!limit.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limit) })

  if (!presentsDispatchSecret(req)) {
    return apiError('unauthorized', {
      message:
        'Dispatch requires Authorization: Bearer EMAIL_DISPATCH_SECRET. ' +
        'When that variable is unset, nothing authorises this endpoint.',
    })
  }

  // The hard refusal. docs/ONBOARDING.md §"Email: nothing is sent, on
  // purpose" requires "a suppression list that outlives a redeploy" before
  // any lifecycle send; the memory fallback forgets opt-outs on restart, so
  // sending from it would mean mailing people whose unsubscribe evaporated.
  const store = getSubscriptionStore()
  if (!store.durable) {
    // `not_configured` (503) so operators' tooling sees the standard shape;
    // the sentence carries the actual refusal.
    return apiError('not_configured', {
      message:
        'Refusing to dispatch: the subscription store is the in-memory fallback ' +
        '(no SUPABASE_SERVICE_ROLE_KEY), which forgets unsubscribes on restart. ' +
        'docs/ONBOARDING.md §"Email: nothing is sent, on purpose" requires a ' +
        'suppression list that outlives a redeploy before any lifecycle send — ' +
        'a scheduler over a store that forgets opt-outs would mail people whose ' +
        'opt-out was lost. Configure the durable email_subscriptions table ' +
        '(supabase/schema-email.sql) and try again. Nothing was sent.',
    })
  }

  if (!isEmailConfigured) {
    // Claiming a day and then failing every send would burn that day for
    // every subscriber in the batch, so with no provider nothing is claimed.
    return NextResponse.json({
      configured: false,
      message:
        'No email provider is configured (RESEND_API_KEY is unset). ' +
        'Nothing was claimed and nothing was sent.',
    })
  }

  // An empty body means "defaults" — a cron's curl should not need a payload.
  const raw = await req.text()
  const parsed = raw.trim().length === 0 ? { ok: true as const, value: {} } : safeJson(raw, 1_024)
  if (!parsed.ok) return badRequest(parsed.error)
  const body = isRecord(parsed.value) ? parsed.value : {}
  let batchLimit = DEFAULT_LIMIT
  if (body.limit !== undefined) {
    if (
      typeof body.limit !== 'number' ||
      !Number.isInteger(body.limit) ||
      body.limit < 1 ||
      body.limit > MAX_LIMIT
    ) {
      return badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}.`)
    }
    batchLimit = body.limit
  }

  try {
    const report = await runCourseDispatch({ limit: batchLimit, baseUrl: APP_URL })
    return NextResponse.json({ ok: true, ...report })
  } catch (err) {
    if (err instanceof SubscriptionStoreUnavailableError) {
      return apiError('upstream_unavailable', {
        message:
          'The subscription store is unreachable. The batch stopped where it was; ' +
          'a re-run is safe — claimed days are never re-sent.',
      })
    }
    throw err
  }
}
