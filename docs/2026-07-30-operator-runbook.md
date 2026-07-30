# CorePrt — Operator Runbook · 2026-07-30

**Goal:** take CorePrt from "Access policies live" to "operator logged in via WARP+posture, no OTP prompt" and "MCP bridge authenticated via service token".

**Current state (verified via API):**
- Access app `CorePrt` (id `c3f1f0da-94e8-4e8a-aef4-6d348dc6899d`, aud `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e`)
- 2 policies attached (canonical live state: see `docs/2026-07-30-final-policy-and-warp-pending.md`)
  - `owner-trusted-mac` (prec 1): `email=gogetta` + `require: device_posture` for all 4 posture UIDs (WARP, OS version, Firewall, Disk encryption)
  - `owner-anywhere` (prec 2): `email=gogetta` only — fallback when WARP not installed
- Policy C (`service-token-buzz-mcp`) was retired; all service tokens were deleted.
- 5 posture integrations live (Gateway, WARP, OS version, Firewall, Disk encryption)
- Tunnel healthy, 4 connectors; relay + postgres + redis + minio healthy running
- API can list devices: **`count=0`** — no devices have reported yet (operator hasn't enrolled WARP)
- API can list registrations: **`count=0`** — no device has registered with WARP

---

## Step 1 — Enroll WARP on the operator's Mac

1. Open **Cloudflare One Client**: 👉 https://one.dash.cloudflare.com/?to=/:account/team/devices
2. Click **Add a device** (or get the team enrollment token if not shown).
3. **On the operator's Mac**, install Cloudflare WARP if not present:
   - macOS: download from https://dash.cloudflare.com/?to=/:account/team/warp or App Store.
4. Open Cloudflare WARP → Settings → **Account** → paste the **organization enrollment token**.
5. Set the connection mode to **WARP** (not DNS-only).
6. Toggle the switch to **Connected**.

Verify on the Mac:

```sh
defaults read loginwindow SystemVersionStampAsString        # should be 15.x.y
diskutil info /System/Volumes/Data | grep FileVault         # should be: FileVault: Yes
sudo /sbin/pfctl -s info                                    # should be: Status: Enabled
/Applications/Cloudflare\ WARP.app/Contents/Resources/warp-cli tunnel info  # should be: Connected
```

Then check Cloudflare sees the device:

```sh
# API call (after re-probing the API token):
curl -sS -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/fb883e97a51c4525501a42a6a06b7a46/devices/registrations" \
  | python3 -m json.tool
```

Expected: `count=1` with one entry for the operator's Mac.

---

## Step 2 — Verify posture is reporting

👉 **https://one.dash.cloudflare.com/?to=/:account/team/logs/posture**

Within ~60 seconds of WARP connecting, you should see your Mac reporting:

- `os_version` → passing
- `firewall` → passing
- `disk_encryption` → passing
- `warp` → registered

If any check shows `failing`, click it for the device's specific reason (e.g., macOS firewall disabled, FileVault off, OS below the configured threshold).

---

## Step 3 — Test the operator login

From the operator's Mac (with WARP connected and posture passing):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://coreprt.webrnds.com/_liveness
```

Expected: **200** (or 200 with the relay's `ok` body). If you get **302**, the WARP client isn't reporting or one of the 4 posture checks is failing.

If the request fails:
1. Check WARP is in **WARP mode**, not DNS-only or off.
2. Verify all 4 posture checks in the dashboard logs.
3. If still 302, the operator email might not match — confirm the `email = gogetta` in the Access policy include matches the email you enrolled WARP with.

---

## Step 4 — (Deprecated) Service token rotation

Policy C (`service-token-buzz-mcp`) was retired; all service tokens were deleted. The dashboard rotation steps that used to live here no longer apply. If MCP auth is required, plan a WARP-only authentication path on the MCP host (see `docs/2026-07-30-final-policy-and-warp-pending.md` for the MCP plan).

The leaked credentials in `~/.config/coreprt/buzz-mcp.env` and in discarded local Git history should still be considered compromised — rotate any password reused elsewhere and audit MCP hosts.

---

## Step 5 — Optional: relay-side `Cf-Access-Jwt-Assertion` validation

Currently `http://127.0.0.1:3300/_liveness` (or any direct hit on the relay) bypasses Access. The 302 only kicks in for traffic that goes through Cloudflare's edge.

To close this gap, add a verification step in `block/buzz` upstream that, for every request:

1. Reads the `Cf-Access-Jwt-Assertion` header.
2. Confirms the header is present and non-empty (fail closed with 403 otherwise).
3. Fetches the JWKS from `https://silent-breeze-f1dc.cloudflareaccess.com/cdn-cgi/access/certs` and verifies the JWT signature against the matching key.
4. **Algorithm pinning**: rejects tokens whose `alg` header is anything other than `RS256` (no `none`, no HS256).
5. Confirms `iss` = `https://silent-breeze-f1dc.cloudflareaccess.com` (the team domain).
6. Confirms `aud` = `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e` (the CorePrt app audience).
7. Validates the time fields: `exp` strictly in the future, `nbf` <= now (if present), and `iat` <= now. The default 5-minute skew is fine.
8. **Fails closed**: any missing/invalid token, claim mismatch, or signature failure → 403.

This is upstream work. I can write the diff skeleton + a unit test plan if you want to send a PR; or install rustup + give me sudo for the duration.

---

## Quick link summary

| Action | Link |
|---|---|
| WARP enrollment | https://one.dash.cloudflare.com/?to=/:account/team/devices |
| Posture logs | https://one.dash.cloudflare.com/?to=/:account/team/logs/posture |
| Service tokens | https://one.dash.cloudflare.com/?to=/:account/:zone/settings/service-auth |
| Access app | https://one.dash.cloudflare.com/?to=/:account/:zone/access/apps/c3f1f0da-94e8-4e8a-aef4-6d348dc6899d |
| Cloudflare One Client docs | https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/ |
