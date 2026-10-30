/**
 * rateLimit.ts — a fixed-window limiter that counts in a SHARED store.
 *
 * This exists because `lib/security/ratelimit.ts` counts in one Node process's
 * memory, and the routes it guards (`/api/agent`, `/api/email`, the Stripe
 * checkout and portal routes) all spend money per accepted request. On Vercel
 * every cold start begins with an empty map and concurrent invocations do not
 * share one, so a per-instance counter approaches "no limit at all" under
 * exactly the load you would want to limit. That is not a control; this is an
 * attempt at one.
 *
 * ── Which store you get ─────────────────────────────────────────────────────
 *
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   → Redis, shared
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          → Redis, shared
 *   neither                                             → in-process, NOT shared
 *
 * The two variable pairs are the same thing: Vercel KV is Upstash underneath
 * and speaks the identical REST dialect, so one code path serves both. The
 * REST protocol is plain `fetch` — no dependency is added to package.json,
 * which matters because this module is imported by route handlers that must
 * keep building in an empty environment.
 *
 * Supabase is the other shared store this project already has, and it is NOT
 * used here on purpose: an atomic counter needs a table plus a `security
 * definer` increment function, and `supabase/schema*.sql` has never been run
 * against a live project (see docs/SECURITY.md, "Could not be verified"). A
 * limiter that depends on unverified SQL is a limiter you cannot trust. If you
 * add that migration, add a Supabase backend here behind the same interface.
 *
 * ── What this bounds, and what it does not ──────────────────────────────────
 *
 * The key is the caller's IP (see `callerKey`), so this bounds ONE MACHINE.
 * IP rotation is cheap — a residential proxy pool costs a few dollars an hour
 * and any cloud provider will hand out fresh addresses for free — so a
 * determined attacker multiplies the limit by however many addresses they care
 * to buy. IPv6 is normalised to a /64 because a single ISP customer is
 * routinely handed the whole /64 and rotating inside it costs nothing at all;
 * that closes the cheapest rotation and none of the others.
 *
 * So: this stops a script, a runaway client and a bored visitor. It does not
 * stop a distributed attacker, and it must not be described as if it does. The
 * only thing that actually bounds cost per PERSON is authentication plus a
 * per-account quota, and the tutor is deliberately anonymous — that is a
 * product decision, and until it changes this is the ceiling.
 */

export type RateLimitStore = 'redis' | 'memory'

export interface RateLimitDecision {
  /** False when the caller has exhausted the window and must get a 429. */
  allowed: boolean
  /** Requests still permitted in this window, never below zero. */
  remaining: number
  /** Epoch milliseconds at which the window ends. */
  resetAt: number
  /**
   * Which store actually answered THIS call. `'memory'` when no Redis is
   * configured, and also when Redis was configured but did not answer — in
   * which case the count is per-instance for the duration of the outage.
   */
  store: RateLimitStore
}

export interface RateLimitRule {
  /** Maximum requests per window. Must be >= 1. */
  limit: number
  /** Window length in milliseconds. Must be >= 1000. */
  windowMs: number
}

/** How long we wait for the store before giving up on it for this request. */
const STORE_TIMEOUT_MS = 1_500

/**
 * Fixed window, not sliding. A caller can burst 2 × limit across a window
 * boundary. Accepted: a sliding window needs a sorted set per key and a
 * read-modify-write per request, and the accuracy buys nothing at this tier.
 */
function windowIndex(now: number, windowMs: number): number {
  return Math.floor(now / windowMs)
}

/**
 * The store key for one (caller, rule, window) triple.
 *
 * `windowMs` is part of the key, and must stay part of it. A route may apply
 * two rules to the SAME caller key — /api/agent counts 12/minute and
 * 100/hour — and without the window length in the key those two counters share
 * a bucket and reset each other on every request, which silently disables both.
 * That is not hypothetical: it is what this code did before the tests in
 * lib/rateLimitRoutes.test.ts caught it.
 */
function storeKey(key: string, rule: RateLimitRule, now: number): string {
  return `${key}:${rule.windowMs}:${windowIndex(now, rule.windowMs)}`
}

// ── store selection ─────────────────────────────────────────────────────────

interface RedisConfig {
  url: string
  token: string
  /** Which variable pair we read, so the warning can name it. */
  source: string
}

let configCache: { redis: RedisConfig | null } | null = null

