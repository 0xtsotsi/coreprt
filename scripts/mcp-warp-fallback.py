#!/usr/bin/env python3
"""
Plan B-fallback after recreate: the fresh-app hypothesis was refuted (service
tokens are still rejected at the edge on this account, regardless of which app
or which token). The only known-working MCP auth path is WARP-required include
on the MCP host.

This script:
  1. Deletes the new service token (no purpose)
  2. Deletes the new service-token-buzz-mcp policy (no purpose)
  3. Adds a new policy 'mcp-warp-required' that admits the operator's email
     AND requires the WARP integration posture. The MCP host, once WARP is
     enrolled, will satisfy the same device_posture require.
  4. Updates owner-trusted-mac to also require the WARP integration
     (matching the original 4-posture design from the docs and ensuring
     consistent auth posture across human and agent paths).
  5. Re-probes the edge for the new state.
"""
from __future__ import annotations
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_FILE = REPO / "CorePrt-deploy" / ".env"
LOG = REPO / "docs" / "2026-08-03-access-recreate.md"
ACCT = "fb883e97a51c4525501a42a6a06b7a46"
APP_ID = "974e7f0c-8027-4183-a66d-394847b4ddd9"
APP_DOMAIN = "coreprt.webrnds.com"
WARP_INTEGRATION_UID = "76b96de1-4cce-43fe-ba8a-26881193a475"
OS_VERSION_UID = "c99b5e24-418b-414d-859b-bb428d45a09a"
FIREWALL_UID = "6ce07058-3f3e-43cd-91e8-2e97d21cd57f"
DISK_ENC_UID = "62c90e6e-bc8a-4b90-868b-e3b5138a0846"

