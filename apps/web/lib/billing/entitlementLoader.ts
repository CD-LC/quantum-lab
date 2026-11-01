/**
 * entitlementLoader.ts — one entitlement fetch per page, not one per component.
 *
 * Browser-safe (no server imports). Used by components/billing/useEntitlement.
 *
 * Every component that calls `useEntitlement()` used to fetch on its own, so a
 * page with a simulator, a save panel and several upgrade gates made a dozen
 * identical requests, against a route limited to 60/min per IP. Behind a
 * classroom or campus NAT that limit is reached by one lesson start, the 429s
 * were rendered as the Free plan, and paying students saw padlocks for features
 * they had paid for. Two fixes live here:
 *
 *  · requests are shared: concurrent callers join one in-flight promise, and a
 *    successful answer is reused for a short TTL;
 *  · a transient failure (429, 5xx, network error) is reported as `transient`,
 *    not as "Free", and carries the last good body so the caller can keep what
 *    it was showing.
 */

export type EntitlementLoad =
  /** The route answered; `body` is its parsed JSON. */
  | { kind: 'ok'; body: unknown }
  /** 429 / 5xx / network failure. Keep the previous value; retry later. */
  | { kind: 'transient'; lastGood?: unknown; retryAfterMs: number }
  /** A definitive non-success (404 and friends): Free is the right answer. */
  | { kind: 'none' }

export type EntitlementFetcher = () => Promise<Response>

/** A good answer is reused this long. Short: a plan change should show soon. */
export const ENTITLEMENT_TTL_MS = 15_000

const DEFAULT_RETRY_MS = 5_000
const MAX_RETRY_MS = 30_000

interface Cached {
  at: number
  body: unknown
}

const cache = new Map<string, Cached>()
const lastGood = new Map<string, unknown>()
const inflight = new Map<string, Promise<EntitlementLoad>>()

/** Test seam: the maps are module-global. */
export function __resetEntitlementLoader(): void {
  cache.clear()
  lastGood.clear()
  inflight.clear()
}

function retryAfterMs(response: Response | null): number {
  const raw = response?.headers?.get('retry-after')
  const seconds = raw ? Number(raw) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_MS
  return Math.min(MAX_RETRY_MS, Math.max(1_000, seconds * 1_000))
}

async function fetchOnce(key: string, fetcher: EntitlementFetcher, now: number): Promise<EntitlementLoad> {
  let response: Response
  try {
    response = await fetcher()
  } catch {
    return { kind: 'transient', lastGood: lastGood.get(key), retryAfterMs: DEFAULT_RETRY_MS }
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'transient', lastGood: lastGood.get(key), retryAfterMs: retryAfterMs(response) }
  }
  if (!response.ok) return { kind: 'none' }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A 200 with an unreadable body is a broken answer, not a plan change.
    return { kind: 'transient', lastGood: lastGood.get(key), retryAfterMs: DEFAULT_RETRY_MS }
  }
  cache.set(key, { at: now, body })
  lastGood.set(key, body)
  return { kind: 'ok', body }
}

/**
 * Load (or join, or reuse) the entitlement for `key` (the user id).
 *
 * `force` skips the TTL and starts a fresh request, for an explicit refresh
 * such as the one after checkout; ordinary mounts never force.
 */
export function loadEntitlement(
  key: string,
  fetcher: EntitlementFetcher,
  opts: { force?: boolean; now?: number } = {}
): Promise<EntitlementLoad> {
  const now = opts.now ?? Date.now()
  if (!opts.force) {
    const hit = cache.get(key)
    if (hit && now - hit.at < ENTITLEMENT_TTL_MS) {
      return Promise.resolve({ kind: 'ok', body: hit.body })
    }
    const pending = inflight.get(key)
    if (pending) return pending
  }
  const promise = fetchOnce(key, fetcher, now).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}
