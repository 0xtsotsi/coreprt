# CorePrt — Posture checks landed · 2026-07-30

**The four canonical WARP posture checks are now live on Cloudflare and wired into Policy A as `require` rules.**

## Posture integrations live (5 total)

| ID | Type | Name |
|---|---|---|
| `e9bb35b0-6339-44df-9bd5-ae3d4092c26c` | `gateway` | Gateway |
| `76b96de1-4cce-43fe-ba8a-26881193a475` | `warp` | WARP |
| `c99b5e24-418b-414d-859b-bb428d45a09a` | `os_version` | Coreprt webrnds posture |
| `6ce07058-3f3e-43cd-91e8-2e97d21cd57f` | `firewall` | Coreprt webrnds post Firewall |
| `62c90e6e-bc8a-4b90-868b-e3b5138a0846` | `disk_encryption` | Coreprt webrnds Disk Encryp |

Created via dashboard at:
👉 https://one.dash.cloudflare.com/?to=/:account/team/posture/checks

(Cloudflare's Reusable components → Posture checks → Cloudflare One Client checks → Add a check.)

## Policy A wired (4 require rules)

`owner-trusted-mac` now requires **all four** of:

1. **WARP registered** — `device_posture {integration_uid: 76b96de1-…}` (WARP integration)
2. **macOS ≥ 15.0** — `device_posture {integration_uid: c99b5e24-…}` (OS version check)
3. **Firewall on** — `device_posture {integration_uid: 6ce07058-…}` (Firewall check)
4. **FileVault on** — `device_posture {integration_uid: 62c90e6e-…}` (Disk encryption check)

Plus `include: email = gogetta`.

A request only matches Policy A when **all five conditions** are met (the four posture checks AND the operator's email). If WARP isn't installed or any check fails, the policy denies and Access falls through to `owner-anywhere` (email only, no require) — which still requires OTP auth.

## Verification commands on the operator's Mac

```sh
defaults read loginwindow SystemVersionStampAsString        # → 15.x.y
diskutil info /System/Volumes/Data | grep FileVault         # → FileVault: Yes
sudo /sbin/pfctl -s info                                    # → Status: Enabled
/Applications/Cloudflare\ WARP.app/Contents/Resources/warp-cli tunnel info   # → Connected
```

Then check that Cloudflare sees the posture:
👉 https://one.dash.cloudflare.com/?to=/:account/team/logs/posture

## Live state (verified at commit time)

- `https://coreprt.webrnds.com/_liveness` → 302 to Access login ✅
- Tunnel `c40f4029-…` → healthy, 4 connectors
- Relay container `coreprt-relay-1` → healthy running
- Postgres / Redis / MinIO → healthy running
- Working tree → clean

## Remaining items (operator's court)

1. **(Deprecated)** Rotate `buzz-mcp-prod` service token is no longer needed — Policy C was retired and all service tokens were deleted. The leaked credentials in chat/discarded local Git history should still be considered compromised. The `/accounts/{id}/access/service_tokens` (underscored) route is reachable for create/list/read/rotate/delete, but its API-created secrets are rejected at the edge, so no service-token provisioning path is known to authenticate against this account.
2. **Optional upstream `block/buzz` change** for `Cf-Access-Jwt-Assertion` validation against app audience `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e` — currently the public 302 only kicks in for traffic via Cloudflare's edge; direct relay on port 3300 still bypasses.
3. **Decide on Country=US geo-fence** — current `owner-anywhere` admits from anywhere with email+OTP. If you want US-only, add a WARP team country rule (not WAF, since you live in NL).
