// agents/_lib/one-shot/invite.mjs
//
// NIP-29 invite-by-link. Operator-facing command:
//   coreprt-agent invite <name> --ttl <hours> [--code-len <n>]
//
// Generates a base64url code, builds a kind 9021 event with
// ["h", channelId], ["code", <code>], ["expiration", <iso>],
// publishes via the writer, copies to the macOS clipboard via pbcopy,
// writes the code to ~/.config/coreprt/last-invite.txt (mode 600).
//
// Removes a feature: rm this file. No other code changes.

import { randomBytes } from "node:crypto";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { getKeypairFromHex, finalizeEvent } from "../nostr.mjs";
import { runWithRelay } from "../writer.mjs";

function parseArgs(argv) {
  const args = argv.slice(2);
  const name = args.shift();
  if (!name) throw new Error("usage: invite <name> --ttl <hours> [--code-len n]");
  const flags = { ttlHours: 24, codeLen: 12, channel: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--ttl") flags.ttlHours = Number.parseFloat(args[++i]);
    else if (arg === "--code-len") flags.codeLen = Number.parseInt(args[++i], 10);
    else if (arg === "--channel") flags.channel = args[++i];
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return { name, flags };
}

const HELP = `Usage: coreprt-agent invite <name> [options]

Mints a one-time invite code, publishes a NIP-29 kind 9021 event with
that code, copies the code to the macOS clipboard, and writes the code
to ~/.config/coreprt/last-invite.txt (mode 600).

Options:
  --ttl <hours>     Code lifetime, encoded as NIP-40 expiration tag (default 24)
  --code-len <n>    Code length in chars (default 12)
  --channel <uuid>  Override channel UUID
  -h, --help        Show this help
`;

function randomCode(len) {
  // base64url, ~6 bits per char. Default 12 chars = ~72 bits of entropy.
  const bytes = Math.ceil((len * 6) / 8) + 2;
  return randomBytes(bytes)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, len);
}

function pbcopy(text) {
  return new Promise((resolve) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
    child.once("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `pbcopy exited ${code}` });
    });
    child.stdin.end(text);
  });
}

async function main() {
  const { name, flags } = parseArgs(process.argv);
  if (flags.help || !name) {
    process.stdout.write(HELP);
    process.exit(name ? 0 : 78);
  }

  const log = (...args) => console.log(`[${name}] [invite]`, ...args);
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
  if (!Number.isInteger(flags.codeLen) || flags.codeLen < 6 || flags.codeLen > 64) {
    process.stderr.write("error: --code-len must be an integer between 6 and 64\n");
    process.exit(78);
  }
  if (!(flags.ttlHours > 0)) {
    process.stderr.write("error: --ttl must be > 0 hours\n");
    process.exit(78);
  }

  const keypair = getKeypairFromHex(nsec);
  const code = randomCode(flags.codeLen);
  const expiration = new Date(Date.now() + flags.ttlHours * 3600 * 1000).toISOString();
  log(`code=${code} expiration=${expiration}`);

  const event = finalizeEvent(
    {
      kind: 9021,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", channelId],
        ["code", code],
        ["expiration", expiration],
      ],
      content: "operator invite",
    },
    keypair.skBytes
  );
  log(`publishing kind:9021 id:${event.id}`);
  const published = await runWithRelay(
    {
      nsec,
      relayUrl: process.env.AGENT_RELAY_URL,
      host: process.env.BUZZ_RELAY_HOST,
      log,
    },
    (session) => session.publish(event)
  );
  if (published.ok !== true) {
    process.stderr.write(`rejected: ${published.reason || "unknown reason"}\n`);
    process.exit(1);
  }
  process.stdout.write(`code=${code}\n`);
  process.stdout.write(`nostr:${event.id}\n`);
  process.stdout.write(`expiration=${expiration}\n`);

  const clip = await pbcopy(code);
  if (clip.ok) log("code copied to clipboard (pbcopy)");
  else log(`clipboard skipped: ${clip.error}`);

  const lastInviteDir = `${process.env.HOME}/.config/coreprt`;
  await mkdir(lastInviteDir, { recursive: true, mode: 0o700 });
  const lastInvitePath = `${lastInviteDir}/last-invite.txt`;
  await writeFile(lastInvitePath, `${code} (kind 9021 id ${event.id} expiration ${expiration})\n`, { mode: 0o600 });
  await chmod(lastInvitePath, 0o600);
  log(`code written to ${lastInvitePath}`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n`);
  process.exit(2);
});
