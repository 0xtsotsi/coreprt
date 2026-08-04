// agents/_lib/writer.mjs
//
// The single publish/subscribe surface for the CorePrt agent CLI.
//
// One file, one job: wrap RelayClient so per-feature one-shots don't reinvent
// the NIP-42 auth handshake, the reconnect-on-disconnect loop, the EOSE
// plumbing, or the argv→event-template parsing.
//
// Per-feature one-shots build an event-template, hand it to `publish()`, or
// hand a filter to `subscribe()` and await EOSE. The writer does not know
// what kinds are "correct" — it accepts whatever kind the caller passes.
//
// To remove: delete this file, the one-shots that import it, and the
// `publish`/`req` cases in `coreprt-agent.sh`. Nothing else breaks.

import { WebSocket } from "ws";
import { finalizeEvent, getKeypairFromHex } from "./nostr.mjs";

const PUBLISH_TIMEOUT_MS = 5_000;
const SUBSCRIBE_QUIET_MS = 7_500;

export async function withRelay({ nsec, relayUrl, host, log }, run) {
  const keypair = getKeypairFromHex(nsec);
  const ws = new WebSocket(relayUrl, { headers: { Host: host } });
  const pendingPublishes = new Map();
  const subscriptions = new Map();
  const session = { authenticated: false, keypair, ws, log };
  let authEventId = null;
  let resolveConnect;
  let rejectConnect;
  let connectPromise = new Promise((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("[writer] ignored malformed JSON message");
      return;
    }
    const [verb, ...args] = message;
    switch (verb) {
      case "AUTH":
        handleAuth(args[0]);
        break;
      case "OK":
        handleOk(args);
        break;
      case "EVENT":
        handleEvent(args);
        break;
      case "EOSE":
        handleEose(args);
        break;
      case "NOTICE":
        log(`[writer] NOTICE: ${args[0] ?? ""}`);
        break;
      case "CLOSED":
        log(`[writer] subscription ${args[0]} closed: ${args[1] ?? ""}`);
        subscriptions.delete(args[0]);
        break;
      default:
        log(`[writer] ignored unsupported message: ${String(verb)}`);
    }
  });

  ws.on("error", (error) => {
    log(`[writer] ws error: ${error.message}`);
    rejectConnect(error);
  });

  ws.once("close", (code, reason) => {
    session.authenticated = false;
    log(`[writer] ws closed: ${code} ${reason.toString()}`);
    rejectPendingPublishes("relay closed");
  });

  function handleAuth(challenge) {
    if (typeof challenge !== "string" || !challenge) {
      log("[writer] ignored invalid AUTH challenge");
      return;
    }
    const relayTag = host.includes("://") ? host : `wss://${host}`;
    const authEvent = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", relayTag],
          ["challenge", challenge],
        ],
        content: "",
      },
      keypair.skBytes
    );
    authEventId = authEvent.id;
    log("[writer] AUTH challenge received; signing");
    ws.send(JSON.stringify(["AUTH", authEvent]));
  }

  function handleOk([eventId, ok, reason]) {
    if (eventId === authEventId) {
      authEventId = null;
      if (!ok) {
        log(`[writer] authentication rejected: ${reason ?? "unknown reason"}`);
        ws.close(4003, "authentication rejected");
        return;
      }
      session.authenticated = true;
      log("[writer] authenticated");
      for (const [subId, sub] of subscriptions) {
        if (sub.kind === "subscribe") ws.send(JSON.stringify(["REQ", subId, sub.filter]));
      }
      resolveConnect();
      return;
    }
    const pending = pendingPublishes.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPublishes.delete(eventId);
    pending.resolve({ ok: Boolean(ok), reason: reason ?? "" });
  }

  function handleEvent([subId, event]) {
    const sub = subscriptions.get(subId);
    if (!sub) return;
    if (sub.onEvent) sub.onEvent(event);
  }

  function handleEose([subId]) {
    const sub = subscriptions.get(subId);
    if (!sub) return;
    if (sub.onEose) sub.onEose();
    if (sub.oneShot) {
      subscriptions.delete(subId);
      ws.send(JSON.stringify(["CLOSE", subId]));
    }
  }

  function rejectPendingPublishes(reason) {
    for (const [, pending] of pendingPublishes) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason });
    }
    pendingPublishes.clear();
  }

  try {
    await connectPromise;
  } catch (error) {
    ws.close();
    throw error;
  }

  return {
    session,
    publish(eventTemplate) {
      return new Promise((resolve) => {
        if (!session.authenticated || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, reason: "relay is not authenticated" });
          return;
        }
        if (!eventTemplate?.id) {
          resolve({ ok: false, reason: "event has no id (finalizeEvent missing?)" });
          return;
        }
        const timer = setTimeout(() => {
          pendingPublishes.delete(eventTemplate.id);
          resolve({ ok: null, reason: "publish timed out" });
        }, PUBLISH_TIMEOUT_MS);
        pendingPublishes.set(eventTemplate.id, { resolve, timer });
        ws.send(JSON.stringify(["EVENT", eventTemplate]));
      });
    },
    subscribe(filter, { onEvent, onEose, oneShot = false } = {}) {
      const subId = `sub-${subscriptions.size + 1}-${Date.now()}`;
      subscriptions.set(subId, { kind: "subscribe", filter, onEvent, onEose, oneShot });
      if (session.authenticated) ws.send(JSON.stringify(["REQ", subId, filter]));
      return subId;
    },
    close() {
      rejectPendingPublishes("writer closed");
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

export async function runWithRelay(options, run) {
  const writer = await withRelay(options, run);
  try {
    return await run(writer);
  } finally {
    writer.close();
  }
}

export function buildEventTemplate({ kind, content = "", tags = [], createdAt }) {
  if (typeof kind !== "number" || kind < 0) {
    throw new Error(`event kind must be a non-negative integer (got ${kind})`);
  }
  return {
    kind,
    content,
    tags: Array.isArray(tags) ? tags : [],
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
  };
}

export async function awaitEose(writer, filter, { onEvent, quietMs = SUBSCRIBE_QUIET_MS } = {}) {
  return new Promise((resolve) => {
    const events = [];
    let timer;
    const subId = writer.subscribe(filter, {
      onEvent: (event) => {
        events.push(event);
        if (onEvent) onEvent(event);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          writer.session.ws.send(JSON.stringify(["CLOSE", subId]));
          resolve(events);
        }, quietMs);
      },
      onEose: () => resolve(events),
      oneShot: true,
    });
    setTimeout(() => resolve(events), quietMs * 4);
  });
}
