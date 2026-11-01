/**
 * /api/credentials — BYOK: store, review and remove your OWN vendor credentials.
 *
 * ── AN API KEY CANNOT REACH THIS ROUTE ──────────────────────────────────────
 *
 * Identity comes from `verifiedCallerId`, which accepts a Supabase SESSION
 * token and nothing else — not `verifiedApiCaller`, which also accepts a
 * `qb16_sk_…` key. This is the same rule `/api/keys` follows and it matters
 * more here, not less.
 *
 * A `hardware:submit` key is a credential somebody puts in a CI environment
 * variable. If it could install a BYOK credential, a leaked key would let an
 * attacker attach THEIR vendor account to the victim's (making every job the
 * victim runs land in the attacker's console, results included), or replace
 * the victim's credential so their jobs silently start spending the operator's
 * allowance again. Neither is something a scoped script credential should be
 * able to do. Attaching a vendor account is an account action and requires the
 * account.
 *
 * Do not "simplify" this by switching to `verifiedApiCaller`.
 *
 * ── Secrets are write-only ──────────────────────────────────────────────────
 *
 * POST accepts a credential and answers with the MASKED record. There is no
 * route, here or anywhere, that reads a stored secret back out to a client —
 * the listing type has no field for one
 * (`lib/security/providerCredentials.ts`). Same rule as an API key, for the
 * same reason: a credential that can be re-read is a credential that leaks
 * through whatever can read it.
 *
 * The NON-secret half does come back in full, on purpose: an AWS access key id
 * and an Azure client id are identifiers, and "which of my accounts is
 * attached?" is the question a credential listing exists to answer.
 *
 * ── This route is provider-agnostic, deliberately ───────────────────────────
 *
 * It never names a vendor's fields. Which fields exist, which are secret and
 * which are required all live in `PROVIDER_FIELDS`, and both the validation
 * and this route's own catalogue response read from there. Adding a provider
 * is an entry in that table plus the upstream plumbing — not an edit here.
 *
 * ── Why DELETE is not called "revoke" anywhere in this file ─────────────────
 *
 * Removing the row stops THIS platform from presenting the credential. It
 * stays valid at the vendor. The only real revocation is deleting the token in
 * IBM's console, the key in AWS IAM, or the client secret in the Azure app
 * registration — and the copy in the response body says so, because a user who
 * believes this button killed their credential will not go and actually kill
 * it.
 */

import { NextResponse } from 'next/server'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { signInRequiredResponse, verifiedCallerId } from '@/lib/security/auth'
import { isRecord, readJsonBody } from '@/lib/security/validate'
import {
  BYOK_PROVIDERS,
  PROVIDER_FIELDS,
  PROVIDER_LABELS,
  ProviderCredentialStoreError,
  byokConfigured,
  byokUnavailableReason,
  deleteProviderCredential,
  isByokProvider,
  listProviderCredentials,
  saveProviderCredential,
} from '@/lib/security/providerCredentials'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Tight, and shared by all three methods.
 *
 * Saving a credential is a once-in-a-while action, and a loop hitting this
 * route is a loop making the server perform AES operations and Supabase writes
 * on somebody's behalf. Listing shares the bucket; a page lists once per visit.
 */
const CREDENTIALS_LIMIT = { limit: 20, windowMs: 60_000 }

/**
 * 8 KiB bounds the buffer and is generous for every provider's field set —
 * Azure's is the largest at four ids plus a secret, and a resource id is
 * around 200 characters.
 */
const MAX_BODY_BYTES = 8192

/**
 * The 503 for a deployment that cannot store credentials.
 *
 * The reason is LOGGED, not published: it names environment variables. What
 * the user sees is that the feature is off here, which is all they can act on.
 */
function storeUnavailable(err: ProviderCredentialStoreError): NextResponse {
  console.error(`[api/credentials] ${err.why}`)
  return NextResponse.json(
    {
      error: 'Saved provider credentials are unavailable on this deployment.',
      detail:
        'This deployment is not configured to store vendor credentials, so nothing was ' +
        'saved. Hardware still works on the platform’s own credentials, within your plan’s ' +
        'monthly allowance.',
    },
    { status: 503 }
  )
}

/** Apply the shared bucket, or null to continue. */
async function limited(req: Request, caller: string): Promise<NextResponse | null> {
  const decision = await rateLimit(callerKey(req.headers, 'byok', caller), CREDENTIALS_LIMIT)
  if (decision.allowed) return null
  return NextResponse.json(
    { error: 'Too many requests.' },
    { status: 429, headers: retryAfterHeaders(decision) }
  )
}

