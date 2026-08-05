#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME=bumble
ENV_FILE="${COREPRT_AGENT_ENV:-$HOME/.config/coreprt/agents/$AGENT_NAME.env}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../_lib" && pwd)"
[[ -f "$ENV_FILE" ]] || { echo "missing agent config: $ENV_FILE" >&2; exit 78; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export AGENT_NAME
export AGENT_LOG_PREFIX="${AGENT_LOG_PREFIX:-$AGENT_NAME}"
export AGENT_RELAY_URL="${AGENT_RELAY_URL:-ws://127.0.0.1:3300}"
export BUZZ_RELAY_HOST="${BUZZ_RELAY_HOST:-coreprt.webrnds.com}"
export AGENT_CHANNEL_UUID="${AGENT_CHANNEL_UUID:-0afe2e00-a9c7-4941-954f-c200c2429e3f}"
export AGENT_RUNTIME=ggcoder
export AGENT_MODEL="${AGENT_MODEL:-MiniMax-M3}"
export AGENT_TRIGGER="${AGENT_TRIGGER:-@bumble}"
export AGENT_SYSTEM_PROMPT="${AGENT_SYSTEM_PROMPT:-You are bumble, a thoughtful CorePrt coding agent. Be concise, practical, and friendly.}"
# Persistent ggcoder --rpc bridge. Model stays loaded across turns;
# session memory (BANANA-style) works; slash commands + autopilot work.
# Set AGENT_GGCODER_RPC=0 in the .env to fall back to spawn-per-message.
export AGENT_GGCODER_RPC="${AGENT_GGCODER_RPC:-1}"

cd "$LIB_DIR"
exec node runtime.mjs
