/**
 * platform/llmConfig.ts — the SHAPE of the tutor's runtime LLM configuration.
 *
 * PURE module: no env, no database, no crypto. Shared by the server (which
 * merges env defaults with the row a platform admin saved) and the admin UI
 * (which edits the redacted form). Everything that reads process.env or
 * Supabase lives in ./settings.ts; everything that decides which provider a
 * given caller gets lives in lib/llm/resolve.ts.
 *
 * Why this exists: provider keys, routing order and "what do free users get"
 * used to be deploy-time env vars, so changing the tutor's provider meant a
 * redeploy and changing what anonymous visitors get meant a code change. Now
 * env is the BASE LAYER (so a fresh deploy still works from deploy.sh alone)
 * and the `platform_settings.llm` row is an OVERLAY an admin edits at
 * /admin/platform without touching Azure.
 */

export const PROVIDER_IDS = ['gemini', 'groq', 'anthropic', 'azure'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  gemini: 'Gemini',
  groq: 'Groq',
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
}

/** Default per-provider model when the admin leaves the field blank. */
export const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-4-6',
  // Azure has no sensible default: the model id is the DEPLOYMENT name the
  // operator chose. Blank means "not configured".
  azure: '',
}

/** Prefix LiteLLM (services/agent) wants in front of the model id. */
export const LITELLM_PREFIX: Record<ProviderId, string> = {
  gemini: 'gemini/',
  groq: 'groq/',
  anthropic: 'anthropic/',
  azure: 'azure/',
}

export interface ProviderConfig {
  /** Plaintext key. Never leaves the server; see RedactedProviderConfig. */
  apiKey: string
  /** Model id (deployment name for Azure). Blank → PROVIDER_DEFAULT_MODEL. */
  model: string
  /** Azure only: resource endpoint. */
  baseUrl: string
  /** Azure only. */
  apiVersion: string
  /** An admin can switch a provider off without deleting its key. */
  enabled: boolean
}

export type TierId = 'anonymous' | 'free' | 'trial' | 'paid'
export const TIER_IDS: readonly TierId[] = ['anonymous', 'free', 'trial', 'paid']

export const TIER_LABEL: Record<TierId, string> = {
  anonymous: 'Signed out',
  free: 'Free (after the launch trial)',
  trial: 'Launch trial (first 30 days)',
  paid: 'Pro / Team / Edu',
}

/**
 * live    — a real model answers (through the tool-calling agent when it is
 *           reachable, else a direct provider call).
 * offline — the built-in FAQ answers; no model is called, nothing is spent.
 * off     — the tutor refuses with a sign-in / upgrade nudge.
 */
export type TierAccess = 'live' | 'offline' | 'off'
export const TIER_ACCESS: readonly TierAccess[] = ['live', 'offline', 'off']

export interface TierPolicy {
  access: TierAccess
  /** 'auto' = follow `order` (cheapest-first); a provider id pins this tier. */
  provider: ProviderId | 'auto'
  /** Messages per rolling 24 h per caller. null = unlimited. */
  messagesPerDay: number | null
  /** Whether Tier 1 (the tool-calling agent, which runs circuits) is offered. */
  tools: boolean
}

export interface LlmSettings {
  providers: Record<ProviderId, ProviderConfig>
  /** Cheapest-first by default; the admin can reorder. */
  order: ProviderId[]
  /** Pin every tier to one provider (falls through when it has no key). */
  forceProvider: ProviderId | null
  tiers: Record<TierId, TierPolicy>
  /** Free-text note shown only in the admin console ("rotated 3 Sep"). */
  note: string
}

/** What the admin UI receives: keys replaced by "is one set" + a hint. */
export interface RedactedProviderConfig extends Omit<ProviderConfig, 'apiKey'> {
  apiKeySet: boolean
  /** Last 4 characters, enough to recognise a key, useless to use it. */
  apiKeyHint: string
  /** Where the effective key comes from — so the console can say "from env". */
  keySource: 'settings' | 'env' | 'none'
}

