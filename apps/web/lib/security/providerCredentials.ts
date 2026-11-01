/**
 * security/providerCredentials.ts — BYOK: the vendor credential a USER brings.
 *
 * SERVER ONLY. Never import from a client component: it reads the service-role
 * key and it decrypts vendor credentials.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every hardware job used to spend the OPERATOR's IBM/AWS/Azure allowance.
 * That is the one cost on this platform that scales with users, and it is the
 * reason the monthly job quota exists at all. When a researcher supplies their
 * own credential instead:
 *
 *   · their jobs cost this platform nothing;
 *   · the quota stops being a limit worth arguing about for them;
 *   · "free for everyone" becomes structurally true rather than a promotion;
 *   · a lab with its own paid IBM instance, AWS account or Azure workspace can
 *     drive hardware it already pays for through this front end.
 *
 * the internal handoff notes §4 is the specification; docs/BYOK.md is what a user reads.
 *
 * ── ENCRYPTED, NOT HASHED — and why that is not a downgrade ─────────────────
 *
 * `lib/security/apiKeys.ts`, three files over, stores a SHA-256 hash and
 * throws the plaintext away. That is right for a credential somebody presents
 * TO us: we only ever need to recognise it.
 *
 * These are the opposite. We have to present them to the vendor on the user's
 * behalf, so they must be RECOVERABLE and a hash is useless. They are sealed
 * with AES-256-GCM by `lib/platform/secretBox.ts` — the same envelope the
 * platform console already uses for admin-set provider keys, reused
 * deliberately rather than reimplemented, because two encryption paths is one
 * more than anybody will keep correct.
 *
 * What that buys: a database dump, or an over-broad Supabase dashboard login,
 * yields ciphertext. What it does not buy: protection from anything that can
 * run code in this process, which by construction can open the envelope. Say
 * that plainly to users rather than implying a credential here is as safe as a
 * credential nowhere.
 *
 * ── SECRET vs PUBLIC, which is the non-obvious part ─────────────────────────
 *
 * Only IBM has a one-field credential. AWS and Azure credentials are several
 * fields, and only SOME of them are secret:
 *
 *   · An AWS **access key id** is an identifier, like a username. The **secret
 *     access key** is what authorises.
 *   · An Azure **tenant id** and **client id** name an app registration that
 *     the **client secret** authenticates.
 *
 * So each field is declared `secret: true` or not. The secret ones are sealed
 * into one envelope; the rest are stored in the clear and shown back to their
 * owner in full — because "which of my AWS accounts is attached?" is exactly
 * the question a credential listing exists to answer, and sealing the
 * identifiers would make it unanswerable.
 *
 * ── The rules this module enforces, not merely documents ────────────────────
 *
 * 1. A secret NEVER leaves this module in plaintext except through
 *    `resolveProviderCredential`, which exists for exactly one caller shape:
 *    a server route about to make one outbound vendor call. Nothing that
 *    serves a browser may call it. `listProviderCredentials` — the function
 *    the account panel is built from — cannot return a secret; its return type
 *    has no field for one.
 * 2. Nothing sealed goes in unsealed. `saveProviderCredential` seals, and the
 *    column has a `v1.` shape check behind it, so a future edit that forgets
 *    to seal fails loudly instead of quietly writing a credential in the clear.
 * 3. A secret is never logged, never put in an error message, and never
 *    included in a thrown Error's text. Every failure here reports the
 *    OPERATION that failed, never the value it was operating on.
 */

import { getServiceSupabase, isServiceRoleConfigured } from '@/lib/billing/entitlements'
import { isSealed, open, seal, secretBoxAvailable } from '@/lib/platform/secretBox'

/**
 * The providers a user may bring a credential for.
 *
 * All three that `services/api` can submit to. Each one is threaded as an
 * EXPLICIT per-request session down to the vendor SDK — an IBM
 * `QiskitRuntimeService` keyed on the presented token, a Braket `AwsSession`
 * built from an explicit boto3 session, an Azure `ClientSecretCredential` — so
 * none of them depends on process-global configuration that concurrent
 * requests would race over.
 *
 * Adding a fourth means: a dataclass in `services/api/app/quantum/
 * credentials.py`, an explicit session in that provider's module, and an entry
 * in `PROVIDER_FIELDS` below. In that order — the UI must never offer a
 * credential the submit path cannot actually present.
 */
