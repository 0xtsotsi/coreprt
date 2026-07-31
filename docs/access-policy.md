# Cloudflare Access policy — CorePrt

**Status:** approved 2026-07-29.
**Owner:** gogetta (single-identity v1).
**Applies to:** `https://coreprt.webrnds.com` (and `wss://coreprt.webrnds.com`).

This document is the **source of truth** for the Access policy shape.
The actual policy is configured in the Cloudflare dashboard
(Access → Applications → CorePrt). Any change here must be reflected
in the dashboard and vice versa.

---

## Why multi-policy

Single-policy Access setups force a choice between "secure" and "all
devices." Multi-policy lets each path have its own posture:

- **Daily-driver Mac** → tight policy (FileVault + Firewall + OS check).
- **Phone, travel laptop, friend's machine** → looser, geo-fenced, short session.
- **Headless callers** (agents via `@buzz/mcp`) → Service Token, no session.

CF Access evaluates all policies as OR — any one passing admits the request.

---

## Policy A — `owner-trusted-mac`

**Purpose:** everyday access from the primary Mac.
**Session:** 24h.

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Emails | `gogetta` |
| Require | OS version | `macOS >= 15.0` |
| Require | Disk encryption | `FileVault = on` |
| Require | Firewall | `enabled` |

What it stops:
- Random internet strangers (email gate).
- Ancient Macs without modern exploit mitigations (OS row).
- Lost-laptop data exposure (FileVault row).
- Misconfigured network stacks (Firewall row).

What it does NOT stop:
- Session-token theft from your browser.
- OTP phish (mitigated by Policy B's geo-fence).
- Compromised IdP.

---

## Policy B — `owner-anywhere`

**Purpose:** access from any device, anywhere — phone, travel laptop, friend's machine.
**Session:** 1h (short blast radius).

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Emails | `gogetta` |
| Require | Country | `United States` |

What it adds beyond email-only:
- A stolen OTP used from a foreign datacenter fails.
- Sessions expire hourly; an attacker has a narrow window.

Tradeoff:
- 1h session means re-OTP on long flights. Acceptable for occasional use.

---

## Policy C — `service-token-buzz-mcp`

**Purpose:** headless callers — agents, MCP bridge, future automation.
**Session:** none (Service Tokens are long-lived credentials).

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Service Token | `buzz-mcp-prod` |

Service Token details:
- Generated on 2026-07-29; re-created 2026-07-31 after the 2026-07-30 retirement.
- Stored in agent host environment (never in repo, never in .env committed).
- Revocable independently of any human session.

**2026-07-31 re-creation note.** The original `buzz-mcp-prod` service token was retired 2026-07-30 as part of the access-policy simplification. A new token with the same name was created from a clean dashboard session on 2026-07-31. The current `client_id` is `b6542dbe957486d355002cba3fb75b00.access` (the secret is held in the operator's `~/.config/coreprt/buzz-mcp.env`, chmod 600, never in this repo). Edge-probe `bash scripts/probe-edge.sh` returns 200 on `/`, `/info`, `/_liveness`, `/_readiness`; the 401 on `POST /events`/`/query`/`/count` is the relay layer (NIP-98 / NIP-42) and is the expected posture — the edge is admitting the request and the relay is asking for Nostr auth.

Why required: `BUZZ_REQUIRE_AUTH_TOKEN=true` and
`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` mean every request needs a
Nostr-signed NIP-98 (HTTP) or NIP-42 (WS) auth event. Service Token
satisfies the CF Access layer; Nostr auth satisfies the relay layer.
Both layers required.

---

## v1 exclusions (deferred)

These were considered and dropped for v1:

- **WARP Require** — adds a per-device install + registration step. Drop for v1; revisit when adding a second Mac.
- **Client certificates (mTLS)** — requires PKI infrastructure. Drop for v1.
- **Device serial numbers** — manual enumeration. Drop for v1.
- **EDR checks (Carbon Black, SentinelOne, etc.)** — not installed. Drop for v1.
- **Geo-fence on Policy A** — daily-driver Mac travels; the OS+FileVault+Firewall rows are the meaningful gate.

---

## Operational notes

- Adding a second human user → update `Include → Emails` in **all three policies** to add the new identity.
- Adding a second agent → create a new Service Token, name it descriptively, store credentials in that agent host's secret store.
- Adding `@buzz/mcp` to a fresh Mac → create a fresh Service Token, place creds in the host's secret store, and add the buzz block to `~/.gg/mcp.json`. See https://github.com/0xtsotsi/buzz-mcp docs/quickstart.md.
- Compromised Service Token → revoke in CF dashboard; rotate Nostr keypair for the affected agent (`docker exec -it coreprt-relay-1 /usr/local/bin/buzz-admin generate-key`, `run.sh add-member <new-key>`, `run.sh remove-member <old-key>`).
- Policy drift detection: when editing any policy in the dashboard, copy the resulting JSON definition back into this file as a fenced code block under "Live state" so version control catches drift.

---

## Live state

> Filled in after §3 B2 dashboard step. Will be the JSON dump of each policy as exported from the CF dashboard.
