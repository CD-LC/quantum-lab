# Quantum Lab — Security Audit

**Date:** 2026-08-17 · **Scope:** the whole repository (282 files, 56 routes, 10 API
route handlers in `apps/web/app/api`, `services/api`, `services/agent`).
**Prior reviews:** none. This is the first.

Line numbers refer to the code **as it was before this audit** (`git show HEAD:<file>`),
because that is the code the findings describe.

---

## 1. Threat model

### What this application actually holds

| Asset | Where it lives | Why an attacker would want it |
|---|---|---|
| Course progress, quiz and exam scores | the learner's browser (`localStorage`), optionally Supabase | low value; embarrassing to lose, not damaging |
| Saved circuits (OpenQASM text) | `localStorage`, optionally `public.circuits` | low value; a learner's own work |
| **Subscription state** — plan, status, renewal date, Stripe customer id | `public.subscriptions`, written only by the Stripe webhook | reveals who pays and how much; the Stripe **customer id is a capability** — see BILL‑1 |
| **Org membership** — colleague email addresses, roles, seat counts | `public.org_members`, or `localStorage` in demo mode | a ready-made corporate email list; role changes are privilege changes |
| An email address per user | Supabase Auth | the only personal data of consequence in the system |
| **Money-spending capability** | `ANTHROPIC_API_KEY` (tutor), IBM/Braket credentials (hardware jobs), `RESEND_API_KEY` (mail), the Stripe secret key | direct financial loss and reputational loss via the sending domain |
| **Other people's money-spending capability** — users' own IBM tokens (BYOK) | `public.user_provider_credentials`, AES-256-GCM sealed | the highest-value row in the database, and the only **recoverable** secret here: every other credential this app stores is hashed. See below |

### What it does not hold

* **No payment details.** Card numbers, expiry, CVC and billing addresses live at Stripe.
  This app stores a `stripe_customer_id` and never touches a PAN. That removes the
  single largest class of breach from the picture — and makes BILL‑1 (which hands an
  attacker a session *at* Stripe) the most serious finding in this report.
* **No PII beyond an email address.** No name, no address, no phone, no date of birth.
* **No sensitive category data.** No health, financial, biometric or government-id data.
* **No user-to-user content.** Nothing one learner writes is shown to another, which
  removes stored-XSS-between-users as a category entirely.

### The one recoverable secret: BYOK (added 2026‑09‑17)

Every other credential this application stores is **hashed** — an API key, a
session — so the table is worthless to whoever reads it. A user's own IBM token
cannot be, because the whole point is to present it to IBM on their behalf. It
is therefore the one asset here that is *encrypted* rather than one-way, and it
deserves naming rather than filing under "credentials".

What that means, stated without softening:

* A database dump yields ciphertext. The key (`SETTINGS_ENCRYPTION_KEY`) lives
  only in the web app's environment, so reading the table is not enough.
* **Anything that can run code in the web app's process can open it.** That
  process has to, in order to do its job. There is no arrangement in which this
  is not true, and `docs/BYOK.md` says so to users in those words rather than
  implying a stronger guarantee.
* The blast radius of one compromised token is *that user's* IBM allowance and
  visibility of *that user's* jobs — not the platform's vendor accounts, and
  not other users. That is strictly better than the pre-BYOK world, where every
  hardware job spent one shared operator credential.

The controls, all of which are load-bearing and covered by tests:

* `/api/credentials` accepts a **session token only**. An API key cannot
  install, replace or read a vendor credential — otherwise a leaked CI key
  could attach the attacker's IBM token to the victim's account and harvest
  every job they run.
* Nothing reads a token back out to a client. The listing type has no field
  for one.
* In `services/api`, a presented token is **never written into the global
  `settings`** object, and the authenticated-service cache is keyed on the
  token itself — so one user's authenticated session cannot be handed to
  another user's request. `services/api/tests/test_byok.py` asserts both.
* The token crosses the internal hop as a header, never a query parameter, so
  it does not reach access logs; `IbmCredentials.__repr__` omits it so it does
  not reach a traceback.

### Adversaries considered

1. **An anonymous internet caller with `curl`.** The dominant threat: every route below
   is reachable without a session, and most of the findings are exactly this.
2. **A logged-in free-tier user** trying to reach paid capability or another tenant's data.
3. **A cost attacker** who does not want data at all, only to spend the operator's money
   (LLM tokens, hardware shots, mail quota) or to exhaust a process.
4. **A prompt injector** who controls text that reaches a tool-calling LLM.

Explicitly **out of scope**: a compromised Stripe account, a malicious Supabase operator,
supply-chain compromise of npm/PyPI, and physical/host access.

---

## 2. Findings

Severity: **critical** = unauthenticated compromise of another user's account or money ·
**high** = unauthenticated data disclosure, mutation, or resource/financial abuse ·
**medium** = requires unusual conditions or has bounded impact · **low** = hardening.

