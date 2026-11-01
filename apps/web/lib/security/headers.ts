/**
 * headers.ts — the single source of truth for Qubit16's response headers.
 *
 * The policy is built as DATA (a directive -> sources map) and serialised once,
 * so a directive can be read, diffed and unit-tested instead of being buried in
 * a string blob that nobody dares touch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OVERLAP WITH vercel.json
 * ─────────────────────────────────────────────────────────────────────────────
 * vercel.json already sets FOUR headers on `/(.*)`:
 *
 *     X-Content-Type-Options: nosniff
 *     Referrer-Policy:        strict-origin-when-cross-origin
 *     X-Frame-Options:        SAMEORIGIN
 *     Permissions-Policy:     camera=(), microphone=(), geolocation=(),
 *                             payment=(), usb=(), interest-cohort=()
 *
 * Those apply only on Vercel. Self-hosting (`next start`, the Dockerfile,
 * docker-compose) gets nothing from them at all, which is why the same headers
 * are set here, in middleware, where they apply on every deployment target.
 *
 * The two MUST NOT DIVERGE, so the four values below are byte-identical to
 * vercel.json's. That is deliberate:
 *
 *   • On Vercel the platform applies its headers to the response middleware
 *     produced. For a single-valued header the last writer wins, and since the
 *     values are identical, "which one wins" is not a question anyone has to
 *     answer. If they ever differ, VERCEL.JSON WINS (it is applied by the edge
 *     network after the function returns) — so a change made only here would
 *     silently do nothing in production. Change both, or neither.
 *   • `X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors 'self'` are
 *     equivalent statements, and are kept equivalent on purpose. A browser that
 *     understands both applies frame-ancestors and ignores XFO; an older one
 *     applies XFO. Setting `frame-ancestors 'none'` here while vercel.json says
 *     SAMEORIGIN would be a genuine conflict — same-origin framing would work
 *     on one deployment and not another — so it is not done.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO SCRIPT NONCE
 * ─────────────────────────────────────────────────────────────────────────────
 * A nonce must be unique per RESPONSE and must appear both in the header and in
 * the HTML. Nearly every page in this app is statically prerendered at build
 * time (`next build` emits static HTML for /, /learn/*, /visualizations/*, the
 * lesson and challenge pages...) and that HTML — including Next's inline
 * bootstrap and flight-payload scripts — is written once and served to everyone.
 * A per-request nonce injected by middleware would not match the nonce baked
 * into that static HTML, so every inline script would be BLOCKED and the app
 * would fail to hydrate.
 *
 * The alternatives were:
 *   (a) Nonce everything, and convert the whole app to dynamic rendering. That
 *       is a performance and architecture change, not a security fix, and it is
 *       out of scope for an audit.
 *   (b) Ship `script-src 'none'`-adjacent strictness that silently breaks the
 *       app the first time someone deploys it.
 *   (c) Ship a CSP with `'unsafe-inline'` on script-src, be explicit that this
 *       is the weakest part of the policy, and get the value that remains:
 *       `default-src 'self'` plus a closed `connect-src` still stops an
 *       injected script from loading remote code or beaconing data to an
 *       attacker's host, and `object-src 'none'`, `base-uri 'none'` and
 *       `form-action 'self'` still close three real injection paths.
 *
 * (c) is what ships. THE TRADE-OFF IS REAL: with `'unsafe-inline'` on scripts,
 * this CSP is a defence-in-depth layer against exfiltration, not a defence
 * against XSS execution. The app's actual anti-XSS control is that it renders
 * everything — including LLM output — through React text nodes and uses
 * `dangerouslySetInnerHTML` nowhere (verified: zero occurrences in the repo).
 * Moving to a nonce is tracked in docs/SECURITY.md's pre-production checklist.
 */

/** A CSP as data: directive name -> source list. Empty list means "no sources". */
export type CspDirectives = Record<string, readonly string[]>

