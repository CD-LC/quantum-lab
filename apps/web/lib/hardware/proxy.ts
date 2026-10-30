/**
 * proxy.ts — the SERVER half of the hardware client. Never import from a
 * component; it reads a secret out of the environment.
 *
 * Why this exists: `lib/hardware/client.ts` used to call `services/api`
 * straight from the browser using `NEXT_PUBLIC_API_URL`. That is the single
 * reason the opt-in `API_SHARED_SECRET` in `services/api/app/core/security.py`
 * could not be switched on — a browser cannot be given the secret (a secret in
 * a bundle is not a secret), so enabling the gate returned 401 to the hardware
 * page. docs/SECURITY.md §4 step 3 asks for exactly this module.
 *
 * ── The contract this module must not break ─────────────────────────────────
 *
 * With NO secret configured the observable behaviour of the hardware page is
 * unchanged: same upstream host, same paths, same status codes, same response
 * bodies, same error text. The only difference is that the bytes take one extra
 * hop through the Next server. Local development is therefore untouched — and
 * must stay untouched, because `services/api` is normally not running at all
 * during local development and the page's "the API is not up, here is the
 * command" state is a designed state, not a fault.
 *
 * ── Surface ─────────────────────────────────────────────────────────────────
 *
 * Only the endpoints the app and the public API actually call are forwarded:
 *
 *   GET    /api/hardware/devices
 *   POST   /api/hardware/estimate
 *   POST   /api/hardware/transpile
 *   POST   /api/hardware/recommend       (ranks devices; spends nothing)
 *   POST   /api/circuits/resources       (FT resource estimate; pure arithmetic)
 *   POST   /api/hardware/submit          (sampler AND estimator)
 *   GET    /api/hardware/job/{provider}/{job_id}
 *   POST   /api/hardware/session         (reserves a device — spends money)
 *   DELETE /api/hardware/session/{id}
 *
 * `GET /api/hardware/jobs` is NOT in this list and is not a proxy: it reads
 * this account's stored job history out of our own database.
 *
 * This is NOT a catch-all `[...path]` proxy, deliberately. `services/api` also
 * exposes `/api/circuits/run` (executes arbitrary user QASM) and `/api/jobs`
 * (a job queue). A wildcard proxy would republish every one of them through
 * the Next server and quietly undo whatever the secret was protecting. If you
 * need another endpoint, add another route file and validate its shape too.
 */

import { NextResponse } from 'next/server'
import { apiError } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import {
  callerHasScope,
  scopeRequiredResponse,
  signInRequiredResponse,
  verifiedApiCaller,
  type ApiCaller,
} from '@/lib/security/auth'
import { ApiKeyStoreError, type ApiScope } from '@/lib/security/apiKeys'
import { QuotaUnavailableError } from '@/lib/billing/usage'
import type { ResolvedCredential } from '@/lib/security/providerCredentials'

/**
 * Same variable, same default, as `lib/hardware/client.ts` used to read from
 * the browser. Keeping it as `NEXT_PUBLIC_API_URL` means an existing
 * deployment or `.env.local` keeps working with no edit. Once the API is on a
 * private network the value becomes an internal hostname that only this
 * process can resolve — which is the point.
 */
const UPSTREAM_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

/**
 * The header `services/api` checks. Must match `SHARED_SECRET_HEADER` in
 * `services/api/app/core/security.py` byte for byte.
 */
const SECRET_HEADER = 'X-Quantum-Lab-Secret'

/**
 * The header carrying a BYOK credential for ONE request.
 *
 * Must match `CREDENTIALS_HEADER` in
 * `services/api/app/quantum/credentials.py` byte for byte.
 *
 * ── Why a header and not a body field ───────────────────────────────────────
 *
 * Polling is a GET, so a body was never an option there, and a query parameter
 * is the worst of all worlds: URLs are logged by every proxy, access log and
 * error reporter between here and the upstream. A header keeps a live vendor
 * token out of all of them, and one mechanism serving both submit and poll is
 * one fewer thing to get right twice.
 *
 * ── Why base64 ──────────────────────────────────────────────────────────────
 *
 * TRANSPORT SAFETY, NOT SECRECY. Base64 is trivially reversible and nothing
 * here pretends otherwise; it exists so that a token containing a character
 * that is illegal in an HTTP header value cannot corrupt the request or, worse,
 * split it. The real protection is that this hop is server-to-server over the
 * deployment's own network.
 */
