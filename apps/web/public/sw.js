/*
 * Quantum Lab service worker — hand-written, no build step.
 *
 * This file is served verbatim from /sw.js, so it must be plain ES2020-era browser
 * JavaScript: no TypeScript, no imports from the app bundle, no npm dependencies.
 *
 * Why a service worker is worth it here: the visualizations, the circuit simulator and
 * the entire course are pure client-side TypeScript (apps/web/lib/quantum.ts) with no
 * backend. Once the HTML and the JS chunks are cached, all of that genuinely runs with
 * the network switched off. The only network-bound features are the AI tutor, billing
 * and saved-circuit sync — see the fetch handler for how those are deliberately
 * excluded from caching.
 */

/**
 * Cache identity. Read from the script URL, NOT hard-coded.
 *
 * This file used to declare `const CACHE_VERSION = 'v1'` above a comment telling a
 * human to bump it on every deploy. That did not work, and could not:
 *
 *   sw.js is served verbatim from public/. A deploy that changes application code
 *   but not this file ships a byte-identical worker. The browser's update check
 *   compares the fetched script's bytes with the installed one's, finds them equal,
 *   and installs nothing. No install means no new cache, no `activate`, and no
 *   eviction — the previous deploy's cached HTML stays authoritative for as long as
 *   the user keeps the site installed. Since `handleNavigation` falls back to that
 *   cached HTML whenever the network takes longer than NAVIGATION_TIMEOUT_MS, a
 *   user on a slow connection could be served last month's HTML, pointing at
 *   /_next/static chunk hashes that the current deploy no longer serves.
 *
 * So the identity comes from the registration URL instead:
 * ServiceWorkerRegistrar.tsx registers `/sw.js?v=<NEXT_PUBLIC_BUILD_STAMP>`, and
 * next.config.mjs sets that stamp to the same value as Next's build id. A new build
 * is a new script URL, which the browser treats as a different script and installs.
 *
 * SCHEMA_VERSION is separate and manual: bump it when the SHAPE of what is cached
 * changes (a new APP_SHELL entry, a different strategy) in a way that must invalidate
 * even on a rebuild of the same commit. It is not a deploy counter.
 *
 * The 'unversioned' fallback covers a worker registered without the query parameter
 * — an old registration from before this change, or a hand-typed URL. It is a real
 * cache name so behaviour degrades to the old (never-rotating) semantics rather
 * than breaking; the next registration from the app supplies a stamp and rotates it.
 */
const SCHEMA_VERSION = 'v2'
const BUILD_STAMP = (function () {
  try {
    return new URL(self.location.href).searchParams.get('v') || 'unversioned'
  } catch {
    return 'unversioned'
  }
})()
const CACHE_NAME = `quantum-lab-${SCHEMA_VERSION}-${BUILD_STAMP}`

/**
 * The minimum set that must exist in the cache before the app can survive a cold
 * offline start. Deliberately tiny: precaching route HTML we have not visited would
 * be guesswork, and Next.js route payloads are picked up by the runtime strategies
 * below as the user actually visits pages.
 */
const APP_SHELL = ['/', '/offline', '/manifest.webmanifest', '/icons/icon.svg']

/** How long a navigation may wait on the network before we serve from cache. */
const NAVIGATION_TIMEOUT_MS = 3000

/**
 * Paths that must never be served from the cache — they are meaningless offline,
 * or they carry per-user / entitlement-gated data.
 *
 * `/api/` is every API route (tutor, billing, circuit sync, health).
 *
 * `/learn/<slug>/content` is the paid-lesson gate (app/learn/[slug]/content/route.ts):
 * the paid blocks exist on the wire only in that response, only after the caller's
 * entitlement was checked. It is not under /api/, so it used to fall through to the
 * stale-while-revalidate handler, which stored the 200 in Cache Storage and served
 * it first on every later request — after sign-out, after a subscription lapsed,
 * and to the next person using the browser. Entitlement is decided by the server
 * on every request or not at all.
 */
const NETWORK_ONLY_PREFIXES = ['/api/']
const NETWORK_ONLY_PATTERNS = [/^\/learn\/[^/]+\/content\/?$/]

/** True for a same-origin path whose response must never touch Cache Storage. */
function isNetworkOnly(pathname) {
  return (
    NETWORK_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    NETWORK_ONLY_PATTERNS.some((pattern) => pattern.test(pathname))
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // `addAll` is atomic: one 404 rejects the whole install. That is the behaviour we
      // want for the shell — a half-precached shell is worse than no service worker.
      await cache.addAll(APP_SHELL)
    })(),
  )

  // NO unconditional self.skipWaiting() here, and that is a fix, not an omission.
  //
  // It used to be called on every install. Two things were wrong with that once the
  // cache name became per-build:
  //
  //  1. `activate` deletes every cache that is not CACHE_NAME. With skipWaiting, the
  //     new worker activates while tabs are still running the PREVIOUS build's HTML.
  //     Those tabs' lazily-loaded chunks (three.js on the two WebGL routes, via
  //     next/dynamic) had just been deleted out from under them, and a self-hosted
  //     `next start` does not serve the previous build's hashed chunks. The
  //     visualization would fail to load in a tab the user never navigated.
  //  2. It made components/pwa/OfflineBanner.tsx's "A new version is ready → Reload"
  //     banner pointless: the worker never entered `waiting`, so
  //     `registration.waiting?.postMessage({type:'SKIP_WAITING'})` had nothing to
  //     post to and the button was a plain reload with extra steps.
  //
  // Now the new worker waits, the banner appears, and the user's click sends
  // SKIP_WAITING (see the `message` handler) immediately before the page reloads —
  // so the old cache is evicted at the one moment nothing is relying on it.
  //
  // On a FIRST install there is no controller, so the browser activates immediately
  // regardless and `clients.claim()` below still gives offline support without a
  // second reload. Waiting only ever delays an UPDATE.
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.map((name) => (name === CACHE_NAME ? undefined : caches.delete(name))),
      )
      // Take over pages that were loaded before this worker existed, so the very first
      // visit gets offline support without a second reload.
      await self.clients.claim()
    })(),
  )
})

