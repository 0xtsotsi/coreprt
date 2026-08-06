// autopilot-loop.mjs — /reflect = always-on Ken auto-review loop.
//
// Mirrors gg-coder's kenAuto autopilot cycle: after every agent reply,
// evaluate the turn (changed lines, tool calls, write/edit count), and if
// the work is substantial enough to be worth reviewing, spawn a Ken-side
// ggcoder session to review it. Ken's verdict routes the loop:
//   ALL_CLEAR → stop (work is sound)
//   IGNORE    → stop (turn was mechanical, nothing to review)
//   HUMAN     → surface a kind:9 with the reason, hand to operator
//   PROMPT    → inject the fix prompt back to the build session
//
// Always on. No toggle. Capped at MAX_AUTOPILOT_ROUNDS iterations.

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const MAX_AUTOPILOT_ROUNDS = 3;

// ── ported from gg-coder/dist/core/ideal-review.js ─────────────────
function evaluateIdealReview(stats) {
  const reasons = [];
  let score = 0;
  if (stats.changedLines >= 120) { score += 2; reasons.push(`${stats.changedLines} changed lines`); }
  else if (stats.changedLines >= 60) { score += 1; reasons.push(`${stats.changedLines} changed lines`); }
  if (stats.toolCalls >= 8) { score += 1; reasons.push(`${stats.toolCalls} tool calls`); }
  if (stats.writeCalls + stats.editCalls >= 4) { score += 2; reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`); }
  else if (stats.writeCalls + stats.editCalls >= 2) { score += 1; reasons.push(`${stats.writeCalls + stats.editCalls} file mutation calls`); }
  if (stats.bashCalls > 0 && stats.writeCalls + stats.editCalls > 0) { score += 1; reasons.push("shell command plus file mutation"); }
  return { shouldReview: score >= 2, score, reasons };
}

// ── ported from gg-coder/dist/core/autopilot-verdict.js ────────────
function parseAutopilotVerdict(reply) {
  const raw = (reply ?? "").trim();
  if (!raw) return { kind: "human", reason: "autopilot returned empty reply" };
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const kw = (lines[i] ?? "").trim().toUpperCase().replace(/[:.]+\s*$/, "").replace(/\s+/g, "_");
  const rest = lines.slice(i + 1).join("\n").trim();
  if (kw === "ALL_CLEAR" || kw.startsWith("ALL_CLEAR")) return { kind: "all_clear" };
  if (kw === "IGNORE" || kw.startsWith("IGNORE") || kw === "SKIP" || kw.startsWith("SKIP")) return { kind: "ignore" };
  if (kw === "HUMAN" || kw.startsWith("HUMAN")) return { kind: "human", reason: rest || "operator decision needed" };
  if (kw === "PROMPT" || kw.startsWith("PROMPT")) {
    // Drop the keyword from the body if it appears on the same line.
    const body = kw === "PROMPT" ? rest : lines.slice(i).join("\n").replace(/^PROMPT[:.\s]*/i, "").trim();
    return { kind: "prompt", body };
  }
  return { kind: "human", reason: `unparseable verdict: ${kw}` };
}

// ── run a one-shot ggcoder --rpc session for Ken's review ──────────
function runKenReview(systemPrompt, userPrompt) {
  return new Promise((resolve) => {
    const bridge = spawn(
      process.execPath,
      [new URL("ggcoder-rpc-bridge.mjs", import.meta.url).pathname],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          GG_PROVIDER: process.env.GG_PROVIDER || "minimax",
          GG_MODEL: process.env.AGENT_MODEL || "MiniMax-M3",
          GG_CWD: process.env.GG_CWD || new URL("..", import.meta.url).pathname,
          GG_NO_EMOJI: "1",
          GG_SYSTEM_PROMPT: systemPrompt,
        },
      }
    );
    const id = `ken-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const collected = [];
    let buf = "";
    const timer = setTimeout(() => {
      bridge.kill("SIGTERM");
      resolve(collected.join(""));
    }, 60_000);
    bridge.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        // ggcoder echoes our prompt id on every streamed event; use it to
        // correlate text_delta events to this Ken review (strict routing —
        // see the parallel logic in runtime.mjs routeBridgeEvent).
        if (event.type === "text_delta" && event.id === id && typeof event.text === "string") {
          collected.push(event.text);
        }
        if (event.type === "result" && event.id === id) {
          clearTimeout(timer);
          const reply = (typeof event.data?.text === "string") ? event.data.text : "";
          const finalReply = reply || collected.join("");
          bridge.kill("SIGTERM");
          resolve(finalReply);
        }
        if (event.type === "error" && event.id === id) {
          clearTimeout(timer);
          resolve(collected.join(""));
        }
      }
    });
    bridge.on("exit", () => { clearTimeout(timer); resolve(collected.join("")); });
    bridge.stdin.write(JSON.stringify({ id, command: "prompt", text: userPrompt }) + "\n");
  });
}

