# MCP buzz_post_message diagnostic — 2026-08-02

## TL;DR

`mcp__buzz__buzz_post_message` (and `buzz_subscribe`) returned a Zod
`invalid_format` error on every call during a 2026-08-02 session. **The relay
was never contacted.** The MCP server was failing at startup because
`BUZZ_PRIVATE_KEY` was not loaded into the spawned Node.js process, and the SDK
wraps startup errors as tool-result errors with a misleading
`replyTo / 64-char hex` validation message.

**Production state was not polluted.** No signed event was emitted by the
session — every call died at `createServer()` before reaching
`buildMessage()`.

## Five stacked configuration bugs (none in this repo)

| # | Bug | Location | Fix |
|---|---|---|---|
| 1 | `~/.gg/mcp.json` invokes `dotenv-cli` **without** `-e <path>` | `~/.gg/mcp.json` | Add `-e /Users/gogetta/.config/coreprt/buzz-mcp.env` between `dotenv-cli` and `--` |
| 2 | `/tmp/dotenv-run` was missing, so `npx --prefix /tmp/dotenv-run dotenv-cli` resolves nothing | Filesystem | `mkdir -p /tmp/dotenv-run && npm install --prefix /tmp/dotenv-run dotenv-cli` (now done) |
| 3 | `BUZZ_RELAY_URL` is **not** in `~/.config/coreprt/buzz-mcp.env`. The MCP config's `env.BUZZ_RELAY_URL` is fine, but if anything in the env-file ever overrides it, the relay URL falls back to `DEFAULT_RELAY_URL` (the local default in `buzz-mcp/dist/index.js`) | `~/.config/coreprt/buzz-mcp.env` | Either add `BUZZ_RELAY_URL=https://coreprt.webrnds.com` to the env file, OR trust the mcp.json `env` block (it should win because dotenv-cli does not override by default) |
| 4 | `["subject", …]` wire-shape bug in `buildMessage` and `buildReaction` (relay expects `["h", <uuid>]`) | `~/Documents/projects/buzz-mcp/src/relay/event-builder.ts:187,230` | One-line rename. Will surface as `400 invalid: channel-scoped events must include an h tag` once bugs 1–3 are fixed |
| 5 | MCP host is not enrolled in Cloudflare WARP. Without WARP, neither the operator nor the MCP can reach the relay (the only working headless auth path on this account is WARP-required include; see `docs/access-policy.md` Policy A1 and `docs/2026-08-03-access-recreate.md`). | MCP host machine | Install Cloudflare One Client, enroll with the team enrollment token, set mode to WARP, add `coreprt.webrnds.com` to split-tunnel Include, connect. |

Bugs 1–3 are configuration bugs. Bug 4 is a known source-code defect (documented in the wire-shape analysis on 2026-08-01; not fixed yet). Bug 5 is operator-side onboarding (CLAUDE.md rail: agent onboarding is gated on the human path being live).


## Verification trace from the diagnostic

```
$ grep -c BUZZ_RELAY_URL ~/.config/coreprt/buzz-mcp.env
0

$ /tmp/dotenv-run/node_modules/.bin/dotenv -- node dist/cli.js < /dev/null
@buzz/mcp: fatal error during startup: Error: BUZZ_PRIVATE_KEY is not set.
    at createServer (file:///.../buzz-mcp/dist/index.js:99:15)

$ /tmp/dotenv-run/node_modules/.bin/dotenv -e ~/.config/coreprt/buzz-mcp.env \
    -- node -e 'console.log(process.env.BUZZ_PRIVATE_KEY.length)'
64
```

The first form (what `~/.gg/mcp.json` invokes) silently no-ops. The second
form (the correct form) loads the 64-char hex key into the spawned process.

## What the relay would have done if the MCP had reached it

Per the four-stacked-blocker analysis done on 2026-08-01 (also captured in
durable memory):

- `signedFetch` only checks `status < 300`. CF Access returns 302 to a login
  page; the tool would have reported `accepted: true` against garbage HTML.
