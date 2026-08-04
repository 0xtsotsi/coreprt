#!/usr/bin/env bash
# agents/bumble/run/digest.sh
#
# LaunchAgent-friendly wrapper around agents/_lib/one-shot/digest.mjs.
# Sources the bumble env, then execs Node. The LaunchAgent plist
# (com.gogetta.coreprt.bumble-digest.plist) loads us at 09:00 local.
#
# AGENT_CHANNEL_UUID must be set in the bumble env file. The plist only
# sets PATH and HOME; channel identity lives in the env file alongside
# the agent nsec. This keeps channel UUIDs out of plist files (which
# require launchctl reload to change) and out of source (which would
# leak the active channel into the repo).

set -euo pipefail

AGENT_NAME=bumble
ENV_FILE="${COREPRT_AGENT_ENV:-$HOME/.config/coreprt/agents/$AGENT_NAME.env}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../_lib" && pwd)"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 78; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export AGENT_NAME
export AGENT_LOG_PREFIX="${AGENT_LOG_PREFIX:-$AGENT_NAME}"
export AGENT_RELAY_URL="${AGENT_RELAY_URL:-ws://127.0.0.1:3300}"
export BUZZ_RELAY_HOST="${BUZZ_RELAY_HOST:-coreprt.webrnds.com}"
# AGENT_CHANNEL_UUID is intentionally not defaulted here. The env file
# is the single source of truth. digest.mjs fails with a clear error
# if it's unset.
export AGENT_RUNTIME="${AGENT_RUNTIME:-codex}"
export AGENT_MODEL="${AGENT_MODEL:-MiniMax-M3}"
export AGENT_SYSTEM_PROMPT="${AGENT_SYSTEM_PROMPT:-You write concise community digests. Output one short paragraph (≤480 chars) with up to 3 inline nostr: deep links to the most important messages cited. No preamble.}"

cd "$LIB_DIR"
exec node one-shot/digest.mjs "$AGENT_NAME" "$@"
