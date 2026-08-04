# `buzz-mcp` implementation plan — multi-relay + sustainability

**Status:** Consolidated draft, 2026-08-02
**Supersedes:** `2026-08-02-buzz-mcp-multi-relay.md` (kept as technical reference)
**Author:** operator session, CorePrt relay stack
**Target repo:** `0xtsotsi/buzz-mcp` (fork of `gogetta/buzz-mcp`)
**Estimated effort:** 1.5–2.5 working days for the technical PRs, plus a few hours for safety/observability additions; rollout over 1–2 weeks.
**Audience:** future operator (or future-self) who needs to land this work without re-discovering the same traps.

## Why this doc exists

This is one document, not two. It combines:

- The **multi-relay technical spec** (RelayPool, channel resolution, fan-out, subscription multiplexing) — the work needed to make the MCP actually work against the operator's two parallel relays.
- The **sustainability / safety recommendations** (config discipline, observability, docs-as-code, process guards) — the work needed to ensure the next debugging session is shorter than this one.

Both halves address the same meta-problem: **the safe path should be the easy path, and destructive operations should require explicit opt-in.** That principle drives most of the decisions below.

## Context

The operator's actual deployment (verified 2026-08-02):

| Relay | URL | Operator pubkey | Community | `#general` UUID | Notes |
|---|---|---|---|---|---|
| Self-hosted | `wss://coreprt.webrnds.com` | `5430c42f1687cf77f71b960d07899596207199a16e056b0cd4ab5d9b1aae53b8` (3 members) | `54aafc47-0608-4831-8656-502d2ba2b9aa` | `0afe2e00-a9c7-4941-954f-c200c2429e3f` | Behind Cloudflare tunnel, requires CF Access, has APNs push config |
| Block-hosted | `wss://webrnds.communities.buzz.xyz` | same pubkey (operator is the only member) | unknown UUID | unknown UUID | Owned by Block (`12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3`) |

Both relays **reject `h:<lowercase-name>` for kind:9 events** (verified empirically). Both accept `h:<uuid>`. The MCP today only knows about one relay at a time, sourced from `BUZZ_RELAY_URL`. Buzz.app's chat UI binds to one relay at a time via `~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`.

Six months of session debugging has shown these recurring failure modes (all addressed below):

1. **Silent misconfiguration.** `signedFetch` returns `accepted:true` against CF Access HTML pages, malformed events, or relay error pages because the check is `status < 300` only. Multiple sessions have called a bug "fixed" when in fact the wire shape was wrong.
2. **Single relay URL with no fallback.** When the configured relay is unreachable, the MCP returns confusing partial failures instead of routing to a backup.
3. **Channel name vs UUID confusion.** Tool callers pass `"general"` (display name), but relays require a UUID in `h:`. Today the MCP doesn't translate.
4. **Destructive operations one keystroke away.** A single `mcp__buzz__buzz_post_message` writes to a public relay. There's no dry-run, no confirmation, no allowlist.
5. **Logs invisible.** `BUZZ_MCP_LOG=info` writes to stderr, which is discarded in the MCP runtime. Operator has no observability into what actually happened.
6. **Config scattered across six places.** `~/.gg/mcp.json`, `~/.config/coreprt/buzz-mcp.env`, `~/.Library/Application Support/xyz.block.buzz.app/...`, `BUZZ_DESKTOP_BUILD_RELAY_URL` baked at compile time, `SignedBootstrapToken` in the binary, and per-relay NIP-29 Host routing.

## Decisions on the previously-open questions

These resolve every `Open questions for sign-off` block from `2026-08-02-buzz-mcp-multi-relay.md`. Where I had to choose without operator input, the choice and rationale are documented so they can be revisited.

