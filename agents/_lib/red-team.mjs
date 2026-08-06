import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { finalizeEvent, getKeypairFromHex } from "./nostr.mjs";
import { RelayClient } from "./relay-client.mjs";
import { parseVerdict } from "./gauntlet.mjs";

export const REVIEW_TIMEOUT_MS = 90_000;
const REVIEW_KINDS = ["win", "lose", "equal"];

class ReviewTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`review timeout after ${timeoutMs}ms`);
    this.name = "ReviewTimeoutError";
  }
}

function envFor(name) {
  const path = `${process.env.HOME}/.config/coreprt/${name}.env`;
  const source = readFileSync(path, "utf8");
  const env = { ...process.env };
  for (const line of source.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)=(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return env;
}

function agentName(agent) {
  return typeof agent === "string" ? agent : agent?.name ?? "unnamed-reviewer";
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function isExplicitFailure(result) {
  return result && typeof result === "object" && result.ok === false;
}

function runtimeReplyText(reply) {
  if (typeof reply === "string") return reply;
  if (!reply || typeof reply !== "object") return "";
  return reply.text ?? reply.content ?? reply.data?.text ?? "";
}

function normalizeReviewerVerdict(reply) {
  const parsed = parseVerdict(runtimeReplyText(reply));
  if (REVIEW_KINDS.includes(parsed.kind)) return parsed;
  return {
    kind: "no_verdict",
    body: parsed.body || "runtime did not return WIN, LOSE, or EQUAL",
  };
}

function resolveAgent(agent, log) {
  const config = typeof agent === "object" && agent !== null ? agent : {};
  const name = agentName(agent);
  let env = { ...process.env, ...(config.env ?? {}) };

  // Test doubles commonly provide all handles directly. Avoid requiring a
  // machine-local .env file in that case; named production agents still load
  // their normal per-agent environment.
  if (!config.env && (!config.keypair || !config.relay || !getRuntimeAsk(config))) {
    try {
      env = { ...env, ...envFor(name) };
    } catch (error) {
      if (!config.keypair || !config.relay || !getRuntimeAsk(config)) throw error;
      log(`red-team: ${name} has no env file; using injected handles`);
    }
  }

  const keypair = config.keypair ?? (env.AGENT_NSEC ? getKeypairFromHex(env.AGENT_NSEC) : null);
  const relay = config.relay ?? (
    keypair && env.AGENT_RELAY_URL
      ? new RelayClient({ url: env.AGENT_RELAY_URL, keypair, log })
      : null
  );
  if (!keypair) throw new Error(`missing keypair for reviewer ${name}`);
  if (!relay) throw new Error(`missing relay for reviewer ${name}`);

  return {
    name,
    env,
    keypair,
    relay,
    ownsRelay: !config.relay,
    ask: getRuntimeAsk(config),
  };
}

function getRuntimeAsk(config) {
  if (typeof config.ask === "function") return config.ask;
  if (typeof config.runtime === "function") return config.runtime;
  if (typeof config.runtime?.ask === "function") return config.runtime.ask;
  if (typeof config.runtime?.review === "function") return config.runtime.review;
  return null;
}

// RelayClient predates multi-consumer event handling and has one onEvent
// callback. Keep that callback intact while allowing concurrent REQs on the
// same injected relay (and on any future shared relay implementation).
const relayEventRegistrations = new WeakMap();

function registerRelayEventHandler(relay, handler) {
  if (typeof relay.on === "function") {
    relay.on("event", handler);
    return () => {
      if (typeof relay.off === "function") relay.off("event", handler);
      else relay.removeListener?.("event", handler);
    };
  }

  let registration = relayEventRegistrations.get(relay);
  if (!registration) {
    const original = relay.onEvent;
    const handlers = new Set();
    const dispatcher = (event) => {
      try {
        original?.call(relay, event);
      } catch {
        // An existing consumer must not prevent a reviewer from receiving its
        // event. The relay client's own handler is intentionally best-effort.
      }
      for (const registeredHandler of [...handlers]) {
        try {
          registeredHandler(event);
        } catch {
          // A single subscription callback must not break the other REQs.
        }
      }
    };
    registration = { original, handlers, dispatcher };
    relayEventRegistrations.set(relay, registration);
    relay.onEvent = dispatcher;
  }

  registration.handlers.add(handler);
  return () => {
    const current = relayEventRegistrations.get(relay);
    if (!current) return;
    current.handlers.delete(handler);
    if (current.handlers.size === 0) {
      if (relay.onEvent === current.dispatcher) relay.onEvent = current.original;
      relayEventRegistrations.delete(relay);
    }
  };
}

function closeOwnedRelay(context) {
  if (!context?.ownsRelay || context.closed) return;
  context.closed = true;
  try {
    context.relay.close?.();
  } catch {
    // Cleanup must not mask the review result.
  }
}

async function readBuilderEvent({ relay, builderEventId, signal, timeoutMs }) {
  let subscriptionId = null;
  let timer = null;
  let settled = false;
  let removeHandler = () => {};
  let removeAbortHandler = () => {};

  let resolveEvent;
  let rejectEvent;
  const result = new Promise((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    removeHandler();
    removeAbortHandler();
    if (subscriptionId !== null && subscriptionId !== undefined) {
      try {
        relay.unsubscribe?.(subscriptionId);
      } catch {
        // Best-effort CLOSE; the relay may already be disconnected.
      }
    }
  };

  const finish = (event, error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectEvent(error);
    else resolveEvent(event);
  };

  const handler = (event) => {
    if (event?.id === builderEventId) finish(event);
  };
  removeHandler = registerRelayEventHandler(relay, handler);

  const onAbort = () => {
    finish(undefined, signal.reason instanceof Error
      ? signal.reason
      : new ReviewTimeoutError(timeoutMs));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortHandler = () => signal.removeEventListener("abort", onAbort);
    }
  }

  timer = setTimeout(() => finish(undefined, new ReviewTimeoutError(timeoutMs)), timeoutMs);
  try {
    subscriptionId = await relay.subscribe({ ids: [builderEventId] });
    // A synchronous test double can emit from subscribe before returning its
    // id; still close that subscription once the id is available.
    if (settled && subscriptionId !== null && subscriptionId !== undefined) {
      try { relay.unsubscribe?.(subscriptionId); } catch { /* best effort */ }
    }
    if (!settled) await relay.connect();
  } catch (error) {
    finish(undefined, asError(error));
  }

  return result;
}

function extractJsonText(output) {
  const raw = output.trim();
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw);
    return runtimeReplyText(parsed) || raw;
  } catch {
    // --json may emit NDJSON; use the last object that contains text.
    for (const line of raw.split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line);
        const text = runtimeReplyText(parsed);
        if (text) return text;
      } catch {
        // Keep looking for a structured result.
      }
    }
    return raw;
  }
}