const isProduction = process.env.NODE_ENV === 'production'
const isDevelopment = process.env.NODE_ENV === 'development'

/**
 * Is the on-device (WebGPU) tutor switched on for this deployment?
 *
 * Read as a LITERAL `process.env.NEXT_PUBLIC_...` reference, never through a
 * dynamic lookup: Next.js inlines the literal form into the client bundle at
 * build time and cannot inline the dynamic one (lib/env.ts's own header
 * records the same trap costing a production outage). It is a build-time
 * value on purpose — the CSP below is emitted into statically prerendered
 * responses, so it cannot vary per request anyway.
 */
export const isDeviceTutorEnabled =
  (process.env.NEXT_PUBLIC_DEVICE_TUTOR ?? '').trim().toLowerCase() === '1' ||
  (process.env.NEXT_PUBLIC_DEVICE_TUTOR ?? '').trim().toLowerCase() === 'true'

/**
 * Origins the browser is allowed to talk to.
 *
 * Each is optional and each defaults to nothing, so the zero-config path yields
 * a policy of exactly `'self'` — which is correct, because with an empty
 * environment the app makes no cross-origin requests at all.
 */
function connectOrigins(): string[] {
  const origins = new Set<string>(["'self'"])

  const add = (raw: string | undefined): void => {
    const value = (raw ?? '').trim()
    if (!value) return
    try {
      origins.add(new URL(value).origin)
    } catch {
      // A malformed URL must never produce a malformed CSP directive. Skipping
      // it degrades to a stricter policy, which is the safe direction.
    }
  }

  // The Python circuit API. next.config.mjs defaults this to localhost:8000, so
  // it is normally present even with an empty .env.
  add(process.env.NEXT_PUBLIC_API_URL)
  // Supabase auth + storage (REST and realtime share the origin).
  add(process.env.NEXT_PUBLIC_SUPABASE_URL)
  // Sentry ingest, only when a DSN is configured.
  add(process.env.NEXT_PUBLIC_SENTRY_DSN)
  // An optional self-hosted analytics sink.
  add(process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT)

  // Supabase realtime uses a websocket on the same host.
  const supabase = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  if (supabase) {
    try {
      origins.add(`wss://${new URL(supabase).host}`)
    } catch {
      /* ignore — see above */
    }
  }

  // The on-device tutor (lib/llm/webllm.ts) fetches its model weights and the
  // matching WebGPU shader library straight from the two hosts MLC publishes
  // them on. Without these it fails with a bare CSP violation in the console
  // and no user-visible error at all, which is a miserable thing to debug.
  //
  // CONDITIONAL, and that is the point: a deployment that leaves the feature
  // off keeps exactly the closed connect-src it had before this existed. This
  // mirrors how the Sentry origin is only added once a DSN is set.
  //
  // Both hosts are weight/asset CDNs, not API endpoints — neither can receive
  // a POST body — so the exfiltration surface this directive exists to close
  // is not meaningfully widened. huggingface.co redirects weight requests to
  // its own *.hf.co CDN, and CSP re-checks the post-redirect URL, so that
  // wildcard is required as well as the apex.
  if (isDeviceTutorEnabled) {
    origins.add('https://huggingface.co')
    origins.add('https://*.hf.co')
    origins.add('https://raw.githubusercontent.com')
  }

  // Next's dev server hot-reloads over a websocket to the page's own origin.
  if (isDevelopment) origins.add('ws:')

  return [...origins]
}

