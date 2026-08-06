// agents/_lib/one-shot/bunker.mjs
//
// CLI front-end for NIP-46 bunker announcements. Publishes a kind:24133
// event so clients (and the ride-along observer in ride-along.mjs) can
// discover the agent's remote signer.
//
// Usage:
//   coreprt-agent bunker <name> announce \
//     [--methods <comma-list>] \
//     [--relay <wss-url>] \
//     [--transport ws|tor|nostrconnect] \
//     [--secret <string>]
//
// `--relay` may be repeated. The first one is also what the connection
// token (printed at the end) uses by default.
//
// `--secret` is optional. If supplied it is included in the connection
// token so a client can verify the bunker (anti-spoofing per NIP-46).
//
// Examples:
//   coreprt-agent bunker bumble announce --relay wss://coreprt.webrnds.com
//   coreprt-agent bunker fizz announce \
//     --relay wss://coreprt.webrnds.com --relay wss://relay.damus.io \
//     --transport ws \
//     --methods 'sign_event:1,nip44_encrypt,nip44_decrypt'
//
// The one-shot reads AGENT_RELAY_URL / BUZZ_RELAY_HOST from the per-agent
// env file (sourced by `coreprt-agent`). It does NOT touch AGENT_BUNKER_URL
// — that's the runtime's read-only handle to the same bunker this command
// just announced.

import { finalizeEvent, getKeypairFromHex } from "../nostr.mjs";
import { runWithRelay } from "../writer.mjs";
import {
  buildBunkerAnnouncementTemplate,
  buildBunkerUrl,
  DEFAULT_METHODS,
  KIND_BUNKER_ANNOUNCEMENT,
  parseMethodList,
} from "../bunker.mjs";

const HELP = `Usage: coreprt-agent bunker <name> announce [options]

Publish a NIP-46 kind:24133 bunker announcement for the named agent.

Options:
  --methods <list>     Comma-separated method[:kind] list. Default:
                       sign_event:0,sign_event:1,sign_event:9,sign_event:22242,
                       sign_event:24133,nip44_encrypt,nip44_decrypt
  --relay <wss-url>    Relay URL. May be repeated. At least one required.
  --transport <type>   Transport tag (ws | tor | nostrconnect). Default: ws.
  --secret <string>    Optional shared secret; embedded into the printed
                       connection token (anti-spoofing).
  -h, --help           Show this help

Outputs the published event id and a ready-to-paste bunker connection token.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  const action = args.shift();
  const flags = { relays: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--methods") flags.methods = args[++i];
    else if (arg === "--relay") flags.relays.push(args[++i]);
    else if (arg === "--transport") flags.transport = args[++i];
    else if (arg === "--secret") flags.secret = args[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, action, flags };
}

export async function announce({ name, nsec, log = console.log, flags }) {
  if (!name) throw new Error("agent name is required");
  if (!nsec) throw new Error("NSEC env var is required");
  const keypair = getKeypairFromHex(nsec);
  const methods = flags.methods ? parseMethodList(flags.methods) : DEFAULT_METHODS;
  const transport = flags.transport ?? "ws";
  const relays = flags.relays ?? [];
  if (relays.length === 0) {
    throw new Error("--relay is required (pass at least one wss:// URL)");
  }
  const template = buildBunkerAnnouncementTemplate({
    agentName: name,
    pubkeyHex: keypair.pkHex,
    methods,
    transport,
    relays,
  });
  const event = finalizeEvent(template, keypair.skBytes);
  log(`[bunker] publishing kind:${KIND_BUNKER_ANNOUNCEMENT} d=${template.tags[0][1]} to ${relays[0]}`);
  const result = await runWithRelay(
    {
      nsec,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    (session) => session.publish(event),
  );
  if (!result.ok) {
    throw new Error(`relay rejected announcement: ${result.reason ?? "unknown"}`);
  }
  const token = buildBunkerUrl({
    remoteSignerPubkey: keypair.pkHex,
    relays,
    secret: flags.secret ?? null,
  });
  return { event, token, methods, transport, relays };
}

async function main() {
  const { name, action, flags } = parseArgs(process.argv);
  if (flags.help || !name || !action || action !== "announce") {
    console.log(HELP);
    if (!flags.help) process.exit(64);
    return;
  }
  const nsec = process.env.NSEC;
  if (!nsec) {
    console.error("NSEC not set in environment (run via coreprt-agent to source agent env)");
    process.exit(78);
  }
  try {
    const { event, token } = await announce({ name, nsec, log: console.log, flags });
    console.log(`bunker event id: ${event.id}`);
    console.log(`bunker token:    ${token}`);
  } catch (err) {
    console.error(`bunker announce failed: ${err.message}`);
    process.exit(1);
  }
}

// `coreprt-agent` runs us via `node <this-file> <name> [action] [flags...]`,
// so the second positional arg is the agent name and the third is the
// action. argv[2] is the first flag (since coreprt-agent sets `AGENT_NAME`
// and `AGENT_RELAY_URL` via env instead of args).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`bunker: unexpected error: ${err.message}`);
    process.exit(1);
  });
}
