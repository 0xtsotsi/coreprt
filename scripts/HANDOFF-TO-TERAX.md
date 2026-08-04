# Hand-off prompt for Terax agent

You are picking up a paused session on @buzz/mcp against `https://coreprt.webrnds.com`.
The operator has authorized you to act on their behalf. Your job: complete the
hello-world round-trip and report results.

---

## What is already done (do NOT redo)

1. **`~/.gg/mcp.json`** — args include `-e /Users/gogetta/.config/coreprt/buzz-mcp.env`
   between `dotenv-cli` and `--`. Verified 2026-08-02.
2. **`/tmp/dotenv-run/`** — `dotenv-cli@11.0.0` installed. `npx dotenv-cli` resolves.
3. **`src/relay/event-builder.ts:187`** — `["subject", ...]` → `["h", ...]` for
   `buildMessage` (kind:9). Docstring updated. **Dist rebuilt** via `npm run build`
   in `~/Documents/projects/buzz-mcp/`. `dist/relay/event-builder.js:63` now reads
   `["h", normalizeChannel(opts.channel)]`. Line 230 untouched (kind:1 forum-post
   subject line is semantically different from a channel identifier — do not rename).
4. **Operator membership** — operator pubkey `5430c42f1687cf77f71b960d07899596207199a16e056b0cd4ab5d9b1aae53b8`
   is already on the relay's community allowlist (added 2026-07-31; role=`member`).
   The other two members are owner `2868cb82892a6bb7782948469e9a4ac65bec2cd0e73a2364dfe95343d1f541b8`
   and member `8a529f5abcb2658cf1544d696081a6f22077eb6963d3a6f0bcc37c69195e2b02`.
   Verify with `docker exec coreprt-relay-1 buzz-admin list-members`.
5. **`~/.config/coreprt/buzz-mcp.env`** — unchanged. Mode 600. Contains
   `BUZZ_PRIVATE_KEY=<64-char hex>` (NOT `507c4dd1…` — that prefix is the secret,
   not the pubkey; the pubkey is `5430c42f…` derived via `getPublicKey(secret)`),
   `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `MINIMAX_API_KEY`. The
   `BUZZ_RELAY_URL` is set in `~/.gg/mcp.json`'s env block
   (`https://coreprt.webrnds.com`), not in the env file.

## What you need to do

**Goal: prove the MCP round-trips end-to-end against the public main instance.**

### Step 1 — Pre-flight (read-only, ~30s)

```bash
# Confirm the MCP server is running with the new dist
curl -s -m 3 -H 'Accept: application/nostr+json' -H 'Host: coreprt.webrnds.com' \
  https://coreprt.webrnds.com/ | python3 -m json.tool | head -20

# Confirm membership
docker exec coreprt-relay-1 buzz-admin list-members

# Confirm the tool surface — load the MCP tool list from the running session
# and verify `buzz_post_message` is present with the correct schema.
```

The NIP-11 response should include `supported_nips: [..., 29, ...]` and a
`push` block with `origin: wss://coreprt.webrnds.com`.

### Step 2 — Create a channel so there's something to post to

The relay's `channels` table is empty. **`buzz-admin` has no `create-channel`
or `list-channels` subcommand** (verified 2026-08-02 against
`docker exec coreprt-relay-1 buzz-admin --help`). The eight available
subcommands are: `add-member`, `remove-member`, `list-members`,
`generate-key`, `migrate`, `product-feedback`, `reconcile-channels`, `help`.
NIP-29 admin endpoints (`/admin/channels`,
`/.well-known/nostr/nip29/channels`) return empty.

Therefore channels **must** be created via a kind:9007 NIP-29 event signed
by an existing member and POSTed to the relay. The shape:

```json
{
  "kind": 9007,
  "tags": [
    ["h", "<channel-uuid-or-lowercase-name>"],
    ["name", "general"],
    ["about", "hello world smoke test"],
    ["picture", ""]
  ],
  "content": "",
  ...
}
```

Check `src/relay/event-builder.ts` for `buildCreateChannel`. If it exists,
wire it into a `buzz_create_channel` MCP tool (small follow-up; ~20 lines)
in `src/tools/channels.ts` + register in `src/index.ts`. If it doesn't
exist, build the event manually using `nostr-tools`:

```typescript
import { finalizeEvent, generateSecretKey } from "nostr-tools";
const sk = hexToBytes(process.env.BUZZ_PRIVATE_KEY);
const event = finalizeEvent({
  kind: 9007,
  tags: [["h", "general"], ["name", "general"]],
  content: "",
  created_at: Math.floor(Date.now() / 1000),
}, sk);
await fetch(`${process.env.BUZZ_RELAY_URL}/events`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Nostr ${btoa(JSON.stringify(event))}`,
  },
  body: JSON.stringify(event),
});
```

Either way, this requires the channel to be a lowercase *name* (e.g.
`general`) — the relay accepts name-form `h` tags as a fallback per the
new docstring at line 173 of `event-builder.ts`. UUIDs are preferred but
not required.

Verify the channel exists after this by sending a kind:9 message via the
MCP and reading it back via `buzz_subscribe` with a filter on the channel
name.

### Step 3 — Post a hello-world

```bash
# Use the MCP tool buzz_post_message
# channel: "general"
# content: "hello from mcp 🐦 — production-ready state probe (2026-08-02)"
# imeta: (optional, omit for first call)
```

The relay should accept (status 200, `event_id` returned). If it returns
`accepted: true` without an `event_id`, that's the same silent-failure pattern
the 2026-08-02 diagnostic found — re-check `signedFetch` and the actual
HTTP body.

### Step 4 — Verify the post round-tripped

```bash
# Use the MCP tool buzz_subscribe
# kinds: [9]
# #t: ["euc"]
# limit: 5
# then poll with buzz_poll
```

You should see your own event echoed back, with `h: ["general"]`,
`t: ["euc"]`, `client: ["buzz-mcp"]`.

### Step 5 — Cleanup

The hello-world message will stay on the public relay until manually deleted.
The operator is fine with this — they explicitly said "i will delete the
population myself if nbeccesary". Do not attempt to delete it.

## What to report back

A short structured report:

1. NIP-11 fingerprint from `https://coreprt.webrnds.com/` (just the
   `name`, `software`, `version`, `supported_nips`, length of the doc).
2. The `docker exec … list-members` output verbatim.
3. Whether Step 2's channel creation succeeded, and how.
4. The `event_id` returned from `buzz_post_message` (or the full error body
   if it didn't).
5. The full JSON of the event from `buzz_subscribe` + `buzz_poll`.
6. Anything unexpected — relay errors, schema mismatches, gating rejections.

## Hard rules (no exceptions)

- **Do NOT rotate any secrets.** The leaked credentials rails in CLAUDE.md
  (the `cfat_…` CF API token, R2 keys) are still in force.
- **Do NOT touch `~/.config/coreprt/buzz-mcp.env` mode** (must stay 600).
- **Do NOT post to a channel that doesn't exist.** Create it first.
- **Do NOT rename `subject` → `h` at line 230 of `event-builder.ts`.** That
  is a forum-post subject line (kind:1), not a channel identifier. If you
  find a reason to rename it, **stop and ask the operator first**.
- **Do NOT add `BUZZ_RELAY_URL` to the env file.** The mcp.json env block
  already sets it; the env file holds the private key; minimize writes.
- **Do NOT modify `~/.gg/mcp.json`.** It's already correct.
- **Do NOT rebuild `event-builder.ts` again.** The dist is already at 0.1.2
  with the fix. If you need to rebuild, that's a sign something else broke.

## Files you may need to read

- `~/Documents/projects/buzz-mcp/src/relay/event-builder.ts` — current
  builders (buildMessage at 167, buildForumPost at 222, buildCreateChannel
  may exist at 240+)
- `~/Documents/projects/buzz-mcp/dist/relay/event-builder.js` — what's running
- `~/Documents/projects/buzz-mcp/dist/tools/messages.js` — post-message tool
- `~/Documents/projects/buzz-mcp/dist/index.js` — createServer() at line 96
- `~/Documents/projects/CorePrt/CLAUDE.md` — operational rails
- `~/Documents/projects/CorePrt/docs/2026-08-02-mcp-diagnostic.md` — full
  trace of the 5-bug stack that was resolved before this hand-off
- `~/Documents/projects/CorePrt/docs/access-policy.md` — current Access policy
- `~/Documents/projects/CorePrt/CHANGELOG.md` — last entry is 2026-08-02

## Where to ask questions

If you hit a hard blocker (relay returns a rejection you can't classify;
`buildCreateChannel` doesn't exist and you can't see how to create the
channel; the kind:9 event is rejected with a new error you haven't seen
before), stop and write back exactly:
- The full error response (verbatim, JSON if available)
- The exact command you ran
- A one-line description of what you think the fix is
- Whether the fix is operator-only (env, membership, Access) or code
  (in `buzz-mcp/`)

The operator will decide. Don't guess on code changes — the rename at
line 187 was the only code change authorized and it's already applied.

## What "done" looks like

A `event_id` returned from `buzz_post_message`, the same `event_id` visible
in `buzz_subscribe` results, and a short report confirming the round-trip.
Not `accepted: true` alone — that's not proof of delivery.

Begin with Step 1.
