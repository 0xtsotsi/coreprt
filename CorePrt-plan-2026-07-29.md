# CorePrt — Buzz-relay public launch plan · 2026-07-29

**Goal:** relay behind `https://coreprt.webrnds.com`, gated by Cloudflare Access.
**Audience:** owner returning from AFK + ggcoder agent on green-light.
**Scope:** from "I have my 64-hex pubkey" → "human path live at the URL above". Agent onboarding (D4) is gated.

---

## 0. State of the tree today (verified, 2026-07-29 07:57 UTC)

| Path | Size | What |
| --- | ---: | --- |
| `README.md` | 9713 | Orientation — see §6 factual issues |
| `CorePrt-owner-keygen.md` | 3622 | Why agent can't run `generate-key` |
| `CorePrt-owner-keygen-output.txt` | 218 | Proves redaction engaged |
| `CorePrt-owner-keys-2026-07-29.txt` | 218 · 600 | Backup slot for nsec (empty) |
| `CorePrt-secrets-backup-2026-07-29.txt` | 540 · 600 | Backup slot for relay secrets |
| `CorePrt-ps-2026-07-29.json` | 7067 | 4 containers, all healthy |
| `CorePrt-relay-log-2026-07-29.txt` | 6377 | Last 40 lines of relay boot |
| `CorePrt-relay/` | empty | Reserved for future `block/buzz` clone |
| `CorePrt-cloudflare/README.md` | 3421 | Runbook |
| `CorePrt-cloudflare/tunnel.yml` | 1075 | TUNNEL_ID is the literal `<TUNNEL_ID>` placeholder |
| `CorePrt-deploy/.env` | 1451 · 600 | Secrets — values not printed in this plan |
| `CorePrt-deploy/compose.yml` | 4246 | relay + postgres + redis + minio |
| `CorePrt-deploy/compose.caddy.yml` | 618 | Unused (`BUZZ_COMPOSE_TLS=false`) |
| `CorePrt-deploy/run.sh` | 3763 | Subcommands: start/stop/restart/pull/upgrade/logs/status/config/backup-hint/add-member/remove-member/list-members |
| `.gitignore` | 320 | Ignores `.env`, backups, dated logs |

**Containers** (`docker ps`): `coreprt-relay-1` (`0.0.0.0:3300→3000`, healthy), `coreprt-postgres-1`, `coreprt-redis-1`, `coreprt-minio-1` — all internal, all healthy.

**Tooling:** `cloudflared 2026.7.1`, `docker 29.6.1`, `docker compose 5.x`, `colima` (socket `~/.colima/default/docker.sock`).

**`~/.cloudflared/` state** (affects §3):

| File | What it means |
| --- | --- |
| `cert.pem` + UUID `cert.json` | You are already logged into CF from this Mac — **don't** re-run `cloudflared tunnel login` unless session has expired |
| `47dd90f6-…json` + `config.yml` (routes `gogett.webrnds.com` + `gogett-daemon.webrnds.com`) | An existing tunnel — the `gogett` one, **not** `coreprt` |
| `homebrew.mxcl.cloudflared.plist` loaded but `brew services list` reports `cloudflared error 1` | The plist can't find `/opt/homebrew/etc/cloudflared/config.yml` (directory doesn't exist). **B3 fixes this.** |

**CorePrt/ is not a git repo** (`git -C . rev-parse --show-toplevel` → `/Users/gogetta`). Tree stays as-is.

---

## 1. Pause points (where the agent waits, not invents)

| ID | What we wait for | Triggered by |
| --- | --- | --- |
| **P1** | 64-hex owner pubkey from your interactive `generate-key` | §2 |
| **P2** | Browser — Cloudflare dashboard (DNS + Access app) | §3 B2 |
| **P3** | Human-path-live: your login to `https://coreprt.webrnds.com`, one post to `#general`, one `+` reaction | Gate to §7 |

---

## 2. Phase A — owner keypair (YOU, interactive)