const CREDENTIALS_HEADER = 'X-Quantum-Lab-Credentials'

/**
 * Backstop timeout. The browser's own AbortController fires at 8s (see
 * TIMEOUT_MS in client.ts) and its clock starts first, so in practice the
 * browser gives up before this does and the user sees the same message it
 * always saw. This one exists so a hung upstream cannot pin a serverless
 * invocation open until the platform's own maximum duration.
 */
const UPSTREAM_TIMEOUT_MS = 8_000

/** The upstream base, for error text that names the host that failed. */
export function upstreamBaseUrl(): string {
  return UPSTREAM_BASE
}

/**
 * The shared secret to present upstream, or null when none is configured.
 *
 * `QUANTUM_API_SECRET` is the name docs/SECURITY.md §4 tells operators to set
 * on the Next deployment; `API_SHARED_SECRET` is accepted as well because a
 * `docker compose` setup usually hands the same variable to both services.
 *
 * A `NEXT_PUBLIC_*` name is NOT accepted and must never be introduced here:
 * Next inlines those into the client bundle, which would publish the secret to
 * every visitor and make the gate worse than useless.
 */
export function upstreamSecret(): string | null {
  const value = (process.env.QUANTUM_API_SECRET ?? process.env.API_SHARED_SECRET ?? '').trim()
  return value.length > 0 ? value : null
}

/**
 * A 504 that the browser client turns back into its "offline" state.
 *
 * The `offline: true` flag is the whole point: before this proxy existed, an
 * unreachable API made the browser's own `fetch` throw, and the UI keys off
 * that to show setup guidance ("start the API with …") instead of an error
 * toast. Through a proxy the browser's fetch SUCCEEDS with a 5xx, so the flag
 * carries the distinction across the hop. `detail` is worded exactly as the
 * client used to word it, so the visible text does not change.
 */
function offlineResponse(detail: string, outcomeUnknown = false): NextResponse {
  return NextResponse.json(
    { detail, offline: true },
    { status: 504, ...(outcomeUnknown ? { headers: { [OUTCOME_HEADER]: 'unknown' } } : {}) }
  )
}

/**
 * Set on a 504 from `forward` when the request WAS SENT but no answer came back
 * in time (an abort). The upstream handler may still be running, so for a call
 * that creates something (a job submission) "no answer" is not "refused": a
 * caller must not release a reservation on it. A connection that could not be
 * made at all does NOT carry the header, because nothing was sent.
 */
export const OUTCOME_HEADER = 'x-qubit16-outcome'

/** True for a `forward` result whose outcome upstream is unknown (timed out). */
export function outcomeUnknown(response: Response): boolean {
  return response.headers.get(OUTCOME_HEADER) === 'unknown'
}

/**
 * Upstream timeout for calls that create a job. The submit handler upstream is
 * synchronous (service set-up, transpile, enqueue), so the 8s read timeout cut
 * healthy submissions off while the job went on to run.
 */
export const SUBMIT_TIMEOUT_MS = 45_000

/**
 * Forward one request upstream and hand the answer back unchanged.
 *
 * Status code and body are passed through verbatim — the client parses
 * FastAPI's `{ detail }` shape and the hardware page shows those messages, so
 * rewriting them here would degrade real error reporting (a 400 "shots must be
 * between 1 and 20000" is useful; "Bad Request" is not).
 *
 * Nothing from the incoming request's headers is forwarded. The browser has no
 * business setting anything upstream, and blindly relaying headers is how a
 * proxy ends up forwarding a caller-supplied `X-Quantum-Lab-Secret`.
 *
 * ── READ THIS BEFORE CALLING IT FROM A NEW ROUTE ────────────────────────────
 *
 * THIS FUNCTION PRESENTS THE OPERATOR'S SHARED SECRET. Whatever gate
 * `services/api` would have applied to the caller, this hop has already passed
 * on their behalf. A route that calls `forward` without deciding who the caller
 * is has re-opened the upstream endpoint to the open internet with the
 * operator's credentials attached — which is precisely the regression that
 * `app/api/hardware/submit/route.ts` shipped and these helpers exist to stop.
 * Every gate a paid endpoint needs must run BEFORE this call, in the route
 * handler, and `lib/hardware/proxy.test.ts` asserts the secret is never
 * attached until they have.
 *
 * @param path Absolute upstream path, e.g. '/api/hardware/devices'.
 * @param body JSON payload for a POST, or undefined for a GET.
 */