/**
 * Ancestors allowed to FRAME the /embed/* routes, beyond 'self'.
 *
 * NEXT_PUBLIC_EMBED_ANCESTORS is a space- or comma-separated list of origins
 * (e.g. "https://vegaduta.ai https://www.vegaduta.ai"). Default unset = no
 * extra ancestors = the embed routes get exactly the global `'self'` policy,
 * so the zero-config path stays as strict as before this variable existed.
 *
 * Each entry is normalised through `new URL().origin` exactly like
 * `connectOrigins()` above, and for the same reason: a malformed value must
 * degrade to a STRICTER policy (the entry is dropped), never to a malformed
 * directive. Wildcards are therefore impossible to express here — that is a
 * feature, not a gap: frame-ancestors is the header that decides who may put
 * this app inside their page, and "anyone" is not an answer this file accepts.
 *
 * WHY X-Frame-Options IS NOT TOUCHED: vercel.json (and this file, kept
 * byte-identical — see the top note) says `X-Frame-Options: SAMEORIGIN` on
 * every route, and on Vercel the edge applies vercel.json AFTER middleware, so
 * a per-route XFO carve-out here would silently do nothing in production —
 * exactly the divergence the top note forbids. Instead this relies on the
 * precedence the top note already documents: a browser that understands both
 * headers applies frame-ancestors and IGNORES XFO, so widening frame-ancestors
 * on the embed routes is sufficient for every browser shipped since ~2016. A
 * legacy browser falls back to XFO's SAMEORIGIN and refuses the cross-origin
 * frame — which fails STRICT, the safe direction. docs/EMBED.md states this
 * trade-off to integrators.
 */
export function embedFrameAncestors(): string[] {
  const raw = (process.env.NEXT_PUBLIC_EMBED_ANCESTORS ?? '').trim()
  if (!raw) return []
  const ancestors = new Set<string>()
  for (const entry of raw.split(/[\s,]+/)) {
    if (!entry) continue
    try {
      const url = new URL(entry)
      // Only web origins: `javascript:` / `data:` parse, but their origin is
      // the opaque "null", which must never reach a frame-ancestors list.
      if (url.protocol === 'https:' || url.protocol === 'http:') ancestors.add(url.origin)
    } catch {
      // Dropped, not guessed at — see connectOrigins() for the rationale.
    }
  }
  return [...ancestors]
}

/**
 * Build the policy for this environment.
 *
 * Every entry carries the reason it exists, because the only thing worse than
 * no CSP is a CSP that nobody can safely edit.
 *
 * @param options.embed True only for the /embed/* routes (decided by proxy.ts
 *   from the pathname). The ONLY directive it changes is frame-ancestors —
 *   an embed is the same app with the same scripts and the same connect list,
 *   so every other directive must stay identical, and keeping the flag out of
 *   the other entries is what guarantees that.
 */
