// agents/_lib/one-shot/digest.mjs
//
// Daily digest. At 09:00 local, the named agent posts a one-paragraph
// recap of the prior 24h of #general to #general, signed by the agent's
// nsec. Manual: \`coreprt-agent digest bumble --since 24\`.
//
// Uses the writer (NIP-42 auth, EOSE plumbing) and spawns the agent's
// runtime to summarize the messages. Removes a feature: rm this file
// and the launchd plist — no other code changes.

import { spawn } from "node:child_process";
import { finalizeEvent, getKeypairFromHex } from "../nostr.mjs";
import { runWithRelay, awaitEose } from "../writer.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: digest <name> [--since <hours>]");
  const flags = { sinceHours: 24, runtime: null, model: null, maxEvents: 200 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--since") flags.sinceHours = Number.parseFloat(args[++i]);
    else if (arg === "--runtime") flags.runtime = args[++i];
    else if (arg === "--model") flags.model = args[++i];
    else if (arg === "--max") flags.maxEvents = Number.parseInt(args[++i], 10);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent digest <name> [options]

Posts a daily recap of the prior --since hours of #general to #general.
The named agent's nsec signs the post.

Options:
  --since <hours>     Window in hours (default 24)
  --runtime <name>    Override the runtime (claude/codex/ggcoder)
  --model <name>      Override the model
  --max <n>           Cap on prior messages summarized (default 200)
  -h, --help          Show this help
`;

function runtimePath(name) {
  return `${process.env.HOME}/.local/bin/${name}-minimax`;
}

function runRuntime({ runtime, model, systemPrompt, userPrompt }) {
  const path = runtimePath(runtime);
  const baseArgs = ["--bare", "--print", "--no-session-persistence"];
  const finalArgs =
    runtime === "claude"
      ? [...baseArgs, "--model", model, "--system-prompt", systemPrompt, userPrompt]
      : runtime === "codex"
        ? ["exec", "--model", model, "--ephemeral", "--skip-git-repo-check", `${systemPrompt}\n\n${userPrompt}`]
        : ["--model", model, "--max-turns", "1", "--provider", "minimax", "--system-prompt", systemPrompt, "--json", userPrompt];
  return new Promise((resolve) => {
    const child = spawn(path, finalArgs, { timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
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
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("close", (code) => {
      if (code !== 0) return finish({ ok: false, error: `exit ${code}: ${stderr.trim().slice(0, 200)}` });
      const text = runtime === "ggcoder" ? extractGgcoderText(stdout) : stdout.trim();
      finish({ ok: true, text });
    });
  });
}

function extractGgcoderText(stdout) {
  for (const line of stdout.split("\n").reverse()) {
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
      // ignore non-JSON diagnostic lines
    }
  }
  return "";
}

function pickTopIds(events, max) {
  // Pick up to `max` event ids for inline deep links, preferring longer
  // messages that aren't from the agent itself.
  return events
    .filter((e) => typeof e.content === "string" && e.content.length > 0)
    .slice(-max)
    .map((e) => e.id);
}

function buildPrompt(events) {
  const numbered = events
    .map((e, i) => `${i + 1}. (${new Date(e.created_at * 1000).toISOString().slice(11, 16)}) ${e.content.slice(0, 400)}`)
    .join("\n");
  const idList = events.map((e) => e.id).join(" ");
  return [
    "Summarize the following chat messages from the last 24 hours.",
    "Write ONE short paragraph (≤ 480 chars).",
    "Be specific: name who said what, decisions, action items, blockers.",
    "After the paragraph, include up to 3 inline 'nostr:<event-id>' references",
    "to the most important messages you cited (use the ids provided).",
    "Output ONLY the summary paragraph with the inline links. No preamble.",
    "",
    "Event ids: " + idList,
    "",
    "Messages:",
    numbered,
  ].join("\n");
}

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }

  const log = (...args) => console.log(`[${name}] [digest]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set\n");
    process.exit(78);
  }
  const channelId = process.env.AGENT_CHANNEL_UUID;
  if (!channelId) {
    process.stderr.write("error: AGENT_CHANNEL_UUID is not set\n");
    process.exit(78);
  }
  const keypair = getKeypairFromHex(nsec);
  const runtime = flags.runtime ?? process.env.AGENT_RUNTIME ?? "codex";
  const model = flags.model ?? process.env.AGENT_MODEL ?? "MiniMax-M3";
  const systemPrompt =
    process.env.AGENT_SYSTEM_PROMPT ??
    "You write concise community digests.";

  const since = Math.floor(Date.now() / 1000) - Math.floor(flags.sinceHours * 3600);

  const filter = { kinds: [9], "#h": [channelId], since, limit: flags.maxEvents };
  log(`fetching last ${flags.sinceHours}h of #general`);
  const events = await runWithRelay(
    {
      nsec,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    (session) => awaitEose(session, filter)
  );
  log(`fetched ${events.length} events`);
  if (events.length === 0) {
    log("no events to summarize; exiting 0");
    process.exit(0);
  }

  const ownIds = new Set(events.filter((e) => e.pubkey === keypair.pkHex).map((e) => e.id));
  const others = events.filter((e) => !ownIds.has(e.id));
  if (others.length === 0) {
    log("only the agent's own messages; nothing to summarize");
    process.exit(0);
  }
  const topIds = pickTopIds(others, 3);

  const userPrompt = buildPrompt(others);
  log(`summarizing via ${runtime} (${model})`);
  const result = await runRuntime({ runtime, model, systemPrompt, userPrompt });
  if (!result.ok) {
    process.stderr.write(`runtime failed: ${result.error}\n`);
    process.exit(1);
  }
  let summary = result.text.trim();
  for (const id of topIds.reverse()) {
    summary += `\nnostr:${id}`;
  }
  if (summary.length > 4000) summary = summary.slice(0, 4000);

  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", channelId]],
      content: summary,
    },
    keypair.skBytes
  );
  log(`publishing kind:9 id:${event.id} (${summary.length} chars)`);
  const published = await runWithRelay(
    {
      nsec,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    (session) => session.publish(event)
  );
  if (published.ok === true) {
    process.stdout.write(`published kind:9 id:${event.id}\n`);
    process.exit(0);
  }
  process.stderr.write(`rejected: ${published.reason || "unknown reason"}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
