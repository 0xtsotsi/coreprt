// agents/_lib/one-shot/__tests__/bunker.test.mjs
//
// Unit tests for the NIP-46 bunker stack:
//   • bunker.mjs: parseBunkerUrl, buildBunkerUrl, buildBunkerAnnouncementTemplate
//   • nip44.mjs: official test vector round-trip + tamper-detection
//   • ride-along.mjs: get_public_key + sign_event RPC cycle (in-memory transport)
//   • bunker-signer.mjs: local fallback when AGENT_BUNKER_URL is unset,
//                         bunker path when set
//
// The relay transport is NOT exercised here. bunker.mjs / ride-along.mjs
// accept an injected transport so the tests run with no socket at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finalizeEvent,
  generateKeypair,
  getKeypairFromHex,
  verifyEvent,
} from "../../nostr.mjs";
import {
  buildBunkerAnnouncementTemplate,
  buildBunkerUrl,
  DEFAULT_METHODS,
  KIND_BUNKER_ANNOUNCEMENT,
  parseBunkerAnnouncement,
  parseBunkerUrl,
  parseMethodList,
} from "../../bunker.mjs";
import { v2Decrypt, v2Encrypt, getConversationKey } from "../../nip44.mjs";
import {
  buildEncryptedRequest,
  createMockTransport,
  rideAlong,
} from "../../ride-along.mjs";
import { createBunkerSigner } from "../../bunker-signer.mjs";
import { hexToBytes } from "@noble/hashes/utils";

// ─────────────────────────────────────────────────────────────────
// parseBunkerUrl / buildBunkerUrl round-trip
// ─────────────────────────────────────────────────────────────────
test("bunker: parseBunkerUrl accepts nostrconnect:// with relays + secret", () => {
  const pub = "a".repeat(64);
  const url = `nostrconnect://${pub}?relay=wss%3A%2F%2Frelay.example&secret=hunter2`;
  const parsed = parseBunkerUrl(url);
  assert.equal(parsed.scheme, "nostrconnect");
  assert.equal(parsed.remoteSignerPubkey, pub);
  assert.deepEqual(parsed.relays, ["wss://relay.example"]);
  assert.equal(parsed.secret, "hunter2");
});

test("bunker: parseBunkerUrl accepts bunker:// scheme", () => {
  const pub = "b".repeat(64);
  const url = `bunker://${pub}?relay=wss://x.test&relay=wss://y.test`;
  const parsed = parseBunkerUrl(url);
  assert.equal(parsed.scheme, "bunker");
  assert.equal(parsed.remoteSignerPubkey, pub);
  assert.equal(parsed.relays.length, 2);
  assert.equal(parsed.relays[0], "wss://x.test");
  assert.equal(parsed.relays[1], "wss://y.test");
});

test("bunker: parseBunkerUrl rejects missing scheme separator", () => {
  assert.throws(() => parseBunkerUrl("just-a-string"), /missing scheme separator/);
});

test("bunker: parseBunkerUrl rejects unknown scheme", () => {
  assert.throws(
    () => parseBunkerUrl("https://abc.example/path"),
    /unknown NIP-46 scheme: https/,
  );
});

test("bunker: parseBunkerUrl rejects non-hex pubkey", () => {
  assert.throws(
    () => parseBunkerUrl("nostrconnect://zzzzzz?relay=wss://x"),
    /invalid remote-signer pubkey/,
  );
});

test("bunker: buildBunkerUrl round-trips through parseBunkerUrl", () => {
  const pub = "c".repeat(64);
  const built = buildBunkerUrl({
    remoteSignerPubkey: pub,
    relays: ["wss://relay1", "wss://relay2"],
    secret: "abc",
    scheme: "bunker",
  });
  const parsed = parseBunkerUrl(built);
  assert.equal(parsed.scheme, "bunker");
  assert.equal(parsed.remoteSignerPubkey, pub);
  assert.equal(parsed.secret, "abc");
  assert.deepEqual(parsed.relays, ["wss://relay1", "wss://relay2"]);
});