/**
 * Only ever store a response we are confident about:
 *  - `ok` filters out 4xx/5xx, so we never persist an error page as if it were content.
 *  - type 'basic' means same-origin and fully readable. Opaque cross-origin responses
 *    (type 'opaque') have an unknown status and count against storage quota at a padded
 *    size, so caching them is a trap.
 */
function isCacheable(response) {
  return Boolean(response) && response.ok && response.type === 'basic'
}

/** A parseable failure for fetch() callers, instead of an HTML page they cannot read. */
function offlineJsonResponse() {
  return new Response(
    JSON.stringify({
      error: 'offline',
      message: 'This feature needs a network connection.',
    }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

/**
 * Navigations: network-first with a short timeout.
 *
 * Network-first (not cache-first) because HTML is the one thing that must reflect a new
 * deploy immediately; serving a cached shell first would pin users to an old build.
 * The timeout exists because "online but on a dead train Wi-Fi" is the common case —
 * without it the user stares at a blank tab until the request finally errors, when we
 * had a perfectly good cached copy all along.
 *
 * The timeout is implemented with Promise.race plus an AbortController so the losing
 * network request is actually cancelled rather than left running in the background.
 */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME)
  const controller = new AbortController()

  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort()
      resolve(undefined)
    }, NAVIGATION_TIMEOUT_MS)
  })

  try {
    const networkResponse = await Promise.race([
      fetch(request, { signal: controller.signal }).catch(() => undefined),
      timeout,
    ])

    if (isCacheable(networkResponse)) {
      // Cache a copy so this route works on the next offline visit.
      cache.put(request, networkResponse.clone())
      return networkResponse
    }
    if (networkResponse) {
      // A real response we simply do not want to cache (redirect, 404, 500).
      return networkResponse
    }
  } finally {
    clearTimeout(timeoutId)
  }

  // Network was too slow or unavailable: this exact page, then the shell root, then
  // the dedicated offline page (which lists what still works without a connection).
  const cached =
    (await cache.match(request)) ||
    (await cache.match('/')) ||
    (await cache.match('/offline'))

  return (
    cached ||
    new Response('You are offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  )
}

/**
 * Next.js build output under /_next/static/: cache-first, and store on first fetch.
 *
 * These filenames contain a content hash, so a given URL's bytes can never change. That
 * makes revalidation pure waste: if it is in the cache it is correct, forever. A new
 * deploy produces new URLs, and the old ones are dropped wholesale when CACHE_VERSION
 * is bumped.
 */
async function handleStaticAsset(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (isCacheable(response)) {
    cache.put(request, response.clone())
  }
  return response
}

/**
 * Everything else same-origin: stale-while-revalidate.
 *
 * Fonts, images, the manifest, the icon, non-hashed public assets. Serving the cached
 * copy instantly keeps the UI fast and makes these assets available offline, while the
 * background refresh means a changed file is at most one visit out of date — the right
 * trade-off for assets that are neither critical-fresh (like HTML) nor immutable (like
 * hashed chunks).
 */
async function handleSameOrigin(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)

  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => undefined)

  if (cached) return cached

  const response = await network
  return (
    response ||
    new Response('', { status: 504, statusText: 'Gateway Timeout' })
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Never touch non-GET traffic. A POST/PUT/DELETE is a side effect on the server;
  // caching it or replaying it from cache would be actively wrong, and the Cache API
  // refuses to store it anyway.
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // Cross-origin (analytics, Supabase, Stripe, fonts on a CDN): stay out of the way.
  // We cannot inspect opaque responses, and these hosts manage their own caching.
  if (url.origin !== self.location.origin) return

  // API routes back the AI tutor, billing and circuit sync. A stale answer here is
  // worse than no answer, so: network only, and a JSON 503 on failure so the calling
  // fetch() gets something it can parse instead of an HTML fallback page.
  if (isNetworkOnly(url.pathname)) {
    event.respondWith(fetch(request).catch(() => offlineJsonResponse()))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(handleStaticAsset(request))
    return
  }

  event.respondWith(handleSameOrigin(request))
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || typeof data.type !== 'string') return

  if (data.type === 'SKIP_WAITING') {
    // Sent by the "A new version is ready → Reload" banner.
    self.skipWaiting()
    return
  }

  if (data.type === 'CLEAR_CACHE') {
    // Escape hatch for support ("try clearing the app cache") and for debugging.
    event.waitUntil(
      (async () => {
        const names = await caches.keys()
        await Promise.all(names.map((name) => caches.delete(name)))
      })(),
    )
  }
})