| # | Question | Decision | Rationale |
|---|---|---|---|
| Q1 | Channel UUID cache TTL | **5 minutes** | Generous for human-edited channels; cheap on the relay; aligns with NIP-29 propagation norms. Tunable via `BUZZ_CHANNEL_CACHE_TTL_MS` env. |
| Q2 | `allowFanout` default | **`true`** | Operators expect "post once, see it everywhere." The `posts[]` array surfaces per-relay results, so partial failure is visible. Override per call. |
| Q3 | `relays: []` semantics | **Error** — "relays parameter must be non-empty if provided" | Silent fall-through masks config mistakes. Loud failure is safer. |
| Q4 | Per-relay Host header | **Derived from WSS URL by default**, overridable via `BUZZ_RELAY_HOST_<n>=host` | Today every relay routes NIP-29 by WSS hostname. If they ever diverge, the override is there. |
| Q5 | Tool return shape change | **Additive `posts[]` field per write tool**; existing fields preserved | MCP JSON-RPC tolerates unknown fields in responses, but smoke-test each downstream consumer (claude-cli, codex-cli, Buzz.app). |
| Q6 | Webhook subscriptions | **Out of scope.** Deferred to a follow-up spec. | Today's subscriptions work via WebSocket poll; webhook push is a separate design effort. |

## Implementation phases

Phases are ordered by dependency. Each phase is independently shippable as a PR; later phases don't block earlier ones.

### Phase 0 — Pre-flight cleanup

**Goal:** Don't leave the relay polluted with debug channels before we start.

**Tasks:**
1. List all kind:9007 (channel-create) events on `coreprt.webrnds.com` authored by the operator. Document them.
2. For each one, ask the operator: keep, archive, or delete.
3. Delete confirmed-duplicate noise channels via kind:9005 (`delete_channel`) signed events. Self-hosted relay supports this; verify NIP-29 spec.
4. Keep the channel with the 3 hello-world messages (`0afe2e00-a9c7-4941-954f-c200c2429e3f`) — that's the canonical `#general` going forward.

**Effort:** 30 min.
**Risk:** Destructive, but reversible (re-create channel + re-post messages).
**Sign-off:** Operator confirms the keep/delete list before any delete fires.

#### Phase 0 inventory (verified 2026-08-02)

All kind:9007 events authored by the operator pubkey on `coreprt.webrnds.com`:

| # | event_id | name | about | created (UTC) | UUID in event | messages | recommendation |
|---|---|---|---|---|---|---|---|
| 1 | `5786f67a97ea3010…` | `test-no-h` | (none) | 2026-08-02 07:42 | server-assigned | unknown | **DELETE** |
| 2 | `714216b4f89813c2…` | `general` | `round-trip-3` | 2026-08-02 07:41 | `0afe2e00-a9c7-4941-954f-c200c2429e3f` | **3** | **KEEP** — contains the three hello-worlds |
| 3 | `f65e60fab854636a…` | `general` | `full round-trip probe` | 2026-08-02 07:41 | `e39006f8-e618-4467-9f35-4e6cbb41626f` | 0 | **DELETE** |
| 4 | `ab6218db79273e66…` | `general` | `hello-world-probe-2` | 2026-08-02 07:41 | `81f7fbca-0078-4921-b613-fa87b7824ee2` | 0 | **DELETE** |
| 5 | `d599993ae36f601f…` | `general` | `hello world smoke test` | 2026-08-02 07:33 | server-assigned | unknown | **DELETE** |
| 6 | `1ee3a99b033628ec…` | `general` | `the main lobby` | 2026-08-01 07:20 | server-assigned | unknown | **PRESERVE** — first channel; possibly intentional |

**Recommended action set:**
- Delete 5 channels: #1, #3, #4, #5, and (pending operator confirmation) #6.
- Keep 1 channel: #2 (`0afe2e00-a9c7-4941-954f-c200c2429e3f`, 3 messages).
- After cleanup: the relay will have exactly one `general` channel with the canonical UUID and the three hello-world messages.