export interface RedactedLlmSettings extends Omit<LlmSettings, 'providers'> {
  providers: Record<ProviderId, RedactedProviderConfig>
}

/**
 * What the admin UI sends back. `apiKey` is optional per provider: absent or
 * empty means "keep whatever is stored"; the literal sentinel CLEAR_KEY means
 * "remove the stored key (fall back to env, if any)".
 */
export interface LlmSettingsPatch {
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>
  order?: ProviderId[]
  forceProvider?: ProviderId | null
  tiers?: Partial<Record<TierId, Partial<TierPolicy>>>
  note?: string
}

export const CLEAR_KEY = '__clear__'

export const DEFAULT_ORDER: ProviderId[] = ['gemini', 'groq', 'anthropic', 'azure']

/**
 * The launch policy: everyone gets the live tutor, and cost is bounded by a
 * per-caller daily quota that gets looser the more committed the caller is.
 * Signed-out visitors get a taste (enough to see the tutor run a circuit),
 * accounts get the Free plan's quota, the launch trial and paid plans are
 * unlimited. An admin can change every number at /admin/platform.
 */
export const DEFAULT_TIERS: Record<TierId, TierPolicy> = {
  anonymous: { access: 'live', provider: 'auto', messagesPerDay: 10, tools: true },
  free: { access: 'live', provider: 'auto', messagesPerDay: 20, tools: true },
  trial: { access: 'live', provider: 'auto', messagesPerDay: null, tools: true },
  paid: { access: 'live', provider: 'auto', messagesPerDay: null, tools: true },
}

export function emptyProvider(): ProviderConfig {
  return { apiKey: '', model: '', baseUrl: '', apiVersion: '', enabled: true }
}

export function emptyLlmSettings(): LlmSettings {
  return {
    providers: {
      gemini: emptyProvider(),
      groq: emptyProvider(),
      anthropic: emptyProvider(),
      azure: emptyProvider(),
    },
    order: [...DEFAULT_ORDER],
    forceProvider: null,
    tiers: {
      anonymous: { ...DEFAULT_TIERS.anonymous },
      free: { ...DEFAULT_TIERS.free },
      trial: { ...DEFAULT_TIERS.trial },
      paid: { ...DEFAULT_TIERS.paid },
    },
    note: '',
  }
}

