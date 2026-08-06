// agents/_lib/one-shot/__tests__/user-status.test.mjs
//
// Unit tests for the NIP-38 user-status library + CLI builder. The relay
// transport is NOT exercised here — it is mocked. These tests pin:
//   • parseTtl duration parsing
//   • normalizeState validation
//   • validateStateAndTtl state-machine rules
//   • buildStatusEventTemplate tag shape (d always, r when URL, expiration
//     only on TTL-bearing states)
//   • publishStatus env opt-out (COREPRT_AGENT_NO_STATUS=1)
//   • publishStatus mock-relay round-trip (signs, calls relay, returns result)
//   • clear path (empty content, d:general, no expiration)

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair, verifyEvent } from "../../nostr.mjs";
import {
  KIND_USER_STATUS,
  TTL_STATES,
  DEFAULT_TTL_SECONDS,
  parseTtl,
  normalizeState,
  validateStateAndTtl,
  buildStatusEventTemplate,
  isStatusDisabled,
} from "../../user-status.mjs";

// ─────────────────────────────────────────────────────────────────
// parseTtl
// ─────────────────────────────────────────────────────────────────
test("nip38: parseTtl accepts bare seconds", () => {
  assert.equal(parseTtl("3600"), 3600);
  assert.equal(parseTtl("0"), 0);
});

test("nip38: parseTtl accepts suffixed units", () => {
  assert.equal(parseTtl("1h"), 3600);
  assert.equal(parseTtl("30m"), 1800);
  assert.equal(parseTtl("90s"), 90);
  assert.equal(parseTtl("1d"), 86400);
  assert.equal(parseTtl("1w"), 604800);
});

test("nip38: parseTtl accepts compound suffixes", () => {
  assert.equal(parseTtl("2h30m"), 2 * 3600 + 30 * 60);
  assert.equal(parseTtl("1d2h3m4s"), 86400 + 2 * 3600 + 3 * 60 + 4);
});

test("nip38: parseTtl returns NaN on bad input", () => {
  assert.ok(Number.isNaN(parseTtl("")));
  assert.ok(Number.isNaN(parseTtl("nope")));
  assert.ok(Number.isNaN(parseTtl("1y"))); // year not supported
  assert.ok(Number.isNaN(parseTtl(null)));
  assert.ok(Number.isNaN(parseTtl(undefined)));
});

// ─────────────────────────────────────────────────────────────────
// normalizeState
// ─────────────────────────────────────────────────────────────────
test("nip38: normalizeState lowercases + trims", () => {
  assert.equal(normalizeState("Working"), "working");
  assert.equal(normalizeState("  DEEP-BUILD  "), "deep-build");
});

test("nip38: normalizeState accepts arbitrary custom d-tags", () => {
  // NIP-38: "Any other status types can be used but they are not defined
  // by this NIP."
  assert.equal(normalizeState("brb"), "brb");
  assert.equal(normalizeState("in_a_meeting"), "in_a_meeting");
});

test("nip38: normalizeState rejects garbage", () => {
  assert.throws(() => normalizeState(""), /non-empty string/);
  assert.throws(() => normalizeState(null), /non-empty string/);
  assert.throws(() => normalizeState("with space"), /invalid state/);
  assert.throws(() => normalizeState("a".repeat(64)), /invalid state/);
});

// ─────────────────────────────────────────────────────────────────
// validateStateAndTtl
// ─────────────────────────────────────────────────────────────────
test("nip38: validateStateAndTtl requires TTL for dnd/idle/deep-build", () => {
  for (const state of TTL_STATES) {
    const result = validateStateAndTtl(state, undefined);
    assert.ok(result.ok, `state ${state} should be ok`);
    assert.equal(result.ttlSeconds, DEFAULT_TTL_SECONDS, `${state} should default to 1h`);
  }
});

test("nip38: validateStateAndTtl rejects zero/negative TTL on TTL states", () => {
  const r = validateStateAndTtl("dnd", 0);
  assert.equal(r.ok, false);
  assert.match(r.error, /ttl is required/i);
  const r2 = validateStateAndTtl("idle", -10);
  assert.equal(r2.ok, false);
});

test("nip38: validateStateAndTtl accepts explicit TTL on TTL states", () => {
  const r = validateStateAndTtl("dnd", 1800);
  assert.ok(r.ok);
  assert.equal(r.ttlSeconds, 1800);
});

test("nip38: validateStateAndTtl allows no TTL for persistent states", () => {
  for (const state of ["general", "music", "working"]) {
    const r = validateStateAndTtl(state, undefined);
    assert.ok(r.ok);
    assert.equal(r.ttlSeconds, null);
  }
});

test("nip38: validateStateAndTtl warns when --ttl is set on persistent state", () => {
  const r = validateStateAndTtl("working", 3600);
  assert.ok(r.ok);
  assert.match(r.warning, /persistent/i);
});