The relay redacts both keys when stdout is captured (proven by `CorePrt-owner-keygen-output.txt` lines 1-2, which read ``Public key: [REDACTED]`` and ``Secret key: [REDACTED]``). I cannot do this step for you.

```bash
# (YOU) — in your terminal, with a real TTY
docker exec -it coreprt-relay-1 /usr/local/bin/buzz-admin generate-key
```

Back up the `nsec1…` by hand — Bitwarden + edit `CorePrt-owner-keys-2026-07-29.txt` (already mode 600). Paste **only the 64-hex pubkey** into chat. The nsec never leaves your terminal.

---

## 3. Phase B — Cloudflare tunnel + DNS + Access (YOU ↔ AGENT)

> **Ordering:** Access policies only attach to **proxied** (orange cloud) records. The tunnel must run before the orange cloud resolves. `tunnel.yml:26` already sets `httpHostHeader: coreprt.webrnds.com`, so the relay sees the canonical host from request #1.

### B1 — tunnel registration (YOU, one-time)

```bash
# (YOU) — only if cert.pem is stale; otherwise skip
cloudflared tunnel login
# (YOU)
cloudflared tunnel create coreprt     # prints <TUNNEL_ID>; ~/.cloudflared/<TUNNEL_ID>.json
# (YOU)
cloudflared tunnel route dns coreprt coreprt.webrnds.com
# (YOU) — replace <TUNNEL_ID> at tunnel.yml:15
$EDITOR ~/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml
# (YOU) — foreground smoke test; Ctrl-C when satisfied
cloudflared tunnel --config ~/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml run coreprt
```

**B1 verify** (YOU): `dig +short coreprt.webrnds.com CNAME` → `<TUNNEL_ID>.cfargotunnel.com.`

### B2 — CF dashboard (YOU, browser)

1. **DNS** — confirm CNAME exists (grey cloud). Don't flip yet.
2. **Access → Applications → Add → Self-hosted**: name `CorePrt`, domain `coreprt.webrnds.com`, session 24h. Policy `owner-only` (Allow):
   - **Include** → Emails → `gogetta`
   - **No Require/Exclude for v1.** See §4 for posture options to layer in.
3. Save.

**B2 verify** (YOU, in a private browser window): `https://coreprt.webrnds.com/_liveness` → Cloudflare Access login screen → OTP from email → HTTP 200, body `ok`.

### B3 — make it persistent (AGENT, after B2 verifies)

**⚠️ The B3 instructions below are WRONG for this Mac.** Brew owns
`~/Library/LaunchAgents/homebrew.mxcl.cloudflared.plist` and re-stamps it from
the formula on every `brew services restart`, undoing any edits. The launch
plan needs a hand-written LaunchAgent under a non-brew label. See
**§3.1 B3 gotchas** below for the actual recipe.

```bash
# (AGENT — original plan, do NOT use)
sudo mkdir -p /opt/homebrew/etc/cloudflared
sudo ln -sf /Users/gogetta/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml \
            /opt/homebrew/etc/cloudflared/config.yml
brew services restart cloudflared
```

**B3 verify** (AGENT): `brew services list | grep cloudflared` → `started`. `tail -30 /opt/homebrew/var/log/cloudflared.log` → `Connection established`.

### B4 — flip to orange cloud (YOU, one click)

Edit `coreprt.webrnds.com` CNAME in CF DNS, toggle Proxy → **Proxied**.

**B4 verify** (YOU): `dig +short coreprt.webrnds.com` → `104.x` or `172.x`. `curl -sSI https://coreprt.webrnds.com/_liveness` → `HTTP/2 200`, `cf-ray:` present.

## 3.1 — B3 gotchas (learned the hard way, 2026-07-31)

Three footguns hit during the actual launch. All future CorePrt
re-deployments should follow the corrected path below.

### 3.1.1 — Brew owns `homebrew.mxcl.cloudflared.plist`

