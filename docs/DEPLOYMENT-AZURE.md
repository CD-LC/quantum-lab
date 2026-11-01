# Deploying Quantum Lab to Azure (Container Apps)

Picked because your AWS account's compute provisioning is stuck behind
"account verification in progress" (CloudShell, and possibly App Runner
too — unconfirmed). This is an alternative cloud, not a replacement for
the AWS kit in `infra/aws/` — that stays valid for whenever AWS clears up.

**Verified in production (October 2026):** the resource group, registry,
Container Apps environment and three apps this script creates are what serves
qubit16.ai, and its image build and rollout steps are the ones
`.github/workflows/deploy.yml` runs on every green `main`. Every step
checks-then-creates, so it's safe to re-run if one step fails partway — fix
that step's issue and run the script again.

## Why Container Apps, not AWS App Runner's closest Azure equivalent

Azure Container Apps **can scale to zero replicas**. AWS App Runner
cannot — that's the entire reason the AWS deployment carries a ≈$15/month
floor no matter how little traffic it gets (docs/DEPLOYMENT-AWS.md §1).
With zero real users, scale-to-zero removes that floor almost entirely —
but as of the change described below, only `agent` actually uses it.
`api` and `web` are both pinned always-on; see the trade-off section.

## What the script does

1. Resource group + Basic-tier Container Registry (ACR)
2. Builds all 3 images **in Azure itself** via `az acr build` — this is
   the other reason this path is worth it while your AWS account is
   blocked: it needs **no local Docker install**, only the `az` CLI.
3. Container Apps environment (Consumption plan)
4. Deploys `api` (`--min-replicas 1 --max-replicas 1`) and `agent`
   (`--min-replicas 0 --max-replicas 1`), smallest valid size (0.25 vCPU /
   0.5 GiB — Container Apps' actual minimum, smaller than App Runner's
   smallest tier). `api` is kept warm on purpose — see the trade-off
   section below.
5. Rebuilds `web` with the real api/agent URLs baked in (same two-pass
   trick as the AWS script, for the same reason: Next's `NEXT_PUBLIC_*`
   vars are compiled in at build time, not read at runtime), and deploys it
   also `--min-replicas 1 --max-replicas 1` — kept warm for the same reason
   as `api`, see the trade-off section below.
6. Wires `ALLOWED_ORIGINS` on api + agent to the real web URL
7. Attempts a $50/mo cost budget alert (Azure Cost Management budgets via
   CLI need a specific role; if it fails, the script tells you the portal
   fallback rather than silently skipping)
8. Prints the 3 live `*.azurecontainerapps.io` URLs with curl health checks

No custom domain anywhere in this — same as the AWS kit, per your
instruction. You get working HTTPS URLs on Azure's own domain.

## Running it

From any shell with the Azure CLI installed (your machine, or Azure Cloud
Shell — Azure's Cloud Shell has historically not shown the same new-account
compute-provisioning delay AWS CloudShell just did, though that isn't
something this session could verify against your specific account):

```bash
az login
cd quantum-lab
bash infra/azure/deploy.sh
```

It never stops to ask you anything — apart from Supabase (baked into the
client bundle at build time, so it has no runtime path), every optional
integration including the LLM keys is configurable after the fact at
`/admin/platform`, with no redeploy needed. To wire a key in from the start
instead, set `GEMINI_KEY` / `GROQ_KEY` / `ANTHROPIC_KEY` as env vars or in
`infra/azure/.env.production` before running — cheapest-first, same as the
AWS script.

To install the Azure CLI on Windows: https://aka.ms/installazurecliwindows
(an MSI installer, no admin terminal gymnastics).

### Wiring the optional integrations (accounts, billing, email, hardware…)

Everything beyond the simulator, visualizations and offline tutor is opt-in
and switched on by credentials. There is one place to put them:

```bash
cp infra/azure/.env.production.example infra/azure/.env.production
# fill in what you have; leave the rest blank
bash infra/azure/deploy.sh
```

