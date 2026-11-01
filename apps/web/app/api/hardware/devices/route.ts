/**
 * GET /api/hardware/devices — server-side proxy for the same path on
 * `services/api`.
 *
 * See lib/hardware/proxy.ts for why the browser no longer calls the Python
 * service directly. This route takes no input at all, so there is nothing to
 * validate beyond refusing to be hammered.
 *
 * ── Gate chain: IP rate limit only. Deliberately. ───────────────────────────
 *
 * NO identity, NO entitlement, NO quota, and here is the reasoning so the next
 * reader does not have to re-derive it:
 *
 *  · It spends nothing at a vendor. Listing backends is free on IBM and on
 *    Braket; there is no per-call charge and no shot count.
 *  · It returns no user data. The response is a catalogue of public devices
 *    plus a queue depth — the same information both providers publish.
 *  · The device list is what the hardware page renders BEFORE anyone decides to
 *    upgrade. Requiring a session here would mean a signed-out visitor sees an
 *    empty page instead of "here is what you could run on", and would add a
 *    Supabase round trip to the first paint of the page.
 *
 * What it does cost is a live call from `services/api` to the providers, which
 * is why READ_LIMIT stays. If a provider ever starts metering catalogue reads,
 * this route needs `requireCaller` — it is the only line that would change.
 *
 * ── Signed-in callers: availability reflects THEIR credentials too ──────────
 *
 * The upstream listing is computed from the operator's environment only. On a
 * deployment where the operator configured no vendor credentials, every device
 * would come back `available: false` and a user who stored their own IBM /
 * AWS / Azure credential (docs/BYOK.md) could not select any device in the
 * picker, even though the submit route would run the job on their account. So
 * when the request carries a valid token, the caller's stored providers are
 * looked up (metadata only — nothing is decrypted) and devices of those
 * vendors are marked `available` with `byok: true`.
 *
 * This is strictly additive and fail-open: no token, an invalid token, a
 * credential store that is down or unconfigured all leave the response exactly
 * as the anonymous one, and identity is optional so the signed-out page is
 * unchanged.
 */

import { withByokAvailability } from '@/lib/hardware/byok'
import { forward, limitOrNull, READ_LIMIT } from '@/lib/hardware/proxy'
import { bearerToken, verifiedApiCaller } from '@/lib/security/auth'
import {
  listProviderCredentials,
  type ByokProvider,
} from '@/lib/security/providerCredentials'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const limited = await limitOrNull(req, 'hw-devices', READ_LIMIT)
  if (limited) return limited
  const upstream = await forward('/api/hardware/devices')

  // Anonymous callers (no token at all) skip every extra round trip.
  if (!bearerToken(req)) return upstream

  const own = await ownProviders(req)
  if (own.size === 0) return upstream

  // The listing is a JSON array (forwardedJson only accepts objects), so parse
  // it here. Anything unexpected passes through untouched.
  let devices: unknown
  try {
    devices = upstream.ok ? await upstream.clone().json() : null
  } catch {
    return upstream
  }
  if (!Array.isArray(devices)) return upstream

  return NextResponse.json(withByokAvailability(devices, own), {
    status: upstream.status,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * The vendors the caller holds a READABLE stored credential for. Never throws:
 * any failure is "none", which is the anonymous response.
 */
async function ownProviders(req: Request): Promise<ReadonlySet<ByokProvider>> {
  try {
    const caller = await verifiedApiCaller(req)
    if (!caller) return new Set()
    const records = await listProviderCredentials(caller.id)
    return new Set(records.filter((r) => r.readable).map((r) => r.provider))
  } catch {
    return new Set()
  }
}
