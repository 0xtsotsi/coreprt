// agents/_lib/user-status.mjs
//
// NIP-38 user-status library. Shared between the runtime (agents/_lib/runtime.mjs)
// and the operator CLI (agents/_lib/one-shot/user-status.mjs).
//
// Reference: https://github.com/nostr-protocol/nips/blob/master/38.md
//
// State machine:
//   general         — default, no expiration, replaces the prior general status
//   music           — also no expiration (clients may add their own on the
//                     music coordinate; we don't add one by default)
//   working         — operator-set "in flight" state; persistent until cleared
//   idle            — runtime-emitted when the agent is waiting between turns
//   deep-build      — runtime-emitted during long-running /compare + gauntlet
//   dnd             — operator-set "do not disturb"; TTL required
//
// TTL policy:
//   • general / music / working: NO expiration tag. Persistent until the next
//     replacement event lands on the same (pubkey, d) coordinate. kind 30315 is
//     parameterized-replaceable (NIP-33), so a fresh event supersedes the old.
//   • dnd / idle / deep-build: TTL required (default 1h, --ttl override). An
//     expiration tag (NIP-40 unix-seconds) is added so dead/idle agents stop
//     showing as "active" after the TTL elapses.
//   • clear: empty content + d:general, no expiration. NIP-38 §Live Statuses:
//     "If the content is an empty string then the client should clear the status."
//
// Tag vocabulary (matches the Rust SDK at
// CorePrt-relay/crates/buzz-sdk/src/builders.rs:1583+):
//   d         — required; status type
//   r         — optional; URL reference (NIP-38 §Live Statuses: "r, p, e or a")
//   emoji     — optional; short emoji displayed by clients (NIP-38 §Live Statuses)
//   expiration — NIP-40 unix-seconds; ONLY on TTL-bearing states

import { finalizeEvent, getKeypairFromHex } from "./nostr.mjs";
import { runWithRelay } from "./writer.mjs";

export const KIND_USER_STATUS = 30315;

// States that get an NIP-40 expiration tag. Anything else is persistent.
export const TTL_STATES = new Set(["dnd", "idle", "deep-build"]);

// Default TTL when an operator passes `--ttl` with no value or no unit: 1 hour.
// (Spec: 60 * 60 seconds.)
export const DEFAULT_TTL_SECONDS = 60 * 60;

// Parses a duration string into seconds. Accepts compound suffixes:
//   "1h" "30m" "2h30m" "3600s" "90" (bare seconds, for shell friendliness)
//   "1d" (24h) and "1w" (7d) are accepted too — dnd/weeklong status is a real
//   use-case. Returns NaN for malformed input.
export function parseTtl(input) {
  if (typeof input !== "string" || input.length === 0) return Number.NaN;
  // Bare seconds, e.g. "3600".
  if (/^\d+$/.test(input)) return Number.parseInt(input, 10);
  let total = 0;
  let matched = false;
  const re = /(\d+)\s*(w|d|h|m|s)/gi;
  let match;
  while ((match = re.exec(input)) !== null) {
    matched = true;
    const n = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === "w") total += n * 7 * 24 * 3600;
    else if (unit === "d") total += n * 24 * 3600;
    else if (unit === "h") total += n * 3600;
    else if (unit === "m") total += n * 60;
    else if (unit === "s") total += n;
  }
  if (!matched) return Number.NaN;
  return total;
}

// Build a kind:30315 event template. Pure function — no signing, no relay
// I/O. Returns the raw template (kind/content/tags/created_at). Sign with
// `finalizeEvent(template, skBytes)` before publishing.
export function buildStatusEventTemplate({
  state = "general",
  text = "",
  emoji,
  reference,
  ttlSeconds,
  createdAt,
} = {}) {
  const tags = [];
  // `d` is required by NIP-38. Without it, clients don't know which status
  // coordinate this is on (general vs music vs custom).
  tags.push(["d", state]);
  if (typeof reference === "string" && reference.length > 0) {
    tags.push(["r", reference]);
  }
  if (typeof emoji === "string" && emoji.trim().length > 0) {
    tags.push(["emoji", emoji.trim()]);
  }
  if (typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    const expiresAt = (createdAt ?? Math.floor(Date.now() / 1000)) + Math.floor(ttlSeconds);
    tags.push(["expiration", String(expiresAt)]);
  }
  return {
    kind: KIND_USER_STATUS,
    content: text ?? "",
    tags,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
  };
}

// Convenience wrapper that signs + publishes in one call. Used by both the
// runtime (which has its own RelayClient) and the CLI one-shot.
//
// opts:
//   nsec        — agent secret (required)
//   relayUrl    — wss:// or ws:// URL
//   host        — Host header (defaults to process.env.BUZZ_RELAY_HOST)
//   log         — log function
//   state       — status type (default: "general")
//   text        — content
//   emoji       — optional
//   reference   — optional URL
//   ttlSeconds  — optional; required for dnd/idle/deep-build
//   runRelay    — optional override for the writer's `runWithRelay`. When set,
//                 the call signature is `runRelay(opts, run)`. The default
//                 delegates to `./writer.mjs`'s `runWithRelay`. Tests inject a
//                 mock runner; production code leaves it unset.
export async function publishStatus(opts) {
  const {
    nsec,
    relayUrl,
    host,
    log = () => {},
    state = "general",
    text = "",
    emoji,
    reference,
    ttlSeconds,
    runRelay,
  } = opts;
  if (isStatusDisabled()) {
    return { skipped: true, reason: "COREPRT_AGENT_NO_STATUS=1" };
  }
  const keypair = getKeypairFromHex(nsec);
  const template = buildStatusEventTemplate({ state, text, emoji, reference, ttlSeconds });
  const event = finalizeEvent(template, keypair.skBytes);
  const runner = typeof runRelay === "function" ? runRelay : runWithRelay;
  const result = await runner(
    { nsec, relayUrl, host: host ?? process.env.BUZZ_RELAY_HOST, log },
    (session) => session.publish(event)
  );
  return { event, result };
}

// Returns true when the env opt-out is set. The runtime uses this to short-
// circuit auto-emit on lifecycle transitions.
export function isStatusDisabled() {
  const v = process.env.COREPRT_AGENT_NO_STATUS;
  return v === "1" || v === "true" || v === "yes";
}

// Validate a state string. Returns the canonical state name or throws.
export function normalizeState(state) {
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("state must be a non-empty string");
  }
  // Allow any d-tag value (NIP-38 says "Any other status types can be used
  // but they are not defined by this NIP"), but trim + lowercase for sanity.
  const s = state.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(s)) {
    throw new Error(`invalid state: ${state} (use lowercase letters/digits/_/-)`);
  }
  return s;
}

// Decide whether a (state, ttlSeconds) pair is well-formed. Returns
// { ok: true, ttlSeconds } or { ok: false, error }. Used by both the CLI and
// the runtime guard.
export function validateStateAndTtl(state, ttlSeconds) {
  if (TTL_STATES.has(state)) {
    if (ttlSeconds === undefined || ttlSeconds === null) {
      return { ok: true, ttlSeconds: DEFAULT_TTL_SECONDS };
    }
    if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return { ok: false, error: `--ttl is required (and > 0) for state ${state}` };
    }
    return { ok: true, ttlSeconds };
  }
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    // Operator explicitly set --ttl on a persistent state. Allow it but warn
    // via the return so the caller can log; do not error.
    return { ok: true, ttlSeconds, warning: `state ${state} is persistent; --ttl is ignored` };
  }
  return { ok: true, ttlSeconds: null };
}
