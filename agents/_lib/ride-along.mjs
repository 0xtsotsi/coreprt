// agents/_lib/ride-along.mjs
//
// NIP-46 ride-along observer. Connects to a remote signer (bunker) over a
// NIP-46 RPC channel, derives the connection key from the bunker's
// kind:24133 announcement pubkey, and exercises the protocol with a couple
// of representative requests:
//
//   1. get_public_key       — confirms the channel works + reveals the user
//                              pubkey (the one the bunker signs on behalf of)
//   2. sign_event:1         — asks the bunker to sign a kind:1 note
//
// Security invariant: the ride-along observer NEVER touches the agent's
// nsec. It only sees:
//   • the bunker pubkey (from the kind:24133 event, public on the relay)
//   • the user pubkey (returned by get_public_key, public after the call)
//   • the signed event (returned by sign_event, public once published)
//
// The observer's *own* private key stays local — it's used only to encrypt
// requests to the bunker. This module never imports the agent's nsec; the
// caller passes nothing but a freshly-generated client keypair (or reuses a
// long-lived one across rides).
//
// Wire format (NIP-46):
//   kind: 24133
//   tags:  [["p", <recipient-pubkey>]]    — only the recipient
//   content: <NIP-44 encrypted RPC payload>
//   payload:
//     {"id": <random>, "method": "<name>", "params": [...]}
//   response: same shape with `result` or `error`.
//
// The transport here is the relay URL the bunker advertised in its
// kind:24133 `relay` tag(s). We pick the first one and open a subscription
// for events p-tagged to our observer pubkey; we publish our request as a
// kind:24133 p-tagged to the bunker.
//
// This module is intentionally small + dependency-light so the same code
// path can be unit-tested with an in-memory mock signer (see __tests__).

import { finalizeEvent, generateKeypair, getKeypairFromHex, verifyEvent } from "./nostr.mjs";
import { getConversationKey, v2Decrypt, v2Encrypt } from "./nip44.mjs";
import { hexToBytes, randomBytes } from "@noble/hashes/utils";
import { KIND_BUNKER_ANNOUNCEMENT, parseBunkerAnnouncement } from "./bunker.mjs";

// Build an unsigned NIP-46 RPC request envelope. The returned object is a
// plain JSON-serializable payload; callers sign it via NIP-44 under the
// conversation key and embed the ciphertext as the kind:24133 content.
export function buildRequest({ id, method, params }) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("rpc request id is required");
  }
  if (typeof method !== "string" || method.length === 0) {
    throw new Error("rpc method is required");
  }
  if (!Array.isArray(params)) {
    throw new Error("rpc params must be an array");
  }
  return { id, method, params };
}

// Build a kind:24133 event template for a NIP-46 request (p-tagged to the
// remote signer). Content is set by the caller (NIP-44 ciphertext).
export function buildRequestTemplate({ requestJson, recipientPubkey }) {
  if (typeof recipientPubkey !== "string" || !/^[0-9a-f]{64}$/i.test(recipientPubkey)) {
    throw new Error("recipientPubkey must be 64 hex");
  }
  return {
    kind: KIND_BUNKER_ANNOUNCEMENT,
    content: requestJson,
    tags: [["p", recipientPubkey.toLowerCase()]],
    created_at: Math.floor(Date.now() / 1000),
  };
}

