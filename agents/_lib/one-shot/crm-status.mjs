// agents/_lib/one-shot/crm-status.mjs
//
// Looks up the live status of a deal. Reads the CRM mirror (trycompai
// or stub) and merges with the recent Nostr events for that deal.
//
// Usage:
//   coreprt-agent crm-status <name> --deal <dealId>
//   coreprt-agent crm-status <name> --deal <dealId> --nostr-only

import { runWithRelay } from "../writer.mjs";
import { crmStatus } from "../crm-bridge.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: crm-status <name> --deal <dealId> [--nostr-only]");
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--deal") flags.dealId = args[++i];
    else if (arg === "--nostr-only") flags.nostrOnly = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent crm-status <name> [options]

Options:
  --deal <dealId>         The deal UUID (required)
  --nostr-only            Skip the trycompai call; show only Nostr events
  -h, --help              Show this help

Examples:
  coreprt-agent crm-status fizz --deal 0afe2e00-a9c7-4941-954f-c200c2429e3f
`;

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  if (!flags.dealId) {
    process.stderr.write("error: --deal <dealId> is required\n");
    process.exit(78);
  }

  const log = (...args) => console.log(`[${name}] [crm-status]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set\n");
    process.exit(78);
  }

  await runWithRelay(
    { nsec, relayUrl: process.env.AGENT_RELAY_URL, host: process.env.BUZZ_RELAY_HOST, log },
    async (session) => {
      // Fetch kind:1 receipts whose ["deal", <dealId>] tag matches via
      // the writer's REQ helper, which awaits EOSE and returns the events.
      const receipts = await session.awaitEose(
        { kinds: [1], "#deal": [flags.dealId] },
        { quietMs: 1500 }
      );
      const result = await crmStatus({
        dealId: flags.dealId,
        recentEvents: receipts,
        nostrOnly: flags.nostrOnly ?? false,
      });
      log(`deal=${result.dealId} status=${result.status} mode=${result.mode} receipts=${result.recentEvents.length}`);
      process.stdout.write(JSON.stringify({
        dealId: result.dealId,
        status: result.status,
        mode: result.mode,
        receipts: result.recentEvents.map((e) => ({
          id: e.id,
          kind: e.kind,
          content: e.content?.slice(0, 200),
          tags: e.tags?.filter((t) => t[0] === "receipt_kind" || t[0] === "scope"),
        })),
      }, null, 2) + "\n");
      process.exit(0);
    }
  );
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});