export const BYOK_PROVIDERS = ['ibm', 'braket', 'azure'] as const

export type ByokProvider = (typeof BYOK_PROVIDERS)[number]

/** Human wording for the account panel. Provider ids are not self-explanatory. */
export const PROVIDER_LABELS: Record<ByokProvider, string> = {
  ibm: 'IBM Quantum',
  braket: 'Amazon Braket',
  azure: 'Azure Quantum',
}

/** One field of one provider's credential. */
export interface CredentialField {
  name: string
  label: string
  /** Sealed and never shown again when true; stored in the clear when false. */
  secret: boolean
  required: boolean
  placeholder?: string
  /** One line under the input. Says what it is and where it comes from. */
  help?: string
}

/**
 * What each provider needs, in the order the panel should ask for it.
 *
 * Served to the client by `/api/credentials` rather than duplicated there, so
 * adding a provider lights up the UI without a matching client-side edit — the
 * same reason `/api/keys` serves its scope list. The client cannot import this
 * module (it reads the service-role key), and a second copy would drift.
 */
export const PROVIDER_FIELDS: Record<ByokProvider, CredentialField[]> = {
  ibm: [
    {
      name: 'token',
      label: 'API token',
      secret: true,
      required: true,
      placeholder: 'paste the token from quantum.ibm.com',
      help: 'On the IBM Quantum dashboard, under "API token".',
    },
    {
      name: 'instance',
      label: 'Instance CRN',
      secret: false,
      required: false,
      placeholder: 'crn:v1:bluemix:public:quantum-computing:…',
      help: 'Only if your IBM account has more than one instance. Leave empty otherwise.',
    },
  ],
  braket: [
    {
      name: 'access_key_id',
      label: 'AWS access key ID',
      secret: false,
      required: true,
      placeholder: 'AKIA…',
      // Deliberately called out: people expect both halves to be secret, and a
      // field that is stored in the clear should say so where they can see it.
      help: 'An identifier, like a username — stored in the clear so you can see which account is attached.',
    },
    {
      name: 'secret_access_key',
      label: 'AWS secret access key',
      secret: true,
      required: true,
      help: 'The half that authorises. Encrypted, and never shown again.',
    },
    {
      name: 'session_token',
      label: 'Session token',
      secret: true,
      required: false,
      help: 'Only for temporary (STS) credentials. Safer than a permanent key, because it expires on its own.',
    },
    {
      name: 'region',
      label: 'AWS region',
      secret: false,
      required: true,
      placeholder: 'us-east-1',
      help: 'Braket devices are region-bound. IonQ is us-east-1; Rigetti is us-west-1.',
    },
    {
      name: 's3_bucket',
      label: 'S3 bucket for results',
      secret: false,
      required: true,
      placeholder: 'my-braket-results',
      help: 'Required. Braket writes every result to S3, and with your keys it must be a bucket you own.',
    },
    {
      name: 's3_prefix',
      label: 'S3 key prefix',
      secret: false,
      required: false,
      placeholder: 'quantum-lab',
      help: 'Optional folder inside that bucket.',
    },
  ],
  azure: [
    {
      name: 'resource_id',
      label: 'Workspace resource ID',
      secret: false,
      required: true,
      placeholder: '/subscriptions/…/providers/Microsoft.Quantum/Workspaces/…',
      help: 'Azure portal → your Quantum Workspace → Properties.',
    },
    {
      name: 'location',
      label: 'Workspace region',
      secret: false,
      required: true,
      placeholder: 'eastus',
      help: 'The region the workspace lives in.',
    },
    {
      name: 'tenant_id',
      label: 'Directory (tenant) ID',
      secret: false,
      required: true,
      help: 'From the app registration you created for this.',
    },
    {
      name: 'client_id',
      label: 'Application (client) ID',
      secret: false,
      required: true,
      help: 'Also from the app registration. An identifier, not a secret.',
    },
    {
      name: 'client_secret',
      label: 'Client secret',
      secret: true,
      required: true,
      help: 'The service principal’s secret. Encrypted, and never shown again.',
    },
  ],
}

