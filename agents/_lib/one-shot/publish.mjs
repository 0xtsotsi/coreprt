// agents/_lib/one-shot/publish.mjs
//
// CLI front-end for the writer. Operator-facing command:
//   coreprt-agent publish <name> --kind <k> --content <text> \
//     --tag h=<uuid> --tag <k>=<v> ...
//
// Builds an event-template, signs it with the agent's nsec, publishes via the
// writer, prints the event id and a nostr: deep link. Exits 0 on relay OK,
// 1 on relay rejection, 78 on misuse, 2 on connection failure.

import { runWithRelay, buildEventTemplate } from "../writer.mjs";
import { finalizeEvent } from "../nostr.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: publish <name> --kind <k> --content <text> [--tag k=v ...]");
  const flags = { tags: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--kind") flags.kind = Number.parseInt(args[++i], 10);
    else if (arg === "--content") flags.content = args[++i];
    else if (arg === "--tag") flags.tags.push(args[++i]);
    else if (arg === "--created-at") flags.createdAt = Number.parseInt(args[++i], 10);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

function parseTag(spec) {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new Error(`--tag value must be k=v (got ${spec})`);
  return [spec.slice(0, eq), spec.slice(eq + 1)];
}

const HELP = `Usage: coreprt-agent publish <name> [options]

Options:
  --kind <k>            Event kind (required, integer)
  --content <text>      Event content
  --tag k=v             Tag, may be repeated
  --created-at <unix>   Override created_at (default: now)
  -h, --help            Show this help

Examples:
  coreprt-agent publish fizz --kind 9 \\
    --content "hello" --tag h=0afe2e00-a9c7-4941-954f-c200c2429e3f
`;

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  if (!Number.isInteger(flags.kind)) {
    process.stderr.write("error: --kind is required and must be an integer\n");
    process.exit(78);
  }

  const log = (...args) => console.log(`[${name}] [publish]`, ...args);
  const tags = flags.tags.map(parseTag);
  const template = buildEventTemplate({
    kind: flags.kind,
    content: flags.content ?? "",
    tags,
    createdAt: flags.createdAt,
  });

  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set in the agent env file\n");
    process.exit(78);
  }

  const writer = await runWithRelay(
    {
      nsec,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    async (session) => {
      // Sign in-process so the published event has the same id we echo to the
      // operator. The writer's NIP-42 AUTH is a separate signed event.
      const { getKeypairFromHex } = await import("../nostr.mjs");
      const keypair = getKeypairFromHex(nsec);
      const event = finalizeEvent(template, keypair.skBytes);
      log(`publishing kind:${event.kind} id:${event.id}`);
      const result = await session.publish(event);
      if (result.ok === true) {
        process.stdout.write(`published kind:${event.kind} id:${event.id}\n`);
        process.stdout.write(`nostr:${event.id}\n`);
        process.exit(0);
      }
      process.stderr.write(`rejected: ${result.reason || "unknown reason"}\n`);
      process.exit(1);
    }
  );
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
