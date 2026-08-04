// agents/_lib/one-shot/search.mjs
//
// Searchable channel archive (NIP-50).
//   coreprt-agent search <name> "<query>" --channel <uuid> [--limit <n>]
//
// REQs the relay with { kinds: [9], "#h": [<channel>], search: "<query>",
// limit }. Prints matches sorted by created_at. If the relay returns 0 hits
// for the NIP-50 search filter, falls back to a client-side filter on a wider
// REQ so the operator still gets useful results (verified 2026-08-04: the
// deployed relay accepts the filter shape but has no fast FTS index).
//
// Removes a feature: rm this file. The underlying \`req\` one-shot still
// supports NIP-50 via --search.

import { runWithRelay, awaitEose } from "../writer.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error('usage: search <name> "<query>" --channel <uuid> [--limit n]');
  const flags = { query: null, channel: null, limit: 20, since: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--channel") flags.channel = args[++i];
    else if (arg === "--limit") flags.limit = Number.parseInt(args[++i], 10);
    else if (arg === "--since") flags.since = Number.parseInt(args[++i], 10);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (!flags.query && !arg.startsWith("--")) flags.query = arg;
    else throw new Error(`unknown flag or duplicate query: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent search <name> "<query>" [options]

Searches #general (or the channel named in --channel) for kind 9 events
matching <query>. NIP-50 search filter; falls back to a client-side
substring filter if the relay returns 0 hits for the search field.

Options:
  --channel <uuid>  Channel UUID (or name; --channel accepts a UUID only,
                    resolution of names is in the channel-cache layer
                    which is a separate concern).
  --limit <n>       Max events to consider (default 20)
  --since <unix>    Only consider events at-or-after this timestamp
  -h, --help        Show this help

Output: one line per match, \`<unix-ts> <author-prefix-12> <80-char snippet>
nostr:<event-id>\`.
`;

function formatMatch(event, query) {
  const snippet = (event.content ?? "").replace(/\s+/g, " ").slice(0, 80);
  const author = (event.pubkey ?? "").slice(0, 12);
  const ts = Number.isInteger(event.created_at) ? event.created_at : 0;
  return `${ts} ${author} ${snippet} nostr:${event.id}`;
}

function clientFilter(events, query) {
  const needle = query.toLowerCase();
  return events.filter((e) => (e.content ?? "").toLowerCase().includes(needle));
}

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }
  if (!flags.query) {
    process.stderr.write('error: query is required ("<query>")\n');
    process.exit(78);
  }
  const log = (...args) => console.log(`[${name}] [search]`, ...args);
  const nsec = process.env.AGENT_NSEC;
  if (!nsec) {
    process.stderr.write("error: AGENT_NSEC is not set\n");
    process.exit(78);
  }
  const channelId = flags.channel ?? process.env.AGENT_CHANNEL_UUID;
  if (!channelId) {
    process.stderr.write("error: AGENT_CHANNEL_UUID is not set (and --channel not given)\n");
    process.exit(78);
  }

  const baseFilter = (extra) => {
    const f = { kinds: [9], "#h": [channelId], limit: Math.max(flags.limit * 4, 80) };
    Object.assign(f, extra);
    return f;
  };

  const nipped = await runWithRelay(
    { nsec, relayUrl: process.env.AGENT_RELAY_URL, host: process.env.BUZZ_RELAY_HOST, log },
    (session) => awaitEose(session, baseFilter({ search: flags.query }))
  );
  log(`NIP-50 search returned ${nipped.length} hits`);
  let matches = nipped;
  if (matches.length === 0) {
    log("falling back to client-side substring filter");
    const broader = await runWithRelay(
      { nsec, relayUrl: process.env.AGENT_RELAY_URL, host: process.env.BUZZ_RELAY_HOST, log },
      (session) => awaitEose(session, baseFilter({ since: flags.since }))
    );
    matches = clientFilter(broader, flags.query);
    log(`client-side filter found ${matches.length} of ${broader.length} events`);
  }

  matches.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const top = matches.slice(0, flags.limit);
  for (const event of top) {
    process.stdout.write(`${formatMatch(event, flags.query)}\n`);
  }
  process.stdout.write(`# ${top.length} match(es) for "${flags.query}"\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