`deploy.sh` loads that (gitignored) file, bakes the `NEXT_PUBLIC_*` values
into the web image, and in step 7b wires every non-blank value onto the
right container app as a secret referenced by env var — so `az containerapp
show` never prints a value. The template documents, per block, what each
integration switches on and where the value comes from: Supabase for
sign-in/sync/exams/orgs (run the `supabase/` schema files first), Stripe
for billing, Resend for email, Sentry for error tracking, Upstash for
cross-replica rate limits, `HEALTH_DEEP_TOKEN` for the deep health probe,
IBM/AWS tokens for real hardware, and Azure OpenAI as a fourth tutor
provider. Blank values are skipped, never cleared.

Re-running the script is the way to add a credential later. Three things
that used to break on re-runs are fixed: the public URL baked into the web
image is now detected from the bound custom domain (it used to revert to
blank, undoing `attach-domain.sh`); `ALLOWED_ORIGINS` keeps the custom
domain instead of replacing it with the `azurecontainerapps.io` URL; and
LLM-key secrets are created on the update path, not only on first create.

Verify what is actually live afterwards with the deep health probe:

```bash
curl -s "https://qubit16.ai/api/health?deep=1&token=$HEALTH_DEEP_TOKEN"
```

## Cost breakdown — estimates, not measurements

Pricing as published August 2026, `eastus`. Assumes pre-launch, ~zero real
traffic — the same assumption as the AWS minimal-sizing doc.

| Item | Est. / month | Why |
| --- | --- | --- |
| Container Registry (Basic) | **≈ $5.00** | Flat $0.167/day regardless of usage. The one real fixed floor. |
| Container Apps — `api` compute (always-on) | **≈ $10–15** | `--min-replicas 1`: one 0.25 vCPU / 0.5 GiB replica runs continuously, billed the full month regardless of traffic. Chosen deliberately — see the trade-off section below. |
| Container Apps — `web` compute (always-on) | **≈ $10–15** | `--min-replicas 1`, same reasoning as `api` — see the trade-off section below. Was `min-replicas 0` originally; moved always-on once the cold-reload tax was measured hitting real visitors on infrequently-visited routes. |
| Container Apps — `agent` compute | **$0 at idle** | Stays `min-replicas 0` — Consumption plan bills per vCPU-second and GiB-second *only while a replica is running*, so no running replica means no charge when nothing's hitting that URL. |
| Container Apps — active compute (agent) | **$0–3** | Near-zero real traffic expected pre-launch; a full month of occasional health-checks/smoke-tests is still low cents. |
| Log Analytics (Container Apps environment) | **$0–2** | First 5 GB/mo free tier typically covers this volume of logs. |
| Data transfer out | **$0–1** | Azure's egress free tier + near-zero real traffic. |
| **Azure subtotal** | **≈ $25–36** | Still roughly in line with AWS's ≈ $17–28 — the gap narrowed further once `web` also moved off scale-to-zero. |
| Supabase / Upstash / Resend / Stripe | same as AWS doc | Unchanged — these aren't cloud-specific. |
| Anthropic/Gemini/Groq API | $0–5 | Cheapest-first gateway; same as AWS doc. |

**Realistic total: ≈ $25–45/month** while there are no real users.

## The trade-off, stated plainly

Scale-to-zero isn't free in the way that matters for a product, only in
the way that matters for a bill: the **first** request after any idle
period pays a cold-start cost — pulling the image and starting the
process. `agent` (still `min-replicas 0`) pays that: a few seconds on the
first hit after idle, then normal-speed until it scales back down. Its
traffic is low enough, and its failure mode gentle enough (a slower first
tutor reply, not a broken page), that this is still the right trade for it.

`api` used to work the same way, except its cold start was worse: on top
of the container boot, `api` imports qiskit/aer, a notably slow import,
and its own `/api/health` probe runs a real circuit through it — measured
at **~5 seconds** in production. That was reported as the service feeling
"stuck" or "not loading," and traded away deliberately: `api` now runs
`--min-replicas 1`, so it's never cold. In exchange it picks up the
always-on floor described in the cost table above (≈$10-15/mo) — worth it
once real cold-start latency is bothering an actual visitor.