function redisConfig(): RedisConfig | null {
  if (configCache) return configCache.redis

  const pairs: Array<[string, string, string]> = [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'Upstash'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'Vercel KV'],
  ]

  let found: RedisConfig | null = null
  for (const [urlVar, tokenVar, source] of pairs) {
    const url = (process.env[urlVar] ?? '').trim().replace(/\/+$/, '')
    const token = (process.env[tokenVar] ?? '').trim()
    if (url && token) {
      found = { url, token, source }
      break
    }
  }

  configCache = { redis: found }
  return found
}

/** True when a shared store is configured. Cheap; safe to call per request. */
export function rateLimitStore(): RateLimitStore {
  return redisConfig() ? 'redis' : 'memory'
}

let warned = false
let degradedWarned = false

/**
 * Say plainly, once per process, that the limiter is not shared.
 *
 * Deliberately `console.warn` and not a thrown error: an empty environment is
 * the supported local-development state for this whole repository, and a
 * limiter that refuses to boot without Redis would make `npm run dev` require
 * an account somewhere. The wording names both failure modes because "in
 * memory" on its own reads as a performance note rather than a security gap.
 */
function warnMemoryStore(): void {
  if (warned) return
  warned = true
  console.warn(
    '[rateLimit] No UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN is set, ' +
      'so rate limiting is counting in this process\'s memory. That store DOES NOT ' +
      'SURVIVE A DEPLOY and DOES NOT SPAN INSTANCES: behind N instances the effective ' +
      'limit is N x the limit, and on a serverless platform each cold start begins ' +
      'with an empty counter. Fine for local development. Not a control you may rely ' +
      'on in production — see docs/SECURITY.md.'
  )
}

// ── in-process fallback ─────────────────────────────────────────────────────

interface Bucket {
  /** Window index; the map key carries it too, this catches a stale entry. */
  window: number
  count: number
  /** Epoch ms at which this bucket's window ends; after that it is garbage. */
  expiresAt: number
  /** Window length, so eviction can tell a per-minute key from a daily quota. */
  windowMs: number
}

/**
 * Keys are never swept on a timer — a `setInterval` in a serverless function is
 * a leak with no owner. A bucket is replaced lazily when its window rolls, and
 * when the map reaches MAX_KEYS `makeRoom` evicts entries: expired windows
 * first, then the OLDEST short-window keys, and only as a last resort the
 * oldest long-window keys. It never clears the map.
 *
 * Clearing everything (what this did before) is not "some callers briefly get a
 * fresh allowance": the same map holds the 24-hour LLM cost quotas, so a flush
 * handed every caller a brand-new daily allowance, and 10 000 cheap one-minute
 * keys are reached within hours on ordinary traffic. Per-minute keys are
 * disposable (they expire in a minute); daily quota keys are what must survive.
 */
const MAX_KEYS = 10_000
/** Evict down to this many entries so the O(n) pass is amortised, not per request. */
const EVICT_TO = Math.floor(MAX_KEYS * 0.9)
/** A window at least this long is a cost quota (daily/hourly), kept longest. */
const LONG_WINDOW_MS = 3_600_000
const buckets = new Map<string, Bucket>()

function makeRoom(now: number): void {
  // 1. Expired windows are free to drop; they can never be read again.
  for (const [k, b] of buckets) {
    if (b.expiresAt <= now) buckets.delete(k)
  }
  if (buckets.size < MAX_KEYS) return

  // 2. Still full of live keys: drop the oldest short-window ones first
  //    (Map iteration order is insertion order).
  for (const [k, b] of buckets) {
    if (buckets.size <= EVICT_TO) break
    if (b.windowMs < LONG_WINDOW_MS) buckets.delete(k)
  }
  if (buckets.size < MAX_KEYS) return

  // 3. Nothing but long windows left: drop the oldest of those.
  for (const k of buckets.keys()) {
    if (buckets.size <= EVICT_TO) break
    buckets.delete(k)
  }
}

function countInMemory(key: string, rule: RateLimitRule, now: number): RateLimitDecision {
  const window = windowIndex(now, rule.windowMs)
  const resetAt = (window + 1) * rule.windowMs
  const mapKey = storeKey(key, rule, now)
  const existing = buckets.get(mapKey)

  if (!existing || existing.window !== window) {
    if (!existing && buckets.size >= MAX_KEYS) makeRoom(now)
    buckets.set(mapKey, { window, count: 1, expiresAt: resetAt, windowMs: rule.windowMs })
    return { allowed: true, remaining: rule.limit - 1, resetAt, store: 'memory' }
  }

  existing.count += 1
  return {
    allowed: existing.count <= rule.limit,
    remaining: Math.max(0, rule.limit - existing.count),
    resetAt,
    store: 'memory',
  }
}

