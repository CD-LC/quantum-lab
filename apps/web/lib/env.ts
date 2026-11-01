/**
 * env.ts — the authoritative list of every environment variable the Next app
 * reads, and the startup check that reports on them.
 *
 * The list below was derived by grepping `apps/web` for `process.env.` and
 * following each hit to the code that consumes it, not by copying a document.
 * If you add a `process.env.X` anywhere under `apps/web`, add it here too —
 * `docs/DEPLOYMENT.md` and `.env.example` are both written from this table.
 *
 * ## Why the `required` list is empty
 *
 * It is not an oversight and it is not laziness. This app is built so that an
 * entirely empty environment produces a working deployment: the lesson track,
 * the circuit simulator, the eight visualizations, the exams and the offline
 * tutor are self-contained TypeScript with no external dependency. Every
 * variable here switches on an *extra*, and every consumer of one is written to
 * degrade rather than throw (see `lib/supabase.ts`, `lib/billing/stripe.ts`,
 * `lib/email/client.ts`).
 *
 * So `assertEnv()` has nothing to fail on from absence alone. What it *does*
 * fail on is a half-configuration — a combination that cannot work and that
 * fails silently in production, where "silently" means the operator finds out
 * from a support email weeks later. Those are the `PAIRS` rules below. That is
 * the fail-loud-and-early path, and it is the one worth having.
 *
 * Do not "fix" this by marking things required. A change that makes an empty
 * environment fail to boot breaks the property the whole project is built on.
 *
 * ## Where this runs
 *
 * `instrumentation.ts` calls `assertEnv()` in its `register()` hook.
 * `next.config.mjs` sets `experimental.instrumentationHook` unconditionally
 * (not only when `NEXT_PUBLIC_SENTRY_DSN` is present), so Next 14 always loads
 * `instrumentation.ts` and this check runs on every deployment, Sentry or not.
 * `node scripts/preflight.mjs` covers the same ground before a deploy and needs
 * no build, for the pre-deploy path.
 *
 * ## Build time vs run time
 *
 * `scope: 'build'` is load-bearing, not documentation. `next.config.mjs` has an
 * `env: { NEXT_PUBLIC_API_URL }` block, and every `NEXT_PUBLIC_*` name is
 * inlined into the compiled output by the compiler. Their values are frozen at
 * `next build`. Changing one in a dashboard, a `docker run -e`, or a compose
 * `environment:` block does nothing at all — verified by grepping the committed
 * build output: `.next/server/app/hardware/page.js` and
 * `.next/server/middleware.js` both contain the literal `http://localhost:8000`
 * baked in from the build machine. A rebuild is the only way to change them.
 */

/** Whether the deployment can work at all without this variable. */
export type Requirement = 'required' | 'optional'

/**
 * Where the value must be present.
 *
 * - `build` — read by the compiler and frozen into the output. Setting it at
 *   run time has no effect; you must rebuild.
 * - `server` — read at run time by server code only. Never reaches the browser.
 */
export type Scope = 'build' | 'server'

/** One environment variable, and what its absence actually costs. */
export interface EnvVar {
  /** Exact variable name, as spelled in `process.env.<name>`. */
  readonly name: string
  readonly requirement: Requirement
  readonly scope: Scope
  /** What is switched on when it is set. */
  readonly unlocks: string
  /** What the app does instead when it is missing. Never "it crashes". */
  readonly withoutIt: string
  /** File:line of a representative read, so the claim above is checkable. */
  readonly readAt: string
}

/**
 * Every variable `apps/web` reads, in deployment order rather than alphabetical
 * order — the ones an operator sets first come first.
 *
 * Deliberately absent: `NODE_ENV`, `NEXT_RUNTIME`, `CI`, `PW_CHROMIUM` and the
 * `__NEXT_*` internals. The first two are set by the framework, `CI` and
 * `PW_CHROMIUM` belong to the test harness (`playwright.config.ts`), and the
 * `__NEXT_*` names are Next's own private plumbing. None of them is an operator
 * decision, and listing them would bury the twenty that are.
 */
