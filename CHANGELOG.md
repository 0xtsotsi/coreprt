# Changelog

## [Unreleased]

## 2026-08-02 — MCP round-trip diagnostic + dev launcher

- `docs/2026-08-02-mcp-diagnostic.md`: full trace of the five stacked bugs that caused `mcp__buzz__buzz_post_message` to return `invalid_format` on every call during a session. **Production was not polluted** — every call died at `createServer()` before signing or contacting the relay. The fix lives in `~/.gg/mcp.json` (operator-managed), not in any repo. CLAUDE.md updated with the "MCP error almost never a parameter bug" rail.
- `scripts/start-buzz-desktop-local.sh`: dev-only launcher that sets `BUZZ_RELAY_URL=ws://127.0.0.1:3300` and clears stale `defaults` keys. Annotated in CLAUDE.md as not-for-production; the main instance remains `wss://coreprt.webrnds.com`.
- Removed stray `scripts/patch-test-name.py` and `scripts/pr-{7,8,9,10}-body.md` — they belong in `~/Documents/projects/buzz-mcp/`, not in this ops repo.

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

