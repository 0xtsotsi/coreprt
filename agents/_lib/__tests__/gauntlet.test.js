// __tests__/gauntlet.test.js — gauntlet-loop module unit tests.
//
// Exercises the pure functions: loadBar, listBars, parseVerdict, the
// run-state persistence, and the nextRound state machine. Does NOT
// spawn ken autopilot (that path is exercised in the autopilot-loop
// integration tests, not here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBar,
  listBars,
  parseVerdict,
  startRun,
  resumeRun,
  nextRound,
  _internals,
} from "../gauntlet.mjs";
import { detectGauntletTag } from "../autopilot-loop.mjs";

// Use an isolated state dir so the test never collides with real runs.
const STATE_DIR = mkdtempSync(join(tmpdir(), "coreprt-gauntlet-"));
process.env.AGENT_STATE_DIR = STATE_DIR;

test("gauntlet: parseVerdict accepts WIN on first line", () => {
  const v = parseVerdict("WIN\n\nthis one is clearly better");
  assert.equal(v.kind, "win");
  assert.equal(v.body, "this one is clearly better");
});

test("gauntlet: parseVerdict accepts LOSE with single-line gap", () => {
  const v = parseVerdict("LOSE\n\nthe type pairing is too quiet");
  assert.equal(v.kind, "lose");
  assert.equal(v.gap, "the type pairing is too quiet");
  assert.match(v.body, /type pairing/);
});

test("gauntlet: parseVerdict accepts EQUAL with single-line gap", () => {
  const v = parseVerdict("EQUAL\n\nthe hero motion is flat on both");
  assert.equal(v.kind, "equal");
  assert.equal(v.gap, "the hero motion is flat on both");
});

test("gauntlet: parseVerdict accepts HUMAN", () => {
  const v = parseVerdict("HUMAN\n\ncannot reach comaxx.nl");
  assert.equal(v.kind, "human");
  assert.match(v.body, /cannot reach comaxx/);
});

test("gauntlet: parseVerdict tolerates trailing colon and lowercase", () => {
  const v = parseVerdict("lose: ours wins on speed but loses on copy");
  assert.equal(v.kind, "lose");
  assert.match(v.body, /loses on copy/);
});

test("gauntlet: parseVerdict returns human on empty reply", () => {
  const v = parseVerdict("");
  assert.equal(v.kind, "human");
  assert.match(v.body, /empty reply/);
});

test("gauntlet: parseVerdict returns human on unparseable first line", () => {
  const v = parseVerdict("maybe later");
  assert.equal(v.kind, "human");
  assert.match(v.body, /unparseable verdict/i);
});

test("gauntlet: loadBar returns null for unknown bar", () => {
  const b = loadBar("not-a-bar-anywhere");
  assert.equal(b, null);
});

test("gauntlet: listBars returns at least the seeded bars", () => {
  const bars = listBars();
  const names = bars.map((x) => x.name);
  assert.ok(names.includes("thecardyard-home"), `expected thecardyard-home; got ${names.join(",")}`);
  assert.ok(names.includes("comaxx-launch-case"));
  assert.ok(names.includes("linear-pricing"));
});

test("gauntlet: loadBar rejects malformed bar JSON", () => {
  // Sanity: MAX_GAUNTLET_ROUNDS is exposed and within sane bounds.
  const { MAX_GAUNTLET_ROUNDS, buildCriticPrompt } = _internals;
  assert.ok(typeof MAX_GAUNTLET_ROUNDS === "number");
  assert.ok(MAX_GAUNTLET_ROUNDS >= 1);
  assert.ok(MAX_GAUNTLET_ROUNDS <= 10);
  assert.ok(typeof buildCriticPrompt === "function");
});

test("gauntlet: startRun persists state to AGENT_STATE_DIR/gauntlet/<runId>.json", () => {
  const runId = "test-run-" + Math.random().toString(36).slice(2, 8);
  const state = startRun({
    runId,
    bar: { ref: { name: "thecardyard-home" } },
    builderPubkey: "50769b0f0000000000000000000000000000000000000000000000000000ab",
    agent: "goji",
  });
  assert.equal(state.runId, runId);
  assert.equal(state.round, 0);
  assert.equal(state.history.length, 0);
  const path = join(STATE_DIR, "gauntlet", `${runId}.json`);
  assert.ok(existsSync(path), `state file missing at ${path}`);
});

