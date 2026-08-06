#!/usr/bin/env node
// sync-ggcoder.test.mjs — node:test suite for scripts/sync-ggcoder.mjs.
//
// Tests run the sync as a child process so the script's env-var path
// overrides (COREPRT_REPO_ROOT, GGCODER_PKG_DIR, GG_FRAMEWORK_PKG_DIR) take
// effect at the child's module-load time. Each test uses its own temp dir.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, readdirSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, "..", "sync-ggcoder.mjs");
const NODE = process.execPath;

// ── helpers ─────────────────────────────────────────────────────────

function makeFakeFramework(dir, { skills = true, commands = true, plans = true, reviews = true } = {}) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@kenkaiiii/gg-framework", version: "0.1.0-test" })
  );
  if (skills) {
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills/foo.md"), "# foo\n");
    writeFileSync(join(dir, "skills/bar.md"), "# bar\n");
  }
  if (commands) {
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands/x.md"), "# x\n");
  }
  if (plans) {
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(join(dir, "plans/p1.md"), "# plan\n");
  }
  if (reviews) {
    mkdirSync(join(dir, "reviews"), { recursive: true });
    writeFileSync(join(dir, "reviews/r1.md"), "# review\n");
  }
}

function makeFakeGgcoder(dir) {
  // Minimal dist/core/prompt-commands.js with one entry.
  mkdirSync(join(dir, "dist/core"), { recursive: true });
  const src = `
export const PROMPT_COMMANDS = [
  {
    name: "smoke-test",
    description: "A test command for sync-ggcoder.test.mjs",
    prompt: \`Hello, smoke.\`,
  },
];
`;
  writeFileSync(join(dir, "dist/core/prompt-commands.js"), src);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@kenkaiiii/ggcoder", version: "9.9.9-test" }));
}

function runSync(env, args = []) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

let tmpRoot, tmpFramework, tmpGgcoder;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "sync-ggcoder-test-"));
  tmpRoot = base;
  tmpFramework = join(base, "fake-framework");
  tmpGgcoder = join(base, "fake-ggcoder");
  mkdirSync(tmpFramework, { recursive: true });
  mkdirSync(tmpGgcoder, { recursive: true });
  mkdirSync(join(base, ".gg"), { recursive: true });
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function syncFrameworkEnv() {
  return {
    COREPRT_REPO_ROOT: tmpRoot,
    GG_FRAMEWORK_PKG_DIR: tmpFramework,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── tests ───────────────────────────────────────────────────────────

test("manifest skip: unchanged file is not re-written (mtime preserved)", async () => {
  makeFakeFramework(tmpFramework);
  // First sync — writes everything + manifest.
  const r1 = runSync(syncFrameworkEnv(), ["--source", "gg-framework"]);
  assert.equal(r1.status, 0, `first sync failed:\n${r1.stderr}\n${r1.stdout}`);

  const fooPath = join(tmpRoot, ".gg/framework/skills/foo.md");
  const manifestPath = join(tmpRoot, ".gg/.sync-manifest.json");
  assert.ok(existsSync(fooPath), "foo.md should exist after first sync");
  assert.ok(existsSync(manifestPath), "manifest should exist after first sync");

  const mtime1 = statSync(fooPath).mtimeMs;
  const manifest1 = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const fileCount1 = Object.keys(manifest1.files).length;
  assert.ok(fileCount1 > 0, "manifest should have at least one file");

  // Wait so any re-write would push mtime forward.
  await sleep(50);

  // Second sync with no source change — must skip all files.
  const r2 = runSync(syncFrameworkEnv(), ["--source", "gg-framework"]);
  assert.equal(r2.status, 0, `second sync failed:\n${r2.stderr}\n${r2.stdout}`);

  const mtime2 = statSync(fooPath).mtimeMs;
  assert.equal(
    mtime2,
    mtime1,
    `file mtime should be unchanged on second sync (mtime1=${mtime1}, mtime2=${mtime2})`
  );

  // Log should mention "unchanged" for skipped files.
  assert.match(
    r2.stdout,
    /unchanged/,
    `expected log to mention unchanged files:\n${r2.stdout}`
  );
});

test("missing source exits 0 with a clear log line", () => {
  // No fake framework created → GG_FRAMEWORK_PKG_DIR points to non-existent dir.
  const r = runSync(
    {
      COREPRT_REPO_ROOT: tmpRoot,
      GG_FRAMEWORK_PKG_DIR: join(tmpRoot, "does-not-exist"),
    },
    ["--source", "gg-framework"]
  );
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}\n${r.stdout}`);
  assert.match(
    r.stdout,
    /gg-framework not installed/,
    `expected "not installed" log line:\n${r.stdout}`
  );
});

test("--dry-run prints planned changes but writes nothing", () => {
  makeFakeFramework(tmpFramework);
  const r = runSync(syncFrameworkEnv(), ["--source", "gg-framework", "--dry-run"]);

  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}\n${r.stdout}`);

  // Output files should NOT exist.
  const fooPath = join(tmpRoot, ".gg/framework/skills/foo.md");
  assert.ok(!existsSync(fooPath), `foo.md should not exist after dry-run`);

  // Manifest should NOT exist (saveManifest is a no-op in dry-run).
  const manifestPath = join(tmpRoot, ".gg/.sync-manifest.json");
  assert.ok(!existsSync(manifestPath), `manifest should not exist after dry-run`);

  // Log should mention dry-run.
  assert.match(
    r.stdout,
    /dry-run|planned|would/i,
    `expected dry-run indicator in log:\n${r.stdout}`
  );
});