export const ENV_VARS: readonly EnvVar[] = [
  {
    name: 'NEXT_PUBLIC_APP_URL',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Canonical URLs, the sitemap, OG/social preview images, and the Stripe checkout return URLs.',
    withoutIt:
      'Everything falls back to http://localhost:3000. Search engines index localhost, social previews are blank, and a customer who completes a real Stripe payment is redirected to a URL that is nothing on their machine.',
    readAt: 'lib/seo.ts:15, lib/billing/stripe.ts:81',
  },
  {
    name: 'NEXT_PUBLIC_API_URL',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Points the hardware pages and the server-side proxy at services/api for circuit execution.',
    withoutIt: 'Defaults to http://localhost:8000; the hardware page shows its "start the API" setup guidance.',
    readAt: 'lib/hardware/proxy.ts:50, lib/hardware/client.ts:42, next.config.mjs:5',
  },
  {
    name: 'AGENT_SERVICE_URL',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Routes /api/agent to the LangChain agent service, which is the tutor tier that can run circuits to check its own answers.',
    withoutIt: 'The tutor drops to a direct model call, or to the offline answer set. The status line in /tutor says which tier is live.',
    readAt: 'app/api/agent/route.ts:54',
  },
  {
    name: 'GEMINI_API_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Live tutor answers in /tutor via Gemini Flash — checked first, and the cheapest option (genuine free tier).',
    withoutIt: 'Falls through to GROQ_API_KEY, then ANTHROPIC_API_KEY, then the built-in offline answer set.',
    readAt: 'app/api/agent/route.ts:selectDirectProvider',
  },
  {
    name: 'GROQ_API_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Live tutor answers via a Groq-hosted open-weight model — used when GEMINI_API_KEY is unset.',
    withoutIt: 'Falls through to ANTHROPIC_API_KEY, then the built-in offline answer set.',
    readAt: 'app/api/agent/route.ts:selectDirectProvider',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Live tutor answers via Claude — the premium option, used when neither GEMINI_API_KEY nor GROQ_API_KEY is set.',
    withoutIt: 'The tutor answers from the built-in offline answer set and says so.',
    readAt: 'app/api/agent/route.ts:selectDirectProvider',
  },
  {
    name: 'AZURE_API_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Live tutor answers and the two model-calling workbench tools via Azure OpenAI — the shared VegaDuta resource, last in the cheapest-first order.',
    withoutIt: 'Azure is skipped. With no other key set, the tutor uses the offline answer set and /workbench/generate and /workbench/evolve say no model is configured.',
    readAt: 'lib/platform/settings.ts:envLlmSettings',
  },
  {
    name: 'AZURE_API_BASE',
    requirement: 'optional',
    scope: 'server',
    unlocks: "The Azure resource's /openai root, e.g. https://vegaduta-ai-az-aoai.openai.azure.com/openai. The SDK appends /deployments/<deployment> itself (useDeploymentBasedUrls).",
    withoutIt: 'providerReady() treats Azure as unconfigured even with a key set, and the resolver falls through to the next provider.',
    readAt: 'lib/platform/settings.ts:envLlmSettings, lib/platform/llmConfig.ts:providerReady',
  },
  {
    name: 'AZURE_API_VERSION',
    requirement: 'optional',
    scope: 'server',
    unlocks: "Pins the Azure api-version query parameter when the deployment rejects the AI SDK's default.",
    withoutIt: "The AI SDK's own default api-version is used, which current gpt-4.1-mini deployments accept.",
    readAt: 'lib/platform/settings.ts:envLlmSettings, app/api/agent/route.ts:buildModel',
  },
  {
    name: 'NEXT_PUBLIC_DEVICE_TUTOR',
    requirement: 'optional',
    scope: 'build',
    unlocks:
      'The on-device tutor: a WebGPU model the learner downloads once and then runs locally, with no API key, no per-question cost, no message limit and no question ever leaving the browser. Set to 1 or true.',
    withoutIt:
      'The panel is not rendered and the CSP keeps its closed connect-src and its script-src without wasm-unsafe-eval — i.e. exactly the policy shipped before the feature existed.',
    readAt: 'lib/security/headers.ts:isDeviceTutorEnabled, components/tutor/DeviceTutorPanel.tsx',
  },
  {
    name: 'TUTOR_MODEL',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Overrides the per-provider model id used by the direct-call tier (gemini-2.5-flash / llama-3.3-70b-versatile / claude-sonnet-4-6 by default).',
    withoutIt: 'Uses the cheap default for whichever provider key is set.',
    readAt: 'app/api/agent/route.ts:selectDirectProvider',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Accounts, cloud-synced progress, saved circuits, org membership.',
    withoutIt: 'Progress and circuits are stored in browser localStorage and still work; there are no accounts.',
    readAt: 'lib/supabase.ts:16',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Client-side Supabase access. Useless on its own — see the pair rule below.',
    withoutIt: 'Same as above: local-only mode.',
    readAt: 'lib/supabase.ts:17',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Server-side writes: the Stripe webhook syncing subscription rows, org membership reads that bypass RLS.',
    withoutIt: 'Entitlement lookups fall back to the free plan and the billing webhook cannot persist a plan change.',
    readAt: 'lib/billing/entitlements.ts:53',
  },
  {
    name: 'SETTINGS_ENCRYPTION_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks:
      'The AES key that seals BYOK vendor credentials and admin-set provider keys at rest. 64 hex chars (openssl rand -hex 32), or any string.',
    withoutIt:
      'Sealing falls back to a key DERIVED FROM SUPABASE_SERVICE_ROLE_KEY: it still works, but anyone who can read the service-role key can decrypt every stored credential, and rotating the service-role key makes them all unreadable. The app logs one loud warning per process and /api/health (trusted callers) reports byokKeyIsFallback. See docs/BYOK.md, "Moving off the fallback key".',
    readAt: 'lib/platform/secretBox.ts:keyBytes',
  },
  {
    name: 'STRIPE_SECRET_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Checkout, the customer portal, and server-enforced plan gating.',
    withoutIt: 'Every account is on the free plan and all free content is fully available. Billing routes answer with a "billing is not set up" payload, not an error.',
    readAt: 'lib/billing/stripe.ts:21',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Signature verification on POST /api/billing/webhook.',
    withoutIt: 'Every webhook is rejected, so a completed payment never becomes a plan. This is the whsec_… value created with the endpoint, not an sk_… key.',
    readAt: 'app/api/billing/webhook/route.ts:22',
  },
  {
    name: 'STRIPE_PRICE_PRO_MONTHLY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Maps a Stripe price id onto the Pro plan, monthly.',
    withoutIt: 'A subscription on that price matches no plan and resolves to free — for someone who has just paid.',
    readAt: 'lib/plans.ts:155 via lib/billing/stripe.ts:58',
  },
  {
    name: 'STRIPE_PRICE_PRO_YEARLY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Maps a Stripe price id onto the Pro plan, annual.',
    withoutIt: 'As above.',
    readAt: 'lib/plans.ts:156 via lib/billing/stripe.ts:58',
  },
  {
    name: 'STRIPE_PRICE_TEAM_MONTHLY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Maps a Stripe price id onto the Team plan, monthly.',
    withoutIt: 'As above.',
    readAt: 'lib/plans.ts:183 via lib/billing/stripe.ts:58',
  },
  {
    name: 'STRIPE_PRICE_TEAM_YEARLY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Maps a Stripe price id onto the Team plan, annual.',
    withoutIt: 'As above.',
    readAt: 'lib/plans.ts:184 via lib/billing/stripe.ts:58',
  },
  {
    name: 'QUANTUM_API_SECRET',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Sends X-Quantum-Lab-Secret upstream from the Next proxy to services/api. Pairs with API_SHARED_SECRET on that service.',
    withoutIt: 'No header is sent, which is correct as long as services/api has no API_SHARED_SECRET set either.',
    readAt: 'lib/hardware/proxy.ts:84',
  },
  {
    name: 'API_SHARED_SECRET',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Accepted as an alias for QUANTUM_API_SECRET, because a compose setup usually hands one variable to both services.',
    withoutIt: 'Same as above.',
    readAt: 'lib/hardware/proxy.ts:84',
  },
  {
    name: 'RESEND_API_KEY',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Real outbound email through Resend: org invites, certificates.',
    withoutIt: 'sendEmail returns { sent: false, reason } and prints the whole message to the server console in development, so the invite flow is testable end to end with no provider account.',
    readAt: 'lib/email/client.ts:12',
  },
  {
    name: 'EMAIL_FROM',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'The From address, on a domain verified in Resend.',
    withoutIt: "Falls back to Resend's sandbox sender, which only delivers to your own address.",
    readAt: 'lib/email/client.ts:19',
  },
  {
    name: 'NEXT_PUBLIC_SENTRY_DSN',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'All error tracking: both Sentry inits and the withSentryConfig build wrapper. One switch, no half-on state. (The instrumentation hook itself is always on, independent of this — see next.config.mjs — since it is also what runs this env check at startup.)',
    withoutIt: 'No Sentry code is loaded or bundled at all, and the build is faster. reportError logs to the console in development and does nothing in production.',
    readAt: 'sentry.client.config.ts:12, next.config.mjs:9',
  },
  {
    name: 'SENTRY_ORG',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Names the Sentry organisation for the build plugin.',
    withoutIt: 'Ignored — the plugin is not loaded without a DSN anyway.',
    readAt: 'next.config.mjs:27',
  },
  {
    name: 'SENTRY_PROJECT',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Names the Sentry project for the build plugin.',
    withoutIt: 'Ignored.',
    readAt: 'next.config.mjs:28',
  },
  {
    name: 'SENTRY_AUTH_TOKEN',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Source-map upload during next build, so stack traces are readable.',
    withoutIt: 'No upload is attempted and traces stay minified.',
    readAt: 'next.config.mjs:29',
  },
  {
    name: 'GOOGLE_SITE_VERIFICATION',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Emits the google-site-verification meta tag, which lets Google Search Console confirm domain ownership without a DNS or file upload and is a prerequisite for requesting indexing / seeing coverage data for a new domain.',
    withoutIt: 'No verification tag is rendered; Search Console ownership must be proven another way (DNS TXT record, or an uploaded HTML file) before the site can be added there.',
    readAt: 'app/layout.tsx:metadata.verification.google',
  },
  {
    name: 'BING_SITE_VERIFICATION',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Emits the msvalidate.01 meta tag, the same ownership proof for Bing Webmaster Tools (which also feeds Yahoo and, via IndexNow, DuckDuckGo).',
    withoutIt: 'No verification tag is rendered; Bing Webmaster Tools ownership must be proven another way.',
    readAt: 'app/layout.tsx:metadata.verification.other',
  },
  {
    name: 'NEXT_PUBLIC_ANALYTICS_ENDPOINT',
    requirement: 'optional',
    scope: 'build',
    unlocks: 'Ships the local-first analytics buffer to a collector. Also added to the CSP connect-src.',
    withoutIt: 'Analytics stay in the browser and are never transmitted, which is a defensible default.',
    readAt: 'lib/analytics/track.ts:52, lib/security/headers.ts:107',
  },
  {
    name: 'ANALYTICS_SUPABASE_TABLE',
    requirement: 'optional',
    scope: 'server',
    unlocks: 'Server-side analytics ingestion into that table. Needs Supabase configured too.',
    withoutIt: '/api/analytics accepts and validates batches, stores nothing, and says so in the response.',
    readAt: 'app/api/analytics/route.ts:32',
  },
] as const

