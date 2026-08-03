# Changelog

## [Unreleased]

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