// Decrypt + parse a NIP-46 RPC response payload. Validates the outer event
// signature before trusting the content (NIP-44 §Decryption rule). Throws on
// MAC mismatch, version mismatch, or signature failure.
export function parseResponse({ event, conversationKey }) {
  if (!event) throw new Error("no event");
  // Verify event signature first — required by NIP-44.
  if (!verifyEvent(event)) {
    throw new Error("response event signature is invalid");
  }
  const payload = v2Decrypt(event.content, conversationKey);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(`response is not valid JSON: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("response must be a JSON object");
  }
  if (typeof parsed.id !== "string") {
    throw new Error("response is missing id");
  }
  return parsed;
}

// Build a NIP-44-encrypted RPC request envelope (signed kind:24133 event)
// ready to publish. Returns:
//   { event, conversationKey, request }
// The caller publishes `event` to the bunker. Decrypting the response
// requires `conversationKey`.
//
// `clientKeypair` is the OBSERVER's keypair — distinct from any agent
// keypair and from the bunker's keypair. We never see the agent's nsec.
export function buildEncryptedRequest({
  clientKeypair,
  bunkerPubkey,
  method,
  params = [],
  id,
  secret,
}) {
  const requestId = id ?? Buffer.from(randomBytes(8)).toString("hex");
  const request = buildRequest({
    id: requestId,
    method,
    params: secret !== undefined ? [secret, ...params] : params,
  });
  const conversationKey = getConversationKey(
    hexToBytes(clientKeypair.skHex),
    bunkerPubkey.toLowerCase(),
  );
  const ciphertext = v2Encrypt(JSON.stringify(request), conversationKey);
  const template = buildRequestTemplate({
    requestJson: ciphertext,
    recipientPubkey: bunkerPubkey,
  });
  const event = finalizeEvent(template, hexToBytes(clientKeypair.skHex));
  return { event, conversationKey, request };
}

// Convenience wrapper that wraps a whole ride-along round trip. This is the
// surface the runtime / one-shot / tests call.
//
//   const result = await rideAlong({
//     clientKeypair,
//     bunkerEvent,        // the kind:24133 event published by the bunker
//     publish,            // async (event) => any
//     subscribe,          // (filter, onEvent) => unsubscribeFn
//     signEventTemplate,  // async (template) => signedEvent  (signs an unsigned
//                          //   kind:1 template the bunker should counter-sign)
//     log = console.log,
//   });
//
// `publish` and `subscribe` are injected so the same code works against a
// real RelayClient OR an in-memory mock for tests. `signEventTemplate`
// defaults to `finalizeEvent` from nostr.mjs.
//
// Returns:
//   { userPubkey, signedNoteId, status: 'ride-along ok' }
//
// On error: throws with a descriptive message; the caller is expected to log
// + exit non-zero. We do not catch here because the CLI wrapper wants a
// distinct error path from the success path.
export async function rideAlong({
  clientKeypair,
  bunkerEvent,
  publish,
  subscribe,
  signEventTemplate = defaultSignEventTemplate,
  log = () => {},
  timeoutMs = 5_000,
}) {
  if (!clientKeypair) throw new Error("clientKeypair is required");
  const parsed = parseBunkerAnnouncement(bunkerEvent);
  const bunkerPubkey = parsed.pubkey;
  const conversationKey = getConversationKey(
    hexToBytes(clientKeypair.skHex),
    bunkerPubkey.toLowerCase(),
  );

  // ── 1. get_public_key ─────────────────────────────────────────────
  log("[ride-along] requesting get_public_key");
  const getPubkey = buildEncryptedRequest({
    clientKeypair,
    bunkerPubkey,
    method: "get_public_key",
    params: [],
  });
  // Register the inFlight entry BEFORE subscribing + publishing so a fast
  // response (e.g. in-memory mock transport) can't arrive before the
  // awaiter is recorded and get silently dropped.
  const getPubkeyResult = waitForResult(getPubkey.request.id, timeoutMs, "get_public_key");
  const unsubGet = subscribe(
    { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [clientKeypair.pkHex] },
    (event) => handleResponse(event, conversationKey, getPubkey.request.id),
  );
  await publish(getPubkey.event);
  const userPubkey = await getPubkeyResult;
  unsubGet?.();
  if (typeof userPubkey !== "string" || !/^[0-9a-f]{64}$/i.test(userPubkey)) {
    throw new Error(`get_public_key returned non-pubkey string: ${String(userPubkey)}`);
  }
  log(`[ride-along] user pubkey: ${userPubkey}`);

  // ── 2. sign_event:1 ───────────────────────────────────────────────
  // The observer signs an UNSIGNED kind:1 template (content + tags only,
  // no id/sig) and asks the bunker to counter-sign it.
  const noteTemplate = {
    kind: 1,
    content: "ride-along test",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };
  const unsigned = JSON.stringify(noteTemplate);
  const signReq = buildEncryptedRequest({
    clientKeypair,
    bunkerPubkey,
    method: "sign_event",
    params: [unsigned],
  });
  log("[ride-along] requesting sign_event:1");
  const signResult = waitForResult(signReq.request.id, timeoutMs, "sign_event");
  const unsubSign = subscribe(
    { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [clientKeypair.pkHex] },
    (event) => handleResponse(event, conversationKey, signReq.request.id),
  );
  await publish(signReq.event);
  const signed = await signResult;
  unsubSign?.();

  // NIP-46 returns the full event as a JSON-stringified object.
  let parsedSigned;
  try {
    parsedSigned = typeof signed === "string" ? JSON.parse(signed) : signed;
  } catch (err) {
    throw new Error(`sign_event returned non-JSON: ${String(signed)}`);
  }
  if (!parsedSigned || typeof parsedSigned !== "object" || !parsedSigned.id) {
    throw new Error("sign_event response missing id field");
  }
  if (parsedSigned.pubkey !== userPubkey) {
    throw new Error(
      `sign_event response pubkey mismatch (got ${parsedSigned.pubkey}, expected ${userPubkey})`,
    );
  }
  if (!verifyEvent(parsedSigned)) {
    throw new Error("signed event signature failed verification");
  }
  log(`[ride-along] signed note id: ${parsedSigned.id}`);

  return {
    userPubkey,
    signedNoteId: parsedSigned.id,
    status: "ride-along ok",
  };
}

// State for in-flight RPCs. We expose it as a small registry so tests can
// inspect/short-circuit without monkey-patching.
const inFlight = new Map();

function handleResponse(event, conversationKey, expectedId) {
  if (process.env.RIDE_ALONG_DEBUG) {
    console.log("[ride-along] handleResponse called for event", event.id.slice(0, 8), "expectedId:", expectedId);
  }
  try {
    const parsed = parseResponse({ event, conversationKey });
    if (process.env.RIDE_ALONG_DEBUG) {
      console.log("[ride-along] parsed.id:", parsed.id);
    }
    if (parsed.id !== expectedId) return; // not our response
    const entry = inFlight.get(expectedId);
    if (!entry) return;
    inFlight.delete(expectedId);
    if (parsed.error && typeof parsed.error === "string") {
      entry.reject(new Error(`rpc error: ${parsed.error}`));
    } else {
      entry.resolve(parsed.result);
    }
  } catch (err) {
    if (process.env.RIDE_ALONG_DEBUG) {
      console.error("[ride-along] handleResponse dropped event:", err.message);
    }
  }
}

function waitForResult(id, timeoutMs, method) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, method };
    inFlight.set(id, entry);
    setTimeout(() => {
      if (inFlight.get(id) === entry) {
        inFlight.delete(id);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

function defaultSignEventTemplate(template) {
  const kp = generateKeypair();
  return finalizeEvent(template, hexToBytes(kp.skHex));
}

// In-memory mock transport used by tests. Mirrors the same interface as
// RelayClient.{publish, subscribe} so tests can inject it without spinning
// up a websocket. Subscribers receive every published event whose filter
// matches. Mock transport does NOT dispatch through a relay — the observer
// callback must invoke `subscribe` first, then the publish handler runs
// directly against the registered handlers.
//
// exportForTesting is the conventional pattern used by the rest of the
// agents/_lib unit tests (see one-shot/__tests__/user-status.test.mjs).
export function createMockTransport() {
  const subscribers = new Set();
  const published = [];
  return {
    async publish(event) {
      published.push(event);
      // Synchronously dispatch to subscribers so observers don't race.
      for (const { filter, onEvent } of subscribers) {
        if (!matchesFilter(event, filter)) continue;
        onEvent(event);
      }
      // Yield to the microtask queue once so async listeners (e.g. the mock
      // bunker's decrypt/sign/publish pipeline) can synchronously dispatch
      // their reply onto the same transport before the caller resumes. The
      // observer registers its awaiter BEFORE publishing, so the reply
      // resolves it on the same turn.
      await Promise.resolve();
      return { ok: true };
    },
    subscribe(filter, onEvent) {
      // Snapshot published.length BEFORE adding the subscriber, so the
      // catch-up only replays events from prior turns (matching real
      // relay behaviour). The current turn's events are already delivered
      // synchronously by publish().
      const seenUpTo = published.length;
      const entry = { filter, onEvent };
      subscribers.add(entry);
      queueMicrotask(() => {
        for (let i = 0; i < seenUpTo; i += 1) {
          const event = published[i];
          if (!matchesFilter(event, filter)) continue;
          try { onEvent(event); } catch { /* ignore */ }
        }
      });
      return () => subscribers.delete(entry);
    },
    published,
    subscribers,
  };
}

function matchesFilter(event, filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter["#p"] && Array.isArray(event.tags)) {
    const eventPs = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
    if (!filter["#p"].some((p) => eventPs.includes(p))) return false;
  }
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  return true;
}