/**
 * /api/keys — issue and list this account's API keys.
 *
 * ── A KEY CANNOT REACH THIS ROUTE ───────────────────────────────────────────
 *
 * Identity here comes from `verifiedCallerId`, which accepts a Supabase
 * SESSION token and nothing else — not `verifiedApiCaller`, which also accepts
 * a key. That is the single most important line in this file.
 *
 * If a key could mint a key, revocation would stop meaning anything: an
 * attacker holding a leaked key issues a second one, and revoking the first
 * leaves the second working. It also means a credential sitting in a CI
 * environment variable cannot quietly grant itself a successor with wider
 * scopes. Key management is an account action and requires the account.
 *
 * Do not "simplify" this by switching to `verifiedApiCaller`.
 *
 * ── The key is returned exactly once ────────────────────────────────────────
 *
 * POST returns the key in its response body and it is never retrievable again;
 * only its SHA-256 hash is stored. A lost key is replaced, not recovered. The
 * response is `no-store` so no cache anywhere holds a copy.
 */

import { NextResponse } from 'next/server'
import { rateLimit, callerKey, retryAfterHeaders } from '@/lib/rateLimit'
import { signInRequiredResponse, verifiedCallerId } from '@/lib/security/auth'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import {
  API_SCOPES,
  ApiKeyStoreError,
  apiKeysConfigured,
  listApiKeys,
  mintApiKey,
  normaliseScopes,
  type ApiScope,
} from '@/lib/security/apiKeys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Issuing is rare and each one is a durable credential, so the bucket is
 * tight. Listing shares it; a page that lists keys does so once per visit.
 */
const KEYS_LIMIT = { limit: 20, windowMs: 60_000 }

/** More than this many live keys is a sign of a loop, not of a workflow. */
const MAX_KEYS_PER_ACCOUNT = 25

/** The 503 for a deployment with no service-role key configured. */
function storeUnavailable(err: ApiKeyStoreError): NextResponse {
  console.error(`[api/keys] ${err.why}`)
  return NextResponse.json(
    {
      error: 'API keys are unavailable.',
      detail:
        'This deployment has no Supabase service-role key configured, so API keys cannot be ' +
        'issued or verified. Set SUPABASE_SERVICE_ROLE_KEY and apply supabase/schema-integrations.sql.',
    },
    { status: 503 }
  )
}

export async function GET(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const decision = await rateLimit(callerKey(req.headers, 'api-keys', caller), KEYS_LIMIT)
  if (!decision.allowed) {
    return NextResponse.json(
      { error: 'Too many requests.' },
      { status: 429, headers: retryAfterHeaders(decision) }
    )
  }

  if (!apiKeysConfigured()) {
    return storeUnavailable(new ApiKeyStoreError('SUPABASE_SERVICE_ROLE_KEY is not configured.'))
  }

  try {
    const keys = await listApiKeys(caller)
    return NextResponse.json({ keys, scopes: API_SCOPES }, { headers: { 'cache-control': 'no-store' } })
  } catch (err) {
    if (err instanceof ApiKeyStoreError) return storeUnavailable(err)
    throw err
  }
}

export async function POST(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const decision = await rateLimit(callerKey(req.headers, 'api-keys', caller), KEYS_LIMIT)
  if (!decision.allowed) {
    return NextResponse.json(
      { error: 'Too many requests.' },
      { status: 429, headers: retryAfterHeaders(decision) }
    )
  }

  if (!apiKeysConfigured()) {
    return storeUnavailable(new ApiKeyStoreError('SUPABASE_SERVICE_ROLE_KEY is not configured.'))
  }

  // 4 KiB is generous for `{name, scopes}` and small enough that a bad client
  // cannot make the server buffer anything interesting.
  const parsed = await readJsonBody(req, 4096)
  if (!parsed.ok && parsed.tooLarge) return NextResponse.json({ error: parsed.error }, { status: 413 })
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (!isRecord(parsed.value)) {
    return NextResponse.json({ error: 'Expected a JSON object body.' }, { status: 400 })
  }
  const body = parsed.value

  const name = str(body.name, 64, 'name')
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
  const trimmed = name.value.trim()
  if (!trimmed) {
    return NextResponse.json(
      { error: 'Give the key a name, so you can tell which one to revoke later.' },
      { status: 400 }
    )
  }

  // Unknown scope strings are DROPPED, not refused. A client built against a
  // later release asking for a scope this deployment does not model should get
  // a working key with the scopes that do exist, rather than a 400 it cannot
  // act on. The reverse — silently granting an unrecognised scope — is the
  // dangerous direction, and `normaliseScopes` cannot do it.
  const scopes: ApiScope[] = normaliseScopes(body.scopes)
  if (scopes.length === 0) {
    return NextResponse.json(
      {
        error: 'Choose at least one scope.',
        detail: `Valid scopes are: ${API_SCOPES.join(', ')}.`,
      },
      { status: 400 }
    )
  }

  try {
    // Counted from the live listing rather than tracked separately: the bound
    // is about keeping the account's own list legible, so it should reflect
    // exactly what the owner sees.
    const existing = await listApiKeys(caller)
    const live = existing.filter((k) => !k.revokedAt)
    if (live.length >= MAX_KEYS_PER_ACCOUNT) {
      return NextResponse.json(
        {
          error: `You already have ${MAX_KEYS_PER_ACCOUNT} active API keys.`,
          detail: 'Revoke one you no longer use before issuing another.',
        },
        { status: 409 }
      )
    }

    const minted = await mintApiKey(caller, trimmed, scopes)
    return NextResponse.json(minted, {
      status: 201,
      // The body contains the key. Nothing may cache it — not a CDN, not the
      // browser's back/forward cache, not a corporate proxy.
      headers: { 'cache-control': 'no-store' },
    })
  } catch (err) {
    if (err instanceof ApiKeyStoreError) return storeUnavailable(err)
    throw err
  }
}