async function askReviewer({ env, name, event, signal }) {
  const home = env.HOME ?? process.env.HOME;
  const binary = env.AGENT_RUNTIME_BIN ?? `${home}/.local/bin/${env.AGENT_RUNTIME ?? "ggcoder"}-minimax`;
  const prompt = [
    `You are ${name}, an independent red-team reviewer.`,
    "Review the builder Nostr event below.",
    "Reply exactly WIN, LOSE, or EQUAL on the first line, followed by concise reasoning.",
    JSON.stringify(event),
  ].join("\n\n");

  return new Promise((resolve, reject) => {
    let child;
    let output = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      child?.kill("SIGTERM");
      finish(signal.reason instanceof Error ? signal.reason : new ReviewTimeoutError(REVIEW_TIMEOUT_MS));
    };

    try {
      child = spawn(
        binary,
        ["--model", "MiniMax-M3", "--max-turns", "1", "--provider", "minimax", "--json", prompt],
        {
          env: { ...env, GG_PROVIDER: "minimax", GG_MODEL: "MiniMax-M3" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      child.on("close", () => finish(null, extractJsonText(output)));
      child.on("error", (error) => finish(error));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    } catch (error) {
      finish(error);
    }
  });
}

async function reviewAgent({ agent, builderEventId, builderPubkey, log, timeoutMs }) {
  const name = agentName(agent);
  const controller = new AbortController();
  let context = null;
  let deadlineTimer = null;
  let reviewPromise;

  try {
    reviewPromise = (async () => {
      context = resolveAgent(agent, log);
      const builderEvent = await readBuilderEvent({
        relay: context.relay,
        builderEventId,
        signal: controller.signal,
        timeoutMs,
      });
      if (controller.signal.aborted) throw controller.signal.reason;

      const reply = context.ask
        ? await context.ask(builderEvent, {
          agent: name,
          builderEventId,
          builderPubkey,
          env: context.env,
          model: "MiniMax-M3",
          signal: controller.signal,
        })
        : await askReviewer({ env: context.env, name, event: builderEvent, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;

      const verdict = normalizeReviewerVerdict(reply);
      if (verdict.kind === "no_verdict") return { name, verdict, event: null, relay: context.relay, keypair: context.keypair };

      const comment = finalizeEvent(
        {
          kind: 1111,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["E", builderEventId], ["P", builderPubkey]],
          content: `${verdict.kind.toUpperCase()}\n${verdict.body}`.trim(),
        },
        context.keypair.skBytes,
      );
      const publishResult = await context.relay.publish(comment);
      if (isExplicitFailure(publishResult)) {
        throw new Error(`review comment rejected: ${publishResult.reason || "unknown reason"}`);
      }
      return {
        name,
        verdict,
        event: comment,
        publishResult,
        relay: context.relay,
        keypair: context.keypair,
      };
    })();

    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new ReviewTimeoutError(timeoutMs)), timeoutMs);
    });
    return await Promise.race([reviewPromise, deadline]);
  } catch (error) {
    const normalized = asError(error);
    controller.abort(normalized);
    closeOwnedRelay(context);
    return {
      name,
      verdict: { kind: "no_verdict", body: normalized.message },
      event: null,
      relay: context?.relay ?? null,
      keypair: context?.keypair ?? null,
      error: normalized,
    };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    controller.abort();
    closeOwnedRelay(context);
  }
}