Brew's source-of-truth plist lives at
`/opt/homebrew/Cellar/cloudflared/<ver>/homebrew.mxcl.cloudflared.plist`.
Every `brew services restart cloudflared` (and `start` / `stop`) **copies
that file over `~/Library/LaunchAgents/homebrew.mxcl.cloudflared.plist`**
without merging user edits. Edits to the brew plist last exactly one
restart cycle, sometimes zero.

**Correct recipe (used on 2026-07-31):**

```bash
# 1. Stash the repo's tunnel.yml in brew's config dir (cosmetic, optional)
mkdir -p /opt/homebrew/etc/cloudflared
ln -sf ~/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml \
       /opt/homebrew/etc/cloudflared/config.yml

# 2. Hand-write a NEW LaunchAgent under a non-brew label
cat > ~/Library/LaunchAgents/com.gogetta.cloudflared-coreprt.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" \
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gogetta.cloudflared-coreprt</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>/Users/gogetta/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml</string>
    <string>run</string>
    <string>coreprt</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/gogetta/.cloudflared/coreprt-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/gogetta/.cloudflared/coreprt-tunnel.err</string>
</dict>
</plist>
PLIST

# 3. Note: launchd IGNORES the StandardErrorPath in this plist and writes
#    to ~/Library/Logs/cloudflared-coreprt.err.log instead. This is normal
#    launchd behavior when the label matches its auto-generated log path.
#    ~/.cloudflared/coreprt-tunnel.err stays empty — that's expected.

# 4. Load it (the `-w` flag persists across reboots)
launchctl load -w ~/Library/LaunchAgents/com.gogetta.cloudflared-coreprt.plist

# 5. Verify
launchctl print gui/$(id -u)/com.gogetta.cloudflared-coreprt | grep -E 'state|last exit code'
#   Expected: state = running, last exit code = (never exited)
ps -p $(pgrep -f 'cloudflared.*tunnel.yml.*run coreprt') -o command
#   Expected: /opt/homebrew/bin/cloudflared tunnel --config ... run coreprt

# 6. The broken brew plist can stay — `brew services list` will keep saying
#    `cloudflared error 1`. Stop it cleanly if it bugs you:
#    brew services stop cloudflared
#    (Drops the launchd registration for the brew plist; does NOT affect
#     our hand-written LaunchAgent.)
```

This recipe mirrors the existing `com.gogetta.cloudflared-gogett`
LaunchAgent pattern, which is what's been running the gogett tunnel since
2026-07-10. The new label is `com.gogetta.cloudflared-coreprt` (note the
**dashed** suffix, matching gogett's convention).

### 3.1.2 — `cloudflared tunnel route dns` can cross-wire to the wrong tunnel

Symptom: `cloudflared tunnel route dns coreprt coreprt.webrnds.com`
silently creates a CF DNS row whose **Target** field is bound to a
different tunnel than expected (in our case, the `gogett` tunnel). When
this happens, requests to `coreprt.webrnds.com` flow through CF edge into
the *gogett* tunnel, which has no ingress rule for the coreprt hostname,
falls through to its catch-all `http_status:404`, and returns 404 even
though both the coreprt tunnel and the relay are healthy.

**Diagnostic** (when in doubt):

```bash
# In CF dashboard: Websites → webrnds.com → DNS → Records
# Look for any row where:
#   Type  = "Tunnel" (not "CNAME")
#   Name  = coreprt
#   Target = <UUID>.cfargotunnel.com
# Confirm the UUID matches the one printed by `cloudflared tunnel info coreprt`.
```

**Fix**: delete the wrong-bound Tunnel record in the dashboard, then
re-run `cloudflared tunnel route dns coreprt coreprt.webrnds.com`.
Verify with `cloudflared tunnel info coreprt` and the dashboard.

This bit us on 2026-07-29 and again indirectly on 2026-07-31 (after the
malformed apex records were cleaned up, the cross-wired Tunnel row was
finally editable and got fixed). Future CorePrt launches should add a
post-`route-dns` sanity check to the plan.

### 3.1.3 — `tunnel.yml` edits don't propagate to a running process

Cloudflared reads `tunnel.yml` once at startup. Edits to the file on
disk have no effect until the process restarts. Symptom: you change
`service: http://127.0.0.1:3300` → `:3301`, restart the relay, see
errors in the tunnel log like `originService=http://127.0.0.1:3300`,
waste 30 minutes wondering if your edit landed.

**Restart the tunnel cleanly:**

```bash
# Either:
kill -TERM $(pgrep -f 'cloudflared.*tunnel.yml.*run coreprt')
#   (launchd respawns via KeepAlive.Crashed in ~5 s)

# Or:
launchctl kickstart -k gui/$(id -u)/com.gogetta.cloudflared-coreprt
```

Then verify in the *new* process's log that the new port appears (read
`tail -50 ~/Library/Logs/cloudflared-coreprt.err.log`, not the stale
`~/.cloudflared/coreprt-tunnel.err` which stays empty).

