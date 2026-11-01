import { NextResponse } from 'next/server'
import { APICallError, generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { badRequest, apiError } from '@/lib/apiError'
import { isRecord, readJsonBody } from '@/lib/security/validate'
import { guardPlatformAdmin } from '@/lib/platform/routeGuard'
import { effectiveLlmSettings, invalidateLlmSettings } from '@/lib/platform/settings'
import {
  isAllowedProviderBaseUrl,
  isProviderId,
  providerModel,
  providerReady,
} from '@/lib/platform/llmConfig'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TEST_TIMEOUT_MS = 15_000

/**
 * POST /api/platform/llm/test — send one tiny prompt through a provider with
 * the key that is CURRENTLY EFFECTIVE (stored or env), or with a key supplied
 * in the body that has not been saved yet, so an admin can check a key before
 * committing it. Body: { provider, apiKey?, model?, baseUrl?, apiVersion? }.
 * Nothing here is persisted; the reply is trimmed to a line.
 */
export async function POST(req: Request): Promise<Response> {
  const guard = await guardPlatformAdmin(req, 'platform-llm-test', 10)
  if (!guard.ok) return guard.response
  const parsed = await readJsonBody(req, 8_000)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value) || !isProviderId(parsed.value.provider)) {
    return badRequest('Body must name a provider: gemini, groq, anthropic or azure.')
  }
  const id = parsed.value.provider
  invalidateLlmSettings()
  const { settings } = await effectiveLlmSettings()
  const cfg = { ...settings.providers[id], enabled: true }
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '')
  if (str(parsed.value.apiKey, 512)) cfg.apiKey = str(parsed.value.apiKey, 512)
  if (str(parsed.value.model, 120)) cfg.model = str(parsed.value.model, 120)
  const suppliedBaseUrl = str(parsed.value.baseUrl, 400)
  if (id !== 'azure') {
    // Only Azure takes a base URL; the other SDKs use fixed endpoints.
    cfg.baseUrl = ''
  } else if (suppliedBaseUrl) {
    // The key goes to this URL. Only a provider host is acceptable, and a URL
    // that differs from the saved one never borrows the saved/env key: the
    // admin must type the key too, so the server-held secret cannot be pointed
    // at a host of the caller's choosing.
    if (!isAllowedProviderBaseUrl(id, suppliedBaseUrl)) {
      return badRequest('baseUrl must be an https URL on an allowed provider host (for Azure, *.openai.azure.com).')
    }
    if (suppliedBaseUrl !== cfg.baseUrl && !str(parsed.value.apiKey, 512)) {
      return badRequest('Testing a different endpoint needs an API key in the request; the saved key is not sent to a new URL.')
    }
    cfg.baseUrl = suppliedBaseUrl
  } else if (cfg.baseUrl && !isAllowedProviderBaseUrl(id, cfg.baseUrl)) {
    // A value saved before the allowlist existed.
    return badRequest('The saved baseUrl is not an allowed provider host. Correct it in the settings first.')
  }
  if (str(parsed.value.apiVersion, 64)) cfg.apiVersion = str(parsed.value.apiVersion, 64)
  if (!providerReady(id, cfg)) {
    return NextResponse.json(
      { ok: false, message: id === 'azure' ? 'Azure needs a key, an endpoint and a deployment name.' : 'No API key to test.' },
      { status: 200 },
    )
  }
  const model = providerModel(id, cfg)
  const lm =
    id === 'gemini'
      ? createGoogleGenerativeAI({ apiKey: cfg.apiKey })(model)
      : id === 'groq'
        ? createGroq({ apiKey: cfg.apiKey })(model)
        : id === 'anthropic'
          ? createAnthropic({ apiKey: cfg.apiKey })(model)
          : createAzure({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, apiVersion: cfg.apiVersion || undefined, useDeploymentBasedUrls: true })(model)

  const started = Date.now()
  try {
    const result = await generateText({
      model: lm,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    return NextResponse.json(
      { ok: true, model, ms: Date.now() - started, sample: result.text.trim().slice(0, 80) },
      { status: 200 },
    )
  } catch (err) {
    const message = APICallError.isInstance(err)
      ? `${err.statusCode ?? 'error'}: ${(err.responseBody ?? err.message).slice(0, 300)}`
      : err instanceof Error
        ? err.message.slice(0, 300)
        : 'Unknown error'
    return NextResponse.json({ ok: false, model, ms: Date.now() - started, message }, { status: 200 })
  }
}