// ── git diff capture for the just-completed turn ───────────────────
function getRecentDiff(since) {
  try {
    return execSync(`git diff ${since}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

// ── the autopilot loop itself ──────────────────────────────────────
export async function runAutopilot({ agent, keypair, relay, channelId, lastReplyEventId, stats, log, skip, tags, content }) {
  if (skip) {
    log("autopilot: skip (slash command reply)");
    return { skipped: true, reason: "slash command reply" };
  }
  // ── gauntlet delegation (PR-3) — runs before Ken when the turn is
  // tagged with `bar:<name>` or mentions `/gauntlet <bar-name>`. The
  // gauntlet publishes its own kind:1111 verdict; Ken does NOT also run.
  const gauntletRef = detectGauntletTag({ tags: tags ?? [], content: content ?? "" });
  if (gauntletRef) {
    const gauntletResult = await maybeRunGauntlet({
      opts: { gauntlet: { barName: gauntletRef.barName, agent }, builderOutput: content ?? "" },
      relay, keypair, channelId, lastReplyEventId, log,
    });
    if (gauntletResult) {
      return { skipped: false, verdict: gauntletResult.verdict.kind, rounds: 1, gauntlet: gauntletResult };
    }
    // bar not found → fall through to Ken with a log line.
  }
  const decision = evaluateIdealReview(stats);
  if (!decision.shouldReview) {
    log(`autopilot: shouldReview=false (score=${decision.score}) — skipping`);
    return { skipped: true, reason: "below threshold", decision };
  }
  log(`autopilot: shouldReview=true (score=${decision.score}, reasons=${JSON.stringify(decision.reasons)})`);

  // Capture the diff for Ken to review.
  const diff = getRecentDiff("HEAD");
  const reviewPrompt = [
    `Review this diff produced by the CorePrt agent "${agent}". The agent just published a reply to the channel. Your job: review the work, return exactly one verdict.`,
    "",
    "## Verdict format (REQUIRED)",
    "First non-empty line of your reply MUST be one of:",
    "  ALL_CLEAR    — work is sound, ship it",
    "  IGNORE       — turn was mechanical, no code changes worth reviewing",
    "  HUMAN        — operator decision needed; explain on the next line",
    "  PROMPT       — issue a fix prompt; the prompt body follows the keyword",
    "",
    "## Diff under review",
    "```",
    diff.slice(0, 8000),
    "```",
  ].join("\n");

  // Ken's system prompt: autopilot-injection preamble + ideal-review shape
  const preamble = "You are Ken, the autopilot reviewer for a CorePrt agent. No human is watching this turn. Self-verify your reasoning; only surface genuine operator decisions. Reply with a verdict in the exact format above; do not editorialize.";
  const reviewSystemPrompt = `${preamble}\n\n${process.env.AUTOPILOT_REVIEW_PROMPT || ""}`.trim();

  let round = 0;
  let verdict = null;
  let lastInjectedPrompt = null;
  while (round < MAX_AUTOPILOT_ROUNDS) {
    round++;
    log(`autopilot round ${round}/${MAX_AUTOPILOT_ROUNDS}`);
    const replyText = await runKenReview(reviewSystemPrompt, reviewPrompt);
    verdict = parseAutopilotVerdict(replyText);
    log(`autopilot verdict: ${verdict.kind}`);

    if (verdict.kind === "all_clear" || verdict.kind === "ignore") {
      // Publish a one-line ken-marker to the channel so the operator sees the review ran
      await publishKenMarker(relay, keypair, channelId, lastReplyEventId, verdict.kind, round);
      return { skipped: false, verdict: verdict.kind, rounds: round };
    }
    if (verdict.kind === "human") {
      // Hand to operator
      await publishKenMarker(relay, keypair, channelId, lastReplyEventId, `HUMAN: ${verdict.reason}`, round);
      return { skipped: false, verdict: "human", reason: verdict.reason, rounds: round };
    }
    if (verdict.kind === "prompt") {
      lastInjectedPrompt = verdict.body;
      // Inject the fix prompt back into the BUILD session as a fresh Nostr kind:9.
      // This becomes the next "user message" the agent processes.
      await publishBuildInjection(relay, keypair, channelId, agent, verdict.body);
      // Loop: re-run review on the next turn's diff
      continue;
    }
  }
  // Capped
  await publishKenMarker(relay, keypair, channelId, lastReplyEventId, `CAPPED at ${MAX_AUTOPILOT_ROUNDS} rounds; last verdict was PROMPT`, MAX_AUTOPILOT_ROUNDS);
  return { skipped: false, verdict: "capped", rounds: MAX_AUTOPILOT_ROUNDS, lastInjectedPrompt };
}

async function publishKenMarker(relay, keypair, channelId, replyEventId, marker, round) {
  const { finalizeEvent } = await import("./nostr.mjs");
  const text = `[ken] (autopilot, round ${round}) ${marker}`;
  const event = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [["h", channelId], ["e", replyEventId]], content: text },
    keypair.skBytes
  );
  await relay.publish(event);
}

