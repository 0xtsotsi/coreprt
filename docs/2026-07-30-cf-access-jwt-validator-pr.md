# Cloudflare Access JWT verifier — `block/buzz` PR

This note records the patch I prepared for upstream `block/buzz`. It is a
**defense-in-depth** layer: Cloudflare's edge already enforces Access for
traffic that transits the public tunnel, but the relay bind address is also
reachable from the LAN, a VPN, or an accidental tunnel bypass. The patch
makes the relay enforce the same Access policy at its own edge so any
non-Cloudflare request is rejected before it hits a Nostr handler.

## What the patch does

Adds `crates/buzz-relay/src/cloudflare_access.rs` with:

- `AccessGuard::from_env()` — builds the verifier from `BUZZ_CF_ACCESS_AUDIENCE`
  and `BUZZ_CF_ACCESS_TEAM_DOMAIN`. If either is unset the guard is `None`
  and the relay behaves exactly as before.
- `verify(guard, headers)` — runs the full claim-and-signature check against
  the live JWKS fetched from `<team_domain>/cdn-cgi/access/certs`.
- `maybe_enforce(guard)` — axum layer factory. The router always installs
  this layer; with no guard configured, the layer is a transparent
  pass-through.
- Bypass paths: `/_liveness`, `/_readiness`, `/_status`, `/_mesh`. Internal
  K8s-style probes never carry an Access JWT and must keep working even if
  the verifier is misconfigured.

Wires it through `Config::cf_access: Option<Arc<AccessGuard>>` and the
existing axum router stack (`middleware::from_fn(...)`).

## Verification contract

Every failure mode fails closed with `403 Forbidden` and a fixed JSON body:

```json
{"error":"forbidden"}
```

(no reason string — that would help an attacker tune probes).

| Failure | HTTP | Reason |
| --- | --- | --- |
| `Cf-Access-Jwt-Assertion` header missing | 403 | `MissingHeader` |
| Header present but not a valid JWT | 403 | `Malformed("header")` |
| `alg` is anything other than `RS256` | 403 | `WrongAlg` |
| `kid` missing or absent from JWKS | 403 | `UnknownKid` |
| JWKS fetch fails (DNS / TLS / timeout) | 403 | `JwksFetch(_)` |
| JWKS HTTP status is non-2xx | 403 | `JwksStatus(code)` |
| JWKS body not parseable | 403 | `JwksDecode(_)` |
| JWK `n`/`e` not usable for RSA | 403 | `BadKey(_)` |
| `iss` does not equal configured team domain | 403 | `ClaimMismatch("iss")` |
| `aud` does not equal configured audience | 403 | `ClaimMismatch("aud")` |
| `exp` is in the past (5-minute leeway) | 403 | `Expired` |
| `nbf` (if present) is in the future | 403 | `ClaimMismatch("nbf")` |
| `iat` (if present) is in the future | 403 | `ClaimMismatch("iat")` |

`exp`/`nbf`/`iat` all use a 5-minute leeway, matching Cloudflare's own
guidance. The JWKS TTL is 60 seconds, invalidated on a `kid` miss so a
key rotation propagates within a minute without operator action.

## Environment configuration

Set **both** env vars; setting only one is a config error:

```sh
BUZZ_CF_ACCESS_AUDIENCE=75f368ec604e03651d9c0590894c2e12be90c91b70be064cacbdb144b292796e
BUZZ_CF_ACCESS_TEAM_DOMAIN=https://silent-breeze-f1dc.cloudflareaccess.com
```

The audience is the **Application Audience** tag shown in
`Zero Trust → Access → Applications → CorePrt → Overview`.
The team domain is the **Cloudflare Zero Trust team domain** shown at the
top of the dashboard. Both are surfaced in `ConfigError::PartialConfig`
or `ConfigError::InvalidTeamDomain` if misconfigured — startup fails
loudly rather than silently running without Access.

## Test plan

Each test runs against a locally-generated RSA keypair. The signer and
verifier share the JWKS via a per-test `Jwks` fixture, not over HTTP.