/**
 * The field each provider's masked hint is taken from.
 *
 * Always a SECRET field. For Braket the access key id would be the obvious
 * choice, but it is already displayed in full from `publicConfig`, so a hint
 * derived from it would be redundant; the hint's job is to distinguish two
 * credentials whose visible parts look alike.
 */
const HINT_FIELD: Record<ByokProvider, string> = {
  ibm: 'token',
  braket: 'secret_access_key',
  azure: 'client_secret',
}

/**
 * One credential as its OWNER sees it.
 *
 * There is no field for a secret and there must never be one. The account
 * panel, the API route behind it and this interface are the three places that
 * would have to change for a secret to reach a browser, and the type is the
 * cheapest of the three to keep honest.
 */
export interface ProviderCredentialRecord {
  provider: ByokProvider
  /** `····8f2c` — the last four characters of the primary secret. */
  hint: string
  /** The non-secret fields, in the clear: identifiers, regions, bucket names. */
  publicConfig: Record<string, string>
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  /**
   * False when the stored ciphertext will not open with the key this
   * deployment currently holds — which in practice means
   * `SETTINGS_ENCRYPTION_KEY` was rotated.
   *
   * Surfaced rather than hidden because the failure is otherwise invisible
   * until a submission mysteriously runs on the operator's credentials
   * instead. The user's fix is to paste the credential again; they can only do
   * that if something tells them to.
   */
  readable: boolean
}

/**
 * A credential opened for exactly one outbound call. Never serialised to a
 * client.
 *
 * `fields` is the secret and public halves merged back into the flat shape the
 * upstream parser expects — see `parse_credentials_header` in
 * `services/api/app/quantum/credentials.py`. It carries LIVE secrets.
 */
export interface ResolvedCredential {
  provider: ByokProvider
  fields: Record<string, string>
}

/** The credential store is not configured, or could not answer. */
export class ProviderCredentialStoreError extends Error {
  constructor(readonly why: string) {
    super('Your saved provider credentials are unavailable right now.')
    this.name = 'ProviderCredentialStoreError'
  }
}

/**
 * Longest single field accepted.
 *
 * An IBM token is ~120 characters and an Azure resource id ~200. This bound
 * exists so a caller cannot make the server encrypt and store a megabyte.
 */
const MAX_FIELD_CHARS = 4096

/** Shortest a SECRET may be before it is obviously a typo or an empty paste. */
const MIN_SECRET_CHARS = 8

const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The SHAPE every non-secret ("public") field must have.
 *
 * Public fields are not just displayed back: services/api feeds `location` and
 * `resource_id` into the Azure SDK, which builds an endpoint URL from them, and
 * hands `region`, `s3_bucket` and the IBM instance to the vendor SDKs. A free
 * account can store any of them (BYOK skips the plan check), so a value like
 * `host.example/x?` in `location` would turn the API service into a request
 * relay to a host of the caller's choosing. Every one is therefore pinned to
 * the vendor's documented format here, and again in
 * `services/api/app/quantum/credentials.py`, which does not trust this layer.
 *
 * Keyed `provider.field`. A public field with no entry is accepted as before
 * (length and whitespace only); adding a provider field means adding its shape.
 */
