# Cloudflare Access policy — CorePrt

**Status:** live as of 2026-08-03.
**Owner:** schreuderdarren@gmail.com (single-identity v1).
**Applies to:** `https://coreprt.webrnds.com` (and `wss://coreprt.webrnds.com`).
**App id:** `974e7f0c-8027-4183-a66d-394847b4ddd9`
**App audience (`aud`):** `55c81dfc5272fb5fdb74636fbb4803912328d317f15b5c2700be8a99ddc44329`
**Previous app id (deleted 2026-08-03):** `c3f1f0da-94e8-4e8a-aef4-6d348dc6899d` / `75f368ec…` — see `docs/2026-08-03-access-recreate.md`.

This document is the **source of truth** for the Access policy shape.
The actual policy is configured in the Cloudflare dashboard
(Access → Applications → CorePrt). Any change here must be reflected
in the dashboard and vice versa.

---

## Why multi-policy

Single-policy Access setups force a choice between "secure" and "all
devices." Multi-policy lets each path have its own posture:

- **Daily-driver Mac with WARP** → tight policy (WARP + 3 posture checks).
- **Phone, travel laptop, friend's machine** → looser, geo-fenced, short session.
- **MCP host (agent)** → WARP-required include; the device's WARP posture satisfies the edge.
- **Headless callers via service tokens** → **retired 2026-08-03** (see "Why no service tokens" below).

CF Access evaluates all policies as OR — any one passing admits the request.

---

## Policy A1 — `mcp-warp-required`

**Purpose:** admit the operator + any MCP host when Cloudflare WARP is connected. The minimum bar for any headless caller.
**Session:** 24h.

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Emails | `schreuderdarren@gmail.com` |
| Require | Device posture | WARP integration `76b96de1-4cce-43fe-ba8a-26881193a475` |

What it stops:
- Random internet strangers (email gate).
- Headless callers without WARP (device posture gate).
- IP-spoofed callers (WARP-issued device certificate is bound to the enrolling account).

What it does NOT stop:
- A stolen WARP session on a stolen Mac.
- A compromised device with WARP enrolled.

---

## Policy A — `owner-trusted-mac`

**Purpose:** everyday access from the primary Mac with WARP enrolled and full posture passing.
**Session:** 24h.

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Emails | `schreuderdarren@gmail.com` |
| Require | Device posture | WARP integration `76b96de1-…` |
| Require | Device posture | OS version `c99b5e24-…` (≥ 15.0) |
| Require | Device posture | Firewall `6ce07058-…` (enabled) |
| Require | Device posture | Disk encryption `62c90e6e-…` (FileVault on) |

What it adds beyond A1:
- Forces the operator's Mac to have FileVault, firewall, and a recent macOS.
- The 4-posture AND is enforced per-policy (no fallback to a lesser check).

What it stops:
- Stolen Mac with WARP still enrolled but FileVault turned off.
- Mac with WARP enrolled but firewall turned off.
- Mac with WARP enrolled but running an old macOS.

---

## Policy B — `owner-anywhere`

**Purpose:** access from any device, anywhere — phone, travel laptop, friend's machine, OR any host without WARP (e.g., a one-off device that doesn't have Cloudflare One Client installed). The 6h session + NL geo-fence make this the OTP fallback when Policy A1/A can't be satisfied.
**Session:** 6h.

| Rule type | Selector | Value |
| --- | --- | --- |
| Include | Emails | `schreuderdarren@gmail.com` |
| Require | Geo | `Netherlands` |

What it adds beyond email-only:
- A stolen OTP used from a foreign datacenter fails.
- Sessions expire every 6 hours; an attacker has a narrow window.

Tradeoff:
- 6h session means re-OTP every workday. Acceptable for occasional use; daily-driver Mac should be on Policy A.

---

## Why no service tokens

**Service tokens are structurally broken on this Cloudflare account.** Every `client_secret` minted via the API *or* the dashboard is rejected at the edge with `service_token_status: false` in the meta JWT. Verified with 3 separate tokens across 2 different apps on 2026-08-03 (the old `c3f1f0da-…` and the new `974e7f0c-…`):

- `b6542dbe…` (the "re-created 2026-07-31" token referenced in earlier docs) — last seen 2026-08-02, but every edge probe with it returned 403. The 2026-07-31 re-creation note that claimed it was working is **factually wrong** — the authed 200s that the note referred to were probably from an older WARP session cached on the operator's machine, not from the service token itself.
- `8558f382-…` (the 2026-08-03 fresh mint) — clean 64-hex `client_secret`, edge returned 403.
- `80ae9bce-…` (the 2026-07-30 mint) — same result.

The 2026-08-03 recreate test (`docs/2026-08-03-access-recreate.md`) **refutes the hypothesis that a fresh app would fix the edge rejection**. Service tokens are an account-level property, not an app-level one.

The replacement path is **WARP-required include on the MCP host** (Policy A1). The MCP host, like the operator's Mac, must:
1. Install Cloudflare One Client.
2. Enroll with a team enrollment token.
3. Set connection mode to WARP.
4. Add `coreprt.webrnds.com` to the WARP split-tunnel **Include** list (otherwise WARP routes everything except local, which works for split-exclude; the include is needed if WARP is in default exclude mode).

When WARP is connected and posture is passing, `signedFetch` from the MCP carries the WARP-issued device certificate as part of the TLS handshake to the edge. The edge admits the request because `mcp-warp-required`'s `device_posture` check passes.

---

## v1 exclusions (deferred)

These were considered and dropped for v1:

- **Client certificates (mTLS)** — requires PKI infrastructure. Drop for v1.
- **Device serial numbers** — manual enumeration. Drop for v1.
- **EDR checks (Carbon Black, SentinelOne, etc.)** — not installed. Drop for v1.
- **Geo-fence on Policy A** — daily-driver Mac travels; the OS+FileVault+Firewall+WARP rows are the meaningful gate.
- **Per-agent identity** — v1 has a single operator. Adding a second human user → update `Include → Emails` in all three policies. Adding a second agent → enroll that host's WARP under the same team token (or a separate team token if separation is desired).

---

## Operational notes

- Adding a second human user → update `Include → Emails` in **all three policies** to add the new identity (e.g. `schreuderdarren@gmail.com`).
- Adding an MCP host → install + enroll WARP on that host. Use a separate enrollment token if you want per-device audit. Add `coreprt.webrnds.com` to its WARP split-tunnel Include list. The host will then satisfy Policy A1's WARP posture gate.
- Compromised WARP device → revoke in CF dashboard (Zero Trust → My Team → Devices → Revoke). The operator must re-enroll with a new device token. The relay's Nostr keypair is unaffected (that's a separate identity).
- Policy drift detection: when editing any policy in the dashboard, copy the resulting JSON definition back into this file as a fenced code block under "Live state" so version control catches drift.
- The pre-2026-08-03 `docs/2026-07-30-service-token-api-quirks.md` documents the service-token investigation. The 2026-08-03 recreate doc is the final word on the path being dead.
- The `cfat_…` API token in `CorePrt-deploy/.env` was posted in chat → **compromised**. The 2026-08-03 rebuild was performed under this same token (Plan B staging). Rotate `CF_API_TOKEN` in the dashboard and re-run `scripts/snapshot-access.py` + `scripts/recreate-access-app.py` + `scripts/mcp-warp-fallback.py` for a clean-cut rebuild.

---

## Live state

> Run `scripts/snapshot-access.py` to dump the current Cloudflare state into `docs/<date>-access-recreate-snapshot.md`. The 2026-08-03 snapshot is the current canonical record.
