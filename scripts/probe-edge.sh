#!/usr/bin/env bash
# Edge probe — verifies the CF Access service token in
# ~/.config/coreprt/buzz-mcp.env is admitted by the Cloudflare edge for the
# CorePrt application.
#
# Security properties (audited 2026-07-31):
#   - BUZZ_RELAY_URL is pinned to https://coreprt.webrnds.com. Any other
#     value is rejected before any CF-Access headers are sent, so a
#     malicious operator-controlled env var can't leak the token to an
#     attacker.
#   - The CF_ACCESS_CLIENT_SECRET is passed via stdin (curl -K -), not on
#     the command line, so it does not appear in `ps`/`/proc/*/cmdline`.
#   - The script exits non-zero on any non-2xx GET response. curl's exit
#     code alone does not reflect HTTP status, so we check `$code`
#     explicitly.
#   - The script never echoes the secret.
#
# Exit codes:
#   0  — all GETs returned 200 (edge is admitting the token)
#   1  — env file missing or unreadable
#   2  — env file is missing required variables
#   3  — BUZZ_RELAY_URL is not the pinned value
#   4  — one or more GET requests returned non-2xx
#   5  — required tool missing (curl)

set -euo pipefail

ENV_FILE="$HOME/.config/coreprt/buzz-mcp.env"
EXPECTED_RELAY="https://coreprt.webrnds.com"

if [ ! -r "$ENV_FILE" ]; then
  echo "fatal: env file $ENV_FILE is missing or unreadable" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  echo "fatal: $ENV_FILE must define CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET" >&2
  exit 2
fi

RELAY="${BUZZ_RELAY_URL:-$EXPECTED_RELAY}"
if [ "$RELAY" != "$EXPECTED_RELAY" ]; then
  echo "fatal: BUZZ_RELAY_URL must be $EXPECTED_RELAY (got '$RELAY') — refusing to send CF-Access headers to a non-CorePrt host" >&2
  exit 3
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "fatal: curl is required" >&2
  exit 5
fi

# Probe a GET endpoint and assert 200.
get() {
  local url="$1"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -m 8 \
    -K - <<CFG
url = "$RELAY$url"
header = "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
header = "CF-Access-Client-Secret: [REDACTED]"
request = "GET"
CFG
  )
  echo "  GET  $url -> HTTP $code"
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    echo "fatal: expected 2xx, got $code on GET $url" >&2
    return 4
  fi
  return 0
}

echo "Probing $RELAY with service token (client_id: ${#CF_ACCESS_CLIENT_ID} chars)..."
fail=0
for path in "/" "/info" "/_liveness" "/_readiness"; do
  if ! get "$path"; then
    fail=1
  fi
done
# The POSTs require NIP-98 / NIP-42 Nostr auth (relay layer, not CF). On an
# edge-only probe we expect 401 — that's correct posture (edge admitted
# the token, relay is asking for Nostr auth).
for path in "/events" "/query" "/count"; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" -m 8 \
    -K - <<CFG
url = "$RELAY$path"
header = "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
header = "CF-Access-Client-Secret: [REDACTED]"
header = "Content-Type: application/json"
request = "POST"
data = "{}"
CFG
  )
  echo "  POST $path -> HTTP $code"
done

exit $fail
