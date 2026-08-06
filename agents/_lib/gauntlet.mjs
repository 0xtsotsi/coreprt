// gauntlet.mjs — bar-and-critic execution loop, the CorePrt-fleet
// implementation of the gauntlet-loop skill vendored under
// agents/_lib/skills/gauntlet-loop/SKILL.md.
//
// The router (fizz) classifies a turn that mentions a `bar:<name>` tag
// or the `/gauntlet <bar-name>` slash command. This module does the
// runtime work:
//
//   1. Look up the bar in agents/_lib/skills/gauntlet-loop/bars/<name>.json
//   2. Build a JOB_REQUEST (kind:43001) with ["gauntlet", "<bar-name>"] in tags
//   3. Spawn a fresh-context critic (ken autopilot or Scout agent, depending on
//      AGENT_GAUNTLET_CRITIC) to do a blind A/B between our output and the bar
//   4. Publish the verdict as a kind:1111 (NIP-22) comment on the builder's event
//   5. On WIN, exit. On LOSE / EQUAL, inject the gap as a follow-up kind:9
//      to the builder and loop. Cap at MAX_GAUNTLET_ROUNDS (default 5).
//
// The bus type is eventId-keyed: every gauntlet run gets a stable runId
// so the kind:1111 verdict chain is queryable. Each round the run state
// (current bar, last verdict, round number) lives at:
//
//   {AGENT_STATE_DIR}/gauntlet/<runId>.json
//
// On crash or restart, the loop can be resumed by feeding the runId back
// into resumeRun().
//
// License: vendored skill spec is CC BY 4.0 (see NOTICE.md). Runtime code
// here is part of CorePrt (see /Users/gogetta/Documents/projects/CorePrt).

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_GAUNTLET_ROUNDS = Number(process.env.AGENT_GAUNTLET_MAX_ROUNDS ?? 5);
const BARS_DIR = new URL("./skills/gauntlet-loop/bars/", import.meta.url);

// STATE_DIR is read lazily so tests can override AGENT_STATE_DIR via
// process.env AFTER this module is imported (ESM hoists imports before
// any module-scope const assignments, so a top-level const would freeze
// the wrong path).
function getStateDir() {
  return process.env.AGENT_STATE_DIR ?? `${process.env.HOME}/.config/coreprt/agents/state`;
}

// ────────────────────────────────────────────────────────────────────────
// Bar registry
// ────────────────────────────────────────────────────────────────────────

/**
 * Load a named bar from the bar registry. Returns null if not found.
 * Each bar is a typed envelope:
 *   {
 *     kind: 'site' | 'doc' | 'repo' | 'paper' | 'video',
 *     ref: { url?, name?, owner? },
 *     fetch: 'screenshot' | 'curl' | 'clone' | 'paper',
 *     comparable: 'side-by-side' | 'benchmark' | 'rubric',
 *     notes: string
 *   }
 */
export function loadBar(name) {
  const path = new URL(`${name}.json`, BARS_DIR).pathname;
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return validateBar(raw);
  } catch {
    return null;
  }
}

function validateBar(b) {
  if (!b || typeof b !== "object") return null;
  const { kind, ref, fetch, comparable } = b;
  if (!["site", "doc", "repo", "paper", "video"].includes(kind)) return null;
  if (!ref || typeof ref !== "object") return null;
  if (!["screenshot", "curl", "clone", "paper"].includes(fetch)) return null;
  if (!["side-by-side", "benchmark", "rubric"].includes(comparable)) return null;
  return b;
}

/**
 * Enumerate every bar in the registry. Used by the router to surface
 * `/gauntlet` completions and by the panel to render the bar library.
 */
export function listBars() {
  const dir = new URL(BARS_DIR).pathname;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.replace(/\.json$/, ""), bar: loadBar(f.replace(/\.json$/, "")) }))
    .filter((x) => x.bar !== null);
}

// ────────────────────────────────────────────────────────────────────────
// Verdict parsing
// ────────────────────────────────────────────────────────────────────────

/**
 * Parse a critic reply into a typed verdict envelope.
 * Accepts:
 *   WIN
 *   LOSE — <single biggest gap>
 *   EQUAL — <what's still off>
 *   HUMAN — <reason>
 *
 * Returns { kind: 'win' | 'lose' | 'equal' | 'human', body, gap }.
 */