// ─────────────────────────────────────────────────────────────────
// buildStatusEventTemplate — tag shape
// ─────────────────────────────────────────────────────────────────
test("nip38: buildStatusEventTemplate always includes the d tag", () => {
  for (const state of ["general", "music", "working", "idle", "dnd", "deep-build"]) {
    const t = buildStatusEventTemplate({ state, text: "hello" });
    const d = t.tags.find((tag) => tag[0] === "d");
    assert.ok(d, `state ${state} missing d tag`);
    assert.equal(d[1], state);
    assert.equal(t.kind, KIND_USER_STATUS);
  }
});

test("nip38: buildStatusEventTemplate omits r tag when no reference", () => {
  const t = buildStatusEventTemplate({ state: "working", text: "x" });
  assert.equal(t.tags.find((tag) => tag[0] === "r"), undefined);
});

test("nip38: buildStatusEventTemplate adds r tag when reference provided", () => {
  const t = buildStatusEventTemplate({
    state: "music",
    text: "song",
    reference: "spotify:search:abc",
  });
  const r = t.tags.find((tag) => tag[0] === "r");
  assert.ok(r);
  assert.equal(r[1], "spotify:search:abc");
});

test("nip38: buildStatusEventTemplate omits emoji tag when blank", () => {
  const t = buildStatusEventTemplate({ state: "general", text: "x", emoji: "   " });
  assert.equal(t.tags.find((tag) => tag[0] === "emoji"), undefined);
});

test("nip38: buildStatusEventTemplate trims emoji", () => {
  const t = buildStatusEventTemplate({ state: "general", text: "x", emoji: "  🚀 " });
  const e = t.tags.find((tag) => tag[0] === "emoji");
  assert.ok(e);
  assert.equal(e[1], "🚀");
});

test("nip38: buildStatusEventTemplate omits expiration on persistent states", () => {
  for (const state of ["general", "music", "working"]) {
    const t = buildStatusEventTemplate({ state, text: "x" });
    assert.equal(
      t.tags.find((tag) => tag[0] === "expiration"),
      undefined,
      `state ${state} should not have expiration`
    );
  }
});

test("nip38: buildStatusEventTemplate adds expiration on TTL states", () => {
  const before = 1_700_000_000;
  const t = buildStatusEventTemplate({
    state: "dnd",
    text: "in meeting",
    ttlSeconds: 1800,
    createdAt: before,
  });
  const exp = t.tags.find((tag) => tag[0] === "expiration");
  assert.ok(exp, "dnd must carry an expiration");
  assert.equal(Number.parseInt(exp[1], 10), before + 1800);
});

test("nip38: buildStatusEventTemplate skips expiration when ttlSeconds=0", () => {
  const t = buildStatusEventTemplate({ state: "idle", text: "x", ttlSeconds: 0 });
  assert.equal(t.tags.find((tag) => tag[0] === "expiration"), undefined);
});

// ─────────────────────────────────────────────────────────────────
// Clear path
// ─────────────────────────────────────────────────────────────────
test("nip38: clear shape = empty content + d:general + no expiration", () => {
  const t = buildStatusEventTemplate({ state: "general", text: "" });
  assert.equal(t.content, "");
  assert.deepEqual(t.tags.find((tag) => tag[0] === "d"), ["d", "general"]);
  assert.equal(t.tags.find((tag) => tag[0] === "expiration"), undefined);
  assert.equal(t.kind, KIND_USER_STATUS);
});

// ─────────────────────────────────────────────────────────────────
// Env opt-out
// ─────────────────────────────────────────────────────────────────
test("nip38: isStatusDisabled honors COREPRT_AGENT_NO_STATUS=1", () => {
  process.env.COREPRT_AGENT_NO_STATUS = "1";
  assert.equal(isStatusDisabled(), true);
  process.env.COREPRT_AGENT_NO_STATUS = "true";
  assert.equal(isStatusDisabled(), true);
  process.env.COREPRT_AGENT_NO_STATUS = "yes";
  assert.equal(isStatusDisabled(), true);
  process.env.COREPRT_AGENT_NO_STATUS = "0";
  assert.equal(isStatusDisabled(), false);
  delete process.env.COREPRT_AGENT_NO_STATUS;
  assert.equal(isStatusDisabled(), false);
});

