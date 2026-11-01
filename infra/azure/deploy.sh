#!/usr/bin/env bash
# Quantum Lab — one-shot Azure Container Apps deploy.
#
# Run this from ANY shell with the Azure CLI installed and `az login` already
# done — your own machine (Git Bash/PowerShell/WSL), Azure Cloud Shell, or
# this repo's CI. Unlike the AWS script, this one does NOT need Docker
# installed locally: `az acr build` builds every image in Azure itself.
#
# VERIFIED IN PRODUCTION (October 2026): the resources this script creates
# (quantum-lab-rg, the registry, the Container Apps environment and the three
# apps) serve qubit16.ai, and its `az acr build` / `az containerapp update`
# steps are the ones .github/workflows/deploy.yml runs on every green main.
# If a step's flags drift from your `az` CLI version it fails with a normal az
# error — re-run the script, it is idempotent (every resource is
# check-then-create).
#
# What it does, in order (mirrors docs/DEPLOYMENT-AZURE.md):
#   1. Creates a resource group + a Basic-tier Azure Container Registry
#   2. Builds all 3 images IN THE CLOUD via `az acr build` (no local Docker)
#   3. Creates a Container Apps environment (Consumption plan)
#   4. Deploys api as an always-on Container App (min-replicas 1 — see the
#      comment above its deploy step), smallest valid size (0.25 vCPU / 0.5 GiB)
#   5. Deploys agent always-on (min-replicas 1: a cold start outlasts the web
#      app's 25 s agent timeout), same size
#   6. Rebuilds web with real API/agent URLs baked in, deploys web also
#      always-on (min-replicas 1 — see the comment above its deploy step,
#      also 0.25 vCPU / 0.5 GiB)
#   7. Points api + agent's ALLOWED_ORIGINS at the real web URL
#   8. Tries to set a monthly cost budget alert (best-effort — some
#      subscription types reject this over the CLI; falls back to a portal
#      pointer if so)
#   9. Prints the 3 live URLs + curl checks
#
# Cost model is fundamentally different from the AWS App Runner version:
# Container Apps CAN scale to zero, so a service left at min-replicas=0 with
# no traffic bills $0 in compute. api, agent and web are all pinned to
# min-replicas=1 instead (see the comments above each deploy step for why —
# each trades ~$10-15/mo for no cold-start tax). The fixed floor is therefore
# roughly $30-45/mo (api + agent + web always-on) plus the Basic ACR (~$5/mo flat) and a small amount of
# Log Analytics ingestion (~$0-2/mo at this volume) — see
# docs/DEPLOYMENT-AZURE.md for the full breakdown.
set -euo pipefail

# On Git Bash/MSYS (Windows), any argument starting with "/" — a bare
# "/api/analytics" as a --build-arg value, for instance — gets silently
# rewritten into a Windows path (C:/Program Files/Git/api/analytics or
# similar) before the underlying program ever sees it. That corrupted a real
# `az acr build` call here, which then failed as "docker build requires
# exactly 1 argument" with no clue the real cause was an env var three steps
# removed from the error. MSYS_NO_PATHCONV=1 disables the rewrite; it is a
# no-op everywhere this script also runs (native Linux/macOS shells, Azure
# Cloud Shell, CI), since only MSYS's runtime looks at it at all.
export MSYS_NO_PATHCONV=1

# ---------------------------------------------------------------- 0. config
RESOURCE_GROUP="${RESOURCE_GROUP:-quantum-lab-rg}"
LOCATION="${LOCATION:-eastus}"
ENV_NAME="quantum-lab-env"
# ACR names must be globally unique across ALL of Azure, alphanumeric only.
#
# BUG FIXED: this used to be `ACR_NAME="${ACR_NAME:-quantumlabacr$RANDOM}"`
# unconditionally — every re-run of this script that did not explicitly
# export ACR_NAME picked a NEW random name, so a second deploy created a
# SECOND, brand-new, empty Container Registry rather than reusing the one
# from the first run. The existing `quantum-lab-api`/`agent`/`web` Container
# Apps still had credentials baked in for the OLD registry, so `az
# containerapp update --image <new-registry>/...` failed to pull with
# `UNAUTHORIZED` — not a transient Azure error, a structural one, since the
# `update` branches below (unlike `create`) never passed registry
# credentials at all and so had nothing to refresh even if they had.
# Fixed two ways: (1) if ACR_NAME is not explicitly set, look for an ACR
# already in this resource group and reuse it before falling back to a new
# random name; (2) every `az containerapp update --image` call below now
# also runs `az containerapp registry set`, so credentials are refreshed on
# every deploy regardless of how ACR_NAME was resolved.
if [ -z "${ACR_NAME:-}" ]; then
  EXISTING_ACR="$(az acr list -g "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
  if [ -n "$EXISTING_ACR" ]; then
    ACR_NAME="$EXISTING_ACR"
    echo "==> Reusing existing Container Registry in $RESOURCE_GROUP: $ACR_NAME"
  else
    ACR_NAME="quantumlabacr$RANDOM"
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ---- Deploy the COMMIT, never the working directory -----------------------
#
# WHY THIS EXISTS. Everything below hands the current directory to
# `az acr build`, which tars it and ships it to Azure. That means a deploy
# used to publish whatever happened to be on disk at that instant — including
# somebody else's half-finished edit, a file saved mid-keystroke, or a
# package.json whose new dependency was not in the lockfile yet.
#
# All three happened on 2026-09-17. A web build failed with
#
#     lib/env.ts(163,5): error TS2322: Type '"client"' is not assignable to type 'Scope'
#
# for a value that was already corrected by the time anybody read the log: the
# tar had caught the file between two keystrokes. Nothing was wrong with the
# committed tree, and nothing in the error said so.
#
# A fourth, worse one: bash reads a script LAZILY, by byte offset. Editing
# deploy.sh while deploy.sh is running makes it resume at the wrong offset and
# execute garbage. Re-running from a pristine checkout fixes that too, because
# the script that runs is the committed one.
#
# So: check out HEAD into a throwaway worktree and re-exec there. What gets
# deployed is exactly what `git show HEAD` says, every time.
#
# `git worktree` rather than `git clone`: no network, no second object store,
# and it can pin an exact commit. On this repo it takes about a second.
#
# UNCOMMITTED WORK IS NOT DEPLOYED, and that is the entire point — but it is
# announced loudly rather than silently dropped, because "I deployed and my
# change is not there" is a horrible ten minutes.
#
# Escape hatch: DEPLOY_FROM_WORKTREE=0 deploys the working directory, the old
# behaviour, for somebody bisecting a build failure who needs to edit and
# retry without committing. It prints what it is doing.
if [ "${DEPLOY_FROM_WORKTREE:-1}" = "1" ] && [ -z "${QLAB_DEPLOY_WORKTREE:-}" ]; then
  if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "==> Not a git repository — deploying this directory as-is."
  else
    DEPLOY_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    DEPLOY_SUBJECT="$(git -C "$REPO_ROOT" log -1 --pretty=%s)"

    # `--porcelain` covers staged, unstaged AND untracked. Untracked matters:
    # a new file that the build imports is just as absent from HEAD as an edit.
    DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)"

    echo "==> Deploying commit $(printf '%.12s' "$DEPLOY_SHA")  $DEPLOY_SUBJECT"
    if [ -n "$DIRTY" ]; then
      echo ""
      echo "    !! YOUR WORKING TREE HAS UNCOMMITTED CHANGES AND THEY ARE NOT"
      echo "       BEING DEPLOYED. The commit above is. Files not included:"
      printf '%s\n' "$DIRTY" | sed 's/^/         /' | head -20
      COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"
      [ "$COUNT" -gt 20 ] && echo "         ... and $((COUNT - 20)) more"
      echo ""
      echo "       Commit them and re-run, or set DEPLOY_FROM_WORKTREE=0 to"
      echo "       deploy this directory as it is."
      echo ""
    fi

    WORKTREE="$(mktemp -d 2>/dev/null || mktemp -d -t qlab)/deploy"

    # Removed on EVERY exit path, including a failed build and a Ctrl-C.
    # `git worktree remove` first so git's own administrative record goes with
    # it; `rm -rf` as the backstop for the case where the directory is gone but
    # the record is not. Neither is allowed to fail the deploy.
    cleanup_worktree() {
      git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
      rm -rf "$(dirname "$WORKTREE")" >/dev/null 2>&1 || true
    }
    trap cleanup_worktree EXIT INT TERM

    echo "==> Checking out $(printf '%.12s' "$DEPLOY_SHA") into a clean worktree"
    if ! git -C "$REPO_ROOT" worktree add --detach --quiet "$WORKTREE" "$DEPLOY_SHA"; then
      echo "!! Could not create a clean worktree. Refusing to deploy the working"
      echo "   directory silently — re-run with DEPLOY_FROM_WORKTREE=0 if that is"
      echo "   really what you want."
      exit 1
    fi

    # Gitignored by design and required by the deploy: the worktree has no copy.
    # Only this one file — anything else the build needs must be committed, and
    # discovering otherwise here is the point.
    if [ -f "$REPO_ROOT/infra/azure/.env.production" ]; then
      cp "$REPO_ROOT/infra/azure/.env.production" "$WORKTREE/infra/azure/.env.production"
      echo "==> Carried infra/azure/.env.production into the worktree"
    fi

    # Re-exec THE WORKTREE'S OWN COPY of this script. That is deliberate: the
    # committed deploy.sh is what runs, so an edit to this file in the working
    # directory cannot affect a deploy either.
    QLAB_DEPLOY_WORKTREE="$WORKTREE" \
      bash "$WORKTREE/infra/azure/deploy.sh"
    STATUS=$?
    cleanup_worktree
    trap - EXIT INT TERM
    exit $STATUS
  fi