export function parseVerdict(reply) {
  const raw = (reply ?? "").trim();
  if (!raw) return { kind: "human", body: "critic returned empty reply" };
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  // First token: take the first whitespace-bounded word, uppercase it,
  // strip a trailing colon/period. Do NOT collapse all whitespace — the
  // body might be on the same line, e.g. "LOSE: type pairing is too quiet".
  const firstLine = (lines[i] ?? "").trim();
  const firstWord = firstLine.split(/[\s:.]+/, 1)[0]?.toUpperCase() ?? "";
  // Body: everything on the first line after the keyword (if any), plus
  // the rest of the lines, trimmed.
  const sameLineRest = firstLine.slice(firstWord.length).replace(/^[:.\s]+/, "");
  const body = [sameLineRest, ...lines.slice(i + 1)].join("\n").trim();
  if (firstWord === "WIN") return { kind: "win", body, gap: null };
  if (firstWord === "LOSE") return { kind: "lose", body, gap: body.split("\n")[0]?.slice(0, 280) || null };
  if (firstWord === "EQUAL") return { kind: "equal", body, gap: body.split("\n")[0]?.slice(0, 280) || null };
  if (firstWord === "HUMAN") return { kind: "human", body, gap: null };
  return { kind: "human", body: `unparseable verdict: ${firstWord}` };
}

// ────────────────────────────────────────────────────────────────────────
// Run state
// ────────────────────────────────────────────────────────────────────────

/**
 * Persist the current run state so a crash can resume.
 */
