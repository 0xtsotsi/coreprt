# CorePrt — self-host Buzz on a Mac, expose via Cloudflare, login from anywhere

A workspace where humans and agents build together, on a relay you own.

**Product codename:** CorePrt (local alias for `block/buzz`).
**Public URL (planned):** `https://coreprt.webrnds.com` — Cloudflare-tunneled, email-locked.
**Local URL (works today):** `http://127.0.0.1:3300` — relay reachable on the loopback only.
**First boot:** 2026-07-29 07:48 UTC — relay passed `_liveness` and rejected unknown hosts with the canonical error.

---

## Folder layout

```
CorePrt/
├── README.md                                # this file
├── CorePrt-deploy/                          # the relay + dependencies (docker compose)
│   ├── .env                                 # secrets — chmod 600 — DO NOT COMMIT
│   ├── compose.yml                          # relay, postgres, redis, minio
│   ├── compose.caddy.yml                    # optional — only when BUZZ_COMPOSE_TLS=true
│   ├── run.sh                               # upstream-shaped bootstrap, member admin
│   └── CorePrt-ps-2026-07-29.json           # snapshot of running services
├── CorePrt-relay/                           # local clone of block/buzz (not vendored; see "Source layout")
├── CorePrt-cloudflare/                      # cloudflared tunnel config + Access policy
├── CorePrt-secrets-backup-2026-07-29.txt    # offline secrets backup — DO NOT COMMIT
└── CorePrt-relay-log-2026-07-29.txt         # last 40 lines of relay boot log
```

## Source layout

The relay image (`ghcr.io/block/buzz:main`) is prebuilt and runs in
Docker. The source for that image is cloned into `CorePrt-relay/` as
a sibling working tree — **not vendored into this repo and not a
git submodule**. The clone has its own `.git/`, ignored by this
repo's `.gitignore`. To refresh:

```bash
cd CorePrt-relay
git pull origin main
```

The clone gives you:
- A reference to upstream commits (`485d03a` at 2026-07-29).
- The ability to audit the relay code against what the container runs.
- A source tree to build from if GHCR pull limits ever bite (40-min
  compile on Apple Silicon, per upstream docs).

It does **not** give you:
- Hot-reload of the running container (the container uses the
  prebuilt image, not the clone).
- Pinned upstream versions. The clone tracks `main`; pin by tag if
  you need reproducibility.

Cloudflare Access posture is documented in
[`docs/access-policy.md`](docs/access-policy.md). The launch plan
that bootstrapped this repo lives at
[`docs/2026-07-29-launch.md`](docs/2026-07-29-launch.md).

---

## What's running right now

| Service  | Image                                  | Port (host→container) | Health |
| -------- | -------------------------------------- | --------------------- | ------ |
| relay    | `ghcr.io/block/buzz:main` (pulled 7-29) | `3300 → 3000`          | healthy (`/_liveness` → `200 ok`) |
| postgres | `postgres:17-alpine`                   | (no publish)          | healthy |
| redis    | `redis:7-alpine`                       | (no publish)          | healthy |
| minio    | `minio:minio:RELEASE.2025-09-07…`      | (no publish)          | healthy |

The relay only accepts the configured community (`coreprt.webrnds.com`). Today that DNS doesn't
exist yet, so the relay correctly returns `404 — no community is configured for this host`
on `127.0.0.1:3300`. **That is the desired state for now.** Once Cloudflare Access + DNS
are in, the same relay will serve over HTTPS to anyone with your allowlisted email.

---

## What you can do today — without leaving your Mac

```bash
cd ~/Documents/projects/CorePrt/CorePrt-deploy

# Tail relay logs
COMPOSE_PROJECT_NAME=coreprt ./run.sh logs relay

# Status
./run.sh status

# Add yourself as the owner once you have a Nostr keypair
# (generate one with a tiny node script — see CorePrt-relay/keys.md, todo)
./run.sh add-member <npub-or-hex> --role admin

# Stop the stack (keeps volumes)
./run.sh stop

# Bring it back
./run.sh start
```

The two unauthenticated probes available today:
- `curl http://127.0.0.1:8080/_liveness` → `ok`
- `curl http://127.0.0.1:9102/metrics` → Prometheus exposition

---

## Roadmap to `https://coreprt.webrnds.com`

### Step 1 — DNS (Cloudflare dashboard, 1 minute) ✅ / ❓

In Cloudflare for the `webrnds.com` zone:

1. `DNS → Add record`
   - **Type:** `CNAME`
   - **Name:** `coreprt`
   - **Target:** `<tunnel-id>.cfargotunnel.com` *(filled in after Step 2)*
   - **Proxy:** **DNS-only** (grey cloud) at first — flip to **Proxied** (orange cloud) once
     the tunnel is reachable. (Proxied + Access policy is the recommended final state.)

2. `Access → Applications → Add → Self-hosted`
   - **Name:** `CorePrt`
   - **Domain:** `coreprt.webrnds.com`
   - **Policy:** name `owner-only`, action `Allow`, **Session duration** 24h
   - **Include:** Emails → `gogetta`
   - This gates both `https://coreprt.webrnds.com` and the WebSocket path
     `wss://coreprt.webrnds.com`.
   - **Important:** Access policies require the orange-cloud (proxied) state. Order matters.

### Step 2 — cloudflared tunnel (this machine, 5 minutes)

