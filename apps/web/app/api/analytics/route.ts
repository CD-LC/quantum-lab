/**
 * /api/analytics — the ingestion endpoint that, by default, ingests nothing.
 *
 * Qubit16's analytics are local-first: events live in the visitor's own
 * browser and are read back by /insights. This route exists so a self-hosting
 * operator has a documented place to add storage, and so the client has
 * something honest to talk to if it is ever pointed at one. Out of the box no
 * storage is configured, so POST accepts a batch, validates and sanitizes it,
 * and tells the caller plainly that it was not stored.
 *
 * It never 500s on a bad body — a malformed batch is a 400 with a message.
 */

import { NextResponse } from 'next/server'
import { reportError } from '@/lib/observability/report'
import { normalizeEvent, type AnalyticsEvent } from '@/lib/analytics/events'
import { isSupabaseConfigured } from '@/lib/supabase'
import { getServiceSupabase } from '@/lib/billing/entitlements'
import { check, clientKey, retryHeaders } from '@/lib/security/ratelimit'
import { isRecord, readJsonBody } from '@/lib/security/validate'

// Required: this handler reads the request body and must never be prerendered
// or cached. Prerendering a dynamic handler has broken `next build` here before.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Largest batch accepted in one POST. Extra events are dropped, not rejected. */
const MAX_BATCH = 500

const NOT_CONFIGURED_MESSAGE =
  'Analytics ingestion is not configured; events stay on the device.'

/** The Supabase table to insert into. Empty (the default) means no sink at all. */
const SINK_TABLE = (process.env.ANALYTICS_SUPABASE_TABLE ?? '').trim()

/**
 * Whether this deployment has somewhere to put events.
 *
 * BOTH conditions are required: an operator must name a table AND have Supabase
 * configured. Ingestion is off by default and stays off unless someone opts in
 * deliberately — see docs/OPERATIONS.md.
 */
function storageConfigured(): boolean {
  return SINK_TABLE.length > 0 && isSupabaseConfigured
}

/**
 * Insert the sanitized batch. Never throws: a database that is down, missing the
 * table, or refusing the write comes back as a reason string. Losing an
 * analytics event is a rounding error; showing a learner an error because one
 * could not be recorded is not acceptable, so every failure here is a 200.
 */
async function storeEvents(events: AnalyticsEvent[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Service role: the analytics table has RLS on and NO policy (only the
  // service role writes it), so the anon client's insert was refused on every
  // request and the failure reported as a 200 — nothing was ever stored.
  const supabase = getServiceSupabase()
  if (!supabase) return { ok: false, reason: 'SUPABASE_SERVICE_ROLE_KEY is not set.' }

  try {
    const { error } = await supabase.from(SINK_TABLE).insert(
      events.map((event) => ({
        name: event.name,
        at: event.at,
        props: event.props,
        session_id: event.sessionId,
      }))
    )
    if (error) return { ok: false, reason: error.message }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Insert failed.' }
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    configured: storageConfigured(),
    mode: 'local-first',
    maxBatch: MAX_BATCH,
    message: NOT_CONFIGURED_MESSAGE,
    privacy:
      'No cookies, no third-party scripts, no fingerprinting, no cross-site identifiers. ' +
      'Events are computed and stored in the visitor’s browser.',
  })
}

/**
 * SECURITY FIX (audit finding RATE-1 / VAL-1): batch ingestion had no rate
 * limit and no body-size ceiling, so a caller could push arbitrarily large
 * bodies at an endpoint that (when a sink IS configured) writes them to the
 * database. 30 batches x 500 events per minute is far above any real client —
 * lib/analytics/track.ts flushes on an interval — and the limiter is
 * PER INSTANCE, so it deters casual abuse only.
 */
const BATCHES_PER_MINUTE = 30
/** 500 events of bounded props comfortably fit; anything larger is not a client. */
const MAX_BODY_BYTES = 1_000_000

export async function POST(request: Request): Promise<NextResponse> {
  const limit = check(clientKey(request.headers, 'analytics'), BATCHES_PER_MINUTE, 60_000)
  if (!limit.allowed) {
    return NextResponse.json(
      { stored: false, error: 'Too many batches. Slow down.', code: 'rate_limited' },
      { status: 429, headers: retryHeaders(limit) }
    )
  }

  // The cap is enforced while the body is read, not after it is buffered.
  const parsed = await readJsonBody(request, MAX_BODY_BYTES)
  if (!parsed.ok) {
    return NextResponse.json(
      {
        stored: false,
        error: parsed.error,
        code: parsed.tooLarge ? 'payload_too_large' : 'bad_request',
      },
      { status: parsed.tooLarge ? 413 : 400 }
    )
  }
  const body: unknown = parsed.value

  if (!isRecord(body)) {
    return NextResponse.json(
      {
        stored: false,
        error: 'Expected an object of the shape { events: AnalyticsEvent[] }.',
        code: 'bad_request',
      },
      { status: 400 }
    )
  }

  const rawEvents = body.events
  if (!Array.isArray(rawEvents)) {
    return NextResponse.json(
      {
        stored: false,
        error: '`events` must be an array of analytics events.',
        code: 'bad_request',
      },
      { status: 400 }
    )
  }

  const truncated = rawEvents.length > MAX_BATCH
  const considered = truncated ? rawEvents.slice(0, MAX_BATCH) : rawEvents

  // Re-validate and re-sanitize server-side. The client already does this, but a
  // server that trusts its client for privacy guarantees does not have any.
  const accepted: AnalyticsEvent[] = []
  let rejected = 0
  for (const raw of considered) {
    const event = normalizeEvent(raw)
    if (event) accepted.push(event)
    else rejected += 1
  }

  if (accepted.length === 0 && rejected > 0) {
    return NextResponse.json(
      {
        stored: false,
        error:
          'No valid events in the batch. Each event needs a known `name`, an ISO-8601 `at`, and flat `props`.',
        code: 'bad_request',
      },
      { status: 400 }
    )
  }

  if (!storageConfigured()) {
    return NextResponse.json({
      stored: false,
      received: accepted.length,
      rejected,
      truncated,
      ...(truncated
        ? { truncationNote: `Batch capped at ${MAX_BATCH} events; the rest were dropped.` }
        : {}),
      message: NOT_CONFIGURED_MESSAGE,
    })
  }

  const outcome = await storeEvents(accepted)
  if (!outcome.ok) {
    // SECURITY FIX (audit finding LEAK-1): a Postgres/PostgREST error message
    // names the table, the column and sometimes the failing policy. That is a
    // free schema map for an anonymous caller; keep it in the server log.
    console.error('[api/analytics] insert failed:', outcome.reason)
    // Reported so a broken sink is visible to an operator. It stays a 200 on
    // purpose: the client posts this fire-and-forget from a visibilitychange
    // handler, it does not retry, and the device keeps its own copy either way,
    // so a non-2xx would produce console noise in every visitor's browser and
    // change nothing. `outcome.reason` is a PostgREST message — it goes to the
    // report and the server log, never to the body.
    reportError(new Error('analytics sink rejected batch'), {
      route: 'api/analytics',
      accepted: accepted.length,
      rejected,
    })
    return NextResponse.json({
      stored: false,
      received: accepted.length,
      rejected,
      truncated,
      reason: 'The analytics sink rejected the batch.',
    })
  }

  return NextResponse.json({
    stored: true,
    count: accepted.length,
    received: accepted.length,
    rejected,
    truncated,
  })
}
