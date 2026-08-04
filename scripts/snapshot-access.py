#!/usr/bin/env python3
"""
Pre-destroy snapshot of the CorePrt Access app under the (compromised) CF_API_TOKEN.
Writes docs/2026-08-03-access-recreate-snapshot.md.

Operator-only. The output file ends up in the working tree but is expected to be
amended into the commit only AFTER the operator has rotated CF_API_TOKEN — until
then the snapshot is itself produced under compromised auth and should be
considered staging.
"""
from __future__ import annotations
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENV_FILE = REPO / "CorePrt-deploy" / ".env"
OUT = REPO / "docs" / "2026-08-03-access-recreate-snapshot.md"

ACCT = "fb883e97a51c4525501a42a6a06b7a46"
ZONE = "788487334a7810a9a377e254c0155b25"
# Current app id (as of 2026-08-03 recreate). Override via env SNAPSHOT_APP_ID if needed.
APP_ID = os.environ.get("SNAPSHOT_APP_ID", "974e7f0c-8027-4183-a66d-394847b4ddd9")
APP_DOMAIN = "coreprt.webrnds.com"


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


def get(token: str, url: str) -> tuple[int, dict | str]:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            body = json.loads(body)
        except Exception:
            pass
        return e.code, body


def edge_probe(domain: str) -> str:
    import urllib.request
    try:
        with urllib.request.urlopen(f"https://{domain}/_liveness", timeout=10) as r:
            return f"{r.status} (final URL: {r.url})"
    except urllib.error.HTTPError as e:
        return f"{e.code} (Location: {e.headers.get('Location', 'n/a')})"


def fmt(d) -> str:
    return json.dumps(d, indent=2, sort_keys=True)


def main() -> int:
    env = load_env(ENV_FILE)
    token = env.get("CF_API_TOKEN")
    if not token:
        print("CF_API_TOKEN missing in .env", file=sys.stderr)
        return 2

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    _, app = get(token, f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/access/apps/{APP_ID}")
    _, app_full = get(token, f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/access/apps/{APP_ID}?expand=policies")
    _, stokens = get(token, f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/access/service_tokens")
    _, posture = get(token, f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/devices/posture/integrations")
    _, tunnels = get(token, f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/cfd_tunnel?name=coreprt")
    _, dns = get(token, f"https://api.cloudflare.com/client/v4/zones/{ZONE}/dns_records?type=CNAME&name={APP_DOMAIN}")

    md: list[str] = []
    md.append(f"# CorePrt — Access app recreate · pre-destroy snapshot · {ts}\n")
    md.append("**Trigger:** The current Access app `c3f1f0da-…` and all artifacts issued under `CF_API_TOKEN` inherit a compromised auth context (the token was posted in chat; per CLAUDE.md gotcha `Any credential that appeared in chat is compromised.`).\n")
    md.append("**This is a Plan B staging rebuild.** The rebuild is performed with the same (compromised) token so we have a known-good working Access state to point at. The operator MUST rotate `CF_API_TOKEN` in the Cloudflare dashboard and re-run the rebuild before this is production-clean. See `docs/2026-08-03-access-recreate.md` Step 6 for the post-rotation re-run.\n")
    md.append(f"**Account:** `{ACCT}`  ")
    md.append(f"**Zone:**   `{ZONE}` (`webrnds.com`)  ")
    md.append(f"**Domain:** `{APP_DOMAIN}`\n")
    md.append("---\n")

    def section(n: str, title: str, payload):
        md.append(f"## {n}. {title}\n")
        if isinstance(payload, (dict, list)):
            md.append("```json")
            md.append(fmt(payload))
            md.append("```\n")
        else:
            md.append("```")
            md.append(str(payload))
            md.append("```\n")

    section("1", f"Current Access app `{APP_ID}`", app)

    policies = []
    if isinstance(app_full, dict) and app_full.get("success"):
        policies = app_full.get("policies", [])
    section("2", "Policies attached (in precedence order)", policies if policies else "(none returned by API)")

    section("3", "Service-token inventory (underscored route)", stokens)

    if isinstance(posture, dict) and posture.get("success"):
        section("4", "Posture integrations (built-in)", posture)
    else:
        section("4", "Posture integrations (built-in)", f"endpoint not granted on this token (HTTP {posture[0] if isinstance(posture, tuple) else '?'}); integration list is also readable via /devices/posture")

    section("5", "Tunnel lookup (must remain bound to the same `coreprt` tunnel)", tunnels)
    section("6", f"DNS — CNAME for {APP_DOMAIN}", dns)

    md.append("## 7. Edge probe (sanity)\n")
    md.append("```")
    md.append(f"https://{APP_DOMAIN}/_liveness -> {edge_probe(APP_DOMAIN)}")
    md.append("```\n")

    md.append("## 8. Hashes for change-detection\n")
    md.append("```")
    md.append(f"app_id:        {APP_ID}")
    md.append(f"app_sha256:    {hashlib.sha256(fmt(app).encode()).hexdigest()}")
    if isinstance(stokens, dict) and stokens.get("success"):
        md.append(f"stokens_count: {len(stokens.get('result', []))}")
    md.append("```\n")

    md.append("---\n")
    md.append("## 9. Operator action checklist (post-snapshot)\n")
    md.append("1. Verify the snapshot looks right (all 6 sections populated, no `Missing X-Auth-…` errors).")
    md.append("2. Proceed to `docs/2026-08-03-access-recreate.md` Step 1: delete the old app.")
    md.append("3. After the new app is live and verified, rotate `CF_API_TOKEN` in Cloudflare dashboard → Account → API Tokens, then re-run `scripts/snapshot-access.py` and `scripts/recreate-access-app.py` to produce a clean-cut replacement.\n")

    OUT.write_text("\n".join(md))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