elif [ "${DEPLOY_FROM_WORKTREE:-1}" != "1" ] && [ -z "${QLAB_DEPLOY_WORKTREE:-}" ]; then
  echo "==> DEPLOY_FROM_WORKTREE=0 — deploying this working directory, uncommitted changes included."
fi

# ---- Optional production secrets, one file -------------------------------
# infra/azure/.env.production (gitignored; template alongside it) holds every
# OPTIONAL integration's credentials — accounts, billing, email, error
# tracking, hardware providers, the health/webhook secrets. Anything set here
# (or already exported in the shell) is wired onto the right container app
# in step 7b below as a secret + secretref env var; anything left blank is
# simply not wired, and the app keeps its documented fallback for that
# feature. This is what turns "the code supports it" into "it is on in prod".
ENV_FILE="${ENV_FILE:-$REPO_ROOT/infra/azure/.env.production}"
if [ -f "$ENV_FILE" ]; then
  echo "==> Loading optional production secrets from $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
fi

# NEXT_PUBLIC_* are compiled into the web bundle (and into the CSP of every
# prerendered page), so a build with them empty ships a site where nobody can
# sign in — silently, because the app degrades to "local storage, no accounts"
# by design. Observed in production 2026-10-03/05: a deploy run without
# .env.production produced exactly that. Refuse rather than ship it.
if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] || [ -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]; then
  if [ "${ALLOW_NO_ACCOUNTS:-0}" != "1" ]; then
    echo "!! NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are empty."
    echo "   Building now would ship a site with sign-in switched off."
    echo "   Put them in $ENV_FILE, or set ALLOW_NO_ACCOUNTS=1 if that is intended."
    exit 1
  fi
fi

echo "==> Checking az login"
az account show >/dev/null 2>&1 || { echo "!! Not logged in. Run: az login"; exit 1; }
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
echo "==> Subscription: $SUBSCRIPTION_ID   Region: $LOCATION"

echo "==> Registering required resource providers (safe to re-run, usually instant if already done)"
az provider register --namespace Microsoft.App --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null 2>&1 || true
az provider register --namespace Microsoft.ContainerRegistry --wait >/dev/null 2>&1 || true

echo "==> Container Apps CLI extension"
az extension add --name containerapp --upgrade -y >/dev/null 2>&1 || true

# --------------------------------------------------------------- 1. RG + ACR
echo "==> Resource group: $RESOURCE_GROUP"
az group show -n "$RESOURCE_GROUP" >/dev/null 2>&1 \
  || az group create -n "$RESOURCE_GROUP" -l "$LOCATION" >/dev/null

echo "==> Container Registry: $ACR_NAME (Basic tier, ~\$5/mo flat — the one fixed floor cost)"
if ! az acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create -n "$ACR_NAME" -g "$RESOURCE_GROUP" --sku Basic --admin-enabled true >/dev/null
fi
ACR_LOGIN_SERVER="$(az acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" --query loginServer -o tsv)"
ACR_USER="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASS="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
TAG="$(date +%Y%m%d%H%M%S)"
echo "==> Image tag: $TAG"

# ------------------------------------------------------ 2. cloud-side builds
#
# acr_build_async queues a build with --no-wait and polls its status instead
# of letting `az acr build` stream the live build log to this terminal.
# WHY: `az acr build`'s log streaming pipes through colorama, which on a
# default Windows console (codepage cp1252, not UTF-8) crashes with
# `UnicodeEncodeError: 'charmap' codec can't encode characters...` the
# moment Docker's build output contains a character cp1252 can't represent
# (observed in practice on this repo's Python builder stage). The build
# itself is unaffected — it runs on Azure regardless of whether the local
# CLI can print its logs — so streaming was never load-bearing; only
# watching it live was. Polling sidesteps the crash entirely, on every
# platform, not just Windows.
acr_build_async() {
  local image="$1" dockerfile="$2" context="$3"; shift 3
  local build_args=("$@")
  local cmd=(az acr build -r "$ACR_NAME" -g "$RESOURCE_GROUP" -t "$image")
  [ -n "$dockerfile" ] && cmd+=(-f "$dockerfile")
  local ba
  for ba in "${build_args[@]:-}"; do
    [ -n "$ba" ] && cmd+=(--build-arg "$ba")
  done
  cmd+=(--no-wait "$context")
  "${cmd[@]}" >/dev/null
  sleep 3
  local run_id
  run_id="$(az acr task list-runs -r "$ACR_NAME" --top 1 --query "[0].runId" -o tsv)"
  echo "   queued run $run_id for $image"
  local status="Queued" waited=0
  while [ "$status" != "Succeeded" ] && [ "$status" != "Failed" ] \
        && [ "$status" != "Error" ] && [ "$status" != "Canceled" ]; do
    sleep 15
    waited=$((waited + 15))
    status="$(az acr task show-run -r "$ACR_NAME" --run-id "$run_id" --query status -o tsv 2>/dev/null || echo "$status")"
    echo "   [${waited}s] $image build status: $status"
    if [ "$waited" -gt 1800 ]; then
      echo "!! Timed out after 30 minutes waiting for $image. Check: az acr task logs -r $ACR_NAME --run-id $run_id"
      exit 1
    fi
  done
  if [ "$status" != "Succeeded" ]; then
    echo "!! ACR build of $image ended with status: $status"
    echo "   Full logs: az acr task logs -r $ACR_NAME --run-id $run_id"
    exit 1
  fi
  echo "   $image build succeeded"
}

