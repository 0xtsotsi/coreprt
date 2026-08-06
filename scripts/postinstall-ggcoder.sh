#!/usr/bin/env bash
# postinstall-ggcoder.sh — run after `npm install -g @kenkaiiii/ggcoder` OR
# `npm install -g @kenkaiiii/gg-framework@latest` to re-sync CorePrt's .gg/
# directory with any new capabilities from either source.
#
# Wraps scripts/sync-ggcoder.mjs. The sync is source-aware: it picks up
# whichever of the two packages is installed and skips the other. Silent on
# no-op (already in sync). Logs to ~/Library/Logs/CorePrt/ggcoder-sync.log.
#
# To wire this script as the postinstall for gg-framework too, point its
# `package.json` "scripts.postinstall" at this absolute path, or symlink
# the file as `postinstall-gg-framework.sh` and reference it the same way
# gg-coder does.

set -euo pipefail
REPO_ROOT="${COREPRT_REPO_ROOT:-$HOME/Documents/projects/CorePrt}"
LOG_ROOT="${COREPRT_LOG_ROOT:-$HOME/Library/Logs/CorePrt}"
mkdir -p "$LOG_ROOT"
exec node "$REPO_ROOT/scripts/sync-ggcoder.mjs" 2>&1 | tee -a "$LOG_ROOT/ggcoder-sync.log"
