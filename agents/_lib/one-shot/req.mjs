// agents/_lib/one-shot/req.mjs
//
// CLI front-end for read-only REQ. Operator-facing command:
//   coreprt-agent req <name> --kind <k> [--tag k=v]... [--search <q>] [--limit <n>]
//
// Prints each event as one JSONL line, then exits 0 on EOSE (or quiet-timeout
// for relays that don't emit EOSE). Exits 1 on connection failure, 78 on misuse.

import { runWithRelay, awaitEose } from "../writer.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: req <name> --kind <k> [--tag k=v]... [--search q] [--limit n]");
  const flags = { tags: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--kind") flags.kind = Number.parseInt(args[++i], 10);
    else if (arg === "--tag") flags.tags.push(args[++i]);
    else if (arg === "--search") flags.search = args[++i];
    else if (arg === "--limit") flags.limit = Number.parseInt(args[++i], 10);
    else if (arg === "--since") flags.since = Number.parseInt(args[++i], 10);
    else if (arg === "--until") flags.until = Number.parseInt(args[++i], 10);
    else if (arg === "--author") flags.author = args[++i];
    else if (arg === "--id") flags.id = args[++i];
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

function buildFilter(flags) {
  if (!Number.isInteger(flags.kind)) {
    throw new Error("--kind is required and must be an integer");
  }
  const filter = { kinds: [flags.kind] };
  if (flags.tags.length > 0) {
    const byKey = new Map();
    for (const spec of flags.tags) {
      const [k, v] = parseTag(spec);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(v);
    }
    for (const [k, values] of byKey) filter[`#${k}`] = values;
  }
  if (flags.search) filter.search = flags.search;
  if (Number.isInteger(flags.limit)) filter.limit = flags.limit;
  if (Number.isInteger(flags.since)) filter.since = flags.since;
  if (Number.isInteger(flags.until)) filter.until = flags.until;
  if (flags.author) filter.authors = [flags.author];
  if (flags.id) filter.ids = [flags.id];
  return filter;
}

const HELP = `Usage: coreprt-agent req <name> [options]

Options:
  --kind <k>            Event kind (required)
  --tag k=v             Filter tag, may be repeated
  --search <q>          NIP-50 search field
  --limit <n>           Max events
  --since <unix>        created_at >= n
  --until <unix>        created_at <= n
  --author <hex>        author pubkey
  --id <hex>            event id
  -h, --help            Show this help

Output: one JSON event per line, then a trailing "{ \"eose\": true }" line.
`;

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  const log = (...args) => console.log(`[${name}] [req]`, ...args);
  const filter = buildFilter(flags);
  log(`REQ ${JSON.stringify(filter)}`);

  await runWithRelay(
    {
      nsec: process.env.AGENT_NSEC,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    async (session) => {
      const events = await awaitEose(session, filter, {
        onEvent: (event) => {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        },
      });
      process.stdout.write(`${JSON.stringify({ eose: true, count: events.length })}\n`);
      process.exit(0);
    }
  );
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
