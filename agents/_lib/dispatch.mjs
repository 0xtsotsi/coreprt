// dispatch.mjs — event → agent routing layer for the CorePrt fleet.
//
// The runtime (agents/_lib/runtime.mjs:62) calls `resolveAgentForEvent(event,
// opts)` on every inbound channel message. This module is the single
// routing surface and the answer to "where does this event go?"
//
// Routing priority (first match wins):
//
//   1. `["assign", "<agent>"]` tag         — operator override; bypasses everything
//                                           (a known design force: an operator
//                                           pressing "send to goji" must never
//                                           be redirected by an unrelated scope).
//   2. `["scope", "<slug>"]` tag           — the CRM bridge and crm-bridge.mjs
//                                           buildJobRequestTemplate emit these;
//                                           look up the scope in the agent
//                                           registry's `scopes` array.
//   3. `["scope", "<alias>"]` resolution   — scopeAliases map (e.g. "marketing"
//                                           → "marketing" when the registry
//                                           learns marketing as a scope).
//   4. `@<trigger>` mention in content     — standard explicit trigger.
//   5. `["bar", "<name>"]` tag             — gauntlet bar delegation. The
//                                           runtime's existing gauntlet hook
//                                           (autopilot-loop.mjs:128) handles
//                                           the gauntlet itself; we just pick
//                                           the agent to do the build.
//   6. Author's pubkey in registry         — direct messages from a known
//                                           agent are routed back to them
//                                           (used for red-team handoffs).
//   7. Default `unrouted` agent            — fizz by default.
//
// Each route is recorded with a `reason` string so logs and audit trails
// explain why an event went where it went. `routeAndLog()` is the
// runtime-facing entry point; pure `resolveAgentForEvent()` is exported
// for unit tests.
//
// Adding a new agent / department is a 1-line change to agents.json — see
// the registry's _doc string for the full onboarding sequence.
//
// Pluggability note: this module never imports runtime.mjs. The runtime
// imports dispatch.mjs. This is the single direction of dependency.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "agents.json");

// ── Registry loader (cached) ────────────────────────────────────────────

let _registry = null;
function loadRegistry() {
  if (_registry) return _registry;
  if (!existsSync(REGISTRY_PATH)) {
    // No registry on disk → fall back to a minimal one. This keeps the
    // runtime functional in the operator's pre-existing hardcoded-3-agent
    // state while the migration to data-driven agents lands.
    _registry = {
      version: 0,
      agents: [
        { name: "fizz", role: "router", scopes: ["*"], trigger: "@fizz", description: "fallback" },
        { name: "bumble", role: "builder", scopes: ["web", "frontend", "landing-page", "thecardyard"], trigger: "@bumble", description: "fallback" },
        { name: "goji", role: "generalist", scopes: ["docs", "research", "general"], trigger: "@goji", description: "fallback" },
      ],
      scopeAliases: {},
      unrouted: "fizz",
    };
    return _registry;
  }
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  // Normalize scope lists to lowercase for case-insensitive match.
  for (const a of raw.agents ?? []) {
    a.scopes = (a.scopes ?? []).map((s) => String(s).toLowerCase());
    if (a.trigger) a.trigger = a.trigger.toLowerCase();
  }
  const aliases = {};
  for (const [k, v] of Object.entries(raw.scopeAliases ?? {})) {
    aliases[String(k).toLowerCase()] = String(v).toLowerCase();
  }
  raw.scopeAliases = aliases;
  _registry = raw;
  return _registry;
}

// Test seam: clear the cache so a test can swap in a fake registry.
export function _resetRegistryCache() { _registry = null; }

// ── Tag extraction helpers ──────────────────────────────────────────────

/** Return the value of the first tag whose name matches `name`, or null. */
function firstTag(tags, name) {
  for (const t of tags ?? []) {
    if (Array.isArray(t) && t[0] === name) {
      return typeof t[1] === "string" ? t[1].toLowerCase() : null;
    }
  }
  return null;
}

/** Return all values of tags whose name matches `name`. */
function allTags(tags, name) {
  const out = [];
  for (const t of tags ?? []) {
    if (Array.isArray(t) && t[0] === name) {
      if (typeof t[1] === "string") out.push(t[1].toLowerCase());
    }
  }
  return out;
}

// ── Match helpers ───────────────────────────────────────────────────────

function findByScope(scope) {
  if (!scope) return null;
  const registry = loadRegistry();
  for (const a of registry.agents) {
    if (a.scopes.includes("*")) continue; // wildcard is a fallback, not a match
    if (a.scopes.includes(scope)) return a;
  }
  return null;
}

function findByName(name) {
  if (!name) return null;
  const registry = loadRegistry();
  return registry.agents.find((a) => a.name === name) ?? null;
}

function findByTrigger(trigger) {
  if (!trigger) return null;
  const registry = loadRegistry();
  return registry.agents.find((a) => a.trigger === trigger) ?? null;
}

