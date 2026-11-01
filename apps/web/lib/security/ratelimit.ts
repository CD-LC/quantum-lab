/**
 * ratelimit.ts — a fixed-window counter held in this process's memory.
 *
 * ############################################################################
 * #  READ THIS BEFORE YOU RELY ON IT.                                        #
 * #                                                                          #
 * #  This limiter is PER INSTANCE. The counters live in the memory of one    #
 * #  Node process and nowhere else. That means:                              #
 * #                                                                          #
 * #    • Behind N instances the effective limit is N x `limit`.              #
 * #    • On a serverless platform (this app's default deployment target is   #
 * #      Vercel) every cold start begins with an empty map, and concurrent   #
 * #      invocations do not share one, so the effective limit approaches     #
 * #      "no limit at all" under exactly the load you would want to limit.   #
 * #    • A deploy resets every counter.                                      #
 * #                                                                          #
 * #  It therefore stops CASUAL ABUSE — a loop in a terminal, a runaway       #
 * #  client, a scraper that does not adapt — and NOTHING MORE. It is not a   #
 * #  control you can point at in a threat model.                             #
 * #                                                                          #
 * #  The real thing needs a SHARED STORE: Upstash/Redis keyed the same way,  #
 * #  or the platform's own edge rate limiting in front of the function.      #
 * #  See docs/SECURITY.md, "Known-weak areas".                               #
 * ############################################################################
 *
 * Fixed window, not sliding: a caller can burst `2 x limit` across a window
 * boundary. That is a known and accepted property — the alternative costs more
 * memory per key for an accuracy this tier does not need.
 *
 * No dependencies, no environment access, no timers: safe in the edge runtime
 * and in a completely empty environment.
 */

import { normaliseAddress } from '../rateLimit'

export interface RateLimitResult {
  /** False when this request should be refused with a 429. */
  allowed: boolean
  /** Requests still permitted in the current window, never below zero. */
  remaining: number
  /** Epoch milliseconds at which the current window ends. */
  resetAt: number
}

interface Bucket {
  /** Window index: floor(now / windowMs). */
  window: number
  count: number
  /** Epoch ms at which this bucket's window ends. */
  expiresAt: number
}

/**
 * Keys are never removed on a schedule — there is no timer here, because a
 * `setInterval` in a serverless function is a leak with no owner. Instead a
 * bucket is replaced lazily when its window has rolled, and when the map
 * reaches `MAX_KEYS` expired buckets are swept and then the OLDEST live ones
 * are evicted. The map is never cleared: clearing hands every caller a fresh
 * allowance, and anyone who can send 10 000 distinct keys could trigger it on
 * demand to reset their own (and everybody else's) counters.
 */
const MAX_KEYS = 10_000
/** Evict down to this many entries so the O(n) pass is amortised. */
const EVICT_TO = Math.floor(MAX_KEYS * 0.9)

const buckets = new Map<string, Bucket>()

function makeRoom(now: number): void {
  for (const [k, b] of buckets) {
    if (b.expiresAt <= now) buckets.delete(k)
  }
  // Still full of live keys: evict the oldest (Map iteration is insertion order).
  for (const k of buckets.keys()) {
    if (buckets.size <= EVICT_TO) break
    buckets.delete(k)
  }
}

/**
 * Count one request against `key` and report whether it is allowed.
 *
 * @param key      Caller identity. See `clientKey` — it is only as good as
 *                 whatever you derived it from.
 * @param limit    Maximum requests permitted per window. Must be >= 1.
 * @param windowMs Window length in milliseconds. Must be >= 1.
 * @param now      Injectable clock, for tests.
 */
export function check(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  // A misconfigured limit must not turn into "everything is allowed" silently,
  // nor into a division by zero. Clamp to something sane and keep counting.
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  const safeWindow = Number.isFinite(windowMs) && windowMs >= 1 ? Math.floor(windowMs) : 1_000

  const window = Math.floor(now / safeWindow)
  const resetAt = (window + 1) * safeWindow

  const existing = buckets.get(key)
  if (!existing || existing.window !== window) {
    if (!existing && buckets.size >= MAX_KEYS) makeRoom(now)
    buckets.set(key, { window, count: 1, expiresAt: resetAt })
    return { allowed: true, remaining: safeLimit - 1, resetAt }
  }

  existing.count += 1
  const remaining = Math.max(0, safeLimit - existing.count)
  return { allowed: existing.count <= safeLimit, remaining, resetAt }
}

/**
 * Derive a limiter key from request headers.
 *
 * Takes the FIRST hop of `x-forwarded-for` (the client as the nearest trusted
 * proxy saw it), then `x-real-ip`, then a constant.
 *
 * ⚠️  A SPOOFABLE HEADER IS A WEAK KEY. Anything a client can set, a client can
 * vary: an attacker who rotates `x-forwarded-for` gets a fresh allowance per
 * request, and the constant fallback lumps every keyless caller into one shared
 * bucket, which is a small self-inflicted denial of service. Both are only
 * acceptable because the tier this limiter belongs to is advisory. Behind a
 * trusted proxy that OVERWRITES the header (Vercel and most CDNs do), the first
 * hop is trustworthy; anywhere else, it is not.
 *
 * @param prefix Namespaces the key so two routes never share a bucket.
 */
export function clientKey(headers: Headers, prefix = 'anon'): string {
  const forwarded = headers.get('x-forwarded-for') ?? ''
  const firstHop = forwarded.split(',')[0]?.trim() ?? ''
  // Cloudflare overwrites cf-connecting-ip; x-forwarded-for it only appends to.
  const ip =
    headers.get('cf-connecting-ip')?.trim() || firstHop || headers.get('x-real-ip')?.trim() || 'unknown'
  // Bound the key: a header is caller-controlled and an unbounded map key is a
  // memory-growth primitive even with MAX_KEYS in place. IPv6 is truncated to
  // its /64 (shared with lib/rateLimit.ts): one customer owns a whole /64, so
  // keying on the full address lets them rotate for a fresh allowance per request.
  return `${prefix}:${normaliseAddress(ip.slice(0, 64))}`
}

/** Standard headers for a 429 so a well-behaved client can back off correctly. */
export function retryHeaders(result: RateLimitResult, now: number = Date.now()): HeadersInit {
  const seconds = Math.max(1, Math.ceil((result.resetAt - now) / 1000))
  return {
    'retry-after': String(seconds),
    'x-ratelimit-remaining': String(result.remaining),
    'x-ratelimit-reset': String(Math.floor(result.resetAt / 1000)),
  }
}

/** Test-only: drop every counter. */
export function resetAll(): void {
  buckets.clear()
}