async function publishBuildInjection(relay, keypair, channelId, agent, body) {
  const { finalizeEvent } = await import("./nostr.mjs");
  // Wrap the body so runtime.mjs's isTriggeredChannelMessage picks it up
  // (the @<agent> trigger filter requires a mention).
  const text = `@${agent} ${body}`;
  const event = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [["h", channelId]], content: text },
    keypair.skBytes
  );
  await relay.publish(event);
}

// ── gauntlet delegation (PR-3) ──────────────────────────────────────
// When the just-completed turn is tagged with a `bar:<name>` or carries
// a `/gauntlet <bar-name>` slash command, the autopilot delegates the
// review to agents/_lib/gauntlet.mjs instead of the default Ken path.
//
// The gauntlet verdict publishes as a kind:1111 (NIP-22) comment on the
// builder's reply event. On LOSE/EQUAL it injects the gap back as a
// follow-up kind:9 to the builder; on WIN/HUMAN it exits the loop.
//
// If `opts.gauntlet` is null/undefined, this function returns null and
// the caller falls through to the existing Ken review path.
export async function maybeRunGauntlet({ opts, relay, keypair, channelId, lastReplyEventId, log }) {
  if (!opts?.gauntlet || !opts?.builderOutput) return null;
  const gauntlet = await import("./gauntlet.mjs");
  const bar = gauntlet.loadBar(opts.gauntlet.barName);
  if (!bar) {
    log(`gauntlet: bar "${opts.gauntlet.barName}" not found; falling through to Ken review`);
    return null;
  }
  const runId = opts.gauntlet.runId ?? `gauntlet-${lastReplyEventId?.slice(0, 8) ?? Date.now()}`;
  if (!gauntlet.resumeRun(runId)) {
    gauntlet.startRun({
      runId,
      bar,
      builderPubkey: opts.gauntlet.builderPubkey ?? "unknown",
      agent: opts.gauntlet.agent ?? "unknown",
    });
  }
  log(`gauntlet: round ${1} bar=${opts.gauntlet.barName} runId=${runId}`);
  const result = await gauntlet.nextRound({
    runId,
    builderOutput: opts.builderOutput,
    builderEventId: lastReplyEventId,
  });
  // Publish the kind:1111 verdict comment so the channel sees it.
  const { finalizeEvent } = await import("./nostr.mjs");
  const verdictEvent = finalizeEvent(
    {
      kind: 1111, // NIP-22 comment
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", channelId],
        ["e", lastReplyEventId, "reply"],
        ["gauntlet", opts.gauntlet.barName],
        ["verdict", result.verdict.kind.toUpperCase()],
        ["client", "coreprt-gauntlet"],
      ],
      content: result.body,
    },
    keypair.skBytes
  );
  await relay.publish(verdictEvent);
  log(`gauntlet: verdict=${result.verdict.kind} done=${result.done}`);
  return { runId, verdict: result.verdict, done: result.done };
}

// Extract a `bar:<name>` reference from the turn's tags/content if any.
// Used by runtime.mjs to populate opts.gauntlet before calling the
// autopilot loop. Pure function so it can be unit-tested.
export function detectGauntletTag({ tags = [], content = "" } = {}) {
  // Tag form: ["bar", "<name>"] in the tags array (Nostr event tags).
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === "bar" && typeof t[1] === "string") {
      return { barName: t[1], source: "tag" };
    }
  }
  // Slash form: "/gauntlet <bar-name>" anywhere in the content.
  // Bar names are slug-shaped ([a-z0-9._-]+); trailing punctuation is
  // stripped before matching so "linear-pricing." reads as "linear-pricing".
  const m = content.replace(/[.,;:!?]+/g, " ").match(/\/gauntlet\s+([a-z0-9._-]+)/i);
  if (m) return { barName: m[1], source: "slash" };
  return null;
}
