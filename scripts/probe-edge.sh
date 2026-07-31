#!/usr/bin/env bash
# Edge probe v2 — correct paths from CorePrt-relay/crates/buzz-relay/src/router.rs.
# Reads secret from env file, never echoes it.
set -euo pipefail

ENV_FILE="$HOME/.config/coreprt/buzz-mcp.env"
# shellcheck disable=SC1090
source "$ENV_FILE"

RELAY="${BUZZ_RELAY_URL:-https://coreprt.webrnds.com}"

get() {
  local url="$1"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -m 8 \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    "$RELAY$url")
  echo "  GET  $url -> HTTP $code"
}

post() {
  local url="$1"; local body="$2"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -m 8 \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -H "Content-Type: application/json" \
    -X POST --data "$body" \
    "$RELAY$url")
  echo "  POST $url -> HTTP $code"
}

echo "Probing $RELAY with service token (client_id: ${#CF_ACCESS_CLIENT_ID} chars)..."
get "/"
get "/info"
get "/_liveness"
get "/_readiness"
# Unauthenticated POST should be 401/403 or 400; with service token we expect 401/202-ish
post "/events" '{"id":"00","kind":1,"content":"probe"}'
post "/query" '{}'
post "/count" '{}'
