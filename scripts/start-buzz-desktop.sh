#!/usr/bin/env bash
# start-buzz-desktop.sh — launch Buzz.app pointed at the CorePrt relay.
#
# Why this exists:
#   CorePrt-relay/desktop/src-tauri/src/relay.rs precedence is:
#     workspace_relay_override (in-memory only, set via Tauri command) →
#     BUZZ_RELAY_URL env var →
#     BUZZ_DESKTOP_BUILD_RELAY_URL (compile-time) →
#     ws://localhost:3000 (hardcoded fallback).
#   The binary at /Applications/Buzz.app has no BUZZ_DESKTOP_BUILD_RELAY_URL baked in.
#   The workspace override is in-memory only (no on-disk persistence), so the
#   only reliable launcher is env var.
#
# Modes:
#   (default)       Public relay over the Cloudflare tunnel.
#                   Use this always — same context from any network, with the
#                   host's WARP device posture satisfying the Access gate.
#                   Reachable from home network AND remote (coffee shop, travel).
#   --local / -l    Loopback to the container (ws://127.0.0.1:3300). Only useful
#                   when the operator is on the Mac hosting the docker containers
#                   AND the tunnel is unreachable. Faster (no TLS hop) but no
#                   fallback when the loopback is unavailable.
#
# The previous version of this script pinned to the loopback only; that broke
# remote access. This rewrite defaults to the public URL and treats local as
# an opt-in escape hatch for tunnel-down scenarios.
set -euo pipefail

MODE="public"
PUBLIC_RELAY_URL="wss://coreprt.webrnds.com"
RELAY_PORT="${BUZZ_HTTP_PORT:-3300}"
LOCAL_RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local|-l)
      MODE="local"
      shift
      ;;
    --public|-p)
      MODE="public"
      shift
      ;;
    --relay-url)
      [[ -n "${2:-}" ]] || { echo "error: --relay-url requires a wss://… argument" >&2; exit 64; }
      PUBLIC_RELAY_URL="$2"
      MODE="public"
      shift 2
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

if [[ "$MODE" == "local" ]]; then
  RELAY_URL="$LOCAL_RELAY_URL"
else
  RELAY_URL="$PUBLIC_RELAY_URL"

  # Pre-flight: warn if the public URL is unreachable AND we're not on a host
  # with WARP enrolled. Do not abort — the operator may want to test the
  # failure path and see the chat window's error message.
  #
  # Probe both wss:///_liveness AND the bare https:// root. A 200 on either
  # means the host reaches the tunnel. Capture the http_code into a variable
  # (do NOT pipe the curl through `>/dev/null 2>&1` first, or the captured
  # code is discarded and the warning fires unconditionally).
  relay_host="${PUBLIC_RELAY_URL//wss:\/\//}"
  liveness_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$PUBLIC_RELAY_URL/_liveness" 2>/dev/null || true)"
  liveness_status="${liveness_status:-000}"
  root_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "https://${relay_host}/" 2>/dev/null || true)"
  root_status="${root_status:-000}"
  if [[ "$liveness_status" != "200" && "$root_status" != "200" ]]; then
    echo "warning: $PUBLIC_RELAY_URL is unreachable from this host (liveness=$liveness_status, root=$root_status). Falling back to --local would require the docker container to be running on this machine." >&2
    echo "         If you are remote, ensure WARP is enrolled (warp-cli status) and split-tunnel includes ${relay_host}." >&2
  fi
fi

# Export the env var so launchd propagates it to the child process.
export BUZZ_RELAY_URL="${RELAY_URL}"

# Wire the desktop's "Welcome Team" (builtin:fizz + builtin:honey +
# builtin:bumble) to MiniMax-M3. The desktop app launches its own copy of
# `buzz-agent` per agent persona, and that subprocess reads BUZZ_AGENT_PROVIDER
# from inherited env (CorePrt-relay/crates/buzz-agent/src/config.rs:783).
#
# Without this, the desktop defaults to whatever the app's Info.plist
# bakes in (likely `anthropic`), so the Welcome Team appears idle in chat
# even though the relay is healthy. Pass the API key only if the operator
# has it in their env.
export BUZZ_AGENT_PROVIDER="${BUZZ_AGENT_PROVIDER:-minimax}"
export BUZZ_AGENT_MODEL="${BUZZ_AGENT_MODEL:-MiniMax-M3}"
# Operator stores the API key in ~/.config/coreprt/minimax.env (existing
# convention; verified 2026-08-05). Source it into the launcher env if not
# already set. set -a ensures all assigned vars auto-export to the
# child Buzz process.
if [[ -z "${MINIMAX_API_KEY:-}" && -f "$HOME/.config/coreprt/minimax.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$HOME/.config/coreprt/minimax.env"
  set +a
fi

# Production launcher is /usr/bin/open. Tests can override via
# BUZZ_DESKTOP_LAUNCHER to inject a stub that records the env.
LAUNCHER_BIN="${BUZZ_DESKTOP_LAUNCHER:-/usr/bin/open}"

echo "→ Starting Buzz.app with BUZZ_RELAY_URL=${RELAY_URL} BUZZ_AGENT_PROVIDER=${BUZZ_AGENT_PROVIDER} BUZZ_AGENT_MODEL=${BUZZ_AGENT_MODEL}"
exec "${LAUNCHER_BIN}" -a /Applications/Buzz.app --args "$@"
