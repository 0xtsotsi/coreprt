// __tests__/red-team.test.mjs — unit tests for the multi-agent red-team
// reviewer fan-out and coordinator aggregation.
//
// Uses an in-memory RelayClient double so no real WebSocket is opened. Each
// reviewer is given a synthetic keypair + relay; verdicts are produced by an
// injected `ask` function so the test never spawns a runtime process.
//
// The FakeRelay exposes `onEvent` (a single-callback property) matching the
// shape `registerRelayEventHandler` looks for. Pre-seeding `_byId` makes the
// per-id REQ emit the builder event synchronously so `readBuilderEvent`
// resolves without waiting on a real subscription.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair, finalizeEvent, verifyEvent } from "../nostr.mjs";
import { runRedTeam, _internals } from "../red-team.mjs";

class FakeRelay {
  constructor() {
    this.published = [];
    this.onEvent = null;
    this._byId = new Map();
  }
  async publish(event) {
    this.published.push(event);
    this._byId.set(event.id, event);
    if (this.onEvent) this.onEvent(event);
    return { ok: true };
  }
  async subscribe({ ids } = {}) {
    const id = `sub-${Math.random().toString(36).slice(2, 8)}`;
    if (Array.isArray(ids)) {
      for (const eventId of ids) {
        const ev = this._byId.get(eventId);
        if (ev) this.onEvent?.(ev);
      }
    }
    return id;
  }
  async connect() { /* no-op for in-memory double */ }
  unsubscribe() { /* no-op */ }
  close() { /* no-op */ }
}

function makeKeypair() {
  return generateKeypair();
}

function makeBuilderKeypair() {
  return generateKeypair();
}

function makeReviewer({ name, verdict, relay, keypair, delayMs = 0, throwOn = null }) {
  return {
    name,
    relay,
    keypair,
    ask: async () => {
      if (throwOn) {
        await new Promise((r) => setTimeout(r, delayMs));
        throw throwOn;
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return verdict;
    },
  };
}

function makeBuilderEvent(builderKeypair) {
  return finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "builder reply under review",
    },
    builderKeypair.skBytes,
  );
}

function seedRelaysWithBuilderEvent(relays, builderEvent) {
  for (const r of relays) r._byId.set(builderEvent.id, builderEvent);
}

test("red-team: all three reviewers return WIN → coordinator publishes WIN, no dissent", async () => {
  const builder = makeBuilderKeypair();
  const builderEvent = makeBuilderEvent(builder);
  const builderPubkey = builderEvent.pubkey;

  const relays = [new FakeRelay(), new FakeRelay(), new FakeRelay()];
  seedRelaysWithBuilderEvent(relays, builderEvent);
  const reviewers = relays.map((relay, i) => makeReviewer({
    name: ["bumble", "fizz", "goji"][i],
    verdict: "WIN\nclean win, no notes",
    relay,
    keypair: makeKeypair(),
  }));

  const result = await runRedTeam({
    builderEventId: builderEvent.id,
    builderPubkey,
    agents: reviewers,
    reviewTimeoutMs: 5_000,
  });

  assert.equal(result.verdict.kind, "win");
  assert.deepEqual(result.counts, { win: 3, lose: 0, equal: 0, no_verdict: 0 });
  assert.equal(result.strongestDissent, null);
  assert.ok(result.metaEvent, "coordinator should publish a meta comment");
  assert.equal(result.metaEvent.kind, 1111);
  // Coordinator is the first reviewer → its relay saw its own WIN + the meta
  // comment, so two events on the first relay.
  assert.equal(relays[0].published.length, 2);
  assert.ok(verifyEvent(result.metaEvent));
});

test("red-team: 1 WIN, 2 LOSE → coordinator publishes LOSE (majority) AND surfaces dissent", async () => {
  const builder = makeBuilderKeypair();
  const builderEvent = makeBuilderEvent(builder);
  const builderPubkey = builderEvent.pubkey;

  const relays = [new FakeRelay(), new FakeRelay(), new FakeRelay()];
  seedRelaysWithBuilderEvent(relays, builderEvent);
  const verdicts = [
    "WIN\nlooks fine to me",
    "LOSE\ntype pairing is way too quiet for hero CTA",
    "LOSE\ncontrast on the CTA fails WCAG AA",
  ];
  const reviewers = relays.map((relay, i) => makeReviewer({
    name: ["bumble", "fizz", "goji"][i],
    verdict: verdicts[i],
    relay,
    keypair: makeKeypair(),
  }));

  const result = await runRedTeam({
    builderEventId: builderEvent.id,
    builderPubkey,
    agents: reviewers,
    reviewTimeoutMs: 5_000,
  });

  assert.equal(result.verdict.kind, "lose", "majority is LOSE; not WIN");
  assert.deepEqual(result.counts, { win: 1, lose: 2, equal: 0, no_verdict: 0 });
  assert.ok(result.strongestDissent, "dissent must be surfaced");
  assert.equal(result.strongestDissent.name, "bumble");
  assert.equal(result.strongestDissent.verdict.kind, "win");

  const content = result.metaEvent.content;
  assert.match(content, /LOSE/);
  assert.match(content, /WIN 1 \/ LOSE 2 \/ EQUAL 0/);
  assert.match(content, /DISSENT: bumble: WIN — looks fine to me/);
});