- `event-builder.ts:187` emits `["subject", …]`; the relay requires
  `["h", <uuid>]` for kind:9 events. Error path:
  `400 invalid: channel-scoped events must include an h tag`.
- Operator pubkey `507c4dd1…` is not a community member, so
  `relay_requires_membership` would reject the event at the kind:9007
  admission layer.
- The `CF_ACCESS_*` env vars in `buzz-mcp.env` are leftover docker/tunnel
  JWT material, not valid Cloudflare Access service tokens — they would be
  rejected at the edge regardless of which path the request takes.

## Repair plan (in dependency order)

1. Patch `~/.gg/mcp.json` — add `-e` flag (operator-only; not in this repo).
2. Confirm `/tmp/dotenv-run` exists with `dotenv-cli` installed.
3. Optionally add `BUZZ_RELAY_URL=https://coreprt.webrnds.com` to the env
   file for redundancy.
4. Patch `event-builder.ts` wire shape (`["subject", …]` → `["h", <uuid>]`).
5. Operator runs `docker exec coreprt-relay-1 buzz-admin add-member <hex>`.
6. After 1–5, the `mcp__buzz__buzz_post_message` round-trip is real and
   observable.

Steps 1–3 fix the immediate "MCP calls return invalid_format" symptom.
Steps 4–5 unlock actual production writes.

## Lesson — apply to every MCP server in this stack

The combination `npx --prefix <writable-tmp-dir> dotenv-cli -- <cmd>` is
fragile: it relies on the directory persisting across sessions, and it
silently no-ops if dotenv-cli can't find a `.env` in the cwd. Prefer
explicit `-e /full/path/to/.env` in MCP `args`, or use a wrapper script
that `source`s the env file before exec'ing the server.

## Affected files outside this repo

- `~/.gg/mcp.json` — operator-managed, not in any repo
- `~/.config/coreprt/buzz-mcp.env` — operator-managed, mode 600
- `~/Documents/projects/buzz-mcp/src/relay/event-builder.ts:187,230` —
  fix lives upstream at `https://github.com/0xtsotsi/buzz-mcp`
- `coreprt-relay-1` member table — operator command, see repair step 5

## Production state after this diagnostic

No changes to `coreprt.webrnds.com`. No new events. No membership churn. The
relay container (`coreprt-relay-1`) and the cloudflared LaunchAgent
(`com.gogetta.cloudflared-coreprt`) are untouched. Only state changed is
local to this Mac: `/tmp/dotenv-run/` now exists with `dotenv-cli@latest`
installed, which is harmless if the operator removes it.
---

## Update 2026-08-03

Bug 5 has changed. The original "operator not on relay allowlist" bug is still valid (the MCP pubkey still needs to be added to the community allowlist), but the **edge-layer blocker is now WARP enrollment**, not service-token configuration. With the service-token path retired on this account (`docs/2026-08-03-access-recreate.md` and `docs/2026-07-30-service-token-api-quirks.md`), the `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` env vars in `~/.config/coreprt/buzz-mcp.env` are no longer needed — the MCP server can keep them in the env file (harmless) but should remove them in a follow-up cleanup once the WARP path is confirmed working.

The current repair plan (in dependency order) is:

1. **Enroll the MCP host in Cloudflare WARP** (the new blocker; the operator's own Mac also needs this). See `docs/2026-07-30-operator-runbook.md` Steps 1 and 4.
2. Patch `~/.gg/mcp.json` — add `-e` flag (operator-only; not in this repo).
3. Confirm `/tmp/dotenv-run` exists with `dotenv-cli` installed.
4. Optionally add `BUZZ_RELAY_URL=https://coreprt.webrnds.com` to the env file for redundancy.
5. Patch `event-builder.ts` wire shape (`["subject", …]` → `["h", <uuid>]`).
6. Operator runs `docker exec coreprt-relay-1 buzz-admin add-member <mcp-hex>`.
7. After 1–6, the `mcp__buzz__buzz_post_message` round-trip is real and observable.
