// agents/_lib/one-shot/crm-receipt.mjs
//
// Publishes a kind:1 RECEIPT for a deal. Used by agents to mark progress,
// blockers, results, and delivered state back to the CRM.
//
// Usage:
//   coreprt-agent crm-receipt <name> \
//     --deal <dealId> \
//     --scope <scope-slug> \
//     --job <job-event-id> \
//     --kind progress|result|blocker|delivered \
//     --content "..."

import { runWithRelay } from "../writer.mjs";
import { crmReceipt } from "../crm-bridge.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: crm-receipt <name> --deal X --scope Y --job Z --kind K --content C");
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--deal") flags.dealId = args[++i];
    else if (arg === "--scope") flags.scope = args[++i];
    else if (arg === "--job") flags.jobEventId = args[++i];
    else if (arg === "--kind") flags.receiptKind = args[++i];
    else if (arg === "--content") flags.content = args[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent crm-receipt <name> [options]

Options:
  --deal <dealId>         The deal UUID (required)
  --scope <slug>          Scope slug (required)
  --job <event-id>        The kind:43001 job event id (required)
  --kind <K>              progress | result | blocker | delivered (required)
  --content <text>        Receipt content (required)
  -h, --help              Show this help

Examples:
  coreprt-agent crm-receipt fizz \\
    --deal 0afe2e00-a9c7-4941-954f-c200c2429e3f \\
    --scope landing-page-v2 \\
    --job 37490d1c86b7562b2bdbff150124500a0bc838e17e1e6fbb72c2f3785330b46f \\
    --kind progress \\
    --content "Hero section shipped to preview; awaiting design review."
`;

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  for (const required of ["dealId", "scope", "jobEventId", "receiptKind", "content"]) {
    if (!flags[required]) {
      process.stderr.write(`error: --${required.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())} is required\n`);
      process.exit(78);
    }
  }

  const log = (...args) => console.log(`[${name}] [crm-receipt]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set\n");
    process.exit(78);
  }

  await runWithRelay(
    { nsec, relayUrl: process.env.AGENT_RELAY_URL, host: process.env.BUZZ_RELAY_HOST, log },
    async (session) => {
      const result = await crmReceipt({
        dealId: flags.dealId,
        scope: flags.scope,
        jobEventId: flags.jobEventId,
        receiptKind: flags.receiptKind,
        content: flags.content,
        signerNsec: nsec,
        log,
      });
      log(`receipt signed nostr_event=${result.receiptEventId} postedToTrycompai=${result.postedToTrycompai} mode=${result.mode}`);
      // Reuse the signed receipt event from crmReceipt() so the event id
      // in the trycompai mirror matches the event id on the relay exactly.
      // (Building a fresh event here would diverge from crmOnboard's
      // pattern and could cause the relay id and trycompai id to differ.)
      const published = await session.publish(result.receiptEvent);
      if (published.ok === true) {
        // writer.mjs session.publish() returns { ok, reason } only; the event
        // id lives on the event we passed in (result.receiptEvent.id).
        process.stdout.write(`receipt published kind:1 id:${result.receiptEvent.id}\n`);
        process.stdout.write(`nostr:${result.receiptEvent.id}\n`);
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