// dispatch.test.js — coverage for the event → agent routing layer.
//
// The runtime hands every inbound channel message to dispatch.mjs; if this
// test suite passes the runtime is guaranteed to pick the right agent for
// every supported shape of inbound event. The 7-rule priority chain is
// tested in order so regressions are unambiguous.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentForEvent, _resetRegistryCache } from "../dispatch.mjs";

function reset() { _resetRegistryCache(); }

const baseEvent = (overrides = {}) => ({
  id: "abcdef0123456789",
  pubkey: "5" + "0".repeat(63),
  kind: 9,
  content: "",
  tags: [],
  ...overrides,
});

test("dispatch: scope tag routes to the right agent", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ tags: [["scope", "web"]] }));
  assert.equal(r.agent, "bumble");
  assert.equal(r.route, "scope");
});

test("dispatch: marketing scope falls through to unrouted (no agent claims marketing yet)", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ tags: [["scope", "marketing"]] }));
  // No agent in agents.json claims `marketing` yet; we log the gap loudly
  // and fall back. Once the operator adds a marketing agent to the registry
  // (one-line edit), this test must be updated to expect "marketing".
  assert.equal(r.agent, "fizz");
  assert.equal(r.route, "scope-unclaimed");
  assert.match(r.reason, /marketing/);
});

test("dispatch: scope alias resolves to the underlying scope", () => {
  reset();
  // agents.json maps "landing-page-v2" → "web"
  const r = resolveAgentForEvent(baseEvent({ tags: [["scope", "landing-page-v2"]] }));
  assert.equal(r.agent, "bumble");
  assert.equal(r.route, "scope");
  assert.equal(r.scope, "web");
});

test("dispatch: @<trigger> mention routes to that agent", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ content: "hey @goji look at this" }));
  assert.equal(r.agent, "goji");
  assert.equal(r.route, "trigger");
});

test("dispatch: bar tag delegates to the site builder (bumble)", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({
    tags: [["bar", "thecardyard-home"]],
    content: "fresh draft attached",
  }));
  assert.equal(r.agent, "bumble");
  assert.equal(r.route, "bar");
});

test("dispatch: assign tag is an explicit operator override", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({
    tags: [["assign", "goji"]],
    content: "no mention of any agent",
  }));
  assert.equal(r.agent, "goji");
  assert.equal(r.route, "assign");
});

test("dispatch: unknown assign falls through to unrouted (logged WARN)", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ tags: [["assign", "marketing-bot"]] }));
  assert.equal(r.agent, "fizz");
  assert.equal(r.route, "assign-unknown");
  assert.match(r.reason, /marketing-bot/);
});

test("dispatch: default (no rule matched) returns the unrouted default", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ content: "just a thought" }));
  assert.equal(r.agent, "fizz");
  assert.equal(r.route, "default");
});

test("dispatch: scope wins over trigger (priority 2 > 4)", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({
    tags: [["scope", "docs"]],
    content: "@bumble build me a page", // would normally route to bumble
  }));
  assert.equal(r.agent, "goji"); // docs goes to goji, not bumble
  assert.equal(r.route, "scope");
});

test("dispatch: assign wins over scope (priority 1 > 2)", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({
    tags: [["scope", "web"], ["assign", "goji"]],
  }));
  assert.equal(r.agent, "goji");
  assert.equal(r.route, "assign");
});

test("dispatch: overrideAgent short-circuits everything", () => {
  reset();
  const r = resolveAgentForEvent(
    baseEvent({ tags: [["scope", "web"]], content: "@goji" }),
    { overrideAgent: "fizz" },
  );
  assert.equal(r.agent, "fizz");
  assert.equal(r.route, "override");
});

test("dispatch: overrideAgent with unknown name returns null + warn", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({}), { overrideAgent: "marketing-bot" });
  assert.equal(r.agent, null);
  assert.equal(r.route, "override-miss");
});

test("dispatch: null/undefined event is safe", () => {
  reset();
  assert.equal(resolveAgentForEvent(null).agent, null);
  assert.equal(resolveAgentForEvent(undefined).agent, null);
});

test("dispatch: case-insensitive scope match", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ tags: [["scope", "WEB"]] }));
  assert.equal(r.agent, "bumble");
});

test("dispatch: case-insensitive @trigger match", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ content: "ping @FIZZ" }));
  assert.equal(r.agent, "fizz");
});

test("dispatch: scope that doesn't match any agent returns unrouted but keeps scope", () => {
  reset();
  const r = resolveAgentForEvent(baseEvent({ tags: [["scope", "legal"]] }));
  assert.equal(r.agent, "fizz");
  assert.equal(r.scope, "legal"); // operator-visible
  assert.equal(r.route, "scope-unclaimed");
});
