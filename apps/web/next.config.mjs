/**
 * One identifier for this build, used in two places that MUST agree:
 *
 *  1. `generateBuildId`, i.e. Next's own build id (the `.next/BUILD_ID` file and
 *     the `/_next/static/<buildId>/` path segment).
 *  2. `NEXT_PUBLIC_BUILD_STAMP`, which components/pwa/ServiceWorkerRegistrar.tsx
 *     appends to the service worker's script URL as `/sw.js?v=<stamp>`.
 *
 * Why they must agree: public/sw.js derives its cache name from that query
 * parameter. Before this existed, sw.js hard-coded `CACHE_VERSION = 'v1'` with a
 * comment telling a human to bump it on every deploy that changes cached assets.
 * Nothing enforced that, and the failure mode is invisible: sw.js is a static file
 * in public/, so a deploy that changes app code but not sw.js ships a
 * BYTE-IDENTICAL worker. The browser compares bytes, finds no change, fires no
 * update, and the previous deploy's cache — including its cached HTML — survives.
 * Deriving the stamp from the build id means a new build is a new script URL is a
 * new registration is a new cache. See docs/PWA.md § "Deploy invalidation".
 *
 * Preference order is deliberate: a commit SHA is stable across a rebuild of the
 * same commit, so redeploying identical code does not needlessly evict every
 * user's cache. Date.now() is the last resort for a local `next build`.
 *
 * DO NOT remove `generateBuildId` without also removing the sw.js coupling — a
 * stamp that no longer tracks the build id is worse than the hard-coded 'v1',
 * because it looks automatic.
 */
/**
 * Keep a candidate to characters that are safe in a URL path segment and a
 * query value, and short enough to read in a log.
 */
const sanitiseStamp = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)

/**
 * An EMPTY value is "unset", not a stamp. `??` only skips null/undefined, and a
 * Docker `ARG NEXT_PUBLIC_BUILD_STAMP=""` becomes an empty-string ENV in every
 * image built without the build-arg, which used to yield an empty Next build id
 * and a service worker registered as `/sw.js?v=` (a cache name that never
 * rotates). So every candidate is sanitised first and the first one that is
 * still non-empty wins; the timestamp can never be empty.
 */
const BUILD_STAMP =
  [
    process.env.NEXT_PUBLIC_BUILD_STAMP,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
  ]
    .map(sanitiseStamp)
    .find((candidate) => candidate.length > 0) ?? sanitiseStamp(Date.now())

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `x-powered-by: Next.js` on every response: framework fingerprinting for
  // exploit scanners, no functional benefit.
  poweredByHeader: false,
  generateBuildId: () => BUILD_STAMP,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000',
    NEXT_PUBLIC_BUILD_STAMP: BUILD_STAMP,
  },
  // Apple fetches this file with no extension and expects JSON. A static file
  // with no extension is otherwise served as application/octet-stream, which
  // makes iOS Universal Links verification fail silently (the app still works;
  // shared links just open in Safari). See docs/IOS.md.
  async headers() {
    return [
      {
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ]
  },
  // instrumentation.ts's register() hook is also what runs lib/env.ts's
  // assertEnv() at startup — see that file's header. It used to need
  // `experimental.instrumentationHook: true` here (Next.js 13/14) to load at
  // all; as of Next.js 15, instrumentation.ts loads by default, and Next.js
  // 16 rejects the now-unrecognized flag outright, so it is removed rather
  // than kept as a no-op. Nothing else changes: instrumentation.ts still runs
  // unconditionally, independent of Sentry, exactly as the removed comment
  // here used to promise.
}

const SENTRY_DSN = (process.env.NEXT_PUBLIC_SENTRY_DSN ?? '').trim()

/**
 * Sentry's webpack plugin is wrapped in ONLY when a DSN exists.
 *
 * A developer with no Sentry account is the default case, and for them this file
 * must behave exactly as it did before: no webpack plugin, no source-map upload
 * attempt, no auth-token warning, no extra build time. So the plain config is
 * exported unless a DSN is present, and the wrapper is only reached when it is.
 * The instrumentation hook itself stays on regardless (see above) — it is cheap
 * (one small module) and instrumentation.ts internally no-ops the Sentry-specific
 * parts of register() when there is no DSN, so this does not undo that guard.
 */
let config = nextConfig

if (SENTRY_DSN) {
  const { withSentryConfig } = await import('@sentry/nextjs')
  config = withSentryConfig(
    nextConfig,
    {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      disableLogger: true,
      // Source maps are only uploaded when an auth token is actually present.
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    }
  )
}

export default config
