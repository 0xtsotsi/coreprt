# Multi-relay support for `@buzz/mcp`

**Status:** Draft spec, 2026-08-02
**Target:** `0xtsotsi/buzz-mcp` (fork of `gogetta/buzz-mcp`)
**Author:** operator session, CorePrt relay stack
**Scope:** Additive, backwards-compatible
**Estimated effort:** 1–2 days for a focused PR including tests

## Problem statement

`@buzz/mcp` today speaks to exactly one Nostr relay per process. The relay URL is read once at `createServer()` from `BUZZ_RELAY_URL` and bound into `signedFetch`. All tool calls — read (`subscribe`, `fetch_events`, `list_channels`) and write (`post_message`, `edit_message`, `react`, `create_channel`) — go to that single relay.

The operator has two parallel relays running, both with the same `self` pubkey (`5430c42f…`):

| Relay | URL | Operator is member? | Channels |
|---|---|---|---|
| Self-hosted | `wss://coreprt.webrnds.com` | ✅ Yes (3 members including owner) | 6× `general` (5 server-assigned, 1 with UUID `0afe2e00-a9c7-4941-954f-c200c2429e3f`) |
| Block-hosted | `wss://webrnds.communities.buzz.xyz` | ✅ Yes (the operator is the only member of `#general`) | `Welcome`, `general`, others (Block-managed) |

Buzz.app's chat UI (`xyz.block.buzz.app`) is bound to one relay at a time via the `apply_workspace` path (`~/.Library/Application Support/xyz.block.buzz.app/agents/agent-pids/*.json`). Operators who want to use a single MCP against both relays today must run two MCP processes with two different `BUZZ_RELAY_URL` values. That's brittle and doesn't match how a model client (Claude Desktop, claude-cli, codex-cli) consumes the tool surface.

This spec adds first-class multi-relay support so one MCP server can route reads/writes across a configured set of relays transparently, with per-channel disambiguation, channel-UUID caching, and partial-failure surfacing.

## Goals

1. **Backwards compatible.** A single `BUZZ_RELAY_URL` still works exactly as today. Existing `~/.gg/mcp.json` configs don't change.
2. **Multi-relay reads.** `subscribe`, `list_channels`, `fetch_events`, and `search` see events from all configured relays, deduplicated by event `id`.
3. **Multi-relay writes, configurable per call.** `post_message`, `edit_message`, `react`, and `create_channel` accept an optional `relays?: string[]` parameter that overrides routing for that one call. Default routing: try each configured relay in order, succeed if at least one accepts.
4. **Channel-name resolution.** `h:<channel-name>` (lowercase name form) is **explicitly rejected** by the deployed relays (NIP-29 channels are addressed by UUID on both `coreprt.webrnds.com` and `webrnds.communities.buzz.xyz`). The MCP resolves `channel` to a UUID per relay by querying kind:9007 events and caching the result.
5. **Partial-failure visibility.** When a write fans out across multiple relays, the tool result surfaces which relays accepted and which rejected, with structured error codes (`{relay, status, body}`).
6. **No silent data loss.** A `restricted: not a channel member` from one relay must not be hidden by an `accepted: true` from another.

## Non-goals

- **Cross-relay event deduplication by content hash.** Two relays may have the same event id but slightly different `content` (impossible in practice — NIP-01 events are content-addressed by id — but called out for clarity).
- **Relay-to-relay event migration.** If a channel exists on relay A but the operator wants it on relay B, the operator creates it on B; we don't move it automatically.
- **Push notification handling.** NIP-17 push events stay single-relay (their origin is part of the event envelope).
- **Write amplification beyond the configured list.** If the operator wants to fan out a write to relays not in the configured list, they explicitly add the relay first.

## Design

### Configuration

Three env vars, all read at `createServer()` time:

```
BUZZ_RELAY_URL          # backwards-compat: single URL, optional
BUZZ_RELAY_URLS         # JSON array, takes precedence over single URL
BUZZ_RELAY_DEFAULT      # primary relay for writes when relays[] not specified
```