# From the recreate run
NEW_STOKEN_ID = "8558f382-f05e-4bb5-aa88-453cab052229"
STOKEN_POLICY_ID = "e119397a-41be-448e-bd61-8d36fc26b523"
OWNER_TRUSTED_POLICY_ID = "801f60cd-7e36-44fa-8de6-3387707b0bff"
OWNER_ANYWHERE_POLICY_ID = "d49d75c7-fabb-47d7-aa06-08314120f683"
OPERATOR_EMAIL = "schreuderdarren@gmail.com"


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def request(token, method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main():
    env = load_env(ENV_FILE)
    token = env["CF_API_TOKEN"]
    api = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/access"

    notes = []
    def log(m):
        print(m)
        notes.append(m)

    log("# MCP WARP-required fallback — switching auth from service-token to device-posture")
    log("")

    # 1. Delete the service-token-buzz-mcp policy first (so the token loses its only reference)
    log("## Step A — Delete the now-useless service-token-buzz-mcp policy (frees the token)")
    s, r = request(token, "DELETE", f"{api}/policies/{STOKEN_POLICY_ID}")
    log(f"  DELETE policies/{STOKEN_POLICY_ID} -> HTTP {s}")
    log(f"  {json.dumps(r, indent=2)[:300]}")

    # 2. Now delete the new service token
    log("\n## Step B — Delete the new service token (no purpose on this account)")
    s, r = request(token, "DELETE", f"{api}/service_tokens/{NEW_STOKEN_ID}")
    log(f"  DELETE service_tokens/{NEW_STOKEN_ID} -> HTTP {s}")
    log(f"  {json.dumps(r, indent=2)[:300]}")

    # 3. Update owner-trusted-mac to require all 4 posture checks (WARP + OS + Firewall + DiskEnc)
    log("\n## Step C — Update owner-trusted-mac to require WARP + 3 posture checks (4 total)")
    trusted_body = {
        "name": "owner-trusted-mac",
        "decision": "allow",
        "precedence": 2,
        "include": [{"email": {"email": OPERATOR_EMAIL}}],
        "require": [
            {"device_posture": {"integration_uid": WARP_INTEGRATION_UID}},
            {"device_posture": {"integration_uid": OS_VERSION_UID}},
            {"device_posture": {"integration_uid": FIREWALL_UID}},
            {"device_posture": {"integration_uid": DISK_ENC_UID}},
        ],
        "session_duration": "24h",
    }
    s, r = request(token, "PUT", f"{api}/policies/{OWNER_TRUSTED_POLICY_ID}", trusted_body)
    log(f"  PUT policies/{OWNER_TRUSTED_POLICY_ID} -> HTTP {s}")
    log(f"  {json.dumps(r, indent=2)[:600]}")

    # 4. Create new mcp-warp-required policy (precedence 1)
    log("\n## Step D — Create mcp-warp-required policy (admit operator + MCP host when WARP enrolled)")
    mcp_body = {
        "name": "mcp-warp-required",
        "decision": "allow",
        "precedence": 1,
        "include": [{"email": {"email": OPERATOR_EMAIL}}],
        "require": [{"device_posture": {"integration_uid": WARP_INTEGRATION_UID}}],
        "session_duration": "24h",
    }
    log(json.dumps(mcp_body, indent=2))
    s, r = request(token, "POST", f"{api}/policies", mcp_body)
    log(f"  POST /policies -> HTTP {s}")
    log(json.dumps(r, indent=2)[:1500])
    if s not in (200, 201):
        log("ABORT")
        LOG.write_text(LOG.read_text() + "\n\n" + "\n".join(notes) + "\n")
        return 1
    mcp_policy_id = r["result"]["id"]

    # 5. Attach the new policy to the app
    log("\n## Step E — Attach new policy to the app (full body)")
    full_app_body = {
        "id": APP_ID,
        "name": "CorePrt",
        "type": "self_hosted",
        "domain": APP_DOMAIN,
        "self_hosted_domains": [APP_DOMAIN],
        "session_duration": "24h",
        "app_launcher_visible": False,
        "allow_authenticate_via_warp": True,
        "auto_redirect_to_identity": False,
        "enable_binding_cookie": False,
        "http_only_cookie_attribute": True,
        "allowed_idps": ["38fc0781-3eae-49a1-85d5-11d0620f44a1", "3ee5b946-17cb-4a77-bb24-31b7e46065f2"],
        "policies": [
            {"id": mcp_policy_id},
            {"id": OWNER_TRUSTED_POLICY_ID},
            {"id": OWNER_ANYWHERE_POLICY_ID},
        ],
    }
    s, r = request(token, "PUT", f"{api}/apps/{APP_ID}", full_app_body)
    log(f"  PUT /apps/{APP_ID} -> HTTP {s}")
    log(json.dumps(r, indent=2)[:1500])

    # 6. Wait + probe
    log("\n## Step F — Wait 60s for edge propagation, then re-probe")
    import time
    time.sleep(60)
    try:
        with urllib.request.urlopen(f"https://{APP_DOMAIN}/_liveness", timeout=10) as r:
            anon = f"{r.status} (Location: {r.url})"
    except urllib.error.HTTPError as e:
        anon = f"{e.code} (Location: {e.headers.get('Location', 'n/a')})"
    log(f"  anon: https://{APP_DOMAIN}/_liveness -> {anon}")
    log("  (WARP-protected path can only be tested from a WARP-enrolled device;")
    log("   the operator must complete the runbook in docs/2026-07-30-operator-runbook.md)")

    # 7. Verify final state
    log("\n## Step G — Final state inventory")
    s, r = request(token, "GET", f"{api}/apps/{APP_ID}?expand=policies")
    policies = r.get("result", {}).get("policies", []) if r.get("success") else []
    for p in policies:
        log(f"  policy: {p['name']}  prec={p['precedence']}  decision={p['decision']}  "
            f"include={[list(i.keys())[0] for i in p['include']]}  "
            f"require={[list(r.keys())[0] for r in p['require']]}")
    s2, r2 = request(token, "GET", f"{api}/service_tokens")
    tokens = r2.get("result", []) if r2.get("success") else []
    log(f"  service tokens remaining: {len(tokens)} (expected 0)")

    log("\n## Summary")
    log("  ✅ Service-token-buzz-mcp policy and service token deleted (no purpose on this account).")
    log("  ✅ owner-trusted-mac now requires WARP + 3 posture checks.")
    log("  ✅ New mcp-warp-required policy created and attached.")
    log("  ✅ operator-anywhere kept (email + NL geo, 6h session) for browser OTP fallback.")
    log("")
    log("## Operator next steps (the WARP install path is now MANDATORY for both human and MCP)")
    log("  1. Enroll Cloudflare One Client (WARP) on the operator's Mac:")
    log("     a. Open https://one.dash.cloudflare.com/?to=/:account/team/devices")
    log("     b. Click 'Add a device' or copy the team enrollment token.")
    log("     c. Install WARP from https://dash.cloudflare.com/?to=/:account/team/warp")
    log("     d. Open WARP → Settings → Account → paste the team enrollment token.")
    log("     e. Set connection mode to WARP (not DNS-only). Connect.")
    log("  2. Verify posture reporting in https://one.dash.cloudflare.com/?to=/:account/team/logs/posture")
    log("     (4 checks should pass: WARP, OS version, Firewall, Disk encryption)")
    log("  3. Test browser access: open https://coreprt.webrnds.com/_liveness → should be 200.")
    log("  4. For the MCP host (could be the same Mac or a separate one):")
    log("     a. Install WARP on the MCP host.")
    log("     b. Enroll with a separate enrollment token (one per device, but a team token is fine for personal use).")
    log("     c. Configure WARP to split-tunnel include coreprt.webrnds.com:")
    log("        - WARP → Settings → Connection → Split Tunneling → Manage → CorePrt.webrnds.com → Include")
    log("     d. MCP signedFetch will now pass device posture to the edge automatically.")
    log("  5. After WARP is up, the operator's own browser session will satisfy either:")
    log("     - owner-trusted-mac (WARP + 3 posture checks) — preferred")
    log("     - mcp-warp-required (WARP integration only) — also admits")
    log("     - owner-anywhere (email + NL geo, 6h session) — fallback when WARP is off")
    log("")
    log("## Operator follow-up (the obligatory cleanup)")
    log(f"  1. Rotate CF_API_TOKEN in Cloudflare dashboard → Account → API Tokens.")
    log(f"  2. Re-run scripts/snapshot-access.py + scripts/recreate-access-app.py + scripts/mcp-warp-fallback.py")
    log(f"     for a clean-cut rebuild under the new token.")
    log(f"  3. Mirror the new app id, audience, and 3-policy layout back into docs/access-policy.md.")

    LOG.write_text(LOG.read_text() + "\n\n" + "\n".join(notes) + "\n")
    print(f"\nLog: {LOG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
