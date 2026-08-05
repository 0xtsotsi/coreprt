import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RelayClient } from "./relay-client.mjs";
import { finalizeEvent, getKeypairFromHex, verifyEvent } from "./nostr.mjs";

const REQUIRED_ENV = [
  "AGENT_NAME",
  "AGENT_NSEC",
  "AGENT_RELAY_URL",
  "AGENT_CHANNEL_UUID",
];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`missing required env: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const name = process.env.AGENT_NAME;
const relayUrl = process.env.AGENT_RELAY_URL;
const channelId = process.env.AGENT_CHANNEL_UUID;
const runtime = (process.env.AGENT_RUNTIME ?? "ggcoder").toLowerCase();
const systemPrompt = process.env.AGENT_SYSTEM_PROMPT ?? "";
const trigger = (process.env.AGENT_TRIGGER ?? `@${name}`).toLowerCase();
const keypair = getKeypairFromHex(process.env.AGENT_NSEC);
const expectedPublicKey = process.env.AGENT_PK;
const log = (...args) =>
  console.log(`[${process.env.AGENT_LOG_PREFIX ?? name}]`, ...args);

if (expectedPublicKey && expectedPublicKey !== keypair.pkHex) {
  throw new Error("AGENT_PK does not match AGENT_NSEC");
}
if (!new Set(["claude", "codex", "ggcoder"]).has(runtime)) {
  throw new Error(`unsupported AGENT_RUNTIME: ${runtime}`);
}

log(`starting with pubkey=${keypair.pkHex.slice(0, 12)}…`);

const seenEventIds = new Set();
let messageQueue = Promise.resolve();
let shuttingDown = false;

const relay = new RelayClient({
  url: relayUrl,
  keypair,
  onNotice: (message) => log(`[NOTICE] ${message}`),
  onEvent: (event) => {
    if (!isTriggeredChannelMessage(event)) return;
    rememberEvent(event.id);
    messageQueue = messageQueue
      .then(() => handleMessage(event))
      .catch((error) => log(`message handling failed: ${error.message}`));
  },
  log,
});

function isTriggeredChannelMessage(event) {
  if (!verifyEvent(event) || event.kind !== 9) return false;
  if (seenEventIds.has(event.id) || event.pubkey === keypair.pkHex) return false;
  const eventChannel = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (eventChannel !== channelId) return false;
  const content = event.content.toLowerCase();
  // Standard trigger: @<agent>
  if (content.includes(trigger)) return true;
  // Slash commands are addressed at a specific agent via the command name.
  // Operator can say `/review` (no @) and the receiving agent will route it.
  // We match against the registered slash commands to avoid false positives.
  const cmds = loadSlashCommands(
    process.env.GG_CWD || new URL(".", import.meta.url).pathname
  );
  const isSlash = /^\s*\/([a-zA-Z0-9_-]+)/.exec(event.content);
  if (isSlash && cmds.has(isSlash[1].toLowerCase())) return true;
  return false;
}

function rememberEvent(eventId) {
  seenEventIds.add(eventId);
  if (seenEventIds.size <= 5_000) return;
  const oldestEventId = seenEventIds.values().next().value;
  seenEventIds.delete(oldestEventId);
}

async function handleMessage(event) {
  log(`received kind:9 from ${event.pubkey.slice(0, 12)}`);
  const reply = await askRuntime(event.content);
  if (!reply) {
    log("runtime returned no reply");
    return;
  }

  const replyEvent = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", channelId],
        ["e", event.id],
      ],
      content: reply,
    },
    keypair.skBytes
  );
  const result = await relay.publish(replyEvent);
  log(`publish result: ${JSON.stringify(result)}`);
}

function askRuntime(userContent) {
  // ── RPC mode (preferred): persistent ggcoder process, model stays loaded,
  //    prompts sent over the bridge's stdin NDJSON, events streamed back
  //    over the bridge's stdout. Activated when AGENT_GGCODER_RPC=1.
  //    We lazily spawn the bridge on first call, then reuse it across calls.
  if (process.env.AGENT_GGCODER_RPC === "1" && runtime === "ggcoder") {
    return askRuntimeRpc(userContent);
  }

  const runtimePath = `${process.env.HOME}/.local/bin/${runtime}-minimax`;
  const model = process.env.AGENT_MODEL ?? "MiniMax-M3";
  const userPrompt = `Message in the CorePrt channel:\n${userContent}\n\nReply concisely in 1-3 sentences.`;
  let args;

  if (runtime === "claude") {
    args = [
      "--bare",
      "--print",
      "--no-session-persistence",
      "--model",
      model,
      "--system-prompt",
      systemPrompt,
      userPrompt,
    ];
  } else if (runtime === "codex") {
    args = [
      "exec",
      "--model",
      model,
      "--ephemeral",
      "--skip-git-repo-check",
      `${systemPrompt}\n\n${userPrompt}`,
    ];
  } else {
    args = [
      "--model",
      model,
      "--max-turns",
      "1",
      "--provider",
      "minimax",
      "--system-prompt",
      systemPrompt,
      "--json",
      userPrompt,
    ];
  }

  return new Promise((resolve) => {
    const child = spawn(runtimePath, args, {
      timeout: 90_000,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      log(`runtime spawn error: ${error.message}`);
      finish("");
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        log(
          `runtime failed (code=${code}, signal=${signal ?? "none"}): ${stderr
            .trim()
            .slice(0, 300)}`
        );
        finish("");
        return;
      }
      finish(parseRuntimeOutput(stdout));
    });
  });
}

function parseRuntimeOutput(stdout) {
  const output = stdout.trim();
  if (runtime !== "ggcoder") return output;

  // ggcoder emits two JSONL shapes depending on internal mode:
  //   (a) Claude-style:  {type:"assistant", message:{content:[{type:"text",text:"…"}]}}
  //   (b) Native:        {type:"text_delta", text:"…"}
  // Some lines may be plain prose (Ken-shipped notifications, prompts).
  let fallback = "";
  const textDeltas = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line; capture as last-resort fallback (skip if it's the
      // ggcoder announcement "✨ Ken just shipped …").
      if (!fallback && !trimmed.startsWith("\u2728")) fallback = trimmed;
      continue;
    }
    // Native ggcoder text_delta events stream incrementally — collect them
    // in order, then concat at the end.
    if (event?.type === "text_delta" && typeof event.text === "string") {
      textDeltas.push(event.text);
      continue;
    }
    // Claude-style message.content array. If we see one, prefer it over
    // any text_delta stream (Claude-style events contain the full reply).
    const content = event?.message?.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  if (textDeltas.length > 0) {
    const joined = textDeltas.join("").trim();
    if (joined) return fallback ? `${fallback}\n${joined}` : joined;
  }
  return fallback;
}

// Lazy-spawned persistent bridge to `ggcoder --rpc`. Created on first
// askRuntimeRpc() call and reused for subsequent calls. Re-created on crash.
let rpcBridge = null;
let rpcNextId = 1;
const rpcPending = new Map(); // id → { resolve, lines }
// Map from the *bridge-side* prompt id to our internal rpc id. ggcoder echoes
// the same id we send it, so we can correlate text_delta events to the right
// pending entry instead of guessing by insertion order.
const rpcIdByBridgeId = new Map();
let rpcLastBridgeId = null;

function ensureBridge() {
  if (rpcBridge && !rpcBridge.killed) return rpcBridge;
  const bridge = spawn(
    process.execPath,
    [
      new URL(".", import.meta.url).pathname + "ggcoder-rpc-bridge.mjs",
    ],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        GG_PROVIDER: process.env.GG_PROVIDER || "minimax",
        GG_MODEL: process.env.AGENT_MODEL || "MiniMax-M3",
        GG_CWD: process.env.GG_CWD || new URL(".", import.meta.url).pathname,
        GG_NO_EMOJI: "1",
      },
    }
  );
  let stdoutBuf = "";
  bridge.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      routeBridgeEvent(event);
    }
  });
  bridge.on("exit", (code) => {
    log(`rpc bridge exited (code=${code})`);
    rpcBridge = null;
    // reject all pending
    for (const [, { resolve }] of rpcPending) resolve("");
    rpcPending.clear();
    rpcIdByBridgeId.clear();
    rpcLastBridgeId = null;
  });
  bridge.on("error", (err) => {
    log(`rpc bridge spawn error: ${err.message}`);
    rpcBridge = null;
  });
  rpcBridge = bridge;
  return bridge;
}

// ── Slash command router ───────────────────────────────────────
// GG Coder's interactive TUI intercepts `/<name>` prompts and expands
// them to the body of `.gg/commands/<name>.md` (frontmatter name).
// The RPC mode does NOT do this — it sends `/foo` as plain text.
// Re-implement the same routing here so our headless consumer gets the
// same slash-command UX as the TUI user.
const SLASH_CMD_CACHE = new Map(); // cwd → Map(name → { description, prompt })
function loadSlashCommands(cwd) {
  if (SLASH_CMD_CACHE.has(cwd)) return SLASH_CMD_CACHE.get(cwd);
  const map = new Map();
  // Search locations, most-specific first. Order matters: the cwd-relative
  // dir is the install-path _lib's own commands; the repo-root dir is the
  // shared project commands.
  const dirs = cwd ? [join(cwd, ".gg", "commands")] : [];
  // Also always include the canonical CorePrt repo root, regardless of cwd.
  const repoRoot = new URL("../../", import.meta.url).pathname;
  if (repoRoot) dirs.push(join(repoRoot, ".gg", "commands"));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fm) continue;
        const meta = Object.fromEntries(
          fm[1].split("\n")
            .map((l) => l.split(":").map((s) => s.trim()))
            .filter((kv) => kv.length === 2 && kv[0])
        );
        const name = meta.name || file.replace(/\.md$/, "");
        map.set(name.toLowerCase(), { description: meta.description ?? "", prompt: fm[2].trim() });
      } catch {
        // skip unreadable
      }
    }
  }
  SLASH_CMD_CACHE.set(cwd, map);
  return map;
}

function expandSlashCommand(userContent) {
  const trimmed = userContent.trim();
  const m = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  if (!m) return { handled: false, expanded: userContent };
  const [, name, rest] = m;
  // Search multiple roots so commands are found regardless of which cwd
  // ggcoder was started in. Order matters: cwd-specific first, then the
  // CorePrt repo root last as a fallback for project-shared commands.
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const searchRoots = [
    process.env.GG_CWD,
    process.cwd(),
    repoRoot,
  ].filter(Boolean);
  for (const root of searchRoots) {
    const cmds = loadSlashCommands(root);
    const cmd = cmds.get(name.toLowerCase());
    if (cmd) {
      const args = (rest ?? "").trim();
      const expanded = args
        ? `${cmd.prompt}\n\n---\nUser arguments: ${args}`
        : cmd.prompt;
      log(`slash command /${name} → ${cmd.prompt.length} chars (from ${root})`);
      return { handled: true, expanded };
    }
  }
  return { handled: false, expanded: userContent };
}

function askRuntimeRpc(userContent) {
  const routed = expandSlashCommand(userContent);
  const userPrompt = routed.handled
    ? routed.expanded
    : `Message in the CorePrt channel:\n${userContent}\n\nReply concisely in 1-3 sentences.`;
  const id = `req-${rpcNextId++}-${Date.now()}`;
  return new Promise((resolve) => {
    const bridge = ensureBridge();
    const entry = { resolve, lines: [] };
    rpcPending.set(id, entry);
    const settled = { v: false };
    const timer = setTimeout(() => {
      if (settled.v) return;
      settled.v = true;
      rpcPending.delete(id);
      log("rpc timeout (90s)");
      resolve(entry.lines.join("").trim());
    }, 90_000);
    // wrap resolve to clear timer
    const origResolve = entry.resolve;
    entry.resolve = (val) => {
      if (settled.v) return;
      settled.v = true;
      clearTimeout(timer);
      origResolve(val);
    };
    try {
      bridge.stdin.write(JSON.stringify({ id, command: "prompt", text: userPrompt }) + "\n");
    } catch (err) {
      log(`rpc write error: ${err.message}`);
      entry.resolve("");
    }
  });
}

function routeBridgeEvent(event) {
  if (event.type === "text_delta" && typeof event.text === "string") {
    // Strict id-only routing — ggcoder echoes our prompt id on every streamed
    // event. Events without an id are dropped to prevent misattribution
    // across concurrent in-flight prompts (bumble's review caught this risk).
    const pending = event.id ? rpcPending.get(event.id) : undefined;
    if (pending) pending.lines.push(event.text);
  } else if (event.type === "result" && rpcPending.has(event.id)) {
    const { resolve, lines } = rpcPending.get(event.id);
    rpcPending.delete(event.id);
    rpcIdByBridgeId.delete(event.id);
    resolve(lines.join("").trim());
  } else if (event.type === "error" && rpcPending.has(event.id)) {
    const { resolve } = rpcPending.get(event.id);
    rpcPending.delete(event.id);
    rpcIdByBridgeId.delete(event.id);
    log(`rpc error: ${event.message}`);
    resolve("");
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}; shutting down`);
  relay.close();
  // Reap the RPC bridge if it's still alive — otherwise the ggcoder child
  // holds the model in memory indefinitely (defeats the whole point of RPC).
  if (rpcBridge && !rpcBridge.killed) {
    try {
      rpcBridge.kill("SIGTERM");
      // Give it a moment to flush; force-kill if it hangs.
      await Promise.race([
        new Promise((resolve) => rpcBridge.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (rpcBridge && !rpcBridge.killed) rpcBridge.kill("SIGKILL");
    } catch (err) {
      log(`bridge shutdown error: ${err.message}`);
    }
  }
  await messageQueue;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await relay.connect();
} catch (error) {
  log(`initial relay connection failed: ${error.message}`);
}
log(`subscribing to channel ${channelId}`);
relay.subscribe({ kinds: [9], "#h": [channelId] });
