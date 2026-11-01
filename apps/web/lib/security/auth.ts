/**
 * security/auth.ts — "who is calling this route handler?", one answer only.
 *
 * SERVER ONLY. Do not import from a client component.
 *
 * This is the exact mechanism the billing routes already used (audit findings
 * BILL-1 / BILL-2 / ORG-1), lifted out of four byte-identical private copies in
 * `app/api/billing/portal`, `app/api/billing/entitlement`, `app/api/orgs` and
 * `app/api/orgs/members` so there is one place to read, one place to fix, and no
 * chance of the copies drifting apart.
 *
 * The rule it exists to enforce: IDENTITY COMES FROM A VERIFIED TOKEN AND
 * NOTHING ELSE. A `userId` in a JSON body or a query string is a claim, never a
 * credential — every handler here compares such a value against the id returned
 * by `auth.getUser(token)`, which Supabase itself validates, so a forged or
 * expired token fails.
 */

import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import { touchApiKey, verifyApiKey, type ApiScope } from '@/lib/security/apiKeys'

/** Bearer tokens are JWTs; anything this long is an attack, not a session. */
const MAX_TOKEN_CHARS = 4096

export const SIGN_IN_REQUIRED =
  'Sign-in required. Send your Supabase access token as `Authorization: Bearer <token>`.'

/**
 * The raw access token presented by the caller, or '' when there is none.
 * `x-supabase-auth` is kept as a fallback so a deployment using a cookie-to-
 * header bridge keeps working — it is the same token, carried differently.
 */
export function bearerToken(req: Request): string {
  const bearer = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)
  const token = (bearer?.[1] ?? req.headers.get('x-supabase-auth') ?? '').trim()
  if (!token || token.length > MAX_TOKEN_CHARS) return ''
  return token
}

/** A caller Supabase has vouched for. Both fields come from the token. */
export interface VerifiedCaller {
  id: string
  /** Lower-cased, or '' when the account has no email. Never from the request. */
  email: string
}

/**
 * What happened when we tried to identify the caller. The three reasons for
 * "no caller" that `verifiedCaller` flattens into one `null` are kept apart
 * here, because they need three different answers:
 *
 *   - `none`        No token was presented (or this deployment has no auth
 *                   service configured, so no token CAN be checked). The caller
 *                   is anonymous. Fine for a route that admits guests.
 *   - `invalid`     A token was presented and the auth service said it is not a
 *                   session: expired, revoked, forged. Answer 401 so the client
 *                   refreshes its session; do NOT quietly treat it as anonymous.
 *   - `unavailable` A token was presented and the auth service could not say
 *                   (network failure, timeout, 5xx, rate limit). The token may
 *                   be perfectly good. Answer 503 so the client retries; do NOT
 *                   treat the caller as anonymous.
 *   - `ok`          Vouched for.
 */
export type CallerOutcome =
  | { kind: 'ok'; caller: VerifiedCaller }
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' }

/**
 * Is this Supabase auth error "the service could not answer" rather than "the
 * token is bad"? Network failures surface as `AuthRetryableFetchError`
 * (status 0 or undefined), a struggling service as 5xx, a throttled one as 429.
 * Everything else (400/401/403: bad JWT, session not found, expired) is the
 * token's fault.
 */
function isServiceFailure(error: { name?: string; status?: number }): boolean {
  if (error.name === 'AuthRetryableFetchError') return true
  const status = error.status
  if (typeof status !== 'number') return false
  return status === 0 || status === 429 || status >= 500
}

/**
 * Like `verifiedCaller`, but says WHY there is no caller.
 *
 * Use this on any route where "the token did not verify" must not be treated
 * the same as "there was no token" (audit finding exams-certs #37: a signed-in
 * candidate was silently dealt a guest attempt during a transient auth outage).
 * `verifiedCaller` is unchanged and still collapses all three to `null`.
 *
 * Never throws.
 */
export async function verifyCallerOutcome(req: Request): Promise<CallerOutcome> {
  const token = bearerToken(req)
  if (!token) return { kind: 'none' }
  const supabase = getSupabase()
  if (!supabase) return { kind: 'none' }
  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error) return isServiceFailure(error) ? { kind: 'unavailable' } : { kind: 'invalid' }
    const id = data.user?.id
    if (!id) return { kind: 'invalid' }
    return { kind: 'ok', caller: { id, email: (data.user?.email ?? '').trim().toLowerCase() } }
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * Resolve the caller from their access token: id AND verified email.
 *
 * The email is here for the invite-acceptance path (audit finding INV-1), which
 * has to answer "is the person clicking this link the person it was sent to?".
 * That question is only meaningful against an email SUPABASE returns for the
 * token — an email in a request body is a claim, exactly like a `userId`.
 *
 * Returns null when no valid token is present, INCLUDING when the auth service
 * could not be reached; use `verifyCallerOutcome` to tell those apart. Never
 * throws.
 */
