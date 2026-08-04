# CorePrt — Zero Trust plan activated · 2026-07-30 **SUPERSEDED 2026-08-03**

> **This document is no longer the live state.** The Access app `c3f1f0da-…` was deleted on 2026-08-03 and replaced with `974e7f0c-…` (aud `55c81dfc…`). The current policy layout is 3 policies including a new `mcp-warp-required` for the MCP host. See `docs/access-policy.md` for the current live state and `docs/2026-08-03-access-recreate.md` for the recreate run log. The remainder of this file is the historical 2026-07-30 activation notes, preserved for the audit trail.

<details>

# CorePrt — Zero Trust plan activated · 2026-07-30 [historical]

**Trigger:** operator paid for Cloudflare Zero Trust subscription; plan upgrade visible at the API level (WAF:Edit now allowed at zone scope; posture integration list reachable).

**API token used in this round:** `[REDACTED]` (account-scoped; never commit live credentials).

## What landed

> **Historical snapshot** (the live state has since moved on):
> the original rollout had three Allow policies attached to
> Access app `CorePrt` (c3f1f0da-…). The canonical live state is now
> two policies — see `docs/2026-07-30-final-policy-and-warp-pending.md`
> for the authoritative policy list and `docs/2026-07-30-service-token-api-quirks.md`
> for why Policy C was retired. The original three-policy layout was:

1. **Access app `CorePrt` (c3f1f0da-…)** — 3 Allow policies attached, enforcing with 302 to Access login.
   - `owner-trusted-mac` (prec 1): `email=gogetta` + `require: device_posture` (WARP integration `76b96de1-…`)
   - `owner-anywhere` (prec 2): `email=gogetta` only — fallback when WARP not installed
   - `service-token-buzz-mcp` (prec 3): `any_valid_service_token` — **retired**; service tokens are deleted and the policy no longer exists.
2. **WAF:Edit verified** — created and deleted a `CorePrt - Geo gate` zone-scoped ruleset (kind: zone, phase: `http_request_firewall_custom`) with one Country=US block rule. Confirmed WAF rule engine accepted the API call and 403'd the NL test request. Deleted because the operator lives in NL.
3. **Posture integrations enumerated** — 2 built-in: `Gateway` and `WARP`.

## What I still need from you (in order of urgency)

1. **(Deprecated)** The buzz-mcp-prod service token rotation no longer applies — all service tokens were deleted and Policy C was retired. If MCP auth is needed, plan a WARP-only authentication path on the MCP host instead. The publication branch was rebuilt from the sanitized final tree and secret-scanned before push; rotate any leaked credentials regardless.
2. **Configure the actual posture checks in the WARP integration** — the API only takes `integration_uid`; the OS version / FileVault / Firewall rules must be defined in Zero Trust → Settings → WARP Client → Posture checks. The WARP integration on the operator's Mac must be registered and reporting passing posture for `owner-trusted-mac` to admit them.
3. **Decide on Country=US geo-fence** — Cloudflare Access does not natively support country gating in policy `include`. Options: (a) WARP team country rule, (b) re-create the WAF geo-gate rule when the operator has a US exit point, (c) accept that any email-authenticated user passes.
4. **Optional: upstream `block/buzz` change** — verify `Cf-Access-Jwt-Assertion` against the app audience `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e` to harden against direct-origin bypass on port 3300. Currently the public 302 only kicks in for traffic that transits the Cloudflare edge.

## Live state at the time of this note

- `https://coreprt.webrnds.com/_liveness` → **302** to Access login (Cloudflare OTP IdP `3ee5b946-…`)
- Cloudflare Tunnel `c40f4029-…` → healthy, 4 QUIC connectors to ams15/18/20/21
- Relay container `coreprt-relay-1` → healthy running
- Direct relay at `http://127.0.0.1:3300/_liveness` → 200 ok (edge-bypass; needs upstream JWT check)

## Token scope summary (final)

Granted and working: account-scoped Apps CRUD, account-scoped Policies CRUD, IdP Read, Org Read, Access Groups Read, posture features Read, WAF:Edit (zone scope).

Granted but endpoint structurally unavailable for this account: Service Tokens (`/accounts/{id}/access/service-tokens` with hyphen returns 404 code 10001; the underscored `/accounts/{id}/access/service_tokens` route is reachable for create/list/read/rotate/delete, but its API-created secrets are rejected at the edge), Tunnel credential refresh (404).

</details>

## Update 2026-08-03

The WARP-required include for the MCP host (originally suggested as "if headless MCP auth is needed later, plan a WARP-only authentication path on the MCP host") was implemented on 2026-08-03. See `docs/access-policy.md` and `docs/2026-08-03-access-recreate.md`.
