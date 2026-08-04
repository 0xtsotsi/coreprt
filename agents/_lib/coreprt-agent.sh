#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${COREPRT_AGENT_INSTALL_ROOT:-$HOME/.local/share/coreprt-agents}"
CONFIG_ROOT="${COREPRT_AGENT_CONFIG_ROOT:-$HOME/.config/coreprt/agents}"
LOG_ROOT="${COREPRT_AGENT_LOG_ROOT:-$HOME/Library/Logs/CorePrt/agents}"
LAUNCH_AGENT_ROOT="$HOME/Library/LaunchAgents"
AGENTS=(fizz bumble goji)

usage() {
  cat <<'USAGE'
Usage: coreprt-agent <install|start|stop|restart|status|logs> [fizz|bumble|goji|all]

Agent secrets belong in ~/.config/coreprt/agents/<name>.env with mode 600.
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
  mkdir -p "$INSTALL_ROOT" "$CONFIG_ROOT" "$LOG_ROOT"
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

command="${1:-}"
target="${2:-all}"
[[ -n "$command" ]] || { usage; exit 64; }

case "$command" in
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
    while IFS= read -r agent; do
      if launchctl print "gui/$(id -u)/$(label_for "$agent")" >/dev/null 2>&1; then
        echo "$agent: loaded"
      else
        echo "$agent: stopped"
      fi
    done < <(selected_agents "$target")
    ;;
  logs)
    while IFS= read -r agent; do
      echo "== $agent =="
      tail -n 50 "$LOG_ROOT/$agent/agent.log" "$LOG_ROOT/$agent/agent.err.log" 2>/dev/null || true
    done < <(selected_agents "$target")
    ;;
  *)
    usage
    exit 64
    ;;
esac