const PUBLIC_FIELD_SHAPES: Record<string, { pattern: RegExp; expect: string }> = {
  'ibm.instance': {
    pattern: /^[A-Za-z0-9:._/-]{1,512}$/,
    expect: 'a CRN such as crn:v1:bluemix:public:quantum-computing:…',
  },
  'braket.access_key_id': {
    pattern: /^[A-Z0-9]{16,128}$/,
    expect: 'upper-case letters and digits only, such as AKIA…',
  },
  'braket.region': {
    pattern: /^[a-z]{2}(-[a-z]+)+-\d$/,
    expect: 'an AWS region such as us-east-1',
  },
  'braket.s3_bucket': {
    pattern: /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    expect: 'an S3 bucket name: 3–63 lower-case letters, digits, dots or hyphens',
  },
  'braket.s3_prefix': {
    pattern: /^(?!.*\.\.)[A-Za-z0-9._/-]{1,256}$/,
    expect: 'letters, digits, dots, hyphens, underscores or slashes',
  },
  'azure.resource_id': {
    pattern: new RegExp(
      `^/subscriptions/${GUID}/resourceGroups/[A-Za-z0-9._()-]{1,90}/providers/Microsoft\\.Quantum/Workspaces/[A-Za-z0-9_-]{1,64}$`,
      'i'
    ),
    expect:
      'the full id, /subscriptions/<guid>/resourceGroups/<name>/providers/Microsoft.Quantum/Workspaces/<name>',
  },
  'azure.location': {
    pattern: /^[a-z0-9]{3,32}$/,
    expect: 'an Azure region name such as eastus',
  },
  'azure.tenant_id': { pattern: new RegExp(`^${GUID}$`, 'i'), expect: 'a GUID' },
  'azure.client_id': { pattern: new RegExp(`^${GUID}$`, 'i'), expect: 'a GUID' },
}

/** Fields Azure and AWS treat case-insensitively, folded before the shape check. */
const LOWERCASED_FIELDS = new Set(['azure.location', 'braket.region'])

/** True when this deployment can store BYOK credentials at all. */
export function byokConfigured(): boolean {
  return isServiceRoleConfigured && secretBoxAvailable()
}

/**
 * Why BYOK is unavailable, for an operator-facing 503 body.
 *
 * Two independent prerequisites fail in ways that look identical to a user and
 * need completely different fixes, so they are named separately.
 */
export function byokUnavailableReason(): string | null {
  if (!isServiceRoleConfigured) return 'SUPABASE_SERVICE_ROLE_KEY is not configured.'
  if (!secretBoxAvailable()) {
    return 'No SETTINGS_ENCRYPTION_KEY (or SUPABASE_SERVICE_ROLE_KEY) is set, so a credential could not be encrypted at rest.'
  }
  return null
}

/**
 * The service-role client, or a thrown error.
 *
 * Throwing rather than returning null because every caller has to refuse on
 * failure: a credential that cannot be stored must not be reported as stored,
 * and one that cannot be read must not silently fall through to the operator's
 * credentials without the caller knowing that is what happened.
 */
function credentialStore() {
  const reason = byokUnavailableReason()
  if (reason) throw new ProviderCredentialStoreError(reason)
  const supabase = getServiceSupabase()
  if (!supabase) {
    throw new ProviderCredentialStoreError('the Supabase service client could not be built.')
  }
  return supabase
}

/** Is this one of the providers we can actually submit with? */
export function isByokProvider(value: unknown): value is ByokProvider {
  return typeof value === 'string' && (BYOK_PROVIDERS as readonly string[]).includes(value)
}

/**
 * `····8f2c` — what a listing shows instead of a secret.
 *
 * Four characters, from the END. The end rather than the beginning because
 * vendor credentials frequently share a fixed prefix, which would make every
 * hint identical and the feature pointless. Four rather than eight because the
 * hint only has to disambiguate between the one or two credentials a person
 * might plausibly hold, and every additional character is free help to
 * somebody who has obtained the database.
 *
 * @param secret The plaintext secret. Not retained.
 * @returns A masked display string, safe to store and to show.
 */
export function maskToken(secret: string): string {
  return `····${secret.trim().slice(-4)}`
}

/**
 * Validate a whole submitted credential against its provider's field list.
 *
 * Returns the fields split into the two halves they are stored as. Doing the
 * split HERE, once, is what makes it impossible for a caller to seal the wrong
 * set: nothing downstream decides what is secret.
 *
 * @param provider Which vendor this credential is for.
 * @param input The raw field map from the request body.
 * @returns The split fields, or a message naming the first problem.
 */