// ─────────────────────────────────────────────────────────────────
// buildBunkerAnnouncementTemplate — tag shape
// ─────────────────────────────────────────────────────────────────
test("bunker: announcement template carries d, t, k[], relay[] tags", () => {
  const pub = "d".repeat(64);
  const template = buildBunkerAnnouncementTemplate({
    agentName: "bumble",
    pubkeyHex: pub,
    methods: ["sign_event:1", "sign_event:22242", "nip44_encrypt"],
    transport: "ws",
    relays: ["wss://coreprt.webrnds.com"],
  });
  assert.equal(template.kind, KIND_BUNKER_ANNOUNCEMENT);
  const tagNames = template.tags.map((t) => t[0]);
  assert.ok(tagNames.includes("d"));
  assert.ok(tagNames.includes("t"));
  assert.ok(tagNames.includes("relay"));
  const kTags = template.tags.filter((t) => t[0] === "k").map((t) => t[1]);
  assert.deepEqual(kTags.sort(), ["nip44_encrypt", "sign_event:1", "sign_event:22242"].sort());
  const dTag = template.tags.find((t) => t[0] === "d");
  assert.equal(dTag[1], "bumble-bunker");
  const tTag = template.tags.find((t) => t[0] === "t");
  assert.equal(tTag[1], "ws");
  const relayTag = template.tags.find((t) => t[0] === "relay");
  assert.equal(relayTag[1], "wss://coreprt.webrnds.com");
});

test("bunker: default methods include sign_event, encrypt, decrypt", () => {
  assert.ok(DEFAULT_METHODS.includes("sign_event:1"));
  assert.ok(DEFAULT_METHODS.includes("nip44_encrypt"));
  assert.ok(DEFAULT_METHODS.includes("nip44_decrypt"));
});

test("bunker: announcement template dedups duplicate k entries", () => {
  const pub = "e".repeat(64);
  const template = buildBunkerAnnouncementTemplate({
    agentName: "x",
    pubkeyHex: pub,
    methods: ["sign_event:1", "sign_event:1", "sign_event:1"],
    transport: "ws",
    relays: ["wss://x"],
  });
  const kTags = template.tags.filter((t) => t[0] === "k");
  assert.equal(kTags.length, 1);
});

test("bunker: announcement template rejects empty methods", () => {
  const pub = "f".repeat(64);
  assert.throws(
    () =>
      buildBunkerAnnouncementTemplate({
        agentName: "x",
        pubkeyHex: pub,
        methods: [],
        transport: "ws",
        relays: ["wss://x"],
      }),
    /methods must be a non-empty array/,
  );
});

test("bunker: announcement template rejects non-ws relay url", () => {
  const pub = "9".repeat(64);
  assert.throws(
    () =>
      buildBunkerAnnouncementTemplate({
        agentName: "x",
        pubkeyHex: pub,
        methods: ["sign_event:1"],
        transport: "ws",
        relays: ["http://relay.example"],
      }),
    /relay URL must start with ws/,
  );
});

test("bunker: announcement template rejects empty relays", () => {
  const pub = "a".repeat(64);
  assert.throws(
    () =>
      buildBunkerAnnouncementTemplate({
        agentName: "x",
        pubkeyHex: pub,
        methods: ["sign_event:1"],
        transport: "ws",
        relays: [],
      }),
    /relays must be a non-empty array/,
  );
});

test("bunker: parseMethodList splits comma + trims + drops empties", () => {
  assert.deepEqual(
    parseMethodList("sign_event:1, nip44_encrypt ,,sign_event:22242"),
    ["sign_event:1", "nip44_encrypt", "sign_event:22242"],
  );
});

