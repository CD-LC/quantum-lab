import { NextResponse } from 'next/server'
import { APICallError, generateText } from 'ai'
import { apiError, badRequest } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { arr, isRecord, readJsonBody, str } from '@/lib/security/validate'
import { verifiedCaller } from '@/lib/security/auth'
import { getEntitlement } from '@/lib/billing/entitlements'
import { effectiveLlmSettings } from '@/lib/platform/settings'
import {
  LITELLM_PREFIX,
  PROVIDER_LABEL,
  isProviderId,
  providerModel,
  providerReady,
  type LlmSettings,
  type ProviderId,
} from '@/lib/platform/llmConfig'
import { resolveForTier, tierOf } from '@/lib/llm/resolve'
import { liveModelForCaller } from '@/lib/llm/callerAccess'
import { reportError } from '@/lib/observability/report'
import { buildLanguageModel, llmTimeoutSignal } from '@/lib/llm/model'
import {
  EVOLVE_LIMITS,
  GRAMMAR,
  buildProposalPrompt,
  extractPrograms,
  formatProgram,
  getProblem,
  parseProgram,
  type EliteBrief,
} from '@/lib/workbench/evolve'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * /api/workbench/evolve — the one network hop behind /workbench/evolve.
 *
 * The evolutionary loop itself runs IN THE BROWSER (lib/workbench/evolve.ts);
 * this route exists only so a provider can propose candidates. It is NOT a
 * general completion proxy: the caller sends a problem id, a generation
 * number and the elite programs as DSL text, and THIS route builds the prompt
 * from the real problem description and grammar. The elites are parsed with
 * the same parser the loop uses, so a caller cannot smuggle free text into
 * the prompt, and the reply is returned as extracted code blocks — text the
 * browser will parse again before anything is evaluated.
 *
 * Provider choice follows lib/llm/resolve.ts exactly as the tutor does: the
 * caller's tier decides whether any model is called, and among the ready
 * providers the caller may pick one by id (that is what lets the page run
 * several providers side by side, as Hive does). A provider that is not ready
 * for this deployment is refused, never substituted silently — the lineage
 * must name the model that actually proposed a candidate.
 */

const PER_MINUTE = 20
const PER_HOUR = 200
const MAX_BODY_BYTES = 64_000
const MAX_REPLY_TOKENS = 700
const MAX_ELITES = EVOLVE_LIMITS.eliteMax

/**
 * Daily-quota namespace, shared with /api/workbench/generate ON PURPOSE: both
 * routes spend the same per-tier `messagesPerDay` model budget, so a caller
 * cannot double it by alternating between them.
 */
export const EVOLVE_QUOTA_PREFIX = 'workbench-day'

/**
 * The address the daily quota is keyed on: the same precedence `callerKey`
 * uses (edge-written cf-connecting-ip, else the first x-forwarded-for hop,
 * else x-real-ip), so the quota bucket is the bucket this route's rate limit
 * already keys on.
 */
function clientAddress(headers: Headers): string | null {
  const cf = headers.get('cf-connecting-ip')?.trim() ?? ''
  const firstHop = (headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? ''
  const real = headers.get('x-real-ip')?.trim() ?? ''
  return (cf || firstHop || real).slice(0, 64) || null
}

const SYSTEM =
  'You propose candidate programs for a small optimisation search. Reply with the requested number of ' +
  'programs, each in its own fenced code block, and no prose. A program that uses any line outside the ' +
  'grammar you are shown is discarded.'

/**
 * The providers a caller of this tier may ask. When the admin pinned a
 * provider (`forceProvider`, or this tier's own pin) and it is ready, the
 * caller gets exactly that one: letting a free or anonymous visitor name a
 * dearer provider would walk around the cost policy resolveForTier applies.
 * Unpinned, every ready provider is open to choose (that is what lets the
 * page run several side by side).
 */
function allowedProviders(
  settings: LlmSettings,
  resolved: ProviderId,
  tier: ReturnType<typeof tierOf>,
): { id: ProviderId; label: string }[] {
  const ready = (id: ProviderId | 'auto' | null | undefined): boolean =>
    Boolean(id) && id !== 'auto' && providerReady(id as ProviderId, settings.providers[id as ProviderId])
  if (ready(settings.forceProvider) || ready(settings.tiers[tier].provider)) {
    return [{ id: resolved, label: PROVIDER_LABEL[resolved] }]
  }
  return settings.order
    .filter((id) => providerReady(id, settings.providers[id]))
    .map((id) => ({ id, label: PROVIDER_LABEL[id] }))
}

async function resolveCaller(req: Request) {
  const caller = await verifiedCaller(req)
  const userId = caller?.id ?? null
  const entitlement = userId ? await getEntitlement(userId) : null
  const tier = tierOf(userId, entitlement)
  const { settings } = await effectiveLlmSettings()
  return { tier, settings, resolution: resolveForTier(settings, tier) }
}

/** Which providers this caller may ask. The page builds one adapter per entry. */
export async function GET(req: Request): Promise<Response> {
  const limit = await rateLimit(callerKey(req.headers, 'evolve-status'), { limit: 60, windowMs: 60_000 })
  if (!limit.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limit) })
  const { tier, settings, resolution } = await resolveCaller(req)
  if (resolution.kind !== 'live') {
    return NextResponse.json({ tier, providers: [], reason: resolution.kind === 'off' ? 'tier_off' : 'offline' })
  }
  return NextResponse.json({
    tier,
    providers: allowedProviders(settings, resolution.provider.id, tier),
    reason: null,
  })
}