// ── Redis (Upstash REST) ────────────────────────────────────────────────────

/**
 * INCR the window key and give it a TTL, in one round trip.
 *
 * The key embeds the window index, so a key is meaningless the moment its
 * window rolls and re-arming the TTL on every increment cannot extend the
 * window a caller is being measured in. That is why this uses a plain EXPIRE
 * rather than `EXPIRE ... NX`, which needs Redis 7 and buys nothing here.
 *
 * Returns null on ANY failure — network, timeout, non-2xx, unparseable body,
 * or a Redis-level error inside the pipeline response. The caller decides what
 * a missing answer means; see `rateLimit`.
 */
async function countInRedis(
  config: RedisConfig,
  key: string,
  rule: RateLimitRule,
  now: number
): Promise<RateLimitDecision | null> {
  const window = windowIndex(now, rule.windowMs)
  const resetAt = (window + 1) * rule.windowMs
  const redisKey = `rl:${storeKey(key, rule, now)}`
  // One extra second so a key cannot expire a hair before the window it counts.
  const ttlSeconds = Math.ceil(rule.windowMs / 1000) + 1

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STORE_TIMEOUT_MS)

  try {
    const response = await fetch(`${config.url}/pipeline`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', redisKey],
        ['EXPIRE', redisKey, String(ttlSeconds)],
      ]),
    })

    if (!response.ok) return null

    const payload: unknown = await response.json()
    if (!Array.isArray(payload) || payload.length === 0) return null

    const first: unknown = payload[0]
    if (!first || typeof first !== 'object') return null
    // Upstash reports command-level failures as { error } inside a 200 body.
    if (typeof (first as { error?: unknown }).error === 'string') return null

    const count = (first as { result?: unknown }).result
    if (typeof count !== 'number' || !Number.isFinite(count)) return null

    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      resetAt,
      store: 'redis',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Count one request against `key` and report whether it is allowed.
 *
 * FAIL-OPEN-ISH, deliberately: when Redis is configured but does not answer,
 * this falls back to the in-process counter rather than refusing the request.
 * Refusing would turn a Redis outage into a total outage of the tutor, the
 * pricing page and transactional mail; falling back leaves a per-instance
 * limiter, which is worse than shared but far better than nothing. The
 * decision's `store` field says which one answered, so a caller that wants to
 * be stricter under degradation can see it.
 *
 * @param key  Caller identity — build it with `callerKey`.
 * @param rule Limit and window. Both are clamped rather than trusted.
 * @param now  Injectable clock, for tests.
 */
export async function rateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now()
): Promise<RateLimitDecision> {
  // A misconfigured rule must not silently become "everything is allowed", nor
  // divide by zero.
  const safe: RateLimitRule = {
    limit: Number.isFinite(rule.limit) && rule.limit >= 1 ? Math.floor(rule.limit) : 1,
    windowMs:
      Number.isFinite(rule.windowMs) && rule.windowMs >= 1_000
        ? Math.floor(rule.windowMs)
        : 60_000,
  }

  const config = redisConfig()
  if (!config) {
    warnMemoryStore()
    return countInMemory(key, safe, now)
  }

  const shared = await countInRedis(config, key, safe, now)
  if (shared) return shared

  // Store unreachable. Say so once per process — a silent downgrade from
  // "shared" to "per-instance" is exactly the kind of thing that is discovered
  // from a bill rather than from a log. Once, not per request, because the
  // failure mode that gets here is usually every request.
  if (!degradedWarned) {
    degradedWarned = true
    console.warn(
      `[rateLimit] ${config.source} did not answer within ${STORE_TIMEOUT_MS}ms. ` +
        'Falling back to a per-instance counter, which does not span instances. ' +
        'Rate limiting is degraded until the store answers again.'
    )
  }
  return countInMemory(key, safe, now)
}

