import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RelayClient } from "./relay-client.mjs";
import { finalizeEvent, getKeypairFromHex, verifyEvent } from "./nostr.mjs";
import {
  buildStatusEventTemplate,
  isStatusDisabled as statusDisabled,
  KIND_USER_STATUS,
} from "./user-status.mjs";

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
      .then(() => handleMessageWithStatus(event))
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
  // loadSlashCommands accepts `null` for cwd and falls back to the repo-root
  // search path on its own.
  const cmds = loadSlashCommands(process.env.GG_CWD);
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

  // Autopilot (always on, mirrors gg-coder kenAuto).
  // After publishing the build reply, ask Ken to review the just-completed
  // work. If Ken returns PROMPT, the fix-prompt is re-injected as a fresh
  // kind:9 — the build session will see it on the next relay subscription
  // tick and process it normally.
  try {
    const { runAutopilot } = await import("./autopilot-loop.mjs");
    const stats = await gatherTurnStats();
    if (stats) {
      // Post-tool hook: if the just-completed turn wrote code, auto-enqueue
      // a /compare slash command. GG-coder does this through the sidecar
      // (`autopilot-gate.js` triggers `ken-compare` after every turn with
      // mutations); we mirror the same hook by publishing a follow-up
      // kind:9 with content "/compare" addressed at ourselves. The slash
      // router will expand it on the next subscription tick.
      //
      // Loop guard: don't re-compare after a slash command reply, since
      // the agent is in read-only "review" / "reflect" / "test" mode, not
      // writing code. Detected by checking whether the inbound event's
      // content starts with `/<cmd>`. (The slash router strips the prefix
      // before sending to ggcoder, but we still have the original event.)
      const isSlashReply = /^\s*\//.test(event.content);
      const wroteCode = (stats.writeCalls + stats.editCalls) > 0;
      if (wroteCode && !isSlashReply) {
        log(`post-tool hook: enqueueing /compare (wrote ${stats.writeCalls} new, ${stats.editCalls} edits)`);
        const compareEvent = finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(Date.now() / 1000) + 1,
            tags: [["h", channelId], ["e", replyEvent.id]],
            content: "/compare",
          },
          keypair.skBytes
        );
        await relay.publish(compareEvent);
      }
      const outcome = await runAutopilot({
        agent: name,
        keypair,
        relay,
        channelId,
        lastReplyEventId: replyEvent.id,
        stats,
        log,
        skip: isSlashReply, // slash-command replies don't produce diff
        tags: event.tags, // 2026-08-06: gauntlet delegation (PR-3) reads bar:<name> tags
        content: event.content, // 2026-08-06: gauntlet delegation also reads /gauntlet <bar> in body
      });
      log(`autopilot outcome: ${JSON.stringify(outcome)}`);
    }
  } catch (err) {
    log(`autopilot error: ${err.message}`);
  }
}

