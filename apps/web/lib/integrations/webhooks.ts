/**
 * integrations/webhooks.ts — outbound webhooks for external agent platforms
 * (roadmap stage A5, the "push" half; Vegaduta et al.).
 *
 * SERVER ONLY. Reads the service-role key when one is present and holds raw
 * signing secrets in memory; never import from a client component.
 *
 * ── What this module promises, and to whom ──────────────────────────────────
 *
 * To the RECEIVER: every delivery is a POST whose body is signed with
 * HMAC-SHA256 under the endpoint's secret, carried in `X-Quantum-Lab-Signature`
 * as `sha256=<hex>`. Verify by recomputing the HMAC over the RAW request bytes
 * and comparing constant-time (docs/INTEGRATIONS.md has a worked example).
 * Delivery is AT-LEAST-ONCE: a retry after a timed-out 200 duplicates, and the
 * hardware seam can re-observe a terminal poll from another instance — key
 * idempotency on the `id` field in the body, not on receipt count.
 *
 * To the CALLER (the grading path, the job poll): dispatch NEVER blocks and
 * NEVER throws. `dispatchWebhookEvent` returns void before any I/O starts
 * (queueMicrotask), and everything inside is caught and sent to the error
 * reporter. A webhook must never be the reason an exam fails to grade.
 *
 * ── SSRF guard ──────────────────────────────────────────────────────────────
 *
 * A webhook URL is an attacker-chosen address this server will POST to, which
 * is the textbook SSRF primitive. `validateWebhookUrl` therefore requires
 * https and refuses hostnames that are IP literals in private/special ranges
 * (and ALL IPv6 literals — classifying every embedding of v4-in-v6 correctly
 * is exactly the kind of parser subtlety that ships holes, and no real
 * receiver registers by raw IPv6 literal). The check runs at registration AND
 * again at every dispatch, so editing a row in the database does not bypass it.
 *
 * A DNS NAME is then RESOLVED (`assertPublicHost`) at registration and again at
 * every delivery, and refused when any returned address is private, loopback,
 * link-local, CGNAT, multicast or otherwise non-public — so `127.0.0.1.nip.io`,
 * `localtest.me` and the internal FQDN of a sibling Container App (which
 * resolves to a private address) are all refused. Names under `.internal`,
 * `.local`, `.lan` and `.home.arpa`, and any name containing an `internal`
 * label, are refused outright without a lookup.
 *
 * Stated RESIDUAL, on purpose: the resolve-then-connect pair is not atomic.
 * `fetch` resolves the name again when it connects, so an attacker who controls
 * the receiver's DNS can answer the check with a public address and the
 * connection with a private one (DNS rebinding). Closing that needs the socket
 * to be opened against the vetted address (a custom undici dispatcher with a
 * `lookup` hook, or an egress proxy), and this codebase takes no new
 * dependencies. What the guard stops: literal-IP SSRF and every name that
 * resolves to a private address at check time — the cheap and common cases. The
 * body is a fixed signed envelope and the response is never returned, so a
 * successful rebind is blind. Listed in docs/SECURITY.md's residual risks.
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 *
 * Same two-backend shape as lib/exams/store.ts, for the same reason: Supabase
 * (`webhook_endpoints`, supabase/schema-integrations.sql, service-role-only)
 * when configured, an in-process Map otherwise. The Map fallback loses every
 * registration on restart; /api/hooks reports `durable: false` so nobody is
 * told otherwise. The raw secret is stored server-side because HMAC signing
 * needs it — see the schema header for why "hash only" cannot work here.
 *
 * ── Auto-disable ────────────────────────────────────────────────────────────
 *
 * A delivery cycle is up to MAX_ATTEMPTS tries with backoff; an exhausted
 * cycle counts ONE consecutive failure. After MAX_CONSECUTIVE_FAILURES the
 * endpoint is flipped inactive, so a receiver that was torn down last month
 * stops costing three timeouts per event forever. Any 2xx resets the counter.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { getServiceSupabase, isServiceRoleConfigured } from '@/lib/billing/entitlements'
import { reportError } from '@/lib/observability/report'

// ────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────

/**
 * The three event types this platform emits. `challenge_completed` is declared
 * because the REST/MCP surface grades challenges server-side and a future
 * server-recorded completion should not need a schema change — but TODAY the
 * in-app challenge flow records completion in the browser only (localStorage),
 * so there is no server seam that fires it. See docs/INTEGRATIONS.md; do not
 * pretend to subscribers that it fires when nothing sends it.
 */