/**
 * Normalise the caller's address into a limiter key.
 *
 * `x-forwarded-for`'s FIRST hop is the client as the nearest proxy saw it. That
 * header is caller-controlled unless a trusted proxy OVERWRITES it (Vercel and
 * most CDNs do; a bare `next start` behind nothing does not). Where it is not
 * overwritten, an attacker sets it to a new value per request and this limiter
 * measures nothing — that is a property of the deployment, not something this
 * function can fix, and it is why §4 of docs/SECURITY.md asks for platform edge
 * limiting as well.
 *
 * IPv6 is truncated to its /64. One residential customer is normally delegated
 * a whole /64, so counting full addresses lets that customer rotate for free.
 *
 * @param headers Request headers.
 * @param prefix  Namespaces the key so two routes never share a bucket.
 * @param subject Optional verified identity (a Supabase user id). When present
 *                it replaces the IP: it is not rotatable without creating
 *                another account, which is a much higher bar. Pass it ONLY
 *                after verifying a token — a body-supplied id would let a
 *                caller pick someone else's bucket.
 */
export function callerKey(headers: Headers, prefix: string, subject?: string | null): string {
  if (subject && subject.trim()) return `${prefix}:u:${subject.trim().slice(0, 64)}`

  // `cf-connecting-ip` is written by Cloudflare's edge, which overwrites any
  // value the client sent, so it is not rotatable. `x-forwarded-for` is only
  // APPENDED to by Cloudflare, so its first hop is whatever the client claimed.
  const forwarded = headers.get('x-forwarded-for') ?? ''
  const firstHop = forwarded.split(',')[0]?.trim() ?? ''
  const raw =
    headers.get('cf-connecting-ip')?.trim() || firstHop || headers.get('x-real-ip')?.trim() || ''

  // Bound it before anything else: a header is caller-controlled and an
  // unbounded key is a memory-growth primitive in the fallback map and an
  // unbounded write in Redis.
  const address = raw.slice(0, 64)
  if (!address) {
    // No address at all lumps every such caller into one bucket. That is a
    // small self-inflicted denial of service and it is the safe direction:
    // the alternative is an unlimited bucket per unidentifiable caller.
    return `${prefix}:ip:unknown`
  }

  return `${prefix}:ip:${normaliseAddress(address)}`
}

/** IPv6 → its /64 prefix; anything else (IPv4, junk) unchanged. */
export function normaliseAddress(address: string): string {
  // Strip a bracketed/ported form like [2001:db8::1]:443 before anything else.
  const bare = address.startsWith('[') ? address.slice(1).split(']')[0] ?? address : address
  if (!bare.includes(':')) return bare

  const expanded = expandIpv6(bare)
  if (!expanded) return bare
  return `${expanded.slice(0, 4).join(':')}::/64`
}

/**
 * Expand an IPv6 literal to its eight groups, each zero-padded to four hex
 * digits and lowercased, or null when it is not one.
 *
 * The padding is not cosmetic: `2001:db8::` and `2001:0db8::` are the same
 * address, but without it their first four groups render as `2001:db8:0:0`
 * and `2001:0db8:0:0` — different strings, so the two spellings landed in
 * different rate-limit buckets instead of sharing one.
 */
function expandIpv6(value: string): string[] | null {
  const halves = value.split('::')
  if (halves.length > 2) return null

  const toGroups = (part: string): string[] => (part ? part.split(':') : [])
  const head = toGroups(halves[0] ?? '')
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : []

  const pad = (groups: string[]): string[] => groups.map((g) => g.toLowerCase().padStart(4, '0'))

  if (halves.length === 1) {
    return head.length === 8 ? pad(head) : null
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  return pad([...head, ...Array<string>(missing).fill('0'), ...tail])
}

/**
 * Headers for a 429 so a well-behaved client backs off correctly.
 *
 * Nothing here identifies the caller or reveals whether a key exists in the
 * store: the values are derived from the window boundary, which is the same
 * for everyone, and from the caller's own exhausted allowance.
 */
export function retryAfterHeaders(
  decision: RateLimitDecision,
  now: number = Date.now()
): Record<string, string> {
  const seconds = Math.max(1, Math.ceil((decision.resetAt - now) / 1000))
  return {
    'retry-after': String(seconds),
    'x-ratelimit-reset': String(Math.floor(decision.resetAt / 1000)),
  }
}

/**
 * Test-only: drop every in-process counter and re-read the environment.
 *
 * The config and the one-shot warning are both memoised for the life of the
 * process, so a test that changes `process.env` must call this or it will keep
 * getting the store the previous test selected.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear()
  configCache = null
  warned = false
  degradedWarned = false
}