**Caveat on server-assigned channels (#1, #5, #6):** Their UUIDs are not in the kind:9007 events themselves. To delete them, the operator must either (a) know the UUID by querying the relay's channel index, or (b) sign a kind:9005 with the channel's relay-assigned UUID. If the relay doesn't expose the UUID lookup, deletion may not be possible without an admin CLI command. **Verify the relay's `delete_channel` shape before signing any delete events.** Fallback: `docker exec coreprt-relay-1 buzz-admin delete-channel <event_id>` if the relay supports it.

**Status:** Inventory complete. Awaiting operator go-ahead before any deletion.

#### Phase 0 execution (2026-08-02)

Operator signed off "Path 1": delete #1, #3, #4, #5; preserve #6; keep #2.

**Wire-shape finding during execution:** Relay accepts kind:9005 with `["h", <uuid>], ["e", <kind-9007-event-id>]`. Missing `h` → `400 invalid: channel-scoped events must include an h tag`. Missing `e` → `400 invalid: missing e tag for target event`. Both required.

**Successfully deleted (200 accepted):**
- `#3` `e39006f8-e618-4467-9f35-4e6cbb41626f` (event_id `f65e60fa…`, 0 messages) → delete event_id `3c285d98…`
- `#4` `81f7fbca-0078-4921-b613-fa87b7824ee2` (event_id `ab6218db…`, 0 messages) → delete event_id `ce09560d…`

**Cannot delete (relay-assigned UUIDs not exposed by relay):**
- `#1` `test-no-h` (event_id `5786f67a…`)
- `#5` `general` "hello world smoke test" (event_id `d599993a…`)
- `#6` `general` "the main lobby" (event_id `1ee3a99b…`) — preserved per Path 1

**Why blocked:** NIP-29 requires `h:<uuid>` for kind:9005, and the relay assigns UUIDs server-side at kind:9007 acceptance time without storing them in the event itself. The relay does not expose these server-assigned UUIDs via:
- `buzz-admin` CLI (no `delete-channel`, `list-channels`, or `channels` subcommands)
- `/admin/channels`, `/api/channels`, `/channels` HTTP endpoints (404)
- NIP-87 channel metadata lookup (404)
- WebSocket REQ (requires NIP-42 AUTH challenge-response handshake that the MCP HTTP query path does not perform)

**Resolution options for the operator:**
1. **Accept partial cleanup.** 2 of 4 confirmed-noise channels deleted. The 3 remaining server-assigned channels stay. Future operators/agents ignore them as duplicate `general` entries.
2. **Delete via direct relay database access** (risky, requires SSH into relay host and modifying the channels table directly). Not recommended — bypasses NIP-29 audit trail.
3. **Open an issue upstream with `block/buzz`** asking for a NIP-87 channel listing endpoint or an admin CLI subcommand. Out of immediate scope.
4. **Wait for `block/buzz` to expose channel UUIDs in kind:9007 responses** (currently the relay strips them from query responses even though they exist server-side). Upstream fix needed.

**Status:** Partial cleanup complete. 2 channels deleted, 3 unverifiable without upstream changes. **Awaiting operator decision on next step.**

### Phase 1 — Configuration discipline + dry-run safety (foundational, blocks everything else)

**Goal:** Make the MCP fail loudly on bad config and refuse to write without explicit confirmation.

**Code changes:**

1. **Env file schema validation** in `src/index.ts:createServer()`:
   ```typescript
   const EnvSchema = z.object({
     BUZZ_PRIVATE_KEY: z.string().regex(/^[0-9a-f]{64}$/),
     BUZZ_RELAY_URL: z.string().url().optional(),
     BUZZ_RELAY_URLS: z.string().optional()
       .transform(s => s ? JSON.parse(s) : undefined)
       .pipe(z.array(z.string().url()).optional()),
     BUZZ_RELAY_DEFAULT: z.string().url().optional(),
     BUZZ_CHANNEL_CACHE_TTL_MS: z.coerce.number().default(300_000),
     BUZZ_MCP_MODE: z.enum(['read-only', 'mutate-with-confirm', 'mutate']).default('mutate'),
     BUZZ_MCP_LOG: z.string().default('info'),
     BUZZ_MCP_LOG_FILE: z.string().optional(),
     BUZZ_RELAY_HOST_0: z.string().optional(),
     BUZZ_RELAY_HOST_1: z.string().optional(),
     BUZZ_RELAY_HOST_2: z.string().optional(),
     BUZZ_RELAY_HOST_3: z.string().optional(),
     CF_ACCESS_CLIENT_ID: z.string().optional(),
     CF_ACCESS_CLIENT_SECRET: z.string().optional(),
   });
   ```
   Failure modes that today are silent become loud:
   - Missing `BUZZ_PRIVATE_KEY` → server fails to start with a clear error.
   - Malformed `BUZZ_RELAY_URLS` JSON → server fails to start with parse error.
   - Wrong-format secret → server fails to start with regex violation.

2. **`BUZZ_MCP_MODE` enforcement** in each write tool (`buzz_post_message`, `buzz_edit_message`, `buzz_react`, `buzz_create_channel`):
   - `read-only` → refuse at tool dispatch; return `{error: 'MCP is in read-only mode'}`.
   - `mutate-with-confirm` → log the unsigned event JSON to stderr at WARN level, return `{status: 'pending-confirm', unsigned_event: {...}}`. Operator must re-call with `confirm: true` to actually sign and post.
   - `mutate` → today behavior.
   - **Default is `mutate-with-confirm` for any new installation** — see Phase 5.

3. **`dryRun: true` per write tool** — returns the unsigned event JSON for inspection without signing or sending.

4. **Per-call `relays: string[]` allowlist check** — if `BUZZ_RELAY_ALLOWED` is set and any relay in `relays[]` isn't in the allowlist, refuse with explicit error.

**Effort:** ~200 lines + tests. ~1 day.
**Risk:** Behavior change for any operator relying on the silent-failure modes. Acceptable: silent failure has never been useful.
**Sign-off:** Operator reviews the schema and mode names.

### Phase 2 — Observability

**Goal:** Operator can see what the MCP did without attaching a debugger.

**Code changes:**

1. **Structured file logging** in `src/util/log.ts`:
   - One-line JSON per log event: `{ts, level, relay, tool, event_id?, latency_ms, ...}`.
   - Default sink: stderr (today).
   - If `BUZZ_MCP_LOG_FILE` is set: also write to that file. Use rotating file (size-based, 5MB × 3).
   - Path convention: `~/Library/Logs/xyz.block.buzz.app/agents/<agent-pid>/buzz-mcp.log` when running under Buzz.app.

2. **Per-relay stats** in `src/relay/stats.ts`:
   ```typescript
   interface RelayStats {
     url: string;
     calls_total: number;
     success: number;
     rejected_400: number;
     rejected_401: number;
     rejected_403: number;
     timeout: number;
     latency_p50_ms: number;
     latency_p95_ms: number;
     last_success_at: number;
     last_error_at: number;
   }
   ```
   Updated on every signed fetch. Exposed via new `buzz_get_stats` MCP tool.

3. **Audit log** for successful writes: `{ts, operator_pubkey, relay, kind, event_id, channel, content_preview}`. Separate file from the structured log. Default path: `~/Library/Logs/xyz.block.buzz.app/agents/audit.log`. Never rot.

4. **Health probe script** at `scripts/relay-health-check.sh`:
   ```bash
   #!/usr/bin/env bash
   # Probes NIP-11 + /query for each configured relay, exits non-zero if any unreachable.
   # Reports to stdout for cron + launchd integration.
   ```
   Cron entry: `*/15 * * * * /Users/gogetta/Documents/projects/CorePrt/scripts/relay-health-check.sh >> ~/Library/Logs/relay-health.log 2>&1`.

**Effort:** ~150 lines + tests + the bash script. ~0.5 day.
**Risk:** Negligible — additive.
**Sign-off:** None required; additive observability.

### Phase 3 — Multi-relay plumbing (the technical core)

**Goal:** One MCP server, multiple relays, transparent to the caller.

**Code changes:**

1. **`BUZZ_RELAY_URLS` parsing** in `src/index.ts` — already covered by Phase 1 schema. Just wire it into a `RelayPool` instantiation.

2. **New `RelayPool` class** at `src/relay/pool.ts`:
   - NIP-11 probe on construct; re-probe on NIP-11 fetch failure.
   - Channel UUID resolution cache (5 min TTL, configurable).
   - `signedFetchEach(opts)` — fans out a signed fetch to N>=1 relays; returns `RelayResponse[]`.
   - 1.5s sleep + 1 retry on `401 NIP-98 replay detected`.
   - 5s per-relay timeout.
   - Per-relay Host header derivation (override-able via `BUZZ_RELAY_HOST_<n>`).

3. **`ChannelResolver` module** at `src/relay/channel-resolver.ts`:
   - `resolveChannelAcrossRelays(pool, name)` → `{byRelay: Map<url, uuid>, missing: string[]}`.
   - Strategy: for each relay, `POST /query` with `{kinds:[9007], '#h': [<uuids-if-known>], limit: 50}`. Match by `name` tag.
   - Cache key: `channel-name`. Cache value: `Map<relay-url, uuid>` with expiry timestamp.
   - `forceRefresh: true` bypasses cache. Used after `create_channel` and on explicit invalidation.

4. **Tool signature additions** — every write tool gets `relays?: string[]` and `allowFanout?: boolean` (default true). Every tool result gets `posts: [{relay, accepted, event_id?, status?, body?}]`.

5. **Replace single-relay reference** throughout:
   - `src/tools/messages.ts`: `post_message`, `edit_message`, `react` use `pool.signedFetchEach`.
   - `src/tools/channels.ts`: `create_channel`, `list_channels`, plus new `list_relays`.
   - `src/tools/summaries.ts`: `subscribe`, `fetch_events`, `search` thread relay field through results.

**Effort:** ~700 lines + ~200 lines tests. ~1.5 days.
**Risk:** Highest in the plan. Backwards-compatible but additive surface; downstream consumers must ignore new fields. Smoke test each one (claude-cli, codex-cli, Buzz.app).
**Sign-off:** Operator reviews the RelayPool API and ChannelResolver cache invalidation strategy before implementation starts.

### Phase 4 — Subscription multiplexing

**Goal:** `buzz_subscribe` opens one WebSocket per configured relay; events are deduped by `id` on poll.

**Code changes:**

1. **SubscriptionManager** in `src/relay/subscription-manager.ts` (already exists per memory; extend, don't replace):
   - One WebSocket pool per configured relay URL.
   - `start(filter, opts)` issues a `REQ` on each pool with the same `sub_id`.
   - `poll()` merges events from all pools, dedup by `event.id`, then strips per-relay origin from the merged set.
   - `stop()` closes all sub-sockets cleanly.

2. **Backpressure:** if any pool's queue exceeds 1000 events, drop and warn. The dedup'd set is the source of truth, not any single pool.

3. **Per-call `relays?: string[]` for subscribe:** override which pools to subscribe to. Default = all configured.

**Effort:** ~150 lines + tests. ~0.5 day. Depends on Phase 3 being done.
**Risk:** Medium. Subscription management is the most subtle part of the existing code; concurrent WebSocket lifecycle is non-trivial.
**Sign-off:** None required; behavior is a superset.

### Phase 5 — Rollout + documentation

**Goal:** A new operator can set this up in 30 minutes without reading source code.

**Tasks:**

1. **Update `~/.gg/mcp.json` example** in `docs/mcp-config.example.json` (the upstream source-of-truth per memory). Show the multi-relay config; show the read-only mode for new installations.
2. **Update CLAUDE.md** with three short, dated sections:
   - "MCP mode precedence" (5 lines).
   - "Multi-relay config" (8 lines, with example env block).
   - "Operational logs" (4 lines, point to file paths).
3. **Update CHANGELOG.md** with a 2026-08-02 entry referencing this plan.
4. **Smoke test plan** for each downstream consumer:
   - claude-cli: confirm new fields ignored.
   - codex-cli: confirm new fields ignored.
   - Buzz.app: confirm channel routing via `apply_workspace` overrides new config.
5. **Operator onboarding doc** `docs/onboarding.md` (new) — 1-page walkthrough: install, configure, verify, troubleshoot.

**Effort:** ~half day.
**Risk:** None.

## Cross-cutting decisions

These apply to every phase and are recorded here so they're not lost.

1. **No silent failures.** Anywhere a check exists today (`status < 300`, regex match, JSON parse), make it loud. The MCP should fail at startup on bad config, not silently produce wrong results at runtime.
2. **Destructive operations need friction.** Phase 1 introduces `BUZZ_MCP_MODE=mutate-with-confirm` as the default. Existing operators can opt out by setting `BUZZ_MCP_MODE=mutate` in their env.
3. **Additive schemas only.** No breaking changes to existing tools' inputs/outputs. New fields are added; existing fields are preserved.
4. **Files in `~/Library/Logs/` follow Apple convention.** Path naming matches what other apps on this Mac already do (`xyz.block.buzz.app/agents/<pid>/`). Less surprising to future tooling.
5. **Documentation has a date in the filename.** Every `docs/<YYYY-MM-DD>-*.md` artifact is dated. CLAUDE.md references them by date, doesn't duplicate.
6. **Memory entries are conservative.** Only save facts that materially help future sessions. One concise self-contained fact per memory. Update or forget when superseded.

## Open items still to resolve

The following are not decided in this plan and need operator input before Phase 3 starts:

1. **Cache TTL value.** Plan says 5 min. Tunable via env. If operator wants shorter (30s for tighter consistency), set `BUZZ_CHANNEL_CACHE_TTL_MS=30000` in env.
2. **Default mode for new installations.** Plan says `mutate-with-confirm`. Operator can override to `mutate` (current behavior) or `read-only`. Pick at install time.
3. **Phase 0 keep/delete list.** Operator chose Path 1: delete #1, #3, #4, #5; preserve #6; keep #2. 2 of 4 deletable channels were deleted. 3 server-assigned channels remain due to relay-side UUID exposure gap. **Operator closed Phase 0 with option 1** (accept partial cleanup). Phase 0 done.
4. **Audit log rotation.** Plan says never rotate. If disk usage becomes a concern, add size-based rotation later. Not now.
5. **Webhook subscriptions (out of scope but mentioned).** When we get to it, separate spec.

## Rollout checklist

In order:

- [x] **Phase 0 inventory complete (2026-08-02)** — Channel list documented. See Phase 0 section.
- [x] **Phase 0 partial destructive action (2026-08-02)** — Deleted 2 of 4 confirmed-noise channels (#3 `e39006f8-…`, #4 `81f7fbca-…`). 3 server-assigned channels (#1, #5, #6) cannot be deleted without relay-side UUID exposure (NIP-87 endpoint, admin CLI, or upstream relay fix). See Phase 0 execution section.
- [x] **Phase 0 closure (2026-08-02, option 1)** — Operator accepted partial cleanup. 3 server-assigned channels (`test-no-h`, `general` "hello world smoke test", `general` "the main lobby") remain in the relay's channel index as cosmetic noise. Future MCP iterations may filter duplicates by name when resolving channels. **Phase 0 closed.**
- [ ] **Phase 1** — Config schema + modes + dry-run. Land as `feat/mcp-config-discipline`. ~1 day.
- [ ] **Phase 2** — Observability. Land as `feat/mcp-observability`. ~0.5 day. No dependencies.
- [ ] **Phase 3** — Multi-relay core. Land as `feat/multi-relay-pool` (the original PR branch name from the superseded spec). ~1.5 days. Depends on Phase 1.
- [ ] **Phase 4** — Subscription multiplexing. Land as `feat/multi-relay-subscribe`. ~0.5 day. Depends on Phase 3.
- [ ] **Phase 5** — Docs + smoke tests. Land as `docs/multi-relay-rollout`. ~0.5 day. Can run in parallel with Phase 4.

Total: ~4.5 days of focused work, sequenced. With CI + review + smoke tests, calendar time is closer to 1.5–2 weeks.

## What we are NOT doing in this plan

Called out explicitly so they don't sneak in via "while we're at it":

- **Cross-relay event migration.** Operator creates channels on the relays they want. We don't move data between relays automatically.
- **Push notifications.** NIP-17 push stays single-relay. Block-hosted relay has the APNs config; self-hosted doesn't (operator can add it later if needed).
- **Mirror relay selection.** A write to `coreprt.webrnds.com` is not automatically mirrored to `webrnds.communities.buzz.xyz`. The MCP fan-out is the operator's choice, not implicit.
- **Multi-operator support.** Single-operator assumption throughout. If a second operator joins, the plan changes shape significantly (separate config namespace, separate audit log, separate allowlists).
- **Web UI for relay management.** Configuration stays in env files and `~/.gg/mcp.json`. No GUI work in scope.

## References

- `docs/2026-08-02-buzz-mcp-multi-relay.md` — superseded technical spec, kept as reference.
- `docs/2026-08-02-mcp-diagnostic.md` — the 5-bug trace that motivated this plan.
- `docs/2026-07-30-operator-runbook.md` — pattern for dated runbook docs.
- `docs/access-policy.md` — pattern for security-load-bearing source-of-truth docs.
- `docs/RUNBOOK.md` — TBD; referenced but not yet created. Phase 5 deliverable.