function findByPubkey(pubkey) {
  if (!pubkey) return null;
  // Registry may carry an `npub`/`pubkey` per agent for direct-message routing.
  // We accept the `pubkey` field here so the operator can wire it up later;
  // missing pubkey is a no-op.
  const registry = loadRegistry();
  for (const a of registry.agents) {
    if (a.pubkey && a.pubkey === pubkey) return a;
  }
  return null;
}

function resolveScopeAlias(scope) {
  if (!scope) return scope;
  const registry = loadRegistry();
  return registry.scopeAliases[scope.toLowerCase()] ?? scope;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resolve which agent should respond to an inbound event.
 *
 * @param {object} event                Nostr event (any kind; only kind:9 is
 *                                       typical at this layer but the router
 *                                       itself is kind-agnostic).
 * @param {object} [opts]               Optional context
 * @param {string} [opts.overrideAgent] Operator override (e.g. from a CLI
 *                                       flag like `coreprt-agent logs fizz`);
 *                                       short-circuits all rules.
 * @returns {{ agent: string|null, route: string, reason: string, scope?: string }}
 *                                       `agent` is null if unrouted AND no
 *                                       default is configured.
 */
export function resolveAgentForEvent(event, opts = {}) {
  if (!event || typeof event !== "object") {
    return { agent: null, route: "invalid", reason: "event is not an object" };
  }

  // Rule 0: explicit override (operator CLI, internal hook, etc.)
  if (opts.overrideAgent) {
    const a = findByName(opts.overrideAgent);
    if (a) return { agent: a.name, route: "override", reason: `overrideAgent=${opts.overrideAgent}` };
    return { agent: null, route: "override-miss", reason: `overrideAgent=${opts.overrideAgent} not in registry` };
  }

  const tags = event.tags ?? [];
  const content = String(event.content ?? "").toLowerCase();
  const pubkey = typeof event.pubkey === "string" ? event.pubkey : null;

  // Rule 1: explicit operator assignment (overrides everything below)
  const assigned = firstTag(tags, "assign");
  if (assigned) {
    const a = findByName(assigned);
    if (a) return { agent: a.name, route: "assign", reason: `assign=${assigned}` };
    return {
      agent: loadRegistry().unrouted ?? null,
      route: "assign-unknown",
      reason: `assign=${assigned} not in registry; falling through to unrouted`,
    };
  }

  // Rule 2+3: scope tag (with alias resolution)
  const rawScope = firstTag(tags, "scope");
  if (rawScope) {
    const aliased = resolveScopeAlias(rawScope);
    const a = findByScope(aliased);
    if (a) return { agent: a.name, route: "scope", reason: `scope=${rawScope}${rawScope !== aliased ? `→${aliased}` : ""}`, scope: aliased };
    // Scope requested but no agent claims it — fall through and let the
    // default catch it. Logged as a warning by the caller.
    return {
      agent: loadRegistry().unrouted ?? null,
      route: "scope-unclaimed",
      reason: `scope=${rawScope} not in any agent.scopes; falling through to unrouted`,
      scope: rawScope,
    };
  }

  // Rule 4: @<trigger> mention in content
  for (const a of loadRegistry().agents) {
    if (a.trigger && content.includes(a.trigger)) {
      return { agent: a.name, route: "trigger", reason: `content includes ${a.trigger}` };
    }
  }

  // Rule 5: bar tag (gauntlet delegation)
  const bar = firstTag(tags, "bar");
  if (bar) {
    // Bar delegation is its own decision (autopilot-loop.mjs handles the
    // gauntlet loop); for routing the builder, we send it to the agent
    // that already owns the scope of the same event, falling back to
    // bumble (the bar is most often a site-quality bar).
    return { agent: "bumble", route: "bar", reason: `bar=${bar} delegates to bumble (site builder)` };
  }

  // Rule 6: direct pubkey match (red-team handoff style)
  if (pubkey) {
    const a = findByPubkey(pubkey);
    if (a) return { agent: a.name, route: "pubkey", reason: `event signed by known agent ${a.name}` };
  }

  // Rule 7: default
  return {
    agent: loadRegistry().unrouted ?? null,
    route: "default",
    reason: "no rule matched; using unrouted default",
  };
}

/**
 * Resolve the agent for an event and return a structured log line. The
 * runtime calls this in `onEvent` and passes the result to its handleMessage
 * for either delivery (if `agent === self`) or forwarding (if not).
 */
export function routeAndLog(event, self, opts = {}) {
  const result = resolveAgentForEvent(event, opts);
  const echo = result.agent === self
    ? `${self} (self)`
    : result.agent
      ? `${result.agent}`
      : "unrouted";
  const warn = result.route === "scope-unclaimed" || result.route === "assign-unknown"
    ? " [WARN]"
    : "";
  return {
    ...result,
    logLine: `[dispatch] event ${event.id?.slice(0, 8) ?? "?"} kind=${event.kind ?? "?"} → ${echo} via ${result.route}: ${result.reason}${warn}`,
  };
}

// ── Internals for tests ─────────────────────────────────────────────────

export const _internals = {
  loadRegistry,
  firstTag,
  allTags,
  findByScope,
  findByName,
  findByTrigger,
  findByPubkey,
  resolveScopeAlias,
  REGISTRY_PATH,
};
