// agents/_lib/nip44.mjs
//
// NIP-44 v2 encryption — used by both NIP-46 (bunker/ride-along RPC) and any
// future end-to-end DMs the agent needs.
//
// Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
//
// Algorithm (v2):
//   conversation_key = HKDF-Extract(ECDH(sk, "02"+pk)[1..33], salt="nip44-v2")
//   per-message:
//     nonce         = 32 random bytes (sent in cleartext)
//     msg_key       = HKDF-Extract(salt=conversation_key, ikm=nonce) -> 32B
//     keys[76]      = HKDF-Expand(msg_key, info="", len=76)
//                     = chacha_key[32] || chacha_nonce[12] || hmac_key[32]
//     padded[pad]   = BE16(len) || plaintext || zero-pad to calcPaddedLen(len)
//     ciphertext    = chacha20-ietf(chacha_key, chacha_nonce, padded)
//     mac           = HMAC-SHA256(hmac_key, aad=nonce || ciphertext)
//     payload       = [0x02] || nonce || ciphertext || mac  -> base64
//
// Crypto primitives:
//   • ECDH (secp256k1, X-only pubkeys)  — @noble/curves/secp256k1
//   • HKDF-Extract / HKDF-Expand (SHA-256) — @noble/hashes/hkdf
//   • chacha20-ietf                       — node:crypto (chacha20 with
//                                            4-byte counter || 12-byte nonce)
//   • HMAC-SHA256                        — node:crypto
//   • base64                             — @scure/base
//
// Why chacha20 from node:crypto and not @noble/ciphers: we already depend on
// @noble/curves + @noble/hashes + @scure/base; pulling in @noble/ciphers for
// one cipher is overkill. Node's `chacha20` follows RFC 8439 (4-byte counter
// little-endian, 12-byte nonce) which matches what NIP-44 v2 expects.
//
// All functions are pure (no I/O, no env access) and accept/return Uint8Array
// or base64 strings. Conversations are parameterized by an X-only hex pubkey
// (32 bytes / 64 hex chars), matching the convention used by `nostr.mjs`.