export const WEBHOOK_EVENTS = [
  'challenge_completed',
  'exam_passed',
  'hardware_job_finished',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(v)
}

// ────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────

/** Total tries per delivery cycle: 1 first attempt + 2 retries. */
export const MAX_ATTEMPTS = 3

/** Waits BEFORE retry 2 and retry 3. Short: this runs inside a request's tail. */
export const RETRY_BACKOFF_MS: readonly number[] = [500, 2_000]

/** Per-attempt timeout. A webhook receiver gets 5s, not our patience. */
export const DELIVERY_TIMEOUT_MS = 5_000

/** Exhausted cycles in a row before an endpoint is switched off. */
export const MAX_CONSECUTIVE_FAILURES = 10

/** Ceiling on endpoints per account, so registration cannot be a bomb. */
export const MAX_ENDPOINTS_PER_USER = 10

export const SIGNATURE_HEADER = 'x-quantum-lab-signature'
export const EVENT_HEADER = 'x-quantum-lab-event'
export const DELIVERY_HEADER = 'x-quantum-lab-delivery'

// ────────────────────────────────────────────────────────────
// URL allowlist rule (the SSRF guard)
// ────────────────────────────────────────────────────────────

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string }

/** 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10 (CGNAT), 0/8. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * https only; hostname must not be a private/special IP literal.
 *
 * "Looks numeric" is treated as an IP claim and held to strict dotted-decimal:
 * `https://2130706433/` and `https://0x7f000001/` are how 127.0.0.1 is usually
 * smuggled past a regex that only knows the dotted form, so any hostname made
 * of digits, dots and hex prefixes must parse as exactly four in-range octets
 * or it is refused outright.
 */
export function validateWebhookUrl(raw: string): UrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, error: 'url must be a string of at most 2048 characters.' }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL.' }
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Webhook URLs must use https.' }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Webhook URLs must not embed credentials.' }
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return { ok: false, error: 'url has no hostname.' }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, error: 'Webhook URLs must not point at localhost.' }
  }
  // URL keeps IPv6 literals bracketed in .host but bare in .hostname; either
  // way a colon can only mean an IPv6 literal here. All refused — see header.
  if (host.includes(':') || host.startsWith('[')) {
    return { ok: false, error: 'IPv6 literal hosts are not accepted; use a DNS name.' }
  }
  // Anything spelled purely from digits / dots / hex is an IP claim.
  if (/^[0-9.]+$/.test(host) || /(^|\.)0x[0-9a-f]+/.test(host)) {
    const parts = host.split('.')
    const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
    const strictV4 = octets.length === 4 && octets.every((o) => Number.isInteger(o) && o <= 255)
    if (!strictV4) {
      return { ok: false, error: 'Numeric hosts must be plain dotted-decimal IPv4.' }
    }
    if (isPrivateIpv4(octets)) {
      return { ok: false, error: 'Webhook URLs must not point at private or reserved IP ranges.' }
    }
  }
  // Internal-only namespaces are refused without a lookup. Azure Container Apps
  // gives an internal-ingress app a name with an `internal` label
  // (`app.internal.<env>.<region>.azurecontainerapps.io`).
  if (
    /\.(internal|local|lan|home\.arpa|intranet|corp)$/.test(host) ||
    host.split('.').includes('internal')
  ) {
    return { ok: false, error: 'Webhook URLs must not point at internal hostnames.' }
  }
  return { ok: true, url }
}