export async function POST(req: Request): Promise<Response> {
  const key = callerKey(req.headers, 'evolve')
  const minute = await rateLimit(key, { limit: PER_MINUTE, windowMs: 60_000 })
  const hour = minute.allowed ? await rateLimit(key, { limit: PER_HOUR, windowMs: 3_600_000 }) : minute
  if (!minute.allowed || !hour.allowed) {
    return apiError('rate_limited', { headers: retryAfterHeaders(minute.allowed ? hour : minute) })
  }

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return badRequest(parsed.error)
  const body = parsed.value
  if (!isRecord(body)) return badRequest('Expected a JSON object.')

  const problemId = str(body.problemId, 64, 'problemId')
  if (!problemId.ok) return badRequest(problemId.error)
  const problem = getProblem(problemId.value)
  if (!problem) return badRequest('Unknown problem.')

  const generation =
    typeof body.generation === 'number' && Number.isInteger(body.generation) && body.generation >= 1
      ? Math.min(body.generation, EVOLVE_LIMITS.generationsMax)
      : null
  if (generation === null) return badRequest('generation must be a positive integer.')

  const elitesRaw = arr(body.elites, MAX_ELITES, 'elites')
  if (!elitesRaw.ok) return badRequest(elitesRaw.error)
  const elites: EliteBrief[] = []
  for (const [i, item] of elitesRaw.value.entries()) {
    const text = str(item, EVOLVE_LIMITS.maxChars, `elites[${i}]`)
    if (!text.ok) return badRequest(text.error)
    const program = parseProgram(text.value, problem.numQubits)
    if (!program.ok) return badRequest(`elites[${i}] is not a valid program: ${program.error}`)
    if (!problem.kinds.includes(program.program.kind)) return badRequest(`elites[${i}] is the wrong kind for this problem.`)
    // Fitness and detail are recomputed here, never trusted from the body.
    const ev = problem.evaluate(program.program)
    elites.push({ id: `e${i + 1}`, text: formatProgram(program.program), fitness: ev.fitness, detail: ev.detail })
  }

  const requested = body.provider
  if (requested !== undefined && !isProviderId(requested)) return badRequest('Unknown provider id.')

  // Who is asking, does their tier get a model, and — the part that costs
  // money — have they any of today's allowance left? One unit is charged here,
  // before a provider is built, exactly as /api/workbench/generate does.
  const access = await liveModelForCaller(
    { authorization: req.headers.get('authorization'), clientIp: clientAddress(req.headers) },
    EVOLVE_QUOTA_PREFIX,
  )
  if (access.kind !== 'live') {
    if (access.reason === 'quota_spent' || access.reason === 'quota_zero') {
      const wait = access.reason === 'quota_spent' && access.resetAt ? Math.max(1, Math.ceil((access.resetAt - Date.now()) / 1000)) : 3600
      return apiError('rate_limited', {
        message: access.note,
        headers: { 'retry-after': String(wait) },
      })
    }
    return apiError('forbidden', {
      message:
        access.tier === 'anonymous'
          ? 'Model proposals are available to signed-in users. The built-in mutation operator still runs without one.'
          : 'Your plan does not include live model calls; the built-in mutation operator still runs.',
    })
  }
  const { tier } = access
  const { settings } = await effectiveLlmSettings()
  let provider = access.resolution.provider
  if (requested !== undefined && requested !== provider.id) {
    if (!allowedProviders(settings, provider.id, tier).some((p) => p.id === requested)) {
      return apiError('not_configured', { message: `${PROVIDER_LABEL[requested]} is not available to your plan on this deployment.` })
    }
    // Same shape resolveForTier builds, for the provider the caller named.
    const cfg = settings.providers[requested]
    const model = providerModel(requested, cfg)
    provider = {
      id: requested,
      label: PROVIDER_LABEL[requested],
      apiKey: cfg.apiKey,
      model,
      litellmModel: `${LITELLM_PREFIX[requested]}${model}`,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
    }
  }

  const prompt = buildProposalPrompt({
    problem,
    grammar: problem.kinds.map((k) => GRAMMAR[k]).join('\n\n'),
    elites,
    generation,
    count: EVOLVE_LIMITS.proposalsPerProvider,
  })

  try {
    const result = await generateText({
      model: buildLanguageModel(provider),
      system: SYSTEM,
      prompt,
      maxOutputTokens: MAX_REPLY_TOKENS,
      abortSignal: llmTimeoutSignal(),
    })
    const programs = extractPrograms(result.text).slice(0, EVOLVE_LIMITS.proposalsPerProvider)
    return NextResponse.json({ provider: provider.label, providerId: provider.id, programs })
  } catch (cause) {
    reportError(cause, { route: 'api/workbench/evolve', stage: 'complete', provider: provider.id })
    if (APICallError.isInstance(cause)) {
      const status = cause.statusCode
      return apiError(status === 429 ? 'rate_limited' : 'upstream_error', {
        message: `${provider.label} replied with status ${status ?? 'unknown'}.`,
      })
    }
    return apiError('upstream_unavailable', { message: `${provider.label} did not answer.` })
  }
}
