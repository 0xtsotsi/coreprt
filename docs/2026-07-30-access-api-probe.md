# CorePrt — Access API probe · 2026-07-30

**Goal:** confirm whether Cloudflare Access resources for CorePrt can be created via the API using the token now stored in `CorePrt-deploy/.env`.

**Result:** **app `CorePrt` is live with 3 Allow policies; Access is enforcing on `https://coreprt.webrnds.com` (302 → Cloudflare Access login for unauthenticated requests). Policy A now includes a `device_posture` Require referencing the built-in WARP integration (`76b96de1-4cce-43fe-ba8a-26881193a475`); Policy B is now two email-only policies (`owner-trusted-mac` posture-gated, `owner-anywhere` not); the 50-CIDR IP-list include was removed in favor of the canonical email-only design.**

---

## Final state (canonical, as of last commit)

App: `CorePrt` (self-hosted)
- App ID: `c3f1f0da-94e8-4e8a-aef4-6d348dc6899d`
- App audience (`aud`): `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e`
- Domain: `coreprt.webrnds.com`
- Allowed IdPs: `cloudflare` OTP IdP `3ee5b946-17cb-4a77-bb24-31b7e46065f2`
- Session duration: `24h`
- App launcher visible: `false`

Attached policies (3, all `decision: allow`, evaluated as OR; Cloudflare evaluates in precedence order but ANY allow matches):

1. **`owner-trusted-mac`** — precedence 1
   - Include: `email = gogetta`
   - Require: `device_posture` (WARP integration `76b96de1-…`)
   - Effect: matches **only** when the user is `gogetta` AND Cloudflare WARP on their device reports passing posture (OS version, FileVault, Firewall — configured in the WARP integration in the Zero Trust dashboard).