export function splitCredentialFields(
  provider: ByokProvider,
  input: unknown
): { ok: true; secrets: Record<string, string>; publicConfig: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Expected an object of credential fields.' }
  }
  const raw = input as Record<string, unknown>
  const secrets: Record<string, string> = {}
  const publicConfig: Record<string, string> = {}

  for (const field of PROVIDER_FIELDS[provider]) {
    const value = raw[field.name]
    const text = typeof value === 'string' ? value.trim() : ''

    if (!text) {
      if (field.required) return { ok: false, error: `${field.label} is required.` }
      continue
    }
    if (text.length > MAX_FIELD_CHARS) {
      return { ok: false, error: `${field.label} must be at most ${MAX_FIELD_CHARS} characters.` }
    }
    // Whitespace inside a credential is always a paste accident (a wrapped
    // line, a copied table cell). Refusing is kinder than storing it and
    // letting the vendor answer "invalid credentials" an hour later from
    // inside a queued job.
    if (/\s/.test(text)) {
      return { ok: false, error: `${field.label} contains a space or a line break — check the paste.` }
    }
    if (field.secret && text.length < MIN_SECRET_CHARS) {
      return { ok: false, error: `${field.label} is too short to be valid.` }
    }

    let stored = text
    if (!field.secret) {
      const key = `${provider}.${field.name}`
      if (LOWERCASED_FIELDS.has(key)) stored = stored.toLowerCase()
      const shape = PUBLIC_FIELD_SHAPES[key]
      if (shape && !shape.pattern.test(stored)) {
        // Name the field and the expected shape, never echo the value back.
        return { ok: false, error: `${field.label} is not in the expected format — it should be ${shape.expect}.` }
      }
    }

    if (field.secret) secrets[field.name] = stored
    else publicConfig[field.name] = stored
  }

  if (!secrets[HINT_FIELD[provider]]) {
    // Every provider has exactly one required primary secret; if it is missing
    // the loop above should already have refused. Belt to that braces, because
    // sealing an empty envelope would produce a credential that looks stored
    // and authenticates nothing.
    return { ok: false, error: 'The credential is missing its secret.' }
  }

  return { ok: true, secrets, publicConfig }
}

/**
 * Store (or replace) one user's credential for one provider.
 *
 * An UPSERT on the composite primary key: saving twice replaces, it does not
 * accumulate. There is no version history and there must not be one — a
 * superseded credential is live until the user revokes it at the vendor, and
 * keeping copies of it here would mean revoking in our UI leaves something
 * behind.
 *
 * @param userId The Supabase-verified owner. Never a body field.
 * @param provider Which vendor this credential is for.
 * @param fields The raw field map, straight from the form.
 * @returns The masked record, exactly as a listing would show it.
 * @throws ProviderCredentialStoreError When the store is absent or refuses.
 */
export async function saveProviderCredential(
  userId: string,
  provider: ByokProvider,
  fields: unknown
): Promise<{ ok: true; record: ProviderCredentialRecord } | { ok: false; error: string }> {
  const split = splitCredentialFields(provider, fields)
  if (!split.ok) return split

  const supabase = credentialStore()

  // Seal BEFORE the round trip, so a failure to encrypt never reaches the
  // insert. A JSON object for every provider, including IBM's single field —
  // one shape means one seal path and one open path, with no branch that could
  // get the two confused.
  const sealed = seal(JSON.stringify(split.secrets))
  if (!isSealed(sealed)) {
    throw new ProviderCredentialStoreError('the credential did not seal into the expected envelope.')
  }

  const { data, error } = await supabase
    .from('user_provider_credentials')
    .upsert(
      {
        user_id: userId,
        provider,
        secret: sealed,
        hint: maskToken(split.secrets[HINT_FIELD[provider]]),
        public_config: split.publicConfig,
        // Explicitly cleared on replacement. The old credential's usage
        // history is not this one's, and a stale `last_used_at` would tell the
        // owner a credential they pasted a minute ago has been in use for
        // weeks.
        last_used_at: null,
      },
      { onConflict: 'user_id,provider' }
    )
    .select('provider, hint, public_config, created_at, updated_at, last_used_at, secret')
    .single()

  if (error || !data) {
    // The message, never the credential. It must not reach a log.
    throw new ProviderCredentialStoreError(
      `the credential could not be stored: ${error?.message ?? 'no row returned'}`
    )
  }

  return { ok: true, record: toRecord(data) }
}

