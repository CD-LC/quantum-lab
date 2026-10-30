#!/bin/sh
# One bounded call to the 7-day course scheduler. Both EMAIL_DISPATCH_SECRET
# and DISPATCH_URL come from this container's own env (set as --env-vars by
# infra/azure/deploy-email-cron.sh — the secret via secretref, so it is never
# a literal in the job definition or in `az` CLI history).
set -eu

if [ -z "${EMAIL_DISPATCH_SECRET:-}" ] || [ -z "${DISPATCH_URL:-}" ]; then
  echo "dispatch: EMAIL_DISPATCH_SECRET or DISPATCH_URL is unset — nothing to call" >&2
  exit 1
fi

status="$(curl -fsS -m 90 -o /tmp/dispatch-body.json -w '%{http_code}' \
  -X POST -H "Authorization: Bearer ${EMAIL_DISPATCH_SECRET}" "${DISPATCH_URL}")"
echo "dispatch: HTTP ${status}"
cat /tmp/dispatch-body.json
echo ""

# HTTP 200 with a non-empty "failures" array means some sends failed (the
# route reports per-recipient errors in the body, not in the status). Exit
# non-zero so the Container Apps job execution shows Failed and can alert,
# instead of a green run that silently dropped emails. No jq in this image:
# the report is compact JSON, so an empty array is the literal "failures":[].
case "$status" in
  2??)
    if grep -q '"failures"' /tmp/dispatch-body.json \
       && ! grep -Eq '"failures"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' /tmp/dispatch-body.json; then
      echo "dispatch: report lists failures — exiting non-zero" >&2
      exit 1
    fi
    exit 0 ;;
  *) exit 1 ;;
esac