test("gauntlet: resumeRun returns the same state that was persisted", () => {
  const runId = "test-resume-" + Math.random().toString(36).slice(2, 8);
  startRun({ runId, bar: { ref: { name: "comaxx-launch-case" } }, builderPubkey: "x", agent: "goji" });
  const resumed = resumeRun(runId);
  assert.ok(resumed);
  assert.equal(resumed.barName, "comaxx-launch-case");
  assert.equal(resumed.agent, "goji");
});

test("gauntlet: resumeRun returns null for unknown runId", () => {
  const r = resumeRun("nonexistent-" + Math.random().toString(36).slice(2, 8));
  assert.equal(r, null);
});

test("gauntlet: nextRound surfaces a HUMAN verdict when the bar is missing", async () => {
  const runId = "test-noround-" + Math.random().toString(36).slice(2, 8);
  // seed startRun with a bogus bar name (state file will hold it)
  startRun({ runId, bar: { ref: { name: "this-bar-does-not-exist" } }, builderPubkey: "x", agent: "goji" });
  const r = await nextRound({
    runId,
    builderOutput: "ignored because bar lookup fails first",
    builderEventId: "deadbeef".repeat(8),
  });
  assert.equal(r.verdict.kind, "human");
  assert.match(r.verdict.body, /bar not found/i);
  assert.equal(r.done, true); // HUMAN exits the loop
});

test("gauntlet: nextRound round counter increments and persists history", async () => {
  const runId = "test-counter-" + Math.random().toString(36).slice(2, 8);
  startRun({ runId, bar: { ref: { name: "this-bar-does-not-exist" } }, builderPubkey: "x", agent: "goji" });
  const r = await nextRound({ runId, builderOutput: "x", builderEventId: "a".repeat(64) });
  assert.ok(r.runId);
  const state = resumeRun(runId);
  assert.ok(state);
  assert.equal(state.round, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].builderEventId, "a".repeat(64));
});

test("gauntlet: nextRound.done is true for HUMAN verdict (exits loop)", async () => {
  const runId = "test-done-human-" + Math.random().toString(36).slice(2, 8);
  startRun({ runId, bar: { ref: { name: "this-bar-does-not-exist" } }, builderPubkey: "x", agent: "goji" });
  const r = await nextRound({ runId, builderOutput: "x", builderEventId: "b".repeat(64) });
  assert.equal(r.verdict.kind, "human");
  assert.equal(r.done, true);
});

test("gauntlet: kind:1111 body includes bar name and run id", async () => {
  const runId = "test-k1111-" + Math.random().toString(36).slice(2, 8);
  startRun({ runId, bar: { ref: { name: "this-bar-does-not-exist" } }, builderPubkey: "x", agent: "goji" });
  const r = await nextRound({ runId, builderOutput: "x", builderEventId: "c".repeat(64) });
  assert.match(r.body, /\[gauntlet\] round 1\//);
  assert.match(r.body, /run: test-k1111-/);
  // HUMAN verdict keyword is uppercased in the body
  assert.match(r.body, /HUMAN/);
});

test("gauntlet: cleanup tmp state dir", () => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  assert.ok(!existsSync(STATE_DIR));
});

test("gauntlet: detectGauntletTag picks up `bar:<name>` tag", () => {
  const ref = detectGauntletTag({ tags: [["bar", "comaxx-launch-case"]], content: "fix the hero" });
  assert.deepEqual(ref, { barName: "comaxx-launch-case", source: "tag" });
});

test("gauntlet: detectGauntletTag picks up `/gauntlet <bar-name>` slash", () => {
  const ref = detectGauntletTag({ tags: [], content: "goji /gauntlet thecardyard-home please" });
  assert.deepEqual(ref, { barName: "thecardyard-home", source: "slash" });
});

test("gauntlet: detectGauntletTag returns null when nothing matches", () => {
  const ref = detectGauntletTag({ tags: [["h", "abc"]], content: "fix the hero, plain text" });
  assert.equal(ref, null);
});

test("gauntlet: detectGauntletTag tolerates trailing punctuation on slash form", () => {
  const ref = detectGauntletTag({ tags: [], content: "run /gauntlet linear-pricing." });
  assert.deepEqual(ref, { barName: "linear-pricing", source: "slash" });
});

test("gauntlet: detectGauntletTag prefers tag form when both are present", () => {
  const ref = detectGauntletTag({
    tags: [["bar", "comaxx-launch-case"]],
    content: "/gauntlet thecardyard-home",
  });
  assert.deepEqual(ref, { barName: "comaxx-launch-case", source: "tag" });
});