# CorePrt — Final policy layout · 2026-07-30

**Operator decided:** keep Policy A (WARP + posture) and Policy B (email only). **Delete Policy C** (service-token-buzz-mcp). Service tokens are unreachable at the edge on this account.

## Policy layout (live now)

| Policy | Precedence | Include | Require |
|---|---|---|---|
| `owner-trusted-mac` | 1 | `email = gogetta` | WARP integration `76b96de1-…` + OS version `c99b5e24-…` + Firewall `6ce07058-…` + Disk encryption `62c90e6e-…` |
| `owner-anywhere` | 2 | `email = gogetta` | *(none)* |

## MCP auth: deferred

Operator chose to defer MCP configuration. Plan when ready:

1. Install Cloudflare One Client on the MCP host.
2. Get team enrollment token from the dashboard.
3. Replace the deleted `service-token-buzz-mcp` policy with a WARP-required include.
4. Each MCP host enrolls independently with its own posture.

Until MCP is configured, MCP callers cannot reach `coreprt.webrnds.com` (no service-token auth, no WARP). Operator retains full access via:

- **Policy A** — enrolled device with WARP connected and all 4 device_posture checks passing (WARP integration, OS version, Firewall, Disk encryption). The user's email must match `gogetta`. Access is granted by the WARP-issued device certificate + posture attestation, **not** by a standard IdP session. No OTP is involved on Policy A.
- **Policy B** — anywhere with email=gogetta + Cloudflare OTP (phone, browser, travel laptop). Policy B still requires an interactive IdP session.

## Service tokens

All service tokens deleted (count: 0). The service-token API endpoint at `/accounts/{id}/access/service_tokens` returns valid-looking credentials but Cloudflare's edge rejects them on this account (`service_token_status: false`). Documented in `docs/2026-07-30-service-token-api-quirks.md`.

## Next operator actions (when back from AFK)

1. Open https://one.dash.cloudflare.com/?to=/:account/team/devices and generate a team enrollment token.
2. Install Cloudflare One Client on this Mac.
3. Paste the token, set mode to WARP, connect.
4. Ping me to verify the device registered and the public surface returns 200.

## Files

- `docs/2026-07-30-access-api-probe.md` — Access API probe history
- `docs/2026-07-30-access-post-zero-trust.md` — Zero Trust activation summary
- `docs/2026-07-30-posture-checks-landed.md` — Posture checks wired up
- `docs/2026-07-30-operator-runbook.md` — 5-step operator playbook
- `docs/2026-07-30-live-state-snapshot.md` — current live state snapshot
- `docs/2026-07-30-end-of-session.md` — no-change-round note
- `docs/2026-07-30-service-token-api-quirks.md` — underscore vs hyphen namespace, edge rejection pattern
- `docs/2026-07-30-final-policy-and-warp-pending.md` — this file