| # | Sev | File · line (pre-fix) | What an attacker could actually do | Status |
|---|---|---|---|---|
| BILL‑1 | **critical** | `apps/web/app/api/billing/portal/route.ts:36` | POST `{"userId":"<any uuid>"}` with **no credential** and receive a Stripe Customer Portal URL for that person: their invoices (with billing name and address), their saved card, "update payment method", and "cancel subscription". User ids are not secrets. | **fixed** |
| ORG‑1 | **high** | `apps/web/app/api/orgs/members/route.ts:50,72,128,186`; `apps/web/app/api/orgs/invite/route.ts:60`; `apps/web/app/api/orgs/route.ts:49` | Anonymous seat management on any org whose id you know: `POST {orgId, email, role:"owner", status:"active"}` adds *yourself* as an owner; `PATCH` demotes the real owner; `DELETE` removes members; `GET ?orgId=` dumps every colleague's email. `POST /invite` burns a paid seat **and** sends mail. No credential of any kind was checked anywhere in these three files. | **fixed** (authentication + per-org role checks; see §3) |
| MAIL‑1 | **high** | `apps/web/app/api/email/route.ts:95,107` | The file header argues a closed template set makes the endpoint safe. It does not: `acceptUrl`/`url` are caller-supplied and land behind the "Sign in"/"Accept invitation" button. Anyone could send *"Sign in to Quantum Lab"* to any address, **from Quantum Lab's own verified domain**, pointing at a credential-harvesting page — SPF/DKIM-aligned phishing no filter will catch. Escaping did not help: an escaped `javascript:` href still works. | **fixed** |
| BILL‑2 | **high** | `apps/web/app/api/billing/entitlement/route.ts:64` | `GET ?userId=<anyone>` returned that user's plan, subscription status, renewal date, cancellation flag and hardware-job usage to an anonymous caller — a working subscription-state oracle for any id ever seen in a share link, an org member list, or a Stripe `client_reference_id`. | **fixed** |
| PY‑1 | **high** | `services/api/app/quantum/runner.py:380` (cap) vs `:379` (parse) | The qubit cap ran **after** `parse_qasm()`. Measured on this machine: the ~50-byte body `qreg q[3000000];` made Qiskit allocate **669 MB** and burn **5.6 s** of CPU before the check was reached; cost is linear in the declared width, so a slightly larger literal OOM-kills the process. QASM length was unbounded too. Unauthenticated, no rate limit. | **fixed** |
| AGENT‑1 | **high** | `apps/web/app/api/agent/route.ts:328` | Unauthenticated proxy to a **metered** LLM with no rate limit, no message-count cap, no per-message length cap and no body-size cap. A single loop bills the operator's Anthropic account indefinitely. | **fixed** |
| RATE‑1 | **high** | `/api/agent`, `/api/analytics`, `/api/billing/*`, `/api/orgs/*` | Only `/api/email` had any limiter at all. Everything else was uncapped, including the two endpoints that spend money (`agent`, `checkout`) and the one that writes to the database (`analytics`). | **fixed** (advisory only — see §4) |
| INJ‑1 | **high** | `services/agent/agent/tools.py:106`; `agent/core.py:93`; `agent/prompts.py:97`; `apps/web/app/api/agent/route.ts:121` | Prompt injection with a real blast radius: `run_quantum_circuit` did `shots = max(1, int(shots))` with **no upper bound**, the tool loop had no wall-clock bound, history and total conversation size were unbounded, and retrieved text (course excerpts, arXiv abstracts) and the learner's own circuit were pasted into the prompt behind a closable ``` fence. | **fixed** (clamps + fencing; see §3) |
| VAL‑1 | **medium** | every route handler | Unbounded strings and arrays throughout: `messages`, `circuitQasm`, `orgName`, `name`, invite `token`, `userId`. `req.json()` was called on unbounded bodies in 7 handlers. `userId` went into database filters with no shape check. | **fixed** |
| LEAK‑1 | **medium** | `checkout/route.ts:117`, `portal/route.ts:96`, `analytics/route.ts:311` | Error responses echoed provider messages verbatim: Stripe errors (account mode, request id, which price env var is misconfigured) and PostgREST errors (table name, column name, failing policy) — a free schema and config map for an anonymous caller. `checkout` even carried the comment *"Never leak a Stripe stack trace"* directly above the code that returned `err.message`. | **fixed** |
| PY‑2 | **medium** | `services/api/app/routers/hardware.py:87,137` | `shots: int = Field(1024, ge=1)` — no upper bound on `/estimate`; `/submit`'s bound was checked in the handler but not in the schema. `/submit` spends real money on IBM/Braket and is unauthenticated. | **partly fixed** |
| HDR‑1 | **medium** | *(absent)* `apps/web/middleware.ts` | No security headers on any non-Vercel deployment (`next start`, the Dockerfile, docker-compose): no CSP anywhere at all, on any target. `vercel.json` set four headers and only on Vercel. | **fixed** |
| INV‑1 | **medium** | `apps/web/lib/orgs/invites.ts:451` | Invite tokens are deterministic, reversible and checksummed with djb2 — anyone can forge one for any org/email pair, and the browser acceptance path decoded the org and email straight out of the link. | **fixed** (random, hashed, expiring, single-use; see §3) |
| ORG‑2 | **medium** | `apps/web/lib/orgs/store.ts:312` | The store resolves identity via `getSupabase().auth.getSession()` — the **browser** client. In a route handler that is always `null`, so every server-side org read falls through to `readLocal()`, which returns an empty database on the server. Consequence: the org API was inert server-side, which is the only reason ORG‑1 was not immediately exploitable against a live database. It is a latent bug, not a control. | **fixed** (explicit server context; see §3) |
| CORS‑1 | **low** | `services/api/app/main.py:26`, `services/agent/agent/server.py:35` | **Was not wide open**, but three wildcards sat behind `allow_credentials=True`: `ALLOWED_ORIGINS=*` was accepted, and both services paired `allow_methods=["*"]` with `allow_headers=["*"]`. The agent service hard-coded `http://localhost:3000`, so a deployed operator had no correct value to set. | **fixed** (wildcard refused at startup, explicit method/header sets; see §3) |
| PROXY‑1 | **critical** | `apps/web/app/api/hardware/submit/route.ts` (as first shipped) | **A regression introduced by the fix for PY‑3.** The Next proxy attaches `X-Quantum-Lab-Secret` to every upstream call, and the submit route checked only an IP rate limit — no identity, no entitlement, no quota. So `curl -X POST https://<host>/api/hardware/submit -d '{"qasm":"…","backend":"ibm_brisbane","shots":20000}'` from a signed-out client was accepted, the server added the operator's secret, and IBM billed the operator. 5/min per address, from as many addresses as the caller cared to rent. Enabling the control this document recommends (`API_SHARED_SECRET`) previously returned 401 for browser traffic and therefore *closed* the endpoint that spends money; after the proxy it stopped protecting it at all. The enforcement layer (`requireFeature`, `assertHardwareQuota`, `recordHardwareJob`) existed the whole time with **zero callers**; every `hasFeature`/`UpgradeGate` call site was a `'use client'` component, i.e. cosmetic. | **fixed** (sign-in + entitlement + fail-closed monthly quota; see §3 and docs/HARDWARE.md) |
| JOB‑1 | **high** | `apps/web/app/api/hardware/job/[provider]/[...jobId]/route.ts` (as first shipped) | Anyone holding a job id could read that job's status **and measurement results**, anonymously, with the operator's shared secret attached upstream to make it work. Ids are high-entropy so this is not enumerable, but they leak through screenshots, logs, copied URLs and support threads. | **fixed** (jobs are bound to the submitting account; see docs/HARDWARE.md §3a) |
| HEALTH‑1 | **medium** | `apps/web/app/api/health/route.ts` (as first shipped) | Unauthenticated, unrate-limited, and performing a live Supabase HEAD count plus two upstream fetches **per request** — one cheap anonymous request amplified into three expensive requests against our own dependencies, at any rate the caller liked. | **fixed** (rate-limited; the expensive probes are opt-in via `?deep=1`, optionally behind `HEALTH_DEEP_TOKEN`) |
| PY‑3 | **low** | `services/api/app/routers/hardware.py:226` | `/api/hardware/submit` spends real IBM/Braket credits and is unauthenticated. Acceptable only because the service is meant to sit on a private network; nothing in the repo enforces that. | **accepted risk, with an opt-in lock** (see §3 and §4) |

### Checked and found clean

These were audited specifically and are **not** findings — recorded so the next reviewer
does not repeat the work:

* **Stripe webhook** (`billing/webhook/route.ts`) — **correct.** Raw body read with
  `req.text()` before any parsing, signature verified with
  `stripe.webhooks.constructEvent(rawBody, signature, secret)`, failure returns 400 with
  no detail. Missing `STRIPE_WEBHOOK_SECRET` returns "not configured" and processes
  nothing. There is **no path where an unverified event mutates a subscription**: every
  `upsertSubscription` call sits downstream of `constructEvent`. Retry semantics are right
  (500 for a database failure, 200 for an unusable-but-verified event). The one soft spot
  is `session.metadata.planId` being cast to `PlanId` without validation — reachable only
  by someone who can already create sessions on your Stripe account, and bounded by
  `toPlanId()` on read.
* **XSS** — `dangerouslySetInnerHTML` appears **zero** times in the repository.
  `components/tutor/MessageBubble.tsx` renders LLM output by splitting on triple-backtick
  fences into React `<p>` and `<pre>` **text nodes**; `components/instructor/CoPilotPanel.tsx`
  renders the same way. No `innerHTML`, no `eval`, no `new Function`, no `srcDoc`.
  Email templates escape every interpolation through `esc()`.