/**
 * One user's stored credentials, masked.
 *
 * This is the function the account panel is built from, and it is incapable of
 * returning a secret — see the note on `ProviderCredentialRecord`.
 *
 * @param userId The Supabase-verified owner.
 * @returns The masked records, one per provider.
 * @throws ProviderCredentialStoreError When the store cannot answer.
 */
export async function listProviderCredentials(
  userId: string
): Promise<ProviderCredentialRecord[]> {
  const supabase = credentialStore()
  const { data, error } = await supabase
    .from('user_provider_credentials')
    .select('provider, hint, public_config, created_at, updated_at, last_used_at, secret')
    .eq('user_id', userId)
    .order('provider', { ascending: true })
    .limit(16)

  if (error) {
    throw new ProviderCredentialStoreError(`the credential listing was refused: ${error.message}`)
  }

  return (Array.isArray(data) ? data : [])
    .map(toRecord)
    // A row for a provider this build no longer submits with is hidden rather
    // than shown as broken: it grants nothing, and presenting it invites
    // somebody to believe it is doing something.
    .filter((record) => isByokProvider(record.provider))
}

/**
 * Forget one credential.
 *
 * ── THIS IS NOT REVOCATION AND THE UI MUST NOT CALL IT THAT ─────────────────
 *
 * Deleting the row stops THIS platform from presenting the credential. The
 * credential itself remains valid at the vendor, where it was issued and where
 * anything else holding a copy can still use it. The only real revocation is
 * deleting the token in IBM's console, the key in AWS IAM, or the client
 * secret in the Azure app registration. docs/BYOK.md and the account panel
 * both say so, because a user who believes "Remove" killed the credential will
 * not go and actually kill it.
 *
 * @param userId The Supabase-verified owner.
 * @param provider Which credential to forget.
 * @returns True when a row was removed, false when there was nothing to remove.
 */
export async function deleteProviderCredential(
  userId: string,
  provider: ByokProvider
): Promise<boolean> {
  const supabase = credentialStore()
  const { data, error } = await supabase
    .from('user_provider_credentials')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
    .select('provider')

  if (error) {
    throw new ProviderCredentialStoreError(`the credential could not be removed: ${error.message}`)
  }
  return Array.isArray(data) && data.length > 0
}

/**
 * Open one user's credential for exactly one outbound vendor call.
 *
 * ── CALLERS: SERVER ROUTES ONLY, AND ONLY IMMEDIATELY BEFORE THE CALL ───────
 *
 * The return value carries live vendor secrets. Do not put it in a response
 * body, a log line, an error message, a cache, a React prop or a
 * `console.error` during debugging. There are exactly two call sites —
 * `app/api/hardware/submit/route.ts` and
 * `app/api/hardware/job/[provider]/[...jobId]/route.ts` — and a third should
 * be argued for rather than added.
 *
 * ── Why null and not a throw when there is no row ───────────────────────────
 *
 * "This user has no credential of their own" is the ordinary case, not a
 * fault: the caller falls back to the operator's credentials. A STORE FAILURE
 * is different and does throw, because silently falling back on an outage
 * would spend the operator's allowance for a user who had arranged not to —
 * the expensive direction, and invisible.
 *
 * ── An unopenable envelope reads as "no credential" ─────────────────────────
 *
 * When `open()` returns null (rotated `SETTINGS_ENCRYPTION_KEY`, tampered
 * ciphertext) this returns null and logs. There is no correct alternative: we
 * cannot present a credential we cannot read, and refusing the submission
 * outright would take hardware away from a user whose only mistake was that
 * the operator rotated a key. The account panel shows the same row as "needs
 * re-entering", which is the actionable half.
 *
 * @param userId The Supabase-verified caller.
 * @param provider Which vendor credential is needed.
 * @returns The opened credential, or null to mean "use the operator's".
 * @throws ProviderCredentialStoreError When the store could not answer at all.
 */
