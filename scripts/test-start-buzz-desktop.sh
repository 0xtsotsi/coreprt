#!/usr/bin/env bash
# test-start-buzz-desktop.sh — verify the Buzz desktop launcher behavior.
#
# Run: `bash scripts/test-start-buzz-desktop.sh`
# Exit 0 on full pass, 1 on first failure.
#
# Strategy: the launcher reads `BUZZ_DESKTOP_LAUNCHER` for the `open` binary to
# invoke. We point that at a stub script that records its argv + env, run the
# launcher against all the flag/env combinations we care about, and assert
# the recorded state matches expectations.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/start-buzz-desktop-local.sh"
STUB_DIR="$(mktemp -d -t buzz-test.XXXXXX)"
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/open" <<'EOF'
#!/usr/bin/env bash
# Stub for /usr/bin/open invoked by the launcher. Records the env so the
# test harness can read it back. stdout is line-oriented and grep-friendly.
echo "STUB_OPEN_ARGS=$*"
echo "STUB_OPEN_BUZZ_RELAY_URL=${BUZZ_RELAY_URL:-<unset>}"
echo "STUB_OPEN_BUZZ_HTTP_PORT=${BUZZ_HTTP_PORT:-<unset>}"
exit 0
EOF
chmod +x "$STUB_DIR/open"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

pass() {
  echo "ok  - $1"
}

# Run the launcher with our stub, returning the captured output.
run_launcher() {
  local out
  out=$(BUZZ_DESKTOP_LAUNCHER="$STUB_DIR/open" "$LAUNCHER" "$@" 2>&1) || true
  printf '%s\n' "$out"
}

check_value() {
  # check_value <label> <needle> <output>
  local label="$1" needle="$2" output="$3"
  if grep -qF "$needle" <<<"$output"; then
    pass "$label ($needle)"
  else
    fail "$label — expected output to contain '$needle' but got:
$output"
  fi
}

check_absent() {
  # check_absent <label> <needle> <output> — opposite of check_value.
  local label="$1" needle="$2" output="$3"
  if grep -qF "$needle" <<<"$output"; then
    fail "$label — expected output to NOT contain '$needle' but got:
$output"
  else
    pass "$label"
  fi
}

# ─── 1. Bash syntax check ───────────────────────────────────────────────────
if bash -n "$LAUNCHER"; then
  pass "bash -n parses cleanly"
else
  fail "bash -n found a syntax error"
fi

# ─── 2. Default mode pins to public URL ────────────────────────────────────
out=$(run_launcher)
check_value "default mode" "STUB_OPEN_BUZZ_RELAY_URL=wss://coreprt.webrnds.com" "$out"

# ─── 3. --local / -l pin to loopback ───────────────────────────────────────
out=$(run_launcher --local)
check_value "--local mode" "STUB_OPEN_BUZZ_RELAY_URL=ws://127.0.0.1:3300" "$out"
out=$(run_launcher -l)
check_value "-l mode" "STUB_OPEN_BUZZ_RELAY_URL=ws://127.0.0.1:3300" "$out"

# ─── 4. -p / --public force public URL even if env tried to override ──────
out=$(BUZZ_RELAY_URL=ws://127.0.0.1:9999 run_launcher --public)
check_value "--public forces public" "STUB_OPEN_BUZZ_RELAY_URL=wss://coreprt.webrnds.com" "$out"

# ─── 5. --relay-url <url> overrides ───────────────────────────────────────
out=$(run_launcher --relay-url wss://staging.example.test)
check_value "--relay-url override" "STUB_OPEN_BUZZ_RELAY_URL=wss://staging.example.test" "$out"

# ─── 6. BUZZ_HTTP_PORT changes loopback port, not public URL ───────────────
out=$(BUZZ_HTTP_PORT=4242 run_launcher --local)
check_value "BUZZ_HTTP_PORT honored on --local" "STUB_OPEN_BUZZ_RELAY_URL=ws://127.0.0.1:4242" "$out"
out=$(BUZZ_HTTP_PORT=4242 run_launcher)
check_value "BUZZ_HTTP_PORT ignored in public mode" "STUB_OPEN_BUZZ_RELAY_URL=wss://coreprt.webrnds.com" "$out"

# ─── 7. Unknown flag is forwarded to the launcher binary as a positional ─
# The script's arg parser falls through unknown flags via `break` so they
# reach the underlying `open` call. This is intentional — argv after the
# recognized flags is forwarded via `open --args` to Buzz.app itself.
out=$(BUZZ_DESKTOP_LAUNCHER="$STUB_DIR/open" "$LAUNCHER" --no-such-flag 2>/dev/null) || true
check_value "unknown flag forwarded as positional" "STUB_OPEN_ARGS=-a /Applications/Buzz.app --args --no-such-flag" "$out"

# ─── 8. --relay-url without an argument is rejected ───────────────────────
if BUZZ_DESKTOP_LAUNCHER="$STUB_DIR/open" "$LAUNCHER" --relay-url 2>/dev/null; then
  fail "--relay-url without a value should have been rejected"
fi
pass "--relay-url without value rejected"

# ─── 9. --help does not invoke the launcher ───────────────────────────────
out=$(BUZZ_DESKTOP_LAUNCHER="$STUB_DIR/open" "$LAUNCHER" --help 2>&1) || true
if grep -qF "STUB_OPEN_" <<<"$out"; then
  fail "--help should not invoke the launcher binary"
fi
pass "--help does not invoke the launcher"

# ─── 10. Trailing args are forwarded to the launcher binary ───────────────
out=$(run_launcher --local -- --debug --feature=x)
check_value "trailing args forwarded via --" "STUB_OPEN_ARGS=-a /Applications/Buzz.app --args -- --debug --feature=x" "$out"

# ─── 11. Stub receives the right /Applications/Buzz.app target ────────────
out=$(run_launcher)
check_value "open targets Buzz.app" "STUB_OPEN_ARGS=-a /Applications/Buzz.app" "$out"

# ─── 12. Pre-flight warning does NOT fire when the public URL is reachable ─
# Use --relay-url pointing at example.com. The wss:// probe will not return
# 200 (example.com doesn't serve _liveness), but the https://example.com/
# fallback probe does. The launcher ORs both probes, so no warning.
out=$(run_launcher --relay-url wss://example.com)
check_absent "no warning when root URL is reachable" "warning: wss://example.com is unreachable" "$out"

# ─── 13. Pre-flight warning DOES fire when neither probe reaches the host ─
# 127.0.0.1:1 is a closed port — both probes get connection-refused
# instantly, so this test stays fast (no curl timeout).
out=$(run_launcher --relay-url wss://127.0.0.1:1)
check_value "warning fires on unreachable URL" "warning: wss://127.0.0.1:1 is unreachable" "$out"

# ─── 14. --local mode skips the pre-flight warning entirely ────────────────
out=$(run_launcher --local)
check_absent "no warning in --local mode" "warning:" "$out"

echo
echo "All launcher tests passed."