export async function verifiedCaller(req: Request): Promise<VerifiedCaller | null> {
  const outcome = await verifyCallerOutcome(req)
  return outcome.kind === 'ok' ? outcome.caller : null
}

/**
 * Resolve the caller's Supabase user id from their access token.
 * Returns null when no valid token is present. Never throws.
 */
export async function verifiedCallerId(req: Request): Promise<string | null> {
  return (await verifiedCaller(req))?.id ?? null
}

/** The canonical 401 body. Deliberately identical across every route. */
export function signInRequiredResponse(): Response {
  return NextResponse.json({ error: SIGN_IN_REQUIRED }, { status: 401 })
}

// ── API keys ────────────────────────────────────────────────────────────────

/**
 * Who is calling, when a key is an acceptable credential.
 *
 * ── THIS IS OPT-IN PER ROUTE, AND MUST STAY THAT WAY ────────────────────────
 *
 * `verifiedCaller` and `verifiedCallerId` above are unchanged and still accept
 * a Supabase session token and nothing else. Making THEM accept keys would
 * have been one line and would have silently extended key authority to every
 * route in the app — billing, the customer portal, org membership, exam
 * attempts, the platform admin console. A credential that sits in a CI
 * environment variable must not be able to change the subscription it spends
 * against or alter who is in an organisation.
 *
 * So a route that wants to be scriptable calls THIS function, and the set of
 * such routes is a decision somebody makes on purpose. Today it is the
 * `/api/hardware/*` surface.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 *
 * A session token is tried first. Only when that fails is the same bearer
 * value tried as a key, and the structural check in `verifyApiKey` (the
 * `qb16_sk_` prefix) means a JWT never reaches the database as a candidate
 * key, and a key is never sent to Supabase's token verifier twice.
 *
 * ── Failure is a refusal, not a fallthrough ─────────────────────────────────
 *
 * `verifyApiKey` throws `ApiKeyStoreError` when the store cannot answer, and
 * this function lets it propagate rather than returning null. A caller
 * presenting a key during a database outage must get "we cannot tell" and not
 * "you are anonymous" — the same fail-closed rule `lib/billing/usage.ts`
 * applies to the quota. Routes turn it into a 503.
 *
 * @param req The incoming request.
 * @returns The caller and how they authenticated, or null when neither
 *   credential is valid.
 * @throws ApiKeyStoreError When a key was presented and could not be checked.
 */
export async function verifiedApiCaller(req: Request): Promise<ApiCaller | null> {
  const sessionId = await verifiedCallerId(req)
  if (sessionId) return { id: sessionId, via: 'session', scopes: null, keyId: null }

  const presented = bearerToken(req)
  if (!presented) return null

  const key = await verifyApiKey(presented)
  if (!key) return null

  // Bookkeeping only, deliberately not awaited — see `touchApiKey`.
  touchApiKey(key.keyId)
  return { id: key.userId, via: 'api-key', scopes: key.scopes, keyId: key.keyId }
}

/** A caller resolved from either credential. */
export interface ApiCaller {
  id: string
  via: 'session' | 'api-key'
  /**
   * The key's scopes, or null for a session.
   *
   * `null` means "not scope-limited", which is why `callerHasScope` returns
   * true for it: a person signed into the site is exercising the full
   * authority of their own account, and scopes exist to let them hand a
   * SUBSET of that authority to a script. An empty array is the opposite —
   * a key that authenticates and may do nothing — so the two must not be
   * conflated, and `scopes: []` must never be used to mean "unrestricted".
   */
  scopes: ApiScope[] | null
  keyId: string | null
}

/**
 * May this caller do the thing this route does?
 *
 * @param caller The resolved caller.
 * @param scope The capability the route needs.
 * @returns True when the caller holds it.
 */
export function callerHasScope(caller: ApiCaller, scope: ApiScope): boolean {
  if (caller.scopes === null) return true
  return caller.scopes.includes(scope)
}

/** The 403 for a key that authenticated but may not do this. */
export function scopeRequiredResponse(scope: ApiScope): Response {
  return NextResponse.json(
    {
      error: `This API key does not have the '${scope}' scope.`,
      detail:
        `This API key authenticated successfully but does not carry the '${scope}' scope, ` +
        'so it may not perform this action. Issue a new key with that scope from your account page.',
    },
    { status: 403 }
  )
}