test("--prune removes orphan files when manifest is fresh", () => {
  makeFakeFramework(tmpFramework);

  // First sync — populates output + manifest.
  const r1 = runSync(syncFrameworkEnv(), ["--source", "gg-framework"]);
  assert.equal(r1.status, 0, r1.stderr);
  const manifestPath = join(tmpRoot, ".gg/.sync-manifest.json");
  assert.ok(existsSync(manifestPath));

  // Add an orphan file to the output root — not in the manifest.
  const orphanDir = join(tmpRoot, ".gg/framework/skills");
  const orphanPath = join(orphanDir, "orphan.md");
  writeFileSync(orphanPath, "# orphan\n");
  assert.ok(existsSync(orphanPath));

  // Run sync with --prune.
  const r2 = runSync(syncFrameworkEnv(), ["--source", "gg-framework", "--prune"]);
  assert.equal(r2.status, 0, `prune failed:\n${r2.stderr}\n${r2.stdout}`);
  assert.ok(!existsSync(orphanPath), "orphan file should be removed by --prune");

  // Real synced file should still be there.
  const fooPath = join(tmpRoot, ".gg/framework/skills/foo.md");
  assert.ok(existsSync(fooPath), "foo.md should still exist after prune");
});

test("--prune refuses when manifest is missing", () => {
  // No manifest exists. --prune should exit 1.
  const r = runSync(syncFrameworkEnv(), ["--source", "gg-framework", "--prune"]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}:\n${r.stderr}\n${r.stdout}`);
  assert.match(
    r.stderr,
    /manifest/i,
    `expected manifest-related error:\n${r.stderr}`
  );
});

test("--prune refuses when manifest is older than 24h", () => {
  makeFakeFramework(tmpFramework);

  // First sync to create manifest.
  const r1 = runSync(syncFrameworkEnv(), ["--source", "gg-framework"]);
  assert.equal(r1.status, 0, r1.stderr);
  const manifestPath = join(tmpRoot, ".gg/.sync-manifest.json");

  // Backdate the manifest mtime to 25 hours ago.
  const oldMtime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(manifestPath, oldMtime, oldMtime);

  const r2 = runSync(syncFrameworkEnv(), ["--source", "gg-framework", "--prune"]);
  assert.equal(r2.status, 1, `expected exit 1, got ${r2.status}:\n${r2.stderr}\n${r2.stdout}`);
  assert.match(
    r2.stderr,
    /24h|old/i,
    `expected "old" or "24h" error:\n${r2.stderr}`
  );
});

test("ggcoder source extraction still works (regression check)", () => {
  makeFakeGgcoder(tmpGgcoder);

  const r = runSync(
    {
      COREPRT_REPO_ROOT: tmpRoot,
      GGCODER_PKG_DIR: tmpGgcoder,
      // Make gg-framework resolve to a non-existent dir so it logs and skips.
      GG_FRAMEWORK_PKG_DIR: join(tmpRoot, "no-framework"),
    },
    []
  );
  assert.equal(r.status, 0, `sync failed:\n${r.stderr}\n${r.stdout}`);

  const smokePath = join(tmpRoot, "agents/_lib/.gg/commands/smoke-test.md");
  assert.ok(existsSync(smokePath), `smoke-test.md should exist at ${smokePath}`);

  const content = readFileSync(smokePath, "utf-8");
  assert.match(content, /name: smoke-test/);
  assert.match(content, /Hello, smoke\./);

  // Version file written.
  const versionPath = join(tmpRoot, "agents/_lib/.ggcoder-version");
  assert.ok(existsSync(versionPath), "version file should exist");
  assert.equal(readFileSync(versionPath, "utf-8").trim(), "9.9.9-test");
});

test("--source gg-framework skips ggcoder entirely", () => {
  makeFakeGgcoder(tmpGgcoder);
  makeFakeFramework(tmpFramework);

  const r = runSync(
    {
      COREPRT_REPO_ROOT: tmpRoot,
      GGCODER_PKG_DIR: tmpGgcoder,
      GG_FRAMEWORK_PKG_DIR: tmpFramework,
    },
    ["--source", "gg-framework"]
  );
  assert.equal(r.status, 0, r.stderr);

  // ggcoder commands dir should not exist (no extraction happened).
  const smokePath = join(tmpRoot, "agents/_lib/.gg/commands/smoke-test.md");
  assert.ok(!existsSync(smokePath), "ggcoder extraction should not have run");

  // gg-framework files should exist.
  const fooPath = join(tmpRoot, ".gg/framework/skills/foo.md");
  assert.ok(existsSync(fooPath), "gg-framework file should exist");
});

test("unknown --source value exits with code 2", () => {
  const r = runSync(syncFrameworkEnv(), ["--source", "bogus"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}:\n${r.stderr}`);
});
