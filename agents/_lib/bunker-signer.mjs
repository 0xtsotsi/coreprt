// agents/_lib/bunker-signer.mjs
//
// Adapter that lets the runtime use a remote signer (NIP-46 bunker) as a
// drop-in replacement for `finalizeEvent(template, skBytes)`.
//
// Usage:
//   const signer = await createBunkerSigner({ url, clientKeypair, relay, log });
//   const signedEvent = await signer.sign({ kind: 1, content: "hi", tags: [], created_at });
//
// The signature intentionally matches the `finalizeEvent(template, skBytes)`
// surface (returns a fully-signed Nostr event), so call sites only need
// to swap the helper function — they don't need to know whether the event
// was signed locally or remotely.
//
// When the URL is null/undefined the factory returns `null` and the runtime
// falls back to the existing local-signer path. This is the only signal the
// runtime reads; everything else is encapsulated here.
//
// Wire shape (NIP-46 RPC):
//   client → bunker: kind:24133 p-tagged to bunker, content = NIP-44(JSON-RPC)
//   bunker → client: kind:24133 p-tagged to client, content = NIP-44(JSON-RPC)
//
// This module assumes the caller already has a `relay.publish` and
// `relay.subscribe` available — typically the existing RelayClient. We
// don't talk to the relay directly so the runtime can swap transports.

import { finalizeEvent, generateKeypair } from "./nostr.mjs";
import { getConversationKey, v2Decrypt, v2Encrypt } from "./nip44.mjs";
import {
  buildEncryptedRequest,
  createMockTransport,
  parseResponse,
} from "./ride-along.mjs";
import { parseBunkerUrl, KIND_BUNKER_ANNOUNCEMENT } from "./bunker.mjs";
import { hexToBytes } from "@noble/hashes/utils";

// Build the signer. Returns:
//   { sign(template) => Promise<signedEvent>, close() => void, info }
//
// `info` is a small object the runtime can log on startup so the operator
// can see which signer is in effect without env-diving.
//
// `transport` is an object that matches the surface used by relay-client:
//   { publish(event), subscribe(filter, onEvent), close() }
//
// When AGENT_BUNKER_URL is empty / unset the factory returns null so the
// caller can branch on it explicitly.
export async function createBunkerSigner({ url, clientKeypair, transport, log = () => {} }) {
  if (!url) return null;
  const parsed = parseBunkerUrl(url);
  if (!parsed.remoteSignerPubkey) {
    throw new Error("bunker URL is missing a remote-signer pubkey");
  }
  const kp = clientKeypair ?? generateKeypair();
  log(`[bunker-signer] remote=${parsed.remoteSignerPubkey.slice(0, 12)}… client=${kp.pkHex.slice(0, 12)}…`);

  // Per-request subscription handle so we don't leak listeners across calls.
  // Each sign() spins up its own short-lived subscription filtered to the
  // bunker's responses (p-tagged to our client key).
  let closed = false;
  const pending = new Map();
  let subscriber = null;

  function ensureSubscribed() {
    if (subscriber || closed) return;
    subscriber = transport.subscribe(
      { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [kp.pkHex] },
      (event) => {
        try {
          const convKey = getConversationKey(hexToBytes(kp.skHex), parsed.remoteSignerPubkey);
          const response = parseResponse({ event, conversationKey: convKey });
          const entry = pending.get(response.id);
          if (!entry) return;
          pending.delete(response.id);
          clearTimeout(entry.timer);
          if (response.error) entry.reject(new Error(`bunker rpc error: ${response.error}`));
          else entry.resolve(response.result);
        } catch {
          // Tampered / unrelated event — ignore. The listener is
          // intentionally silent so a noisy relay doesn't drown logs.
        }
      },
    );
  }

  function teardown() {
    if (closed) return;
    closed = true;
    subscriber?.();
    subscriber = null;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("bunker signer closed"));
    }
    pending.clear();
  }

  async function rpcCall({ method, params, timeoutMs = 5_000 }) {
    ensureSubscribed();
    const { event, conversationKey: _convKey, request } = buildEncryptedRequest({
      clientKeypair: kp,
      bunkerPubkey: parsed.remoteSignerPubkey,
      method,
      params,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new Error(`bunker rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(request.id, { resolve, reject, timer });
      transport.publish(event).catch((err) => {
        pending.delete(request.id);
        clearTimeout(timer);
        reject(new Error(`bunker rpc publish failed: ${err.message}`));
      });
    });
  }

  async function sign(template) {
    if (closed) throw new Error("bunker signer is closed");
    const result = await rpcCall({
      method: "sign_event",
      params: [JSON.stringify(template)],
    });
    let event;
    try {
      event = typeof result === "string" ? JSON.parse(result) : result;
    } catch (err) {
      throw new Error(`bunker sign_event returned non-JSON: ${err.message}`);
    }
    if (!event || typeof event !== "object" || !event.id) {
      throw new Error("bunker sign_event response missing id field");
    }
    if (event.kind !== template.kind) {
      throw new Error(
        `bunker sign_event kind mismatch (got ${event.kind}, expected ${template.kind})`,
      );
    }
    return event;
  }

  return {
    sign,
    close: teardown,
    info: {
      remoteSignerPubkey: parsed.remoteSignerPubkey,
      clientPubkey: kp.pkHex,
      relays: parsed.relays,
      scheme: parsed.scheme,
    },
  };
}

// Re-export for tests so they can construct a transport without depending
// on ride-along.mjs directly.
export { createMockTransport, parseBunkerUrl, KIND_BUNKER_ANNOUNCEMENT };
export { finalizeEvent };