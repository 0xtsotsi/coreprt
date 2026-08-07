#!/usr/bin/env bash
# start-opencli-bridge.sh — keep the host Mac awake and launch Chrome with the
# OpenCLI Browser Bridge extension attached, so ggcoder (or any agent with the
# opencli-browser skill) can drive popups that block the operator's workflow
# while they are remote + AFK.
#
# Why this exists:
#   The OpenCLI daemon (`opencli`) drives a *live* logged-in Chrome window
#   through a Browser Bridge extension. None of that works when:
#     - the Mac is asleep (laptop lid closed, power nap, or display sleep),
#     - Chrome is not running,
#     - or the extension has not been loaded into a profile.
#   This script holds the Mac awake with `caffeinate -disu` (display +
#   idle + system sleep suppressed, plus simulated user activity so
#   App Nap does not throttle the daemon or Chrome) and re-launches
#   Chrome in the default profile so the extension is loaded once it
#   has been added via chrome://extensions in Developer Mode.
#
# One-time setup (operator action):
#   1. Open chrome://extensions/ in this Chrome profile.
#   2. Toggle "Developer mode" (top right).
#   3. "Load unpacked" → select ~/.config/opencli/extensions/
#      (the unpacked manifest lives there after the v1.8.6 release
#      zip has been extracted).
#   4. Confirm `opencli doctor` reports the extension as connected.
#   5. Re-run this script whenever the operator wants the bridge active.
#
# Usage:
#   ./scripts/start-opencli-bridge.sh           # foreground, caffeinate
#                                               # outlives the script
#   kill <PID-from-output>                      # release the wake hold
#
# Exit codes:
#   0  Bridge ready (Chrome + daemon up + extension connected, caffeinate
#      running in background; output prints the PID to kill).
#   2  Setup incomplete (extension did not connect within 15s) — operator
#      needs to load the unpacked extension in chrome://extensions/.
#   3  Chrome not installed.
#   4  Failed to launch Chrome.
#   5  opencli not on PATH.
#   6  Browser Bridge extension not unpacked at ~/.config/opencli/extensions/.

set -euo pipefail

CHROME_APP="/Applications/Google Chrome.app"
DAEMON_BIN="$(command -v opencli || true)"
EXT_DIR="${HOME}/.config/opencli/extensions"

if [[ -z "${DAEMON_BIN}" ]]; then
  echo "error: opencli not on PATH. Install with: npm install -g @jackwener/opencli" >&2
  exit 5
fi
if [[ ! -d "${CHROME_APP}" ]]; then
  echo "error: ${CHROME_APP} not found." >&2
  exit 3
fi
if [[ ! -f "${EXT_DIR}/manifest.json" ]]; then
  echo "error: Browser Bridge extension not unpacked at ${EXT_DIR}." >&2
  echo "       Download from https://github.com/jackwener/OpenCLI/releases/tag/v1.8.6" >&2
  echo "       and unzip to ${EXT_DIR}." >&2
  exit 6
fi

# 1. Hold the system awake. -d = display sleep off, -i = idle sleep off,
# -s = system sleep off (lid close on a clamshell still respects power
# adapter when present; on battery this is a tradeoff the operator chose
# to make when launching this script). -u simulates user activity so
# App Nap does not throttle the daemon or Chrome.
#
# Important: we deliberately do NOT use `caffeinate -w <pid>`. Without
# `-w`, caffeinate holds the system awake indefinitely until killed —
# exactly what we want, since the script returns to its caller almost
# immediately. The PID is printed so the operator can `kill` it later.
echo "→ caffeinate -disu (hold Mac awake while bridge is active)"
caffeinate -disu &
CAFFEINATE_PID=$!
disown "${CAFFEINATE_PID}" 2>/dev/null || true

# INT/TERM should still kill caffeinate if the operator Ctrl-C's this
# terminal. EXIT is intentionally absent — letting `exit 0` fall through
# is what lets caffeinate outlive the script.
trap 'kill "${CAFFEINATE_PID}" 2>/dev/null || true' INT TERM

# 2. Make sure the OpenCLI daemon is up.
if ! pgrep -f "opencli.*daemon" >/dev/null 2>&1; then
  echo "→ Starting OpenCLI daemon"
  "${DAEMON_BIN}" daemon start >/dev/null 2>&1 || true
  sleep 1
fi

# 3. Launch Chrome in the default profile if not already running. `open -gj`
# brings the app to the front without launching a duplicate if one is
# already up; the bridge attaches via the extension, not by CDP fronting.
if ! pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "→ Launching Chrome (default profile)"
  /usr/bin/open -gj -a "${CHROME_APP}" || {
    echo "error: failed to launch Chrome." >&2
    kill "${CAFFEINATE_PID}" 2>/dev/null || true
    exit 4
  }
  # Give the extension a moment to register its service worker and
  # announce itself to the daemon. The doctor poll below is the real
  # gate; this is just a head start.
  sleep 3
else
  echo "→ Chrome already running"
fi

# 4. Poll doctor until the extension is connected. Doctor prefixes every
# line with `[OK]`, `[MISSING]`, or `[FAIL]`, so a connected extension
# produces an `[OK] Extension:` line.
echo "→ Waiting for Browser Bridge extension to connect (opencli doctor)..."
for attempt in {1..15}; do
  if "${DAEMON_BIN}" doctor 2>&1 | grep -qE '^\[OK\][[:space:]]+Extension:'; then
    echo ""
    echo "✓ Bridge ready."
    echo "    caffeinate PID: ${CAFFEINATE_PID}  (kill to release the wake hold)"
    echo "    drive the browser:  opencli browser <session> open <url>"
    exit 0
  fi
  sleep 1
done

echo "" >&2
echo "error: Browser Bridge extension did not connect within 15s." >&2
echo "" >&2
echo "  One-time setup:" >&2
echo "    1. Open chrome://extensions/ in this Chrome profile" >&2
echo "    2. Enable 'Developer mode' (top right)" >&2
echo "    3. 'Load unpacked' → ${EXT_DIR}" >&2
echo "    4. Re-run this script" >&2
echo "" >&2
kill "${CAFFEINATE_PID}" 2>/dev/null || true
exit 2
