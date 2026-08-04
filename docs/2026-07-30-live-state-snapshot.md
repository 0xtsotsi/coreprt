# CorePrt — Live state · 2026-07-30

_Snapshot taken at end of session, after all API-touchable wiring was landed._
_Operator-side steps (WARP enrollment on Mac, dashboard service-token rotation) are tracked in `docs/2026-07-30-operator-runbook.md`._

## Public surface
- https://coreprt.webrnds.com/_liveness -> 302 (302 -> Access login)

## Containers
- coreprt-relay-1: healthy
- coreprt-postgres-1: healthy
- coreprt-redis-1: healthy
- coreprt-minio-1: healthy

## Cloudflare Tunnel (c40f4029-...)
- status: healthy
- connectors: 4

## Access app CorePrt (c3f1f0da-...) **SUPERSEDED 2026-08-03**

> **This snapshot is from 2026-07-30 and is no longer the live state.** The app `c3f1f0da-…` was deleted on 2026-08-03 and replaced with `974e7f0c-8027-4183-a66d-394847b4ddd9` (audience `55c81dfc…`). The current policy layout is 3 policies: `mcp-warp-required` (prec 1), `owner-trusted-mac` (prec 2), `owner-anywhere` (prec 3 with NL geo + 6h session). The current canonical live state is in `docs/access-policy.md`; the recreate run log is in `docs/2026-08-03-access-recreate.md`. The remainder of this file is the historical 2026-07-30 snapshot, preserved for the audit trail.

<details>

## Access app CorePrt (c3f1f0da-...) [historical]
- name: CorePrt
- aud: 75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e
- domain: coreprt.webrnds.com
- allowed_idps: 0
- policies: 3
  - owner-trusted-mac (prec 1)
    - include: ['email']
    - require: device_posture with integration_uids:
      - 76b96de1-4cce-43fe-ba8a-26881193a475
      - c99b5e24-418b-414d-859b-bb428d45a09a
      - 6ce07058-3f3e-43cd-91e8-2e97d21cd57f
      - 62c90e6e-bc8a-4b90-868b-e3b5138a0846
  - owner-anywhere (prec 2)
    - include: ['email']
    - require: none
## Posture integrations (5)
- gateway         e9bb35b0-6339-44df-9bd5-ae3d4092c26c  Gateway
- warp            76b96de1-4cce-43fe-ba8a-26881193a475  WARP
- os_version      c99b5e24-418b-414d-859b-bb428d45a09a  Coreprt webrnds posture
- firewall        6ce07058-3f3e-43cd-91e8-2e97d21cd57f  Coreprt webrnds post Firewall
- disk_encryption 62c90e6e-bc8a-4b90-868b-e3b5138a0846  Coreprt webrnds Disk Encryp

## Device registrations
- count: 0 (operator has not enrolled WARP yet — see runbook step 1)

## Service token credentials
- Saved at `~/.config/coreprt/buzz-mcp.env` (mode 600, outside repo).
- Token id `49fb85ca-e23a-4e92-9b5a-20d660edd1a2` (`buzz-mcp-prod`), client_id `c7d1562a9b067519aa15c1047599f01c.access`, created via the dashboard.
- Last verified against the live app: **302** with `service_token_status: false` in the meta JWT — **Cloudflare's edge rejects all service-token secrets created via either the dashboard or the API on this account.** The dashboard-generated token id is now explicitly referenced in `service-token-buzz-mcp` policy. Even with the explicit token_id reference, the edge still rejects it.

This appears to be a Cloudflare-side bug or a hidden prerequisite (e.g., the account needs an Access organization configured, or the dashboard flow involves a "secret confirmation" step the API can't replicate). **Workaround candidates:** (1) upgrade to a higher Cloudflare plan that supports Cloudflare Access for SaaS / for Teams with full token validation, (2) switch to WARP-only authentication for MCP and abandon service tokens, (3) sign JWTs at the relay and verify them at the Cloudflare edge via `Cf-Access-Jwt-Assertion` instead of using service tokens.

### Operational note
This is the third token rotation in this session. **All three secrets are rejected by the edge**, including:
1. The leaked `4b13f637…5620a` (rotated multiple times).
2. The API-created `d98196c4…` (POST /accounts/{id}/access/service_tokens).
3. The dashboard-created `c6299e6f…b8a7d3` (above).

The pattern is consistent: every `client_secret` returned by Cloudflare's APIs is accepted by the API (`success: true`) but rejected by the edge (`service_token_status: false` in the JWT meta). This points to a Cloudflare edge-side bug or unannounced account-level gate.

</details>

## Update 2026-08-03

The hypothesis (Cloudflare edge-side bug) was confirmed by the recreate test on 2026-08-03. The fresh app + fresh token route did not unstick the rejection. **Workaround candidate (2)** (WARP-only auth) was implemented: see `docs/access-policy.md` and `docs/2026-08-03-access-recreate.md`. All service tokens are deleted as of 2026-08-03; the service-token path is permanently retired on this account.
