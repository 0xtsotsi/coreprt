#!/usr/bin/env bash
# scripts/pr-loop.sh — drive a branch's PR to merge.
#
# Loop:
#   1. Wait for CI to settle (gh pr checks --watch --fail-fast).
#   2. On fail → run /compare against the failing diff.
#   3. On PROMPT → publish the fix prompt to the agent's relay channel + leave it
#      as a PR comment. The agent runtime (running elsewhere) consumes the kind:9,
#      applies the fix, commits, and pushes. We then wait for the new HEAD.
#   4. On ALL_CLEAR with CI green + APPROVED review → squash-merge & delete branch.
#   5. Stop on HUMAN verdict, on merge, or after PR_LOOP_MAX_ROUNDS rounds.
#
# Operator overrides (env vars):
#   PR_LOOP_MAX_ROUNDS  default 5  — hard cap on loop iterations.
#   PR_LOOP_BASE        default main — merge base.
#   PR_LOOP_DRY_RUN     default 0   — set to 1 to log only, never push / merge.
#   PR_LOOP_LABEL       default unset — only act on PRs with this label.
#   PR_LOOP_POLL        default 30  — seconds between CI-state polls.
#   PR_LOOP_AGENT       default empty — agent handle (e.g. "goji") for @-mention in
#                                       the published kind:9. If empty, the prompt is
#                                       only posted as a PR comment.
#
# Usage:
#   ./scripts/pr-loop.sh                 # drive the current branch's PR
#   ./scripts/pr-loop.sh <pr-number>     # drive a specific PR
#   PR_LOOP_DRY_RUN=1 ./scripts/pr-loop.sh
#
# Exits non-zero on hard failure. Exit codes:
#   2  gh not authenticated
#   3  on base branch
#   4  no PR / pass a PR number
#   5  label guard failed
#   6  CI failing and /compare says ALL_CLEAR (operator must investigate)
#   7  fix prompt could not be published
#   8  unparseable verdict
#   9  max rounds reached
#   10 PR is closed
#   11 gh pr merge failed despite pr_merge_ready (race or branch-protection change)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MAX_ROUNDS="${PR_LOOP_MAX_ROUNDS:-5}"
BASE="${PR_LOOP_BASE:-main}"
DRY_RUN="${PR_LOOP_DRY_RUN:-0}"
LABEL="${PR_LOOP_LABEL:-}"
POLL="${PR_LOOP_POLL:-30}"
AGENT="${PR_LOOP_AGENT:-}"

COMPARE_PROMPT_FILE="$REPO_ROOT/.gg/commands/compare.md"

# Globals set by run_compare; read by the caller.
LAST_VERDICT=""
LAST_BODY=""

log()  { printf '[pr-loop] %s\n' "$*"; }
warn() { printf '[pr-loop] WARN: %s\n' "$*" >&2; }
die()  { printf '[pr-loop] %s\n' "$*" >&2; exit "${2:-1}"; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1" 127; }

require gh
require git
require jq

gh auth status >/dev/null 2>&1 || die "gh not authenticated — run \`gh auth login\` first" 2

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "$BASE" ]] || die "refusing to drive the base branch ($BASE) — check out a feature branch" 3

PR_NUMBER="${1:-}"
if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER="$(gh pr view --json number --jq '.number' 2>/dev/null || true)"
fi
[[ -n "$PR_NUMBER" ]] || die "no PR found for branch $BRANCH — pass a PR number or open one first" 4

log "branch=$BRANCH pr=#$PR_NUMBER base=$BASE max_rounds=$MAX_ROUNDS dry_run=$DRY_RUN"

if [[ -n "$LABEL" ]]; then
  pr_labels="$(gh pr view "$PR_NUMBER" --json labels --jq '.labels[].name' 2>/dev/null || true)"
  if ! grep -Fxq "$LABEL" <<<"$pr_labels"; then
    die "PR #$PR_NUMBER missing required label '$LABEL' (has: ${pr_labels:-none})" 5
  fi
fi

# Strip the YAML frontmatter from the compare.md prompt body so the model doesn't
# see the frontmatter as instructions.
compare_body() {
  awk 'BEGIN{p=0} /^---$/{c++; next} c==2{p=1} p' "$COMPARE_PROMPT_FILE"
}