export async function GET(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const capped = await limited(req, caller)
  if (capped) return capped

  // An unconfigured deployment answers 200 with an empty list and
  // `configured: false`, NOT an error. The panel then renders an honest
  // "not available here" instead of a red failure state, and a user who is
  // simply not using BYOK sees nothing alarming.
  if (!byokConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        reason:
          'This deployment cannot store vendor credentials. Hardware runs on the platform’s ' +
          'own credentials, within your plan’s monthly allowance.',
        credentials: [],
        providers: providerCatalogue(),
      },
      { headers: { 'cache-control': 'no-store' } }
    )
  }

  try {
    const credentials = await listProviderCredentials(caller)
    return NextResponse.json(
      { configured: true, credentials, providers: providerCatalogue() },
      // A masked hint is not a secret, but this is still account data and
      // there is no version of it worth caching anywhere.
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (err) {
    if (err instanceof ProviderCredentialStoreError) return storeUnavailable(err)
    throw err
  }
}

export async function POST(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const capped = await limited(req, caller)
  if (capped) return capped

  if (!byokConfigured()) {
    return storeUnavailable(
      new ProviderCredentialStoreError(byokUnavailableReason() ?? 'BYOK is not configured.')
    )
  }

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return NextResponse.json({ error: parsed.error }, { status: 413 })
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (!isRecord(parsed.value)) {
    return NextResponse.json({ error: 'Expected a JSON object body.' }, { status: 400 })
  }
  const body = parsed.value

  if (!isByokProvider(body.provider)) {
    return NextResponse.json(
      {
        error: 'Unknown provider.',
        detail: `Credentials can currently be supplied for: ${BYOK_PROVIDERS.join(', ')}.`,
      },
      { status: 400 }
    )
  }

  try {
    // `fields` is a per-provider map — the route does not know or care which
    // keys a provider needs, and deliberately does not: the field list and the
    // secret/public split live in ONE place (`PROVIDER_FIELDS`), so a route
    // that enumerated them would be a second copy to drift.
    const outcome = await saveProviderCredential(caller, body.provider, body.fields)
    if (!outcome.ok) {
      // A shape complaint about one field. The message describes the PROBLEM
      // ("required", "too short", "contains a space") and never echoes the
      // value, because an error body is one of the places a credential ends up
      // in a log.
      return NextResponse.json({ error: outcome.error }, { status: 400 })
    }
    return NextResponse.json(
      {
        credential: outcome.record,
        // Repeated on every save rather than shown once at first use: this is
        // the sentence that decides whether somebody understands what they
        // just handed over, and it costs nothing to say again.
        notice:
          'Stored encrypted. Jobs you submit will now run on your own ' +
          `${PROVIDER_LABELS[body.provider]} account and appear in your own console — they no ` +
          'longer count against this platform’s monthly allowance. Removing it here stops us ' +
          'using it; to truly revoke it, delete the credential at the vendor.',
      },
      { status: 201, headers: { 'cache-control': 'no-store' } }
    )
  } catch (err) {
    if (err instanceof ProviderCredentialStoreError) return storeUnavailable(err)
    throw err
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const capped = await limited(req, caller)
  if (capped) return capped

  if (!byokConfigured()) {
    return storeUnavailable(
      new ProviderCredentialStoreError(byokUnavailableReason() ?? 'BYOK is not configured.')
    )
  }

  const provider = new URL(req.url).searchParams.get('provider')
  if (!isByokProvider(provider)) {
    return NextResponse.json(
      {
        error: 'Unknown provider.',
        detail: `Expected one of: ${BYOK_PROVIDERS.join(', ')}.`,
      },
      { status: 400 }
    )
  }

  try {
    const removed = await deleteProviderCredential(caller, provider)
    // 200 either way, and `removed` says which happened. A 404 for "there was
    // nothing there" would make a double-click look like a failure, and the
    // end state the caller wanted — no credential stored — is true in both
    // cases.
    return NextResponse.json(
      {
        removed,
        notice:
          'Removed from this platform. Your jobs will go back to the platform’s own ' +
          'credentials and your monthly allowance. THIS DID NOT REVOKE THE CREDENTIAL — it ' +
          'is still valid at the vendor. Delete it there if you want it dead.',
      },
      { headers: { 'cache-control': 'no-store' } }
    )
  } catch (err) {
    if (err instanceof ProviderCredentialStoreError) return storeUnavailable(err)
    throw err
  }
}

/**
 * What the panel needs to render a provider it has never heard of.
 *
 * Served from the server rather than hardcoded in the component for the same
 * reason `/api/keys` serves its scope list: adding a provider should light up
 * the UI without a matching client-side edit, and a build where the two
 * disagree should favour the one that knows what the submit path can use.
 */
function providerCatalogue() {
  return BYOK_PROVIDERS.map((provider) => ({
    id: provider,
    label: PROVIDER_LABELS[provider],
    // The field list travels with the provider so the panel can render a
    // vendor it has never heard of: name, label, whether it is secret (which
    // decides `type=password` and the "never shown again" wording), whether it
    // is required, and the one line of help under the input.
    fields: PROVIDER_FIELDS[provider],
  }))
}