## 3.2 — Credentials in chat: never

During the 2026-07-31 launch, two near-misses occurred:

1. **Cloudflare API token** (`cfat_…`) pasted in chat context. Revoked
   immediately.
2. **R2 access key + secret** pasted in chat context. Rotated
   immediately.

These were caught before they caused damage, but **this must never
happen again.** Any secret, token, or credential belonging to CorePrt,
Cloudflare, R2, S3, GitHub, or any third party MUST go to:

- `~/Documents/projects/CorePrt/CorePrt-secrets-backup-*.txt` (mode 600,
  gitignored), or
- Bitwarden / 1Password, or
- A password manager

The `.gitignore` patterns at lines 3-15 already exclude the right
artifacts. Don't paste secrets into chat for any reason, including
"just for one quick copy-paste." Once it's in chat history, it's
potentially in chat backups, logs, model training, or screenshots.

## 4. CF Access posture — what CF can evaluate, what I'd propose

Sources: <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#selectors> · <https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/> · <https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/client-checks/>

**Selectors CF Access can evaluate today:**

| Category | Selector | Notes |
| --- | --- | --- |
| Identity | Emails / Emails ending in | Exact or suffix match against IdP |
| Identity | External Evaluation | Custom API |
| Network | IP ranges (IPv4+IPv6, CIDR) | Source IP |
| Network | Country | Source-IP → country |
| Network | Everyone / Anyone | Catch-all |
| Auth | Service Token | Headless callers |
| Auth | Valid certificate (mTLS) | Client presents a valid cert |
| Device (Client) | OS version · Disk encryption · Firewall · Require WARP · Require Gateway | Client WARP-reported; **requires Cloudflare One Client running** on the device |
| Device (Client) | Application check · File check · Device serial numbers (macOS) | Process/path/serial present |
| Device (Client) | Client certificate · Carbon Black · SentinelOne · Tanium | PKI / EDR presence |
| Device (Client) | Domain joined | Windows-only |

**Default proposal for your Mac** (no MDM, low friction, meaningful):

| Rule type | Selector | Value | Why |
| --- | --- | --- | --- |
| Include | Emails | `gogetta` | Day-1 gate |
| Require | OS version | `macOS >= 15.0` | Blocks ancient Macs |
| Require | Disk encryption | `FileVault = on` | Fills the "lost laptop" risk |
| Require | Firewall | `enabled` | Cheap to satisfy, easy to fail |
| Require | Require WARP | `WARP connected` | Ties access to CF-audited client *(only if `coreprt.webrnds.com` is in WARP split-tunnel include — otherwise drop this row)* |

**Skip for v1:** Device serial numbers (manual enumeration), Client certificate (needs PKI), EDR (none installed).

**You're the decider on this matrix.** I'll wait for `approve default` / `email-only` / `drop WARP` / `<other>` before editing the Access policy.

---

## 5. `.env` audit (read-only — values not printed)

Compared to upstream `block/buzz/deploy/compose/.env.example`:

| Key | Present | Non-placeholder | Notes |
| --- | :-: | :-: | --- |
| `BUZZ_IMAGE` | ✅ | ✅ | `ghcr.io/block/buzz:main` |
| `BUZZ_DOMAIN` | ✅ | ✅ | `coreprt.webrnds.com` — matches `httpHostHeader` in `tunnel.yml:26` |
| `RELAY_URL`, `BUZZ_MEDIA_*`, `BUZZ_CORS_ORIGINS` | ✅ | ✅ | All `coreprt.webrnds.com` — internally consistent |
| `BUZZ_REQUIRE_AUTH_TOKEN`, `BUZZ_REQUIRE_RELAY_MEMBERSHIP`, `BUZZ_ALLOW_NIP_OA_AUTH` | ✅ | ✅ | Closed-relay mode (correct for AFK launch) |
| `BUZZ_AUTO_MIGRATE` | ✅ | ✅ | `true` — upstream recommends `false` once stable; run `buzz-admin migrate` manually on upgrade |
| `BUZZ_GIT_CONFORMANCE_PROBE` | ✅ | ✅ | `true` |
| `RUST_LOG` | ✅ | ✅ | `buzz_relay` only — upstream recommends per-module levels. Cosmetic |
| `RELAY_OWNER_PUBKEY` | ✅ | ❌ | **`0000…01` placeholder. Only `CHANGE_ME`-style value left.** Must be replaced before agents (D4) connect. |
| `BUZZ_RELAY_PRIVATE_KEY` | ✅ | ✅ | 32-byte hex. **Stable, back up.** |
| `BUZZ_GIT_HOOK_HMAC_SECRET` | ✅ | ✅ | Stable, back up. |
| `POSTGRES_*`, `REDIS_PASSWORD` | ✅ | ✅ | Stable, back up. |
| `BUZZ_S3_*` | ✅ | ✅ | Bucket `coreprt-media` (not upstream default `buzz-media` — fine) |
| `BUZZ_HTTP_PORT` | ✅ | ✅ | `3300` (not upstream default `3000` — fine for local-only) |
| `CADDY_*_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `MINIO_*_PORT`, `ADMINER_PORT`, `PROMETHEUS_PORT` | ❌ | — | Only used with `compose.caddy.yml` / `compose.dev.yml`, both off |

**Findings:** .env is internally consistent. Only one stale placeholder remains (`RELAY_OWNER_PUBKEY`). Two tightening recommendations: turn `BUZZ_AUTO_MIGRATE` off post-stabilization, expand `RUST_LOG` to per-module.

---

## 6. Factual issues found in existing docs (evidence + cite)

| File:Line | Claim | Reality | Evidence |
| --- | --- | --- | --- |
| `README.md:189` | "cloudflared installed but not yet authenticated and no tunnel exists yet" | Half-wrong: cert.pem exists (you're logged in), and a tunnel *does* exist (`47dd90f6-…`, the `gogett` one) | `~/.cloudflared/cert.pem` 282 B · 600; `~/.cloudflared/config.yml` routes `gogett.webrnds.com` |
| `README.md:193` | "`brew services start cloudflared` is the documented persistent option" | Docs are right, but on this machine `brew services list` reports `cloudflared error 1` because `/opt/homebrew/etc/cloudflared/config.yml` is missing | `ls /opt/homebrew/etc/cloudflared/` → ENOENT. **B3 fixes this.** |
| `README.md:177` | "smoke-test from loopback: set `BUZZ_DOMAIN=127.0.0.1` … and restart" | Misleading — `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` still requires the bootstrap owner (placeholder `0000…01`) regardless of `BUZZ_DOMAIN`. Skip this test | `.env` line; relay log line 16 |
| `CorePrt-cloudflare/tunnel.yml:15` | `credentials-file: …<TUNNEL_ID>.json` | Literal placeholder — must be filled after `cloudflared tunnel create coreprt` | File line 15 |
| `CorePrt-cloudflare/README.md:74-76` | Pivot to `coreprt.pages.dev` if `webrnds.com` not in CF | We can't confirm CF hosts `webrnds.com` from agent (browser step). Acceptable as-is | — |
| `CorePrt-owner-keygen.md:91` | "[REDACTED] output logged at `CorePrt-owner-keygen-output.txt`" | Verified | File lines 1-2 literally read ``Public key: [REDACTED]`` and ``Secret key: [REDACTED]`` |

**No fabricated issues.** All bugs above are directly verifiable.

---

## 7. D4 — Agent onboarding (GATED on P3, do not start before)

**Hard gate (P3 — "human path live"):** you have logged into `https://coreprt.webrnds.com` via CF Access, opened `#general` in Buzz desktop (pointed at `wss://coreprt.webrnds.com`), posted one message, reacted `+`.