# BUG FIX (see the ACR_NAME comment above): `az containerapp update --image`
# does NOT accept --registry-server/--registry-username/--registry-password
# and never refreshes a Container App's stored registry credentials — those
# are set once, on `create`, and otherwise untouched. If the ACR being
# pulled from ever differs from the one the app was created against (a stale
# ACR_NAME, a rotated admin password, a manually recreated registry), every
# subsequent `update --image` fails to pull with UNAUTHORIZED, and the error
# gives no hint that credentials are the cause. Call this immediately before
# every `containerapp update --image` below so every deploy is self-healing
# regardless of why the credentials might be stale.
refresh_registry_creds() {
  local app="$1"
  az containerapp registry set -n "$app" -g "$RESOURCE_GROUP" \
    --server "$ACR_LOGIN_SERVER" --username "$ACR_USER" --password "$ACR_PASS" >/dev/null
}

echo "==> Building services/api in the cloud (az acr build, queued + polled)"
acr_build_async "quantum-lab/api:$TAG" "services/api/Dockerfile" "services/api"

echo "==> Building services/agent in the cloud"
acr_build_async "quantum-lab/agent:$TAG" "services/agent/Dockerfile" "services/agent"

echo "==> Building apps/web pass 1 (placeholder NEXT_PUBLIC_* — real ones baked in at step 5)"
acr_build_async "quantum-lab/web:$TAG" "apps/web/Dockerfile" "."

# ------------------------------------------------------ 3. Container Apps env
echo "==> Container Apps environment: $ENV_NAME"
az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1 \
  || az containerapp env create -n "$ENV_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" >/dev/null

# ------------------------------------------------- cheapest-first LLM keys
# Same order as infra/aws/deploy.sh — see docs/LLM-GATEWAY.md.
#
# NON-INTERACTIVE ON PURPOSE. This used to `read -r -p` for a key at the
# terminal when none was set (guarded by `[ -t 0 ]` so it never blocked a
# non-interactive run). Removed: apart from Supabase (NEXT_PUBLIC_* is baked
# into the client bundle at build time, so it genuinely cannot be changed
# after a deploy without rebuilding), every piece of config this script
# handles already has a real runtime path that doesn't need this script
# re-run at all — LLM keys specifically are the ENV LAYER only, and a
# platform admin (PLATFORM_ADMIN_EMAILS) can add, replace, test and remove
# them, and set what signed-out/free/trial/paid learners get, at
# /admin/platform. A deploy should never have to stop and ask a question a
# UI already answers. Set GEMINI_KEY/GROQ_KEY/ANTHROPIC_KEY as env vars or in
# infra/azure/.env.production if you want one wired in from the start;
# otherwise this deploys straight through with the tutor on its offline tier.
GEMINI_KEY="${GEMINI_KEY:-}"
GROQ_KEY="${GROQ_KEY:-}"
ANTHROPIC_KEY="${ANTHROPIC_KEY:-}"
if [ -z "$GEMINI_KEY" ] && [ -z "$GROQ_KEY" ] && [ -z "$ANTHROPIC_KEY" ]; then
  echo "   No LLM key in the env file or environment — deploying with the tutor on its"
  echo "   offline tier. Add one anytime at https://<your-domain>/admin/platform (needs"
  echo "   PLATFORM_ADMIN_EMAILS) with no redeploy needed, or set GEMINI_KEY / GROQ_KEY /"
  echo "   ANTHROPIC_KEY in infra/azure/.env.production and re-run this script."
fi

if [ -n "$GEMINI_KEY" ]; then
  AGENT_MODEL="gemini/gemini-2.5-flash"; WEB_TUTOR_MODEL="gemini-2.5-flash"
elif [ -n "$GROQ_KEY" ]; then
  AGENT_MODEL="groq/llama-3.3-70b-versatile"; WEB_TUTOR_MODEL="llama-3.3-70b-versatile"
elif [ -n "$ANTHROPIC_KEY" ]; then
  AGENT_MODEL="anthropic/claude-sonnet-4-6"; WEB_TUTOR_MODEL="claude-sonnet-4-6"
else
  AGENT_MODEL="gemini/gemini-2.5-flash"; WEB_TUTOR_MODEL=""
fi

# ---- The api/web shared secret -------------------------------------------
#
# THIS USED TO BE `API_SHARED_SECRET="$(openssl rand -hex 32)"`, unconditionally,
# on every run. Two services hold this value — the api (as API_SHARED_SECRET)
# and the web container (as QUANTUM_API_SECRET) — and they are deployed one
# after the other, api first. So every single deploy rotated the secret and then
# spent the several minutes between the two updates with the web container
# presenting a value the api no longer accepted. Every proxied hardware call
# returned "This API requires a shared secret" for that whole window, on a
# deploy that may have changed nothing but a paragraph of copy. Observed in
# production on 2026-09-17.
#
# Two things were wrong and both are fixed:
#
#   1. ROTATION WAS A SIDE EFFECT OF SHIPPING. It is now opt-in. An ordinary
#      deploy does not touch the secret at all — neither container's copy is
#      rewritten, so they cannot drift apart and there is no window. Rotating a
#      credential is a deliberate operation with a cost; paying that cost to
#      deploy a CSS change bought nothing.
#
#   2. ROTATION ITSELF HAD NO SAFE ORDERING. With one accepted value, whichever
#      service you update first is wrong until the other catches up — updating
#      web first just inverts which side 401s. services/api now accepts a
#      COMMA-SEPARATED LIST (app/core/security.py), so a rotation can run as an
#      overlap: teach the api both values, move web to the new one, then retire
#      the old. No step in that sequence refuses a correctly-configured caller.
#
# To actually rotate:
#
#     ROTATE_API_SECRET=1 bash infra/azure/deploy.sh
#
ROTATE_API_SECRET="${ROTATE_API_SECRET:-0}"

# Non-empty ONLY when this run must write a secret value. Empty on an ordinary
# re-deploy, and every `secret set` below is skipped when it is empty — which
# is what makes an ordinary deploy incapable of desynchronising the two sides.
API_SECRET_NEW=""
# "<old>,<new>" during a rotation: what the api is taught to accept while web
# is still on the old value. Empty otherwise.
API_SECRET_OVERLAP=""

if ! az containerapp show -n quantum-lab-api -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  # First deploy. Nothing is live, so there is no window to protect.
  API_SECRET_NEW="$(openssl rand -hex 32)"
  echo "==> Shared secret: generating one (first deploy)"
elif [ "$ROTATE_API_SECRET" = "1" ]; then
  # Read the live value so the overlap can contain it. It is used to build the
  # overlap string and is never echoed.
  API_SECRET_OLD="$(az containerapp secret show -n quantum-lab-api -g "$RESOURCE_GROUP"     --secret-name api-shared-secret --query value -o tsv 2>/dev/null || true)"
  API_SECRET_NEW="$(openssl rand -hex 32)"
  if [ -n "$API_SECRET_OLD" ]; then
    API_SECRET_OVERLAP="$API_SECRET_OLD,$API_SECRET_NEW"
    echo "==> Shared secret: ROTATING via an overlap window (old and new both accepted, then old retired)"
  else
    # The api exists but has no readable secret — it was deployed before this
    # existed, or the read was refused. There is nothing to overlap WITH, so
    # this degrades to the old behaviour. Say so, because it means this one
    # run does have a brief window.
    echo "==> Shared secret: ROTATING, but the current value could not be read."
    echo "    No overlap is possible, so hardware calls will 401 until web updates."
  fi
else
  echo "==> Shared secret: reusing the deployed value (pass ROTATE_API_SECRET=1 to rotate)"
fi

# --------------------------------------------------------------- 4. api
# min-replicas=1 (not 0) is a deliberate exception to this file's
# scale-to-zero-everywhere default. The api container imports Qiskit/Aer at
# startup and /api/health runs a real probe circuit through it — a cold
# request pays for both the container boot AND that import, which measured
# ~5s in production. That was surfaced as "it takes too long to load, even
# after being idle for a bit" and traded away deliberately: one always-on
# 0.25 vCPU / 0.5 GiB replica costs roughly $10-15/mo, in exchange for the
# api never cold-starting. agent is pinned always-on below as well: its cold
# start outlasts the web app's 25 s agent timeout.
#
# web used to be scale-to-zero here too, on the reasoning that Next.js has no
# Qiskit-style import cost. That reasoning held when the site was ~30 routes;
# it stopped holding once three content waves grew it past 100 routes on the
# same 0.25 vCPU container. Measured directly against production (browser
# Navigation/Resource Timing, not guessed): a page not hit in the last
# ~5 minutes (Next's own route-cache staleness window, see x-nextjs-stale-time)
# pays a real reload tax on its next click — up to ~2.2s observed on a
# content-heavy route, driven by large per-route JS chunks and/or a cold
# container, vs. 300-550ms for a route hit recently. Surfaced as "the app is
# so slow ... on click of different modules". Same fix as api's, and the same
# ~$10-15/mo trade: min-replicas=1 below.
echo "==> Deploying services/api (min-replicas 1 — see comment above; 0.25 vCPU / 0.5 GiB)"
# On first deploy this carries the generated value. On an ordinary re-deploy
# API_SECRET_NEW is empty and the array is never used, because nothing below
# writes the secret unless there is a value to write.
API_SECRETS=(api-shared-secret="${API_SECRET_OVERLAP:-$API_SECRET_NEW}")
API_ENV_VARS=(API_SHARED_SECRET=secretref:api-shared-secret ALLOWED_ORIGINS=http://localhost:3000)

if ! az containerapp show -n quantum-lab-api -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp create \
    -n quantum-lab-api -g "$RESOURCE_GROUP" --environment "$ENV_NAME" \
    --image "$ACR_LOGIN_SERVER/quantum-lab/api:$TAG" \
    --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --target-port 8000 --ingress external \
    --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets "${API_SECRETS[@]}" \
    --env-vars "${API_ENV_VARS[@]}" \
    >/dev/null
else
  refresh_registry_creds quantum-lab-api
  # STEP 1 OF THE ROTATION, and ONLY when rotating.
  #
  # An ordinary deploy skips this entirely: the api keeps the secret it already
  # has, web keeps the matching one, and the two cannot drift apart. This
  # `if` is the whole fix for the every-deploy outage.
  #
  # When rotating, what is written here is the OVERLAP — "<old>,<new>" — so the
  # api accepts both while web is still on the old value. Web moves to the new
  # value further down, and the old one is retired after that.
  if [ -n "${API_SECRET_OVERLAP:-}" ] || [ -n "$API_SECRET_NEW" ]; then
    az containerapp secret set -n quantum-lab-api -g "$RESOURCE_GROUP" --secrets "${API_SECRETS[@]}" >/dev/null
  fi
  az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
    --image "$ACR_LOGIN_SERVER/quantum-lab/api:$TAG" \
    --set-env-vars API_SHARED_SECRET=secretref:api-shared-secret \
    --min-replicas 1 --max-replicas 1 >/dev/null
fi
API_FQDN="$(az containerapp show -n quantum-lab-api -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
API_URL="https://$API_FQDN"
echo "==> api: $API_URL"
curl -s -o /dev/null -w "   /api/health -> %{http_code}\n" "$API_URL/api/health" || true

# --------------------------------------------------------------- 5. agent
# min-replicas 1, not 0: a scale-from-zero cold start (image pull + Python +
# model client import) always exceeds the web app's 25 s agent timeout, so the
# first tutor question after any idle spell fell through to the offline FAQ.
echo "==> Deploying services/agent (min-replicas 1, 0.25 vCPU / 0.5 GiB)"
AGENT_SECRETS=()
AGENT_ENV_VARS=(MODEL="$AGENT_MODEL" ALLOWED_ORIGINS=http://localhost:3000)
[ -n "$GEMINI_KEY" ]    && AGENT_SECRETS+=(gemini-api-key="$GEMINI_KEY")    && AGENT_ENV_VARS+=(GEMINI_API_KEY=secretref:gemini-api-key)
[ -n "$GROQ_KEY" ]      && AGENT_SECRETS+=(groq-api-key="$GROQ_KEY")       && AGENT_ENV_VARS+=(GROQ_API_KEY=secretref:groq-api-key)
[ -n "$ANTHROPIC_KEY" ] && AGENT_SECRETS+=(anthropic-api-key="$ANTHROPIC_KEY") && AGENT_ENV_VARS+=(ANTHROPIC_API_KEY=secretref:anthropic-api-key)

if ! az containerapp show -n quantum-lab-agent -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  CREATE_ARGS=(-n quantum-lab-agent -g "$RESOURCE_GROUP" --environment "$ENV_NAME"
    --image "$ACR_LOGIN_SERVER/quantum-lab/agent:$TAG"
    --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS"
    --target-port 8001 --ingress internal
    --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi
    --env-vars "${AGENT_ENV_VARS[@]}")
  if [ "${#AGENT_SECRETS[@]}" -gt 0 ]; then
    CREATE_ARGS+=(--secrets "${AGENT_SECRETS[@]}")
  fi
  az containerapp create "${CREATE_ARGS[@]}" >/dev/null
else
  refresh_registry_creds quantum-lab-agent
  # BUG FIXED: the update path used to ship only the new image. LLM keys and
  # MODEL were set on `create` alone, so a key added on a later run (the
  # normal case: deploy first, get a key, deploy again) never reached the
  # agent — the tutor stayed on the offline tier with no error anywhere.
  # Secrets must exist before an env var can reference them, hence the order.
  if [ "${#AGENT_SECRETS[@]}" -gt 0 ]; then
    az containerapp secret set -n quantum-lab-agent -g "$RESOURCE_GROUP" --secrets "${AGENT_SECRETS[@]}" >/dev/null
  fi
  az containerapp update -n quantum-lab-agent -g "$RESOURCE_GROUP" \
    --image "$ACR_LOGIN_SERVER/quantum-lab/agent:$TAG" \
    --min-replicas 1 --max-replicas 1 \
    --set-env-vars "${AGENT_ENV_VARS[@]}" >/dev/null
fi
# The agent has no authentication of its own; only the web app's /api/agent
# route (auth, quota, message clamps) may reach it. Internal ingress makes it
# resolvable from inside the Container Apps environment and nowhere else.
# Idempotent, so an agent created external by an older version of this
# script is moved inside on the next run.
az containerapp ingress update -n quantum-lab-agent -g "$RESOURCE_GROUP" --type internal --target-port 8001 >/dev/null
AGENT_FQDN="$(az containerapp show -n quantum-lab-agent -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
AGENT_URL="https://$AGENT_FQDN"
echo "==> agent: $AGENT_URL (internal ingress — reachable only from the web app)"

# ---------------------------------------------------------------- 6. web
# ---- Which URL is the PUBLIC one? --------------------------------------
# NEXT_PUBLIC_APP_URL is baked into the web image at build time and drives
# every canonical URL, the sitemap, OG tags and the RSS feed. It used to be
# baked BLANK here ("the URL isn't known until after the first deploy"), which
# was true only on the very first run — and on every re-run it silently
# reverted qubit16.ai's canonicals to relative URLs, undoing what
# attach-domain.sh had built. Now: PUBLIC_URL wins if set; otherwise the
# first custom domain bound to quantum-lab-web; otherwise, on a re-run, the
# app's existing *.azurecontainerapps.io FQDN; and only on a true first
# deploy is it blank (that run should be followed by attach-domain.sh or a
# re-run of this script, both of which bake the right value).
if [ -z "${PUBLIC_URL:-}" ] && az containerapp show -n quantum-lab-web -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  CUSTOM_DOMAIN="$(az containerapp hostname list -n quantum-lab-web -g "$RESOURCE_GROUP" --query "[?bindingType=='SniEnabled'] | [0].name" -o tsv 2>/dev/null || true)"
  if [ -n "$CUSTOM_DOMAIN" ]; then
    PUBLIC_URL="https://$CUSTOM_DOMAIN"
  else
    PUBLIC_URL="https://$(az containerapp show -n quantum-lab-web -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
  fi
fi
PUBLIC_URL="${PUBLIC_URL:-}"
echo "==> Public URL baked into web: ${PUBLIC_URL:-(blank: first deploy — re-run or attach-domain.sh will set it)}"

# The commit being built, so /api/health and Sentry can say which release is
# live. Empty (not an error) when this is not a git checkout.
RELEASE_SHA="${NEXT_PUBLIC_SENTRY_RELEASE:-$(git rev-parse HEAD 2>/dev/null || true)}"

echo "==> Building web pass 2 with real URLs baked in (az acr build, queued + polled)"
acr_build_async "quantum-lab/web:$TAG-web" "apps/web/Dockerfile" "." \
  "NEXT_PUBLIC_APP_URL=$PUBLIC_URL" \
  "NEXT_PUBLIC_API_URL=$API_URL" \
  "NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL:-}" \
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" \
  "NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN:-}" \
  "NEXT_PUBLIC_LAUNCH_TRIAL_DAYS=${NEXT_PUBLIC_LAUNCH_TRIAL_DAYS:-}" \
  "NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL=${NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL:-}" \
  "NEXT_PUBLIC_ANALYTICS_ENDPOINT=${NEXT_PUBLIC_ANALYTICS_ENDPOINT:-}" \
  "NEXT_PUBLIC_DEVICE_TUTOR=${NEXT_PUBLIC_DEVICE_TUTOR:-}" \
  "NEXT_PUBLIC_SENTRY_RELEASE=${RELEASE_SHA}" \
  "NEXT_PUBLIC_BUILD_STAMP=${RELEASE_SHA:0:12}"

echo "==> Deploying apps/web (min-replicas 1 — see comment above api's deploy step; 0.25 vCPU / 0.5 GiB)"
# The NEW value, never the overlap: web presents exactly one secret, and the
# api is what has been taught to accept two for the duration.
WEB_SECRETS=()
[ -n "$API_SECRET_NEW" ] && WEB_SECRETS+=(quantum-api-secret="$API_SECRET_NEW")
WEB_ENV_VARS=(QUANTUM_API_SECRET=secretref:quantum-api-secret AGENT_SERVICE_URL="$AGENT_URL")
[ -n "$GEMINI_KEY" ]    && WEB_SECRETS+=(gemini-api-key="$GEMINI_KEY")    && WEB_ENV_VARS+=(GEMINI_API_KEY=secretref:gemini-api-key)
[ -n "$GROQ_KEY" ]      && WEB_SECRETS+=(groq-api-key="$GROQ_KEY")       && WEB_ENV_VARS+=(GROQ_API_KEY=secretref:groq-api-key)
[ -n "$ANTHROPIC_KEY" ] && WEB_SECRETS+=(anthropic-api-key="$ANTHROPIC_KEY") && WEB_ENV_VARS+=(ANTHROPIC_API_KEY=secretref:anthropic-api-key)
[ -n "$WEB_TUTOR_MODEL" ] && WEB_ENV_VARS+=(TUTOR_MODEL="$WEB_TUTOR_MODEL")
# The launch-trial policy is read at request time on the server as well as
# baked into the client bundle above; both must agree, so both are set.
#
# SET UNCONDITIONALLY, INCLUDING WHEN BLANK. Every other optional variable here
# is guarded with `[ -n ... ]`, which is right for a credential — omitting it
# leaves whatever is already there. It is WRONG for a policy: blanking
# NEXT_PUBLIC_LAUNCH_TRIAL_DAYS in .env.production to turn the per-account
# window off did nothing, because the guard skipped it and the container kept
# the 30 from a previous deploy. The promotion then ran with BOTH windows, and
# `applyLaunchTrial` takes the earlier — so every account older than 30 days
# got nothing from a promotion that was supposed to cover everybody.
WEB_ENV_VARS+=(NEXT_PUBLIC_LAUNCH_TRIAL_DAYS="${NEXT_PUBLIC_LAUNCH_TRIAL_DAYS:-}")
# The on-device tutor needs this at RUN time as well as as a build arg above.
# proxy.ts computes the CSP per request, so without it here the container
# serves the closed policy while the client bundle (built WITH the flag) still
# renders the download button — a visible, pressable control whose download is
# then blocked by CSP with no error the learner can see. Observed in
# production. Same both-places rule as the line above, for the same reason.
WEB_ENV_VARS+=(NEXT_PUBLIC_DEVICE_TUTOR="${NEXT_PUBLIC_DEVICE_TUTOR:-}")
# The ABSOLUTE end of the launch promotion, e.g. 2026-12-17. Set this rather
# than only the day count whenever the promotion has an end DATE: the day count
# is a rolling PER-ACCOUNT window, so on its own "free for the next three
# months" silently becomes six months for somebody who signs up in the last
# week of it, and there is no date on which it ends for everybody. Setting both
# ends the trial at whichever comes first. lib/billing/launchTrial.ts carries
# the full reasoning.
WEB_ENV_VARS+=(NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL="${NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL:-}")

# SUPABASE_SERVICE_ROLE_KEY's PAIRS rule in lib/env.ts requires
# NEXT_PUBLIC_SUPABASE_URL, and the Supabase-both-or-neither rule requires
# NEXT_PUBLIC_SUPABASE_ANON_KEY too — but env.ts's isSet() does a DYNAMIC
# `process.env[name]` lookup, which Next.js cannot statically inline the way
# it inlines a literal `process.env.NEXT_PUBLIC_X` reference. Baking these
# into the client bundle via --build-arg above (which is otherwise correct
# and sufficient for every browser-side use) does NOT put them in the
# server process's actual runtime environment. Without also setting them
# here, the first deploy where SUPABASE_SERVICE_ROLE_KEY is non-empty makes
# assertEnv() throw at boot and takes the whole app down on every route —
# confirmed by doing it in production. Same fix as NEXT_PUBLIC_LAUNCH_TRIAL_DAYS
# just above, for the same underlying reason.
[ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && WEB_ENV_VARS+=(NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL")
[ -n "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ] && WEB_ENV_VARS+=(NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY")

if ! az containerapp show -n quantum-lab-web -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp create \
    -n quantum-lab-web -g "$RESOURCE_GROUP" --environment "$ENV_NAME" \
    --image "$ACR_LOGIN_SERVER/quantum-lab/web:$TAG-web" \
    --registry-server "$ACR_LOGIN_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --target-port 3000 --ingress external \
    --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets "${WEB_SECRETS[@]}" \
    --env-vars "${WEB_ENV_VARS[@]}" \
    >/dev/null
else
  refresh_registry_creds quantum-lab-web
  # Same fix as the agent above: `--set-env-vars GEMINI_API_KEY=secretref:…`
  # fails outright if the secret was never created, which it was not on a
  # first deploy without keys. Set the secrets first, every run; the shared
  # api secret is regenerated per run and the api side is updated below.
  # Guarded on emptiness for two reasons: on an ordinary deploy there is no
  # api secret to write (see above), and `az containerapp secret set` with no
  # --secrets argument is an error rather than a no-op. WEB_SECRETS can also be
  # non-empty with no api secret in it, when only LLM keys are configured.
  if [ ${#WEB_SECRETS[@]} -gt 0 ]; then
    az containerapp secret set -n quantum-lab-web -g "$RESOURCE_GROUP" --secrets "${WEB_SECRETS[@]}" >/dev/null
  fi
  # --min-replicas/--max-replicas here (not just on `create`) matters on a
  # re-run against an app that already exists with the old min-replicas=0:
  # `update` does not touch scaling unless told to, so an app deployed before
  # this fix landed would otherwise stay scale-to-zero forever, silently.
  az containerapp update -n quantum-lab-web -g "$RESOURCE_GROUP" \
    --image "$ACR_LOGIN_SERVER/quantum-lab/web:$TAG-web" \
    --min-replicas 1 --max-replicas 1 \
    --set-env-vars "${WEB_ENV_VARS[@]}" >/dev/null
fi
WEB_FQDN="$(az containerapp show -n quantum-lab-web -g "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
WEB_URL="https://$WEB_FQDN"
echo "==> web: $WEB_URL"
curl -s -o /dev/null -w "   /api/health -> %{http_code}\n" "$WEB_URL/api/health" || true

# ---- STEP 3 OF THE ROTATION: retire the old secret ------------------------
#
# Web is now on the new value, so the api no longer needs to accept the old
# one. Narrowing back to a single value is NOT optional housekeeping: an
# overlap left in place forever means the secret being rotated away from is
# still accepted, which defeats the entire point of having rotated.
#
# This runs only when a rotation was actually performed, and only AFTER web's
# update above has returned — that ordering is what makes the sequence
# gapless, so do not move this call earlier.
if [ -n "${API_SECRET_OVERLAP:-}" ]; then
  echo "==> Retiring the previous shared secret (api now accepts only the new one)"
  az containerapp secret set -n quantum-lab-api -g "$RESOURCE_GROUP" \
    --secrets "api-shared-secret=$API_SECRET_NEW" >/dev/null
  # A Container Apps secret change needs a new revision to reach the running
  # container, which `update` forces. Without this the api keeps serving with
  # both values loaded until something else happens to restart it.
  az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
    --set-env-vars API_SHARED_SECRET=secretref:api-shared-secret >/dev/null
fi

# ---------------------------------------------------------- 7. wire origins
# BUG FIXED: this used to set ALLOWED_ORIGINS to the *.azurecontainerapps.io
# URL alone, which on every re-run dropped https://qubit16.ai from the
# allow-list that attach-domain.sh had appended — and the browser's calls
# from the real domain to the api (the /hardware page reads
# NEXT_PUBLIC_API_URL client-side) then failed CORS. Now the list is the
# Azure URL plus every custom domain bound to web, plus PUBLIC_URL if it is
# something else again; de-duplicated, comma-separated, which is the format
# both Python services' origins_list parses.
ORIGINS="$WEB_URL"
for d in $(az containerapp hostname list -n quantum-lab-web -g "$RESOURCE_GROUP" --query "[].name" -o tsv 2>/dev/null || true); do
  ORIGINS="$ORIGINS,https://$d"
done
[ -n "$PUBLIC_URL" ] && ORIGINS="$ORIGINS,$PUBLIC_URL"
ORIGINS="$(printf '%s' "$ORIGINS" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)"
echo "==> Pointing api + agent ALLOWED_ORIGINS at $ORIGINS"
az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
  --set-env-vars ALLOWED_ORIGINS="$ORIGINS" >/dev/null
az containerapp update -n quantum-lab-agent -g "$RESOURCE_GROUP" \
  --set-env-vars ALLOWED_ORIGINS="$ORIGINS" >/dev/null

# ------------------------------------------ 7b. optional integrations
# Each entry is  VAR:apps  — the env var name and which container apps get it
# (w = web, a = api, g = agent). Values come from the shell / ENV_FILE above.
# Set as a secret and referenced by secretref so `az containerapp show` never
# prints the value. Unset or blank vars are skipped, never cleared: removing a
# secret is a deliberate act, done by hand.
wire_secret() {
  local var="$1" apps="$2"
  # Indirect expansion on its own line: `local var="$1" value="${!var}"` on one
  # line evaluates ${!var} BEFORE var is assigned and fails with "invalid
  # indirect expansion" — which is exactly how the first real run died here.
  local value="${!var:-}"
  [ -z "$value" ] && return 0
  local secret_name
  secret_name="$(printf '%s' "$var" | tr 'A-Z_' 'a-z-')"
  local app letter
  for letter in $(printf '%s' "$apps" | sed 's/./& /g'); do
    case "$letter" in
      w) app=quantum-lab-web ;;
      a) app=quantum-lab-api ;;
      g) app=quantum-lab-agent ;;
      *) echo "!! wire_secret: unknown app letter '$letter' for $var"; continue ;;
    esac
    az containerapp secret set -n "$app" -g "$RESOURCE_GROUP" --secrets "$secret_name=$value" >/dev/null
    az containerapp update -n "$app" -g "$RESOURCE_GROUP" --set-env-vars "$var=secretref:$secret_name" >/dev/null
    echo "   $var -> $app"
  done
}
echo "==> Wiring optional integrations that have values (blank = skipped)"
# Accounts, sync, billing, exams, orgs (Supabase) — the public URL/anon key
# are baked into the web build above; the service role is server-only.
wire_secret SUPABASE_SERVICE_ROLE_KEY w
# Billing (Stripe) — see docs/STRIPE-SETUP.md for the price ids + webhook.
wire_secret STRIPE_SECRET_KEY w
wire_secret STRIPE_WEBHOOK_SECRET w
wire_secret BILLING_RECONCILE_SECRET w
# Transactional email (Resend) — see docs/ONBOARDING.md.
wire_secret RESEND_API_KEY w
wire_secret EMAIL_FROM w
wire_secret EMAIL_DISPATCH_SECRET w
# Error tracking (Sentry) — the public DSN is a build arg above; these are
# server-side / source-map upload only.
wire_secret SENTRY_AUTH_TOKEN w
wire_secret SENTRY_ORG w
wire_secret SENTRY_PROJECT w
# Distributed rate limiting across replicas (Upstash Redis REST).
wire_secret UPSTASH_REDIS_REST_URL w
wire_secret UPSTASH_REDIS_REST_TOKEN w
# Gate the deep health probe (docs/SECURITY.md HEALTH-1).
wire_secret HEALTH_DEEP_TOKEN w
# Platform console (/admin/platform): who may open it, and the key that
# encrypts provider API keys saved there. If no encryption key is given, one
# is generated once and remembered in the env file so a redeploy never
# silently makes the stored keys unreadable.
wire_secret PLATFORM_ADMIN_EMAILS w
if [ -z "${SETTINGS_ENCRYPTION_KEY:-}" ] && [ -n "${PLATFORM_ADMIN_EMAILS:-}" ]; then
  SETTINGS_ENCRYPTION_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
    printf '\nSETTINGS_ENCRYPTION_KEY=%s\n' "$SETTINGS_ENCRYPTION_KEY" >> "$ENV_FILE"
    echo "   generated SETTINGS_ENCRYPTION_KEY and appended it to $ENV_FILE (keep that file)"
  else
    echo "!! generated a SETTINGS_ENCRYPTION_KEY but there is no env file to remember it in;"
    echo "   add SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY to infra/azure/.env.production"
  fi
fi
wire_secret SETTINGS_ENCRYPTION_KEY w
# Pin the tutor to one provider (docs/LLM-GATEWAY.md) — plain value, not secret.
if [ -n "${FORCE_LLM_PROVIDER:-}" ]; then
  az containerapp update -n quantum-lab-web -g "$RESOURCE_GROUP" --set-env-vars "FORCE_LLM_PROVIDER=$FORCE_LLM_PROVIDER" >/dev/null
  echo "   FORCE_LLM_PROVIDER=$FORCE_LLM_PROVIDER -> quantum-lab-web"
fi
# The aggregate-analytics sink table name (see supabase/schema-analytics.sql)
# — a table name, not a secret. Read at request time by
# apps/web/app/api/analytics/route.ts; also needs
# NEXT_PUBLIC_ANALYTICS_ENDPOINT set (build-time, above) or the client never
# calls this route in the first place. Both unset (the default) keeps
# analytics fully local-first, as documented in lib/analytics/track.ts.
#
# GUARDED, not just wired: lib/env.ts has a hard PAIRS rule requiring
# SUPABASE_SERVICE_ROLE_KEY whenever this is set — unmet, assertEnv() throws
# at server startup and EVERY route 500s, not a graceful analytics-off
# degrade. Confirmed by doing it: this exact combination took qubit16.ai down
# in production. Check the pair here, before it ever reaches the container,
# rather than relying on the app's own crash-on-boot as the only guard.
if [ -n "${ANALYTICS_SUPABASE_TABLE:-}" ]; then
  if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    echo "!! ANALYTICS_SUPABASE_TABLE is set but SUPABASE_SERVICE_ROLE_KEY is not."
    echo "   Wiring only the table name would take the whole app down at startup"
    echo "   (lib/env.ts's PAIRS rule) — refusing to set it. Fill in"
    echo "   SUPABASE_SERVICE_ROLE_KEY in $ENV_FILE and re-run, or leave"
    echo "   ANALYTICS_SUPABASE_TABLE unset for now."
  else
    az containerapp update -n quantum-lab-web -g "$RESOURCE_GROUP" --set-env-vars "ANALYTICS_SUPABASE_TABLE=$ANALYTICS_SUPABASE_TABLE" >/dev/null
    echo "   ANALYTICS_SUPABASE_TABLE=$ANALYTICS_SUPABASE_TABLE -> quantum-lab-web"
  fi
fi
# Real quantum hardware (services/api) — see docs/HARDWARE.md.
wire_secret IBM_QUANTUM_TOKEN a
wire_secret AWS_ACCESS_KEY_ID a
wire_secret AWS_SECRET_ACCESS_KEY a
wire_secret AWS_DEFAULT_REGION a
# Azure OpenAI as a tutor provider (the internal Azure-credits notes) — both runtimes.
wire_secret AZURE_API_KEY wg
wire_secret AZURE_API_BASE wg
wire_secret AZURE_API_VERSION wg

# ------------------------------------------------------- 8. budget alert
echo "==> Cost budget alert at \$50/mo (best-effort — CLI budgets need a Cost Management writer role)"
BUDGET_JSON=$(cat <<EOF
{
  "category": "Cost",
  "amount": 50,
  "timeGrain": "Monthly",
  "timePeriod": {"startDate": "$(date -u +%Y-%m-01)"},
  "notifications": {
    "Actual_GreaterThan_80_Percent": {
      "enabled": true, "operator": "GreaterThan", "threshold": 80,
      "contactEmails": [], "thresholdType": "Actual"
    }
  }
}
EOF
)
echo "$BUDGET_JSON" > /tmp/az-budget.json
az consumption budget create-or-update --budget-name quantum-lab-budget-50usd \
  --category Cost --amount 50 --time-grain Monthly \
  --start-date "$(date -u +%Y-%m-01)" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP" \
  >/dev/null 2>&1 \
  || echo "   (skipped — set one manually: portal.azure.com -> Cost Management -> Budgets -> Add, scoped to $RESOURCE_GROUP)"

# ---------------------------------------------- 9. Founders Hub milestone workloads
#
# OPT-IN, off by default: export ENABLE_MILESTONE_WORKLOADS=true to run this.
# [UNVERIFIED] — same caveat as the rest of this script, but more so: these
# 3 commands have had zero real-world exercise. Read before running.
#
# WHAT AND WHY: Microsoft for Startups Founders Hub's $25,000 credit
# milestone requires 5+ *distinct* Azure services with >=$1 spend each,
# sustained ~60 days — see the internal Azure-credits notes. This deployment alone
# only touches 2 (Container Registry, Container Apps). This section adds
# 3 more, on purpose, purely to diversify billed services toward that
# milestone. It is a deliberate reversal of this script's own "minimal
# hardware" instinct — roughly +$30-40/mo — which is exactly why it is
# opt-in rather than automatic.
#
# WHAT THIS DOES NOT DO: provisioning these resources does not connect
# them to the running application. apps/web/lib/supabase.ts speaks
# Supabase's SDK/REST API, not raw Postgres wire protocol, so Azure
# Database for PostgreSQL here is a separate resource generating its own
# spend, not a drop-in Supabase replacement. Same for Redis (the app
# expects Upstash's REST API, not Azure Cache for Redis's native
# protocol) and Azure OpenAI (the LLM gateway in docs/LLM-GATEWAY.md has
# no Azure provider wired in yet). Actually using any of these in the app
# is separate follow-up work this script does not do.
if [ "${ENABLE_MILESTONE_WORKLOADS:-false}" = "true" ]; then
  echo ""
  echo "==> Founders Hub milestone workloads (adds ~\$30-40/mo — see comment above)"
  RES_SUFFIX="$(echo -n "$SUBSCRIPTION_ID" | md5sum | cut -c1-8)"

  PG_SERVER="quantum-lab-pg-$RES_SUFFIX"
  echo "==> Azure Database for PostgreSQL Flexible Server: $PG_SERVER (Burstable B1ms, ~\$13/mo)"
  PG_WIRED=false
  if ! az postgres flexible-server show -n "$PG_SERVER" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
    PG_ADMIN_PASSWORD="$(openssl rand -base64 24)"
    if az postgres flexible-server create \
        -n "$PG_SERVER" -g "$RESOURCE_GROUP" -l "$LOCATION" \
        --admin-user quantumlabadmin --admin-password "$PG_ADMIN_PASSWORD" \
        --sku-name Standard_B1ms --tier Burstable --storage-size 32 --version 16 \
        --public-access 0.0.0.0-255.255.255.255 --yes >/dev/null 2>&1; then
      echo "   created"
      # Wired straight into app/jobs/archive.py's durable job-history table —
      # see that module and the internal Azure-credits notes. Only possible on first
      # create: the admin password is generated here and Azure never returns
      # it again, so an "already exists" server on a re-run cannot be wired
      # automatically (see the else branch below).
      PG_HOST="$(az postgres flexible-server show -n "$PG_SERVER" -g "$RESOURCE_GROUP" --query fullyQualifiedDomainName -o tsv)"
      DATABASE_URL="postgresql://quantumlabadmin:$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$PG_ADMIN_PASSWORD")@$PG_HOST:5432/postgres?sslmode=require"
      az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
        --set-env-vars DATABASE_URL=secretref:database-url >/dev/null 2>&1 || true
      az containerapp secret set -n quantum-lab-api -g "$RESOURCE_GROUP" \
        --secrets database-url="$DATABASE_URL" >/dev/null 2>&1 \
        && az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
             --set-env-vars DATABASE_URL=secretref:database-url >/dev/null 2>&1 \
        && PG_WIRED=true
      if [ "$PG_WIRED" = true ]; then
        echo "   wired: DATABASE_URL set on quantum-lab-api — job history now persists (app/jobs/archive.py)"
      else
        echo "   provisioned but NOT wired (containerapp secret set failed) — admin password"
        echo "   (SAVE THIS, shown once only): $PG_ADMIN_PASSWORD"
      fi
    else
      echo "   (failed — check manually: az postgres flexible-server create --help, or create via portal)"
    fi
  else
    echo "   already exists, skipping creation"
    echo "   NOT re-wiring DATABASE_URL: the admin password from its original creation isn't"
    echo "   recoverable from Azure. If quantum-lab-api isn't already using it, set DATABASE_URL"
    echo "   manually: az containerapp secret set -n quantum-lab-api -g $RESOURCE_GROUP --secrets database-url=<url>"
  fi

  REDIS_NAME="quantum-lab-redis-$RES_SUFFIX"
  echo "==> Azure Cache for Redis: $REDIS_NAME (Basic C0, ~\$16/mo)"
  REDIS_JUST_CREATED=false
  if ! az redis show -n "$REDIS_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
    if az redis create -n "$REDIS_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" \
        --sku Basic --vm-size c0 --no-wait >/dev/null 2>&1; then
      echo "   creation queued (Redis takes 15-20 min to finish provisioning)"
      REDIS_JUST_CREATED=true
    else
      echo "   (failed — check manually: az redis create --help, or create via portal)"
    fi
  else
    echo "   already exists, skipping creation"
  fi
  if [ "$REDIS_JUST_CREATED" = true ] || az redis show -n "$REDIS_NAME" -g "$RESOURCE_GROUP" --query provisioningState -o tsv 2>/dev/null | grep -qi succeeded; then
    echo "   waiting for Redis to finish provisioning before wiring it in (up to ~20 min)..."
    REDIS_READY=false
    for _ in $(seq 1 80); do
      STATE="$(az redis show -n "$REDIS_NAME" -g "$RESOURCE_GROUP" --query provisioningState -o tsv 2>/dev/null || echo "")"
      if [ "$STATE" = "Succeeded" ]; then
        REDIS_READY=true
        break
      fi
      sleep 15
    done
    if [ "$REDIS_READY" = true ]; then
      REDIS_HOST="$(az redis show -n "$REDIS_NAME" -g "$RESOURCE_GROUP" --query hostName -o tsv)"
      REDIS_KEY="$(az redis list-keys -n "$REDIS_NAME" -g "$RESOURCE_GROUP" --query primaryKey -o tsv)"
      # rediss:// (TLS) on port 6380 — Azure Cache for Redis's non-TLS 6379 is
      # disabled by default, and app/jobs/store.py's redis.Redis.from_url
      # picks TLS automatically from the rediss:// scheme.
      REDIS_URL="rediss://:$REDIS_KEY@$REDIS_HOST:6380/0"
      if az containerapp secret set -n quantum-lab-api -g "$RESOURCE_GROUP" \
           --secrets redis-url="$REDIS_URL" >/dev/null 2>&1 \
         && az containerapp update -n quantum-lab-api -g "$RESOURCE_GROUP" \
              --set-env-vars REDIS_URL=secretref:redis-url >/dev/null 2>&1; then
        echo "   wired: REDIS_URL set on quantum-lab-api — job store now shared/multi-process (app/jobs/store.py)"
      else
        echo "   provisioned but NOT wired (containerapp secret set failed) — wire REDIS_URL manually"
      fi
    else
      echo "   still provisioning after ~20 min — re-run this script (with ENABLE_MILESTONE_WORKLOADS=true)"
      echo "   once portal.azure.com shows $REDIS_NAME as Running, or wire REDIS_URL by hand:"
      echo "   az redis list-keys -n $REDIS_NAME -g $RESOURCE_GROUP"
    fi
  fi

  AOAI_NAME="quantum-lab-aoai-$RES_SUFFIX"
  echo "==> Azure OpenAI Service: $AOAI_NAME"
  AOAI_READY=false
  if ! az cognitiveservices account show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
    if az cognitiveservices account create -n "$AOAI_NAME" -g "$RESOURCE_GROUP" -l "$LOCATION" \
        --kind OpenAI --sku S0 --yes >/dev/null 2>&1; then
      echo "   created"
      AOAI_READY=true
    else
      echo "   (failed — this subscription most likely needs separate Azure OpenAI access approval:"
      echo "    https://aka.ms/oai/access — apply, wait for approval, then re-run this script)"
    fi
  else
    echo "   already exists, skipping creation"
    AOAI_READY=true
  fi
  if [ "$AOAI_READY" = true ]; then
    # gpt-4o-mini: cheapest generally-available chat-capable Azure OpenAI
    # model as of this writing — the tutor's own default (Gemini Flash) still
    # wins on cost when its key is set; this exists as the selectable
    # fallback described in docs/LLM-GATEWAY.md, not to replace it.
    AOAI_DEPLOYMENT="gpt-4o-mini"
    if ! az cognitiveservices account deployment show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" \
         --deployment-name "$AOAI_DEPLOYMENT" >/dev/null 2>&1; then
      az cognitiveservices account deployment create -n "$AOAI_NAME" -g "$RESOURCE_GROUP" \
        --deployment-name "$AOAI_DEPLOYMENT" --model-name gpt-4o-mini --model-version "2024-07-18" \
        --model-format OpenAI --sku-name Standard --sku-capacity 10 >/dev/null 2>&1 \
        && echo "   model deployment '$AOAI_DEPLOYMENT' created" \
        || echo "   (model deployment failed — deploy manually: portal.azure.com -> $AOAI_NAME -> Model deployments)"
    else
      echo "   model deployment '$AOAI_DEPLOYMENT' already exists"
    fi
    AOAI_ENDPOINT="$(az cognitiveservices account show -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --query properties.endpoint -o tsv 2>/dev/null || echo "")"
    AOAI_KEY="$(az cognitiveservices account keys list -n "$AOAI_NAME" -g "$RESOURCE_GROUP" --query key1 -o tsv 2>/dev/null || echo "")"
    if [ -n "$AOAI_ENDPOINT" ] && [ -n "$AOAI_KEY" ]; then
      # Same 3 vars, same names, on both services deliberately — see the
      # comments in services/agent/agent/config.py and
      # apps/web/app/api/agent/route.ts's selectDirectProvider(). Not set as
      # MODEL/TUTOR_MODEL's default: Azure OpenAI is a selectable fallback,
      # never pre-empting Gemini's free tier.
      for APP in quantum-lab-agent quantum-lab-web; do
        az containerapp secret set -n "$APP" -g "$RESOURCE_GROUP" \
          --secrets azure-api-key="$AOAI_KEY" >/dev/null 2>&1 \
          && az containerapp update -n "$APP" -g "$RESOURCE_GROUP" \
               --set-env-vars AZURE_API_KEY=secretref:azure-api-key \
                 AZURE_API_BASE="$AOAI_ENDPOINT" AZURE_API_VERSION="2024-10-21" >/dev/null 2>&1 \
          && echo "   wired: AZURE_API_KEY/AZURE_API_BASE/AZURE_API_VERSION set on $APP" \
          || echo "   provisioned but NOT wired on $APP (containerapp secret set failed)"
      done
      echo "   To actually USE it: set MODEL=azure/$AOAI_DEPLOYMENT on quantum-lab-agent, or"
      echo "   TUTOR_MODEL=$AOAI_DEPLOYMENT on quantum-lab-web, once Gemini/Groq/Anthropic are"
      echo "   unavailable or you want to test the Azure path specifically."
    else
      echo "   provisioned but could not read endpoint/key back — wire manually if needed"
    fi
  fi

  echo ""
  echo "   Founders Hub Milestone 3 needs these sustained ~60 days from whichever"
  echo "   moment each finished wiring above — see the internal Azure-credits notes."
fi

# ------------------------------------------------------------- done
echo ""
echo "================================================================"
echo " DEPLOYED (Azure Container Apps)"
echo "   web:   $WEB_URL   (always-on, min-replicas 1 — no cold-start tax)"
echo "   api:   $API_URL   (always-on, min-replicas 1 — public URL, but"
echo "                      unauthenticated by default unless"
echo "                      API_SHARED_SECRET is enforced — see"
echo "                      docs/SECURITY.md; same exposure as the AWS kit)"
echo "   agent: $AGENT_URL (internal ingress; always-on, min-replicas 1 — a"
echo "                      cold start would outlast the web 25 s timeout)"
echo ""
echo " web and api are pinned always-on (~\$10-15/mo each) specifically to"
echo " avoid the cold-start tax that was measured hitting real users on"
echo " infrequently-visited pages — see the comments above each service's"
echo " deploy step. Only agent still scales to zero. See"
echo " docs/DEPLOYMENT-AZURE.md for the full cost breakdown."
echo "================================================================"