/**
 * Combinations that cannot work.
 *
 * Each rule is "if any of `when` is set, all of `requires` must be set", and
 * an unmet rule is NOT a warning: it lands in `report.errors`, and
 * `assertEnv()` throws on any error (below) unless
 * `QUANTUM_LAB_SKIP_ENV_CHECK=1` is set. `instrumentation.ts` calls
 * `assertEnv()` at server startup, so every rule below is "the whole app
 * refuses to boot, every route 500s" — not a degraded feature. That crash is
 * deliberate: the misconfiguration each rule catches would otherwise fail
 * *silently* at the application-logic level (no exception, no 5xx, no log
 * line — see each `consequence` for what that silent failure would have
 * been), which is a worse failure mode than a loud boot-time refusal.
 *
 * Each `consequence` string names the boot crash AND that
 * would-have-been-silent failure. Learned to say so explicitly after getting
 * this wrong twice in the same production deploy: the second half of each
 * string used to describe ONLY the prevented silent failure, which reads
 * exactly like a soft degrade if you don't already know every rule here
 * throws.
 */
interface PairRule {
  readonly when: readonly string[]
  readonly requires: readonly string[]
  /** What actually goes wrong, in terms of what a user experiences. */
  readonly consequence: string
}

const PAIRS: readonly PairRule[] = [
  {
    when: ['STRIPE_SECRET_KEY'],
    requires: [
      'STRIPE_PRICE_PRO_MONTHLY',
      'STRIPE_PRICE_PRO_YEARLY',
      'STRIPE_PRICE_TEAM_MONTHLY',
      'STRIPE_PRICE_TEAM_YEARLY',
    ],
    consequence:
      'The app refuses to boot until all four are set. Prevents: plan resolution matching the price id on the Stripe subscription against these four names, where an unset one matches nothing, so the webhook falls through to the free plan for a customer who has just been charged, and existing subscribers are downgraded on their next renewal webhook — Stripe reports success and so do your logs, the only signal being support email.',
  },
  {
    when: ['STRIPE_SECRET_KEY'],
    requires: ['STRIPE_WEBHOOK_SECRET'],
    consequence:
      'The app refuses to boot until both are set. Prevents: every webhook failing signature verification with no signing secret, so payments never become plans — Stripe retries and then gives up, silently.',
  },
  {
    when: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    requires: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    consequence:
      'The app refuses to boot until both are set. Prevents: isSupabaseConfigured requiring both, so with only one set the app would silently stay in local-only mode while the operator believes accounts are on.',
  },
  {
    when: ['SUPABASE_SERVICE_ROLE_KEY'],
    requires: ['NEXT_PUBLIC_SUPABASE_URL'],
    // Both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are
    // build-time-baked client values ONLY unless the deployment also sets
    // them as literal runtime container env vars — isSet() here does a
    // DYNAMIC process.env[name] lookup, which Next.js cannot statically
    // inline the way it inlines a literal process.env.NEXT_PUBLIC_X
    // reference. infra/azure/deploy.sh now sets both explicitly at runtime
    // for exactly this reason (see the comment next to
    // NEXT_PUBLIC_SUPABASE_URL there) — if you deploy this app some other
    // way, you need to do the same, or the first build with a real
    // SUPABASE_SERVICE_ROLE_KEY takes the whole app down at boot even though
    // the URL is right there in the client bundle.
    consequence:
      'The app refuses to boot until NEXT_PUBLIC_SUPABASE_URL is ALSO present in the server process\'s actual runtime environment (not just baked into the client build — see the comment above). Prevents: a service-role client with no project URL to connect to, so entitlement lookups would silently return the free plan.',
  },
  {
    when: ['ANALYTICS_SUPABASE_TABLE'],
    requires: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    // CORRECTED: this used to say "ingestion is switched on with nowhere to
    // write, so /api/analytics reports success and stores nothing" — a soft
    // degrade. That is what happens if this rule is merely a WARNING. It is
    // not: an unmet PAIRS rule lands in `report.errors`, and assertEnv()
    // THROWS on any error (see below) unless QUANTUM_LAB_SKIP_ENV_CHECK=1 is
    // set. instrumentation.ts calls assertEnv() at server startup, so this
    // is not a degraded analytics feature — it is the entire app refusing to
    // boot, on every route, until the pair is fixed. Confirmed the hard way:
    // setting ANALYTICS_SUPABASE_TABLE alone (SUPABASE_SERVICE_ROLE_KEY still
    // blank) took qubit16.ai down with 500s everywhere, /api/health included.
    consequence:
      'The app REFUSES TO START — assertEnv() throws at boot and every route 500s, including /api/health — until both are set or ANALYTICS_SUPABASE_TABLE is cleared. This is not a soft degrade.',
  },
]

