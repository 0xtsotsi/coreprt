// lemma-bridge.mjs — passive read-only bridge from CorePrt to a Lemma
// workspace (https://lemma.work).
//
// What it does
// ============
//
// Subscribes to the CorePrt relay via the local proxy (ws://127.0.0.1:3300,
// Host: coreprt.webrnds.com), applies a per-process filter (kinds +
// tag-set), and POSTs every matching event as a JSON envelope to a
// configured Lemma pod's webhook URL.
//
// What it does NOT do
// ===================
//
//   - It does not write to the relay. (Read-only sidecar.)
//   - It does not import runtime.mjs, dispatch.mjs, or any other CorePrt
//     hot-path module. The bridge is fully isolated; deleting the file
//     and its directory has zero impact on the rest of the system.
//   - It does not depend on the operator's WARP or CF Access state at
//     startup. The local relay proxy at 127.0.0.1:3300 already routes
//     through the tunnel; the bridge just talks to that.
//
// Why a separate sidecar instead of a runtime hook
// =================================================
//
// Adding a "if lemma" branch to runtime.mjs would make the runtime
// coupled to a third-party product. The operator said "I want to delete
// the Lemma feature when necessary". This module is the entire Lemma
// surface area: delete the file + its env file + its LaunchAgent, and
// CorePrt runs as before.
//
// Operational model
// ==================
//
//   - Configured via ~/.config/coreprt/agents/<name>.lemma.env (mode 0600).
//   - Subscribed filter is one of: a default (kinds 1, 7, 9, 1111, 43001),
//     or an explicit JSON filter loaded from LEMMA_FILTER_FILE.
//   - The "since" cursor is persisted to ~/.config/coreprt/agents/<name>/
//     lemma.cursor so a restart doesn't re-replay the entire channel.
//   - Dedupe: kind:7 reactions (per author, per target) are suppressed
//     for LEMMA_DEDUPE_REACTION_SECONDS (default 300) to keep the
//     bridge below the relay's ~200 events/min rate limit when Lemma
//     pods are chatty.
//   - The HTTP webhook is the only output. If LEMMA_WEBHOOK_URL is
//     unset, the bridge logs to stderr and exits non-zero so the
//     operator notices.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RelayClient } from "./relay-client.mjs";
import { getKeypairFromHex } from "./nostr.mjs";

const DEFAULT_KINDS = [1, 7, 9, 1111, 43001, 30023];
const DEFAULT_DEDUPE_REACTION_SECONDS = 300;
const STATE_DIR = join(process.env.HOME ?? "", ".config", "coreprt", "agents", "state");
const CURSOR_FILE = process.env.LEMMA_CURSOR_FILE
  ?? join(STATE_DIR, `${process.env.AGENT_NAME ?? "lemma"}.cursor`);
const DEDUPE_FILE = process.env.LEMMA_DEDUPE_FILE
  ?? join(STATE_DIR, `${process.env.AGENT_NAME ?? "lemma"}.dedupe.json`);

// ─── Config ───────────────────────────────────────────────────────────

