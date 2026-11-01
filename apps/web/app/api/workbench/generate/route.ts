/**
 * POST /api/workbench/generate — the generate → verify → repair loop for the
 * /workbench/generate page.
 *
 * Body: { spec, maxAttempts?, candidateQasm? } — validated by the same
 * parseGenerateArgs the MCP tool uses, so the page and an agent cannot drift.
 * Reply: newline-delimited JSON. One {"type":"attempt", attempt} line per
 * round AS IT LANDS, then one {"type":"result", …GenerateResult} line — so the
 * page fills its timeline live and a Stop keeps what was already recorded.
 * Refusals are a single JSON object ({ offline: true, reason } when the
 * caller's tier gets no live model; the page can still verify a pasted
 * circuit locally in that case, what it cannot do is generate one).
 *
 * Who gets a model follows the tutor's rules exactly (lib/llm/resolve.ts):
 * verified identity → entitlement → tier → admin policy. Each request counts
 * ONE unit against the tier's daily message quota even though the loop may
 * make up to maxAttempts model calls; the per-request cost is bounded by
 * maxAttempts × REPLY_MAX_TOKENS, which is why maxAttempts is capped.
 */

import { NextResponse } from 'next/server'
import { badRequest, apiError } from '@/lib/apiError'
import { getEntitlement } from '@/lib/billing/entitlements'
import { resolveForTier, tierOf } from '@/lib/llm/resolve'
import { reportError } from '@/lib/observability/report'
import { effectiveLlmSettings } from '@/lib/platform/settings'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { verifiedCaller } from '@/lib/security/auth'
import { isRecord, readJsonBody } from '@/lib/security/validate'
import { generateVerifiedCircuit } from '@/lib/workbench/generate'
import { adapterFor } from '@/lib/workbench/liveProvider'
import { parseGenerateArgs, serializeAttempt, serializeGenerateResult } from '@/lib/workbench/mcpTool'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Each request may make several model calls; keep the per-minute count low. */
const PER_MINUTE = 6
const PER_HOUR = 40
const MAX_BODY_BYTES = 128_000

export async function POST(req: Request): Promise<Response> {
  try {
    const key = callerKey(req.headers, 'workbench-generate')
    const minute = await rateLimit(key, { limit: PER_MINUTE, windowMs: 60_000 })
    const hour = minute.allowed ? await rateLimit(key, { limit: PER_HOUR, windowMs: 3_600_000 }) : minute
    if (!minute.allowed || !hour.allowed) {
      const decision = minute.allowed ? hour : minute
      return NextResponse.json(
        { error: 'Too many runs in a row. Wait a moment and try again.', code: 'rate_limited' },
        { status: 429, headers: retryAfterHeaders(decision) },
      )
    }

    const parsed = await readJsonBody(req, MAX_BODY_BYTES)
    if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
    if (!parsed.ok) return badRequest(parsed.error)
    if (!isRecord(parsed.value)) return badRequest('Request body must be a JSON object.')
    const body = parsed.value
    const args = parseGenerateArgs({
      spec: body.spec,
      max_attempts: body.maxAttempts,
      candidate_qasm: body.candidateQasm,
    })
    if (!args.ok) return badRequest(args.error)
    const { spec, maxAttempts, candidate } = args.input

    // ── Who is asking, and does their tier get a model?
    const caller = await verifiedCaller(req)
    const userId = caller?.id ?? null
    const entitlement = userId ? await getEntitlement(userId) : null
    const tier = tierOf(userId, entitlement)
    const { settings } = await effectiveLlmSettings()
    const resolution = resolveForTier(settings, tier)

    if (resolution.kind !== 'live') {
      // Still honour a candidate-only request: verification needs no model.
      if (candidate && maxAttempts === 1) {
        const result = await generateVerifiedCircuit(spec, null, { maxAttempts: 1, candidate })
        return NextResponse.json({ ...serializeGenerateResult(result, spec), tier }, { status: 200 })
      }
      return NextResponse.json(
        {
          offline: true,
          tier,
          reason:
            resolution.kind === 'off'
              ? tier === 'anonymous'
                ? 'Generation needs a signed-in account on this deployment. You can still verify a pasted circuit.'
                : 'Live models are not included in your plan. You can still verify a pasted circuit.'
              : 'No model is configured for your tier right now. You can still verify a pasted circuit.',
        },
        { status: 200 },
      )
    }

    const policy = resolution.policy
    if (policy.messagesPerDay !== null) {
      if (policy.messagesPerDay <= 0) {
        return NextResponse.json(
          { offline: true, tier, reason: 'Your daily model allowance on this tier is zero.' },
          { status: 200 },
        )
      }
      const day = await rateLimit(callerKey(req.headers, 'workbench-day', userId), {
        limit: policy.messagesPerDay,
        windowMs: 86_400_000,
      })
      if (!day.allowed) {
        return NextResponse.json(
          {
            offline: true,
            tier,
            reason: `You have used today's ${policy.messagesPerDay} model calls on this tier. It resets in ${Math.ceil((day.resetAt - Date.now()) / 3_600_000)} h.`,
            code: 'quota',
          },
          { status: 429, headers: retryAfterHeaders(day) },
        )
      }
    }

    const provider = adapterFor(resolution)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
          } catch {
            // The client went away; the loop's abort signal stops the rest.
          }
        }
        try {
          const result = await generateVerifiedCircuit(spec, provider, {
            maxAttempts,
            candidate,
            signal: req.signal,
            onAttempt: (a) => send({ type: 'attempt', attempt: serializeAttempt(a) }),
          })
          send({ type: 'result', ...serializeGenerateResult(result, spec), tier })
        } catch (cause) {
          reportError(cause, { route: 'api/workbench/generate', stage: 'stream' })
          send({ type: 'error', error: 'The generation run failed on the server.' })
        } finally {
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (err) {
    reportError(err, { route: 'api/workbench/generate', stage: 'post' })
    return NextResponse.json(
      { error: 'The generation run failed on the server. Try again.', code: 'internal' },
      { status: 500 },
    )
  }
}
