# CorePrt — Operator Runbook · 2026-07-30 (updated 2026-08-03)

**Goal:** take CorePrt from "Access policies live" to "operator logged in via WARP+posture, no OTP prompt" and "MCP host authenticated via WARP".

> **2026-08-03 update.** WARP enrollment is now **MANDATORY**, not optional. Service tokens are structurally broken on this Cloudflare account and were retired; the only working headless auth path is WARP-required include (Policy A1). The Access app was also recreated as `974e7f0c-8027-4183-a66d-394847b4ddd9` (aud `55c81dfc…`); the old `c3f1f0da-…` / `75f368ec…` was deleted. See `docs/2026-08-03-access-recreate.md` for the recreate run log.

**Current state (verified via API on 2026-08-03):**
- Access app `CorePrt` (id `974e7f0c-8027-4183-a66d-394847b4ddd9`, aud `55c81dfc5272fb5fdb74636fbb4803912328d317f15b5c2700be8a99ddc44329`)
- 3 policies attached (canonical live state: see `docs/access-policy.md`)
  - `mcp-warp-required` (prec 1): `email=schreuderdarren@gmail.com` + `require: device_posture(WARP integration)`
  - `owner-trusted-mac` (prec 2): `email=schreuderdarren@gmail.com` + `require: device_posture` for all 4 posture UIDs (WARP, OS version, Firewall, Disk encryption)
  - `owner-anywhere` (prec 3): `email=schreuderdarren@gmail.com` + `require: geo(NL)` + 6h session
- Service tokens: **0** (all deleted 2026-08-03; service-token path retired on this account — see `docs/2026-07-30-service-token-api-quirks.md` and the refutation in `docs/2026-08-03-access-recreate.md`)
- 5 posture integrations live (Gateway, WARP, OS version, Firewall, Disk encryption)
- Tunnel healthy, 4 connectors; relay + postgres + redis + minio healthy running
- API can list devices: **`count=0`** — no devices have reported yet (operator hasn't enrolled WARP)
- API can list registrations: **`count=0`** — no device has registered with WARP

---

## Step 1 — Enroll WARP on the operator's Mac **MANDATORY**

Without WARP enrolled, neither the operator nor any MCP host can reach the relay (Policy A1/A require the WARP device-posture check; Policy B's 6h session is the only path without WARP, and it requires NL geo). The operator's daily-driver path is Policy A (WARP + 3 posture checks), not Policy B.

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
3. If still 302, the operator email might not match — confirm the `email = schreuderdarren@gmail.com` in the Access policy include matches the email you enrolled WARP with.

---

## Step 4 — Enroll WARP on the MCP host (MCP-side)

If the MCP host is the same Mac as the operator's, Step 1 already covers it. If the MCP host is a different machine (a separate Mac, a Linux box, a CI runner, etc.), do this:

1. On the MCP host, install Cloudflare One Client:
   - macOS: download from https://dash.cloudflare.com/?to=/:account/team/warp or App Store.
   - Linux: see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/manual-deployment/ for apt repo install.
2. Get a team enrollment token from https://one.dash.cloudflare.com/?to=/:account/team/devices (separate token from the operator's, for per-device audit).
3. On the MCP host, register the token:
   ```
   warp-cli registration token <TEAM_TOKEN>
   ```
4. Set the connection mode to **WARP** (not DNS-only): `warp-cli mode warp` (Linux) or via the app Settings on macOS.
5. Connect: `warp-cli connect`.
6. **Critical:** add `coreprt.webrnds.com` to the WARP split-tunnel **Include** list on the MCP host. Without this, WARP routes all traffic to the Cloudflare edge; with split-tunnel Include for the relay host, the MCP's TLS handshake to `coreprt.webrnds.com` carries the WARP device certificate through the tunnel that Cloudflare sees.
   - macOS: WARP → Settings → Connection → Split Tunneling → Manage → add `coreprt.webrnds.com` → Include.
   - Linux: split-tunnel config is via `mdm.xml` profile or the dashboard's WARP client config (see docs link above).
7. Verify the MCP host shows up in `devices/registrations` and posture is passing for WARP.
8. From the MCP host, the `mcp__buzz__*` tools should now reach the relay through the WARP-authenticated TLS path.

> **Note for the `~/.config/coreprt/buzz-mcp.env` file.** The `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` env vars are no longer needed. The MCP server can keep them in the env file (harmless) but should remove them in a follow-up cleanup once the WARP path is confirmed working — see `docs/2026-08-02-mcp-diagnostic.md` for the env-file schema.

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
6. Confirms `aud` = `55c81dfc5272fb5fdb74636fbb4803912328d317f15b5c2700be8a99ddc44329` (the **current** CorePrt app audience — old `75f368ec…` was retired 2026-08-03).
7. Validates the time fields: `exp` strictly in the future, `nbf` <= now (if present), and `iat` <= now. The default 5-minute skew is fine.
8. **Fails closed**: any missing/invalid token, claim mismatch, or signature failure → 403.

This is upstream work. I can write the diff skeleton + a unit test plan if you want to send a PR; or install rustup + give me sudo for the duration.

---

## Quick link summary

| Action | Link |
|---|---|
| WARP enrollment | https://one.dash.cloudflare.com/?to=/:account/team/devices |
| Posture logs | https://one.dash.cloudflare.com/?to=/:account/team/logs/posture |
| ~~Service tokens~~ (retired 2026-08-03) | ~~https://one.dash.cloudflare.com/?to=/:account/:zone/settings/service-auth~~ |
| Access app | https://one.dash.cloudflare.com/?to=/:account/:zone/access/apps/974e7f0c-8027-4183-a66d-394847b4ddd9 |
| Cloudflare One Client docs | https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/ |