// Compute changedLines / writeCalls / editCalls / bashCalls from the working
// tree (git diff HEAD). Used to decide whether Ken should review the turn.
// Tool-call granularity is inferred from per-file diff metadata:
// - each file in the diff → one tool call
// - .sh / .bash / Makefile changes → bashCall
// - new files (+++/--- header with no source lines in HEAD) → writeCall
// - existing files modified → editCall
async function gatherTurnStats() {
  const { execSync } = await import("node:child_process");
  let diff;
  try {
    diff = execSync("git diff HEAD -- .", {
      cwd: process.env.GG_CWD || new URL("..", import.meta.url).pathname,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  if (!diff.trim()) return null;
  const lines = diff.split("\n");
  // Count only `+` / `-` data lines, NOT the `+++` / `---` file headers.
  const changedLines = lines.filter(
    (l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))
  ).length;
  // Walk per-file diff sections to tally one tool call per file.
  const files = []; // [{ path, isNew, isBash }]
  let current = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /diff --git a\/(.+) b\/(.+)/.exec(line);
      if (m) {
        current = { path: m[2], isNew: false, isBash: /\.(sh|bash)$/i.test(m[2]) || /Makefile$/i.test(m[2]) };
        files.push(current);
      }
    } else if (current && line.startsWith("new file mode")) {
      current.isNew = true;
    }
  }
  let bashCalls = 0, writeCalls = 0, editCalls = 0;
  for (const f of files) {
    if (f.isBash) bashCalls++;
    else if (f.isNew) writeCalls++;
    else editCalls++;
  }
  return {
    changedLines,
    toolCalls: files.length,
    toolFailures: 0,
    turns: 1,
    writeCalls,
    editCalls,
    bashCalls,
  };
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
    }, routed.handled ? 180_000 : 90_000);
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
  // Each agent serializes prompts through messageQueue (handleMessage), so only
  // one in-flight prompt per agent at a time. We can safely route by FIFO when
  // ggcoder doesn't echo the request id on text_delta. Final result/error
  // events are still id-strict — those are the atomic handshake.
  const earliestId = () => {
    const it = rpcPending.keys().next();
    return it.done ? null : it.value;
  };
  if (event.type === "text_delta" && typeof event.text === "string") {
    const targetId = event.id ?? earliestId();
    const pending = targetId ? rpcPending.get(targetId) : undefined;
    if (pending) pending.lines.push(event.text);
  } else if (event.type === "result" && rpcPending.has(event.id)) {
    const { resolve, lines } = rpcPending.get(event.id);
    rpcPending.delete(event.id);
    resolve(lines.join("").trim());
  } else if (event.type === "error" && rpcPending.has(event.id)) {
    const { resolve } = rpcPending.get(event.id);
    rpcPending.delete(event.id);
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

// ── NIP-38 user status (kind 30315) ───────────────────────────
// Full spec: https://github.com/nostr-protocol/nips/blob/master/38.md
//
// States:
//   general (default) — persistent on the d:general coordinate.
//   music, working    — persistent; the runtime auto-emits "working" while
//                       a turn is in-flight and "idle" when waiting.
//   dnd, idle, deep-build — TTL-bearing (default 1h). Idle/deep-build are
//                       emitted by the runtime; dnd is set by the operator
//                       via `coreprt-agent user-status <name> set --state dnd`.
//
// Auto-emit lifecycle transitions:
//   startup  → general "active" with 1h expiry (preserves the prior interim
//              presence ping behavior, so a dead agent self-clears within 1h).
//   turn start → working "<agent> on <kind:9 reply>"  (no expiry)
//   turn end   → idle "waiting" with 1h expiry (clears when idle > 1h)
//   compare gauntlet running → deep-build "running gauntlet round N/M" (1h)
//
// Opt out by setting COREPRT_AGENT_NO_STATUS=1 in the agent env file.
const statusLog = (...args) => log(`[status]`, ...args);

// Track the current state so we don't churn publishes (only emit on change).
let currentStatusState = null;
let currentStatusText = null;

async function publishStatus(state, text, opts = {}) {
  if (statusDisabled()) {
    statusLog(`skip (COREPRT_AGENT_NO_STATUS=1) state=${state}`);
    return { skipped: true };
  }
  // Defer until AUTH completes (max 10s) so the publish doesn't race the
  // NIP-42 challenge. Mirrors the behavior of the prior interim ping.
  const deadline = Date.now() + 10_000;
  while (!relay.authenticated && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!relay.authenticated) {
    statusLog(`skip (auth timeout) state=${state}`);
    return { skipped: true, reason: "auth-timeout" };
  }
  if (currentStatusState === state && currentStatusText === text && !opts.force) {
    return { skipped: true, reason: "unchanged" };
  }
  try {
    const template = buildStatusEventTemplate({
      state,
      text,
      emoji: opts.emoji,
      reference: opts.reference,
      ttlSeconds: opts.ttlSeconds,
    });
    const event = finalizeEvent(template, keypair.skBytes);
    if (event.kind !== KIND_USER_STATUS) {
      throw new Error(`internal: expected kind ${KIND_USER_STATUS}, got ${event.kind}`);
    }
    const result = await relay.publish(event);
    currentStatusState = state;
    currentStatusText = text;
    statusLog(
      `state=${state} id=${event.id.slice(0, 12)}… ` +
        `tags=${event.tags.map((t) => t[0]).join(",")} ` +
        `result.ok=${result.ok} ${result.reason ?? ""}`
    );
    return { event, result };
  } catch (err) {
    statusLog(`publish failed state=${state}: ${err.message}`);
    return { error: err.message };
  }
}

// Initial presence ping + reconnect retry. The RelayClient's `authenticated`
// flag flips true on AUTH and false on disconnect; we poll it and re-publish
// whenever it transitions false → true. This makes the operator-visible
// "active" badge self-heal after relay flapping without modifying
// RelayClient itself.
let wasAuthed = false;
function statusWatchdogTick() {
  const model = process.env.AGENT_MODEL ?? "MiniMax-M3";
  if (relay.authenticated && !wasAuthed) {
    wasAuthed = true;
    publishStatus("general", `[active] ${name} ggcoder · ${model}`, {
      ttlSeconds: 3600,
      force: true,
    }).catch((err) => statusLog(`initial ping error: ${err.message}`));
  } else if (!relay.authenticated && wasAuthed) {
    wasAuthed = false;
    statusLog(`relay deauthenticated; will re-publish on next AUTH`);
  }
}
const statusWatchdog = setInterval(statusWatchdogTick, 2_000);
statusWatchdog.unref?.();

// Wrap handleMessage so we can flip working→idle around each turn.
// The outer messageQueue chain in onEvent() already serializes turns, so we
// don't need a re-entrancy guard here — each handleMessageWithStatus runs to
// completion before the next turn starts.
const handleMessageBase = handleMessage;
let turnCounter = 0;
async function handleMessageWithStatus(event) {
  turnCounter += 1;
  const turnId = turnCounter;
  await publishStatus("working", `${name} on turn #${turnId}: ${event.content.slice(0, 80)}`);
  try {
    await handleMessageBase(event);
  } finally {
    // working → idle on exit. 1h expiry so a dead agent self-clears.
    await publishStatus("idle", `${name} waiting`, { ttlSeconds: 3600 });
  }
}

// ── Hello-world one-shot (interim) ──────────────────────────────
// Operator can set AGENT_HELLO_WORLD to publish a single kind:9 to
// the channel on startup. Used to verify the agent is in the right
// community after channel migration. Set to empty to disable.
if (process.env.AGENT_HELLO_WORLD) {
  try {
    if (!relay.authenticated) throw new Error("relay not authenticated");
    const helloEvent = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", channelId],
          ["subject", "hello-world"],
          ["client", "ggcoder-minimax"],
        ],
        content: process.env.AGENT_HELLO_WORLD,
      },
      keypair.skBytes
    );
    const result = await relay.publish(helloEvent);
    log(
      result?.ok
        ? `hello-world published: ${JSON.stringify(result)}`
        : `hello-world not published: ${result?.reason ?? "unknown"}`
    );
  } catch (err) {
    log(`hello-world failed: ${err.message}`);
  }
}