export function cspDirectives(options: { embed?: boolean } = {}): CspDirectives {
  const extraAncestors = options.embed === true ? embedFrameAncestors() : []
  return {
    // Everything not named below falls back to same-origin only.
    'default-src': ["'self'"],

    // See the long note above: statically prerendered HTML makes a per-request
    // nonce impossible, so inline scripts are permitted. 'unsafe-eval' is added
    // ONLY in development, where Next's HMR needs it; production never gets it.
    //
    // 'wasm-unsafe-eval' is added ONLY when the on-device tutor is enabled.
    // WebLLM compiles a WebAssembly module for the WebGPU backend, and without
    // this token that compile is refused. It is a much narrower grant than
    // 'unsafe-eval': it permits WebAssembly compilation and nothing else — no
    // eval(), no Function(), no setTimeout(string). A deployment with the
    // feature off keeps precisely the script-src it had before.
    'script-src': isDevelopment
      ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
      : isDeviceTutorEnabled
        ? ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]
        : ["'self'", "'unsafe-inline'"],

    // Next.js injects styles inline (styled-jsx, the critical-CSS <style> tags
    // it emits for every page) and Tailwind's runtime-set custom properties are
    // applied as inline style attributes. Without 'unsafe-inline' the app
    // renders unstyled. `style-src-attr` would be the tighter split, but Next
    // needs inline <style> ELEMENTS too, so both are covered by this one entry.
    'style-src': ["'self'", "'unsafe-inline'"],

    // The app draws with inline SVG and canvas/WebGL (three.js), exports charts
    // and certificates as data: and blob: URLs, and ships an app icon at
    // app/icon.svg. No remote images are loaded from anywhere.
    'img-src': ["'self'", 'data:', 'blob:'],

    // Self-hosted fonts only; data: covers any inlined subset.
    'font-src': ["'self'", 'data:'],

    // Closed list — this is the directive that does the real work here. With
    // script-src permissive, restricting where a script may SEND data is what
    // still makes an injected script mostly useless.
    'connect-src': connectOrigins(),

    // three.js compiles shaders and the simulator does heavy maths; if either
    // ever moves to a worker, it must be a same-origin one. blob: is included
    // because bundlers emit workers as blob URLs.
    'worker-src': ["'self'", 'blob:'],

    // No <object>, <embed> or <applet>. Nothing in the app uses them, and they
    // are a classic bypass for a script-src that permits inline.
    'object-src': ["'none'"],

    // Stops an injected <base href> from re-pointing every relative script URL.
    'base-uri': ["'none'"],

    // Forms may only post to this origin. Stripe Checkout is a REDIRECT away to
    // checkout.stripe.com (see app/api/billing/checkout/route.ts — the route
    // returns `session.url` and the browser navigates), NOT an embedded form or
    // iframe. A navigation is not a form submission and is not a frame, so
    // neither form-action nor frame-src needs a Stripe entry. If the app ever
    // adopts Stripe Elements or embedded Checkout, frame-src must gain
    // https://js.stripe.com and https://hooks.stripe.com — grep for `frame-src`
    // in this file before making that change.
    'form-action': ["'self'"],

    // Equivalent to X-Frame-Options: SAMEORIGIN, matching vercel.json. See the
    // note at the top of this file. On the /embed/* routes (and ONLY there) the
    // NEXT_PUBLIC_EMBED_ANCESTORS allowlist is appended — see the long note on
    // embedFrameAncestors() for why XFO stays SAMEORIGIN alongside it.
    'frame-ancestors': ["'self'", ...extraAncestors],

    // Nothing in the app is framed.
    'frame-src': ["'none'"],

    // Only meaningful over HTTPS; harmless (and ignored) on http://localhost.
    ...(isProduction ? { 'upgrade-insecure-requests': [] } : {}),
  }
}

/** Serialise a directive map to a CSP header value. */
export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(' ')}`))
    .join('; ')
}

/**
 * Every security header this app sets, as a plain object.
 *
 * @param options.isSecure Whether the request arrived over HTTPS. HSTS is only
 *   emitted when true AND in production — sending it from a plain-http dev
 *   server would be ignored by browsers anyway, and sending it from a staging
 *   box on http would be a footgun the day someone points a real hostname at it.
 * @param options.embed Whether this response is for an /embed/* route — passed
 *   through to cspDirectives(); see embedFrameAncestors() for what it changes
 *   (frame-ancestors) and, deliberately, what it does not (everything else,
 *   X-Frame-Options included).
 */
export function securityHeaders(
  options: { isSecure?: boolean; embed?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': serializeCsp(cspDirectives({ embed: options.embed })),

    // ── The four below are byte-identical to vercel.json. Change both. ──
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    // ────────────────────────────────────────────────────────────────────

    // Speculative DNS lookups for third-party hosts leak a visitor's reading
    // habits to a resolver. This app has no third-party hosts to prefetch.
    'X-DNS-Prefetch-Control': 'off',
  }

  // Two years, subdomains included. NOT preloaded: preload is a one-way door
  // that the operator, not this file, must choose to walk through.
  if (options.isSecure === true && isProduction) {
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'
  }

  return headers
}

/** Apply every security header to a Headers object, in place. */
export function applySecurityHeaders(
  target: Headers,
  options: { isSecure?: boolean; embed?: boolean } = {},
): void {
  for (const [name, value] of Object.entries(securityHeaders(options))) {
    target.set(name, value)
  }
}
