/**
 * /api/hooks — register (POST), list (GET) and delete (DELETE) outbound
 * webhook endpoints. Roadmap stage A5; the receiving side of
 * docs/INTEGRATIONS.md.
 *
 * IDENTITY COMES FROM A VERIFIED TOKEN AND NOTHING ELSE — the same
 * `verifiedCallerId` the billing routes use (lib/security/auth.ts), so an
 * endpoint belongs to the account whose Supabase token registered it and no
 * body field can claim otherwise. There is deliberately no guest path: a
 * webhook is a standing instruction to POST account activity to an external
 * server, and an unverifiable cookie identity must not be able to leave one
 * behind.
 *
 * Rate limits run BEFORE token verification (IP-keyed), same reasoning as
 * billing/portal: an unauthenticated flood is refused without spending a
 * Supabase round trip on it.
 *
 * The signing secret appears in exactly one response: the 201 from POST.
 * GET returns a fingerprint (sha256 prefix) and never the secret — a secret
 * that can be re-fetched is a secret whose exposure window never closes.
 */

import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'
import { signInRequiredResponse, verifiedCallerId } from '@/lib/security/auth'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import {
  getWebhookStore,
  registerEndpoint,
  toPublicEndpoint,
  WebhookStoreUnavailableError,
  WEBHOOK_EVENTS,
} from '@/lib/integrations/webhooks'

export const runtime = 'nodejs'

/** Registration writes rows; listing is a page-level read. */
const WRITE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60_000 }
const READ_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 }

async function limitOrNull(req: Request, prefix: string, rule: RateLimitRule): Promise<Response | null> {
  const decision = await rateLimit(callerKey(req.headers, prefix), rule)
  if (decision.allowed) return null
  return apiError('rate_limited', { headers: retryAfterHeaders(decision) })
}

function storeFailure(err: unknown): Response {
  if (err instanceof WebhookStoreUnavailableError) {
    return apiError('not_configured', {
      message: 'Webhook records are temporarily unreachable. Nothing was changed — try again in a moment.',
    })
  }
  throw err
}

export async function POST(req: Request): Promise<Response> {
  const limited = await limitOrNull(req, 'hooks-write', WRITE_LIMIT)
  if (limited) return limited

  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const parsed = await readJsonBody(req, 8_192)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value)) return badRequest('Expected a JSON object.')

  const url = str(parsed.value.url, 2048, 'url')
  if (!url.ok) return badRequest(url.error)

  try {
    const result = await registerEndpoint(caller, url.value, parsed.value.events)
    if (!result.ok) return badRequest(result.error)
    return NextResponse.json(
      {
        endpoint: toPublicEndpoint(result.endpoint),
        // Shown ONCE. Store it now; GET will only ever show a fingerprint.
        secret: result.secret,
        events: WEBHOOK_EVENTS,
        durable: getWebhookStore().durable,
      },
      { status: 201 }
    )
  } catch (err) {
    return storeFailure(err)
  }
}

export async function GET(req: Request): Promise<Response> {
  const limited = await limitOrNull(req, 'hooks-read', READ_LIMIT)
  if (limited) return limited

  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  try {
    const endpoints = await getWebhookStore().listForUser(caller)
    return NextResponse.json({
      endpoints: endpoints.map(toPublicEndpoint),
      events: WEBHOOK_EVENTS,
      durable: getWebhookStore().durable,
    })
  } catch (err) {
    return storeFailure(err)
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const limited = await limitOrNull(req, 'hooks-write', WRITE_LIMIT)
  if (limited) return limited

  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  // `?id=` for curl ergonomics; a JSON body works too.
  const fromQuery = new URL(req.url).searchParams.get('id')
  let rawId: unknown = fromQuery
  if (!rawId) {
    const parsed = await readJsonBody(req, 2_048)
    if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
    if (parsed.ok && isRecord(parsed.value)) rawId = parsed.value.id
  }
  const id = str(rawId, 64, 'id')
  if (!id.ok) return badRequest(id.error)

  try {
    // The store's delete is owner-scoped, so someone else's id and an unknown
    // id are the same 404 — no oracle for which endpoint ids exist.
    const deleted = await getWebhookStore().delete(id.value, caller)
    if (!deleted) return apiError('not_found', { message: 'No such endpoint.' })
    return NextResponse.json({ deleted: true })
  } catch (err) {
    return storeFailure(err)
  }
}