import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf";
import {
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

const VERSION_BYTE = 0x02;
const NIP44_INFO = utf8ToBytes("nip44-v2");
const textDecoder = new TextDecoder();

// chacha20-ietf: 16-byte IV = u32 counter (LE) || 12-byte nonce.
// Counter starts at 0. For our payloads (< 4 KiB), this is always block 0.
function chacha20IetfCrypt(key, nonce12, data) {
  if (nonce12.length !== 12) {
    throw new Error(`chacha20 nonce must be 12 bytes (got ${nonce12.length})`);
  }
  const iv = new Uint8Array(16);
  iv.set(nonce12, 4); // counter = 0, then 12-byte nonce
  const cipher = createCipheriv("chacha20", key, iv);
  return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

function hmacAad(hmacKey, ciphertext, aad) {
  const h = createHmac("sha256", hmacKey);
  h.update(Buffer.from(concatBytes(aad, ciphertext)));
  return new Uint8Array(h.digest());
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Returns the 32-byte conversation key for the (priv, pub) pair.
// pub must be a 32-byte hex-encoded X-only pubkey (no 0x02 prefix).
export function getConversationKey(privkeyBytes, xOnlyPubkeyHex) {
  if (privkeyBytes.length !== 32) {
    throw new Error(`privkey must be 32 bytes (got ${privkeyBytes.length})`);
  }
  // ECDH treats the pubkey as a full point; X-only pubkeys get prefixed with
  // 0x02 to bind to the even-Y coordinate.
  const pubFull = hexToBytes(`02${xOnlyPubkeyHex}`);
  const sharedX = secp256k1.getSharedSecret(privkeyBytes, pubFull).subarray(1, 33);
  // Per the reference impl: hkdf_extract(sha256, ikm=sharedX, salt="nip44-v2").
  // Noble's signature is extract(hash, ikm, salt).
  return hkdfExtract(sha256, sharedX, NIP44_INFO);
}

function getMessageKeys(conversationKey, nonce) {
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chacha_key: keys.subarray(0, 32),
    chacha_nonce: keys.subarray(32, 44),
    hmac_key: keys.subarray(44, 76),
  };
}

function calcPaddedLen(len) {
  if (!Number.isInteger(len) || len < 1) {
    throw new Error(`plaintext length must be a positive integer (got ${len})`);
  }
  if (len <= 32) return 32;
  // Smallest power of 2 strictly greater than (len - 1).
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

// Padded layout: BE16(len) || plaintext || zero-pad to padded_len.
// For lengths >= 65536, the prefix widens to 2 zero bytes + BE32(len) = 6 bytes.
function pad(plaintext) {
  const unpadded = utf8ToBytes(plaintext);
  const unpaddedLen = unpadded.length;
  if (unpaddedLen < 1) throw new Error("plaintext must be at least 1 byte");
  let prefix;
  if (unpaddedLen >= 0x10000) {
    if (unpaddedLen > 0xffffffff) {
      throw new Error(`plaintext too large (${unpaddedLen} bytes, max 2^32-1)`);
    }
    const arr = new Uint8Array(6);
    new DataView(arr.buffer).setUint32(2, unpaddedLen, false);
    prefix = arr;
  } else {
    const arr = new Uint8Array(2);
    new DataView(arr.buffer).setUint16(0, unpaddedLen, false);
    prefix = arr;
  }
  const suffix = new Uint8Array(calcPaddedLen(unpaddedLen) - unpaddedLen);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded) {
  if (padded.length < 2) throw new Error("padded buffer too short");
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const firstTwo = dv.getUint16(0);
  let unpaddedLen;
  let prefixLen;
  if (firstTwo === 0) {
    if (padded.length < 6) throw new Error("padded buffer too short for extended prefix");
    unpaddedLen = dv.getUint32(2);
    prefixLen = 6;
    if (unpaddedLen < 0x10000) throw new Error("invalid padding (extended marker w/ short len)");
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }
  if (unpaddedLen < 1 || unpaddedLen > 0xffffffff) {
    throw new Error(`invalid unpadded length (${unpaddedLen})`);
  }
  const expected = prefixLen + calcPaddedLen(unpaddedLen);
  if (padded.length !== expected) {
    throw new Error(`invalid padding (padded=${padded.length}, expected ${expected})`);
  }
  const unpadded = padded.subarray(prefixLen, prefixLen + unpaddedLen);
  return bytesToUtf8(unpadded);
}

// Encrypts plaintext under a 32-byte conversation key. nonce is optional —
// pass a deterministic nonce in tests, otherwise a fresh CSPRNG nonce is used.
export function v2Encrypt(plaintext, conversationKey, nonce) {
  if (!(conversationKey instanceof Uint8Array) || conversationKey.length !== 32) {
    throw new Error("conversationKey must be 32 bytes");
  }
  const n = nonce ?? randomBytes(32);
  if (n.length !== 32) {
    throw new Error(`nonce must be 32 bytes (got ${n.length})`);
  }
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, n);
  const padded = pad(plaintext);
  const ciphertext = chacha20IetfCrypt(chacha_key, chacha_nonce, padded);
  const mac = hmacAad(hmac_key, ciphertext, n);
  return base64.encode(concatBytes(new Uint8Array([VERSION_BYTE]), n, ciphertext, mac));
}

// Decrypts a v2 payload produced by `v2Encrypt` (or any NIP-44 v2 implementation).
// Throws on tampering (HMAC mismatch) or malformed padding.
export function v2Decrypt(payload, conversationKey) {
  if (typeof payload !== "string") throw new Error("payload must be a string");
  if (payload.length < 132) throw new Error(`invalid payload length: ${payload.length}`);
  let data;
  try {
    data = base64.decode(payload);
  } catch (err) {
    throw new Error(`invalid base64: ${err.message}`);
  }
  if (data.length < 99) throw new Error(`invalid data length: ${data.length}`);
  if (data[0] !== VERSION_BYTE) {
    throw new Error(`unknown encryption version ${data[0]} (only v2 supported)`);
  }
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, -32);
  const mac = data.subarray(-32);
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const calculatedMac = hmacAad(hmac_key, ciphertext, nonce);
  if (!constantTimeEqual(calculatedMac, mac)) {
    throw new Error("invalid MAC (message tampered or wrong conversation key)");
  }
  // chacha20 is a stream cipher; encryption == decryption under the same key/nonce.
  const padded = chacha20IetfCrypt(chacha_key, chacha_nonce, ciphertext);
  return unpad(padded);
}

// Convenience: encrypt from a privkey + remote-pubkey-hex without manually
// deriving the conversation key. Equivalent to two v2Encrypt calls in
// opposite directions.
export function encryptToRecipient(plaintext, senderPrivkey, recipientPubkeyHex) {
  const ck = getConversationKey(senderPrivkey, recipientPubkeyHex);
  return v2Encrypt(plaintext, ck);
}

export function decryptFromSender(payload, receiverPrivkey, senderPubkeyHex) {
  const ck = getConversationKey(receiverPrivkey, senderPubkeyHex);
  return v2Decrypt(payload, ck);
}

// Re-export the hex helpers we already pulled in, for callers that want to
// convert between hex pubkey strings and the bytes getConversationKey needs.
export { bytesToHex, hexToBytes };

// Lightweight self-test, gated on `node:nip44.mjs` being run directly. Useful
// for sanity-checking after a refactor without spinning up the full test
// harness. Skipped in the test runner (NODE_TEST_CONTEXT is set then).
if (
  import.meta.url === `file://${process.argv[1]}` &&
  !process.env.NODE_TEST_CONTEXT
) {
  const sk1 = randomBytes(32);
  const sk2 = randomBytes(32);
  const pk1 = bytesToHex(secp256k1.getPublicKey(sk1, true).subarray(1));
  const pk2 = bytesToHex(secp256k1.getPublicKey(sk2, true).subarray(1));
  const msg = "ride-along observer never sees the nsec";
  const a = encryptToRecipient(msg, sk1, pk2);
  const b = decryptFromSender(a, sk2, pk1);
  if (b !== msg) {
    console.error("nip44 self-test FAILED");
    process.exit(1);
  }
  console.log("nip44 self-test OK");
}