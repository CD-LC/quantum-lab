import { NextResponse } from 'next/server'
import { badRequest, apiError } from '@/lib/apiError'
import { isRecord, readJsonBody } from '@/lib/security/validate'
import { guardPlatformAdmin } from '@/lib/platform/routeGuard'
import {
  effectiveLlmSettings,
  invalidateLlmSettings,
  isPlatformSettingsConfigured,
  redact,
  saveLlmSettings,
} from '@/lib/platform/settings'
import { secretBoxAvailable } from '@/lib/platform/secretBox'
import { anyProviderReady, resolveForTier } from '@/lib/llm/resolve'
import { TIER_IDS, type LlmSettingsPatch, type TierId } from '@/lib/platform/llmConfig'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 64_000

/**
 * GET /api/platform/llm — the effective configuration, redacted (no key ever
 * leaves the server; the console sees "set · …ab12 · from settings"), plus the
 * resolution each tier would get right now so the admin can see the effect
 * of a change before a learner does.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = await guardPlatformAdmin(req, 'platform-llm-read', 60)
  if (!guard.ok) return guard.response
  invalidateLlmSettings() // an admin looking wants the truth, not a 30 s old cache
  const eff = await effectiveLlmSettings()
  const effective = {} as Record<TierId, { access: string; provider: string | null; messagesPerDay: number | null; tools: boolean }>
  for (const tier of TIER_IDS) {
    const r = resolveForTier(eff.settings, tier)
    effective[tier] = {
      access: r.kind === 'live' ? 'live' : r.kind === 'offline' ? `offline (${r.reason === 'policy' ? 'by policy' : 'no provider ready'})` : 'off',
      provider: r.kind === 'live' ? r.provider.label : null,
      messagesPerDay: r.policy.messagesPerDay,
      tools: r.policy.tools,
    }
  }
  return NextResponse.json(
    {
      settings: redact(eff),
      stored: eff.stored,
      unreadable: eff.unreadable,
      effective,
      anyProviderReady: anyProviderReady(eff.settings),
      canStore: isPlatformSettingsConfigured,
      canStoreSecrets: isPlatformSettingsConfigured && secretBoxAvailable(),
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}

/** PUT /api/platform/llm — save a patch. Body: { patch, version }. */
export async function PUT(req: Request): Promise<Response> {
  const guard = await guardPlatformAdmin(req, 'platform-llm-write', 20)
  if (!guard.ok) return guard.response
  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value) || !isRecord(parsed.value.patch)) {
    return badRequest('Body must be { patch: {...}, version?: number }.')
  }
  const version = typeof parsed.value.version === 'number' ? parsed.value.version : null
  const result = await saveLlmSettings(parsed.value.patch as LlmSettingsPatch, guard.caller.email, version)
  if (!result.ok) {
    const status = result.code === 'conflict' ? 409 : result.code === 'error' ? 500 : 503
    return NextResponse.json({ error: result.message, code: result.code }, { status })
  }
  return NextResponse.json({ ok: true, version: result.version }, { status: 200 })
}
