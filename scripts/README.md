# scripts/

Operational scripts.

| Script | Purpose |
| --- | --- |
| `probe-edge.sh` | Reads `~/.config/coreprt/buzz-mcp.env` and verifies the CF Access service token is admitted by the edge for the `coreprt.webrnds.com` application. Reads the secret from the env file but never echoes it to stdout. Exit 0 on edge 200s, non-zero on edge 403. |
| `mcp-warp-fallback.py` | Plan-B after the 2026-08-03 Access recreate: deletes the dead service-token and `service-token-buzz-mcp` policy, adds `mcp-warp-required`, and updates `owner-trusted-mac` to require the WARP integration posture. See `docs/2026-08-03-access-recreate.md`. |
| `snapshot-access.py` | Dumps the current Cloudflare Access app + policies into `docs/<date>-access-recreate-snapshot.md` so dashboard drift is reviewable in git. |
| `recreate-access-app.py` | Deletes and re-creates the CorePrt Access app + policies. Used during the 2026-08-03 incident. |
| `verify-live-state.py` | Cross-checks the running relay, Postgres, Redis, MinIO, and CF Access against the expected configuration in `docs/access-policy.md`. |
| `fix-plan-paste-artifacts.py` | Strips verbatim secrets from pasted plan text before the agent commits them. |
| `start-buzz-desktop.sh` | Launches the local `/Applications/Buzz.app` desktop chat client with `BUZZ_RELAY_URL` set to the operator's expected relay. Default mode is `wss://coreprt.webrnds.com` (the public tunnel + WARP-acquired Access posture) so the operator gets the same context whether they're on the host Mac or remote. Pass `--local` to force `ws://127.0.0.1:3300` (only usable when the docker containers are running on this machine). The `BUZZ_DESKTOP_LAUNCHER` env var is honored by the test harness — production callers can ignore it. |
| `test-start-buzz-desktop.sh` | Verifies the launcher's flag/env mix: `bash -n` parses, default → public, `--local` → loopback, `--relay-url` overrides, `BUZZ_HTTP_PORT` is honored only on `--local`, unknown flags fall through to the launcher binary, `--help` is non-executing, pre-flight warning does not fire when the URL is reachable, pre-flight warning does fire on connection refused, `--local` skips the pre-flight entirely. 15 cases, exit 0 on full pass. |

Run `bash scripts/test-start-buzz-desktop.sh` after any change to the launcher.
