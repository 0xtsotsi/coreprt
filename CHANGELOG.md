# Changelog

## [Unreleased]

## 2026-08-04 — Writer foundation + 3 operator one-shots (digest, invite, search)

Merged PRs #5 + #6 (fast-forward). Supersedes the now-closed PR #5
(foundation) — its content is part of this release.

- **`agents/_lib/writer.mjs`** (~230 LOC): the single publish/subscribe
  surface for every agent one-shot. `runWithRelay({ nsec, relayUrl, host,
  log }, run)` opens a WS, performs the NIP-42 AUTH handshake
  (kinds 22242 with `["relay", "wss://<host>"]`), waits for OK on the
  AUTH event before running the caller's body, then closes cleanly.
  Per-feature one-shots never reimplement NIP-42, reconnect, or EOSE
  plumbing. To remove the writer: delete the file, the one-shots that
  import it, and the `publish|req|search|digest|invite` cases in
  `coreprt-agent.sh`. Nothing else breaks.
- **`coreprt-agent publish <name> --kind <k> --content <text> --tag k=v …`**
  signs a kind in-process so the echoed id matches the published id,
  prints `nostr:<id>` after relay OK. Exits 78 on misuse, 1 on
  rejection, 2 on connection failure.
- **`coreprt-agent req <name> --kind <k> [--tag k=v] [--search q] [--limit n]`**
  prints JSONL events + a trailing `{ "eose": true, count: N }` line.
  Full NIP-50 + REQ filter surface (kinds, #tags, since/until, authors, ids).
- **Feature 1 — daily digest (`agents/_lib/one-shot/digest.mjs`)**:
  `coreprt-agent digest bumble [--since <hours>]` fetches the prior
  window of `#general`, strips the agent's own messages, asks the agent's
  runtime (default codex-minimax / MiniMax-M3) for a ≤480-char recap,
  publishes as kind 9 with up to 3 inline `nostr:` deep links. Scheduled
  at 09:00 local via `CorePrt-deploy/com.gogetta.coreprt.bumble-digest.plist`
  (`StartCalendarInterval Hour=9 Minute=0`). Removes the feature by
  deleting the script + the plist.
- **Feature 2 — invite-by-link (`agents/_lib/one-shot/invite.mjs`)**:
  `coreprt-agent invite <name> --ttl 24h [--code-len 12]` mints a
  base64url code (~72 bits of entropy), publishes a NIP-29 kind 9021
  with NIP-40 expiration, `pbcopy`s the code, writes it to
  `~/.config/coreprt/last-invite.txt` (mode 600).
- **Feature 3 — searchable archive (`agents/_lib/one-shot/search.mjs`)**:
  `coreprt-agent search <name> "<query>" --channel <uuid>` issues
  NIP-50 search. If the relay returns 0 hits (no fast FTS index on
  `coreprt-relay-1`), falls back to a wider REQ + client-side substring
  filter. Verified on the deployed relay 2026-08-04: NIP-50 returned 0
  for "coreprt"; the fallback re-fetched 3 events, filtered to 0. Output:
  one line per match, `nostr:<id>` deep links.
- **`coreprt-agent.sh` gains `publish|req|search|digest|invite`** as named
  subcommands. Each sources the agent env, syncs the runtime, and `exec`s
  Node against the matching `agents/_lib/one-shot/<name>.mjs`.
- **No changes** to `runtime.mjs`, `nostr.mjs`, `relay-client.mjs`,
  the daemon LaunchAgents, the relay image, or `package.json`.
- **No kind numbers in shared code.** The writer accepts `--kind` from
  the operator; each one-shot has the kind number it cares about as a
  single constant in its own file. Renumbering is a 1-file edit.

## 2026-08-03 — Access app recreate + WARP-required fallback for MCP

- Recreated the Cloudflare Access app from scratch: new app id `974e7f0c-8027-4183-a66d-394847b4ddd9` (aud `55c81dfc…`); old `c3f1f0da-…` / `75f368ec…` deleted.
- **Service-token path is permanently retired on this account.** Verified via the 2026-08-03 recreate test: a fresh app + fresh token still gets 403 at the edge (`docs/2026-08-03-access-recreate.md`). Account-level, not app-level.
- New 3-policy layout: `mcp-warp-required` (prec 1, email + WARP integration), `owner-trusted-mac` (prec 2, email + WARP + 3 posture checks), `owner-anywhere` (prec 3, email + NL geo + 6h session).
- **WARP is now MANDATORY for both the operator and the MCP host.** Operator's daily-driver Mac and any MCP host must enroll Cloudflare One Client and add `coreprt.webrnds.com` to WARP split-tunnel Include. Runbook: `docs/2026-07-30-operator-runbook.md` Steps 1 and 4.
- `docs/access-policy.md` rewritten to be the live source of truth (3 policies, new app id, WARP-only headless auth).
- Historical docs (`2026-07-30-access-api-probe.md`, `2026-07-30-access-post-zero-trust.md`, `2026-07-30-final-policy-and-warp-pending.md`, `2026-07-30-live-state-snapshot.md`, `2026-07-30-service-token-api-quirks.md`, `2026-07-30-operator-runbook.md`) marked **SUPERSEDED 2026-08-03** with a `<details>` wrapper preserving the historical content.
- `CLAUDE.md` gotchas updated: service-token gotcha is now "structurally broken, do not retry"; new gotcha "WARP is the only headless auth path"; new gotcha for the current app id/audience; compromised-`cfat_…` gotcha now references the staging rebuild.
- `scripts/snapshot-access.py` + `scripts/recreate-access-app.py` + `scripts/mcp-warp-fallback.py` are the new ops toolset. Re-runnable for the post-`CF_API_TOKEN`-rotation clean-cut rebuild.
- `docs/2026-08-02-mcp-diagnostic.md` bug 5 changed from "operator not on allowlist" to "MCP host not WARP-enrolled". Repair plan reordered: WARP enrollment is the new edge-layer blocker.
- **Staging only.** The 2026-08-03 rebuild was performed under the same (compromised) `CF_API_TOKEN`. The new app id/audience are still bound to compromised auth. Operator MUST rotate `CF_API_TOKEN` in the Cloudflare dashboard and re-run the rebuild scripts for a production-clean state.

## 2026-08-02 — MCP round-trip diagnostic + dev launcher

- `docs/2026-08-02-mcp-diagnostic.md`: full trace of the five stacked bugs that caused `mcp__buzz__buzz_post_message` to return `invalid_format` on every call during a session. **Production was not polluted** — every call died at `createServer()` before signing or contacting the relay. The fix lives in `~/.gg/mcp.json` (operator-managed), not in any repo. CLAUDE.md updated with the "MCP error almost never a parameter bug" rail.
- `scripts/start-buzz-desktop-local.sh`: dev-only launcher that sets `BUZZ_RELAY_URL=ws://127.0.0.1:3300` and clears stale `defaults` keys. Annotated in CLAUDE.md as not-for-production; the main instance remains `wss://coreprt.webrnds.com`.
- Removed stray `scripts/patch-test-name.py` and `scripts/pr-{7,8,9,10}-body.md` — they belong in `~/Documents/projects/buzz-mcp/`, not in this ops repo.

## 2026-08-05 — Buzz desktop launcher: public-by-default

- `scripts/start-buzz-desktop-local.sh`: behavior flipped. Default now launches the desktop app against `wss://coreprt.webrnds.com` (the public Cloudflare Tunnel, reachable from any network with a WARP-enrolled host). `--local` / `-l` forces `ws://127.0.0.1:3300` for tunnel-down scenarios. Added `--public`, `--relay-url`, `--help` flags and a `BUZZ_DESKTOP_LAUNCHER` env var for testability. Rationale: the operator needs the same context (channels, agents, history) on the host Mac AND remote, with no manual switching.
- Added `scripts/test-start-buzz-desktop.sh` covering all flag/env combinations (15 cases, all passing): `bash -n` syntax, default → public, `--local` → loopback, `--relay-url` override, `BUZZ_HTTP_PORT` honored only on `--local`, unknown flags fall through to the launcher binary, `--help` is non-executing, trailing args forwarded, pre-flight warning suppressed on reachable URL, pre-flight warning fires on connection-refused URL, `--local` skips the pre-flight entirely.
- Fix: pre-flight warning logic in the launcher used `if ! curl ... >/dev/null 2>&1` which discarded the `-w '%{http_code}'` output and caused the warning to fire unconditionally in public mode. Now captures the status code, probes both `wss:///_liveness` and the `https://` root, and only warns when both return non-200.
- `scripts/README.md` now lists every script with its purpose, including the launcher's new public-by-default behavior.

## 2026-07-31 — @buzz/mcp rollout (v0.1.0)

- Six `gogetta/buzz-mcp` PRs merged into `https://github.com/0xtsotsi/buzz-mcp` (default branch `main`) (commits `5b78eb9` → `6e9526e`). 16 MCP tools, 9 event builders, BIP-340 signer, NIP-98 HTTP, NIP-42 WS, 93 tests, operator docs.
- Re-create the `service-token-buzz-mcp` policy in Cloudflare Access after the 2026-07-30 retirement. New service token `buzz-mcp-prod` is live; client_id + client_secret in `~/.config/coreprt/buzz-mcp.env` (chmod 600).
- Per-agent Nostr keypair minting is operator-only (CLAUDE.md safety rail: `buzz-admin generate-key` redaction). Agent-side onboarding cannot run end-to-end until the operator pastes `BUZZ_PRIVATE_KEY` into the host env file. The CorePrt docs are now in place for that step.
- Correct the spec's `gogetta/buzz-mcp` namespace to `0xtsotsi/buzz-mcp` across all CorePrt docs. The npm package name remains `@buzz/mcp` (unaffected).
- `scripts/probe-edge.sh` is the operational tool that verifies the CF Access edge admits the service token. Keep it.
- Operator playbook: `~/.gg/mcp.json` block for the `buzz` server is in `https://github.com/0xtsotsi/buzz-mcp/blob/main/docs/mcp-config.example.json` (Track A for dev, Track B for prod). The block is gated on the operator's per-agent `BUZZ_PRIVATE_KEY`.

## 2026-07-30 — CorePrt Access and tunnel bring-up

- Pin cloudflared to HTTP/2 while WARP blocks QUIC on UDP/7844 (`CorePrt-cloudflare/tunnel.yml`).
- Track `com.gogetta.coreprt.cloudflared` LaunchAgent reference (`CorePrt-cloudflare/com.gogetta.coreprt.cloudflared.plist`); deployed copy lives in `~/Library/LaunchAgents/`.
- Reconcile Access policies to two: `owner-trusted-mac` (enrolled device with all 4 device_posture checks) and `owner-anywhere` (email + OTP). Service-token policy and all service tokens retired.
- Tighten `Cf-Access-Jwt-Assertion` verification plan: RS256, expected issuer, exp/nbf/iat checks, fail-closed 403.
- Document service-token API surface: hyphen route returns 404; underscored `/accounts/{id}/access/service_tokens` reachable for create/list/read/rotate/delete but its secrets are rejected at the edge on this account.
- Operator playbook no longer asks for credentials in chat; secrets stay in `~/.config/coreprt/buzz-mcp.env`.
- Mark the three-policy state historical and the two-policy state authoritative across all docs.
- Align RELAY_OWNER_PUBKEY instructions to hex encoding; align tunnel identity across `tunnel.yml` and README.md.
- Fix CHANGE_ME regex portability (`[[:space:]]*$`), spelling (`Filewall` → `Firewall`), and host-specific plist documentation.
- P3 gate preserved before D4 agent onboarding: prove owner path with a `#general` post and `+` reaction, then per-agent keypair + `--role member`.