`web` moved the same direction for a related but distinct reason. It never
had `api`'s import-cost problem, but the site itself grew — from roughly 30
routes when `web` was first sized to over 100 across three later content
waves — on the same 0.25 vCPU container and the same `min-replicas 0`.
Measured directly against production (browser Navigation/Resource Timing,
not guessed): a route not hit within Next's own ~5-minute route-cache
window pays a real reload tax on its next click — up to ~2.2s observed on
a content-heavy page, against 300-550ms for a route hit recently. Reported
as "the app is so slow ... on click of different modules," which is exactly
the symptom a per-route cache/cold-container tax produces: fast for
whatever was just visited, slow for whatever wasn't. `web` now also runs
`--min-replicas 1`.

If the always-on cost ever needs to come back down, flip `api` and/or
`web` back to `--min-replicas 0 --max-replicas 1` in
`infra/azure/deploy.sh` and re-run it — cold starts return, along with the
near-$0-at-idle cost. The same lever runs the other way on `agent`, for
whenever there's a demo, a paying customer, or an SLA to hit.

## Teardown

Everything lives in one resource group, so cleanup is one command:

```bash
az group delete -n quantum-lab-rg --yes --no-wait
```

This deletes the registry, the images in it, and all three container
apps — irreversible, and stops billing immediately.

## CD from GitHub Actions

`.github/workflows/deploy.yml` ships the latest `main` after CI is green: it builds only the
services whose source changed and points the Container App at the new image. It does **not** manage
secrets or env vars — that stays with `infra/azure/deploy.sh`. It is off until you set it up once:

**Shortcut: `bash infra/azure/setup-github-oidc.sh` does steps 1, 2 and 5; steps 3 and 4 are already done.**

1. Create an Entra app registration with a **federated credential** for
   `repo:cdandlc/quantum-lab:environment:production`, and give its
   service principal `Contributor` on resource group `quantum-lab-rg` (that covers `az acr build`
   and `az containerapp update`).
2. Repository **secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
3. Repository **variables** (these are public values, they end up in the browser bundle):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optionally
   `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_LAUNCH_TRIAL_DAYS`, `NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL`,
   `NEXT_PUBLIC_ANALYTICS_ENDPOINT`, `NEXT_PUBLIC_DEVICE_TUTOR` — same values as `.env.production`.
4. Create a `production` environment (optionally with a required reviewer to gate each deploy).
5. Set the variable `AZURE_DEPLOY_ENABLED=true`.

The web job fails outright if the two Supabase variables are empty, and the smoke test fails if
`/account` comes back in "no accounts" mode.

**What gets deployed.** The workflow logs in to Azure first, then compares each service with the
commit its *live* image was built from (the image tag is `gh-<first 12 chars of the SHA>`), so a
multi-commit push, or a push whose CI run was cancelled by a newer one, still ships everything that
changed since production. If the live commit cannot be established (an image built by `deploy.sh`
carries a timestamp tag, the tag is unreadable, or the commit is not in the clone) that service is
deployed; a live commit already at or ahead of the commit being deployed is left alone. Pass
`services` to `workflow_dispatch` to force a subset. Not tested against a real Azure subscription;
the planning script is exercised against a stubbed `az` in `apps/web/lib/security/infraHardening.test.ts`.

**Release identifier.** The web build receives the commit as `NEXT_PUBLIC_SENTRY_RELEASE` (what
`/api/health` reports as `version` to a caller holding `HEALTH_DEEP_TOKEN`, and what Sentry tags events
with) and its first 12 characters as `NEXT_PUBLIC_BUILD_STAMP` (the service-worker cache name, so
rebuilding the same commit does not evict every installed user's cache). `deploy.sh` passes the same
two from `git rev-parse HEAD`.

**Runtime.** The web image and CI run Node 22 LTS.
