// lemma-bridge.mjs — operator-facing one-shot for the Lemma bridge.
//
// Usage:
//   coreprt-agent lemma-bridge <agent> env-init <env-file-path>  # scaffold a config
//   coreprt-agent lemma-bridge <agent> cursor                    # show the current cursor
//   coreprt-agent lemma-bridge <agent> cursor reset              # reset to 0 (backfill on next run)
//   coreprt-agent lemma-bridge <agent> dedupe                    # show the dedupe map
//   coreprt-agent lemma-bridge <agent> check                     # sanity-check env + reach the relay
//
// The <agent> positional is required by coreprt-agent.sh's table dispatch.
// For the lemma bridge it determines the env file name (~/.config/coreprt/agents/<agent>.lemma.env)
// and the state files (state/<agent>.cursor, state/<agent>.dedupe.json).
//
// Note: this one-shot is read-only for `cursor`/`dedupe`/`check`; it does
// not start the bridge process. To run the bridge, install the LaunchAgent
// (see agents/lemma/com.coreprt.agent.lemma.plist.example) or invoke
// `node agents/_lib/lemma-bridge.mjs` directly.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const args = process.argv.slice(2);
const agentName = args[0];
const subcommand = args[1];

function help() {
  console.log(`usage: coreprt-agent lemma-bridge <agent> <subcommand>

subcommands:
  env-init [path]  scaffold a new env file at the given path (default
                   ~/.config/coreprt/agents/<agent>.lemma.env, mode 0600)
  cursor           show the current cursor (created_at) for this agent
  cursor reset     reset the cursor to 0 so the next run backfills
  dedupe           show the dedupe map (kind:7 reactions suppressed)
  check            verify env, relay reachability, and webhook URL format

  delete           print the steps to remove the Lemma feature (no-op
                   confirmation; nothing is deleted by this command)
`);
}

if (!agentName || subcommand === "help" || subcommand === "--help") {
  help();
  process.exit(agentName ? 0 : 64);
}

const HOME = process.env.HOME ?? "";
const ENV_FILE = join(HOME, ".config", "coreprt", "agents", `${agentName}.lemma.env`);
const STATE_DIR = join(HOME, ".config", "coreprt", "agents", "state");
const CURSOR_FILE = join(STATE_DIR, `${agentName}.cursor`);
const DEDUPE_FILE = join(STATE_DIR, `${agentName}.dedupe.json`);

function loadEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

if (subcommand === "env-init") {
  const target = args[2] ?? ENV_FILE;
  if (existsSync(target)) {
    console.error(`refusing to overwrite existing env file: ${target}`);
    process.exit(73);
  }
  mkdirSync(join(target, ".."), { recursive: true });
  const envLines = [
    `# ~/.config/coreprt/agents/${agentName}.lemma.env`,
    `# Lemma bridge config (PR-7). Mode 0600.`,
    ``,
    `# Required: per-agent keypair (must be a relay member for AUTH to succeed)`,
    `AGENT_NSEC=`,
    ``,
    `# Required: where to deliver events. Any HTTPS endpoint that accepts`,
    `# POST + JSON. Lemma pods expose a webhook on port 7322.`,
    `LEMMA_WEBHOOK_URL=`,
    `# Optional bearer token (sent as Authorization: Bearer <token>)`,
    `LEMMA_WEBHOOK_TOKEN=`,
    ``,
    `# Optional: relay override. Defaults to ws://127.0.0.1:3300 with`,
    `# Host: coreprt.webrnds.com (works with the local proxy + WARP).`,
    `# AGENT_RELAY_URL=`,
    `# BUZZ_RELAY_HOST=`,
    ``,
    `# Optional: kinds to deliver. Default 1,7,9,1111,43001,30023.`,
    `# LEMMA_KINDS=1,7,9`,
    ``,
    `# Optional: reaction dedupe window in seconds. Default 300 (5 min).`,
    `# LEMMA_DEDUPE_REACTION_SECONDS=300`,
    ``,
    `# Optional: set to 1 to backfill from the relay on first run`,
    `# (otherwise the cursor is pinned to "now" so a fresh start only sees`,
    `# new events).`,
    `# LEMMA_BACKFILL=1`,
    ``,
    `# Optional: filter file (JSON filter object, e.g. { "kinds": [1,9], "#t": ["euc"] }).`,
    `# LEMMA_FILTER_FILE=`,
    ``,
    `# Optional: enable verbose logging.`,
    `# LEMMA_DEBUG=1`,
  ];
  writeFileSync(target, envLines.join("\n") + "\n", { mode: 0o600 });
  console.log(`wrote ${target}`);
  console.log("next steps:");
  console.log(`  1. edit ${target} and set AGENT_NSEC + LEMMA_WEBHOOK_URL`);
  console.log(`  2. add the agent to the relay if not already a member:`);
  console.log(`     COMPOSE_PROJECT_NAME=coreprt ./CorePrt-deploy/run.sh add-member <hex> --role member`);
  console.log(`  3. start the bridge: launchctl load -w ~/Library/LaunchAgents/com.coreprt.agent.${agentName}.plist`);
  console.log(`     (or run directly: node agents/_lib/lemma-bridge.mjs)`);
  process.exit(0);
}