export async function resolveProviderCredential(
  userId: string,
  provider: ByokProvider
): Promise<ResolvedCredential | null> {
  if (!byokConfigured()) return null

  const supabase = credentialStore()
  const { data, error } = await supabase
    .from('user_provider_credentials')
    .select('secret, public_config')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()

  if (error) {
    throw new ProviderCredentialStoreError(`the credential lookup failed: ${error.message}`)
  }
  if (!data || typeof data.secret !== 'string') return null

  const plaintext = open(data.secret)
  if (!plaintext) {
    console.error(
      `[providerCredentials] a stored ${provider} credential could not be decrypted. ` +
        'SETTINGS_ENCRYPTION_KEY has probably been rotated; the owner must re-enter it. ' +
        "Falling back to the operator's credentials for this request."
    )
    return null
  }

  const secrets = parseSecrets(plaintext, provider)
  if (!secrets) {
    console.error(
      `[providerCredentials] a stored ${provider} credential decrypted to something that is ` +
        'not a field map. Treating it as absent.'
    )
    return null
  }

  return {
    provider,
    // Merged back into the flat shape `parse_credentials_header` expects
    // upstream. Public config is spread FIRST so a secret can never be
    // shadowed by a same-named public field.
    fields: { ...publicConfigOf(data.public_config), ...secrets },
  }
}

/**
 * Read the sealed plaintext back into a field map.
 *
 * Accepts a bare string as well as a JSON object, and reads the bare form as
 * an IBM token. That is not speculative generality: the first release of this
 * feature sealed IBM's token as a bare string, and a row written by it must
 * keep working rather than silently stop presenting a credential the owner
 * believes is attached.
 *
 * @param plaintext The opened envelope.
 * @param provider Which provider the row is for.
 * @returns The secret field map, or null when it is unusable.
 */
function parseSecrets(plaintext: string, provider: ByokProvider): Record<string, string> | null {
  const trimmed = plaintext.trim()
  if (!trimmed.startsWith('{')) {
    return provider === 'ibm' ? { token: trimmed } : null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/** The stored `public_config` jsonb as a string map, defensively. */
function publicConfigOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry) out[key] = entry
  }
  return out
}

/**
 * Stamp `last_used_at`. Best-effort, and deliberately not awaited by callers
 * in a way that can fail their request.
 *
 * This is bookkeeping for the owner's benefit — "am I still using this?" — and
 * a failed write of it is not a reason to fail a job submission that has
 * already happened.
 *
 * @param userId The Supabase-verified owner.
 * @param provider Which credential was just presented.
 */
export async function touchProviderCredential(
  userId: string,
  provider: ByokProvider
): Promise<void> {
  try {
    const supabase = credentialStore()
    await supabase
      .from('user_provider_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('provider', provider)
  } catch (err) {
    console.error(
      `[providerCredentials] could not stamp last_used_at for ${provider}:`,
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * Database row to the shape the owner sees.
 *
 * `readable` costs one decryption per listed row. That is deliberate: it is
 * the only way to distinguish "stored and usable" from "stored and now
 * garbage", and the alternative — discovering it when a submission quietly
 * runs on the operator's credentials — is exactly the silent failure this
 * field exists to prevent. The plaintext is dropped on the next line.
 */
function toRecord(row: Record<string, unknown>): ProviderCredentialRecord {
  const sealed = typeof row.secret === 'string' ? row.secret : ''
  return {
    provider: String(row.provider ?? '') as ByokProvider,
    hint: typeof row.hint === 'string' ? row.hint : '',
    publicConfig: publicConfigOf(row.public_config),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    lastUsedAt: typeof row.last_used_at === 'string' ? row.last_used_at : null,
    readable: sealed.length > 0 && open(sealed) !== null,
  }
}
