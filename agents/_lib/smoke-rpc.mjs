#!/usr/bin/env node
// Smoke test: spawn bridge + consumer connected via parent stdio.
// Simulates what runtime.mjs will do at runtime.
import { spawn } from "node:child_process";
import readline from "node:readline";

const bridge = spawn("node", [
  "/Users/gogetta/Documents/projects/CorePrt/agents/_lib/ggcoder-rpc-bridge.mjs",
], {
  env: {
    ...process.env,
    GG_MODEL: "MiniMax-M3",
    GG_CWD: "/Users/gogetta/Documents/projects/CorePrt",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = readline.createInterface({ input: bridge.stdout });
const lines = [];
const promptId = "smoke-" + Date.now();

rl.on("line", (line) => {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "text_delta" && typeof event.text === "string") {
    lines.push(event.text);
  } else if (event.type === "result" && event.id === promptId) {
    console.log("FINAL:", JSON.stringify(lines.join("").trim()));
    bridge.kill("SIGTERM");
    process.exit(0);
  } else if (event.type === "error" && event.id === promptId) {
    console.error("ERROR:", event.message);
    bridge.kill("SIGTERM");
    process.exit(1);
  }
});

bridge.stdin.write(JSON.stringify({ id: promptId, command: "prompt", text: "say hi in one sentence" }) + "\n");

setTimeout(() => {
  console.error("TIMEOUT");
  bridge.kill("SIGTERM");
  process.exit(2);
}, 90000);
