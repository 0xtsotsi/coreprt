#!/usr/bin/env bash
set -euo pipefail

# Resolve the real source path of this script. When invoked via a symlink
# (the `~/.local/bin/coreprt-agent` -> `agents/_lib/coreprt-agent.sh`
# symlink) or via PATH (where BASH_SOURCE[0] is just the script name), the
# naive `dirname "${BASH_SOURCE[0]}"` resolves wrong. `realpath` follows the
# symlink to the actual repo location.
SOURCE_ROOT="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
INSTALL_ROOT="${COREPRT_AGENT_INSTALL_ROOT:-$HOME/.local/share/coreprt-agents}"
CONFIG_ROOT="${COREPRT_AGENT_CONFIG_ROOT:-$HOME/.config/coreprt/agents}"
LOG_ROOT="${COREPRT_AGENT_LOG_ROOT:-$HOME/Library/Logs/CorePrt/agents}"
LAUNCH_AGENT_ROOT="$HOME/Library/LaunchAgents"
AGENTS=(fizz bumble goji)

usage() {
  cat <<'USAGE'
Usage: coreprt-agent <command> [args]

Lifecycle (one per agent or "all"):
  install   Sync source to ~/.local/share/coreprt-agents/ and bootstrap
  start     Start the named agent LaunchAgent
  stop      Stop the named agent LaunchAgent
  restart   Re-sync source and restart
  status    Print loaded status
  logs      Tail the named agent log
  sync-ggcoder  Re-sync gg-coder built-in capabilities (--force / --dry-run)

One-shot commands (operator-driven, exit after publishing or reading):
  publish   <name> [--kind k] [--content text] [--tag k=v ...]
  req       <name> --kind k [--tag k=v ...] [--search q] [--limit n]
  search    <name> "<query>" --channel <uuid> [--limit n]
  digest    <name> [--since <hours>]
  invite    <name> --ttl <hours> [--code-len n]
  user-status <name> set --state <state> --text <text> [--emoji E] [--ttl D] [--reference URL]
  user-status <name> clear
  crm-onboard <name> --client X --contact Y --scope Z [--budget-hours N] [--title T] [--memo-file F]
  crm-status  <name> --deal <dealId>
  crm-receipt <name> --deal X --scope Y --job Z --kind K --content C
  dispatch    <name> [show|inspect|resolve|test] [--tag k=v ...] [--content C] [--kind N]
  lemma-bridge <name> [env-init [path]|cursor [reset]|dedupe|check|delete]

Agent secrets live in ~/.config/coreprt/agents/<name>.env with mode 600.
CRM bridge config (optional) lives in ~/.config/coreprt/crm.env with mode 600.
USAGE
}

selected_agents() {
  local requested="${1:-all}"
  if [[ "$requested" == all ]]; then
    printf '%s\n' "${AGENTS[@]}"
    return
  fi
  for agent in "${AGENTS[@]}"; do
    if [[ "$agent" == "$requested" ]]; then
      printf '%s\n' "$agent"
      return
    fi
  done
  echo "unknown agent: $requested" >&2
  exit 64
}

label_for() {
  printf 'com.coreprt.agent.%s' "$1"
}

sync_runtime() {
  mkdir -p "$INSTALL_ROOT" "$CONFIG_ROOT" "$LOG_ROOT" \
           "$INSTALL_ROOT/_lib/one-shot"
  rsync -a --delete --exclude node_modules --exclude '*.log' \
    "$SOURCE_ROOT/" "$INSTALL_ROOT/"
  if [[ ! -d "$INSTALL_ROOT/_lib/node_modules" ]]; then
    (cd "$INSTALL_ROOT/_lib" && npm install --omit=dev --ignore-scripts)
  fi
}

write_plist() {
  local agent="$1"
  local label plist
  label="$(label_for "$agent")"
  plist="$LAUNCH_AGENT_ROOT/$label.plist"
  mkdir -p "$LAUNCH_AGENT_ROOT" "$LOG_ROOT/$agent"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_ROOT/$agent/run/start.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$INSTALL_ROOT/_lib</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_ROOT/$agent/agent.log</string>
  <key>StandardErrorPath</key><string>$LOG_ROOT/$agent/agent.err.log</string>
</dict>
</plist>
PLIST
  chmod 600 "$plist"
  plutil -lint "$plist" >/dev/null
}