# Run /compare against the current diff. Sets LAST_VERDICT and LAST_BODY so the
# caller can route on the verdict and route the body to the agent.
run_compare() {
  local diff
  diff="$(git diff "origin/$BASE"...HEAD 2>/dev/null || git diff HEAD)"
  if [[ -z "$diff" ]]; then
    LAST_VERDICT="IGNORE"
    LAST_BODY="no diff against origin/$BASE"
    return 0
  fi

  local prompt_file
  prompt_file="$(mktemp -t prloop.XXXXXX.md)"
  {
    echo "Run /compare against the diff below."
    echo
    echo '```diff'
    echo "$diff" | head -c 50_000
    echo
    echo '```'
  } > "$prompt_file"

  local out
  out="$("${HOME}/.local/bin/ggcoder-minimax" \
        --bare --print --max-turns 1 --provider minimax \
        --system-prompt "$(compare_body)" \
        --json "$(cat "$prompt_file")" 2>/dev/null || true)"
  rm -f "$prompt_file"

  # First non-empty line is the verdict; everything after is the body.
  LAST_VERDICT=""
  LAST_BODY=""
  local first=1
  while IFS= read -r line; do
    if [[ $first -eq 1 ]]; then
      line="${line#"${line%%[![:space:]]*}"}"   # ltrim
      line="${line%"${line##*[![:space:]]}"}"   # rtrim
      line="${line%%[:,.;]*}"                   # strip trailing punctuation
      line="${line// /_}"                       # "ALL CLEAR" → "ALL_CLEAR"
      LAST_VERDICT="$line"
      first=0
    else
      LAST_BODY+="$line"$'\n'
    fi
  done <<<"$out"
}

# Publish a PROMPT to the agent's relay channel as a kind:9. Falls back to a PR
# comment if AGENT_RELAY_URL / AGENT_CHANNEL_UUID / AGENT_NSEC are not set.
publish_fix_prompt() {
  local body="$1"
  local wrapped
  if [[ -n "$AGENT" ]]; then
    wrapped="@$AGENT $body"
  else
    wrapped="$body"
  fi

  if [[ -n "${AGENT_RELAY_URL:-}" && -n "${AGENT_CHANNEL_UUID:-}" && -n "${AGENT_NSEC:-}" ]]; then
    log "publishing fix prompt to relay channel"
    if [[ "$DRY_RUN" == "1" ]]; then
      warn "dry-run: would publish to $AGENT_RELAY_URL channel $AGENT_CHANNEL_UUID"
    else
      # Secrets flow via inherited env, NEVER argv. The helper reads
      # AGENT_NSEC / AGENT_RELAY_URL / AGENT_CHANNEL_UUID from its own env.
      # Only the literal prompt text crosses the process boundary.
      AGENT_NSEC="$AGENT_NSEC" \
      AGENT_RELAY_URL="$AGENT_RELAY_URL" \
      AGENT_CHANNEL_UUID="$AGENT_CHANNEL_UUID" \
      "${HOME}/.local/bin/ggcoder-minimax" \
        --bare --print --max-turns 1 \
        --system-prompt "You are the relay-publish helper. Build a Nostr kind:9 event with the user content below, sign it with AGENT_NSEC, and POST it to AGENT_RELAY_URL with the h tag set to AGENT_CHANNEL_UUID. Reply with the event id or an error." \
        "$wrapped" >/dev/null 2>&1 || warn "relay publish helper failed; falling back to PR comment"
    fi
  else
    log "AGENT_RELAY_URL/UUID/NSEC not set — posting fix prompt as PR comment only"
  fi

  gh pr comment "$PR_NUMBER" --body "$body" >/dev/null \
    || { warn "could not post PR comment"; return 1; }
}

# Wait for CI to leave the pending state. Prints the failing check names (one per
# line) on stdout, or empty if all green. Uses `gh pr checks --json` with the
# `bucket` field that's standardized across gh versions — more reliable than
# tab-parsing the text output (which has burned other repos in production).
ci_failing() {
  jq -r '.[] | select(.bucket == "fail" or .bucket == "cancel") | .name' \
    <(gh pr checks "$PR_NUMBER" --json name,state,bucket 2>/dev/null) 2>/dev/null
}

ci_pending() {
  local buckets
  buckets="$(gh pr checks "$PR_NUMBER" --json bucket --jq '[.[] | .bucket] | join(" ")' 2>/dev/null || true)"
  [[ -z "$buckets" ]] && return 1
  [[ "$buckets" == *"pending"* ]]
}

# `gh pr checks --json` is the structured pipeline; the old tab-text format was
# column-position-dependent and is the documented footgun in hermes-agent
# (terminal_tool.py:2724-2780). `bucket` is the canonical gh field: pass | fail
# | pending | skipping | cancel.
pr_state() {
  gh pr view "$PR_NUMBER" --json state --jq '.state' 2>/dev/null
}

# Merge-readiness check. Combines the aggregate `reviewDecision` (what branch
# protection actually enforces) with `mergeStateStatus` (BLOCKED / BEHIND /
# DIRTY / CLEAN) so we fail loud instead of letting `gh pr merge` error out.
# Per-reviewer `.reviews[].state` parsing misses stale CHANGES_REQUESTED that
# was later overridden — `reviewDecision` aggregates them correctly.
pr_merge_ready() {
  local fields
  fields="$(gh pr view "$PR_NUMBER" --json reviewDecision,mergeStateStatus \
              -q '.reviewDecision + " " + .mergeStateStatus' 2>/dev/null || true)"
  [[ "$fields" == "APPROVED CLEAN" ]]
}

round=0
state=""
status=""
while (( round < MAX_ROUNDS )); do
  round=$((round + 1))
  log "──── round $round/$MAX_ROUNDS ────"

  state="$(pr_state)"
  if [[ "$state" == "MERGED" ]]; then
    log "PR #$PR_NUMBER is merged — done"
    exit 0
  fi
  if [[ "$state" == "CLOSED" ]]; then
    die "PR #$PR_NUMBER is closed — aborting" 10
  fi

  # Wait for CI to settle.
  while ci_pending; do
    log "CI pending — sleeping ${POLL}s"
    sleep "$POLL"
    state="$(pr_state)"
    [[ "$state" == "MERGED" ]] && { log "merged while waiting"; exit 0; }
  done

  failing="$(ci_failing)"
  if [[ -n "$failing" ]]; then
    log "failing checks: $(echo "$failing" | tr '\n' ' ')"
    run_compare
    log "verdict: $LAST_VERDICT"
    case "$LAST_VERDICT" in
      ALL_CLEAR|IGNORE)
        warn "CI failing but /compare says $LAST_VERDICT — operator review required"
        gh pr comment "$PR_NUMBER" --body "🟡 /compare: $LAST_VERDICT but CI is failing. Operator review needed." >/dev/null || true
        exit 6
        ;;
      HUMAN)
        gh pr comment "$PR_NUMBER" --body "🟡 /compare: HUMAN — operator decision needed"$'\n\n'"$LAST_BODY" >/dev/null || true
        log "surfaced HUMAN to operator — exiting"
        exit 0
        ;;
      PROMPT)
        log "verdict=PROMPT — publishing fix prompt"
        publish_fix_prompt "$LAST_BODY" || die "could not publish fix prompt" 7
        log "agent should push a new commit; waiting ${POLL}s"
        sleep "$POLL"
        continue
        ;;
      *)
        warn "unparseable verdict: $LAST_VERDICT"
        exit 8
        ;;
    esac
  fi

  # CI green. Check merge readiness: aggregate reviewDecision + mergeStateStatus.
  if pr_merge_ready; then
    log "approved and CI green — merging"
    if [[ "$DRY_RUN" == "0" ]]; then
      if ! gh pr merge "$PR_NUMBER" --squash --delete-branch --body "/compare: ALL_CLEAR" >/dev/null; then
        warn "gh pr merge failed despite pr_merge_ready — operator review required"
        gh pr comment "$PR_NUMBER" --body "🔴 pr-loop: pr_merge_ready returned true but gh pr merge failed. Operator review required." >/dev/null || true
        exit 11
      fi
    fi
    exit 0
  fi

  # Surface why we didn't merge yet so the operator can act.
  status="$(gh pr view "$PR_NUMBER" --json reviewDecision,mergeStateStatus \
              -q '"review=\(.reviewDecision) mergeState=\(.mergeStateStatus)"' 2>/dev/null || true)"
  log "CI green but not merge-ready ($status) — sleeping ${POLL}s and rechecking"
  sleep "$POLL"
done

warn "max rounds ($MAX_ROUNDS) reached without merge"
exit 9
