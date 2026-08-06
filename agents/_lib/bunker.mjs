// agents/_lib/bunker.mjs
//
// NIP-46 bunker library: parse + build bunker connection URLs, build the
// kind:24133 announcement template, parse an announcement event back into
// its structural parts, and parse a comma-separated method list.
//
// This module is the single source of truth for the bunker wire shape. The
// one-shot CLI (agents/_lib/one-shot/bunker.mjs), the runtime signer adapter
// (bunker-signer.mjs), and the ride-along observer (ride-along.mjs) all
// import from here.
//
// To remove: delete this file, the one-shot, the signer adapter, and the
// ride-along observer. Nothing else in agents/_lib breaks.

export const KIND_BUNKER_ANNOUNCEMENT = 24133;

// Default method allowlist advertised by an agent bunker. Includes the
// three RPC methods the agent needs (sign_event for every kind it emits,
// nip44_encrypt + nip44_decrypt for future DM use).
export const DEFAULT_METHODS = Object.freeze([
  "sign_event:0",
  "sign_event:1",
  "sign_event:9",
  "sign_event:22242",
  "sign_event:24133",
  "nip44_encrypt",
  "nip44_decrypt",
]);

const HEX64 = /^[0-9a-f]{64}$/i;

// Split a comma-separated method list, trim each entry, drop empties.
// Throws nothing — invalid entries are silently dropped so a typo like
// "sign_event:1, ,sign_event:22242" still produces a usable list.
export function parseMethodList(raw) {
  if (typeof raw !== "string") {
    throw new Error("method list must be a string");
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse a bunker URL into its components. Accepts either of the two NIP-46
// connection-token schemes:
//
//   bunker://<pubkey>?relay=<wss>&relay=<wss>&secret=<s>
//   nostrconnect://<pubkey>?relay=<wss>&relay=<wss>&secret=<s>
//
// Returns: { scheme, remoteSignerPubkey, relays, secret }
//
// Throws on missing scheme separator, unknown scheme, or non-hex pubkey.
export function parseBunkerUrl(url) {
  if (typeof url !== "string") {
    throw new Error("bunker URL must be a string");
  }
  const sepIdx = url.indexOf("://");
  if (sepIdx < 1) {
    throw new Error("bunker URL is missing scheme separator");
  }
  const scheme = url.slice(0, sepIdx).toLowerCase();
  if (scheme !== "bunker" && scheme !== "nostrconnect") {
    throw new Error(`unknown NIP-46 scheme: ${scheme}`);
  }
  const rest = url.slice(sepIdx + 3);
  const qIdx = rest.indexOf("?");
  const remoteSignerPubkey = (qIdx < 0 ? rest : rest.slice(0, qIdx)).toLowerCase();
  if (!HEX64.test(remoteSignerPubkey)) {
    throw new Error(`invalid remote-signer pubkey: ${remoteSignerPubkey}`);
  }

  let relays = [];
  let secret;
  if (qIdx >= 0) {
    const params = new URLSearchParams(rest.slice(qIdx + 1));
    for (const value of params.getAll("relay")) {
      if (typeof value === "string" && value.length > 0) relays.push(value);
    }
    const s = params.get("secret");
    if (typeof s === "string" && s.length > 0) secret = s;
  }

  return { scheme, remoteSignerPubkey, relays, secret };
}

// Build a bunker URL from components. Inverse of parseBunkerUrl. The
// `secret` and `relays` are optional (matches the call sites in tests + CLI).
//
// scheme defaults to "bunker". All non-relay params are sorted to keep the
// output stable for the round-trip test.
export function buildBunkerUrl({ remoteSignerPubkey, relays = [], secret, scheme = "bunker" }) {
  if (typeof remoteSignerPubkey !== "string" || !HEX64.test(remoteSignerPubkey)) {
    throw new Error(`invalid remote-signer pubkey: ${String(remoteSignerPubkey)}`);
  }
  if (scheme !== "bunker" && scheme !== "nostrconnect") {
    throw new Error(`unknown NIP-46 scheme: ${scheme}`);
  }
  if (!Array.isArray(relays)) {
    throw new Error("relays must be an array");
  }
  const params = new URLSearchParams();
  for (const relay of relays) {
    if (typeof relay !== "string" || !relay.startsWith("ws")) {
      throw new Error(`relay URL must start with ws: ${String(relay)}`);
    }
    params.append("relay", relay);
  }
  if (typeof secret === "string" && secret.length > 0) {
    params.set("secret", secret);
  }
  const qs = params.toString();
  return `${scheme}://${remoteSignerPubkey.toLowerCase()}${qs ? `?${qs}` : ""}`;
}

// Build the kind:24133 announcement template (UNSIGNED). Caller signs via
// finalizeEvent(template, skBytes) and publishes.
//
// Tags produced (in this order, dedup within k[]):
//   ["d", "<agentName>-bunker"]
//   ["t", "<transport>"]
//   ["k", "<method>"]      — one per unique method
//   ["relay", "<wss-url>"] — one per relay
export function buildBunkerAnnouncementTemplate({
  agentName,
  pubkeyHex,
  methods,
  transport,
  relays,
}) {
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error("agentName must be a non-empty string");
  }
  if (typeof pubkeyHex !== "string" || !HEX64.test(pubkeyHex)) {
    throw new Error(`invalid pubkeyHex: ${String(pubkeyHex)}`);
  }
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new Error("methods must be a non-empty array");
  }
  if (typeof transport !== "string" || transport.length === 0) {
    throw new Error("transport must be a non-empty string");
  }
  if (!Array.isArray(relays) || relays.length === 0) {
    throw new Error("relays must be a non-empty array");
  }
  for (const relay of relays) {
    if (typeof relay !== "string" || !relay.startsWith("ws")) {
      throw new Error(`relay URL must start with ws: ${String(relay)}`);
    }
  }

  const seen = new Set();
  const tags = [
    ["d", `${agentName}-bunker`],
    ["t", transport],
  ];
  for (const method of methods) {
    if (typeof method !== "string" || method.length === 0) continue;
    if (seen.has(method)) continue;
    seen.add(method);
    tags.push(["k", method]);
  }
  for (const relay of relays) {
    tags.push(["relay", relay]);
  }

  return {
    kind: KIND_BUNKER_ANNOUNCEMENT,
    content: "",
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}

// Extract the structural parts of a signed kind:24133 announcement.
//
// Returns: { pubkey, d, transport, methods, relays }
//
// Throws if the event is not a kind:24133.
export function parseBunkerAnnouncement(event) {
  if (!event || typeof event !== "object") {
    throw new Error("not a bunker announcement: event is null or not an object");
  }
  if (event.kind !== KIND_BUNKER_ANNOUNCEMENT) {
    throw new Error(`not a bunker announcement: kind=${event.kind}`);
  }
  const tags = Array.isArray(event.tags) ? event.tags : [];
  let d;
  let transport;
  const methods = [];
  const relays = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    const [name, value] = tag;
    if (typeof value !== "string") continue;
    if (name === "d") d = value;
    else if (name === "t") transport = value;
    else if (name === "k") methods.push(value);
    else if (name === "relay") relays.push(value);
  }
  return {
    pubkey: typeof event.pubkey === "string" ? event.pubkey.toLowerCase() : event.pubkey,
    d,
    transport,
    methods,
    relays,
  };
}