/** Every provider id exactly once; unknown ids dropped, missing ones appended. */
export function normalizeOrder(order: unknown): ProviderId[] {
  const seen = new Set<ProviderId>()
  const out: ProviderId[] = []
  if (Array.isArray(order)) {
    for (const id of order) {
      if (isProviderId(id) && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  for (const id of DEFAULT_ORDER) if (!seen.has(id)) out.push(id)
  return out
}

const MAX_MODEL_CHARS = 120
const MAX_URL_CHARS = 400
const MAX_NOTE_CHARS = 500
const MAX_PER_DAY = 100_000

/**
 * Hosts a provider's `baseUrl` may point at. Only Azure takes a base URL (the
 * others use their SDK's fixed endpoint), and an Azure OpenAI / AI Foundry
 * resource always lives under one of these suffixes. The admin test route sends
 * the provider key to this URL, and the tutor sends every prompt to it, so an
 * arbitrary host here is a credential-exfiltration and internal-probe primitive.
 *
 * Extra hosts (a sovereign cloud, a private endpoint name) can be added with the
 * optional PLATFORM_LLM_ALLOWED_HOSTS env var: a comma-separated list of exact
 * hostnames or `.suffix` entries. Unset, only the Azure suffixes are accepted.
 */
const AZURE_HOST_SUFFIXES = [
  '.openai.azure.com',
  '.cognitiveservices.azure.com',
  '.services.ai.azure.com',
]

function extraAllowedHosts(): string[] {
  return (process.env.PLATFORM_LLM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/** True for an https URL on an allowed provider host that is not an IP literal. */
export function isAllowedProviderBaseUrl(id: ProviderId, value: string): boolean {
  if (id !== 'azure') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  if (url.port && url.port !== '443') return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // IP literals (v4 or v6) are never a provider host.
  if (host.includes(':') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return false
  if (AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) {
    return true
  }
  return extraAllowedHosts().some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry
  )
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max)
}

export function normalizeTierPolicy(base: TierPolicy, patch: unknown): TierPolicy {
  if (!patch || typeof patch !== 'object') return { ...base }
  const p = patch as Record<string, unknown>
  const out: TierPolicy = { ...base }
  if (typeof p.access === 'string' && (TIER_ACCESS as readonly string[]).includes(p.access)) {
    out.access = p.access as TierAccess
  }
  if (p.provider === 'auto' || isProviderId(p.provider)) out.provider = p.provider
  if (p.messagesPerDay === null) out.messagesPerDay = null
  else if (typeof p.messagesPerDay === 'number' && Number.isFinite(p.messagesPerDay)) {
    out.messagesPerDay = Math.min(MAX_PER_DAY, Math.max(0, Math.floor(p.messagesPerDay)))
  }
  if (typeof p.tools === 'boolean') out.tools = p.tools
  return out
}

/**
 * Apply an untrusted patch (the admin UI's PUT body) to a settings object.
 * Strings are trimmed and bounded; unknown fields are ignored; `apiKey` is
 * handled by the caller (it needs encryption) and is passed through here
 * verbatim only when present.
 */
export function applyLlmPatch(base: LlmSettings, patch: LlmSettingsPatch): LlmSettings {
  const next: LlmSettings = {
    providers: { ...base.providers },
    order: [...base.order],
    forceProvider: base.forceProvider,
    tiers: { ...base.tiers },
    note: base.note,
  }
  if (patch.providers && typeof patch.providers === 'object') {
    for (const id of PROVIDER_IDS) {
      const p = patch.providers[id]
      if (!p || typeof p !== 'object') continue
      const cur = { ...next.providers[id] }
      const model = cleanString(p.model, MAX_MODEL_CHARS)
      if (model !== undefined) cur.model = model
      const baseUrl = cleanString(p.baseUrl, MAX_URL_CHARS)
      // An empty string clears the field; anything else must be an allowed
      // provider host or the patch keeps the current value.
      if (baseUrl !== undefined && (baseUrl === '' || isAllowedProviderBaseUrl(id, baseUrl))) {
        cur.baseUrl = baseUrl
      }
      const apiVersion = cleanString(p.apiVersion, 64)
      if (apiVersion !== undefined) cur.apiVersion = apiVersion
      if (typeof p.enabled === 'boolean') cur.enabled = p.enabled
      if (typeof p.apiKey === 'string') {
        const key = p.apiKey.trim()
        if (key === CLEAR_KEY) cur.apiKey = ''
        else if (key.length > 0) cur.apiKey = key.slice(0, 512)
      }
      next.providers[id] = cur
    }
  }
  if (patch.order !== undefined) next.order = normalizeOrder(patch.order)
  if (patch.forceProvider === null) next.forceProvider = null
  else if (isProviderId(patch.forceProvider)) next.forceProvider = patch.forceProvider
  if (patch.tiers && typeof patch.tiers === 'object') {
    for (const tier of TIER_IDS) {
      if (tier in patch.tiers) next.tiers[tier] = normalizeTierPolicy(next.tiers[tier], patch.tiers[tier])
    }
  }
  const note = cleanString(patch.note, MAX_NOTE_CHARS)
  if (note !== undefined) next.note = note
  return next
}

/** Is this provider callable at all (key present, enabled, Azure fully specified)? */
export function providerReady(id: ProviderId, cfg: ProviderConfig): boolean {
  if (!cfg.enabled || !cfg.apiKey) return false
  if (id === 'azure') return Boolean(cfg.baseUrl && cfg.model)
  return true
}

export function providerModel(id: ProviderId, cfg: ProviderConfig): string {
  return cfg.model || PROVIDER_DEFAULT_MODEL[id]
}

export function keyHint(apiKey: string): string {
  if (!apiKey) return ''
  return apiKey.length <= 4 ? '••••' : `…${apiKey.slice(-4)}`
}