/** True for an IPv4 address that is not publicly routable (wider than isPrivateIpv4). */
function isNonPublicIpv4(octets: number[]): boolean {
  if (isPrivateIpv4(octets)) return true
  const [a, b, c] = octets
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/** Classify a resolved address (v4 or v6 text) as non-public. Unparseable => refuse. */
export function isNonPublicAddress(address: string): boolean {
  const addr = address.trim().toLowerCase().replace(/%.*$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const octets = addr.split('.').map(Number)
    if (octets.some((o) => o > 255)) return true
    return isNonPublicIpv4(octets)
  }
  if (!addr.includes(':')) return true
  // IPv4-mapped in dotted form (::ffff:10.0.0.1): judge the embedded v4.
  const dotted = addr.match(/^(?:[0:]*:)(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return isNonPublicAddress(dotted[1])
  // IPv4-mapped in hex form (::ffff:a00:1).
  const hexMapped = addr.match(/^[0:]*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16)
    const lo = parseInt(hexMapped[2], 16)
    return isNonPublicIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255])
  }
  if (addr === '::' || addr === '::1') return true
  const first = parseInt(addr.split(':')[0] || '0', 16)
  if (Number.isNaN(first)) return true
  if (first === 0) return true // ::/8 incl. IPv4-compatible and unspecified
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // multicast
  if (addr.startsWith('2001:db8') || addr.startsWith('2001:0db8')) return true // documentation
  if (addr.startsWith('64:ff9b')) return true // NAT64 embeds a v4 address; refuse
  return false
}

/** Resolves a hostname to every address it maps to. Swappable for tests. */
export type HostResolver = (host: string) => Promise<string[]>

const defaultResolver: HostResolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address)

let hostResolver: HostResolver = defaultResolver

/** TEST SEAM: replace (or, with no argument, restore) the DNS resolver. */
export function __setHostResolverForTests(resolver?: HostResolver): void {
  hostResolver = resolver ?? defaultResolver
}

/**
 * Resolve the URL's host and refuse it if ANY address is non-public. IP
 * literals were fully classified by validateWebhookUrl and need no lookup. A
 * lookup that fails or returns nothing is refused (fail closed): a receiver
 * that cannot be resolved cannot be delivered to anyway.
 */
export async function assertPublicHost(url: URL): Promise<UrlCheck> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (/^[0-9.]+$/.test(host)) return { ok: true, url }
  let addresses: string[]
  try {
    addresses = await hostResolver(host)
  } catch {
    return { ok: false, error: 'Webhook host could not be resolved.' }
  }
  if (addresses.length === 0) return { ok: false, error: 'Webhook host could not be resolved.' }
  if (addresses.some(isNonPublicAddress)) {
    return { ok: false, error: 'Webhook URLs must not resolve to private or reserved addresses.' }
  }
  return { ok: true, url }
}

// ────────────────────────────────────────────────────────────
// Signing
// ────────────────────────────────────────────────────────────

/** Hex HMAC-SHA256 of the exact body bytes. What the receiver recomputes. */
export function signWebhookPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

/** sha256 hex of the secret — the non-sensitive fingerprint the list API shows. */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

// ────────────────────────────────────────────────────────────
// Endpoint records and the two-backend store
// ────────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  id: string
  userId: string
  url: string
  /** Raw signing key. Never serialised by /api/hooks after registration. */
  secret: string
  secretHash: string
  events: WebhookEvent[]
  active: boolean
  failureCount: number
  createdAt: string
}

export const WEBHOOK_TABLE = 'webhook_endpoints'

interface EndpointRow {
  id: string
  user_id: string
  url: string
  secret: string
  secret_hash: string
  events: string[]
  active: boolean
  failure_count: number
  created_at: string
}

function rowToEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    secret: row.secret,
    secretHash: row.secret_hash,
    events: (Array.isArray(row.events) ? row.events : []).filter(isWebhookEvent),
    active: row.active === true,
    failureCount: typeof row.failure_count === 'number' ? row.failure_count : 0,
    createdAt: row.created_at,
  }
}

