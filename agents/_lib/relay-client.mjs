import { WebSocket } from "ws";
import { finalizeEvent } from "./nostr.mjs";

const OPEN = 1;
const PUBLISH_TIMEOUT_MS = 5_000;

export class RelayClient {
  constructor({ url, keypair, onEvent, onNotice, log = console.log }) {
    this.url = url;
    this.keypair = keypair;
    this.onEvent = onEvent;
    this.onNotice = onNotice ?? (() => {});
    this.log = log;
    this.ws = null;
    this.subs = new Map();
    this.subCounter = 0;
    this.pending = new Map();
    this.authenticated = false;
    this.authEventId = null;
    this.retryCount = 0;
    this.reconnectTimer = null;
    this.shouldRun = true;
    this.connectPromise = null;
  }

  connect() {
    if (this.ws?.readyState === OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.shouldRun = true;
    this.connectPromise = new Promise((resolve, reject) => {
      const wsUrl = new URL(this.url);
      const options = {};
      if (wsUrl.hostname === "127.0.0.1" || wsUrl.hostname === "localhost") {
        options.headers = {
          Host: process.env.BUZZ_RELAY_HOST ?? "coreprt.webrnds.com",
        };
      }

      const socket = new WebSocket(this.url, options);
      this.ws = socket;
      let opened = false;

      socket.once("open", () => {
        opened = true;
        this.connectPromise = null;
        this.log(`[relay] connected to ${this.url}`);
        resolve();
      });
      socket.on("message", (raw) => this._onMessage(raw.toString()));
      socket.on("error", (error) => {
        this.log(`[relay] error: ${error.message}`);
        if (!opened) {
          this.connectPromise = null;
          reject(error);
        }
      });
      socket.once("close", (code, reason) => {
        this.connectPromise = null;
        this.authenticated = false;
        this.authEventId = null;
        this.log(`[relay] closed: ${code} ${reason.toString()}`);
        this._resolvePendingPublishes("relay disconnected");
        if (this.shouldRun) this._scheduleReconnect();
      });
    });

    return this.connectPromise;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldRun) return;
    const baseDelay = Math.min(30_000, 1_000 * 2 ** this.retryCount);
    const delay = baseDelay + Math.floor(Math.random() * 500);
    this.retryCount += 1;
    this.log(`[relay] reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (error) {
        this.log(`[relay] reconnect failed: ${error.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.log("[relay] ignored malformed JSON message");
      return;
    }

    const [verb, ...args] = message;
    switch (verb) {
      case "AUTH":
        this._handleAuth(args[0]);
        break;
      case "EVENT":
        this.onEvent?.(args[1]);
        break;
      case "OK":
        this._handleOk(args);
        break;
      case "NOTICE":
        this.onNotice(args[0]);
        break;
      case "CLOSED":
        this.log(`[relay] subscription ${args[0]} closed: ${args[1] ?? ""}`);
        break;
      case "EOSE":
        break;
      default:
        this.log(`[relay] ignored unsupported message: ${String(verb)}`);
    }
  }

  _handleAuth(challenge) {
    if (typeof challenge !== "string" || !challenge) {
      this.log("[relay] ignored invalid AUTH challenge");
      return;
    }

    const configuredHost = process.env.BUZZ_RELAY_HOST ?? "coreprt.webrnds.com";
    const relayTag = configuredHost.includes("://")
      ? configuredHost
      : `wss://${configuredHost}`;
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
      this.keypair.skBytes
    );

    this.authEventId = authEvent.id;
    this.authenticated = false;
    this.log("[relay] AUTH challenge received");
    this._send(["AUTH", authEvent]);
  }

  _handleOk([eventId, ok, reason]) {
    if (eventId === this.authEventId) {
      this.authEventId = null;
      if (!ok) {
        this.log(`[relay] authentication rejected: ${reason ?? "unknown reason"}`);
        this.ws?.close(4003, "authentication rejected");
        return;
      }

      this.authenticated = true;
      this.retryCount = 0;
      this.log("[relay] authenticated");
      for (const [subscriptionId, filter] of this.subs) {
        this._send(["REQ", subscriptionId, filter]);
      }
      return;
    }

    const pending = this.pending.get(eventId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(eventId);
    pending.resolve({ ok: Boolean(ok), reason: reason ?? "" });
  }

  subscribe(filter) {
    const subscriptionId = `sub-${++this.subCounter}`;
    this.subs.set(subscriptionId, filter);
    if (this.authenticated) {
      this._send(["REQ", subscriptionId, filter]);
    } else {
      this.log(`[relay] subscription ${subscriptionId} queued until authentication`);
    }
    return subscriptionId;
  }

  unsubscribe(subscriptionId) {
    if (!this.subs.delete(subscriptionId)) return;
    if (this.ws?.readyState === OPEN) this._send(["CLOSE", subscriptionId]);
  }

  publish(event) {
    if (!event?.id) {
      return Promise.resolve({ ok: false, reason: "event has no id" });
    }
    if (!this.authenticated || this.ws?.readyState !== OPEN) {
      return Promise.resolve({ ok: false, reason: "relay is not authenticated" });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(event.id);
        resolve({ ok: null, reason: "publish timed out" });
      }, PUBLISH_TIMEOUT_MS);
      this.pending.set(event.id, { resolve, timer });
      this._send(["EVENT", event]);
    });
  }

  _send(message) {
    if (this.ws?.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  _resolvePendingPublishes(reason) {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ ok: false, reason });
    }
    this.pending.clear();
  }

  close() {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._resolvePendingPublishes("relay client closed");
    this.ws?.close();
    this.ws = null;
  }
}
