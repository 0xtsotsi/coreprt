// agents/_lib/one-shot/crm-onboard.mjs
//
// Onboards a new client into the webrnds CRM bridge (PR-5). Generates a
// dealId, publishes a kind:30023 deal memo, and posts to trycompai (or
// the stub log, when CRM_PROVIDER=stub).
//
// Usage:
//   coreprt-agent crm-onboard <name> \
//     --client "Acme Corp" \
//     --contact <npub-or-hex> \
//     --scope landing-page-v2 \
//     --budget-hours 16 \
//     [--title "Acme landing page v2"] \
//     [--memo-file /path/to/memo.md]

import { runWithRelay } from "../writer.mjs";
import { crmOnboard } from "../crm-bridge.mjs";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: crm-onboard <name> --client X --contact Y --scope Z [--budget-hours N] [--title T] [--memo-file F]");
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--client") flags.client = args[++i];
    else if (arg === "--contact") flags.contact = args[++i];
    else if (arg === "--scope") flags.scope = args[++i];
    else if (arg === "--budget-hours") flags.budgetHours = Number.parseInt(args[++i], 10);
    else if (arg === "--title") flags.title = args[++i];
    else if (arg === "--memo-file") flags.memoFile = args[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent crm-onboard <name> [options]

Options:
  --client <name>        Client display name (required)
  --contact <pk>         Client contact pubkey, hex or npub (required)
  --scope <slug>         Scope slug (e.g. landing-page-v2) (required)
  --budget-hours <n>     Budget in hours (optional)
  --title <text>         Memo title (optional, default: "<client> — <scope>")
  --memo-file <path>     Read memo body from a markdown file (optional)
  -h, --help             Show this help

Examples:
  coreprt-agent crm-onboard fizz \\
    --client "Acme Corp" \\
    --contact npub1abc...xyz \\
    --scope landing-page-v2 \\
    --budget-hours 16
`;

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  for (const required of ["client", "contact", "scope"]) {
    if (!flags[required]) {
      process.stderr.write(`error: --${required} is required\n`);
      process.exit(78);
    }
  }

  const log = (...args) => console.log(`[${name}] [crm-onboard]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set\n");
    process.exit(78);
  }

  // npub → hex: not implemented here; the caller passes hex. Future
  // expansion can accept npub1... and translate via nip19.
  let body = undefined;
  if (flags.memoFile) {
    body = readFileSync(flags.memoFile, "utf8");
  }

  await runWithRelay(
    { nsec, relayUrl: process.env.AGENT_RELAY_URL, host: process.env.BUZZ_RELAY_HOST, log },
    async (session) => {
      const result = await crmOnboard({
        client: flags.client,
        contact: flags.contact,
        scope: flags.scope,
        budgetHours: flags.budgetHours,
        dealMemo: {
          title: flags.title,
          body,
        },
        signerNsec: nsec,
        log,
      });
      log(`onboarded: deal=${result.dealId} nostr_event=${result.dealEvent.id} mode=${result.mode}`);
      if (result.trycompaiPosted) log("posted to trycompai: ok");
      // crmOnboard signs the dealEvent; we publish it via the writer's
      // session so AUTH and relay acceptance are handled consistently.
      const published = await session.publish(result.dealEvent);
      if (published.ok === true) {
        // writer.mjs session.publish() returns { ok, reason } only; the event
        // id lives on the event we passed in (result.dealEvent.id).
        process.stdout.write(`onboarded deal=${result.dealId} nostr_event=${result.dealEvent.id}\n`);
        process.exit(0);
      }
      process.stderr.write(`rejected: ${published.reason || "unknown"}\n`);
      process.exit(1);
    }
  );
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});