* **Secret leakage** — the only `NEXT_PUBLIC_*` variables are `API_URL`, `APP_URL`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SENTRY_DSN`, `ANALYTICS_ENDPOINT`. All six are
  legitimately public (the Supabase anon key is designed to be, provided RLS is on — see
  the checklist). No file marked `'use client'` reads any server-only variable, and no
  client component imports `lib/billing/entitlements.ts`, `lib/billing/stripe.ts` or
  `lib/email/client.ts`. `SUPABASE_SERVICE_ROLE_KEY` is read only from server modules.
* **SSRF** — all three suspects are safe. `/api/agent` forwards to `AGENT_SERVICE_URL`
  and `lib/hardware/client.ts` to `NEXT_PUBLIC_API_URL`: both are **operator-set
  environment variables**, and only the *path* is fixed by code — a user cannot steer
  either. `services/agent/agent/arxiv.py` builds `f"{ARXIV_API_URL}?{urlencode(params)}"`
  from a **constant host**, with the user-supplied identifier only ever landing inside an
  encoded query parameter, so `_identifier_kind()` returning `"query"` for junk input is
  not a hole. `follow_redirects=True` means arxiv.org could redirect the client somewhere
  else, but only arxiv.org can, and the response is parsed as XML and never re-fetched.
* **`isServiceRoleConfigured` / degradation** — every optional integration (Supabase,
  Stripe, Resend, Sentry, Anthropic, IBM, Braket) genuinely no-ops when unset. Verified by
  building and serving with an empty environment.

---

## 3. What was fixed, and how

### New files

* **`apps/web/lib/security/headers.ts`** — one source of truth for every security header,
  with the CSP built as a `Record<directive, sources[]>` and serialised once. Also carries
  the two arguments that matter: why the four headers here are byte-identical to
  `vercel.json`'s (and which wins if they ever diverge — vercel.json does, because the edge
  network applies it after the function returns), and why there is **no script nonce**.
* **`apps/web/lib/security/ratelimit.ts`** — `check(key, limit, windowMs)` →
  `{ allowed, remaining, resetAt }`, plus `clientKey(headers, prefix)` and `retryHeaders()`.
  The per-instance caveat is stated in a banner comment, not a footnote.
* **`apps/web/lib/security/validate.ts`** — `str`, `optionalStr`, `int` (rejects NaN and
  ±Infinity), `arr`, `oneOf`, `uuid`, `email`, `httpUrl`, `safeJson(text, maxBytes)`,
  `isRecord`. Every one returns `{ok:true,value} | {ok:false,error}` so a handler can
  answer 400 with a specific message instead of catching an exception.
* **`apps/web/middleware.ts`** — applies the headers to every page and API response;
  matcher skips `_next/static`, `_next/image`, and the static metadata files. No auth
  logic (see the file header for why).

*Added in the follow-up pass that closed checklist item 2 and finished ORG‑1:*

* **`apps/web/lib/security/auth.ts`** — `verifiedCallerId(req)`, `bearerToken(req)` and
  `signInRequiredResponse()`. This is the audit's own mechanism, unchanged, lifted out of
  the four byte-identical private copies in `billing/portal`, `billing/entitlement`,
  `orgs` and `orgs/members` so there is one implementation to read and to fix. Identity
  comes from `supabase.auth.getUser(token)` and from nothing else; a `userId` in a body or
  a query string is a claim, never a credential.
* **`apps/web/lib/authFetch.ts`** — the client half. `authFetch(input, init)` and
  `authHeaders()` read the browser session and attach
  `Authorization: Bearer <session.access_token>`. Signed out, or Supabase unconfigured,
  the header is simply absent and the request goes out anonymously, exactly as before. An
  `authorization` header the caller set explicitly is never overwritten.
* **`apps/web/lib/orgs/access.ts`** — the per-org authorisation gate:
  `requireOrgRole(req, orgId, allowed)` and `ownerOnlyDenied(...)`. It reads the caller's
  `public.org_members` row **server-side**, which `lib/orgs/store.ts` cannot do (ORG‑2),
  using the service-role client when configured and otherwise an anon client carrying the
  caller's own token so RLS evaluates the read as that user. Every failure — no token, no
  row, a query error, no usable client — denies. One 403 sentence for "not a member",
  "wrong role" and "no such org", so the error is not a membership oracle.

*Added in the third pass, which closed INJ‑1, ORG‑2, INV‑1, CORS‑1 and the RLS
half of ORG‑1:*

* **`apps/web/app/api/orgs/invite/accept/route.ts`** — the invite-acceptance
  path, which did not previously exist server-side at all: acceptance happened
  in the browser, from data decoded out of the link. Checks, in order: the
  token resolves to a stored row; the row is unaccepted and unexpired; the
  caller is signed in; the caller's **Supabase-verified email** is the invited
  one; the invite is burned with a conditional update before the seat is
  written. The org and the role come from the row, never from the request.
* **`services/api/app/core/security.py`** — the opt-in shared-secret gate for
  `services/api`. Unset (the default) it does nothing at all; set, every request
  outside `/api/health` must carry `X-Quantum-Lab-Secret`, compared with
  `hmac.compare_digest`. See §4 for what an operator must do around it.

*Added in the fourth pass, which closed checklist items 4 and 5's code half:*

* **`apps/web/lib/rateLimit.ts`** — the shared-store limiter that replaces
  `lib/security/ratelimit.ts` on the expensive routes. `rateLimit(key, rule)` →
  `{allowed, remaining, resetAt, store}`, plus `callerKey(headers, prefix, subject?)`
  and `retryAfterHeaders()`. Counts in Upstash/Vercel-KV Redis over its REST API
  when `UPSTASH_REDIS_REST_URL`+`_TOKEN` or `KV_REST_API_URL`+`_TOKEN` are set —
  plain `fetch`, no new dependency — and falls back to an in-process map
  otherwise, with a startup `console.warn` that says in those words that the
  store does not survive a deploy and does not span instances. **Supabase was
  not used** even though the project has it: an atomic counter needs a table and
  a `security definer` function in `supabase/schema*.sql`, and none of that SQL
  has ever been run against a live project (see "Could not be verified" below).
  Wired into `/api/agent`, `/api/email`, `/api/billing/checkout`,
  `/api/billing/portal` and every route under `/api/hardware`.
* **`apps/web/lib/hardware/proxy.ts` + `apps/web/app/api/hardware/**`** — the
  server-side proxy that lets the shared secret be switched on. Five route
  files, one per endpoint the app actually calls, each validating the request
  shape before forwarding. Deliberately not a `[...path]` catch-all: that would
  republish `/api/circuits/run` through the Next server. Full detail, including
  what is still unproxied, is in **docs/HARDWARE.md**.

### Route fixes

* **BILL‑1** — `portal/route.ts` now derives the caller from a **Supabase-verified access
  token** (`auth.getUser(token)`) and refuses any `userId` that is not the caller's own:
  401 with no token, 403 on mismatch. The check runs only when Supabase is configured —
  with an empty environment the handler has already returned `configured:false`, so the
  zero-config path is byte-identical to before.
* **BILL‑2** — `entitlement/route.ts` shape-checks `userId` as a UUID and, when Supabase
  is configured, requires a token matching it. A mismatch returns the **free-tier payload**
  (with `x-entitlement-authenticated: false`) rather than 403, so the endpoint neither
  confirms nor denies that an id exists and the UI keeps its documented "always 200"
  contract.
* **ORG‑1** — all of `POST/PATCH/DELETE /api/orgs/members`, `GET /api/orgs/members`,
  `POST /api/orgs/invite` and `POST /api/orgs` require a verified token when Supabase is
  configured; `POST /api/orgs` additionally requires `ownerId` to *be* the caller.
  **The authorisation half is now done too** (this was the "partly fixed" part). Every
  handler that names an org calls `requireOrgRole` after authenticating, and the role
  model is:

  | Action | Required role in *that* org |
  |---|---|
  | `GET /api/orgs/members` (reads every colleague's email) | owner, admin or member — an **active** seat |
  | `POST /api/orgs/members`, `PATCH`, `DELETE` | owner or admin |
  | `POST /api/orgs/invite` (holds a seat, sends mail) | owner or admin |
  | granting the `owner` role, or modifying/removing an existing owner | **owner only** |
  | `GET /api/orgs?userId=` | the caller's own id only — a mismatched `?userId=` is 403 |
  | `POST /api/orgs` | `ownerId` must be the caller (unchanged) |

  A suspended seat is a revoked seat: it may neither read nor manage, whatever its role.
  A caller who is authenticated but not a member of the target org cannot read it or write
  it at all — the "signed-in free-tier user adds themselves as owner of someone else's
  org" attack from §4 now returns 403 before any store call happens. An admin cannot
  promote themselves to owner, which would otherwise be a one-request escalation.
  Covered by `apps/web/lib/orgs/access.test.ts` (16 tests through the real handlers).
* **MAIL‑1** — every caller-supplied link in `/api/email` goes through
  `httpUrl(value, 2048, allowedHosts)`, where the allow-list is
  `NEXT_PUBLIC_APP_URL` + the request's own origin. Off-site links, and `javascript:`/
  `data:` schemes, are refused with a 400 that names the field. Free-text template fields
  are length-capped.
* **AGENT‑1 / RATE‑1** — `/api/agent` gained a 12/min limiter, a 512 KB body cap, 40
  messages, 8 000 chars per message, 20 000 chars of attached QASM (long content is
  truncated rather than rejected, so a learner who pastes a wall of text still gets an
  answer). `GET /api/agent` is limited too, because each call makes an outbound request.
  Limiters added to `analytics` (30/min), `checkout` (10/min), `portal` (10/min),
  `entitlement` (60/min), `orgs` (30/min), `orgs/invite` (5/min).
* **VAL‑1** — `req.json()` replaced with `safeJson(await req.text(), maxBytes)` in seven
  handlers; ids bounded and shape-checked; the invite `token` bounded to 512 chars before
  it reaches the four-chars-at-a-time hex decoder.
* **LEAK‑1** — provider error messages now go to `console.error` and a fixed string goes
  to the client, in `checkout`, `portal` and `analytics`.
* **PY‑1** — new `guard_qasm()` in `services/api/app/routers/circuits.py`, applied at the
  top of `/circuits/run`, `/circuits/statevector`, `/hardware/analyse`, `/hardware/estimate`,
  `/hardware/transpile`, `/hardware/submit` and `/jobs`. It caps the source at 128 KiB
  (413) and regex-scans for `qreg q[N]` / `qubit[N]` declarations exceeding
  `settings.max_qubits` (400) **before any parser is invoked**. It is a floor, not a
  replacement: the existing per-backend post-parse check still runs and still owns the
  exact limit.

  Measured, same payload, same machine:

  | | before | after |
  |---|---|---|
  | `qreg q[3000000]` | 669 MB, 5.6 s, then a 400 | **400 in 28 ms**, no allocation |
  | 200 000-char body | parsed | **413** |
  | a real Bell circuit | 200 | **200, unchanged** |

* **PY‑2** — `le=20_000` added to the `shots` field on `EstimateRequest` and
  `SubmitRequest`, so an out-of-range value is a 422 before any work starts.

* **INJ‑1 — the clamps, and the fence.** The honest framing has not changed:
  *"the model can be talked into saying the wrong thing" is not solvable.* What
  is solvable is how much an injected instruction can **spend**, and whether a
  document can pass itself off as an instruction at all. Both are now done.

  **Bounds on what one request may spend** — all of them settings in
  `services/agent/agent/config.py`, so an operator can tighten them without a
  deploy:

  | | Before | After | Where |
  |---|---|---|---|
  | Tool-invocation rounds | 6, hard-coded | `max_tool_rounds` (6), `early_stopping_method="force"` | `agent/core.py` |
  | Wall clock per run | **unbounded** — one local Aer simulation is one round | `max_agent_seconds` (60) | `agent/core.py` |
  | `run_quantum_circuit(shots=)` | **unbounded** (`max(1, int(shots))`) | `max_shots` (20 000) | `agent/tools.py` |
  | History turns | unbounded | `max_history_turns` (20) | `agent/core.py`, `agent/server.py` |
  | Characters per turn | unbounded | `max_message_chars` (8 000) | both |
  | **Total** conversation characters | 40 × 8 000 = **320 000** | 24 000 | `app/api/agent/route.ts` |
  | Reply tokens | 1 024 | 1 024, named and commented | `app/api/agent/route.ts` |

  The shots clamp is the one with a measurable blast radius: the execution API
  rejects an absurd count, the tool **swallows that error and falls back to a
  local Aer simulation at the requested count**, so `"run this with 500000000
  shots"` — a sentence anyone can type — was an unbounded CPU burn inside the
  agent process. `clamp_shots()` bounds it before either path is taken.

  The total-character budget is the other one worth naming: the per-message and
  per-array caps added in the previous pass are each reasonable and their
  product was not.

  **Retrieved context is fenced and labelled.** Four things reach the model that
  it did not write: the learner's question, the QASM in their editor, course
  excerpts from the RAG index (`search_concepts`), and an arXiv abstract
  (`fetch_arxiv_paper` — the one tool that touches the open internet). The
  circuit used to be pasted in behind a plain ``` fence, which a QASM "comment"
  can simply close; the retrieved text was not marked at all.

  Now each arrives inside long, specific markers, under a standing instruction
  that says what it is and what not to do with it, **and every occurrence of the
  markers is stripped from the payload before interpolation**, so the block
  cannot be closed from the inside. That last part is the mechanism; a delimiter
  a document can close is decoration.

  | Content | Fence | Where |
  |---|---|---|
  | Learner circuit (web tier) | `<<<UNTRUSTED_LEARNER_DATA>>>` | `app/api/agent/route.ts` |
  | Learner circuit (agent tier) | same markers | `agent/prompts.py` |
  | Course excerpts, arXiv abstract | `<<<REFERENCE_MATERIAL>>>` | `agent/tools.py` |

  The system prompt gained rule 7, which is the standing instruction the fences
  refer back to: instructions come from the prompt, never from content; and the
  tutor is told explicitly that it has no knowledge of and no tool that can
  reach anyone's account, billing or credentials — so the "your subscription
  has expired, re-enter your card" injection would have the model asserting
  something it has just been told is false.

  The arXiv **title** is marker-stripped but not fenced: it is one line, it is
  quoted constantly, and wrapping every title in a paragraph of standing
  instructions would make the tool unusable. The fenced abstract's preamble
  names the whole retrieved record.

  Tests: `apps/web/lib/security/agentClamps.test.ts` (7, through the real route,
  including a circuit that tries to close the fence) and
  `services/agent/tests/test_injection_clamps.py` (17).

* **ORG‑2 — the store is told who is calling.** `lib/orgs/store.ts` now takes an
  optional trailing `ctx: OrgContext` — `{ userId, client }`, already verified.

  Without it the behaviour is byte-identical to before: the browser session, or
  `readLocal()`. With it the store uses the caller and the client it was handed
  and asks a browser nothing. The context is built by `orgContext(req, callerId)`
  in **`lib/orgs/access.ts`**, from the same `membershipClient()` that already
  answers "is this caller an owner of this org?" — one mechanism, not two, as
  required. `requireOrgRole` returns it on the `ok` path, so a handler cannot
  hold a working client for an org it was refused.

  Three properties fall out of it, and each has a test:

  * **A `userId` in a request still selects nothing.** `listOrgs(userId, ctx)`
    ignores the argument entirely when a context is present and queries the
    verified caller. `createOrg` writes `owner_id` as the verified caller, not
    as the supplied `ownerId`.
  * **No silent local fallback on the server.** A failed remote read returns
    empty and a failed remote *write* throws, rather than writing to a
    `localStorage` that does not exist and reporting success.
  * **`storageMode()`'s cache is only touched on the browser path** — a
    per-process boolean set by whichever request ran last is meaningless on a
    server and would leak one request's state into another's render.

  Every handler in `/api/orgs`, `/api/orgs/members` and `/api/orgs/invite` now
  passes the context. Tests: `apps/web/lib/orgs/store.test.ts` (6, run in
  vitest's `node` environment — no `window`, no `localStorage`, i.e. exactly the
  conditions a route handler runs in).

* **INV‑1 — invite tokens.** **Chosen: a 32-byte cryptographically random token,
  stored only as its SHA-256, with an expiry and single use.** The audit's other
  option was an HMAC over `(org, email, expiry)` with a server secret. It was
  not taken, and the reasoning is in the header of `lib/orgs/invites.ts`:

  1. **Single use is the property that matters most here.** An invite link
     travels by email, gets forwarded, is logged by mail scanners and pasted
     into chat. A stateless HMAC is replayable by everyone who ever sees it
     until it expires. Making it single-use needs a row to burn — and once the
     row exists, the HMAC has bought nothing.
  2. **An HMAC needs a server secret**, and this app runs with an empty
     environment by design. A scheme that is secure only when an optional
     variable happens to be set is the exact failure mode this audit keeps
     finding.
  3. `public.org_invites` already exists and already has `accepted_at`.

  What changed, concretely:

  * `makeInviteToken` / `parseInvite` / `inviteFromToken` / `inviteIssuedAt` /
    `inviteExpiryFromToken` are **gone**. They could not survive: the token no
    longer encodes anything, so there is nothing to decode — and
    `inviteFromToken`, which rebuilt a whole invite from a token when no row
    existed, *was* the vulnerability. No row now means no invite.
  * The column is `org_invites.token_hash`, not `token`. A dump of the table
    contains no usable link, and the raw token never reaches a query, a query
    log or a slow-query report.
  * The expiry is read from the **stored row**, never from the link.
  * `markInviteAccepted` burns the row with `... .eq(id).is('accepted_at', null)`
    and reports whether *this* call won, so two requests racing on one link
    cannot both take a seat. A read-then-write has a window; this has none.
  * Acceptance moved out of the browser into
    `POST /api/orgs/invite/accept`, which additionally requires a signed-in
    caller whose **Supabase-verified email** matches the invite's. That is what
    makes a leaked link useless to whoever found it. The role and org come from
    the row.
  * `schema-orgs.sql` carries an idempotent migration that **deletes every
    unclaimed pre-fix invite**. They are all forgeable; they must not survive
    the fix. Re-send them.

  Tests: `apps/web/lib/orgs/invites.test.ts` (14) — forgery, a leaked link used
  by the wrong person, replay, expiry, and that "missing", "used" and "expired"
  return one identical sentence so the endpoint is not an oracle.

* **CORS‑1.** `ALLOWED_ORIGINS=*` now raises at startup in **both** Python
  services, naming the variable and saying why (`origins_list` in
  `services/api/app/core/config.py` and `services/agent/agent/config.py`).
  `allow_methods` and `allow_headers` are the explicit sets each service uses
  instead of `["*"]`. The agent service no longer hard-codes
  `http://localhost:3000` — it reads the same `ALLOWED_ORIGINS`, so a deployed
  operator finally has a correct value to set.

  **Failure mode when the variable is unset:** the default stays
  `http://localhost:3000` and each service emits a `RuntimeWarning` at startup
  saying so. A deployed app on any other origin then gets a browser CORS error,
  which is the setting working, not breaking. Narrowing silently to something
  the operator did not ask for would be worse; opening up would be much worse.
  Tests: `services/api/tests/test_security.py`.

* **The RLS half of ORG‑1.** `supabase/schema-orgs.sql` enables RLS on
  `orgs`, `org_members` and `org_invites` and carries policies expressing the
  same rule as `lib/orgs/access.ts`: a non-suspended member of an org may read
  its `org_members` rows, and only owners and admins may insert, update or
  delete them. The recursion trap (a SELECT policy on `org_members` whose
  subquery selects from `org_members`) is avoided with two `security definer`
  helpers with pinned `search_path`.

  Two things are stated in the file, in banners, because they are the two things
  a reader must not get wrong:

  * **This is defence in depth, not the control.** The control is the
    application-layer check in `lib/orgs/access.ts`, which runs on every request
    *including the ones that use the service-role key* — and the service role
    bypasses every policy in that file. If you change the rule in one place,
    change it in the other in the same commit.
  * **UNVERIFIED against a live project.** Nobody has run it. The policies have
    not been observed to load and no query has been made with a real anon key to
    confirm a non-member is refused. It is written from documented semantics and
    reviewed by reading; that is all. The test to run is checklist item 1.

  `supabase/README.md` gained the per-table RLS summary and the one real gap:
  the **analytics sink table has no schema file here at all** — an operator who
  sets `ANALYTICS_SUPABASE_TABLE` creates it themselves, and must enable RLS on
  it. A template is in that README; the right policy set is usually *none*, since
  the route writes with the service role and nothing should read it with the
  anon key.

* **The client half (checklist item 2).** Every browser call to a route that resolves a
  caller now goes through `authFetch`, so the token the server demands is actually sent:

  | Call site | Route |
  |---|---|
  | `components/billing/useEntitlement.ts` | `GET /api/billing/entitlement?userId=` |
  | `app/account/page.tsx` (Manage billing) | `POST /api/billing/portal` |
  | `components/billing/PricingTable.tsx` | `POST /api/billing/checkout` |
  | `components/admin/InvitePanel.tsx` | `POST /api/orgs/invite` |

  Swept for others: `components/tutor/ChatPanel.tsx` and
  `components/instructor/CoPilotPanel.tsx` call `/api/agent`, which is rate-limited but
  deliberately not user-resolving; `lib/analytics/track.ts` posts to `/api/analytics`, and
  `lib/hardware/client.ts` to the `/api/hardware/*` proxy (it called `services/api`
  directly when this was written) — neither resolves a caller. Those are left
  anonymous rather than given a credential they have no use for; for the hardware
  routes that is a real gap, recorded in docs/HARDWARE.md §4. The admin console reads
  members through `lib/orgs/store.ts` in the browser, not through `fetch`, so there is no
  other org call site to convert.

  This fixes the visible regression the audit predicted: a signed-in Pro user saw the
  free-tier badge, and "Manage billing" answered 401.

* **`POST /api/billing/checkout`** — same principle as BILL‑1, applied where the audit had
  only bounded the value: `userId` is stamped into `client_reference_id` and into session
  metadata that the **Stripe webhook reads back to decide whose subscription row to
  write**, so it is identity. When Supabase is configured and a `userId` is supplied it
  must now be the caller's own (401 without a token, 403 on mismatch). A signed-out
  visitor checking out anonymously sends no `userId` and is unaffected.

### The authorisation bug, proved

Served the production build with demo Supabase/Stripe credentials so both integrations
report themselves configured, with the pre-fix handlers mounted alongside the fixed ones.
Anonymous requests, victim `userId=00000000-0000-0000-0000-0000000000aa`:

```
############ BILL-1: POST /api/billing/portal {"userId":"<victim>"}
--- BEFORE ---  HTTP 200  {"error":"Could not look up your billing record."}
--- AFTER  ---  HTTP 401  {"error":"Sign-in required. Send your Supabase access token
                                    as `Authorization: Bearer <token>`."}
```

The `BEFORE` response is the important one: that message is emitted **after** the handler
has accepted the anonymous request and is already executing the privileged
`subscriptions.select('stripe_customer_id').eq('user_id', <victim>)` lookup with the
service-role key. It failed only because the demo credentials are not a real project.
With real credentials the next lines create the portal session and return its URL. The
`AFTER` response is returned before any lookup happens.

```
############ BILL-2: GET /api/billing/entitlement?userId=<victim>
--- BEFORE ---  HTTP 200  {"entitlement":{...resolved for the victim...}}
--- AFTER  ---  HTTP 200  x-entitlement-authenticated: false
                          {"entitlement":{"planId":"free","status":"none",...}}
```

### The headers, proved

Built with `next build`, served with `next start` on port 3987, four `curl -sI` calls.
Actual bytes returned on `GET /` (identical on `/pricing` and on
`GET /api/billing/entitlement`):

```
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self' http://localhost:8000; worker-src 'self' blob:; object-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'self'; frame-src 'none';
  upgrade-insecure-requests
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
x-dns-prefetch-control: off
x-frame-options: SAMEORIGIN
```

(`connect-src` picked up `http://localhost:8000` because `next.config.mjs` defaults
`NEXT_PUBLIC_API_URL` to it. `Strict-Transport-Security` is absent here and correctly so:
the request was plain http. It is emitted only when the request is https **and**
`NODE_ENV === 'production'`.)

And the static asset — middleware did **not** run, exactly as the matcher intends:

```
$ curl -sI http://127.0.0.1:3987/_next/static/chunks/webpack-9c7efacf4e911573.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
   ← no CSP, no X-Frame-Options, nothing added
```

---

## 4. Not fixed — why, and what it would take

### ORG‑1 / ORG‑2 — both halves now closed

*(This section twice described work that has since landed. What follows is the
state after the third pass; the detail is in §3.)*

**Application-layer authorisation: done.** `lib/orgs/access.ts` gates every
handler that names an org.

**RLS: written, and UNVERIFIED.** `supabase/schema-orgs.sql` enables RLS on
`orgs`, `org_members` and `org_invites` with policies expressing the same rule,
plus two banners: one saying this is defence in depth behind the app-layer check
(and that the service-role key bypasses it entirely), one saying nobody has run
it against a live project. That second banner is the honest status — see
"Could not be verified" and checklist item 1, which is still **open**.

**ORG‑2: done.** The store takes an explicit, already-verified caller and client
from the server (`OrgContext`), built by `orgContext()` in the same module that
resolves the caller for the role check. The org routes are no longer inert
server-side.

### INJ‑1 — prompt injection in the tutor path

**Now clamped and fenced (§3), but not "solved", and the distinction matters.**
The path is: user text → `/api/agent` → `services/agent` → an LLM holding eight
tools (`run_quantum_circuit`, `generate_circuit`, `explain_measurement`,
`check_circuit`, `search_concepts`, `get_learner_profile`, `create_quiz`,
`fetch_arxiv_paper`, `recommend_next_lesson`).

*What "ignore previous instructions" can still achieve here:*

* **Make the tutor say something wrong. STILL POSSIBLE, and it is the realistic
  harm.** Persona override, wrong physics, "your subscription has expired,
  re-enter your card at <link>". The reply is rendered as **text** by
  `MessageBubble.tsx`, so it cannot become script — but it can become a
  convincing sentence. What changed is only that the model is now told
  explicitly, in rule 7 of the system prompt, that it knows nothing about
  anyone's account or billing and has no tool that could reach them, and that
  content is never an instruction. That raises the bar; it does not close the
  hole, and no prompt can. **The UI must never present tutor output as
  authoritative about the user's own account, and must never render it as
  markup.**
* **Burn compute. FIXED.** `clamp_shots()` bounds `run_quantum_circuit`, so the
  local Aer fallback can no longer be driven to an arbitrary shot count, and
  `max_agent_seconds` bounds the run whatever the tools do.
* **Burn tokens over many turns. FIXED.** Total conversation characters, history
  turns, per-message length and reply tokens are all bounded.
* **Loop the tool calls. BOUNDED.** `max_tool_rounds` with
  `early_stopping_method="force"`, so hitting the limit ends the run with a
  partial answer rather than raising.
* **Read the learner profile.** Unchanged and bounded: `get_learner_profile`
  reads only the `progress` object the caller's own request forwarded. The worst
  case is the attacker reading data they already sent.
* **Second-order injection via arXiv.** Still reachable — anyone who can put
  text on arXiv can put text in that context — but it now arrives inside
  `<<<REFERENCE_MATERIAL>>>` under a standing instruction, and cannot close that
  block from the inside. It still does not unlock a new tool.
* **What it cannot do:** reach a new network destination (the circuit tool posts
  to a fixed `settings.quantum_api_url` path; the arXiv tool builds a fixed
  host), read a secret (no tool returns environment data), or write to a
  database (no tool writes anything).

**No longer open for hardware:** `/api/hardware/submit` is authenticated and
metered per account per calendar month against `lib/plans.ts` (50 / 500 / 5,000),
counted in `public.hardware_usage`. That counter lives in Postgres and nowhere
else, so unlike the rate limiter it survives a cold start and is shared across
instances; when it cannot be read the submission is refused rather than allowed.

**Still open:** the tutor is anonymous, so there is no per-user token budget —
an injection that costs money is bounded per request, and now per IP per minute
and per hour (checklist item 4), but still not per *person*. The remaining half
is authentication on `/api/agent`, and that is a product decision as much as a
security one: the tutor deliberately works signed out.

### Rate limiting — what it is now, and where the ceiling still is

**Changed.** `/api/agent`, `/api/email`, `/api/billing/checkout`,
`/api/billing/portal` and every `/api/hardware/*` proxy route now count through
`apps/web/lib/rateLimit.ts`, which uses Redis over Upstash's REST API when one
is configured. The limit is then the same number across every instance and
survives a deploy. The two paid, anonymous routes gained a second, longer
window as well, because a per-minute limit alone is a large per-day budget:
`/api/agent` is 12/minute **and** 100/hour (12/minute alone permits 17 280
requests a day from one address), `/api/email` is 5/minute **and** 100/day.

`lib/security/ratelimit.ts` still exists and still guards `/api/orgs/*` and
`/api/analytics`. It is still per-instance. Those routes are authenticated or
cheap; the paid ones are not, which is why only they were moved.

**Three things this still does not do, and none of them is subtle:**

1. **The key is an IP.** IP rotation is cheap — any cloud provider hands out
   fresh addresses, a residential proxy pool costs a few dollars an hour — so an
   attacker multiplies the limit by however many addresses they buy. IPv6 is
   collapsed to a /64 (one ISP customer is normally delegated the whole /64, so
   counting full addresses would let them rotate for free). That closes the
   cheapest rotation and none of the others. **Per-*person* cost is still
   unbounded**, and the only fix is authentication plus a per-account quota
   against `plans.tutorMessagesPerDay` — which conflicts with the tutor being
   deliberately anonymous. That is a product decision, still open.
2. **`x-forwarded-for` is caller-controlled** unless a trusted proxy overwrites
   it. Cloudflare, in front of qubit16.ai, only APPENDS to it, so its first hop
   is whatever the client sent. Since 2026-10-09 both limiters
   (`lib/rateLimit.ts`, `lib/security/ratelimit.ts`) key on `cf-connecting-ip`
   first, which Cloudflare's edge overwrites. That is only trustworthy while the
   origin is reachable solely through Cloudflare: the Azure Container Apps'
   `*.azurecontainerapps.io` hostnames should be restricted to Cloudflare's IP
   ranges, or a direct caller can set `cf-connecting-ip` themselves. Platform
   edge rate limiting in front of the function is still worth having.
3. **Without Redis it is exactly the old limiter.** No variables set means an
   in-process map. It warns loudly at startup and the warning names both failure
   modes, but a warning nobody reads is not a control. `rateLimit()` also falls
   back to that map when Redis is configured but does not answer — deliberately,
   because failing closed would turn a Redis outage into an outage of the tutor,
   the pricing page and transactional mail.

**Not verified:** no Redis has ever been available in this container. The
Upstash path is tested against a stubbed `fetch` (`apps/web/lib/rateLimit.test.ts`)
which proves the pipeline body, the arithmetic and the fallback, and proves
nothing about a real instance.

### Exposing services/api safely

**`services/api` is unauthenticated by design, and that has not been changed
silently.** `POST /api/circuits/run` executes user-supplied circuits and
`POST /api/hardware/submit` spends real IBM/Braket credits, both with no
credential. The audit accepted this **only** on the assumption that the port is
private, and nothing in the repository, the Dockerfile or `docker-compose.yml`
enforces that assumption. Published as-is, PY‑3 becomes critical.

There are exactly two supported deployments. Pick one deliberately.

**A. Private network — preferred, and free.** Do not publish the port. Let only
the Next server reach it, on an internal address:

* Railway/Render/Fly: give the API a private/internal hostname and do **not**
  attach a public domain. Set `NEXT_PUBLIC_API_URL` to that internal address —
  which means the browser can no longer call it directly, so the hardware page
  needs its calls proxied through a Next route handler (see B, step 3; the same
  work).
* Docker/Kubernetes: drop the `ports:` mapping for the `api` service in
  `docker-compose.yml` — the `web` service reaches it over the compose network
  as `http://api:8000` regardless. On Kubernetes, a `ClusterIP` Service and no
  Ingress.
* Verify it: `curl https://<your-api-host>/api/health` from outside must fail to
  connect. If it answers, the port is public.

**B. Shared secret — when you cannot keep it private.** A signed request from
the Next server, in the cheapest form that works. Opt-in, so local development
is untouched.

1. Generate a secret and set `API_SHARED_SECRET` **on the API service only**:
   `openssl rand -hex 32`. It must never appear in a `NEXT_PUBLIC_*` variable,
   in `docker-compose.yml`'s `web` service, or in any file the browser bundle
   can reach.
2. Set the same value as a **server-only** variable on the Next deployment
   (e.g. `QUANTUM_API_SECRET`). Server-only means: no `NEXT_PUBLIC_` prefix, and
   read only from a route handler.
3. ~~**Proxy the browser's calls.**~~ **DONE, in code.** `lib/hardware/client.ts`
   used to call `NEXT_PUBLIC_API_URL` from the browser, so no caller could send
   the header and giving them the secret would have published it. The five
   endpoints the app uses now go through Next route handlers under
   `apps/web/app/api/hardware/**`, which validate the request shape, rate-limit
   it, and attach `X-Quantum-Lab-Secret` server-side. With no secret set the
   behaviour is unchanged, so local development is untouched.
   **Three callers are still direct and will 401 when the gate is on:**
   `analyse()`, `submitLocalJob()` and `pollLocalJob()` in `client.ts` (no page
   calls any of them, which is why they were not given routes), and
   `services/agent`'s `run_quantum_circuit`, which posts to `/api/circuits/run`
   with no header and silently simulates locally when it fails. See
   **docs/HARDWARE.md**.
4. Verify it: an unauthenticated `POST /api/circuits/run` must return 401, and
   `GET /api/health` must still return 200 (it is exempt, so liveness probes
   keep working — a probe cannot be given a secret and a failing probe is an
   outage).

**What the secret is and is not.** It answers "is this caller the Next server?"
and nothing else. It is not identity, not a per-user quota, and not a rate
limit; it does not make `/hardware/submit` safe to expose to a logged-in user
without a quota in front of it.

**And it is worse than neutral if the proxy in front of it has no gate of its
own.** The proxy presents the secret for whoever is calling, so the moment
`/api/hardware/submit` was published through Next without an identity check, the
secret was being spent on anonymous callers — see finding PROXY‑1. The Next
route, not the Python service, is now where "may this person spend our money?"
is asked: sign-in, then `hardware.real`, then a monthly quota that **refuses when
it cannot be counted**. Read the gate chain in docs/HARDWARE.md §3 before adding
any further route under `app/api/hardware/**`. Comparison is `hmac.compare_digest`, so a wrong
value leaks nothing through timing. It is a door lock. Option A is still better,
because a lock on a door nobody can find is better than a lock alone.

**Also still true regardless of which you pick:** `services/api` has no rate
limit of any kind. `guard_qasm()` bounds one request; nothing bounds a thousand.

### Other items left as-is

* **`/api/agent` upstream error echo** (`route.ts`, the Anthropic non-OK branch) returns
  the first 200 characters of the upstream body to the browser. Anthropic error bodies are
  structured JSON with no secret material, and the echo is a genuinely useful setup aid,
  so it stays. Revisit if the upstream ever changes.
* **PY‑2 is still only partly fixed.** The `shots` bound is in the schema now,
  and the Next proxy adds a 5/minute cap in front of `/submit`, but the Python
  endpoints remain unauthenticated and unmetered **per user** — anyone who can
  reach the port directly bypasses the proxy entirely, and the proxy's own key
  is an IP. An entitlement check against `lib/plans.ts` on the submit route is
  what would actually bound it; it does not exist.

### Could not be verified

* **Supabase RLS. Still the biggest one, and now larger in scope.** All three
  `supabase/schema*.sql` files declare policies — including the `org_members` and
  `org_invites` policies written in this pass — but **no live project has ever been
  available**, so nothing has been confirmed: not that RLS is enabled, not that the
  policies load, not that a non-member is actually refused. The entire security of the
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` being public rests on this. The `org_members` SELECT
  policy in particular calls a `security definer` helper to dodge the RLS recursion trap
  (SQLSTATE 42P17) — a construction that fails loudly rather than open if it is wrong, but
  that is reasoning, not evidence. **Verify before production** (checklist item 1). The
  banner in `schema-orgs.sql` says the same thing where someone editing the file will see
  it.
* **The `org_invites` migration.** The idempotent `do $$ … $$` block that drops the old
  `token` column and deletes unclaimed forgeable invites has not been run against a real
  Postgres. It is written to be safe to re-run and to fail loudly rather than half-apply,
  but it has not been executed.
* **The shared-secret gate under a real proxy.** `services/api/tests/test_security.py`
  exercises it through `TestClient`. It has not been run behind a real reverse proxy, and
  the interaction with a platform that strips unknown headers is untested — if 401s appear
  after enabling it, check whether your proxy forwards `X-Quantum-Lab-Secret`.
* **Stripe webhook against live signatures.** The code is correct by inspection; it was
  not exercised with a real `stripe listen`.
* **Behaviour behind Vercel's edge.** The header-precedence claim in §3 (vercel.json wins
  over middleware) is from documented behaviour, not from an observed deploy. The values
  are identical, so nothing depends on it being right — but do not change one without the
  other on that basis.

---

## 5. Pre-production checklist

Ordered. Items 1–5 are blocking. Items marked DONE are recorded rather than
deleted, because several of them still need an **operator action** — a variable to
set or SQL to run — before the code change means anything.

1. **Confirm RLS is ON and correct.** `public.subscriptions`, `public.circuits`,
   `public.org_members`, `public.org_invites`, `public.hardware_usage` and any analytics
   sink table, and `subscriptions` **write-denied to users** (the webhook's service role
   is the only writer). **STILL OPEN, and now the single largest unverified assumption in
   this report:** the policies are written, in all three `supabase/schema*.sql` files, but
   **nobody has run them against a live project** — see the UNVERIFIED banner in
   `schema-orgs.sql`. Test it: with the **anon key alone**, signed in as a user who is not
   a member of an org, run `select * from org_members where org_id = '<that org>'`. It
   must return zero rows. Repeat as a `member` seat and confirm insert/update/delete are
   refused. Then the same for another user's `subscriptions` and `circuits` row.
2. ~~**Land the client half of the BILL‑1/BILL‑2 fix.**~~ **DONE.** All four browser call
   sites (`components/billing/useEntitlement.ts`, `app/account/page.tsx`,
   `components/billing/PricingTable.tsx`, `components/admin/InvitePanel.tsx`) now go
   through `lib/authFetch.ts`, which attaches
   `Authorization: Bearer <session.access_token>`. Tests: `apps/web/lib/authFetch.test.ts`.
3. ~~**Clamp the agent tool arguments.**~~ **DONE.** `clamp_shots()` in
   `services/agent/agent/tools.py` bounds `run_quantum_circuit` to
   `settings.max_shots`, and the tool loop gained `max_tool_rounds` and
   `max_agent_seconds` in `agent/core.py`. Conversation size, history and reply tokens
   are bounded too — table in §3. Tests:
   `services/agent/tests/test_injection_clamps.py`, `apps/web/lib/security/agentClamps.test.ts`.
4. ~~**Put a shared-store rate limit in front of `/api/agent`.**~~ **DONE in code,
   OPERATOR ACTION REQUIRED.** `apps/web/lib/rateLimit.ts` counts in Redis and is
   wired into `/api/agent` (12/min + 100/hour), `/api/email` (5/min + 100/day),
   `/api/billing/checkout`, `/api/billing/portal` and the `/api/hardware/*`
   proxy routes. **It does nothing until you set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL`/`KV_REST_API_TOKEN`) on the
   Next deployment** — without them it degrades to the old per-instance map and
   warns at startup. Read "Rate limiting" in §4 before treating this as closed:
   the key is an IP, and per-*person* cost is still unbounded because the tutor
   is deliberately anonymous.
5. **Do not expose `services/api` publicly.** **STILL OPEN — it is an operator action, not
   a code change.** Full instructions, both supported deployments and how to verify each,
   are in §4 "Exposing services/api safely". An opt-in `API_SHARED_SECRET` exists for
   the case where a private network is impossible, and **step 3 of that section is now
   done**: the hardware page's calls are proxied through the Next server, so switching
   the secret on no longer breaks it. What it does still break is listed in
   docs/HARDWARE.md §4 — three unused client helpers and `services/agent`'s circuit tool.
   Option A (private network) remains the better choice; the proxy makes option B
   workable rather than making option A unnecessary.
6. ~~Finish ORG‑1.~~ **DONE, with one caveat.** Per-org role checks:
   `lib/orgs/access.ts`, enforced across `/api/orgs`, `/api/orgs/members` and
   `/api/orgs/invite`; role table in §3; tests in `apps/web/lib/orgs/access.test.ts`.
   RLS policies: written in `supabase/schema-orgs.sql` — **the caveat is item 1, they are
   unverified.** ORG‑2: fixed, the store takes an explicit server-side caller context;
   tests in `apps/web/lib/orgs/store.test.ts`.
7. ~~Replace the invite token scheme (INV‑1).~~ **DONE.** Random, hashed, expiring,
   single-use; acceptance moved server-side and bound to the caller's verified email.
   §3 has the reasoning; tests in `apps/web/lib/orgs/invites.test.ts`.
   **Operator action required:** re-run `supabase/schema-orgs.sql`. Its migration block
   **deletes every unclaimed invite** — they are all forgeable under the old scheme — and
   replaces `org_invites.token` with `token_hash`. Re-send any outstanding invitations.
8. ~~Reject `ALLOWED_ORIGINS=*` while `allow_credentials=True`.~~ **DONE** in both Python
   services, which now refuse to start on a wildcard. **Operator action required:** set
   `ALLOWED_ORIGINS` to your real app origin on **both** `services/api` and
   `services/agent` — the agent service used to hard-code `http://localhost:3000` and now
   reads the variable, so a deployment that never set it will start warning and refusing
   the browser's origin.
9. Set `NEXT_PUBLIC_APP_URL` to the real origin — MAIL‑1's link allow-list is derived
   from it, and a wrong value rejects legitimate invite mail.
10. Rotate every key that has ever been in a `.env` committed to a shell history or a CI
    log, and confirm `.env` is in `.gitignore` (it is).
11. Add HSTS preload only after running with `max-age=63072000; includeSubDomains` for a
    full period — it is a one-way door.
12. Consider moving to a CSP nonce, which requires dynamic rendering (see the long note in
    `lib/security/headers.ts`). Until then `script-src` permits `'unsafe-inline'` and the
    CSP is an **exfiltration** control, not an **execution** control.
13. Turn on Sentry (`NEXT_PUBLIC_SENTRY_DSN`) or equivalent, and alert on 401/403/429
    rates — none of the fixes above are observable today.

---

## 6. Reporting a vulnerability

Open a **private** security advisory on the GitHub repository. Please do not file a public
issue. Include the request, the response, and what you believe the impact is.

## Origin lockdown (the two dashboard steps, made runnable)

The Container Apps answer on their own `*.azurecontainerapps.io` hostnames as
well as through Cloudflare. Two steps close the direct path:

1. `bash infra/azure/restrict-origin-to-cloudflare.sh` — allows only
   Cloudflare's published ranges on the web and api apps (the agent already
   has internal ingress). Every other address gets 403 from Azure. Re-run it
   if Cloudflare changes its ranges; `--remove` undoes it.
2. Cloudflare dashboard → the qubit16.ai zone → **SSL/TLS → Overview → Full
   (strict)**, so the edge verifies the origin certificate.

After both, `https://qubit16.ai` works and the raw app hostnames answer 403.

> **Correction (2026-10-27).** The sentence above holds for the web app only.
> `restrict-origin-to-cloudflare.sh` has not been applied to `quantum-lab-api`:
> its raw `*.azurecontainerapps.io` hostname still answers (item 1 below).

## Open operator items (as of 2026-10-27)

These need an Azure, Cloudflare, Apple or Supabase login that the code review
and the automated fixes did not have. None is closed by a commit. Nothing here
has been tested by the people who wrote it down: Docker and `az` were not
available when this list was written.

1. **Restrict the `services/api` origin.** The api Container App has external
   ingress and its raw hostname answers from the internet. Its `/api/health` is
   exempt from the shared-secret gate and runs a probe circuit per call with no
   rate limit. The hostname is also named in the site's CSP `connect-src`. Run
   `bash infra/azure/restrict-origin-to-cloudflare.sh` for the api app too (or
   make its ingress internal if the browser does not need to reach it), then
   confirm the raw hostname answers 403.
2. **Disable the ACR admin account.** `infra/azure/deploy.sh`,
   `attach-domain.sh` and `deploy-email-cron.sh` create the registry with
   `--admin-enabled true` and store its static password on every Container App
   and the cron job. Move to a system-assigned managed identity with `AcrPull`
   (`--registry-identity system`), then `az acr update --admin-enabled false`
   and delete `refresh_registry_creds()` and the `az acr credential show` lines.
3. **`www.qubit16.ai` returns Cloudflare 525.** No `www` hostname or certificate
   is bound on the web app. Either add a Cloudflare redirect rule
   `www.qubit16.ai/*` -> `https://qubit16.ai/$1` (301), or run
   `DOMAIN=www.qubit16.ai bash infra/azure/attach-domain.sh`. Until then the
   `applinks:www.qubit16.ai` entitlement in the iOS app cannot verify.
4. **Apple Team ID placeholder.** `apps/web/public/.well-known/apple-app-site-association`
   still contains `REPLACE_WITH_APPLE_TEAM_ID`, and `apps/ios/project.yml` has an
   empty `DEVELOPMENT_TEAM`. Universal Links do not work until both carry the
   real Team ID (docs/IOS.md step 2). It must come from the Apple Developer
   account; it is not guessed here.
5. **Apply Supabase migration `20261022000040_rls_audit_2026_10_22.sql`** to
   production (`supabase db push`, or `supabase/apply-all-migrations.sql`), then
   run `supabase/verify-migrations.sql` and expect no `REGRESSED` row.
6. **Set `HEALTH_DEEP_TOKEN`** on the web app if you want release, environment
   and per-check detail from `/api/health`. Without it nobody is trusted and
   anonymous callers (and you) get statuses only.
7. **GitHub Actions are pinned to tags, not commit SHAs.** `actions/checkout`,
   `setup-node`, `setup-python`, `setup-java`, `cache`, `upload-artifact`,
   `azure/login`, `gradle/actions/setup-gradle` and `cloudflare/wrangler-action`
   should each be pinned to a full commit SHA with a `# vX.Y.Z` comment, and
   `npx --yes wrangler@3` in `pages.yml` pinned to an exact version. The SHAs
   were not available offline and were not invented; resolve them with
   `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and add a Dependabot entry
   for the `github-actions` ecosystem.
8. **Stripe is not configured in production.** `/api/health` reports
   `stripe: skipped`, so Upgrade on `/pricing` cannot complete. Set
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the `STRIPE_PRICE_*` ids on
   the web app.
9. **Node 22 rollout.** The web image and CI moved to Node 22 in code; the
   running site only changes when the next web image is built and deployed.
   The root `package.json` `engines.node` (`>=18.17`) is outside the files
   changed with this list and should be raised to `>=22`.

## 2026-10-27 wave 3

Fixes from the third pass over the audit findings. Each has a unit test beside
the code. Nothing here was exercised against production.

### Exam subject resolution no longer turns a bad session into a guest

`lib/security/auth.ts` gains `verifyCallerOutcome`, which tells apart *no token*,
*invalid or expired token*, and *auth service unreachable*. `verifiedCaller` and
`verifiedCallerId` keep their old contract (anything but a verified caller is
`null`). `resolveSubject` in `lib/exams/session.ts` uses the new function and
sets `ResolvedSubject.denied` to a 401 (token rejected) or a 503 with
`Retry-After` (auth service down) instead of quietly dealing a guest attempt that
can never become a certificate. **A route must return `denied` when it is set.**
`lib/exams/service.ts` must check it after each `resolveSubject` call; until it
does, behaviour is exactly as before. The guest cookie carries `Secure` on https
and a malformed cookie value reads as absent instead of throwing.

### BYOK public fields are shape-checked

The non-secret BYOK fields reach vendor SDKs, and the Azure SDK builds an
endpoint from `location` / `resource_id`. They are now pinned to the vendors'
formats, in the web layer when stored (`splitCredentialFields`) and again in
`services/api/app/quantum/credentials.py`, which does not trust its caller:
Azure location `^[a-z0-9]{3,32}$`, tenant and client ids as GUIDs, the full
`/subscriptions/<guid>/resourceGroups/<name>/providers/Microsoft.Quantum/Workspaces/<name>`
resource id, AWS region, S3 bucket and prefix, access key id, and the IBM
instance. `services/api/app/quantum/azure.py` no longer returns the Azure SDK's
exception text to the caller (it was reflected in a 400); the caller gets a fixed
sentence and the real cause is logged. Consequence to know about: a credential
stored earlier whose public field does not match (for example an Azure tenant
given as a domain name instead of a GUID) is now refused by the API service at
use time with "not in the expected format", and its owner must re-save it.

### The BYOK sealing key fallback is loud, not removed

If `SETTINGS_ENCRYPTION_KEY` is unset, credentials are sealed under a key derived
from `SUPABASE_SERVICE_ROLE_KEY`. Anyone who can read the service-role key can
decrypt them, and rotating it makes them unreadable. Requiring the explicit key
would lock out every user whose credential is already stored that way, so the
fallback stays, with: one `console.warn` and one error-tracker warning per
process, `byokKeyIsFallback()` in `lib/platform/secretBox.ts` for `/api/health`
to report to trusted callers, and `open()` still reading values sealed under the
derived key after the explicit key is set (new seals use the explicit key only).
The earlier statement in this document that the decryption key "lives only in the
web app's environment" is true only once `SETTINGS_ENCRYPTION_KEY` is set. Steps:
docs/BYOK.md, "Moving off the fallback key".

### Rotation note: a lapsed or replaced sealing key

A sealing key is *lapsed* when it is no longer the one the stored values were
sealed under: `SETTINGS_ENCRYPTION_KEY` replaced with another value, removed
while the service-role key is the only fallback, or the service-role key rotated
while the fallback was in use. Nothing re-encrypts. Every value sealed under the
lapsed key fails to open, `resolveProviderCredential` answers "no credential"
and logs `could not be decrypted`, and the job runs on the operator's credentials
rather than the user's, so the symptom is spend on the operator account, not an
error. Before any rotation: (1) check `byokKeyIsFallback`; (2) if it is `true`,
set `SETTINGS_ENCRYPTION_KEY` first and do not rotate the service-role key until
users have re-saved their credentials; (3) if it is `false`, expect to ask each
user to re-enter their credential after the change; (4) keep the previous key in
the secret manager until that has happened. The admin-set provider keys in
`platform_settings` follow the same rule and must be re-entered in
`/admin/platform`.
