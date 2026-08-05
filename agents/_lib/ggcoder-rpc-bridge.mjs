#!/usr/bin/env node
// ggcoder-rpc-bridge — wire runtime.mjs stdio to ggcoder --rpc stdio.
//
// Architecture (jcode-style persistent serve process):
//
//   ┌────────────────────────┐         ┌─────────────────────────┐
//   │ runtime.mjs (Nostr     │  stdin  │ ggcoder-rpc-bridge.mjs  │  spawn  │ ggcoder --rpc         │
//   │ client)                │ ──────► │ (this file)             │ ───────► │ (persistent, model    │
//   │                        │  stdout │                         │          │  loaded)              │
//   │ read prompt events     │ ◄────── │ forward events/result   │ ◄─────── │                      │
//   └────────────────────────┘         └─────────────────────────┘
//
// We forward the parent's stdin → ggcoder's stdin, and ggcoder's stdout →
// the parent's stdout. Process startup latency is paid ONCE per LaunchAgent
// boot, not once per Nostr message.
//
// env:
//   GGCODER_BIN   — path to ggcoder binary (default: ~/.npm-global/bin/ggcoder)
//   GG_PROVIDER   — AI provider (default: minimax)
//   GG_MODEL      — model name (default: MiniMax-M3)
//   GG_SYSTEM_PROMPT — optional system prompt override
//   GG_CWD        — working dir for ggcoder (default: repo root)
//   GG_BIN_ARGS   — extra args passed to ggcoder before `--rpc`

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const bin = process.env.GGCODER_BIN || `${process.env.HOME}/.npm-global/bin/ggcoder`;
if (!existsSync(bin)) {
  console.error(`ggcoder not found at ${bin}. Set GGCODER_BIN or install @kenkaiiii/ggcoder.`);
  process.exit(1);
}

const provider = process.env.GG_PROVIDER || "minimax";
const model = process.env.GG_MODEL || "MiniMax-M3";
const cwd = process.env.GG_CWD || process.cwd();
const extraArgs = (process.env.GG_BIN_ARGS || "").split(/\s+/).filter(Boolean);

const args = [
  ...extraArgs,
  "--provider", provider,
  "--model", model,
  "--rpc",
];
if (process.env.GG_SYSTEM_PROMPT) {
  args.push("--system-prompt", process.env.GG_SYSTEM_PROMPT);
}

const child = spawn(bin, args, {
  cwd,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, GG_NO_EMOJI: "1" },
});

let childExited = false;
let exitCode = 0;
child.on("exit", (code, signal) => {
  childExited = true;
  exitCode = code ?? (signal ? 1 : 0);
  // Forward exit so the parent knows
  process.exit(exitCode);
});
child.on("error", (err) => {
  console.error(`failed to spawn ggcoder: ${err.message}`);
  process.exit(1);
});

// parent stdin → ggcoder stdin
process.stdin.on("data", (chunk) => {
  if (childExited) return;
  child.stdin.write(chunk);
});
process.stdin.on("end", () => {
  if (!childExited) child.stdin.end();
});

// ggcoder stdout → parent stdout (events + results NDJSON)
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    process.stdout.write(line + "\n");
  }
});
child.stdout.on("end", () => {
  if (stdoutBuf) process.stdout.write(stdoutBuf);
  if (!childExited) child.kill("SIGTERM");
});

// Forward parent SIGTERM/SIGINT to ggcoder cleanly
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (!childExited) {
      child.kill(sig);
    }
  });
}