// ─────────────────────────────────────────────────────────────────
// Mocked relay round-trip — verifies signing + publishStatus plumbing
// ─────────────────────────────────────────────────────────────────
test("nip38: publishStatus signs + posts + respects opt-out", async (t) => {
  // Inject a mock relay runner via the `runRelay` opt on publishStatus.
  const captured = { published: null, calls: 0 };
  const runRelay = async (opts, run) => {
    captured.calls += 1;
    const session = {
      publish: async (event) => {
        captured.published = event;
        return { ok: true, reason: "" };
      },
    };
    return run(session);
  };

  const { publishStatus } = await import("../../user-status.mjs");
  const kp = generateKeypair();
  const nsecHex = kp.skHex;

  // Case 1: opt-out via env. publishStatus itself short-circuits BEFORE the
  // runner is invoked, so captured.calls stays at 0.
  process.env.COREPRT_AGENT_NO_STATUS = "1";
  const skipped = await publishStatus({
    nsec: nsecHex,
    relayUrl: "ws://mock",
    state: "working",
    text: "should be skipped",
    runRelay,
  });
  assert.equal(skipped.skipped, true);
  assert.equal(captured.published, null, "publish must be skipped when COREPRT_AGENT_NO_STATUS=1");
  assert.equal(captured.calls, 0, "runner must not be called on opt-out");

  // Case 2: opt-in. The mock relay should receive a valid kind:30315.
  delete process.env.COREPRT_AGENT_NO_STATUS;
  const result = await publishStatus({
    nsec: nsecHex,
    relayUrl: "ws://mock",
    state: "working",
    text: "shipping NIP-38",
    emoji: "🚀",
    runRelay,
  });
  assert.equal(result.result.ok, true);
  assert.ok(result.event);
  assert.equal(result.event.kind, KIND_USER_STATUS);
  assert.ok(verifyEvent(result.event), "published event must verify");
  assert.equal(captured.published.id, result.event.id);
  const d = captured.published.tags.find((tag) => tag[0] === "d");
  assert.equal(d[1], "working");
  const emoji = captured.published.tags.find((tag) => tag[0] === "emoji");
  assert.equal(emoji[1], "🚀");
});

test("nip38: publishStatus TTL-bearing state carries expiration", async () => {
  const captured = { published: null };
  const runRelay = async (opts, run) => {
    const session = {
      publish: async (event) => {
        captured.published = event;
        return { ok: true, reason: "" };
      },
    };
    return run(session);
  };
  const { publishStatus } = await import("../../user-status.mjs");
  const kp = generateKeypair();
  delete process.env.COREPRT_AGENT_NO_STATUS;
  const r = await publishStatus({
    nsec: kp.skHex,
    relayUrl: "ws://mock",
    state: "dnd",
    text: "in meeting",
    ttlSeconds: 1800,
    runRelay,
  });
  assert.equal(r.result.ok, true);
  const exp = captured.published.tags.find((tag) => tag[0] === "expiration");
  assert.ok(exp, "dnd must carry expiration");
  // expiration is created_at + ttl; tolerate 1s clock drift.
  const expNum = Number.parseInt(exp[1], 10);
  assert.ok(Math.abs(expNum - (captured.published.created_at + 1800)) <= 1);
});

test("nip38: publishStatus surfaces relay rejection", async () => {
  const runRelay = async (opts, run) => {
    const session = {
      publish: async () => ({ ok: false, reason: "blocked: policy" }),
    };
    return run(session);
  };
  const { publishStatus } = await import("../../user-status.mjs");
  const kp = generateKeypair();
  delete process.env.COREPRT_AGENT_NO_STATUS;
  const r = await publishStatus({
    nsec: kp.skHex,
    relayUrl: "ws://mock",
    state: "working",
    text: "should be rejected",
    runRelay,
  });
  assert.equal(r.result.ok, false);
  assert.match(r.result.reason, /blocked/);
});

// ─────────────────────────────────────────────────────────────────
// CLI arg parsing surface (we exercise the parser indirectly via the
// buildStatusEventTemplate contract — the CLI itself is a thin wrapper).
// ─────────────────────────────────────────────────────────────────
test("nip38: CLI surface — set with --ttl 30m on dnd → expiration in 30m", () => {
  const ttl = parseTtl("30m");
  const t = buildStatusEventTemplate({ state: "dnd", text: "meeting", ttlSeconds: ttl });
  const exp = t.tags.find((tag) => tag[0] === "expiration");
  assert.ok(exp);
  assert.ok(Number.parseInt(exp[1], 10) - t.created_at >= 1800 - 2);
  assert.ok(Number.parseInt(exp[1], 10) - t.created_at <= 1800 + 2);
});

test("nip38: CLI surface — set with no --ttl on general → no expiration", () => {
  const t = buildStatusEventTemplate({ state: "general", text: "active" });
  assert.equal(t.tags.find((tag) => tag[0] === "expiration"), undefined);
});

test("nip38: CLI surface — clear → empty content + d:general", () => {
  const t = buildStatusEventTemplate({ state: "general", text: "" });
  assert.equal(t.content, "");
  assert.deepEqual(t.tags.find((tag) => tag[0] === "d"), ["d", "general"]);
});