export async function forward(
  path: string,
  body?: unknown,
  /**
   * Overrides the method inferred from `body`.
   *
   * The inference — no body means GET, a body means POST — covered every
   * endpoint until closing a runtime session needed a DELETE with no body,
   * which the inference reads as a GET. Passing the method explicitly is the
   * narrow fix; making every caller pass one would be churn for no safety.
   */
  method?: 'GET' | 'POST' | 'DELETE',
  /**
   * A BYOK credential to present upstream INSTEAD of the operator's, for this
   * one request.
   *
   * ── READ THIS BEFORE PASSING ONE ────────────────────────────────────────
   *
   * This is a live vendor token belonging to a user. It is attached to exactly
   * one outbound request and is never stored, cached or logged here. It must
   * come from `resolveProviderCredential()` and from nothing else — in
   * particular NEVER from a field on the incoming request. A browser-supplied
   * token would be in browser memory, in any error report, and in whatever
   * logs the request passed through on its way here, which is precisely the
   * shape the internal handoff notes §4 rules out.
   *
   * Null (the default) means "use the operator's credentials", which is the
   * behaviour every caller had before this parameter existed.
   */
  credential?: ResolvedCredential | null,
  /** Override the default 8s upstream timeout, e.g. SUBMIT_TIMEOUT_MS for a job submission. */
  options?: { timeoutMs?: number }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  const secret = upstreamSecret()
  if (secret) headers[SECRET_HEADER] = secret
  if (credential) headers[CREDENTIALS_HEADER] = encodeCredential(credential)

  try {
    const upstream = await fetch(`${UPSTREAM_BASE}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })

    const text = await upstream.text()
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        // The hardware page polls; a cached device list or job status would be
        // wrong rather than merely stale.
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError'
    return offlineResponse(
      aborted
        ? `No response from ${UPSTREAM_BASE} within ${timeoutMs / 1000}s.`
        : `Could not reach ${UPSTREAM_BASE}.`,
      aborted
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Serialise a BYOK credential into the header value the upstream parses.
 *
 * The wire shape is `base64(JSON)` and the JSON keys are the ones
 * `services/api/app/quantum/credentials.py` reads: `provider`, `token`,
 * `instance`. Keep the two in step — a mismatch here does not fail loudly, it
 * makes the upstream fall back to the operator's credentials, which is a
 * silently wrong bill rather than an error.
 *
 * `Buffer` rather than `btoa` because a vendor token is not guaranteed to be
 * latin-1 and `btoa` throws on anything that is not. Node runtime only, which
 * this module already requires (it reads `process.env`).
 *
 * @param credential An opened credential from `resolveProviderCredential`.
 * @returns The header value. Contains a live token; do not log it.
 */
function encodeCredential(credential: ResolvedCredential): string {
  return Buffer.from(
    // The fields are spread FIRST and `provider` written last, so a stored
    // field called `provider` cannot override the provider this credential was
    // actually looked up under — which is the one value upstream uses to
    // decide which vendor to authenticate against.
    JSON.stringify({ ...credential.fields, provider: credential.provider }),
    'utf8'
  ).toString('base64')
}

/**
 * Per-caller limits for the proxied routes.
 *
 * `submit` is separate and much tighter because it is the only one that spends
 * money: each accepted call enqueues a job on IBM or Braket. The others cost
 * CPU on a machine you own. Both are keyed on the caller's IP, with all the
 * caveats in lib/rateLimit.ts — this bounds one script, not a pool of hosts.
 */
export const READ_LIMIT: RateLimitRule = { limit: 60, windowMs: 60_000 }
export const SUBMIT_LIMIT: RateLimitRule = { limit: 5, windowMs: 60_000 }

/**
 * Apply a limit and return a 429 to send, or null to continue.
 *
 * The body is a fixed string. It names no key, no count and no identity, so it
 * cannot be used to probe whether some other caller's bucket exists.
 *
 * @param subject A VERIFIED caller id. When present the bucket is keyed on the
 *                account rather than the IP, which is the only key an attacker
 *                cannot rotate for free. Pass it only after `requireCaller`.
 */
export async function limitOrNull(
  req: Request,
  prefix: string,
  rule: RateLimitRule,
  subject?: string | null
): Promise<NextResponse | null> {
  const decision = await rateLimit(callerKey(req.headers, prefix, subject), rule)
  if (decision.allowed) return null
  return NextResponse.json(
    { detail: 'Too many requests. Wait a moment and try again.' },
    { status: 429, headers: retryAfterHeaders(decision) }
  )
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The verified caller behind this request, or the response to send back.
 *
 * `lib/security/auth.ts` is the project's ONE auth mechanism (the billing and
 * org routes already use it); this is a thin wrapper that shapes its answer
 * like the other `…OrNull` helpers here so a route handler reads as a straight
 * line of gates. The identity comes from a credential the server verified and
 * from nothing else — never from a `userId` in the body, which is a claim.
 *
 * ── Two credentials, one identity ───────────────────────────────────────────
 *
 * This is the surface where a SCRIPT is a first-class caller, so it accepts
 * either a Supabase session token (a browser) or a `qb16_sk_…` API key (a
 * script, a CI job, a notebook). `verifiedApiCaller` tries them in that order.
 *
 * The rest of the app does NOT do this and must not start: billing, orgs,
 * exams and the platform console all still call `verifiedCallerId`, which
 * accepts a session and nothing else. A credential living in a CI environment
 * variable must not be able to change the subscription it spends against.
 *
 * ── Scopes ──────────────────────────────────────────────────────────────────
 *
 * `scope` is what this route needs. A session caller always has it — a person
 * signed into the site is exercising the full authority of their own account.
 * A key has it only if it was issued with it, and is refused with a 403 that
 * names the missing scope, so the fix is obvious from the error alone.
 *
 * ── An unverifiable key is a refusal ────────────────────────────────────────
 *
 * When a key was presented and the store could not answer, this returns 503
 * rather than 401. "We cannot check your credential" is not "you are
 * anonymous", and the difference is what stops a database blip from reading to
 * a script as a permanent auth failure it should stop retrying.
 *
 * The 401 body uses `detail`, not `error`, because `lib/hardware/client.ts`
 * reads FastAPI's `{ detail }` shape and the hardware page renders it. A 401
 * the user cannot read is a support ticket.
 */
export async function requireCaller(
  req: Request,
  scope: ApiScope = 'hardware:read'
): Promise<{ ok: true; id: string; via: 'session' | 'api-key' } | { ok: false; response: NextResponse }> {
  let caller: ApiCaller | null
  try {
    caller = await verifiedApiCaller(req)
  } catch (err) {
    if (err instanceof ApiKeyStoreError) {
      console.error(`[hardware/proxy] API key could not be verified: ${err.why}`)
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: 'Your API key could not be verified right now.',
            detail:
              'The credential store is unreachable, so this request was refused rather than ' +
              'treated as anonymous. Your key is almost certainly fine — retry shortly.',
          },
          { status: 503 }
        ),
      }
    }
    throw err
  }

  if (caller && callerHasScope(caller, scope)) {
    return { ok: true, id: caller.id, via: caller.via }
  }

  if (caller) {
    // Authenticated, but this key may not do this. A distinct 403 rather than
    // a 401: retrying with the same key will never work, and telling a script
    // to "sign in" when it did sign in sends the reader in the wrong direction.
    const refusal = scopeRequiredResponse(scope)
    return { ok: false, response: refusal as NextResponse }
  }

  // Mirror the canonical body so the shape matches every other route, then add
  // `detail` for the hardware client's renderer.
  const canonical = signInRequiredResponse()
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: 'Sign-in required.',
        detail:
          'Sign in to submit a job to real quantum hardware, or send an API key as ' +
          '`Authorization: Bearer qb16_sk_…`. Running on hardware is a Pro feature.',
        upgradeUrl: '/pricing',
      },
      { status: canonical.status }
    ),
  }
}

/**
 * A 402 for a plan that does not include the feature, or an allowance that is
 * spent. Same status the billing routes use, so the client has one thing to
 * recognise.
 */
export function featureLocked(detail: string): NextResponse {
  return NextResponse.json(
    { error: detail, detail, feature: 'hardware.real', requiredPlan: 'pro', upgradeUrl: '/pricing' },
    { status: 402 }
  )
}

/**
 * A 503 for "the quota store could not answer".
 *
 * THIS IS THE FAIL-CLOSED BRANCH and it must stay a refusal. Allowing the job
 * when the meter is broken converts a database outage into an unbounded
 * provider bill, and the operator finds out from an invoice. The reason string
 * is logged, never published: it names environment variables and tables.
 */
export function quotaUnavailable(
  err: QuotaUnavailableError,
  route: string,
  detail = 'Hardware submission is temporarily unavailable because usage cannot be metered. Nothing was submitted.'
): NextResponse {
  console.error(`[${route}] refusing: ${err.why}`)
  return NextResponse.json({ detail, error: detail }, { status: 503 })
}

/** Parse a forwarded 2xx body without trusting its shape. Null when unusable. */
export async function forwardedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (response.status < 200 || response.status >= 300) return null
  try {
    const parsed: unknown = await response.clone().json()
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A 400 in the shape FastAPI uses, so the client renders it identically. */
export function badRequest(detail: string): NextResponse {
  return NextResponse.json({ detail }, { status: 400 })
}

/**
 * Validation bounds, mirrored from `services/api`.
 *
 * These are a SECOND check, not the only one: the FastAPI schemas and
 * `guard_qasm()` still run upstream and remain authoritative. Checking here
 * means an oversized or malformed body is refused before it costs a network
 * round trip and a Qiskit parse — which is the whole reason `guard_qasm` was
 * moved ahead of `parse_qasm` in the first place (audit finding PY-1: a 50-byte
 * body made Qiskit allocate 669 MB).
 *
 * If you change a bound upstream, change it here too. A mismatch is not a
 * security hole in either direction — the tighter of the two wins — but it
 * produces confusing errors.
 */
/** `MAX_QASM_CHARS` in services/api/app/routers/circuits.py. */
export const MAX_QASM_CHARS = 131_072
/** `settings.max_shots` in services/api/app/core/config.py. */
export const MAX_SHOTS = 20_000
/** Backend ids are registry keys like `ibm_brisbane`; nothing is near this. */
export const MAX_BACKEND_CHARS = 64
/** Bytes of request body accepted before parsing, ~ MAX_QASM_CHARS plus slack. */
export const MAX_BODY_BYTES = 160_000

/**
 * Read and parse a JSON object body, or return the 400 to send back.
 *
 * `readJsonBody` enforces the byte cap WHILE READING the stream (audit finding
 * VAL-1), so an oversized body is refused with 413 without being buffered;
 * `await req.json()` on an unbounded body is not.
 */
export async function readJsonObject(
  req: Request
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return { ok: false, response: apiError('payload_too_large') }
  if (!parsed.ok) return { ok: false, response: badRequest(parsed.error) }
  if (!isRecord(parsed.value)) return { ok: false, response: badRequest('Expected a JSON object.') }
  return { ok: true, value: parsed.value }
}

/**
 * Validate the `qasm` + `backend` pair every circuit endpoint shares.
 *
 * `qasm` is checked but NOT trimmed, and is forwarded exactly as it arrived.
 * `validate.str()` trims, and OpenQASM is whitespace-sensitive enough
 * (line-oriented parsers, exported sources that end in a newline) that
 * silently editing a caller's circuit on the way through is not this layer's
 * business.
 */
export function circuitFields(
  body: Record<string, unknown>
): { ok: true; qasm: string; backend: string } | { ok: false; response: NextResponse } {
  if (typeof body.qasm !== 'string') return { ok: false, response: badRequest('qasm must be a string.') }
  if (body.qasm.trim().length === 0) return { ok: false, response: badRequest('qasm must not be empty.') }
  if (body.qasm.length > MAX_QASM_CHARS) {
    return {
      ok: false,
      response: badRequest(
        `qasm must be at most ${MAX_QASM_CHARS} characters (got ${body.qasm.length}).`
      ),
    }
  }
  const backend = str(body.backend, MAX_BACKEND_CHARS, 'backend')
  if (!backend.ok) return { ok: false, response: badRequest(backend.error) }
  return { ok: true, qasm: body.qasm, backend: backend.value }
}
