/**
 * GET /api/health — what this deployment can actually reach.
 *
 * STATUS CODE IS THE CONTRACT, not the body: 200 when everything configured is
 * answering, 503 when something configured is not. An orchestrator, an uptime
 * monitor and a load balancer all read the code and none of them parses JSON,
 * so a health endpoint that returns 200 with `{"status":"failing"}` is a health
 * endpoint that never fires an alert.
 *
 * `degraded` is 200. It means "working, with a caveat" (see the Supabase
 * anon-key-only case in lib/observability/health.ts) and paging on it would
 * teach people to ignore the page.
 *
 * WHAT THIS DOES NOT PUBLISH, because it is unauthenticated and reachable by
 * anyone who can reach the app: no environment-variable values, no internal
 * hostnames or ports, no upstream response bodies, no exception messages, no
 * database or provider error text.
 *
 * ANONYMOUS CALLERS GET STATUSES ONLY, on every branch (success, 503 and the
 * internal-error path): `version` and `environment` are empty strings and each
 * check's `detail` is empty. The detail strings name the LLM vendor per tier,
 * the mail provider and sender, and the admin count; the release and
 * environment name are reconnaissance too. A caller holding HEALTH_DEEP_TOKEN
 * (`x-health-token:` header or `token=`) gets all of it. With no token
 * configured nobody is "trusted", so the detail is simply never published.
 *
 * `?verbose=0` trims a trusted caller's per-check detail to just statuses, for
 * a monitor that only wants the roll-up.
 *
 * ── Cheap by default; the expensive checks are opt-in ───────────────────────
 *
 * This route used to be unauthenticated, unrate-limited, and to perform a live
 * Supabase HEAD count plus two upstream fetches ON EVERY REQUEST. That is a
 * free amplifier: one cheap request from anywhere on the internet became three
 * expensive requests against our own dependencies, with no bound on the rate.
 * A liveness probe that can be used to hammer the database is not a liveness
 * probe. Two things changed:
 *
 *  1. RATE LIMIT. Shallow gets a generous per-IP allowance (a 30s HEALTHCHECK
 *     needs 2/minute; the limit is 60). Deep gets a much smaller one, because
 *     each deep call costs three network round trips.
 *  2. DEEP IS OPT-IN. `?deep=1` runs the real probes. If `HEALTH_DEEP_TOKEN` is
 *     set, deep additionally requires it (`x-health-token:` header, or `token=`
 *     in the query so a monitor that can only be given a URL still works); a
 *     wrong or missing token silently falls back to the shallow report rather
 *     than 401-ing, so this endpoint never becomes an oracle for whether a
 *     token is configured.
 *
 * WHEN NO TOKEN IS CONFIGURED, deep remains open to anyone — bounded by the
 * tight limiter and by nothing else. That is the compatible default (an
 * operator's existing monitor keeps working after this deploy). Setting
 * HEALTH_DEEP_TOKEN is recommended — see docs/SECURITY.md, finding HEALTH-1.
 *
 * Point the orchestrator at `/api/health` and the uptime monitor at
 * `/api/health?deep=1&token=…`. A shallow `ok` means "the process is up and
 * wired", NOT "every dependency answers" — do not alert on it.
 */

import { NextResponse } from 'next/server'
import { RELEASE, ENVIRONMENT } from '@/lib/observability/release'
import { overallStatus, runHealthChecks, type HealthReport } from '@/lib/observability/health'
import { reportError } from '@/lib/observability/report'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'

// MUST NOT be prerendered or cached: a health report baked at build time is a
// lie that never changes. `revalidate = 0` is belt-and-braces with the CDN
// headers set below, which are what actually stop a proxy from caching it.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
} as const

/** A container HEALTHCHECK at --interval=30s needs 2/min. This is 30x that. */
const SHALLOW_LIMIT: RateLimitRule = { limit: 60, windowMs: 60_000 }
/** Three network round trips per call, so a far smaller allowance. */
const DEEP_LIMIT: RateLimitRule = { limit: 6, windowMs: 60_000 }

/** Constant-time-ish compare, so the token cannot be recovered byte by byte. */
function tokenMatches(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Should this request run the expensive probes?
 *
 * Returns false rather than an error for a bad token — see the header. The
 * caller gets a valid, cheap health report either way.
 */
function wantsDeep(req: Request, url: URL): boolean {
  const asked = url.searchParams.get('deep')
  if (asked !== '1' && asked !== 'true') return false

  const expected = (process.env.HEALTH_DEEP_TOKEN ?? '').trim()
  if (!expected) return true

  const supplied = (req.headers.get('x-health-token') ?? url.searchParams.get('token') ?? '').trim()
  return tokenMatches(supplied, expected)
}

function isTrusted(req: Request, url: URL): boolean {
  const expected = (process.env.HEALTH_DEEP_TOKEN ?? '').trim()
  if (!expected) return false
  const supplied = (req.headers.get('x-health-token') ?? url.searchParams.get('token') ?? '').trim()
  return tokenMatches(supplied, expected)
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const deep = wantsDeep(req, url)
  // Detail text, release and environment go only to a caller holding the
  // configured token. Anonymous callers (crawlers, scanners) get statuses only.
  const trusted = isTrusted(req, url)
  const verbose = trusted && url.searchParams.get('verbose') !== '0'

  // Two buckets, two prefixes: exhausting the deep allowance must not stop the
  // orchestrator's cheap liveness probe from answering.
  const decision = await rateLimit(
    callerKey(req.headers, deep ? 'health-deep' : 'health'),
    deep ? DEEP_LIMIT : SHALLOW_LIMIT
  )
  if (!decision.allowed) {
    return NextResponse.json(
      { status: 'unknown', error: 'Too many health checks. Wait a moment and try again.' },
      { status: 429, headers: { ...NO_STORE, ...retryAfterHeaders(decision) } }
    )
  }

  try {
    const checks = await runHealthChecks({ deep })
    const status = overallStatus(checks)

    const report: HealthReport = {
      status,
      version: trusted ? RELEASE : '',
      environment: trusted ? ENVIRONMENT : '',
      at: new Date().toISOString(),
      // `deep` is echoed so a monitor cannot mistake a shallow `ok` (which
      // proves only that the process is wired) for a real dependency check.
      deep,
      checks: verbose
        ? checks
        : Object.fromEntries(
            Object.entries(checks).map(([name, c]) => [
              name,
              { status: c.status, detail: '', checked: c.checked },
            ])
          ),
    }

    return NextResponse.json(report, {
      status: status === 'failing' ? 503 : 200,
      headers: NO_STORE,
    })
  } catch (err) {
    // runHealthChecks() is written not to throw, so reaching here means the
    // health machinery itself is broken — which is exactly the case where a
    // silent 200 would be worst. Report it and fail loudly.
    reportError(err, { route: 'api/health' })
    return NextResponse.json(
      {
        status: 'failing',
        version: trusted ? RELEASE : '',
        environment: trusted ? ENVIRONMENT : '',
        at: new Date().toISOString(),
        deep,
        checks: {},
        error: 'The health check itself failed.',
        code: 'internal',
      },
      { status: 503, headers: NO_STORE }
    )
  }
}