```
tests::missing_header_is_rejected
    headers empty; expect AccessError::MissingHeader.
    This is the most important test — proves no bypass path exists.

tests::empty_header_is_rejected
    headers has header but value = ""; expect MissingHeader.
    Catches a "default header inserted by reverse proxy" regression.

tests::wrong_alg_is_rejected
    header alg = HS256; expect WrongAlg.
    This is the security-critical test: a `none` or HS256 token must
    never be accepted, even if the rest of the JWT is valid.

tests::unknown_kid_is_rejected
    header kid is not in JWKS; expect UnknownKid (or JwksFetch on a
    flaky local server, hence the OR).
    Catches JWKS-cache staleness regressions.

tests::wrong_aud_is_rejected
    valid signature, but aud != configured audience; expect ClaimMismatch("aud").
    Catches a copy-paste of the wrong audience tag.

tests::wrong_iss_is_rejected
    valid signature, but iss != configured team domain; expect ClaimMismatch("iss").
    Catches a copy-paste of the wrong team domain.

tests::expired_token_is_rejected
    exp = now - 3600; expect Expired.
    Catches a leeway regression.

tests::immature_token_is_rejected
    nbf = now + 3600; expect ClaimMismatch("nbf").
    Catches a leeway regression on nbf.

tests::future_iat_is_rejected
    iat = now + 3600; expect ClaimMismatch("iat").
    Catches a leeway regression on iat.

tests::valid_token_passes
    valid header + claims; expect Ok(()).
    The happy-path test. Without it the other tests could pass while
    the verifier returns Err unconditionally.

tests::bypass_paths_are_not_verified
    request to /_liveness; no header; expect next.run(request).await
    to be invoked unchanged. The middleware factory is wired through
    a per-path early return; this test pins the contract.

tests::maybe_enforce_with_no_guard_is_pass_through
    maybe_enforce(None) → next is called unmodified, no header check.
    Pins the "no config = no enforcement" contract; default deployments
    must behave exactly as before this patch.
```

End-to-end coverage via the axum stack:

```
integration::forbidden_without_jwt
    Start a test server with the middleware enabled. Request any
    protected route with no header. Expect 403, body contains
    "forbidden", no handler ran (asserted via a counter middleware).

integration::forbidden_with_expired_jwt
    Same as above but with an expired JWT signed by the right key.
    Expect 403, full reject path.

integration::passes_with_valid_jwt
    Request with a freshly signed JWT; expect 200 and the inner
    handler runs.

integration::health_endpoints_skip_middleware
    Request /_liveness without a JWT; expect 200 even when middleware
    is otherwise configured. This protects internal probes from
    outages caused by Access misconfiguration.
```

## Open follow-ups (not in this patch)

- **Bypass for the relay's own upstream.** If the relay is later fronted
  by another service (a custom proxy, a second relay in a mesh), that
  service must add its own `Cf-Access-Jwt-Assertion` header on the way
  in or it will get 403. Not the relay's problem to solve, but the
  failure mode should be documented.
- **JWKS metrics.** A counter for cache hits / cache misses / fetches by
  status code would help operators tell when a JWKS rotation has
  propagated. Defer until a real incident; the structured `tracing` log
  already records every fetch.
- **HSM-backed signing.** Cloudflare's keys are RSA-2048 today; if they
  migrate to ECDSA or RSA-PSS the validator needs an algorithm allow-list
  update. Out of scope for this PR — `Validation::algorithms` is the
  knob to turn when that day comes.

## Local validation

The patch is on branch `ops/2026-07-30-cf-access-jwt-validator`. Before
opening the upstream PR I will:

1. `cargo check -p buzz-relay` (clean compile).
2. `cargo test -p buzz-relay cloudflare_access` (unit + integration tests).
3. `cargo clippy -p buzz-relay -- -D warnings` (no new lints).
4. Run the relay locally with the env vars unset and confirm the public
   302 to Access still works exactly as before the patch (no-op
   pass-through).
5. Run the relay locally with the env vars set, request
   `http://127.0.0.1:3000/_liveness` without a JWT → expect 200 (bypass).
   Request any other route without a JWT → expect 403. With a
   freshly-signed JWT against the local JWKS → expect 200.

When all five pass, the PR is ready to send.