function persistRunState(runId, state) {
  const dir = join(getStateDir(), "gauntlet");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.json`);
  writeFileSync(path, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
}

function loadRunState(runId) {
  const path = join(getStateDir(), "gauntlet", `${runId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Critic spawn (ken autopilot path)
// ────────────────────────────────────────────────────────────────────────

/**
 * Run the ken autopilot critic on the builder's reply. Reuses the existing
 * `ggcoder --rpc` kenAuto protocol via the ggcoder-rpc-bridge.mjs already
 * present in the repo. Returns the raw reply text.
 *
 * Inputs:
 *   - bar: bar envelope from loadBar()
 *   - builderOutput: the kind:9 reply text the builder just published
 *   - builderEventId: Nostr event id of the builder's reply (used in prompt)
 */
export function runKenCritic({ bar, builderOutput, builderEventId }) {
  return new Promise((resolve) => {
    const prompt = buildCriticPrompt({ bar, builderOutput, builderEventId });
    const bridge = spawn(
      process.execPath,
      [new URL("./ggcoder-rpc-bridge.mjs", import.meta.url).pathname],
      { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, AGENT_GAUNTLET_CRITIC_MODE: "1" } },
    );
    let stdout = "";
    bridge.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    bridge.on("close", () => resolve(stdout.trim()));
    bridge.on("error", () => resolve(""));
    bridge.stdin.write(prompt);
    bridge.stdin.end();
  });
}

function buildCriticPrompt({ bar, builderOutput, builderEventId }) {
  const ref = bar.ref;
  const refString = ref.url ? `${ref.name ?? "the bar"} at ${ref.url}` : (ref.name ?? "the bar");
  return `You are the harsh critic in a gauntlet-loop comparison.

Builder's reply (Nostr event ${builderEventId}):
${builderOutput}

The bar is ${refString}. ${bar.notes ?? ""}

Your job: do a blind A/B between the builder's reply and the bar. Pick a verdict:

WIN   — the builder's reply beats the bar on every dimension you can measure.
LOSE  — the builder's reply loses; name the SINGLE biggest remaining gap in one line.
EQUAL — neither wins; name the SINGLE thing that would tip the scale in one line.
HUMAN — you cannot reach the bar (network, auth, etc.) and an operator must intervene.

Be harsh. Praise is not useful. Scores out of 10 drift upward every round.

Reply with exactly the keyword on the first line, then a one-paragraph body.`;
}

// ────────────────────────────────────────────────────────────────────────
// Public loop entry points
// ────────────────────────────────────────────────────────────────────────

/**
 * Start a new gauntlet run. Returns the runId so the caller can publish
 * progress events keyed to it. Caller must invoke nextRound() for each
 * builder reply they want judged.
 */
export function startRun({ runId, bar, builderPubkey, agent }) {
  const state = {
    runId,
    barName: bar.ref.name ?? "unnamed",
    builderPubkey,
    agent,
    round: 0,
    history: [],
    createdAt: Date.now(),
  };
  persistRunState(runId, state);
  return state;
}

/**
 * Judge one builder reply. Returns a verdict envelope plus the JSON
 * body the caller should publish as a kind:1111 NIP-22 comment.
 */
export async function nextRound({ runId, builderOutput, builderEventId }) {
  const state = loadRunState(runId) ?? { runId, history: [], round: 0 };
  state.round += 1;
  const bar = loadBar(state.barName);
  if (!bar) {
    const verdict = { kind: "human", body: `bar not found: ${state.barName}` };
    state.history.push({ round: state.round, builderEventId, verdict });
    persistRunState(runId, state);
    return {
      verdict,
      runId,
      body: buildVerdictKind1111Body({ verdict, bar: { ref: { name: state.barName } }, round: state.round, runId }),
      done: true,
    };
  }
  const reply = await runKenCritic({ bar, builderOutput, builderEventId });
  const verdict = parseVerdict(reply);
  state.history.push({ round: state.round, builderEventId, verdict });
  persistRunState(runId, state);
  return {
    verdict,
    runId,
    body: buildVerdictKind1111Body({ verdict, bar, round: state.round, runId }),
    done: verdict.kind === "win" || verdict.kind === "human" || state.round >= MAX_GAUNTLET_ROUNDS,
  };
}

/**
 * Build the NIP-22 (kind:1111) comment body for a verdict. The body is
 * plain-text readable AND machine-parseable: first line is the verdict
 * keyword, then a short paragraph. Tools can grep the first line.
 */
function buildVerdictKind1111Body({ verdict, bar, round, runId }) {
  const verdictKw = verdict.kind.toUpperCase();
  return `[gauntlet] round ${round}/${MAX_GAUNTLET_ROUNDS} — ${verdictKw}
bar: ${bar.ref.name ?? bar.ref.url ?? "unnamed"}
run: ${runId}
${verdict.body}`;
}

/**
 * Optional multi-agent red-team hook. When `redTeam.agents` is provided, this
 * routes the round through `runRedTeam()` and returns the coordinator's
 * aggregate verdict as the kind:1111 body. When `redTeam` is omitted or has
 * no agents, falls back to the single-critic ken autopilot path.
 *
 * Imported lazily to avoid a hard dep on agents/_lib/red-team.mjs at startup;
 * the function is only loaded when the opt-in path is actually taken.
 */
export async function nextRoundWithRedTeam({ runId, builderOutput, builderEventId, redTeam }) {
  const state = loadRunState(runId) ?? { runId, history: [], round: 0 };
  state.round += 1;
  const bar = loadBar(state.barName);
  const barEnvelope = bar ?? { ref: { name: state.barName } };

  // Lazy require so test suites that mock the ken critic do not pay for the
  // red-team module load and so the module can be absent in minimal builds.
  const { runRedTeam } = await import("./red-team.mjs");
  const aggregate = await runRedTeam({
    builderEventId,
    builderPubkey: state.builderPubkey,
    agents: redTeam.agents,
    log: redTeam.log ?? (() => {}),
    reviewTimeoutMs: redTeam.reviewTimeoutMs,
  });

  const verdict = aggregate.verdict ?? { kind: "human", body: "red-team produced no verdict" };
  state.history.push({
    round: state.round,
    builderEventId,
    verdict,
    counts: aggregate.counts,
    strongestDissent: aggregate.strongestDissent,
  });
  persistRunState(runId, state);

  const counts = aggregate.counts ?? { win: 0, lose: 0, equal: 0, no_verdict: 0 };
  const dissent = aggregate.strongestDissent;
  const body = buildRedTeamVerdictBody({ verdict, bar: barEnvelope, round: state.round, runId, counts, dissent });

  return {
    verdict,
    runId,
    body,
    done: verdict.kind === "win" || verdict.kind === "human" || state.round >= MAX_GAUNTLET_ROUNDS,
    aggregate,
  };
}

function buildRedTeamVerdictBody({ verdict, bar, round, runId, counts, dissent }) {
  const verdictKw = (verdict.kind ?? "human").toUpperCase();
  const tally = `[red-team] WIN ${counts.win} / LOSE ${counts.lose} / EQUAL ${counts.equal} / NO_VERDICT ${counts.no_verdict}`;
  const dissentLine = dissent
    ? `\nDISSENT: ${dissent.name}: ${dissent.verdict.kind.toUpperCase()} — ${dissent.verdict.body}`
    : "\nNo dissent.";
  return `[gauntlet] round ${round}/${MAX_GAUNTLET_ROUNDS} — ${verdictKw}
bar: ${bar.ref.name ?? bar.ref.url ?? "unnamed"}
run: ${runId}
${tally}${dissentLine}
${verdict.body ?? ""}`.trim();
}

/**
 * Resume a run from persisted state. Returns null if state is missing or
 * stale (older than 24h).
 */
export function resumeRun(runId) {
  const state = loadRunState(runId);
  if (!state) return null;
  if (Date.now() - state.updatedAt > 24 * 60 * 60 * 1000) return null;
  return state;
}

export const _internals = {
  MAX_GAUNTLET_ROUNDS,
  buildCriticPrompt,
  buildVerdictKind1111Body,
};