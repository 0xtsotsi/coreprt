#!/usr/bin/env python3
"""
Recreate the CorePrt Access app from scratch under the (compromised) CF_API_TOKEN.

Mirror the live 3-policy shape captured by scripts/snapshot-access.py:
  1. service-token-buzz-mcp — non_identity, any valid service token, precedence 1
  2. owner-trusted-mac      — email + device_posture (disk-encryption + firewall), prec 2
  3. owner-anywhere         — email + NL geo-fence + 6h session, prec 3

After recreate:
  - mint a fresh service token, bind it to policy 1
  - delete the OLD app + the OLD service token
  - update the live edge probe + write the new state to docs/

The test for whether this rebuild is worth keeping:
  - if the NEW service token authenticates at the edge (status 200 on /_liveness
    with the CF-Access-Client-Id/Secret headers), we keep the design and the
    access-policy.md "2026-07-31 re-creation note" was right.
  - if it still gets 403, we fall back to WARP-required include for MCP and
    rewrite access-policy.md to reflect that.

Operator must rotate CF_API_TOKEN in the dashboard and re-run this script
for the result to count as production-clean.
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_FILE = REPO / "CorePrt-deploy" / ".env"
OUT = REPO / "docs" / "2026-08-03-access-recreate.md"

ACCT = "fb883e97a51c4525501a42a6a06b7a46"
ZONE = "788487334a7810a9a377e254c0155b25"
OLD_APP_ID = "c3f1f0da-94e8-4e8a-aef4-6d348dc6899d"
APP_DOMAIN = "coreprt.webrnds.com"

# Captured by snapshot-access.py on 2026-08-03.
POSTURE_DISK_ENCRYPTION_UID = "62c90e6e-bc8a-4b90-868b-e3b5138a0846"
POSTURE_FIREWALL_UID = "6ce07058-3f3e-43cd-91e8-2e97d21cd57f"
OTP_IDP = "3ee5b946-17cb-4a77-bb24-31b7e46065f2"
OTP_OTP_IDP = "38fc0781-3eae-49a1-85d5-11d0620f44a1"
ALLOWED_IDPS = [OTP_OTP_IDP, OTP_IDP]
SESSION_DURATION = "24h"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def request(token: str, method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"raw": "<non-JSON body>"}
        return e.code, payload


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="actually create / delete. Default is dry-run.")
    p.add_argument("--skip-delete-old", action="store_true", help="do not delete the OLD app or token (useful for re-runs).")
    p.add_argument("--skip-new-stoken", action="store_true", help="do not create a new service token.")
    args = p.parse_args()

    env = load_env(ENV_FILE)
    token = env.get("CF_API_TOKEN")
    if not token:
        print("CF_API_TOKEN missing in .env", file=sys.stderr)
        return 2

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log: list[str] = []
    def emit(msg: str) -> None:
        print(msg)
        log.append(msg)

    emit(f"# CorePrt — Access app recreate run · {ts}")
    emit(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    emit(f"Old app: {OLD_APP_ID}")
    emit("")

    api = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/access"

    # ---- Step 1a: Find any existing app for APP_DOMAIN and delete it ----
    emit("## Step 1a — Delete any existing app + service token for the domain")
    if not args.skip_delete_old:
        s, r = request(token, "GET", f"{api}/apps?domain={APP_DOMAIN}")
        if isinstance(r, dict) and r.get("success"):
            for a in r.get("result", []) or []:
                if a.get("domain") == APP_DOMAIN:
                    emit(f"  Found existing app id={a['id']} domain={a.get('domain')}  -> DELETE")
                    if args.apply:
                        ds, dr = request(token, "DELETE", f"{api}/apps/{a['id']}")
                        emit(f"    DELETE -> HTTP {ds}")
                        emit(json.dumps(dr, indent=2)[:500])
        s2, r2 = request(token, "GET", f"{api}/service_tokens")
        if isinstance(r2, dict) and r2.get("success"):
            for t in r2.get("result", []) or []:
                if t.get("name") == "buzz-mcp-prod":
                    emit(f"  Found existing service token id={t['id']} name={t.get('name')}  -> DELETE")
                    if args.apply:
                        ds, dr = request(token, "DELETE", f"{api}/service_tokens/{t['id']}")
                        emit(f"    DELETE -> HTTP {ds}")
        emit("")

    # ---- Step 1: Create the new app ----
    emit("## Step 1 — Create new Access app")
    create_app_body = {
        "name": "CorePrt",
        "domain": APP_DOMAIN,
        "type": "self_hosted",
        "session_duration": SESSION_DURATION,
        "app_launcher_visible": False,
        "allow_authenticate_via_warp": True,
        "auto_redirect_to_identity": False,
        "enable_binding_cookie": False,
        "http_only_cookie_attribute": True,
        "allowed_idps": ALLOWED_IDPS,
    }
    emit(f"POST {api}/apps")
    emit(json.dumps(create_app_body, indent=2))
    if args.apply:
        status, resp = request(token, "POST", f"{api}/apps", create_app_body)
        emit(f"  -> HTTP {status}")
        emit(json.dumps(resp, indent=2)[:2000])
        if status != 200 and status != 201:
            emit("ABORT: app creation failed")
            OUT.write_text("\n".join(log) + "\n")
            return 1
        new_app = resp["result"]
        new_app_id = new_app["id"]
        new_aud = new_app["aud"]
    else:
        new_app_id = "<would-be-new-app-id>"
        new_aud = "<would-be-new-aud>"

    # ---- Step 2: Create 3 policies ----
    emit("\n## Step 2 — Create 3 policies on the new app")

    policy_specs = [
        {
            "name": "service-token-buzz-mcp",
            "decision": "non_identity",
            "precedence": 1,
            "include": [{"everyone": {}}],  # placeholder; fixed up after stoken created
            "require": [],
            "session_duration": "24h",
        },
        {
            "name": "owner-trusted-mac",
            "decision": "allow",
            "precedence": 2,
            "include": [{"email": {"email": "schreuderdarren@gmail.com"}}],
            "require": [
                {"device_posture": {"integration_uid": POSTURE_DISK_ENCRYPTION_UID}},
                {"device_posture": {"integration_uid": POSTURE_FIREWALL_UID}},
            ],
            "session_duration": "24h",
        },
        {
            "name": "owner-anywhere",
            "decision": "allow",
            "precedence": 3,
            "include": [{"email": {"email": "schreuderdarren@gmail.com"}}],
            "require": [{"geo": {"country_code": "NL"}}],
            "session_duration": "6h",
        },
    ]

    new_policy_ids: dict[str, str] = {}
    for spec in policy_specs:
        # Policies are account-scoped; attach to app via separate step.
        emit(f"  POST {api}/policies  name={spec['name']}")
        if args.apply:
            ps, pr = request(token, "POST", f"{api}/policies", spec)
            emit(f"    -> HTTP {ps}")
            if ps not in (200, 201):
                emit(json.dumps(pr, indent=2)[:1000])
                emit(f"ABORT: policy {spec['name']} creation failed")
                OUT.write_text("\n".join(log) + "\n")
                return 1
            new_policy_ids[spec["name"]] = pr["result"]["id"]
            emit(f"    id={pr['result']['id']}")
        else:
            new_policy_ids[spec["name"]] = f"<would-be-{spec['name']}-id>"

    # ---- Step 3: Attach policies to the new app ----
    emit("\n## Step 3 — Attach 3 policies to the new app")
    if args.apply:
        update_body = {"policies": [{"id": pid} for pid in new_policy_ids.values()]}
        ps, pr = request(token, "PUT", f"{api}/apps/{new_app_id}", update_body)
        emit(f"  PUT {api}/apps/{new_app_id}  -> HTTP {ps}")
        emit(json.dumps(pr, indent=2)[:1500])

    # ---- Step 4: Create new service token, replace `everyone` placeholder in policy 1 ----
    new_token_id = "<would-be-new-token-id>"
    new_token_client_id = "<would-be-client-id>"
    new_token_secret = "<would-be-client-secret>"
    emit("\n## Step 4 — Create new service token, re-pin policy 1's include")
    if not args.skip_new_stoken:
        stoken_body = {
            "name": "buzz-mcp-prod",
            "duration": "forever",
        }
        emit(f"  POST {api}/service_tokens  body={json.dumps(stoken_body)}")
        if args.apply:
            ps, pr = request(token, "POST", f"{api}/service_tokens", stoken_body)
            emit(f"    -> HTTP {ps}")
            emit(json.dumps(pr, indent=2)[:2000])
            if ps in (200, 201):
                new_token_id = pr["result"]["id"]
                new_token_client_id = pr["result"]["client_id"]
                new_token_secret = pr["result"]["client_secret"]
                # Update policy 1 to use this token_id (no duplicate)
                pid1 = new_policy_ids["service-token-buzz-mcp"]
                pol_update = {
                    "name": "service-token-buzz-mcp",
                    "decision": "non_identity",
                    "precedence": 1,
                    "include": [{"service_token": {"token_id": new_token_id}}],
                    "require": [],
                    "session_duration": "24h",
                }
                ps2, pr2 = request(token, "PUT", f"{api}/policies/{pid1}", pol_update)
                emit(f"  PUT policy {pid1}  -> HTTP {ps2}")
                emit(json.dumps(pr2, indent=2)[:1500])
            else:
                emit("  WARN: service token creation failed; policy 1 will keep everyone-include (no one admitted)")

    # ---- Step 5: Edge probe the new app with the new service token ----
    emit("\n## Step 5 — Edge probe")
    edge_status_anon = "?"
    edge_status_authed = "?"
    if args.apply:
        # No auth
        try:
            with urllib.request.urlopen(f"https://{APP_DOMAIN}/_liveness", timeout=10) as r:
                edge_status_anon = f"{r.status}"
        except urllib.error.HTTPError as e:
            edge_status_anon = f"{e.code} (Location: {e.headers.get('Location', 'n/a')})"
        emit(f"  unauthed:  https://{APP_DOMAIN}/_liveness -> {edge_status_anon}")
        # With new service token
        if new_token_client_id.startswith("b"):
            req = urllib.request.Request(
                f"https://{APP_DOMAIN}/_liveness",
                headers={
                    "CF-Access-Client-Id": new_token_client_id,
                    "CF-Access-Client-Secret": new_token_secret,
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    edge_status_authed = f"{r.status}"
            except urllib.error.HTTPError as e:
                edge_status_authed = f"{e.code}"
            emit(f"  authed:    CF-Access-Client-Id={new_token_client_id[:12]}... -> {edge_status_authed}")
        else:
            edge_status_authed = "(skipped — no client_id)"

    verdict = "UNKNOWN"
    if edge_status_authed.startswith("2"):
        verdict = "PASS — service token works on the new app"
    elif edge_status_authed.startswith("4"):
        verdict = "FAIL — service token still rejected at the edge on the new app. Plan B was wrong; switch to WARP-required include for MCP."

    # ---- Step 6: Cleanup status note (actual delete already done in Step 1a) ----
    emit("\n## Step 6 — Cleanup status")
    emit("  Old app + old service token were already deleted in Step 1a (before the new app was created), so there's nothing left to do here.")
    emit("  Step 1a only runs if --skip-delete-old is NOT set, and only when --apply is set.")
    if args.skip_delete_old:
        emit("  --skip-delete-old was passed, so the old app + old token are still alive. Re-run without that flag to remove them.")

    # ---- Summary ----
    emit("\n## Summary")
    emit(f"  new app id:     {new_app_id}")
    emit(f"  new audience:   {new_aud}")
    emit(f"  new token id:   {new_token_id}")
    emit(f"  new client_id:  {new_token_client_id}")
    emit(f"  edge (anon):    {edge_status_anon}")
    emit(f"  edge (authed):  {edge_status_authed}")
    emit(f"  verdict:        {verdict}")
    emit("")
    emit("## Operator follow-up")
    emit("  1. Verify the new app is live at the dashboard URL.")
    emit("  2. Open `https://coreprt.webrnds.com/_liveness` in a browser and confirm the OTP prompt appears (or 200 if WARP enrolled).")
    emit("  3. If verdict=PASS, write the new `client_id` + `client_secret` to `~/.config/coreprt/buzz-mcp.env` (mode 600) and restart any MCP bridge.")
    emit("  4. Rotate `CF_API_TOKEN` in the dashboard → Account → API Tokens. Re-run this script for a clean-cut replacement.")
    emit("  5. Mirror any Access app id / audience / policy changes back into `docs/access-policy.md`.")

    OUT.write_text("\n".join(log) + "\n")
    print(f"\nLog: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