/** A variable that must never exist, and why. */
const FORBIDDEN: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
    why: 'Every NEXT_PUBLIC_ name is inlined into the client bundle, so this publishes a key that bypasses row-level security to every visitor. Rename it to SUPABASE_SERVICE_ROLE_KEY and rotate the key — it has been served to browsers.',
  },
  {
    name: 'NEXT_PUBLIC_STRIPE_SECRET_KEY',
    why: 'Same mechanism: this ships a live Stripe secret key to every visitor. Rotate it in the Stripe dashboard immediately.',
  },
  {
    name: 'NEXT_PUBLIC_ANTHROPIC_API_KEY',
    why: 'Same mechanism: anyone loading a page can read the key and spend your Anthropic budget. Rotate it.',
  },
  {
    name: 'NEXT_PUBLIC_QUANTUM_API_SECRET',
    why: 'A secret a browser holds is not a secret; the shared-secret gate on services/api becomes decoration. Use QUANTUM_API_SECRET, which stays server-side.',
  },
]

/** The outcome of a check. Errors abort startup; warnings never do. */
export interface EnvReport {
  readonly errors: string[]
  readonly warnings: string[]
  /** Names that are set, for a one-line "what is on" summary. */
  readonly configured: string[]
}

function isSet(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0
}

/**
 * Inspect the current environment without throwing or logging.
 *
 * Exported separately from `assertEnv` so a route, a test or a future health
 * endpoint can ask the same question without the side effects.
 */