function endpointToRow(e: WebhookEndpoint): EndpointRow {
  return {
    id: e.id,
    user_id: e.userId,
    url: e.url,
    secret: e.secret,
    secret_hash: e.secretHash,
    events: e.events,
    active: e.active,
    failure_count: e.failureCount,
    created_at: e.createdAt,
  }
}

/** Thrown by the store when Supabase is configured but unreachable. The
 *  /api/hooks routes turn it into a 503; the dispatcher swallows and reports
 *  it, because a store outage must not surface through a grading response. */
export class WebhookStoreUnavailableError extends Error {
  constructor(message = 'The webhook store is unreachable.') {
    super(message)
    this.name = 'WebhookStoreUnavailableError'
  }
}

export interface WebhookStore {
  readonly kind: 'supabase' | 'memory'
  readonly durable: boolean
  listForUser(userId: string): Promise<WebhookEndpoint[]>
  /** Active endpoints of this account subscribed to this event. */
  listActiveForEvent(userId: string, event: WebhookEvent): Promise<WebhookEndpoint[]>
  insert(endpoint: WebhookEndpoint): Promise<WebhookEndpoint>
  /** Persist changed `active` / `failureCount`. Best-effort on dispatch. */
  update(endpoint: WebhookEndpoint): Promise<void>
  /** Delete only when owned by userId. True when a row went away. */
  delete(id: string, userId: string): Promise<boolean>
}

// Memory backend — same caveats as the exam store's Map, stated in the header.

const memEndpoints = new Map<string, WebhookEndpoint>()

const memoryStore: WebhookStore = {
  kind: 'memory',
  durable: false,
  async listForUser(userId) {
    return [...memEndpoints.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  },
  async listActiveForEvent(userId, event) {
    return (await this.listForUser(userId)).filter((e) => e.active && e.events.includes(event))
  },
  async insert(endpoint) {
    memEndpoints.set(endpoint.id, { ...endpoint })
    return endpoint
  },
  async update(endpoint) {
    if (memEndpoints.has(endpoint.id)) memEndpoints.set(endpoint.id, { ...endpoint })
  },
  async delete(id, userId) {
    const existing = memEndpoints.get(id)
    if (!existing || existing.userId !== userId) return false
    memEndpoints.delete(id)
    return true
  },
}

// Supabase backend.

function client() {
  const supabase = getServiceSupabase()
  if (!supabase) throw new WebhookStoreUnavailableError('No service-role client.')
  return supabase
}

function orThrow<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    reportError(result.error, { scope: 'integrations.webhooks.store', what })
    throw new WebhookStoreUnavailableError()
  }
  return result.data
}

const supabaseStore: WebhookStore = {
  kind: 'supabase',
  durable: true,
  async listForUser(userId) {
    const data = orThrow(
      await client()
        .from(WEBHOOK_TABLE)
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true }),
      'listForUser'
    )
    return ((data ?? []) as EndpointRow[]).map(rowToEndpoint)
  },
  async listActiveForEvent(userId, event) {
    // Array-contains is Postgres-side (`events @> {event}`); filtering the
    // user's handful of rows in JS instead keeps the query trivially portable
    // and the row count is capped at MAX_ENDPOINTS_PER_USER anyway.
    return (await this.listForUser(userId)).filter((e) => e.active && e.events.includes(event))
  },
  async insert(endpoint) {
    orThrow(await client().from(WEBHOOK_TABLE).insert(endpointToRow(endpoint)), 'insert')
    return endpoint
  },
  async update(endpoint) {
    orThrow(
      await client()
        .from(WEBHOOK_TABLE)
        .update({ active: endpoint.active, failure_count: endpoint.failureCount })
        .eq('id', endpoint.id),
      'update'
    )
  },
  async delete(id, userId) {
    const data = orThrow(
      await client().from(WEBHOOK_TABLE).delete().eq('id', id).eq('user_id', userId).select('id'),
      'delete'
    )
    return Array.isArray(data) && data.length > 0
  },
}

/** Resolved per call, not memoised — same reasoning as getExamStore. */
export function getWebhookStore(): WebhookStore {
  return isServiceRoleConfigured ? supabaseStore : memoryStore
}

