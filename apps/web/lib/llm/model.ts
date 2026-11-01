/**
 * llm/model.ts — turn a ResolvedProvider (lib/llm/resolve.ts) into an AI-SDK
 * LanguageModel. One switch, shared by every server route that calls a model
 * directly, so a new provider is added in llmConfig + here and nowhere else.
 *
 * Server-only by nature (it needs the provider key); import it from route
 * handlers and server modules, never from a component.
 */

import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import type { ResolvedProvider } from './resolve'

/**
 * The api-version to send when none is configured.
 *
 * NOT cosmetic: `@ai-sdk/azure` falls back to the literal string `"v1"` when
 * `apiVersion` is undefined, and `?api-version=v1` on a deployment-based URL
 * is rejected by Azure with `{"code":"404","message":"Resource not found"}` —
 * the same message a wrong deployment gives, which makes it expensive to
 * diagnose. A blank field must mean "a version that works", never "v1".
 * 2024-10-21 is the GA version infra/azure/deploy.sh already pins.
 */
export const AZURE_DEFAULT_API_VERSION = '2024-10-21'

/** Blank → a version that actually resolves. See AZURE_DEFAULT_API_VERSION. */
export function azureApiVersion(configured: string): string {
  const v = configured.trim()
  return v || AZURE_DEFAULT_API_VERSION
}

/**
 * Azure's own portal shows the endpoint as `https://<name>.openai.azure.com/`
 * — without the `/openai` segment the data plane actually needs. Anyone who
 * pastes that value straight into /admin/platform gets a URL one segment
 * short and, again, a bare "Resource not found". Accept the portal's value
 * and add the segment ourselves.
 *
 * A base already ending in `/openai`, or in `/openai/v1` (the newer
 * versionless API, which the SDK detects and treats differently), is left
 * exactly as it is.
 */
export function azureBaseUrl(configured: string): string {
  const base = configured.trim().replace(/\/+$/, '')
  if (!base) return base
  const path = (() => {
    try {
      return new URL(base).pathname.replace(/\/+$/, '').toLowerCase()
    } catch {
      return ''
    }
  })()
  if (path.endsWith('/openai') || path.endsWith('/openai/v1')) return base
  return `${base}/openai`
}

/**
 * Ceiling on one direct provider call. Deliberately shorter than the platform's
 * request limit (Cloudflare ~100 s, Container Apps ~240 s) AND leaves room after
 * the 25 s agent-service attempt in /api/agent, so a provider that hangs instead
 * of erroring still ends in the route's own offline fallback rather than a
 * socket the proxy closes. Pass it to `generateText({ abortSignal })`.
 */
export const LLM_CALL_TIMEOUT_MS = 30_000

/** A fresh timeout signal for one provider call. */
export function llmTimeoutSignal(ms: number = LLM_CALL_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(Number.isFinite(ms) && ms > 0 ? ms : LLM_CALL_TIMEOUT_MS)
}

export function buildLanguageModel(p: ResolvedProvider): LanguageModel {
  switch (p.id) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: p.apiKey })(p.model)
    case 'groq':
      return createGroq({ apiKey: p.apiKey })(p.model)
    case 'anthropic':
      return createAnthropic({ apiKey: p.apiKey })(p.model)
    case 'azure':
      /*
       * `.chat(...)`, NOT the provider's own call signature.
       *
       * Calling the provider directly — `createAzure({...})(model)` — selects
       * the RESPONSES API in this version of the AI SDK, so the request goes
       * to `/openai/deployments/<deployment>/responses`. Azure only serves
       * `/responses` on its newer preview api-versions; on the GA versions
       * (2024-10-21 is the one infra/azure/deploy.sh pins) that route does not
       * exist, and Azure answers a missing ROUTE with the same body it uses
       * for a missing DEPLOYMENT:
       *
       *     {"error":{"code":"404","message":"Resource not found"}}
       *
       * which is why this looked for all the world like a wrong deployment
       * name. It was not: the deployment, the key, the endpoint and the
       * api-version were all correct and verified working by hand against
       * `/chat/completions`. The single wrong thing was the ROUTE, chosen by
       * the SDK, invisible from any config.
       *
       * `.chat()` pins the chat-completions route, which every Azure
       * api-version this app can be pointed at supports. Do not "simplify"
       * this back to `createAzure({...})(p.model)` — that is the bug.
       * modelUrl() in the test beside this file asserts the route.
       */
      return createAzure({
        apiKey: p.apiKey,
        baseURL: azureBaseUrl(p.baseUrl),
        apiVersion: azureApiVersion(p.apiVersion),
        useDeploymentBasedUrls: true,
      }).chat(p.model)
  }
}
