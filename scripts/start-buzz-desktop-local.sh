#!/usr/bin/env bash
# start-buzz-desktop-local.sh — launch Buzz.app with the local CorePrt relay.
#
# Why this exists:
#   CorePrt-relay/desktop/src-tauri/src/relay.rs precedence is:
#     workspace_relay_override → BUZZ_RELAY_URL → BUZZ_DESKTOP_BUILD_RELAY_URL → ws://localhost:3000
#   The binary at /Applications/Buzz.app has no BUZZ_DESKTOP_BUILD_RELAY_URL baked in
#   (strings dump confirmed — only `ws://localhost:3000` and public relay list).
#   It also has a workspace override that auto-pins to wss://coreprt.webrnds.com
#   when the public tunnel is reachable. Neither path picks the local relay.
#
#   Setting BUZZ_RELAY_URL=ws://127.0.0.1:3300 here wins over the hardcoded fallback
#   AND over the compile-time var. Whether it wins over the workspace override
#   depends on whether the override is read from disk at launch or held in memory
#   only — the script below clears the on-disk override to be safe.
set -euo pipefail

# Resolve the relay port. The relay listens on container port 3000, forwarded
# to host 127.0.0.1:3300 by colima. Read BUZZ_HTTP_PORT from .env if present.
RELAY_PORT="${BUZZ_HTTP_PORT:-3300}"
RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"

# Best-effort: clear any persisted workspace override so the env var wins.
# The override is stored somewhere under
#   ~/Library/Application Support/xyz.block.buzz.app/
# Try common keys — adjust as the storage format becomes known.
defaults delete xyz.block.buzz.app BUZZ_RELAY_URL 2>/dev/null || true
defaults delete xyz.block.buzz.app workspace_relay_override 2>/dev/null || true
defaults delete xyz.block.buzz.app relay_url 2>/dev/null || true

# Export the env var so launchd propagates it to the child process.
export BUZZ_RELAY_URL="${RELAY_URL}"

echo "→ Starting Buzz.app with BUZZ_RELAY_URL=${RELAY_URL}"
exec /usr/bin/open -a /Applications/Buzz.app --args "$@"