```bash
# 1. Authorise cloudflared against Cloudflare. Browser opens, pick the webrnds.com zone.
cloudflared tunnel login

# 2. Create the tunnel. Output prints a TUNNEL_ID; copy it.
cloudflared tunnel create coreprt
#   → writes credentials file at ~/.cloudflared/<TUNNEL_ID>.json

# 3. Edit `CorePrt-cloudflare/tunnel.yml` and replace `<TUNNEL_ID>` in
#    `credentials-file:` with the ID printed above. Save.

# 4. Point DNS at the tunnel
cloudflared tunnel route dns coreprt coreprt.webrnds.com

# 5. Smoke-test (foreground) with the shipped config
cloudflared tunnel --config ~/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml run coreprt
# Expected output (last lines):
#   INF Route via CNAME: coreprt.webrnds.com  →  http://127.0.0.1:3300
#   INF Connection established connIndex=0 ...
# Then in another terminal:
curl -s https://coreprt.webrnds.com   # → "404: no community is configured for this host"
# That confirms the tunnel is alive AND reaching the relay (which is rejecting an unbound host).
```

### Step 3 — make it persistent (launchd)

```bash
brew services start cloudflared     # already installed
sudo cloudflared service install    # registers /Library/LaunchDaemons/...
```

The relay stack itself is `restart: unless-stopped`, so `colima start` after a reboot brings
Postgres/Redis/MinIO/Relay back automatically. If you want dedicated launchd:
see `CorePrt-deploy/launchd/com.gogetta.coreprt.plist` (todo).

### Step 4 — generate the owner keypair + invite

The relay image includes `buzz-admin`, which can both generate a keypair and add it as the owner.

```bash
# Generate (keypair + nsec/npub printed to stdout; capture in your password manager)
docker exec coreprt-relay-1 /usr/local/bin/buzz-admin generate-key
#   → prints nsec1…  and  npub1…  plus the hex pubkey
# Back up the nsec1 offline. Then:

# Add as the owner (replace <hex-pubkey> with the hex pubkey from the previous step)
COMPOSE_PROJECT_NAME=coreprt ./run.sh add-member <hex-pubkey> --role admin

# Verify
COMPOSE_PROJECT_NAME=coreprt ./run.sh list-members
```

Now edit `CorePrt-deploy/.env` and replace `RELAY_OWNER_PUBKEY=0000...01` with the
hex pubkey. Restart the relay:

```bash
COMPOSE_PROJECT_NAME=coreprt ./run.sh restart
```

For agents (Hive) we want a **separate keypair per worker** so audit trails remain trustworthy.
Generate one per worker with `docker exec coreprt-relay-1 /usr/local/bin/buzz-admin generate-key`
and add each as `--role member` (not admin).

---

## Honest disclosures

- **First boot was fast (40 seconds total):** the `ghcr.io/block/buzz:main` image is prebuilt; we
  skipped the from-source `just build` route entirely. The macOS/Arm compile from source
  is **30–40 min** with Hermit + Rosetta; we're explicit that we picked the docker route.
- **`BUZZ_RELAY_PRIVATE_KEY` is generated, but `RELAY_OWNER_PUBKEY` is a placeholder
  (`000000...01`).** Until the owner keypair is provisioned, the relay rejects all writes to
  `coreprt.webrnds.com`. That's fine for day 1 (we're not exposing it yet), but it has to
  be filled in before the first public user.
- **`compose.caddy.yml` is shipped but not used.** Caddy handles TLS for the single-VPS deploy.
  Locally we use `cloudflared` instead, which terminates TLS at the Cloudflare edge. Same
  effective security profile; we don't double-cert.
- **The relay rejects `127.0.0.1` because no community is bound.** This is expected — the
  `BUZZ_DOMAIN` regex binds the community to a *public host*. To smoke-test from the loopback
  during development, set `BUZZ_DOMAIN=127.0.0.1` in `.env` and restart; undo before exposing.
- **Cloudflare Access policy uses three Allow rules** (trusted-mac, anywhere, service-token) per [`docs/access-policy.md`](docs/access-policy.md). I will *not* modify these without your explicit say-so. A misconfigured public relay is a discoverable system.
- **Cloudflare DNS for `webrnds.com` isn't currently in `~/.cloudflared`** — I haven't probed
  for a stored certificate. The dashboard steps above assume you (a) own the zone in CF and
  (b) have API credentials available. If neither is true yet, that's the next blocker to
  resolve — say the word and I'll wire a personal proxy upstream.
- **No git-data or git hooks are configured.** `buzz-git-data` volume is created but unused.
  We can mount a project in once the relay has its first admin.
- **`cloudflared` is installed but not yet authenticated and no tunnel exists yet.** The
  Step 2 commands require a Cloudflare account + browser login; `tunnel create` writes a
  JSON credentials file to `~/.cloudflared/<TUNNEL_ID>.json` (path referenced in tunnel.yml).
  Re-run Step 2 from scratch on any machine and the credentials file needs to travel with
  the tunnel registration. Back it up.
- **`brew services start cloudflared` is the documented persistent option on macOS**, but
  it expects `/opt/homebrew/etc/cloudflared/config.yml` (symlinked in the README). If you
  use a different path, the daemon won't start.

---

## Next decisions (waiting on you)

| # | Decision | Default I'd pick |
| - | -------- | ---------------- |
| D1 | **Owner keypair** — generate now (give you a `nsec1…` to back up) or wait? | Generate now |
| D2 | **`coreprt.webrnds.com` DNS zone** — does Cloudflare already host `webrnds.com`? | Assume yes |
| D3 | **Cloudflare Access** — multi-policy posture (trusted-mac + anywhere + service-token), see [`docs/access-policy.md`](docs/access-policy.md) | Approved (multi-policy) |
| D4 | **Onboard agents now vs later?** | Later — first we prove the human path |

---

*Generated 2026-07-29 after bringing the relay up locally for the first time.*
