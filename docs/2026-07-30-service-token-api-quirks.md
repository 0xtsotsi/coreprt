# Service token API quirks · 2026-07-30

The Cloudflare API endpoint `/accounts/{id}/access/service_tokens` (with
**underscore**) works — the documented `/access/service-tokens` (with
**hyphen**) returns 404 code 10001 on every token I've probed. This is
the source of every "service tokens 404" across the previous rounds.

## Confirmed reachable with this API token

- `POST /accounts/{id}/access/service_tokens` — creates a token and returns
  `client_id` and `client_secret` in the response body. **Both fields are
  populated only on creation/rotation.**
- `GET /accounts/{id}/access/service_tokens` — lists all account-level tokens
  with `client_id` but no `client_secret`.
- `GET /accounts/{id}/access/service_tokens/{id}` — returns full record with
  `client_id` but no `client_secret`.
- `POST /accounts/{id}/access/service_tokens/{id}/rotate` — returns a fresh
  `client_secret`, sets `previous_client_secret_expires_at` to the rotation
  timestamp (so old secret is immediately invalidated).
- `DELETE /accounts/{id}/access/service_tokens/{id}` — hard-delete the token.

## Endpoints that don't work

- `GET/POST /accounts/{id}/access/service-tokens` (hyphen) — 404 code 10001
- `GET/POST /accounts/{id}/access/service_auth/tokens` — 404 code 10001
- `GET/POST /accounts/{id}/access/tokens` — 404 code 10001
- `POST /accounts/{id}/iam/service-tokens` — 400 (no route)
- `POST /accounts/{id}/zero-trust/service-tokens` — 400 (no route)

## Verified constraints

- The `client_secret` returned by `POST /access/service_tokens` is a 64-char
  hex string. **Cloudflare's edge rejects it** (`service_token_status: false`
  in the meta JWT, regardless of how the policy references the token). The
  create/rotate API responses are accepted (`success: true`) and the token
  records appear in `GET` listings, but the secrets don't authenticate at the
  edge.
- The **dashboard-created** tokens (during the operator's prior sessions) had
  the same 64-hex format and also didn't authenticate at the edge when I
  tested them.
- This is reproducible across rotated secrets, fresh creates, and across
  policy shapes (`any_valid_service_token` and `service_token: { token_id }`).
- Allowed IdPs restored to `[cloudflare OTP]` doesn't fix it either.

## Conclusion

For this Cloudflare account, the **underscored** `/accounts/{id}/access/service_tokens`
route is reachable and supports create / list / read / rotate / delete. The
**hyphenated** `/accounts/{id}/access/service-tokens` route returns 404 (code 10001)
for every variant tried. The API accepts every token it creates (`success: true`),
but every `client_secret` returned by the API — including rotated ones — was
rejected at the edge with `service_token_status: false` in the meta JWT. Dashboard-
created tokens observed in prior sessions had the same 64-hex shape and were also
rejected at the edge when tested. **No service-token creation path is known to
produce a token that authenticates at the edge on this account.** Policy C has
therefore been retired; all service tokens are deleted; if MCP auth is needed
later, plan a WARP-only authentication path on the MCP host instead.

The remaining work is operator-side: create a fresh service token bound
to `CorePrt (c3f1f0da-…)`, store both values locally in
`~/.config/coreprt/buzz-mcp.env` with mode 600, and report only the
token ID and verification result. Never paste the secret into chat.

---

## Update 2026-08-03 — service-token path is permanently retired on this account

A recreate test on 2026-08-03 (`docs/2026-08-03-access-recreate.md`) **refuted the hypothesis that a fresh app + fresh token would unstick the edge rejection**. Steps taken:

1. Deleted the old Access app `c3f1f0da-…` (with its 3 policies and the old service token `80ae9bce-…`).
2. Created a new app `974e7f0c-…` from scratch.
3. Re-attached a fresh 3-policy layout (the service-token policy is at prec 1).
4. Minted a new service token via the API (`8558f382-…`, client_id `4d9539a3…access`, 64-hex secret).
5. Pinned the new policy's `service_token` include to the new token id.
6. Probed the edge with `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers — **HTTP 403**, same as before.

The edge rejection is **account-level, not app-level**. The 2026-07-31 "re-creation note" in earlier docs that claimed the token was working is **factually wrong** — the authed 200s at the time were likely from a cached WARP session on the operator's machine, not from the service token itself.

**The service-token path is permanently retired on this account.** The replacement is WARP-required include on the MCP host (Policy A1 in `docs/access-policy.md`). All service tokens are deleted (count: 0). The new Access app has no service-token policy attached.

If Cloudflare support ever fixes the edge-rejection issue on this account, the recreate script (`scripts/recreate-access-app.py`) can be re-run to add a service-token policy back. Until then, do not retry.
