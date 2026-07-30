# CorePrt — Token recheck round · 2026-07-30

**Status: token rotation did not unlock any new API endpoints.**

After the operator reported another token update, I re-probed all endpoints. The same account-scoped API token remains in the gitignored `CorePrt-deploy/.env`, but the API behavior is identical to the previous round:

| Endpoint | Code | Same as last round? |
| --- | ---: | --- |
| `/accounts/{id}/access/apps` GET / POST / PUT | 200 | ✅ unchanged |
| `/accounts/{id}/access/policies` GET | 200 | ✅ unchanged |
| `/accounts/{id}/access/identity_providers` GET | 200 | ✅ unchanged |
| `/accounts/{id}/devices/posture` GET | 200 (2 integrations) | ✅ unchanged |
| `/zones/{id}/access/apps/{id}` PUT (with `device_posture.check`) | 200 (Cloudflare normalizes to integration_uid only) | ✅ unchanged |
| **`/accounts/{id}/access/service-tokens` (hyphen) GET / POST** | **404 code 10001** | ❌ hyphen route still 404 (use underscored route) |
| **`/accounts/{id}/tunnels/{id}/token` GET** | **404** | ❌ **still 404** |
| All posture-check sub-resources (`/devices/posture/checks`, etc.) | 404 | ❌ structurally absent |

I tried every namespace variant for service tokens (15+ URL paths) and tunnel credentials (4 paths). All return 404.

**Conclusion:** the operator's token rotation did not add the `Account → Access: Service Tokens: Edit` permission group, **or** this account doesn't have the service-token API surface enabled at all. The `Account → Cloudflare Tunnel: Edit` permission is also still absent.

## What I verified and re-attempted this round

- Re-probed every endpoint enumerated in `docs/2026-07-30-access-api-probe.md`. No change.
- Re-attempted creating a posture check (`{type: "os_version", config: {operator: ">=", version: "15.0.0"}}`) on the WARP integration via `/devices/posture/integrations/{uid}/checks` and `/devices/posture/checks`. Both 404.
- Re-attempted sending a `device_posture` Require rule with a nested `check` object. Cloudflare's API accepted the PUT (200) but **stripped the `check` field** on storage, leaving only `integration_uid`. So posture checks must still be configured in the Zero Trust dashboard.

## What I can land without your input

Nothing new. The Access app + 3 policies, tunnel, WAF scope, posture integration list — all already in place from previous rounds. Live state is healthy:

- `https://coreprt.webrnds.com/_liveness` → 302 to Access login
- Tunnel `c40f4029-…` → healthy, 4 connectors
- Relay container `coreprt-relay-1` → healthy running
- Postgres / Redis / MinIO → healthy running
- Working tree → clean at `609787e`

## What's still in your court

1. **Rotate the `buzz-mcp-prod` service token** in the dashboard (old credentials exposed in chat/discarded local Git history). Service tokens must be created via dashboard because the API endpoint returns 404 for this account.
2. **Configure WARP posture checks** (OS version, FileVault, Firewall) in Zero Trust → Settings → WARP Client → Posture checks.
3. **Decide on Country=US geo-fence** (WARP team country rule, or accept the current email-only policy).
4. **Optional upstream `block/buzz` change** for `Cf-Access-Jwt-Assertion` validation against app audience `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e`.

If the dashboard summary for this token shows new permission groups (Service Tokens, Tunnel credential, etc.) that the API isn't honoring, that's a Cloudflare-side caching or scope-attach issue. Try **delete + create new token** rather than edit-in-place in the dashboard — that pattern has consistently failed across this session.