export function checkEnv(): EnvReport {
  const errors: string[] = []
  const warnings: string[] = []
  const configured: string[] = []

  for (const v of ENV_VARS) {
    if (isSet(v.name)) {
      configured.push(v.name)
    } else if (v.requirement === 'required') {
      // Unreachable today — the list holds no required entries, on purpose.
      // Kept because the moment one is added this is the behaviour wanted.
      errors.push(`${v.name} is REQUIRED and is not set. ${v.withoutIt}`)
    }
  }

  for (const { name, why } of FORBIDDEN) {
    if (isSet(name)) errors.push(`${name} must not exist. ${why}`)
  }

  for (const rule of PAIRS) {
    if (!rule.when.some(isSet)) continue
    const missing = rule.requires.filter((n) => !isSet(n))
    if (missing.length === 0) continue
    errors.push(
      `${rule.when.filter(isSet).join(', ')} is set but ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not. ${rule.consequence}`
    )
  }

  // Not a pair rule, because it is about the *value* rather than presence, and
  // only matters in production. localhost in a canonical tag or a Stripe return
  // URL is the single most common silent production fault in this project.
  if (process.env.NODE_ENV === 'production') {
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()
    if (!appUrl) {
      warnings.push(
        'NEXT_PUBLIC_APP_URL is not set, so canonical URLs, the sitemap, OG images and Stripe return URLs all point at http://localhost:3000. It is inlined at build time, so setting it in a dashboard without rebuilding changes nothing.'
      )
    } else if (appUrl.includes('localhost') || appUrl.startsWith('http://')) {
      warnings.push(
        `NEXT_PUBLIC_APP_URL is "${appUrl}" in a production build. Stripe will redirect paying customers there.`
      )
    }
  }

  return { errors, warnings, configured }
}

