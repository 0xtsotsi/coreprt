# Changelog

## [Unreleased]
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

