/**
 * hardware/byok.ts — deciding WHOSE credential pays for one hardware request.
 *
 * SERVER ONLY. It reaches the credential store, which decrypts vendor secrets.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * Two routes have to reach the same answer about the same job, and they reach
 * it from different information:
 *
 *   · `POST /api/hardware/submit` knows the backend id and an OPTIONAL
 *     provider (the hardware page omits it and lets the upstream derive it).
 *   · `GET  /api/hardware/job/{provider}/{jobId}` knows the provider and
 *     nothing else.
 *
 * If they disagree the failure is quiet. A job is invisible outside the account
 * that created it — on every vendor, not just IBM — so a submit that uses the
 * credential and a poll that does not produces a job that runs fine and then
 * reports "not found" forever. One module, one decision, both callers.
 */

import {
  isByokProvider,
  resolveProviderCredential,
  type ByokProvider,
  type ResolvedCredential,
} from '@/lib/security/providerCredentials'

/**
 * Backend id to provider, mirrored from `BACKEND_PROVIDER` in
 * `services/api/app/quantum/hardware.py`, which is authoritative.
 *
 * The mirror exists because the submit route is allowed to omit `provider` and
 * let the upstream derive it from the backend id — the hardware page's own
 * happy path does exactly that — so this layer has to make the same derivation
 * to know which stored credential is even relevant.
 *
 * DRIFT: a backend added upstream and not added here falls through to the
 * prefix rules below, and only if it is also named unlike every existing one
 * does BYOK silently not apply to it. That failure spends the OPERATOR's
 * allowance rather than the user's — the direction that shows up on an invoice
 * rather than in a surprise — which is why the prefix rules are here as well
 * as the table.
 */
const BACKEND_PROVIDER: Record<string, ByokProvider> = {
  ibm_quantum: 'ibm',
  ibm_brisbane: 'ibm',
  ibm_kyiv: 'ibm',
  ibm_sherbrooke: 'ibm',
  ionq_aria: 'braket',
  ionq_forte: 'braket',
  rigetti_ankaa: 'braket',
  azure_quantinuum_h1: 'azure',
  azure_ionq_aria: 'azure',
}

/**
 * Naming rules for backends the table has not heard of yet.
 *
 * ORDER MATTERS. `azure_ionq_aria` starts with `azure_` and contains `ionq`,
 * and it is an AZURE device — Azure resells IonQ hardware, and the same
 * machine reached through Braket is a different job on a different bill. So
 * the `azure_` rule is tested first, and a rule that merely matched `ionq`
 * anywhere would route it to the wrong vendor entirely.
 */
const PREFIX_RULES: ReadonlyArray<readonly [RegExp, ByokProvider]> = [
  [/^azure[_-]/i, 'azure'],
  [/^ibm[_-]/i, 'ibm'],
  [/^(ionq|rigetti|oqc|iqm)[_-]/i, 'braket'],
]

/**
 * Which BYOK provider, if any, applies to this request.
 *
 * @param provider The explicit provider, when the caller supplied one.
 * @param backend The backend id, used only when `provider` is absent.
 * @returns The provider a stored credential would be looked up for, or null
 *          when the backend cannot be attributed to one.
 */
export function byokProviderFor(
  provider: string | null | undefined,
  backend: string | null | undefined
): ByokProvider | null {
  // An explicit provider WINS and is never second-guessed from the backend id.
  // The caller naming `braket` for an oddly-named device is a caller who knows
  // something this mirror does not.
  if (provider) return isByokProvider(provider) ? provider : null

  const id = (backend ?? '').trim()
  if (!id) return null

  const known = BACKEND_PROVIDER[id]
  if (known) return known

  for (const [pattern, target] of PREFIX_RULES) {
    if (pattern.test(id)) return target
  }
  return null
}

/**
 * The caller's own credential for this request, or null to use the operator's.
 *
 * Null means exactly one thing to every caller: proceed as this platform
 * always has — the operator's credentials, the plan's monthly allowance, any
 * spend budget. It is the ordinary case, not a fault.
 *
 * A STORE FAILURE is not swallowed here; it propagates as
 * `ProviderCredentialStoreError`. The submit route turns that into a refusal
 * rather than a fallback, and the reason is worth stating: falling back on an
 * outage would spend the operator's allowance on behalf of a user who had
 * arranged not to, silently, with no trace except a bill. See the handler.
 *
 * @param userId The Supabase-verified caller. Never a body field.
 * @param provider The explicit provider, when known.
 * @param backend The backend id, when known.
 * @returns An opened credential — which carries LIVE vendor secrets — or null.
 */
export async function resolveSubmissionCredential(
  userId: string,
  provider: string | null | undefined,
  backend: string | null | undefined
): Promise<ResolvedCredential | null> {
  const target = byokProviderFor(provider, backend)
  if (!target) return null
  return resolveProviderCredential(userId, target)
}

/**
 * Make a device listing BYOK-aware for one caller.
 *
 * The upstream listing is computed from the OPERATOR's environment, so on a
 * deployment with no provider credentials every device comes back
 * `available: false` — while the submit route would happily run a job on the
 * caller's own stored credential. A device the operator cannot reach but whose
 * vendor the caller has a readable credential for is therefore marked
 * available, with `byok: true` so the UI can say whose account it will use.
 *
 * Devices that are already available are left exactly as they were: the
 * operator's credential works and nothing about the caller changes that.
 *
 * @param devices The parsed upstream listing.
 * @param ownProviders Providers the caller holds a readable credential for.
 * @returns A new listing; the input is not mutated.
 */
export function withByokAvailability(
  devices: unknown[],
  ownProviders: ReadonlySet<ByokProvider>
): unknown[] {
  if (ownProviders.size === 0) return devices
  return devices.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const device = entry as Record<string, unknown>
    if (device.available !== false || typeof device.id !== 'string') return entry
    // Deliberately NOT passing `device.provider`: for Braket hardware it is the
    // hardware vendor ('ionq', 'rigetti'), not the credential family.
    const target = byokProviderFor(null, device.id)
    if (!target || !ownProviders.has(target)) return entry
    return { ...device, available: true, reason: null, byok: true }
  })
}
