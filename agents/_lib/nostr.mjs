import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bech32 } from "@scure/base";

const textEncoder = new TextEncoder();

export function npubEncode(hex) {
  return bech32.encode("npub", bech32.toWords(hexToBytes(hex)));
}

export function nsecEncode(hex) {
  return bech32.encode("nsec", bech32.toWords(hexToBytes(hex)));
}

export function getKeypairFromHex(secretKeyHex) {
  const secretKeyBytes = hexToBytes(secretKeyHex);
  if (secretKeyBytes.length !== 32) {
    throw new Error(`secret key must be 32 bytes (got ${secretKeyBytes.length})`);
  }

  const publicKeyBytes = secp256k1.getPublicKey(secretKeyBytes, true).subarray(1);
  const publicKeyHex = bytesToHex(publicKeyBytes);
  return {
    skBytes: secretKeyBytes,
    pkBytes: publicKeyBytes,
    skHex: bytesToHex(secretKeyBytes),
    pkHex: publicKeyHex,
    npub: npubEncode(publicKeyHex),
    nsec: nsecEncode(bytesToHex(secretKeyBytes)),
  };
}

export function generateKeypair() {
  return getKeypairFromHex(bytesToHex(secp256k1.utils.randomSecretKey()));
}

function serializeEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

export function finalizeEvent(eventTemplate, secretKeyBytes) {
  const publicKeyHex = bytesToHex(
    secp256k1.getPublicKey(secretKeyBytes, true).subarray(1)
  );
  const event = {
    ...eventTemplate,
    pubkey: publicKeyHex,
    tags: eventTemplate.tags ?? [],
    content: eventTemplate.content ?? "",
  };
  const hash = sha256(textEncoder.encode(serializeEvent(event)));

  return {
    ...event,
    id: bytesToHex(hash),
    sig: bytesToHex(schnorr.sign(hash, secretKeyBytes)),
  };
}

export function verifyEvent(event) {
  try {
    if (
      !event ||
      typeof event.id !== "string" ||
      typeof event.pubkey !== "string" ||
      typeof event.sig !== "string" ||
      !Array.isArray(event.tags) ||
      typeof event.content !== "string"
    ) {
      return false;
    }
    const hash = sha256(textEncoder.encode(serializeEvent(event)));
    return (
      event.id === bytesToHex(hash) &&
      schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey))
    );
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes };
