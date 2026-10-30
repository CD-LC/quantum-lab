# syntax=docker/dockerfile:1
#
# Quantum Lab — web application image.
#
# BUILD CONTEXT IS THE REPO ROOT, NOT apps/web:
#
#     docker build -f apps/web/Dockerfile -t quantum-lab-web .
#
# (docker-compose.yml is wired this way: `context: .` + `dockerfile: apps/web/Dockerfile`.)
#
# WHY. apps/web is an npm WORKSPACE. The root package.json declares
# `"workspaces": ["apps/*"]` and there is exactly ONE lockfile, at the repo
# root. apps/web has no package-lock.json of its own. An image built with
# apps/web as its context therefore cannot see the lockfile at all, and
# `npm ci` fails outright ("The `npm ci` command can only install with an
# existing package-lock.json"). Falling back to `npm install` "fixes" the error
# by resolving fresh versions that nobody tested — which is the exact failure a
# lockfile exists to prevent. So we copy the ROOT package.json + the ROOT
# package-lock.json + the workspace's package.json, and install from the root.
# npm then hoists everything into /app/node_modules and links the workspace.
# This is the single easiest thing to get wrong in this repo.
#
# STANDALONE OUTPUT WITHOUT TOUCHING next.config.mjs:
# apps/web/next.config.mjs deliberately does NOT set `output: 'standalone'` —
# it stays minimal so that a developer with no Sentry account gets the plain
# config. Rather than change it, the builder stage sets NEXT_PRIVATE_STANDALONE=1,
# the env var Next 14 reads to force standalone emission.
#
# HOW FAR THAT IS VERIFIED, because an earlier version of this comment claimed
# "verified against Next 14.2.35" without qualification and it was not:
#   * VERIFIED BY READING the pinned source. node_modules/next/dist/server/
#     config-shared.js line 88 is
#       output: !!process.env.NEXT_PRIVATE_STANDALONE ? "standalone" : undefined
#     and a user config that leaves `output` undefined does not override that
#     default. The flag does force standalone output on this exact version.
#   * VERIFIED BY EXECUTION: this file is what `az acr build` builds for
#     production (and what deploy.yml builds on every green main), and the
#     emitted tree — standalone/apps/web/server.js beside a hoisted
#     standalone/node_modules — is what the running image executes.
#     If it is wrong the build fails loudly at the `COPY .../standalone` line
#     rather than producing a broken image, and the FALLBACK at the bottom of
#     this file is the fix.


###############################################################################
# Stage 1 — deps
#
# Purpose: produce node_modules, and nothing else, from a lockfile-respecting
# install. Split from the builder so that this expensive layer is cached and
# only re-run when a package.json or the lockfile actually changes — editing a
# .tsx file must not trigger a reinstall.
###############################################################################
FROM node:22-alpine AS deps

# Next's SWC binary is glibc-linked; alpine needs the compat shim.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# The root manifest + the single root lockfile + the workspace manifest.
# All three are required: without the root package.json npm does not know
# apps/web is a workspace; without apps/web/package.json it has nothing to
# install for it; without the lockfile `npm ci` refuses to run.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json

# `npm ci`, never `npm install`: ci installs exactly what the lockfile pins,
# deletes any pre-existing node_modules, and fails loudly if the lockfile and
# package.json have drifted — instead of silently rewriting the lockfile inside
# an image layer where nobody will ever see the diff. Dev dependencies ARE
# needed here (typescript, tailwind, postcss all run during `next build`);
# they are dropped later by never being copied into the runner.
RUN npm ci --no-audit --no-fund


###############################################################################
# Stage 2 — builder
#
# Purpose: run `next build` against the full source tree and emit the
# standalone server. Nothing from this stage survives except the three
# directories the runner copies.
###############################################################################
FROM node:22-alpine AS builder

RUN apk add --no-cache libc6-compat

WORKDIR /app

# Reuse the installed tree rather than installing again.
#
# ONE COPY, NOT TWO. There used to be a second line here:
#
#     COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
#
# and it broke the build outright — `COPY failed: stat ...: file does not
# exist`. npm hoists everything to the root when nothing conflicts, and with
# this lockfile nothing does: running exactly the deps stage's install
# (root package.json + package-lock.json + apps/web/package.json, then
# `npm ci`) produces NO apps/web/node_modules directory at all. Verified by
# running that install in an empty directory against this repo's lockfile —
# 484 packages, all at /app/node_modules. If a future dependency does force a
# nested tree, add the line back guarded, or copy /app in one go; do not
# re-add it unconditionally.
COPY --from=deps /app/node_modules ./node_modules

# Source. .dockerignore keeps node_modules, .next, .git, .venv, test artefacts
# and every .env file out of this copy.
COPY . .

# No telemetry ping from a build container, and build in production mode so
# React and Next strip development-only code paths.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# The whole point of this file: standalone output without editing next.config.mjs.
ENV NEXT_PRIVATE_STANDALONE=true

# ── Build-time configuration ────────────────────────────────────────────────
#
# These five are INLINED INTO THE OUTPUT by the compiler and cannot be changed
# afterwards. `next.config.mjs` has an `env: { NEXT_PUBLIC_API_URL }` block, and
# every NEXT_PUBLIC_* name is substituted at compile time, in server code as
# well as client code. Passing them with `docker run -e` or a compose
# `environment:` block does nothing whatsoever — verified by grepping the
# committed build output, where `.next/server/app/hardware/page.js` and
# `.next/server/middleware.js` both contain the literal `http://localhost:8000`
# baked in from the build machine.
#
# So they are ARGs. They are NOT secrets and must never become secrets: every
# value here is served to browsers, and ARG values are additionally recorded in
# the image and readable via `docker history`. The Supabase anon key belongs in
# this list — it is designed to be public and is protected by row-level
# security. A service-role key never does.
#
# Empty defaults keep the "builds with no configuration" property intact.
ARG NEXT_PUBLIC_APP_URL=""
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ARG NEXT_PUBLIC_SENTRY_DSN=""
# Launch-period policy (lib/billing/launchTrial.ts): "" = off. Public by
# design — the pricing page prints it — and the server enforces the same value.
ARG NEXT_PUBLIC_LAUNCH_TRIAL_DAYS=""
# The ABSOLUTE end of the promotion. A MISSING `ARG` HERE IS SILENT AND WAS
# SHIPPED: deploy.sh passed this build arg, Docker ignored it, the value never
# reached the build, Next inlined an undefined into the client bundle, and the
# pricing page decided the promotion was off — while the container's RUNTIME
# env had the value, so the server happily granted every account the trial. A
# site that was in fact giving everything away, saying nothing about it.
#
# Adding a NEXT_PUBLIC_* variable therefore means editing THREE places, not
# two: .env.production (or the shell), deploy.sh's build-arg list AND its
# env-var list, and this ARG/ENV pair. Miss the last one and the server and
# the browser disagree with no error anywhere.
ARG NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL=""
# On-device (WebGPU) tutor: "" or unset = off, which is the default and keeps
# the CSP exactly as strict as it was.
#
# THIS ONE IS NEEDED AT BUILD TIME *AND* AT RUN TIME, which is unusual, and
# getting it half-right fails silently in the more confusing direction. Both:
#   - BUILD: Next inlines `process.env.NEXT_PUBLIC_DEVICE_TUTOR` into the
#     client bundle, which is what makes DeviceTutorPanel render at all.
#   - RUN:   proxy.ts (Next 16's middleware) calls securityHeaders() on every
#     request, so the CSP that decides whether huggingface.co may be reached
#     is computed in the RUNNING container, not baked at build.
# Set only the build arg and you ship a visible, pressable button whose
# download is then blocked by CSP with nothing in the UI to say why. Observed
# in production. So it appears in the ARG/ENV pair below, in deploy.sh's
# build-arg list AND its WEB_ENV_VARS list, and in .env.example.
ARG NEXT_PUBLIC_DEVICE_TUTOR=""
# The commit this image is built from. deploy.yml passes the full SHA.
#   - NEXT_PUBLIC_SENTRY_RELEASE: read by lib/observability/release.ts (Sentry
#     release, /api/health `version`). Inlined at build, so it reaches both the
#     server and the browser bundle.
#   - NEXT_PUBLIC_BUILD_STAMP: next.config.mjs uses it as the build id and the
#     service-worker cache name, so rebuilding the same commit does not evict
#     every installed user's cache. next.config.mjs sanitises and truncates it.
# Not secrets (a commit SHA of a public repo). Empty default: a local build
# with no value falls back to 'unknown' / a timestamp exactly as before.
ARG NEXT_PUBLIC_SENTRY_RELEASE=""
ARG NEXT_PUBLIC_BUILD_STAMP=""
# deploy.yml and deploy.sh already pass this as a build arg; without an ARG here
# Docker silently drops it and the first-party analytics endpoint stays off.
ARG NEXT_PUBLIC_ANALYTICS_ENDPOINT=""
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_LAUNCH_TRIAL_DAYS=$NEXT_PUBLIC_LAUNCH_TRIAL_DAYS \
    NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL=$NEXT_PUBLIC_LAUNCH_TRIAL_UNTIL \
    NEXT_PUBLIC_DEVICE_TUTOR=$NEXT_PUBLIC_DEVICE_TUTOR \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    NEXT_PUBLIC_BUILD_STAMP=$NEXT_PUBLIC_BUILD_STAMP \
    NEXT_PUBLIC_ANALYTICS_ENDPOINT=$NEXT_PUBLIC_ANALYTICS_ENDPOINT

# NOTE ON SECRETS: no *secret* is passed in here, and none needs to be. This
# project builds correctly with an entirely empty environment — the course,
# the circuit simulator, the visualizations and the offline tutor are all
# self-contained. Supabase/Stripe/Sentry/Anthropic are read at RUN time (or
# are absent, and the code degrades on purpose). Do not add ARG lines for
# secrets: build args are recorded in the image and readable via
# `docker history`.
RUN npm run build --workspace=web


###############################################################################
# Stage 3 — runner
#
# Purpose: the smallest possible image that can serve the app. It contains a
# Node runtime, the traced production dependencies and the compiled output —
# no source, no toolchain, no dev dependencies. The standalone bundle is
# already pruned to production dependencies only (that is what tracing means),
# which is why there is no install step here at all; see the FALLBACK note at
# the bottom of this file for the `npm ci --omit=dev` variant used when
# standalone output is unavailable.
###############################################################################
FROM node:22-alpine AS runner

RUN apk add --no-cache libc6-compat

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# 0.0.0.0, not localhost: a server bound to the loopback interface inside a
# container is unreachable from the published port.
ENV HOSTNAME=0.0.0.0

# Non-root user. A container process running as uid 0 that is compromised
# through the app has root on any bind-mounted path.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# The standalone bundle is monorepo-shaped, so it unpacks over /app directly:
#   /app/node_modules            hoisted, traced production deps
#   /app/package.json
#   /app/apps/web/server.js      the entry point
#   /app/apps/web/.next/         the compiled server output
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./

# Static assets and public files are NOT included in the standalone trace and
# must be copied separately — miss these and the app boots but every page
# loads unstyled with 404s on /_next/static/*.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

# Liveness probe against a real page render. `/` is used rather than an API
# route because the web app has no dedicated health endpoint and this proves
# the React server is actually rendering, not merely listening. Uses the Node
# runtime already in the image — no curl/wget install, no extra layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/',timeout:4000},r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1)})"

# The standalone server is a plain Node script; it does not need npm, next, or
# a shell. Exec form so signals reach it and `docker stop` is a clean SIGTERM
# rather than a 10-second timeout and SIGKILL.
CMD ["node", "apps/web/server.js"]


###############################################################################
# FALLBACK — if NEXT_PRIVATE_STANDALONE ever stops emitting .next/standalone
# (it is a private flag; a future Next major may rename it), the build breaks
# at the `COPY .../standalone` line with "not found". The fix is a
# non-standalone runner: keep stages 1 and 2 unchanged apart from dropping the
# NEXT_PRIVATE_STANDALONE line, and replace the runner body with a production
# install plus `next start`:
#
#   COPY package.json package-lock.json ./
#   COPY apps/web/package.json ./apps/web/package.json
#   RUN npm ci --omit=dev --no-audit --no-fund   # runtime deps only
#   COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next ./apps/web/.next
#   COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
#   COPY --from=builder --chown=nextjs:nodejs /app/apps/web/next.config.mjs ./apps/web/
#   CMD ["npm", "run", "start", "--workspace=web"]
#
# That image is roughly 2-3x larger and boots a little slower, but is otherwise
# equivalent. As of Next 14.2.35 the standalone path above is verified working.
###############################################################################