// ────────────────────────────────────────────────────────────
// Registration / listing / deletion (what /api/hooks calls)
// ────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

/** What /api/hooks may serialise about an endpoint. NO `secret` field. */
export interface PublicEndpoint {
  id: string
  url: string
  events: WebhookEvent[]
  active: boolean
  failureCount: number
  /** First 12 hex chars of sha256(secret) — enough to match, useless to sign. */
  secretFingerprint: string
  createdAt: string
}

export function toPublicEndpoint(e: WebhookEndpoint): PublicEndpoint {
  return {
    id: e.id,
    url: e.url,
    events: e.events,
    active: e.active,
    failureCount: e.failureCount,
    secretFingerprint: e.secretHash.slice(0, 12),
    createdAt: e.createdAt,
  }
}

export type RegisterResult =
  | { ok: true; endpoint: WebhookEndpoint; secret: string }
  | { ok: false; error: string }

/**
 * Register an endpoint for a VERIFIED account id (the route resolves identity;
 * this function trusts its caller the way the exam service trusts
 * resolveSubject). The secret is server-generated and returned exactly once —
 * a caller-supplied secret would tempt clients into reusing credentials that
 * exist elsewhere, and 32 random bytes are strictly stronger anyway.
 */
export async function registerEndpoint(
  userId: string,
  rawUrl: string,
  rawEvents: unknown
): Promise<RegisterResult> {
  const syntactic = validateWebhookUrl(rawUrl)
  if (!syntactic.ok) return { ok: false, error: syntactic.error }
  const checked = await assertPublicHost(syntactic.url)
  if (!checked.ok) return { ok: false, error: checked.error }

  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { ok: false, error: `events must be a non-empty array from: ${WEBHOOK_EVENTS.join(', ')}.` }
  }
  const events = [...new Set(rawEvents)]
  if (!events.every(isWebhookEvent)) {
    return { ok: false, error: `Unknown event type. Valid events: ${WEBHOOK_EVENTS.join(', ')}.` }
  }

  const store = getWebhookStore()
  const existing = await store.listForUser(userId)
  if (existing.length >= MAX_ENDPOINTS_PER_USER) {
    return { ok: false, error: `An account may register at most ${MAX_ENDPOINTS_PER_USER} endpoints. Delete one first.` }
  }

  const secret = `whsec_${randomBytes(32).toString('hex')}`
  const endpoint: WebhookEndpoint = {
    id: newId('whk'),
    userId,
    url: checked.url.toString(),
    secret,
    secretHash: secretFingerprint(secret),
    events: events as WebhookEvent[],
    active: true,
    failureCount: 0,
    createdAt: new Date().toISOString(),
  }
  await store.insert(endpoint)
  return { ok: true, endpoint, secret }
}

// ────────────────────────────────────────────────────────────
// Delivery
// ────────────────────────────────────────────────────────────

/** Injectable I/O so the retry/disable logic is testable without a network. */
export interface DeliveryDeps {
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
}