// ─────────────────────────────────────────────────────────────────
// Sign + parse announcement
// ─────────────────────────────────────────────────────────────────
test("bunker: signed announcement passes verifyEvent + parseBunkerAnnouncement", () => {
  const kp = generateKeypair();
  const template = buildBunkerAnnouncementTemplate({
    agentName: "bumble",
    pubkeyHex: kp.pkHex,
    methods: ["sign_event:1", "nip44_encrypt"],
    transport: "ws",
    relays: ["wss://coreprt.webrnds.com"],
  });
  const event = finalizeEvent(template, hexToBytes(kp.skHex));
  assert.equal(event.kind, KIND_BUNKER_ANNOUNCEMENT);
  assert.equal(event.pubkey, kp.pkHex);
  assert.ok(verifyEvent(event));
  const parsed = parseBunkerAnnouncement(event);
  assert.equal(parsed.pubkey, kp.pkHex);
  assert.equal(parsed.transport, "ws");
  assert.equal(parsed.relays[0], "wss://coreprt.webrnds.com");
  assert.equal(parsed.d, "bumble-bunker");
});

test("bunker: parseBunkerAnnouncement rejects non-24133 event", () => {
  const kp = generateKeypair();
  const event = finalizeEvent(
    {
      kind: 1,
      content: "hi",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    hexToBytes(kp.skHex),
  );
  assert.throws(() => parseBunkerAnnouncement(event), /not a bunker announcement/);
});

// ─────────────────────────────────────────────────────────────────
// NIP-44 v2 — official test vector + tamper-detection
// ─────────────────────────────────────────────────────────────────
test("nip44: encrypts + decrypts the canonical v2 vector", () => {
  const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
  const nonce = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
  const expected = "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb";
  const got = v2Encrypt("a", ck, nonce);
  assert.equal(got, expected);
  assert.equal(v2Decrypt(expected, ck), "a");
});

test("nip44: decrypt detects tampered ciphertext", () => {
  const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
  const nonce = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
  const good = v2Encrypt("hello world", ck, nonce);
  // Flip a bit in the mac (last char of base64 -> tamper the mac byte).
  const bad = good.slice(0, -1) + (good.endsWith("=") ? "B" : "X");
  assert.throws(() => v2Decrypt(bad, ck), /invalid MAC|invalid base64/);
});

test("nip44: getConversationKey matches official vector", () => {
  const sk = hexToBytes("315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268");
  const pub = "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133";
  const expected = "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1";
  const ck = getConversationKey(sk, pub);
  assert.equal(Buffer.from(ck).toString("hex"), expected);
});

// ─────────────────────────────────────────────────────────────────
// rideAlong RPC cycle (in-memory mock transport)
// ─────────────────────────────────────────────────────────────────

// Build a fake bunker that owns a real keypair. Each test wires a real
// sign_event response by encrypting with the bunker's keypair under the
// per-request conversation key.
function makeMockBunker(bunkerKeypair) {
  // We need a transport that the bunker "listens" on for incoming RPCs and
  // pushes responses onto. The ride-along observer uses its own transport;
  // we bridge by giving them the same in-memory mock so the request events
  // dispatched by `publish` reach the bunker's listener.
  const transport = createMockTransport();
  const pending = new Map();
  transport.subscribe({ kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [bunkerKeypair.pkHex] }, (event) => {
    // Decrypt, dispatch, sign + publish response.
    (async () => {
      try {
        const ck = getConversationKey(hexToBytes(bunkerKeypair.skHex), event.pubkey);
        const request = JSON.parse(v2Decrypt(event.content, ck));
        const entry = pending.get(request.id);
        if (!entry) return;
        const result = entry.handler(request);
        const response = { id: request.id, result };
        const ct = v2Encrypt(JSON.stringify(response), ck);
        const replyTemplate = {
          kind: KIND_BUNKER_ANNOUNCEMENT,
          content: ct,
          tags: [["p", event.pubkey]],
          created_at: Math.floor(Date.now() / 1000),
        };
        const replyEvent = finalizeEvent(replyTemplate, hexToBytes(bunkerKeypair.skHex));
        await transport.publish(replyEvent);
      } catch {
        // Bad event — ignore.
      }
    })();
  });
  return {
    transport,
    on(method, handler) {
      // methodHandler registry, keyed by request id; the listener will
      // match by request.method. Easier: register a handler per method.
      pending.set(method, { handler });
    },
    handle(method, handler) {
      // Replace the catch-all: rewrite on('get_public_key' or whatever)
      // to switch by request.method instead of request.id.
      pending._byMethod = pending._byMethod || new Map();
      pending._byMethod.set(method, handler);
    },
  };
}

test("ride-along: get_public_key + sign_event:1 RPC cycle with mock bunker", async () => {
  // Setup: bunker (the agent) owns a real keypair. The observer uses a
  // freshly-generated client keypair. We share a single mock transport
  // between them so published events are delivered synchronously.
  const bunkerKp = generateKeypair();
  const bunker = {
    kp: bunkerKp,
    signEvent: (template) => finalizeEvent(template, hexToBytes(bunkerKp.skHex)),
    getPublicKey: () => bunkerKp.pkHex,
  };
  const transport = createMockTransport();

  // Mock bunker listener: receives kind:24133 events p-tagged to itself.
  transport.subscribe(
    { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [bunkerKp.pkHex] },
    (event) => {
      (async () => {
        const ck = getConversationKey(hexToBytes(bunkerKp.skHex), event.pubkey);
        const req = JSON.parse(v2Decrypt(event.content, ck));
        let result;
        if (req.method === "get_public_key") {
          result = bunker.getPublicKey();
        } else if (req.method === "sign_event") {
          const tmpl = JSON.parse(req.params[0]);
          result = bunker.signEvent(tmpl);
        } else {
          result = null;
        }
        const response = { id: req.id, result };
        const ct = v2Encrypt(JSON.stringify(response), ck);
        const replyTemplate = {
          kind: KIND_BUNKER_ANNOUNCEMENT,
          content: ct,
          tags: [["p", event.pubkey]],
          created_at: Math.floor(Date.now() / 1000),
        };
        const replyEvent = finalizeEvent(replyTemplate, hexToBytes(bunkerKp.skHex));
        await transport.publish(replyEvent);
      })();
    },
  );

  const clientKp = generateKeypair();
  // Build the kind:24133 announcement the observer discovers.
  const announceEvent = finalizeEvent(
    buildBunkerAnnouncementTemplate({
      agentName: "bumble",
      pubkeyHex: bunkerKp.pkHex,
      methods: ["sign_event:1", "get_public_key"],
      transport: "ws",
      relays: ["wss://mock"],
    }),
    hexToBytes(bunkerKp.skHex),
  );

  const result = await rideAlong({
    clientKeypair: clientKp,
    bunkerEvent: announceEvent,
    publish: (event) => transport.publish(event),
    subscribe: (filter, onEvent) => transport.subscribe(filter, onEvent),
    log: () => {},
    timeoutMs: 2_000,
  });
  assert.equal(result.status, "ride-along ok");
  assert.equal(result.userPubkey, bunkerKp.pkHex);
  assert.match(result.signedNoteId, /^[0-9a-f]{64}$/);
});

test("ride-along: tamper detection — wrong conversation key fails", async () => {
  const bunkerKp = generateKeypair();
  const transport = createMockTransport();
  const announceEvent = finalizeEvent(
    buildBunkerAnnouncementTemplate({
      agentName: "bumble",
      pubkeyHex: bunkerKp.pkHex,
      methods: ["sign_event:1"],
      transport: "ws",
      relays: ["wss://mock"],
    }),
    hexToBytes(bunkerKp.skHex),
  );
  const clientKp = generateKeypair();
  // Publish a forged response encrypted with a DIFFERENT key.
  const wrongKp = generateKeypair();
  transport.subscribe(
    { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [clientKp.pkHex] },
    (event) => {
      const ck = getConversationKey(hexToBytes(wrongKp.skHex), clientKp.pkHex);
      const response = { id: "forged", result: bunkerKp.pkHex };
      const ct = v2Encrypt(JSON.stringify(response), ck);
      const replyTemplate = {
        kind: KIND_BUNKER_ANNOUNCEMENT,
        content: ct,
        tags: [["p", clientKp.pkHex]],
        created_at: Math.floor(Date.now() / 1000),
      };
      const replyEvent = finalizeEvent(replyTemplate, hexToBytes(wrongKp.skHex));
      transport.publish(replyEvent);
    },
  );

  await assert.rejects(
    () =>
      rideAlong({
        clientKeypair: clientKp,
        bunkerEvent: announceEvent,
        publish: (event) => transport.publish(event),
        subscribe: (filter, onEvent) => transport.subscribe(filter, onEvent),
        log: () => {},
        timeoutMs: 500,
      }),
    /invalid MAC|sign_event response pubkey mismatch|timed out/,
  );
});

// ─────────────────────────────────────────────────────────────────
// bunker-signer: local fallback vs. bunker path
// ─────────────────────────────────────────────────────────────────
test("bunker-signer: returns null when url is empty (local fallback)", async () => {
  const transport = createMockTransport();
  const signer = await createBunkerSigner({ url: "", transport, log: () => {} });
  assert.equal(signer, null);
});

test("bunker-signer: routes sign() through the bunker (no local nsec leak)", async () => {
  // The agent (caller of sign) provides an OBSERVER keypair. The bunker
  // owns a separate keypair. Verify that:
  //   - signer.sign(template) returns an event signed by the BUNKER's key
  //   - the caller never touches the bunker's nsec
  const bunkerKp = generateKeypair();
  const observerKp = generateKeypair();
  const transport = createMockTransport();

  transport.subscribe(
    { kinds: [KIND_BUNKER_ANNOUNCEMENT], "#p": [bunkerKp.pkHex] },
    (event) => {
      (async () => {
        const ck = getConversationKey(hexToBytes(bunkerKp.skHex), event.pubkey);
        const req = JSON.parse(v2Decrypt(event.content, ck));
        if (req.method === "sign_event") {
          const tmpl = JSON.parse(req.params[0]);
          const signed = finalizeEvent(tmpl, hexToBytes(bunkerKp.skHex));
          const ct = v2Encrypt(JSON.stringify({ id: req.id, result: signed }), ck);
          const replyEvent = finalizeEvent(
            {
              kind: KIND_BUNKER_ANNOUNCEMENT,
              content: ct,
              tags: [["p", event.pubkey]],
              created_at: Math.floor(Date.now() / 1000),
            },
            hexToBytes(bunkerKp.skHex),
          );
          await transport.publish(replyEvent);
        }
      })();
    },
  );

  const url = buildBunkerUrl({
    remoteSignerPubkey: bunkerKp.pkHex,
    relays: ["wss://mock"],
    scheme: "nostrconnect",
  });
  const signer = await createBunkerSigner({
    url,
    clientKeypair: observerKp,
    transport,
    log: () => {},
  });
  assert.ok(signer);
  const template = {
    kind: 1,
    content: "hello",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };
  const signed = await signer.sign(template);
  // The signed event must be signed by the BUNKER's key, not the
  // observer's key. This proves the nsec never crossed the wire.
  assert.equal(signed.pubkey, bunkerKp.pkHex);
  assert.notEqual(signed.pubkey, observerKp.pkHex);
  assert.ok(verifyEvent(signed));
  signer.close();
});

// ─────────────────────────────────────────────────────────────────
// Acceptance: publishing a bunker for bumble succeeds
// (in-memory mock relay so the test stays offline)
// ─────────────────────────────────────────────────────────────────
test("bunker: publishing kind:24133 for bumble with mock runWithRelay", async () => {
  const kp = generateKeypair();
  const transport = createMockTransport();
  const template = buildBunkerAnnouncementTemplate({
    agentName: "bumble",
    pubkeyHex: kp.pkHex,
    methods: DEFAULT_METHODS,
    transport: "ws",
    relays: ["wss://coreprt.webrnds.com"],
  });
  const event = finalizeEvent(template, hexToBytes(kp.skHex));
  const result = await transport.publish(event);
  assert.equal(result.ok, true);
  assert.equal(event.kind, KIND_BUNKER_ANNOUNCEMENT);
  assert.match(event.id, /^[0-9a-f]{64}$/);
  // The transport recorded exactly one event — the announcement.
  assert.equal(transport.published.length, 1);
  assert.equal(transport.published[0].id, event.id);
});