Resolution order in `createServer()`:
1. If `BUZZ_RELAY_URLS` is set and parseable as JSON array → use it as the relay list. The first element is also `BUZZ_RELAY_DEFAULT`.
2. Else if `BUZZ_RELAY_URL` is set → use it as a single-element list, also the default.
3. Else → throw "no relay configured" (today's behavior).

Example `~/.gg/mcp.json` env block for an operator with both relays:

```json
"env": {
  "BUZZ_PRIVATE_KEY": "${env:BUZZ_PRIVATE_KEY}",
  "BUZZ_RELAY_URLS": "[\"wss://coreprt.webrnds.com\",\"wss://webrnds.communities.buzz.xyz\"]",
  "BUZZ_MCP_LOG": "info",
  "DOTENV_CONFIG_PATH": "/Users/gogetta/.config/coreprt/buzz-mcp.env"
}
```

### Relay pool

Replace the implicit single-relay reference throughout `dist/` with a `RelayPool` class:

```typescript
// src/relay/pool.ts (new)

export interface RelayEndpoint {
  url: string;
  /** Cached NIP-29 community id (UUID), null until first probe. */
  communityId: string | null;
  /** Cached NIP-11 doc, null until first probe. */
  nip11: RelayInformationDocument | null;
  /** Last NIP-98 auth window timestamp; used to dedupe rapid-fire kind:27235. */
  lastAuthAt: number;
}

export interface RelayInfo {
  url: string;
  communityId: string | null;
  capabilities: {
    nips: number[];
    extensions: string[];
  };
}

export class RelayPool {
  private endpoints: RelayEndpoint[] = [];
  private channelCache = new Map<string /* channel-name */, Map<string /* relay-url */, string /* channel-uuid */>>();
  private channelCacheExpiresAt = new Map<string, number>();

  constructor(urls: string[]) { /* ... */ }
  async probe(): Promise<RelayInfo[]> { /* NIP-11 fetch per relay */ }

  /** Resolve channel name to per-relay UUID map. Cache TTL: 5 minutes. */
  async resolveChannel(name: string): Promise<Map<string, string>>;

  /** Fetch NIP-98 signed request, retried once per relay if 401 NIP-98 replay. */
  async signedFetchEach(opts: SignedFetchOpts): Promise<RelayResponse[]>;

  /** Multiplex a subscription across all relays, dedup by event id. */
  async subscribe(filter: NostrFilter, opts: { kinds?, limit?, since?, until?, '#h'?, '#t'?, authors? }): Promise<NostrEvent[]>;
}
```

### Channel UUID resolution

Today: `buildMessage` emits `["h", normalizeChannel(opts.channel)]` and the relay rejects lowercase names. Resolution belongs in the tool layer, not the builder, because:

- The builder must remain pure (no IO).
- Different relays may resolve the same name to different UUIDs.
- Cache invalidation is per-relay.

New module:

```typescript
// src/relay/channel-resolver.ts (new)

export interface ChannelResolution {
  /** map of relay URL -> channel UUID */
  byRelay: Map<string, string>;
  /** relays where the channel does not exist */
  missing: string[];
}

export async function resolveChannelAcrossRelays(
  pool: RelayPool,
  name: string,
): Promise<ChannelResolution> {
  // For each configured relay:
  //   POST /query filter { kinds: [9007], '#h': [<existing-uuids-if-known>], limit: 50 }
  //   Find event with `name` tag matching `name`
  //   If found, capture its `h` tag (UUID)
  //   If not found, add to `missing`
  // Cache for 5 minutes; refresh on cache miss or explicit `forceRefresh: true`.
}
```

### Tool signature changes

All tool signatures add `relays?: string[]` and an output wrapper where applicable. None of the existing required parameters change.

```typescript
// Example: buzz_post_message

input: {
  channel: string,           // channel name OR UUID
  content: string,
  replyTo?: string,
  imeta?: ImetaEntry[],
  // NEW:
  relays?: string[],         // override routing; default = all configured
  allowFanout?: boolean,     // default true. If false and the channel exists on multiple relays, error.
},

output: {
  accepted: boolean,
  event_id: string | null,   // first accepted event_id; null if all relays rejected
  posts: Array<{
    relay: string,
    accepted: boolean,
    event_id?: string,
    status?: number,
    body?: string,
  }>,
  // existing fields preserved
}
```

Other tools get analogous additions:

| Tool | New optional params | Output changes |
|---|---|---|
| `buzz_post_message` | `relays?`, `allowFanout?` | `posts[]` per-relay result |
| `buzz_edit_message` | `relays?` | `edits[]` per-relay result |
| `buzz_react` | `relays?` | `reactions[]` per-relay result |
| `buzz_create_channel` | `relays?` | `channels[]` per-relay result; each relay may assign its own UUID |
| `buzz_subscribe` | `relays?` | (no change — already multiplexed via SubscriptionManager) |
| `buzz_list_channels` | `relays?` | result adds `relay` field per channel |
| `buzz_fetch_events` | `relays?` | events add `relay` field indicating origin |
| `buzz_search` | `relays?` | events add `relay` field indicating origin |
| `buzz_get_identity` | — | also returns configured relays |
| NEW: `buzz_list_relays` | — | returns `{url, community_id, capabilities, last_probed_at}` per relay |

### Subscription multiplexing

Today, `SubscriptionManager` opens one WebSocket per `subscribe` call. Extend to one WebSocket per configured relay, then merge results:

```typescript
// src/relay/subscription-manager.ts (modify)

export class SubscriptionManager {
  private pools: Map<string, WebSocketPool>; // relay URL -> WS pool

  async start(filter: NostrFilter, opts: { relays?: string[] }): Promise<{ sub_id: string }> {
    const relays = opts.relays ?? [...this.pools.keys()];
    const sub_id = randomUUID();
    for (const relay of relays) {
      this.pools.get(relay)!.send(["REQ", sub_id, filter]);
    }
    return { sub_id };
  }

  // poll() merges events from all pools, dedup by event id, then strips origin before returning
}
```

Event dedup key is `event.id`. If two relays return the same event (which is normal for kind:1 notes that propagate across the nostr network), it shows up once.

### Write fan-out semantics

Per-call rules:

1. If `relays?: string[]` is provided, only fan out to those relays.
2. If `relays?` is empty array → error "relays parameter must be non-empty if provided".
3. If `relays?` is omitted:
   - Resolve `channel` across all configured relays.
   - If channel exists on exactly one relay → post to that one.
   - If channel exists on multiple relays → fan out to all of them (default `allowFanout=true`).
   - If `allowFanout=false` and channel exists on multiple → error "channel exists on multiple relays; set relays=[...] to disambiguate or allowFanout=true to fan out".
4. If `channel` is a UUID (matches `/^[0-9a-f-]{36}$/`) → post to all relays that have this UUID in their index. Most likely one.
5. If `channel` is a name and not found on any relay → error "channel not found on any configured relay".
6. For each target relay:
   - Build the event with the relay's NIP-29 Host header.
   - Sign once with the operator's keypair.
   - Send NIP-98 signed POST.
   - If 401 NIP-98 replay → wait 1.5s and retry once.
   - If 400/403/etc → record error in `posts[i]`, continue.
7. Return when all relays have responded or 5s timeout (per-relay).

### Partial failure reporting

The output includes a `posts[]` array. Each entry has:

```typescript
{
  relay: string,
  accepted: boolean,
  event_id?: string,
  status?: number,
  body?: string,        // relay error body, if rejected
  error?: string,       // client-side error, if network/timeout
}
```

Top-level `accepted` is `true` iff at least one `posts[i].accepted === true`. Top-level `event_id` is the first accepted event_id. Tools that need stricter semantics (e.g. "all-or-nothing") can be added later with a `requireAllAccepted: true` flag.

### Cache invalidation

Two cache layers:

1. **NIP-11 cache.** Probe once per process start. Invalidate on NIP-11 fetch failure (re-probe on next call).
2. **Channel UUID cache.** TTL = 5 minutes per channel name. Invalidate when:
   - A `create_channel` for that name succeeds on any relay (the new event has the fresh UUID).
   - A `subscribe` returns a kind:9007 event with that name and a different UUID than cached.
   - Explicit `forceRefresh: true` passed in a tool call.

### Backwards compatibility tests

Required CI checks:

1. Single `BUZZ_RELAY_URL` config produces identical wire behavior to today. Snapshot tests on `dist/` output.
2. `~/.gg/mcp.json` files using `BUZZ_RELAY_URL` continue to work unchanged.
3. Tool schemas published via the MCP `tools/list` request include the new optional parameters.
4. Existing 93 tests still pass.

## File-by-file change list

| Path | Change | Lines |
|---|---|---|
| `src/relay/pool.ts` | new: `RelayPool` class, NIP-11 probe, channel resolution | ~250 |
| `src/relay/channel-resolver.ts` | new: `resolveChannelAcrossRelays`, cache layer | ~120 |
| `src/relay/subscription-manager.ts` | modify: one WebSocket per relay, dedup on poll | ~80 |
| `src/relay/client.ts` | modify: `signedFetch` accepts `relayUrl` param; `buildAuthHeader` is shared | ~30 |
| `src/index.ts` | modify: parse `BUZZ_RELAY_URLS` / `BUZZ_RELAY_URL`, instantiate `RelayPool` | ~40 |
| `src/tools/messages.ts` | modify: post/edit/react go through pool | ~60 |
| `src/tools/channels.ts` | new or modify: `create_channel`, `list_channels`, new `list_relays` | ~120 |
| `src/tools/summaries.ts` | modify: subscribe/fetch/search thread relay field through results | ~30 |
| `src/util/zod.ts` | no change (helpers already accept `optional`) | 0 |
| `tests/multi-relay.test.ts` | new: cross-relay fan-out, dedup, partial-failure | ~200 |
| `docs/multi-relay.md` | new: this file, published as operator docs | ~150 |

**Total:** ~1,080 lines including tests and docs. Realistic landing as a single PR over 1–2 focused days.

## Open questions for sign-off

1. **Cache TTL.** 5 min for channel UUID cache. Too short? Too long? Operationally, channels don't move often; 5 min is generous. Could be 60s for tighter consistency at the cost of more relay queries.

2. **`allowFanout` default.** Spec says `true`. But fan-out writes a message to multiple relays simultaneously, which may not be desired (operator may want one source of truth per channel). Counter-argument: NIP-29 propagation across relays is normal; the operator's intent is usually "this message should be visible to everyone." Default `true` favors visibility.

3. **`relays: []` semantics.** Empty array → error vs "fall through to default." Spec says error, because silent fall-through can mask config mistakes.

4. **Per-relay Host header.** Each relay routes NIP-29 by Host header. For self-hosted relay, the Host is the public DNS name. For Block-hosted, it's `webrnds.communities.buzz.xyz`. The pool needs to track the right Host per relay. `BUZZ_RELAY_URL` provides the WSS host which usually matches the NIP-29 community host; for cases where they differ, we add `BUZZ_RELAY_HOST_<N>=...` overrides.

5. **Tool return shape change.** Existing tools return `{event_id, accepted, ...}`. Adding `posts[]` is additive, but tools that consume the return shape (downstream code in claude-cli, codex-cli, Buzz.app) might still break if they don't ignore unknown fields. MCP JSON-RPC schemas should ignore extras, but worth a smoke test in each consumer.

6. **Webhook subscriptions.** Not in scope. Out-of-scope for this spec, deferred to a follow-up.

## Rollout plan

Once signed off:

1. **PR branch:** `feat/multi-relay-pool` against `0xtsotsi/buzz-mcp:main`.
2. **Land in three commits:**
   - (a) `RelayPool` + `BUZZ_RELAY_URLS` parsing + NIP-11 probe.
   - (b) `ChannelResolver` + per-call `relays[]` param plumbing through `messages.ts`, `channels.ts`, `summaries.ts`.
   - (d) Subscription multiplexing + new `buzz_list_relays` tool + docs.
3. **Rebuild and test against both relays** (`wss://coreprt.webrnds.com`, `wss://webrnds.communities.buzz.xyz`).
4. **Update `~/.gg/mcp.json`** for the multi-relay config.
5. **Operator-facing docs** in `docs/multi-relay.md` (this file), `docs/mcp-config.example.json`, `CHANGELOG.md`.
6. **Smoke test plan:**
   - `buzz_list_relays` returns both endpoints with NIP-11 capabilities.
   - `buzz_list_channels` returns channels from both relays, each with `relay` field.
   - `buzz_post_message {channel:"general", content:"hello from multi-relay"}` lands on both relays' `#general`.
   - `buzz_subscribe` to `#general` returns events from both relays, deduped.
   - If one relay is unreachable, `posts[]` surfaces the error but the other relay's write still succeeds.

## Out of scope for this spec

- `BUZZ_RELAY_AUTH` per-relay auth (e.g. Cloudflare Access service tokens for the self-hosted relay). Currently the MCP honors `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` for the single relay; this spec does not change that behavior, but a future spec should add per-relay overrides since `webrnds.communities.buzz.xyz` doesn't need CF Access.
- Push notifications via NIP-17. Single-relay scope stays as today.
- Event migration between relays. Operator's responsibility.
- Push-proxy / mirror relays. Single-relay scope stays as today.