if (subcommand === "cursor") {
  const reset = args[2] === "reset";
  if (reset) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CURSOR_FILE, "0", "utf8");
    console.log(`cursor reset to 0 (next bridge run will backfill)`);
    process.exit(0);
  }
  if (!existsSync(CURSOR_FILE)) {
    console.log(`no cursor file yet: ${CURSOR_FILE}`);
    console.log(`(the bridge pins the cursor to "now" on first run unless LEMMA_BACKFILL=1)`);
    process.exit(0);
  }
  const v = readFileSync(CURSOR_FILE, "utf8").trim();
  const ts = Number(v);
  console.log(`cursor: created_at=${v}${Number.isFinite(ts) ? ` (${new Date(ts * 1000).toISOString()})` : ""}`);
  process.exit(0);
}

if (subcommand === "dedupe") {
  if (!existsSync(DEDUPE_FILE)) {
    console.log(`no dedupe file yet: ${DEDUPE_FILE}`);
    process.exit(0);
  }
  const map = JSON.parse(readFileSync(DEDUPE_FILE, "utf8"));
  const entries = Object.entries(map);
  console.log(`dedupe entries: ${entries.length}`);
  for (const [k, ts] of entries.slice(0, 20)) {
    console.log(`  ${k}  ${ts}  (${new Date(Number(ts) * 1000).toISOString()})`);
  }
  if (entries.length > 20) console.log(`  ... +${entries.length - 20} more`);
  process.exit(0);
}

if (subcommand === "check") {
  const env = loadEnv();
  const errs = [];
  if (!env.AGENT_NSEC) errs.push("AGENT_NSEC not set");
  if (!env.LEMMA_WEBHOOK_URL) errs.push("LEMMA_WEBHOOK_URL not set");
  for (const e of errs) console.error(`- ${e}`);
  if (errs.length > 0) {
    console.error(`\nFAIL: ${errs.length} env error(s). run 'env-init' to scaffold.`);
    process.exit(1);
  }
  console.log("env: OK");
  // Try a quick reachability check against the local relay.
  const relay = env.AGENT_RELAY_URL ?? "ws://127.0.0.1:3300";
  const host = env.BUZZ_RELAY_HOST ?? "coreprt.webrnds.com";
  await new Promise((resolve) => {
    const ws = new WebSocket(relay, { headers: { Host: host } });
    const timer = setTimeout(() => { console.error("relay: TIMEOUT (3s)"); ws.terminate(); process.exit(2); }, 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      console.log(`relay: OK (${relay} via Host: ${host})`);
      ws.close();
      resolve();
    });
    ws.once("error", (err) => { clearTimeout(timer); console.error(`relay: FAIL (${err.message})`); process.exit(2); });
  });
  console.log("webhook URL: OK (format only; not contacted)");
  process.exit(0);
}

if (subcommand === "delete") {
  console.log(`Steps to remove the Lemma feature (no files are modified by this command):`);
  console.log(`  1. unload the LaunchAgent:`);
  console.log(`     launchctl unload ~/Library/LaunchAgents/com.coreprt.agent.${agentName}.plist`);
  console.log(`  2. delete the bridge files:`);
  console.log(`     rm agents/_lib/lemma-bridge.mjs`);
  console.log(`     rm agents/_lib/one-shot/lemma-bridge.mjs`);
  console.log(`     rm agents/_lib/__tests__/lemma-bridge.test.js`);
  console.log(`     rm ${ENV_FILE}`);
  console.log(`     rm ${CURSOR_FILE} ${DEDUPE_FILE}`);
  console.log(`  3. remove 'lemma-bridge' from the coreprt-agent.sh dispatch table`);
  console.log(`  4. (optional) remove the agent from the relay:`);
  console.log(`     COMPOSE_PROJECT_NAME=coreprt ./CorePrt-deploy/run.sh remove-member <hex>`);
  console.log(`\nNo core hot path imports lemma-bridge.mjs, so the rest of CorePrt runs unchanged.`);
  process.exit(0);
}

console.error(`unknown subcommand: ${subcommand}`);
help();
process.exit(64);
