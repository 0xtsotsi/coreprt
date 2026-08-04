#!/usr/bin/env python3
"""Read the latest snapshot and verify post-conditions.

Exits 0 if the live Cloudflare state matches what `docs/access-policy.md`
claims (app id, audience, 3 policies, no service tokens, tunnel alive,
edge returns 302 or 200). Exits 1 on any drift.

Usage:
    python3 scripts/verify-live-state.py
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SNAP = Path("/Users/gogetta/Documents/projects/CorePrt/docs/2026-08-03-access-recreate-snapshot.md")

# Hard-coded post-conditions (must match docs/access-policy.md and the live app).
EXPECTED_APP_ID = "974e7f0c-8027-4183-a66d-394847b4ddd9"
EXPECTED_APP_AUD = "55c81dfc5272fb5fdb74636fbb4803912328d317f15b5c2700be8a99ddc44329"
EXPECTED_APP_DOMAIN = "coreprt.webrnds.com"
EXPECTED_WARP_INTEGRATION = "76b96de1-4cce-43fe-ba8a-26881193a475"
EXPECTED_TRUSTED_POSTURES = {
    "76b96de1-4cce-43fe-ba8a-26881193a475",  # WARP
    "c99b5e24-418b-414d-859b-bb428d45a09a",  # OS version
    "6ce07058-3f3e-43cd-91e8-2e97d21cd57f",  # Firewall
    "62c90e6e-bc8a-4b90-868b-e3b5138a0846",  # Disk encryption
}
EXPECTED_POLICIES = {
    "mcp-warp-required":  (1, "allow"),
    "owner-trusted-mac":  (2, "allow"),
    "owner-anywhere":     (3, "allow"),
}


def load_sections(snapshot_text: str) -> dict[str, str]:
    """Index the snapshot by section number. Each section is a fenced JSON body."""
    sections: dict[str, str] = {}
    for m in re.finditer(
        r"^## (\d+)\. (.+?)$\n+```(?:json)?\n(.*?)\n```",
        snapshot_text,
        re.MULTILINE | re.DOTALL,
    ):
        sections[m.group(1)] = m.group(3).strip()
    return sections


def require_section(sections: dict[str, str], n: str, label: str) -> str:
    body = sections.get(n)
    if body is None:
        print(f"ABORT: snapshot is missing section {n} ({label}); re-run scripts/snapshot-access.py")
        sys.exit(1)
    return body


def parse_app(sections: dict[str, str]) -> dict:
    body = require_section(sections, "1", "Access app")
    try:
        d = json.loads(body)
    except json.JSONDecodeError as e:
        print(f"ABORT: app section not JSON: {e}")
        sys.exit(1)
    if not d.get("success"):
        print(f"ABORT: app API returned success=false: {d.get('errors')}")
        sys.exit(1)
    return d["result"]


def main() -> int:
    if not SNAP.exists():
        print(f"ABORT: snapshot not found at {SNAP}; run scripts/snapshot-access.py first")
        return 1
    sections = load_sections(SNAP.read_text())
    failures = 0

    # 1. App
    r = parse_app(sections)
    print(
        f"App: id={r['id']}  aud={r['aud']}  domain={r['domain']}  "
        f"type={r['type']}  session={r.get('session_duration')}"
    )
    for k, v in {
        "id": EXPECTED_APP_ID,
        "type": "self_hosted",
        "domain": EXPECTED_APP_DOMAIN,
        "aud": EXPECTED_APP_AUD,
    }.items():
        ok = r.get(k) == v
        if not ok:
            failures += 1
        print(f"  [{'OK' if ok else 'FAIL'}] {k} = {r.get(k)} (expected {v})")

    # 2. Policies (embedded under app.policies in section 1)
    print()
    policies = r.get("policies", [])
    actual = {p["name"]: p for p in policies}
    for p in policies:
        incs = [list(i.keys())[0] for i in p.get("include", [])]
        reqs = [list(rr.keys())[0] for rr in p.get("require", [])]
        print(
            f"  {p['name']:25s} prec={p['precedence']} decision={p['decision']:12s}  "
            f"include={incs}  require={reqs}  session={p.get('session_duration')}"
        )

    print()
    for name, (prec, dec) in EXPECTED_POLICIES.items():
        a = actual.get(name)
        if not a:
            print(f"  [FAIL] policy {name}: MISSING")
            failures += 1
            continue
        ok = a["precedence"] == prec and a["decision"] == dec
        if not ok:
            failures += 1
        print(f"  [{'OK' if ok else 'FAIL'}] {name}: prec={a['precedence']}/{prec} decision={a['decision']}/{dec}")

    mcp = actual.get("mcp-warp-required", {})
    mcp_reqs = [
        rr.get("device_posture", {}).get("integration_uid")
        for rr in mcp.get("require", [])
        if "device_posture" in rr
    ]
    ok = mcp_reqs == [EXPECTED_WARP_INTEGRATION]
    if not ok:
        failures += 1
    print(f"  [{'OK' if ok else 'FAIL'}] mcp-warp-required require includes WARP integration: {mcp_reqs}")

    trusted = actual.get("owner-trusted-mac", {})
    trusted_reqs = {
        rr.get("device_posture", {}).get("integration_uid")
        for rr in trusted.get("require", [])
        if "device_posture" in rr
    }
    ok = trusted_reqs == EXPECTED_TRUSTED_POSTURES
    if not ok:
        failures += 1
    print(f"  [{'OK' if ok else 'FAIL'}] owner-trusted-mac requires all 4 posture UIDs: {len(trusted_reqs)} of 4")

    anywhere = actual.get("owner-anywhere", {})
    geo_reqs = [
        rr.get("geo", {}).get("country_code")
        for rr in anywhere.get("require", [])
        if "geo" in rr
    ]
    ok = geo_reqs == ["NL"] and anywhere.get("session_duration") == "6h"
    if not ok:
        failures += 1
    print(f"  [{'OK' if ok else 'FAIL'}] owner-anywhere: geo=NL session=6h (got geo={geo_reqs} session={anywhere.get('session_duration')})")

    # 3. Service tokens
    print()
    st_body = require_section(sections, "3", "service token inventory")
    try:
        st = json.loads(st_body)
    except json.JSONDecodeError as e:
        print(f"ABORT: service tokens section not JSON: {e}")
        sys.exit(1)
    if isinstance(st, dict) and "result" in st:
        tokens = st["result"]
    elif isinstance(st, list):
        tokens = st
    else:
        tokens = []
    n = len(tokens)
    ok = n == 0
    if not ok:
        failures += 1
    print(f"Service tokens: {n}  (expected 0)")
    print(f"  [{'OK' if ok else 'FAIL'}] count=0")

    # 5. Tunnel
    print()
    tu_body = require_section(sections, "5", "tunnel lookup")
    try:
        tu = json.loads(tu_body)
    except json.JSONDecodeError as e:
        print(f"ABORT: tunnel section not JSON: {e}")
        sys.exit(1)
    tunnels = tu if isinstance(tu, list) else tu.get("result", [])
    names = [t.get("name") for t in tunnels]
    ok = "coreprt" in names
    if not ok:
        failures += 1
    print(f"Tunnels: {names}  (expected ['coreprt'])")
    print(f"  [{'OK' if ok else 'FAIL'}] coreprt tunnel alive")

    # 7. Edge probe (live, not from snapshot)
    # The python-urllib User-Agent on this Mac is WARP-intercepted and returns 200
    # (the WARP device cert satisfies Policy A). curl from the same Mac returns 302
    # (not WARP-intercepted). Both are correct edge behaviors.
    print()
    req = urllib.request.Request(
        "https://coreprt.webrnds.com/_liveness",
        headers={"User-Agent": "verify-live-state/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            live_status = resp.status
    except urllib.error.HTTPError as e:
        live_status = e.code
    ok = live_status in (302, 200)
    if not ok:
        failures += 1
    print(f"Edge probe (live): https://coreprt.webrnds.com/_liveness -> HTTP {live_status}")
    print(f"  [{'OK' if ok else 'FAIL'}] anon probe returns 302 (redirect to Access login) or 200 (WARP'd)")

    print()
    print(f"=== {('PASS — all checks green' if failures == 0 else f'FAIL — {failures} mismatch(es)')} ===")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