start_agent() {
  local agent="$1"
  local label plist
  label="$(label_for "$agent")"
  plist="$LAUNCH_AGENT_ROOT/$label.plist"
  [[ -f "$CONFIG_ROOT/$agent.env" ]] || {
    echo "missing $CONFIG_ROOT/$agent.env" >&2
    return 78
  }
  chmod 600 "$CONFIG_ROOT/$agent.env"
  write_plist "$agent"
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$label"
  else
    launchctl bootstrap "gui/$(id -u)" "$plist"
  fi
}

run_one_shot() {
  local command="$1"
  local agent="$2"
  shift 2
  if [[ -z "$agent" ]]; then
    echo "usage: coreprt-agent $command <fizz|bumble|goji> [args...]" >&2
    exit 64
  fi
  case "$agent" in fizz|bumble|goji) ;; *)
    echo "unknown agent: $agent" >&2
    exit 64
    ;;
  esac
  local env_file="$CONFIG_ROOT/$agent.env"
  if [[ ! -f "$env_file" ]]; then
    echo "missing $env_file" >&2
    exit 78
  fi
  sync_runtime
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  export AGENT_NAME="$agent"
  export AGENT_RELAY_URL="${AGENT_RELAY_URL:-ws://127.0.0.1:3300}"
  export BUZZ_RELAY_HOST="${BUZZ_RELAY_HOST:-coreprt.webrnds.com}"
  export AGENT_LOG_PREFIX="${AGENT_LOG_PREFIX:-$agent}"
  local cmd_dir="$INSTALL_ROOT/_lib/one-shot"
  if [[ ! -f "$cmd_dir/$command.mjs" ]]; then
    echo "no such one-shot: $command (missing $cmd_dir/$command.mjs)" >&2
    exit 78
  fi
  cd "$INSTALL_ROOT/_lib"
  exec node "$cmd_dir/$command.mjs" "$agent" "$@"
}

command="${1:-}"
target="${2:-all}"
[[ -n "$command" ]] || { usage; exit 64; }

case "$command" in
  sync-ggcoder)
    exec node "$SOURCE_ROOT/../scripts/sync-ggcoder.mjs" "$@"
    ;;
  install|start|restart)
    sync_runtime
    while IFS= read -r agent; do
      start_agent "$agent"
      echo "started $agent"
    done < <(selected_agents "$target")
    ;;
  stop)
    while IFS= read -r agent; do
      launchctl bootout "gui/$(id -u)/$(label_for "$agent")" 2>/dev/null || true
      echo "stopped $agent"
    done < <(selected_agents "$target")
    ;;
  status)
    # Smart dispatch: when the third arg is `set`/`clear`, route to the
    # NIP-38 user-status one-shot. Otherwise fall back to the lifecycle
    # "loaded/stopped" check.
    if [[ "${3:-}" == "set" || "${3:-}" == "clear" ]]; then
      run_one_shot "user-status" "$target" "${@:3}"
    else
      while IFS= read -r agent; do
        if launchctl print "gui/$(id -u)/$(label_for "$agent")" >/dev/null 2>&1; then
          echo "$agent: loaded"
        else
          echo "$agent: stopped"
        fi
      done < <(selected_agents "$target")
    fi
    ;;
  logs)
    while IFS= read -r agent; do
      echo "== $agent =="
      tail -n 50 "$LOG_ROOT/$agent/agent.log" "$LOG_ROOT/$agent/agent.err.log" 2>/dev/null || true
    done < <(selected_agents "$target")
    ;;
  publish|req|search|digest|invite|user-status|crm-onboard|crm-status|crm-receipt|dispatch|lemma-bridge)
    run_one_shot "$command" "$target" "${@:3}"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    usage
    exit 64
    ;;
esac
