# CorePrt · Cloudflare setup

One-time, ~5 minutes. After this, `https://coreprt.webrnds.com` reaches the
local relay in `CorePrt-deploy`, and only your email passes Cloudflare Access.

## Prerequisites

- A Cloudflare account that owns the `webrnds.com` zone.
- `cloudflared` (already installed at `/opt/homebrew/bin/cloudflared`, v2026.7.1).
- The relay stack is **already running** via `CorePrt-deploy` on `127.0.0.1:3300`.

## One-time setup

```bash
# 1. Authorise cloudflared against your Cloudflare account. Browser opens.
cloudflared tunnel login

# 2. Create the tunnel. The output prints a TUNNEL_ID; paste it into tunnel.yml.
cloudflared tunnel create coreprt

# 3. Point DNS at the tunnel. Idempotent.
cloudflared tunnel route dns coreprt coreprt.webrnds.com

# 4. Smoke-test in the foreground
cloudflared tunnel --config /Users/gogetta/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml run coreprt
# Expected: "Route via CNAME: coreprt.webrnds.com" then tunnel stays open
# Test:    curl -s https://coreprt.webrnds.com   →  "404: no community is configured for this host"
```

## Make it persistent

```bash
# Create the symlink brew expects
sudo mkdir -p /opt/homebrew/etc/cloudflared
sudo ln -sf /Users/gogetta/Documents/projects/CorePrt/CorePrt-cloudflare/tunnel.yml /opt/homebrew/etc/cloudflared/config.yml
brew services start cloudflared
```

`brew services start cloudflared` registers a LaunchAgent that comes back after
reboot. Verify with `brew services list | grep cloudflared`.

## Cloudflare dashboard steps (5 clicks)

1. **DNS → Add record:**
   - Type: **CNAME**
   - Name: **coreprt**
   - Target: `<TUNNEL_ID>.cfargotunnel.com`
   - Proxy: **DNS-only** at first. Once `curl https://coreprt.webrnds.com` returns the
     expected 404, flip it to **Proxied** (orange cloud). Access policy requires proxy.

2. **Access → Applications → Add a self-hosted app:**
   - Name: `CorePrt`
   - Domain: `coreprt.webrnds.com`
   - Policy: name `owner-only`, action **Allow**, session **24h**
   - Include: Emails → `gogetta`

3. Verify:
   - In a private browser window (not logged into CF): `https://coreprt.webrnds.com`
     → Cloudflare Access login screen → only `gogetta` email is allowed.
   - In the desktop Buzz app (pointed at `wss://coreprt.webrnds.com`): same gate.

## Honest caveats

- **Default email gate is permissive within the email.** `gogetta` can log in from any
  device. If you want device posture checks (managed device IDs, geo-fencing, etc.), add
  a second rule on the same policy.
- **Cloudflare Access has a 1-day cache once you log in.** Reauth on a new browser; the
  email magic link is the recovery path.
- **WebSocket through Access works out of the box** but with a minor caveat: the WSS
  Upgrade request has to come from a CF edge IP and pass the same `Host` header. We've
  set `httpHostHeader: coreprt.webrnds.com` so the relay sees the canonical host. If the
  relay ever logs `no community is configured` from inside, the Access upgrade won — check
  `cloudflared` logs for the `Host: …` header it forwarded.
- **`webrnds.com` DNS zone must already exist on Cloudflare.** If your registrar is
  something else and CF is only handling nameservers for a subset, the route-dns step
  fails. We can pivot to a separate zone (`coreprt.pages.dev`) in 30 seconds if needed.

---

*Last updated 2026-07-29 in tandem with the relay first-boot.*
