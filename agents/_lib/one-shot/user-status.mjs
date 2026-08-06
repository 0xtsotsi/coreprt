// agents/_lib/one-shot/user-status.mjs
//
// CLI front-end for NIP-38 user status (kind 30315).
//
// Usage:
//   coreprt-agent user-status <name> set --state <state> --text <text> \
//     [--emoji <emoji>] [--ttl <duration>] [--reference <url>]
//   coreprt-agent user-status <name> clear
//
// Examples:
//   coreprt-agent user-status fizz set --state working --text "shipping NIP-38"
//   coreprt-agent user-status fizz set --state dnd --text "in meeting" --ttl 30m
//   coreprt-agent user-status fizz clear
//
// Behavior:
//   • general / music / working: persistent (no expiration tag). Latest event
//     on the (pubkey, d:<state>) coordinate supersedes prior — NIP-33
//     parameterized-replaceable.
//   • dnd / idle / deep-build: requires a TTL (default 1h). Adds NIP-40
//     expiration tag.
//   • clear: publishes a fresh kind:30315 with d:general and empty content.
//     Per NIP-38 §Live Statuses: "If the content is an empty string then the
//     client should clear the status."

import {
  buildStatusEventTemplate,
  normalizeState,
  parseTtl,
  validateStateAndTtl,
  isStatusDisabled,
  publishStatus,
  KIND_USER_STATUS,
} from "../user-status.mjs";

const HELP = `Usage: coreprt-agent user-status <name> <action> [options]

Actions:
  set     Publish a status event
  clear   Clear the active status (publishes d:general with empty content)

Options for 'set':
  --state <name>       Status type (general, music, working, idle, dnd, deep-build, or custom)
  --text <text>        Status text (the event content)
  --emoji <emoji>      Optional short emoji (e.g. 🎧, 🚀)
  --reference <url>    Optional URL reference (NIP-38 r-tag)
  --ttl <duration>     Auto-expire after duration. Required for dnd/idle/deep-build.
                       Accepts: 30m, 1h, 2h30m, 3600s, 1d, 1w. Default 1h.
  -h, --help           Show this help

Examples:
  coreprt-agent user-status fizz set --state working --text "shipping NIP-38"
  coreprt-agent user-status fizz set --state dnd --text "in meeting" --ttl 30m
  coreprt-agent user-status fizz clear
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  const action = args.shift();
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--state") flags.state = args[++i];
    else if (arg === "--text") flags.text = args[++i];
    else if (arg === "--emoji") flags.emoji = args[++i];
    else if (arg === "--reference") flags.reference = args[++i];
    else if (arg === "--ttl") flags.ttl = args[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, action, flags };
}

async function main() {
  const { name, action, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  if (!action || !["set", "clear"].includes(action)) {
    process.stderr.write(`error: action must be 'set' or 'clear' (got ${JSON.stringify(action)})\n`);
    process.stderr.write(HELP);
    process.exit(78);
  }
  if (isStatusDisabled()) {
    process.stderr.write("error: COREPRT_AGENT_NO_STATUS=1 — status publishing is disabled\n");
    process.exit(78);
  }
  const log = (...args) => console.log(`[${name}] [user-status]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set in the agent env file\n");
    process.exit(78);
  }

  let template;
  if (action === "clear") {
    // NIP-38: empty content + d:general → "client should clear the status".
    template = buildStatusEventTemplate({ state: "general", text: "" });
  } else {
    if (!flags.state) {
      process.stderr.write("error: --state is required for 'set'\n");
      process.exit(78);
    }
    if (typeof flags.text !== "string") {
      process.stderr.write("error: --text is required for 'set'\n");
      process.exit(78);
    }
    let state;
    try {
      state = normalizeState(flags.state);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(78);
    }
    let ttlSeconds = null;
    if (flags.ttl !== undefined) {
      ttlSeconds = parseTtl(flags.ttl);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        process.stderr.write(`error: invalid --ttl ${JSON.stringify(flags.ttl)} (try '30m', '1h', '3600s')\n`);
        process.exit(78);
      }
    }
    const validation = validateStateAndTtl(state, ttlSeconds);
    if (!validation.ok) {
      process.stderr.write(`error: ${validation.error}\n`);
      process.exit(78);
    }
    if (validation.warning) log(validation.warning);
    template = buildStatusEventTemplate({
      state,
      text: flags.text,
      emoji: flags.emoji,
      reference: flags.reference,
      ttlSeconds: validation.ttlSeconds,
    });
  }

  if (template.kind !== KIND_USER_STATUS) {
    throw new Error(`internal: expected kind ${KIND_USER_STATUS}, got ${template.kind}`);
  }

  log(
    `publishing kind:30315 d:${template.tags.find((t) => t[0] === "d")?.[1] ?? "?"} ` +
      `tags=${template.tags.map((t) => t[0]).join(",")}`
  );
  const { event, result } = await publishStatus({
    nsec,
    relayUrl: process.env.AGENT_RELAY_URL,
    host: process.env.BUZZ_RELAY_HOST,
    log,
    state: template.tags.find((t) => t[0] === "d")?.[1] ?? "general",
    text: template.content,
    emoji: template.tags.find((t) => t[0] === "emoji")?.[1],
    reference: template.tags.find((t) => t[0] === "r")?.[1],
    ttlSeconds: (() => {
      const exp = template.tags.find((t) => t[0] === "expiration")?.[1];
      return exp ? Math.max(0, Number.parseInt(exp, 10) - template.created_at) : null;
    })(),
  });
  if (result.ok === true) {
    process.stdout.write(`published kind:30315 id:${event.id}\n`);
    process.stdout.write(`nostr:${event.id}\n`);
    process.exit(0);
  }
  process.stderr.write(`rejected: ${result.reason || "unknown reason"}\n`);
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