let alreadyRan = false

/**
 * Run the check at startup: throw on an error, log warnings, and say nothing
 * else. Idempotent — the Next server may evaluate a module more than once per
 * process and an operator should not read the same list four times.
 *
 * Set `QUANTUM_LAB_SKIP_ENV_CHECK=1` to downgrade every error to a warning.
 * That escape hatch exists for one situation: a production incident where the
 * check is the thing keeping you from booting. Use it, then fix the config.
 */
export function assertEnv(): EnvReport {
  const report = checkEnv()
  if (alreadyRan) return report
  alreadyRan = true

  const skip = (process.env.QUANTUM_LAB_SKIP_ENV_CHECK ?? '').trim() === '1'

  for (const w of report.warnings) console.warn(`[env] WARN  ${w}`)

  if (report.errors.length > 0) {
    for (const e of report.errors) console.error(`[env] ERROR ${e}`)
    if (!skip) {
      throw new Error(
        `Environment is misconfigured (${report.errors.length} error${
          report.errors.length === 1 ? '' : 's'
        }, listed above). Every one of these fails silently at run time, which is why this refuses to start instead. See docs/DEPLOYMENT.md § "Environment variables". To boot anyway during an incident: QUANTUM_LAB_SKIP_ENV_CHECK=1`
      )
    }
    console.error('[env] QUANTUM_LAB_SKIP_ENV_CHECK=1 is set, so the errors above are not fatal.')
  }

  return report
}
