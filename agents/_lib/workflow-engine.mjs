// workflow-engine.mjs — parse a plan into tasks and execute them.
//
// Mirrors the shape used by existing .gg/plans/*.md files (see
// 2026-08-04-foundation-and-priorities.md for the canonical format):
//
//   ## Foundation: <name>          ← task 1
//   ## Feature 1: <name>            ← task 2
//   **User-facing behavior:**        ← detail
//   **Files/anchors:**               ← detail
//   **Verification:**                ← detail
//
// Each `## <Label>:` heading becomes one TaskRecord. Heading content after
// the colon is the title. Body text up to the next `## ...` is the prompt.
//
// The tasks are written to ~/.gg/tasks.json matching gg-coder's TaskRecord
// schema (id, title, prompt, status, createdAt). One workspace per task
// (a git worktree under /tmp/coreprt-ws-<taskid>). The same Nostr channel
// is used for subagent dispatch — each child runtime.mjs subscribes to
// the channel, processes its assigned task, replies, and exits.
//
// Invocation:
//   node workflow-engine.mjs parse <plan.md>          # parse + show tasks
//   node workflow-engine.mjs run <plan.md>            # parse + dispatch
//   node workflow-engine.mjs run <plan.md> --task N  # run only one task

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const TASKS_FILE = join(process.env.HOME, ".gg", "tasks.json");
const WS_ROOT = "/tmp/coreprt-ws";
const REPO_ROOT = join(import.meta.dirname, "..", "..");

// ── plan parser ─────────────────────────────────────────────────
// Match `## <Label>:` or `## <Label>` headings. Skip h1 (`#`) and h3+ (`###`).
// Group body text under each heading. Empty headings are ignored.
function parsePlan(planPath) {
  const src = readFileSync(planPath, "utf-8");
  const lines = src.split("\n");
  const tasks = [];
  let current = null;
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line);
    if (m) {
      if (current) tasks.push(current);
      const heading = m[1].trim();
      // Strip leading numbering like "1:" or "Feature 1:" — keep the title only.
      const title = heading.replace(/^(?:Feature\s+\d+|Foundation|Task)\s*:\s*/i, "");
      current = { title, prompt: "" };
    } else if (current) {
      current.prompt += line + "\n";
    }
  }
  if (current) tasks.push(current);
  return tasks
    .map((t) => ({ id: randomUUID().slice(0, 8), title: t.title.trim(), prompt: t.prompt.trim() }))
    .filter((t) => t.title && t.prompt);
}

// ── task store ──────────────────────────────────────────────────
function loadTasks() {
  if (!existsSync(TASKS_FILE)) return [];
  return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
}
function saveTasks(tasks) {
  mkdirSync(dirname(TASKS_FILE), { recursive: true });
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}
function upsertTask(task) {
  const all = loadTasks();
  const existing = all.findIndex((t) => t.id === task.id);
  if (existing >= 0) all[existing] = task;
  else all.push(task);
  saveTasks(all);
}
function markDone(taskId) {
  const all = loadTasks();
  const t = all.find((x) => x.id === taskId);
  if (t) { t.status = "done"; saveTasks(all); }
}

// ── workspace management ───────────────────────────────────────
function makeWorkspace(taskId) {
  const ws = join(WS_ROOT, taskId);
  if (existsSync(ws)) {
    log(`workspace ${ws} already exists, reusing`);
    return ws;
  }
  mkdirSync(dirname(ws), { recursive: true });
  // git worktree add at HEAD — each task gets a clean copy to mutate.
  try {
    execSync(`git worktree add "${ws}" HEAD`, { cwd: REPO_ROOT, stdio: "inherit" });
    log(`created worktree at ${ws}`);
  } catch (err) {
    // Worktree failed (probably no git repo). Fall back to a plain copy.
    log(`worktree add failed: ${err.message}; falling back to cp`);
    execSync(`cp -R "${REPO_ROOT}/." "${ws}/"`, { stdio: "inherit" });
  }
  return ws;
}
function cleanupWorkspace(taskId) {
  const ws = join(WS_ROOT, taskId);
  if (!existsSync(ws)) return;
  try {
    execSync(`git worktree remove --force "${ws}"`, { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    rmSync(ws, { recursive: true, force: true });
  }
}

// ── subagent dispatch ──────────────────────────────────────────
function dispatchTask(task, channelId) {
  const ws = makeWorkspace(task.id);
  log(`dispatching task ${task.id} (${task.title}) in workspace ${ws}`);
  // Spawn a child runtime.mjs with the task as the only prompt, addressed at
  // the agent. The child subscribes to the channel, replies, and exits.
  // We post the initial kind:9 from the *operator's* nsec to the channel
  // (no separate writer needed) — the runtime sees it and processes.
  const env = {
    ...process.env,
    AGENT_NAME: process.env.AGENT_NAME || "goji",
    AGENT_RELAY_URL: process.env.AGENT_RELAY_URL || "wss://coreprt.webrnds.com",
    AGENT_CHANNEL_UUID: channelId,
    AGENT_GGCODER_RPC: "1",
    AGENT_WORKSPACE: ws,
    AGENT_TASK_ID: task.id,
  };
  // The child is started with the same env; the operator's nsec + prompt
  // are sent through the one-shot publish helper to keep the spawning
  // surface identical to operator-driven prompts.
  const child = spawn(
    process.execPath,
    [join(process.env.HOME, ".local/share/coreprt-agents/_lib/runtime.mjs")],
    { stdio: "inherit", env, cwd: ws }
  );
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      log(`task ${task.id} child exited (code=${code})`);
      markDone(task.id);
      cleanupWorkspace(task.id);
      resolve(code);
    });
  });
}

// ── logging ─────────────────────────────────────────────────────
function log(...args) {
  console.error(`[workflow-engine]`, ...args);
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  const [, , subcommand, planPath, ...rest] = process.argv;
  if (!subcommand || !planPath) {
    console.error("usage: workflow-engine.mjs <parse|run> <plan.md> [--task N]");
    process.exit(64);
  }
  const tasks = parsePlan(planPath);
  log(`parsed ${tasks.length} tasks from ${planPath}`);

  if (subcommand === "parse") {
    for (const t of tasks) {
      console.log(`# ${t.id}  ${t.title}`);
      console.log(`   prompt: ${t.prompt.length} chars`);
    }
    return;
  }

  if (subcommand === "run") {
    // Write all tasks to ~/.gg/tasks.json so the task pane sees them.
    const now = new Date().toISOString();
    const records = tasks.map((t) => ({ ...t, status: "pending", createdAt: now }));
    saveTasks(records);
    log(`wrote ${records.length} tasks to ${TASKS_FILE}`);

    const onlyTask = rest.includes("--task") ? rest[rest.indexOf("--task") + 1] : null;
    const targets = onlyTask ? records.filter((t) => t.id === onlyTask) : records;
    const channelId = process.env.AGENT_CHANNEL_UUID;
    if (!channelId) {
      console.error("AGENT_CHANNEL_UUID must be set");
      process.exit(78);
    }
    for (const t of targets) {
      // Mark in-progress and dispatch.
      t.status = "in-progress";
      saveTasks(records);
      await dispatchTask(t, channelId);
    }
    return;
  }

  console.error(`unknown subcommand: ${subcommand}`);
  process.exit(64);
}

main().catch((err) => { log(`fatal: ${err.message}`); process.exit(1); });
