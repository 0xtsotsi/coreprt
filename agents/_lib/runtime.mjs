import { spawn } from "node:child_process";
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
  return event.content.toLowerCase().includes(trigger);
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

  for (const line of output.split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      const content = event?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    } catch {
      // JSONL may contain non-JSON diagnostic lines.
    }
  }
  return "";
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}; shutting down`);
  relay.close();
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