function countVerdicts(results) {
  const counts = { win: 0, lose: 0, equal: 0, no_verdict: 0 };
  for (const result of results) {
    if (Object.hasOwn(counts, result.verdict.kind)) counts[result.verdict.kind] += 1;
    else counts.no_verdict += 1;
  }
  return counts;
}

function majorityVerdict(counts) {
  const winner = REVIEW_KINDS.reduce((best, kind) => {
    if (counts[kind] > counts[best]) return kind;
    return best;
  }, REVIEW_KINDS[0]);
  return REVIEW_KINDS.some((kind) => counts[kind] > 0) ? winner : "no_verdict";
}

function dissentScore(result) {
  const priority = { lose: 3, equal: 2, win: 1 }[result.verdict.kind] ?? 0;
  return priority * 1_000_000 + (result.verdict.body?.length ?? 0);
}

function strongestDissent(results, winner) {
  return results
    .filter((result) => REVIEW_KINDS.includes(result.verdict.kind) && result.verdict.kind !== winner)
    .sort((a, b) => dissentScore(b) - dissentScore(a))[0] ?? null;
}

function buildMetaContent({ winner, counts, dissent }) {
  const lines = [
    winner.toUpperCase(),
    `[red-team] WIN ${counts.win} / LOSE ${counts.lose} / EQUAL ${counts.equal} / NO_VERDICT ${counts.no_verdict}`,
  ];
  if (dissent) {
    lines.push(`DISSENT: ${dissent.name}: ${dissent.verdict.kind.toUpperCase()} — ${dissent.verdict.body}`);
  } else {
    lines.push("No dissent.");
  }
  return lines.join("\n");
}

/**
 * Run independent NIP-22 reviews in parallel, then publish the coordinator's
 * aggregate as a reply to the coordinator comment and the builder root.
 *
 * `agents` accepts names backed by ~/.config/coreprt/<name>.env, or injected
 * objects with { name, env, keypair, relay, ask } for tests and embeddings.
 * `reviewTimeoutMs`/`timeoutMs` are test hooks; production defaults to 90s.
 */
export async function runRedTeam({
  builderEventId,
  builderPubkey,
  agents = [],
  log = () => {},
  reviewTimeoutMs = REVIEW_TIMEOUT_MS,
  timeoutMs,
} = {}) {
  const deadlineMs = timeoutMs ?? reviewTimeoutMs;
  const results = await Promise.all(
    agents.map((agent) => reviewAgent({
      agent,
      builderEventId,
      builderPubkey,
      log,
      timeoutMs: deadlineMs,
    })),
  );

  const counts = countVerdicts(results);
  const winner = majorityVerdict(counts);
  const dissent = strongestDissent(results, winner);
  const content = buildMetaContent({ winner, counts, dissent });

  // Normally the first reviewer is the coordinator. If it timed out before
  // publishing a comment, use the first successful reviewer so the aggregate
  // still gets published rather than turning one timeout into a deadlock.
  const coordinator = results[0];
  const publisher = (coordinator?.event && coordinator.relay && coordinator.keypair)
    ? coordinator
    : results.find((result) => result.event && result.relay && result.keypair);
  if (!publisher) {
    return {
      results,
      counts,
      strongestDissent: dissent,
      verdict: { kind: winner, body: content },
      event: null,
      metaEvent: null,
    };
  }

  const parentEventId = coordinator?.event?.id ?? publisher.event.id;
  const metaEvent = finalizeEvent(
    {
      kind: 1111,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", parentEventId],
        ["E", builderEventId],
        ["P", builderPubkey],
      ],
      content,
    },
    publisher.keypair.skBytes,
  );
  try {
    const publishResult = await publisher.relay.publish(metaEvent);
    if (isExplicitFailure(publishResult)) {
      throw new Error(`meta-comment rejected: ${publishResult.reason || "unknown reason"}`);
    }
    return {
      results,
      counts,
      strongestDissent: dissent,
      verdict: { kind: winner, body: content },
      event: metaEvent,
      metaEvent,
      publisher: publisher.name,
      publishResult,
    };
  } catch (error) {
    log(`red-team: coordinator publish failed: ${asError(error).message}`);
    return {
      results,
      counts,
      strongestDissent: dissent,
      verdict: { kind: winner, body: content },
      event: null,
      metaEvent: null,
      error: asError(error),
    };
  }
}

export const _internals = {
  buildMetaContent,
  countVerdicts,
  majorityVerdict,
  normalizeReviewerVerdict,
  registerRelayEventHandler,
};