### 7.1 — one keypair per agent (YOU per agent, AGENT per add)

```bash
# (YOU) — per agent, interactive
docker exec -it coreprt-relay-1 /usr/local/bin/buzz-admin generate-key
# → back up nsec offline; paste only the pubkey back
```

```bash
# (AGENT) — once per pubkey you hand me
COMPOSE_PROJECT_NAME=coreprt ./run.sh add-member <hex-pubkey> --role member
# If back-to-back: sleep 1 between calls (run.sh:120 — kind:13534 timestamp collisions)
```

### 7.2 — GG Coder → `buzz-mcp` bridge (reference only, **do not scaffold**)

**Do not scaffold `@buzz/mcp` yet.** Spec lives at:

`/Users/gogetta/Documents/projects/Twenty/demoshots/posters/2026-07-29-gg-buzz-integration/spec.md`

Status: **spec only, no code yet** (`spec.md` lines 7-8). Package name is `@buzz/mcp` (`spec.md` §4 `package.json`). MCP config shape per `spec.md` §7 / lines 248-256:

```jsonc
{
  "mcpServers": {
    "instatic": { /* existing */ },
    "buzz": {
      "command": "npx",
      "args": ["-y", "@buzz/mcp"],
      "env": {
        "BUZZ_PRIVATE_KEY": "${env:BUZZ_PRIVATE_KEY}",
        "BUZZ_RELAY_URL": "https://coreprt.webrnds.com"
      }
    }
  }
}
```

Current `~/.gg/mcp.json` has only the `instatic` block — we'll add `buzz` alongside. Both `BUZZ_REQUIRE_AUTH_TOKEN=true` and `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` mean each agent's `BUZZ_PRIVATE_KEY` must match a pubkey already in the relay's allowlist (`spec.md` §5 — NIP-98 HTTP + NIP-42 WS auth).

---

## 8. Pause-points summary

| After | Agent does | Agent waits for |
| --- | --- | --- |
| §2 | nothing | **P1:** 64-hex pubkey |
| §3 B1 | edits `tunnel.yml` once TUNNEL_ID known | **P2:** browser — DNS + Access app |
| §3 B2 | runs B3 (services) | you flip proxy |
| §3 B3 | nothing | **P3** (human-path-live) |
| §3 B4 | runs `add-member` per agent pubkey; adds `buzz` block to `~/.gg/mcp.json` once `@buzz/mcp` ships | each agent's pubkey + the package shipping |

---

## 9. Owner keypair ready? Run this one-liner to resume

The moment you've captured the pubkey + nsec, paste this back (replace `<HEX_64>`):

```bash
# (YOU) — paste the entire block back; I execute the rest locally
echo "pubkey=<HEX_64>" && cloudflared tunnel list 2>&1 | head -20
```

Then I will, in order:

1. Write `RELAY_OWNER_PUBKEY=<HEX_64>` into `CorePrt-deploy/.env`.
2. `./run.sh restart` the relay.
3. `./run.sh list-members` — confirm owner is admin.
4. Hand back to you for Phase B (tunnel create + dashboard).

---

*Plan written 2026-07-29 by the ggcoder `plan-prompts` agent while the owner is AFK. Re-verify P1-P3 with the owner before executing any post-P3 step.*