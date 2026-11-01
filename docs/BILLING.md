# Billing & Entitlements

Quantum Lab is fully usable with **no Stripe account and no Supabase project**.
With an empty environment every visitor gets the Free plan, the billing routes
answer with a friendly "not configured" payload instead of an error, and nothing
throws at import time. Everything below is about turning the paid tiers *on*.

---

## 1. Environment variables

Put these in `apps/web/.env.local` (never commit them).

| Variable | Required for | What it is |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | everything | Secret API key, `sk_test_…` in test mode. Its presence is what flips `isStripeConfigured`. |
| `STRIPE_WEBHOOK_SECRET` | the webhook | Signing secret, `whsec_…`. Printed by `stripe listen`, or shown when you create the endpoint in the dashboard. |
| `NEXT_PUBLIC_APP_URL` | redirects | Public origin, e.g. `https://quantumlab.example`. Defaults to `http://localhost:3000`. |
| `SUPABASE_SERVICE_ROLE_KEY` | persistence | Service-role key. The **only** credential permitted to write `subscriptions` and `hardware_usage`. Server-side only — never expose it to the browser. |
| `BILLING_RECONCILE_SECRET` | the nightly sweep (§8) | Optional shared secret for `POST /api/billing/reconcile` on somebody else's behalf. Unset (the default) means the header is ignored entirely and only self-service reconciliation works. |

Plus one price id per sellable plan/period (see the table in §3):

```
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_YEARLY=price_…
STRIPE_PRICE_TEAM_MONTHLY=price_…
STRIPE_PRICE_TEAM_YEARLY=price_…
```