const realDeps: DeliveryDeps = {
  fetchImpl: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface DeliveryOutcome {
  delivered: boolean
  attempts: number
}

/**
 * One delivery cycle against one endpoint: signed POST, MAX_ATTEMPTS tries,
 * RETRY_BACKOFF_MS between them, DELIVERY_TIMEOUT_MS per attempt. Any 2xx is
 * success; everything else — including a 3xx, because following a redirect
 * would re-open the SSRF door the URL check just closed — is a failed attempt.
 */
export async function deliverToEndpoint(
  endpoint: WebhookEndpoint,
  event: WebhookEvent,
  body: string,
  deliveryId: string,
  deps: DeliveryDeps = realDeps
): Promise<DeliveryOutcome> {
  // Re-check at dispatch time: a row edited in the database, or one written
  // before the guard tightened, must not turn the dispatcher into a proxy.
  const syntactic = validateWebhookUrl(endpoint.url)
  if (!syntactic.ok) return { delivered: false, attempts: 0 }
  // …and resolve it: a public-looking name that points at a private address is
  // refused here too (see assertPublicHost for the rebinding residual).
  const checked = await assertPublicHost(syntactic.url)
  if (!checked.ok) return { delivered: false, attempts: 0 }

  const signature = signWebhookPayload(endpoint.secret, body)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.sleep(RETRY_BACKOFF_MS[attempt - 2] ?? 2_000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    try {
      const res = await deps.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: `sha256=${signature}`,
          [EVENT_HEADER]: event,
          [DELIVERY_HEADER]: deliveryId,
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
      if (res.status >= 200 && res.status < 300) {
        return { delivered: true, attempts: attempt }
      }
    } catch {
      // Network error / timeout — indistinguishable from a 5xx for our
      // purposes: try again, then count the cycle.
    } finally {
      clearTimeout(timer)
    }
  }
  return { delivered: false, attempts: MAX_ATTEMPTS }
}

/**
 * The synchronous-looking core the fire-and-forget wrapper runs. EXPORTED FOR
 * TESTS and for nothing else — production callers use dispatchWebhookEvent,
 * which detaches from the request; awaiting this in a route would put webhook
 * receivers' latency on the user's critical path.
 */
export async function dispatchNow(
  event: WebhookEvent,
  payload: Record<string, unknown>,
  userId: string,
  deps: DeliveryDeps = realDeps
): Promise<void> {
  const store = getWebhookStore()
  let endpoints: WebhookEndpoint[]
  try {
    endpoints = await store.listActiveForEvent(userId, event)
  } catch (err) {
    reportError(err, { scope: 'integrations.webhooks', what: 'listActiveForEvent', event })
    return
  }
  if (endpoints.length === 0) return

  const deliveryId = newId('evt')
  const body = JSON.stringify({
    id: deliveryId,
    event,
    createdAt: new Date().toISOString(),
    data: payload,
  })

  await Promise.all(
    endpoints.map(async (endpoint) => {
      const outcome = await deliverToEndpoint(endpoint, event, body, deliveryId, deps)
      const next: WebhookEndpoint = outcome.delivered
        ? { ...endpoint, failureCount: 0 }
        : {
            ...endpoint,
            failureCount: endpoint.failureCount + 1,
            active: endpoint.failureCount + 1 < MAX_CONSECUTIVE_FAILURES,
          }
      if (
        next.failureCount !== endpoint.failureCount ||
        next.active !== endpoint.active
      ) {
        try {
          await store.update(next)
        } catch (err) {
          reportError(err, { scope: 'integrations.webhooks', what: 'update', endpoint: endpoint.id })
        }
      }
    })
  )
}

/**
 * Fire-and-forget dispatch. Returns before any I/O begins and can never throw
 * into the caller — this is the ONLY entry point application code may use.
 */
export function dispatchWebhookEvent(
  event: WebhookEvent,
  payload: Record<string, unknown>,
  userId: string
): void {
  queueMicrotask(() => {
    void dispatchNow(event, payload, userId).catch((err) => {
      reportError(err, { scope: 'integrations.webhooks', what: 'dispatch', event })
    })
  })
}

/**
 * Per-process dedupe for seams that re-observe the same fact — the hardware
 * poll sees `status: done` on every poll after the first. BEST-EFFORT ONLY:
 * two serverless instances each fire once, which is exactly the at-least-once
 * contract the module header states. The set is capped and cleared wholesale,
 * the same crude-but-ownerless policy as lib/rateLimit.ts's bucket map.
 */
const dispatchedKeys = new Set<string>()
const MAX_DEDUPE_KEYS = 5_000

export function dispatchWebhookEventOnce(
  dedupeKey: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  userId: string
): void {
  if (dispatchedKeys.has(dedupeKey)) return
  if (dispatchedKeys.size >= MAX_DEDUPE_KEYS) dispatchedKeys.clear()
  dispatchedKeys.add(dedupeKey)
  dispatchWebhookEvent(event, payload, userId)
}

/** Empties the in-process store and dedupe set. Tests only. */
export function __resetWebhookStoreForTests(): void {
  memEndpoints.clear()
  dispatchedKeys.clear()
}