2. **`owner-anywhere`** — precedence 2
   - Include: `email = gogetta`
   - Require: *(none)*
   - Effect: matches anywhere `gogetta` authenticates with the cloudflare OTP IdP. This is the fallback when WARP is unavailable (travel laptop, phone, friend's machine).
3. **`service-token-buzz-mcp`** — precedence 3
   - Include: `any_valid_service_token`
   - Require: *(none)*
   - Effect: admits headless MCP / `curl` callers with valid `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers.

`https://coreprt.webrnds.com/_liveness` → **HTTP 302** to `https://silent-breeze-f1dc.cloudflareaccess.com/cdn-cgi/access/login/coreprt.webrnds.com?kid=…` with `www-authenticate: Cloudflare-Access …`. Access is actively gating the host.

A request directly to the relay on `http://127.0.0.1:3300/_liveness` still returns **HTTP 200** — Access only intercepts traffic that transits Cloudflare's edge. The `Cf-Access-Jwt-Assertion` is forwarded to the origin on tunnel traffic; verifying it requires a `block/buzz` upstream change.

---

## Important architectural lesson — Require vs Include

Cloudflare Access evaluates `require` rules **per-policy** (not globally). If a precedence-1 policy has `require: [device_posture]` and the request has no posture match, **the policy denies**, even if the include matches. Lower-precedence policies are not consulted as a fallback when a require fails.

**The wrong way**: precedence-1 `owner-trusted-mac` with `include: email, require: device_posture` — denied every non-WARP client, including the operator from a phone.

**The right way** (what's currently live): two parallel policies with the same include but different require:
- `owner-trusted-mac` — `include: email, require: device_posture` (matches only when WARP says yes)
- `owner-anywhere` — `include: email` (matches anywhere)

Either policy passing admits the request.

---

## Token scopes (verified by behavior after the latest token edit)

| Endpoint | HTTP | Implies |
| --- | ---: | --- |
| `/accounts/{id}/access/apps` GET / POST | 200 / 201 | Account-scoped Apps full CRUD ✅ |
| `/accounts/{id}/access/policies` GET / POST | 200 / 201 | Account-scoped Policies CRUD ✅ |
| `/accounts/{id}/access/identity_providers` GET | 200 | IdP Read ✅ |
| `/accounts/{id}/access/organizations` GET | 200 | Organization Read ✅ |
| `/accounts/{id}/access/groups` GET | 200 | Access Groups Read ✅ |
| `/accounts/{id}/access/service-tokens` (hyphenated) GET / POST | **404 code 10001** | Hyphen route is 404; use the underscored route below |
| `/accounts/{id}/devices/posture` GET | 200 | Posture features Read ✅ (2 integrations: Gateway, WARP) |
| `/accounts/{id}/devices/posture/integrations` GET | **404** | Specific integrations list endpoint not granted ❌ |
| `/accounts/{id}/tunnels/{id}/token` GET | **404** | Tunnel credentials refresh not granted ❌ |
| `/zones/{id}/dns_records` GET / PATCH | 200 | DNS Read+Write ✅ |
| `/zones/{id}/access/apps` PUT (with inline policies + `device_posture`) | 200 | Zone-scoped Apps CRUD with posture require ✅ |

**Net change from the previous token state:**
- gained: account-scoped Apps CRUD, account-scoped Policies CRUD, posture features list, **WAF:Edit (zone-scoped)**
- lost: nothing significant (zone-scoped Apps still works)
- WAF custom ruleset creation: ✅ **worked** with `kind: zone` (Free plan allows up to 5 zone-scoped custom rules per ruleset)

---

## Include + Require rule types verified

`PUT /zones/{id}/access/apps/{id}` with inline `policies[]` accepts:

- Include: `email`, `email_domain`, `everyone`, `any_valid_service_token`, `ip`, `login_method`, `device_posture` — all 201
- Require: `device_posture` with `{integration_uid: "76b96de1-…"}` — 201

Rejected:

- Include: `geoip`, `country` (Access does not support country gating; lives in WAF)
- A `device_posture` rule with both `integration_uid` AND `check: {os_version: …}` is **silently normalized** by Cloudflare down to just `{integration_uid}`. The check definitions (OS version >= 15.0, FileVault on, etc.) live in the WARP integration's posture check configuration in the Zero Trust dashboard, not in the policy rule.

---

## WAF geo-fence experiment

Created `CorePrt - Geo gate` ruleset (kind: zone, phase: http_request_firewall_custom) with one rule:

```
(not ip.geoip.country in {"US"} and http.host eq "coreprt.webrnds.com")
  action: block
```

This **worked as designed** — blocked my NL request with 403 — but had to be deleted because the operator is currently in the Netherlands and would be locked out. The right place for Country=US gating is either:

1. The Cloudflare Zero Trust dashboard (DAS team → Add group → Country rule), or
2. The WAF Custom Rules feature with a wider US IP allowlist (but Free plan limits to 5 rules/ruleset), or
3. The Access policy's IP include list (still the current approach — see owner-anywhere above)

The single WAF rule was created and deleted in this session; the ruleset is gone.

---

## Gaps relative to `docs/access-policy.md`

1. **Policy A posture checks (OS version ≥ 15.0, FileVault on, Firewall enabled)** — the API only sets `integration_uid`, not specific checks. The operator must configure these in the Zero Trust dashboard: **Zero Trust → Settings → WARP Client → Posture checks → Add check** (one each for `OS version`, `Disk encryption`, `Firewall`). The policy rule then references the WARP integration and the checks run client-side.
2. **Policy B "Country = US"** — Cloudflare Access does not support country gating in policy includes. The current `owner-anywhere` is email-only with no geo-fence. To add a US-only restriction, use the dashboard's WARP team country rule, or layer a Cloudflare WAF country block rule (Free plan allows simple country-block lists).
3. **Policy C service token** — `/accounts/{id}/access/service-tokens` (hyphenated) returns 404, but the underscored `/accounts/{id}/access/service_tokens` route supports create/list/read/rotate/delete with the current token. The **secrets** returned by the API are accepted by the API (`success: true`) but rejected by the edge (`service_token_status: false` in the meta JWT). Policy C has since been deleted; the canonical live state is two policies. See `docs/2026-07-30-service-token-api-quirks.md`.
4. **Relay-side `Cf-Access-Jwt-Assertion` validation** — `block/buzz` does not currently verify the JWT against the app audience `75f368ec…`. Without that, Access gating is bypassable by going direct to the relay on port 3300 even when Access is "on". The public 302 we see only kicks in for traffic that transits Cloudflare's edge. The relay-side check is an upstream `block/buzz` change.

---

## Operational notes

- Access app id `c3f1f0da-94e8-4e8a-aef4-6d348dc6899d` is now live. **Do not delete it.**
- App audience `75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e` should be hard-coded into the relay's `Cf-Access-Jwt-Assertion` validator once that change is upstreamed to `block/buzz`.
- All three policies are currently `allow`-only. The app does not have `deny_unmatched_requests` set, so requests that don't match any policy currently fall through to Access's default (browser OTP prompt, but no IdP match = 403). Flip `App → deny_unmatched_requests` to `true` only after verifying the policies admit the operator's expected access patterns.

## Service-token credential storage (Policy C)

Service tokens are admitted by the `service-token-buzz-mcp` policy via `any_valid_service_token`, but the API cannot enumerate or rotate them with the current token. A token was created manually in the Cloudflare dashboard (Access → Service Auth → Create a Service Token, bound to app `c3f1f0da-…`).

The credentials live at **`~/.config/coreprt/buzz-mcp.env`** (mode 600), outside the CorePrt repo. The MCP bridge should `source` this file at startup and forward both headers on every request to `https://coreprt.webrnds.com`. A documentation-only ignore rule in `.gitignore` references `~/.config/coreprt/` as a defense-in-depth against accidental copies into the repo.

**IMPORTANT: this token's `client_secret` was exposed in chat and in a discarded local-only commit. It must be rotated before the MCP bridge uses it. No leaked credential may appear in the publication branch.** The replacement flow is:

1. Dashboard → Access → Service Auth → Create a Service Token, select app `c3f1f0da-…`.
2. Copy the new `client_id` (`…access`) and `client_secret` (64-hex).
3. Update `~/.config/coreprt/buzz-mcp.env`.
4. Restart any MCP bridge that had the old credentials cached.

Build the publication branch from the sanitized final tree and run a secret scan before push. Cleanup of local reflogs and unreachable objects is a separate operator action after recovery is no longer needed.