You also need the ordinary Supabase pair (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`) from `supabase/README.md`, and you must run
`supabase/schema-billing.sql` in the SQL editor.

If a price id is missing, `/api/billing/checkout` returns **200** with
`{ configured: false, message }` naming the exact variable that is unset — no
stack trace, no broken pricing page.

---

## 2. Creating the products and prices

1. In the Stripe dashboard, switch to **Test mode**.
2. **Product catalogue → Add product**. Create one product per paid tier:
   *Quantum Lab Pro* and *Quantum Lab Team*.
3. For each product add **two recurring prices** — one monthly, one yearly —
   matching `lib/plans.ts`:
   - Pro: $19.00 / month and $190.00 / year
   - Team: $99.00 / month and $990.00 / year
4. Open each price and copy its id (`price_1Nxxxx…`) from the price detail page.
5. Paste each into the env var the plan names. `lib/plans.ts` is the source of
   truth for which var belongs to which price:

   | Plan | Monthly env var | Yearly env var |
   | --- | --- | --- |
   | `free` | — (no checkout) | — |
   | `pro` | `STRIPE_PRICE_PRO_MONTHLY` | `STRIPE_PRICE_PRO_YEARLY` |
   | `team` | `STRIPE_PRICE_TEAM_MONTHLY` | `STRIPE_PRICE_TEAM_YEARLY` |
   | `edu` | — (contact sales) | — |

6. Restart `npm run dev` — env vars are read at request time, but Next.js only
   loads `.env.local` at boot.

The reverse mapping (`planIdForPriceId`) scans these same env vars, so a price
id that is not in the environment resolves to no plan. **A production deploy
must have every price id set**, or a legitimate webhook will downgrade the
subscriber to `free`.

### Enable the customer portal

`/api/billing/portal` needs the portal configured once:
**Settings → Billing → Customer portal → Activate**, allowing plan changes and
cancellation.

Checkout is for a *first* subscription only. `/api/billing/checkout` reuses the
account's stored Stripe customer and answers 409 when the account already holds
a live (`active`, `trialing`, `past_due`) subscription; the pricing page then
sends the subscriber to the portal, which switches the one subscription and
prorates the difference, instead of billing a second one.

---

## 3. Plans

Generated from `apps/web/lib/plans.ts` — that file is the contract; this table
is a snapshot.

| Plan | Monthly | Yearly | Max qubits | Saved circuits | Hardware jobs/mo | Tutor msgs/day | Seats |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Free** (`free`) | Free | Free | 16 | 10 | 0 | 20 | 1 |
| **Pro** (`pro`) | $19/mo | $190/yr (17% off) | 16 | Unlimited | 50 | Unlimited | 1 |
| **Team** (`team`) | $99/mo | $990/yr (17% off) | 16 | Unlimited | 500 | Unlimited | 10 |
| **University** (`edu`) | Contact sales | Contact sales | 16 | Unlimited | 5,000 | Unlimited | Unlimited |

### Features by plan

The browser simulator is **16 qubits on every plan**, signed in or not (changed
2026-10-09). It runs on the visitor's own device and costs the deployment
nothing; capping it at 5 (Free) and 12 (Pro, and so every launch-trial account)
contradicted the product's name. Plans differ on hardware, the live tutor, the
advanced track, saved circuits and seats.

| Feature id | Free | Pro | Team | University |
| --- | --- | --- | --- | --- |
| `simulator.basic` | yes | yes | yes | yes |
| `simulator.qubits.5` | yes | yes | yes | yes |
| `simulator.qubits.12` | yes | yes | yes | yes |
| `simulator.qubits.16` | yes | yes | yes | yes |
| `circuits.save` | yes | yes | yes | yes |
| `circuits.share` | yes | yes | yes | yes |
| `hardware.simulator` | yes | yes | yes | yes |
| `tutor.offline` | yes | yes | yes | yes |
| `course.foundations` | yes | yes | yes | yes |
| `export.qasm` | yes | yes | yes | yes |
| `circuits.unlimited` | — | yes | yes | yes |
| `hardware.vendor` | — | yes | yes | yes |
| `hardware.real` | — | yes | yes | yes |
| `tutor.live` | — | yes | yes | yes |
| `course.advanced` | — | yes | yes | yes |
| `certification` | — | yes | yes | yes |
| `export.notebook` | — | yes | yes | yes |
| `team.seats` | — | — | yes | yes |
| `team.admin` | — | — | yes | yes |
| `analytics.usage` | — | — | yes | yes |

### What plan copy is allowed to claim

`Plan.highlights` is rendered verbatim on `/pricing`, each line with a ✓. The
rule, enforced by `apps/web/lib/plans.test.ts`:

- **A highlight must be something the entitlement layer grants at checkout** — a
  `FeatureId` on that plan, or a number read from that plan's `limits`. If a
  self-serve buyer can click Upgrade and not get it, it does not belong there.
- **A capability a human arranges goes in `Plan.arrangedHighlights`**, which
  only a `contactSales` plan may set. The pricing card renders those under
  "Set up with you during onboarding — not a self-serve switch", with a neutral
  marker rather than a ✓.
- **Do not add a `FeatureId` for something nothing implements.** `hasFeature`
  would then answer true for a capability no code delivers, which is the same
  false promise moved somewhere harder to find.

Four University claims were removed or reframed under this rule in the pricing
truth pass; the reasoning is written next to the `edu` plan in `plans.ts`.
Summary: SSO and a bespoke lesson track are `arrangedHighlights` (real, done by
hand); **LMS grade passback** was removed because lesson progress lives in the
learner's browser (`lib/lessons/progress.ts`) and never reaches a server, so
there is no score to push into a gradebook; **priority hardware queue** was
removed because the queue belongs to the provider. Team's "Shared circuit
library" was removed: circuits are stored per user, and the only sharing
primitive (`circuits.share`) is on Free.

---

## 4. Webhooks in development

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/billing/webhook
```

`stripe listen` prints a signing secret on startup:

```
> Ready! Your webhook signing secret is whsec_abc123…
```

Copy it into `STRIPE_WEBHOOK_SECRET` and restart the dev server. Leave
`stripe listen` running in its own terminal for the whole session — the secret
changes each time you restart it.

Handled events:

| Event | Effect on `public.subscriptions` |
| --- | --- |
| `checkout.session.completed` | Upserts the row: customer, subscription, plan, status, period end. Applied only for a `mode: 'subscription'` session whose `client_reference_id` equals `metadata.userId`, is a UUID, and whose plan resolves to a known paid plan (`pro` / `team`); any other session (a Payment Link, a one-off charge) is acknowledged and ignored. |
| `customer.subscription.created` | Same, from the subscription object. |
| `customer.subscription.updated` | Plan/status/period-end refresh (upgrades, downgrades, cancel-at-period-end). |
| `customer.subscription.deleted` | `status = 'canceled'`. |
| `invoice.payment_failed` | `status = 'past_due'`. |

Anything else is logged and acknowledged with 200 — Stripe retries non-2xx
responses, so an unhandled type must never 500. A *database* failure **does**
return 500, on purpose, and so does a failed call back *into* Stripe (an outage,
a 429 or a timeout while `checkout.session.completed` or `invoice.payment_failed`
re-reads the subscription): those are the cases where a retry helps. A Stripe
answer that a retry cannot change (no such subscription, a bad key) is
acknowledged with 200.

### Retries and ordering

Stripe retries for up to three days and makes **no ordering guarantee**. Two
things follow, and neither was handled before 2026-08-17:

- **Replay.** The same event delivered twice was processed twice.
  `public.stripe_events` is now an idempotency ledger: the handler checks it
  before doing anything and writes to it only *after* the work succeeded. The
  order matters — claiming the id first would mean a crash between the claim and
  the write turns Stripe's retry into a skipped duplicate, and the change is
  lost with nothing to say so. A redelivery answers
  `{ received: true, duplicate: true }`.
- **Out-of-order delivery.** An upgrade created at 12:00:00 whose first delivery
  times out is retried at 12:00:30 — by which time the customer's downgrade,
  created at 12:00:10, has already been applied. Last-arrival-wins leaves the
  account on a plan it no longer pays for; with the events the other way round
  it *cancels a paying customer*. Every write now carries Stripe's
  `event.created`, and `public.apply_stripe_subscription` drops a write whose
  stamp is older than the last one applied to that account
  (`subscriptions.last_event_at`).

**Endpoint API version.** The shape of `event.data.object` follows the API
version the Dashboard *endpoint* was created with, not the SDK's. Create the
production endpoint with **`2024-10-28.acacia`** (`STRIPE_API_VERSION` in
`lib/billing/stripe.ts`, the version the SDK is pinned to). Newer versions drop
the top-level `current_period_end` on subscriptions and `subscription` on
invoices; as a safety net the handler re-reads the subscription through the
pinned client whenever `event.api_version` differs and logs one warning, and it
also looks for the invoice's subscription under `parent.subscription_details`.
That keeps renewals and `past_due` correct, at the cost of one extra Stripe call
per event, so fix the endpoint rather than relying on it.

What was **already** right and must stay that way: the signature is verified
against the raw body before anything else runs, and the user id comes from the
event (`metadata.userId` / `client_reference_id`) rather than from the request.

You can replay an event without paying again:

```bash
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

(`stripe trigger checkout.session.completed` uses Stripe's fixture session, which
carries none of this app's `client_reference_id` / `metadata.userId`, so it is
acknowledged and ignored; to exercise the checkout path, buy through
`/pricing` in test mode.)

### Production endpoint

**Developers → Webhooks → Add endpoint**, URL
`https://<your-domain>/api/billing/webhook`, subscribed to the five events
above. Copy that endpoint's signing secret into the deployment's
`STRIPE_WEBHOOK_SECRET`.

---

## 5. Testing a subscription end to end

1. `npm run dev` and `stripe listen --forward-to localhost:3000/api/billing/webhook`.
2. Go to `/pricing` and start a Pro checkout.
3. Pay with Stripe's test cards:

   | Card | Result |
   | --- | --- |
   | `4242 4242 4242 4242` | Succeeds. |
   | `4000 0000 0000 9995` | Declined (insufficient funds). |
   | `4000 0025 0000 3155` | Requires 3D Secure authentication. |

   Any future expiry, any CVC, any postcode.
4. You land on `/account?checkout=success`. The `stripe listen` terminal shows
   `checkout.session.completed → 200`.
5. Confirm the resolution layer agrees:

   ```bash
   curl 'http://localhost:3000/api/billing/entitlement?userId=<uuid>'
   ```

   Expect `planId: "pro"`, `status: "active"`, and the Pro limits.
6. Cancel from the portal (`POST /api/billing/portal` with `{ userId }`) and
   watch `customer.subscription.updated` flip `cancel_at_period_end` to true.

Test-mode subscriptions never charge a real card, and test data is isolated from
live data.

---

## 6. How gating works

There are two layers, and only one of them is a security control.

**Client courtesy — `lib/plans.ts` in the browser.**
Components import the same pure `plans.ts` and use `hasFeature`, `maxQubitsFor`
and `canSaveAnotherCircuit` to grey out a locked control, show a padlock, or put
an "Upgrade to Pro" ribbon on a lesson. This exists so the product feels honest:
you can see what you would get. It is trivially bypassable with devtools, and
that is fine, because it grants nothing.

**Server enforcement — `lib/billing/entitlements.ts`.**
A route that performs paid work is meant to resolve the entitlement *itself*
from the database and gate on it:

```ts
import { requireFeature, featureLockedResponse } from '@/lib/billing/entitlements'
import { FeatureLockedError } from '@/lib/plans'

try {
  await requireFeature(userId, 'hardware.real')
} catch (err) {
  if (err instanceof FeatureLockedError) return featureLockedResponse(err)
  throw err
}
```

`featureLockedResponse` returns **402 Payment Required** with
`{ error, feature, requiredPlan, upgradeUrl: '/pricing' }`, which the client
turns into an upgrade prompt.

> **Closed, 2026-08-17.** This gap used to read: *"no route calls any of this
> yet — `requireFeature`, `recordHardwareJob` and `assertHardwareQuota` have
> exactly zero callers"*, with the only thing between a Free account and a real
> hardware job being the client-side `<UpgradeGate>`, which devtools removes.
> By the time the Next proxy landed it was worse than over-delivery: the proxy
> attached the operator's shared secret, so a **signed-out** `curl` could bill
> the operator (docs/SECURITY.md, finding PROXY‑1).
>
> `POST /api/hardware/submit` now runs the full chain — verified caller →
> `requireFeature(id, 'hardware.real')` → atomic reserve → forward →
> `recordHardwareJob` — and `lib/hardware/submitGate.test.ts` fails if
> any link is removed. `GET /api/hardware/job/*` requires a verified caller who
> **owns** the job. `devices`, `estimate` and `transpile` stay open on purpose;
> the reasoning is at the top of each route file. Full chain and its failure
> modes: **docs/HARDWARE.md §3**.

**The quota is the one place that must NOT degrade to Free.**
`lib/billing/usage.ts` is the deliberate exception to the "failure degrades to
Free" rule below. Free means *zero* hardware jobs, so degrading is a refusal and
therefore safe — but its `hardwareJobsUsed` may also be 0 because the count
query failed, and 0-because-nothing-ran and 0-because-the-database-is-down are
the same number and opposite decisions. So the usage helpers **throw
`QuotaUnavailableError`** instead of guessing, and the submit route turns that
into a 503. Allowing a job when the meter is broken turns a database blip into an
unbounded provider bill.

Practical consequences, so nobody discovers them from an invoice or a ticket:

- **No Supabase, or no `SUPABASE_SERVICE_ROLE_KEY` → no hardware submissions.**
  RLS denies `INSERT` on `hardware_usage` to users, so without the service role
  nothing can be metered and everything is refused. A deployment with real
  IBM/Braket credentials and no database has no way to bound spend.
- **Cold start / second instance:** the counter is `public.hardware_usage` and
  nothing else — no in-process cache. A fresh serverless instance counts exactly
  what a warm one counts, and N instances share one allowance instead of getting
  N allowances (contrast `lib/rateLimit.ts`, whose in-memory fallback does not).
- **The reservation is atomic.** `public.reserve_hardware_job` (a `security
  definer` function) takes a per-user advisory lock, counts the window and
  inserts the reservation only if the count is under the limit — one round trip,
  one decision. A refusal writes nothing at all, and a submission that fails
  upstream releases its row, so a user is never charged allowance for a job that
  was not submitted.

  > **Closed, 2026-08-17.** This used to read: *"the usage row is inserted
  > before the count … two simultaneous submissions can still both slip
  > through"*. They can't now. Note also that the old inclusive count was fed to
  > `canRunHardware`, which refuses at `used >= limit`, so **Pro delivered 49 of
  > the 50 jobs the pricing page sells**. The function counts before it inserts
  > and delivers 50.

  The limit and the window are **arguments**, not something the function works
  out, so `EXECUTE` is revoked from `anon` and `authenticated` and granted only
  to `service_role`. A signed-in user who could call it could pass their own
  limit. Verification queries 2 and 3 in `supabase/schema-billing.sql` check
  exactly that, and they must be run by hand — see §9.
- **A 2xx with no job id is handled, not just logged.** The row stays (the
  vendor may have accepted and will charge for the job) and is marked
  `settlement = 'unmatched'` so an operator can find it; the caller gets **502**
  with copy telling them it may be running and to check the provider console.
  Passing the upstream 2xx through was worse than useless: the browser types
  that body as `SubmittedJob` and starts polling `undefined`.
- **Job ownership:** `recordHardwareJob` stamps `provider` + `job_id` onto the
  reserved row. Those two columns are what `GET /api/hardware/job/*` checks, so
  they are not bookkeeping — they are the access control.

The rules that keep the two layers honest:

- **Never trust a plan id from the browser.** `getEntitlement(userId)` reads the
  database; a request body claiming `planId: 'team'` is ignored everywhere.
- **Only Stripe may grant a plan.** RLS on `public.subscriptions` gives users
  `SELECT` on their own row and nothing more; `INSERT`/`UPDATE` are not granted
  to any user role. The webhook writes with the service-role key. This is the
  single most important line of defence in the billing system — see the header
  comment in `supabase/schema-billing.sql`.
- **Metered work is recorded server-side.** `reserveHardwareJob` writes to
  `hardware_usage` with the service role *before* the job is submitted and
  `recordHardwareJob` stamps the provider's handle on it afterwards. The count
  is taken inside `public.reserve_hardware_job`, over the window in §7. Users
  can read their usage but cannot delete it to reset a quota.
- **Failure degrades to Free, never to an error — except where Free is not the
  safe answer.** Any exception inside `getEntitlement` returns
  `FREE_ENTITLEMENT`: a billing outage costs revenue for a few minutes, an error
  page costs a learner their lesson. `lib/billing/usage.ts` deliberately does the
  opposite and refuses; see the box above for why.
- **Grace for dunning.** `past_due` keeps access (see `effectivePlan`), so a
  failed renewal does not lock someone out mid-sentence. `canceled` and
  `incomplete` fall back to Free.
- **`unpaid` is not grace.** In Stripe, `unpaid` means dunning has finished and
  the subscription will not be retried or charged again. `toStatus` maps it to
  `canceled`, so the account falls back to Free, and reconciliation ranks it
  below `canceled`. Set the dunning behaviour under **Settings → Billing →
  Subscriptions and emails → Manage failed payments**. Either "cancel the
  subscription" or "mark the subscription as unpaid" now ends access; "leave
  the subscription past-due" keeps Stripe's `past_due` status forever, which
  this code treats as grace with no time limit, so do not choose it.

### Where entitlements come from

`getEntitlement(userId)` takes the **stronger** of two sources, ranked
`free < pro < team < edu`:

1. the user's own row in `public.subscriptions`, and
2. any seat granted through `public.org_members` (an optional table — if it does
   not exist, the query error is treated as "no org", not as a failure).

It then fills `hardwareJobsUsed` by counting the current usage window's rows in
`public.hardware_usage` (§7 — the same window the gate enforces), so the UI can
show "12 of 50 used". That particular count is best-effort and is fine for a
badge. The **submit route does not use it**: the number it acts on is taken
inside `reserve_hardware_job`, under the same lock as the insert, and
`hardwareJobsInPeriod` throws rather than returning a comforting 0.

---

## 7. What "this month" means for a quota

The plans sell hardware jobs **per month**. Two readings of that are defensible
and they give different answers, so the choice is written down here and enforced
by `apps/web/lib/billing/period.ts`.

**We use the subscription's monthly anniversary, not the calendar month.**

A customer who subscribes on 20 January and is metered by calendar month gets
the tail of January's 50 jobs and a fresh 50 on 1 February — up to 100 hardware
jobs inside the one billing period they paid for. That is IBM time the operator
buys and does not sell, it fires for anyone who subscribes after the 1st, and
the error is in the expensive direction. Anchoring to the subscription instead
gives 20 Jan–20 Feb, then 20 Feb–20 Mar: exactly what was paid for.

Details that matter if you touch this:

- The anchor is the **day-of-month and time-of-day** of `current_period_end`,
  stepped monthly — *not* `current_period_end` minus one billing interval. An
  annual subscription's period end is twelve months out, so the naive version
  would give an annual customer 50 jobs a **year** against a page promising 50 a
  month.
- Because only the anchor day is read, a `current_period_end` left stale by a
  missed webhook still yields the right window. That is deliberate: the window
  must not collapse during exactly the outage §8 exists to repair.
- Anchor day 31 clamps to the 28th/29th/30th, the same clamp Stripe applies, so
  windows tile with no gap and no overlap.
- **No anchor ⇒ calendar month.** That covers Free accounts (allowance 0, so the
  window is irrelevant), org-seat holders (`getEntitlement` clears
  `currentPeriodEnd` when a seat outranks a personal subscription — the seat's
  period belongs to the org and this row does not know it), and rows written
  before this change.
- `getEntitlement` counts the **same** window it enforces. A badge that counts a
  calendar month while the gate counts a billing month produces "it says I have
  8 left but it refuses me", and the customer is right.

---

## 8. Reconciliation — when Stripe and the database disagree

The webhook is a *push*, and a push is not a guarantee. All of these have
happened to somebody: the endpoint was down long enough for Stripe to give up
retrying; `STRIPE_WEBHOOK_SECRET` was rotated without a redeploy so every
delivery 400'd; the change was made by hand in the dashboard; the endpoint was
not subscribed to the event type it needed; the event carried no
`metadata.userId` and could not be attributed to an account.

`POST /api/billing/reconcile` re-derives one account's row by reading Stripe
live. It writes with **no ordering stamp**, which
`apply_stripe_subscription` treats as unconditionally fresh — a live read cannot
be stale relative to any event.

| Caller | How | Scope |
| --- | --- | --- |
| A signed-in user | `Authorization: Bearer <supabase token>`, `{ "userId": "<their own id>" }` | Themselves only. 403 for anyone else's id. |
| An operator or cron | `x-reconcile-secret: $BILLING_RECONCILE_SECRET` | Any user id. |

With `BILLING_RECONCILE_SECRET` unset the header is ignored entirely — an empty
secret must never authorise anything. A call without the secret is rate limited
to 5/min per IP because every allowed call reaches Stripe, and Stripe
rate-limits the *account*, not the caller. A call that presents the operator
secret is limited per *target account* (20/min) instead: the sweep below is many
accounts from one host, and a per-IP limit silently refused the sixth account
onwards with a 429 that `curl -sS` reports as success.

### When it should run

1. **Automatically, on staleness.** `GET /api/billing/entitlement` calls
   `reconcileIfStale`, which fires only when `current_period_end` is more than
   24 hours in the past — a renewal that happened at Stripe and never reached
   us, i.e. exactly the case where a paying customer is being refused. It
   self-heals on their next page load, with a 10-minute per-process cooldown.
   Only a row whose stored status still grants access (`active`, `trialing`,
   `past_due`) qualifies: a `canceled` / `none` row keeps its past period end
   forever, and re-querying Stripe for every ex-subscriber would burn the
   account-wide rate limit for nothing.
2. **On demand**, from support, and **automatically after checkout**: the
   account page, when it opens with `?checkout=success`, calls
   `POST /api/billing/reconcile` and re-reads the entitlement up to five times
   over about 45 seconds while the plan is still Free
   (`lib/billing/confirmCheckout.ts`). First-time checkout now creates the Stripe
   customer *before* the session and records it, so the reconciler can find a
   buyer whose first webhook never landed.
3. **Nightly**, for every account holding a `stripe_customer_id`. Not wired:
   this repository has no scheduler, and inventing one that never runs is the
   kind of decoration this project has been burned by before. The loop:

   ```bash
   # every account with a Stripe customer, one at a time, gently
   psql "$SUPABASE_DB_URL" -Atc \
     "select user_id from public.subscriptions where stripe_customer_id is not null" |
   while read -r uid; do
     curl -sS --fail -X POST "$APP_URL/api/billing/reconcile" \
       -H "content-type: application/json" \
       -H "x-reconcile-secret: $BILLING_RECONCILE_SECRET" \
       -d "{\"userId\":\"$uid\"}"
     sleep 1
   done
   ```

4. **After any webhook outage**, for everyone — same loop.

A reconciliation that *changes* something logs a warning naming the before and
after. A run of those is an incident (a webhook path is broken), not a
curiosity.

---

## 9. Verifying the SQL against a live project

`supabase/schema-billing.sql` **has** been applied end to end to a stock
PostgreSQL 16 (with stubs for `auth.users`, `auth.uid()` and the three Supabase
roles), and on that server the ordering guard, the grants and the advisory-lock
blocking were observed rather than assumed — the header of the verification
block in the file lists exactly what was seen. What that cannot cover is
Supabase itself: different function ownership, PostgREST rather than psql, a
real `auth.uid()`, and RLS evaluated for roles that actually exist. So the
numbered queries at the end of the file still have to be run **against the
project**. The test suites in `apps/web` emulate both functions; each emulation
says so in its header.

The two queries that are security properties rather than conveniences:

- **Query 2** — `has_function_privilege` for `anon` and `authenticated` on both
  functions must be **false**. If either is true, a signed-in user can grant
  themselves Team, or spend a stranger's hardware allowance.
- **Query 3** — two concurrent sessions, limit 1: the second call must *block*
  on the first's advisory lock and then return `reserved = f`. If it returns
  `reserved = t` immediately, the atomic quota is not atomic.

Query 8 is the one that matters most and is the easiest to get wrong when
reading the output: a user's `update subscriptions set plan_id='team'` must
affect **zero rows**. RLS with no `UPDATE` policy does not raise — it silently
matches nothing — so "no error" is not the thing to check for.

Also worth a cron of its own: query 5 lists `settlement = 'unmatched'` usage
rows — jobs that may exist at a provider and cannot be polled here.

---

## 10. Files

| Path | Role |
| --- | --- |
| `apps/web/lib/plans.ts` | Pure plan/feature/limit contract, shared by client and server. |
| `apps/web/lib/plans.test.ts` | Grant/refuse coverage plus the copy-vs-entitlement invariants above. |
| `apps/web/lib/billing/stripe.ts` | Lazy Stripe client, price-id lookup both ways, `APP_URL`. |
| `apps/web/lib/billing/entitlements.ts` | Resolution layer + `requireFeature` + 402 helper. |
| `apps/web/lib/billing/usage.ts` | Hardware job metering and quota assertion. |
| `apps/web/app/api/billing/checkout/route.ts` | Creates a Checkout Session. |
| `apps/web/app/api/billing/portal/route.ts` | Opens the customer portal. |
| `apps/web/app/api/billing/webhook/route.ts` | Stripe's push path: signature, dispatch, idempotency ledger (§4). |
| `apps/web/app/api/billing/entitlement/route.ts` | Read-only entitlement for the UI. |
| `apps/web/lib/billing/period.ts` | The quota window: subscription anchor, calendar-month fallback (§7). |
| `apps/web/lib/billing/subscription.ts` | The only writer of `subscriptions`: Stripe→row mapping, ordering stamp, event ledger. |
| `apps/web/lib/billing/reconcile.ts` | Pull the truth back from Stripe (§8). |
| `apps/web/app/api/billing/reconcile/route.ts` | Self-service and operator reconciliation. |
| `supabase/schema-billing.sql` | Tables, indexes, RLS, `updated_at` trigger, the atomic quota and webhook-ordering functions, and the verification queries (§9). |
| `supabase` table `hardware_bonus` | One-time engagement grants on the hardware quota (§11). |
| `apps/web/app/api/billing/hardware-bonus/route.ts` | Read-only bonus state for the quota display (§11). |

---

## 11. The engagement bonus — "use it, earn more"

A **Pro** account that consumes its **50th hardware job within a subscription
year** earns a **one-time bonus of +25 jobs**. The mechanic borrows IBM-style
engagement pricing: the customers who actually exercise the expensive feature
are the ones a bonus retains, and a bonus that triggers on the 50th job cannot
be farmed by an idle account.

### Semantics, precisely

* **Who**: accounts whose monthly hardware allowance is the Pro allowance
  (50). Team and Edu allowances are already sized for heavy use; Free has no
  allowance. Eligibility is decided in `lib/billing/usage.ts`
  (`bonusEligible`), not by the caller.
* **When**: on the reservation that is the 50th job counted over the trailing
  365 days (the code's working definition of "subscription year" — the usage
  layer never sees a yearly billing anchor, and a rolling year can only ever
  grant *later* than an anchored one, never twice).
* **What**: a row in `public.hardware_bonus`, written by
  `reserve_hardware_job` itself. The grant raises the effective limit **of the
  usage window it lands in** by 25 — and only that window — so the mechanic
  hands out at most 25 extra jobs per grant, and at most one grant per
  subscription year.
* **Atomicity**: the grant check, the once-per-year latch (the existence of a
  grant row newer than the year start) and the count+insert all run under the
  same per-user advisory lock inside `reserve_hardware_job`. Two simultaneous
  50th-job submissions cannot double-grant, and a refusal cannot miss a bonus
  granted a millisecond earlier. Verification query 9 in
  `supabase/schema-billing.sql` demonstrates all of it against a live server.
* **Display**: `GET /api/billing/hardware-bonus` reports the caller's active
  grant so the account page can widen the meter and say why. Like the
  entitlement route, it is a courtesy and **not a gate** — the enforcing check
  is inside the SQL function on every submission.

### What this deliberately is not

* Not a plan change: the `Entitlement` shape and `lib/plans.ts` are untouched.
  The bonus is a property of the usage *window*, not of the plan, which is why
  it lives in the usage layer end to end.
* Not retroactive or transferable: it never refunds jobs already run and never
  moves between windows or users.
* Not marketing copy: the pricing page does not promise it. A mechanic that
  exists as a surprise-and-delight grant can be tuned or removed without
  breaking an advertised claim; the moment it is advertised it becomes a
  `highlights` line and must obey §3's rules.

### Migration note

This version of `reserve_hardware_job` **changes the function's return type**
(two bonus columns), so `schema-billing.sql` drops the old five-argument
function and creates the eight-argument one. A deployment running new
application code against the *old* function gets PostgREST's "no such
function", which `lib/billing/usage.ts` already treats as "fall back to the
legacy insert-then-count path and log the file to run" — quota enforcement
stays up (minus atomicity and the bonus) until the SQL is applied.

## Store apps: no purchase entry points

Google Play's payments policy and App Store guideline 3.1.1 refuse apps that sell
digital subscriptions through an outside checkout. Both store apps are shells
around this site, so inside them the site hides every way to buy: every link to
`/pricing`, "See plans" / "Upgrade" buttons, the search palette's pricing entry,
and the plan cards, prices and FAQ on `/pricing` itself (which shows a neutral
"Subscriptions are not sold in the app" note instead). Purchases stay on the
website; the apps reflect whatever plan the account has.

* Detection: `apps/web/lib/app-shell.ts` (`STORE_APP_SCRIPT`, run before first
  paint by `components/ui/StoreAppScript.tsx`) marks `<html data-store-app>` when
  the user agent carries `Qubit16App` (iOS), the referrer is
  `android-app://ai.qubit16.app`, or the URL has `?app=android` **and** the user
  agent is Android **and** the page is in an installed-app display mode
  (`standalone` or `fullscreen`, which a TWA matches and an ordinary browser tab
  does not). `?app=ios` is **not** honoured at all — the iOS app is identified by
  its user-agent token — and `?app=android` in a normal browser tab does nothing,
  so a shared `/pricing?app=android` link cannot hide the purchase path for other
  visitors. It is remembered in `sessionStorage` for that app session only.
* Hiding: one CSS rule in `app/globals.css`, so a new `/pricing` link anywhere is
  covered automatically. Use `data-store-hide` for a whole phrase or block, and
  `data-store-only` for in-app-only replacement text.
* Backstop: `/api/billing/checkout` and `/api/billing/portal` answer 403 to the
  iOS app's user agent (the portal allows plan changes, so it is a purchase path
  too). The Android app is real Chrome and cannot be told apart server-side.
* The account page's "Manage billing" button (and the status line it renders)
  carries `data-store-hide`, and is rendered only when the entitlement route
  reports `billingEnabled` — so it is absent in the store apps and on a
  deployment with Stripe off. Guarded by `lib/billing/accountPage.test.ts`.
* Tests: `apps/web/lib/app-shell.store.test.ts`.
