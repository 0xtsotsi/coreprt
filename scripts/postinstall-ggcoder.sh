#!/usr/bin/env bash
# postinstall-ggcoder.sh — run after `npm install -g @kenkaiiii/ggcoder` to
# re-sync CorePrt's .gg/ directory with any new gg-coder capabilities.
#
# Wraps scripts/sync-ggcoder.mjs. Silent on no-op (already in sync).
# Logs to ~/Library/Logs/CorePrt/ggcoder-sync.log on explicit invocation.

set -euo pipefail
REPO_ROOT="${COREPRT_REPO_ROOT:-$HOME/Documents/projects/CorePrt}"
LOG_ROOT="${COREPRT_LOG_ROOT:-$HOME/Library/Logs/CorePrt}"
mkdir -p "$LOG_ROOT"
exec node "$REPO_ROOT/scripts/sync-ggcoder.mjs" 2>&1 | tee -a "$LOG_ROOT/ggcoder-sync.log"