function loadEnv(file) {
  if (!file || !existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const envFile = process.env.LEMMA_ENV_FILE
  ?? join(process.env.HOME ?? "", ".config", "coreprt", "agents", `${process.env.AGENT_NAME ?? "lemma"}.lemma.env`);
const env = loadEnv(envFile);

const RELAY_URL = process.env.AGENT_RELAY_URL
  ?? env.AGENT_RELAY_URL
  ?? "ws://127.0.0.1:3300";
const RELAY_HOST = process.env.BUZZ_RELAY_HOST
  ?? env.BUZZ_RELAY_HOST
  ?? "coreprt.webrnds.com";
const AGENT_NSEC = process.env.AGENT_NSEC ?? env.AGENT_NSEC;
const WEBHOOK_URL = process.env.LEMMA_WEBHOOK_URL ?? env.LEMMA_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.LEMMA_WEBHOOK_TOKEN ?? env.LEMMA_WEBHOOK_TOKEN;
const FILTER_FILE = process.env.LEMMA_FILTER_FILE ?? env.LEMMA_FILTER_FILE;
const KINDS = (process.env.LEMMA_KINDS ?? env.LEMMA_KINDS ?? DEFAULT_KINDS.join(","))
  .split(",")
  .map((k) => Number(k.trim()))
  .filter((n) => Number.isInteger(n));
const DEDUPE_REACTION_SECONDS = Number(
  process.env.LEMMA_DEDUPE_REACTION_SECONDS ?? env.LEMMA_DEDUPE_REACTION_SECONDS ?? DEFAULT_DEDUPE_REACTION_SECONDS,
);
const DEBUG = process.env.LEMMA_DEBUG === "1" || env.LEMMA_DEBUG === "1";

const log = (...args) => console.log(`[lemma-bridge ${new Date().toISOString().slice(11, 19)}]`, ...args);
const dbg = (...args) => { if (DEBUG) log("[debug]", ...args); };

// ─── State: cursor + reaction dedupe ─────────────────────────────────

function readCursor() {
  if (!existsSync(CURSOR_FILE)) return 0;
  const n = Number(readFileSync(CURSOR_FILE, "utf8").trim());
  return Number.isFinite(n) ? n : 0;
}

function writeCursor(t) {
  mkdirSync(dirname(CURSOR_FILE), { recursive: true });
  writeFileSync(CURSOR_FILE, String(t), "utf8");
}

function readDedupe() {
  if (!existsSync(DEDUPE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DEDUPE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeDedupe(map) {
  mkdirSync(dirname(DEDUPE_FILE), { recursive: true });
  writeFileSync(DEDUPE_FILE, JSON.stringify(map, null, 2));
}

/** True if we should suppress this kind:7 reaction. Records the time
 * regardless so the next identical reaction within the window is also
 * suppressed. */
function shouldSuppressReaction(event) {
  if (event.kind !== 7) return false;
  const target = event.tags.find((t) => t[0] === "e")?.[1] ?? "<none>";
  const key = `${event.pubkey.slice(0, 12)}:${target}`;
  const now = Math.floor(Date.now() / 1000);
  const map = readDedupe();
  // Prune old entries
  for (const [k, ts] of Object.entries(map)) {
    if (now - ts > DEDUPE_REACTION_SECONDS) delete map[k];
  }
  const last = map[key];
  if (last !== undefined && now - last < DEDUPE_REACTION_SECONDS) {
    writeDedupe(map);
    return true;
  }
  map[key] = now;
  writeDedupe(map);
  return false;
}

// ─── Webhook delivery ──────────────────────────────────────────────

async function deliver(event) {
  if (!WEBHOOK_URL) {
    log("LEMMA_WEBHOOK_URL not configured; dropping event");
    return { ok: false, reason: "no-webhook" };
  }
  const body = JSON.stringify({
    source: "coreprt",
    received_at: new Date().toISOString(),
    event,
  });
  const headers = { "content-type": "application/json" };
  if (WEBHOOK_TOKEN) headers.authorization = `Bearer ${WEBHOOK_TOKEN}`;
  try {
    const res = await fetch(WEBHOOK_URL, { method: "POST", headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ─── Filter loader ────────────────────────────────────────────────

function loadFilter() {
  if (FILTER_FILE && existsSync(FILTER_FILE)) {
    const f = JSON.parse(readFileSync(FILTER_FILE, "utf8"));
    dbg("loaded filter from file", f);
    return f;
  }
  return { kinds: KINDS };
}

// ─── Main loop ─────────────────────────────────────────────────────

async function main() {
  if (!AGENT_NSEC) {
    console.error("missing AGENT_NSEC (or set LEMMA_ENV_FILE with AGENT_NSEC)");
    process.exit(78);
  }
  if (!WEBHOOK_URL) {
    console.error("missing LEMMA_WEBHOOK_URL — bridge has nowhere to send events");
    process.exit(78);
  }
  const keypair = getKeypairFromHex(AGENT_NSEC);
  log(`relay=${RELAY_URL} host=${RELAY_HOST} webhook=${WEBHOOK_URL} kinds=${KINDS.join(",")} dedupe=${DEDUPE_REACTION_SECONDS}s`);

  const filter = loadFilter();
  let cursor = readCursor();
  log(`cursor starts at created_at=${cursor} (0 means "from now")`);

  const relay = new RelayClient({
    url: RELAY_URL,
    keypair,
    onEvent: (event) => {
      handleEvent(event).catch((err) => log(`handler error: ${err.message}`));
    },
    onNotice: (message) => log(`[NOTICE] ${message}`),
    log: dbg,
  });

  async function handleEvent(event) {
    if (typeof event.created_at === "number" && event.created_at <= cursor) {
      dbg(`skip stale event created_at=${event.created_at} <= cursor=${cursor}`);
      return;
    }
    if (shouldSuppressReaction(event)) {
      dbg(`suppress duplicate reaction ${event.id.slice(0, 12)}`);
      return;
    }
    const result = await deliver(event);
    if (result.ok) {
      if (typeof event.created_at === "number" && event.created_at > cursor) {
        cursor = event.created_at;
        writeCursor(cursor);
      }
      log(`delivered ${event.kind} ${event.id.slice(0, 12)}…`);
    } else {
      log(`webhook FAILED for ${event.id.slice(0, 12)}…: ${result.reason}`);
    }
  }

  // Pre-set the cursor to "now" so the first subscription doesn't replay
  // history. Operators who want full backfill on first run should set
  // LEMMA_BACKFILL=1 in the env file.
  if (cursor === 0 && process.env.LEMMA_BACKFILL !== "1" && env.LEMMA_BACKFILL !== "1") {
    cursor = Math.floor(Date.now() / 1000);
    writeCursor(cursor);
    log(`LEMMA_BACKFILL not set; cursor pinned to now (${cursor})`);
  }

  await relay.connect();
  relay.subscribe(filter);
  log(`subscribed with filter=${JSON.stringify(filter)}`);

  process.once("SIGINT", () => { log("SIGINT; closing"); relay.close(); process.exit(0); });
  process.once("SIGTERM", () => { log("SIGTERM; closing"); relay.close(); process.exit(0); });

  // Keep alive; RelayClient handles reconnection.
  while (true) await sleep(60_000);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