test("red-team: one reviewer times out → other two still publish, NO_VERDICT counted, doesn't block", async () => {
  const builder = makeBuilderKeypair();
  const builderEvent = makeBuilderEvent(builder);
  const builderPubkey = builderEvent.pubkey;

  const relays = [new FakeRelay(), new FakeRelay(), new FakeRelay()];
  seedRelaysWithBuilderEvent(relays, builderEvent);
  const slow = makeReviewer({
    name: "slow",
    verdict: "WIN",
    relay: relays[0],
    keypair: makeKeypair(),
    delayMs: 200, // exceeds the 50ms timeout below
  });
  const fast1 = makeReviewer({ name: "fast1", verdict: "EQUAL\nok", relay: relays[1], keypair: makeKeypair() });
  const fast2 = makeReviewer({ name: "fast2", verdict: "EQUAL\nok", relay: relays[2], keypair: makeKeypair() });

  const result = await runRedTeam({
    builderEventId: builderEvent.id,
    builderPubkey,
    agents: [slow, fast1, fast2],
    reviewTimeoutMs: 50,
  });

  assert.deepEqual(result.counts, { win: 0, lose: 0, equal: 2, no_verdict: 1 });
  assert.equal(result.verdict.kind, "equal", "majority of decided verdicts is EQUAL");
  // slow did not publish a comment (timed out before publish).
  assert.equal(relays[0].published.length, 0);
  // fast1 + fast2 each published one comment. Coordinator (slow) failed, so
  // the fallback publisher is fast1 (first successful reviewer).
  assert.equal(relays[1].published.length, 2, "fast1 published its own + the meta");
  assert.equal(result.publisher, "fast1");
});

test("red-team: tag shape — root E/P uppercase on each reviewer; meta adds lowercase e parent", async () => {
  const builder = makeBuilderKeypair();
  const builderEvent = makeBuilderEvent(builder);
  const builderPubkey = builderEvent.pubkey;

  const relays = [new FakeRelay(), new FakeRelay()];
  seedRelaysWithBuilderEvent(relays, builderEvent);
  const reviewers = relays.map((relay, i) => makeReviewer({
    name: ["bumble", "fizz"][i],
    verdict: "WIN",
    relay,
    keypair: makeKeypair(),
  }));

  const result = await runRedTeam({
    builderEventId: builderEvent.id,
    builderPubkey,
    agents: reviewers,
    reviewTimeoutMs: 5_000,
  });

  // Every reviewer's own comment (kind 1111) must have uppercase E + P only.
  for (const reviewComment of result.results.slice(0, 2).map((r) => r.event).filter(Boolean)) {
    assert.equal(reviewComment.kind, 1111);
    assert.ok(
      reviewComment.tags.some(([k, v]) => k === "E" && v === builderEvent.id),
      "reviewer comment must have uppercase E root tag",
    );
    assert.ok(
      reviewComment.tags.some(([k, v]) => k === "P" && v === builderPubkey),
      "reviewer comment must have uppercase P root author tag",
    );
    assert.ok(
      !reviewComment.tags.some(([k]) => k === "e"),
      "reviewer comment must NOT have a lowercase e parent tag (root only)",
    );
  }

  // Meta comment must have lowercase e parent (pointing at the coordinator's
  // own comment) AND uppercase E + P root tags.
  const meta = result.metaEvent;
  assert.equal(meta.kind, 1111);
  const tags = Object.fromEntries(meta.tags);
  assert.match(
    meta.tags.find(([k]) => k === "e")?.[1] ?? "",
    /^[0-9a-f]{64}$/,
    "lowercase e parent must reference the coordinator's own comment id",
  );
  assert.equal(tags.E, builderEvent.id, "meta must keep uppercase E root tag");
  assert.equal(tags.P, builderPubkey, "meta must keep uppercase P root author tag");
});

test("red-team: internal tally + majority rules", () => {
  const { countVerdicts, majorityVerdict } = _internals;
  assert.deepEqual(
    countVerdicts([
      { verdict: { kind: "win" } },
      { verdict: { kind: "lose" } },
      { verdict: { kind: "equal" } },
      { verdict: { kind: "no_verdict" } },
    ]),
    { win: 1, lose: 1, equal: 1, no_verdict: 1 },
  );
  assert.equal(majorityVerdict({ win: 0, lose: 0, equal: 0, no_verdict: 0 }), "no_verdict");
  assert.equal(majorityVerdict({ win: 2, lose: 1, equal: 0, no_verdict: 0 }), "win");
  assert.equal(majorityVerdict({ win: 1, lose: 2, equal: 0, no_verdict: 0 }), "lose");
  // Tie → first listed kind wins (current implementation picks the first
  // tied kind by REVIEW_KINDS order: win, lose, equal).
  assert.equal(majorityVerdict({ win: 1, lose: 1, equal: 0, no_verdict: 0 }), "win");
});
