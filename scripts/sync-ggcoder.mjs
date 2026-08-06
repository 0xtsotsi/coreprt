#!/usr/bin/env node
// sync-ggcoder.mjs — auto-sync gg-coder and gg-framework packages into CorePrt.
//
// Sources:
//   ggcoder       — parse dist/core/* into markdown commands/agents/skills/prompts/defaults.
//                   Writes to agents/_lib/.gg/{commands,agents,skills},
//                   agents/_lib/.ggcoder-{prompts,defaults}.
//   gg-framework  — verbatim file mirror of skills/, commands/, plans/, reviews/.
//                   Writes to .gg/framework/<subdir>.
//
// Idempotent. Re-running with no source change skips per-file via the manifest.
//
// Usage:
//   node scripts/sync-ggcoder.mjs                     # sync all installed sources
//   node scripts/sync-ggcoder.mjs --force             # re-sync even if manifest says unchanged
//   node scripts/sync-ggcoder.mjs --dry-run           # print plan, write nothing
//   node scripts/sync-ggcoder.mjs --source ggcoder    # only one source
//   node scripts/sync-ggcoder.mjs --source gg-framework
//   node scripts/sync-ggcoder.mjs --prune             # remove orphans (requires fresh manifest)
//
// Env overrides (for tests):
//   COREPRT_REPO_ROOT     — repo root (default: parent of this script)
//   GGCODER_PKG_DIR       — ggcoder install path
//   GG_FRAMEWORK_PKG_DIR  — gg-framework install path

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Paths ────────────────────────────────────────────────────────────
const REPO_ROOT = process.env.COREPRT_REPO_ROOT || join(__dirname, "..");
const GGCODER_PKG =
  process.env.GGCODER_PKG_DIR ||
  "/Users/gogetta/.npm-global/lib/node_modules/@kenkaiiii/ggcoder";
const GGCODER_CORE = join(GGCODER_PKG, "dist/core");
const GG_FRAMEWORK_PKG =
  process.env.GG_FRAMEWORK_PKG_DIR ||
  "/Users/gogetta/.npm-global/lib/node_modules/@kenkaiiii/gg-framework";
const MANIFEST_PATH = join(REPO_ROOT, ".gg/.sync-manifest.json");

// ggcoder outputs
const OUT_COMMANDS = join(REPO_ROOT, "agents/_lib/.gg/commands");
const OUT_AGENTS = join(REPO_ROOT, "agents/_lib/.gg/agents");
const OUT_SKILLS = join(REPO_ROOT, "agents/_lib/.gg/skills");
const OUT_PROMPTS = join(REPO_ROOT, "agents/_lib/.ggcoder-prompts");
const OUT_DEFAULTS = join(REPO_ROOT, "agents/_lib/.ggcoder-defaults");
const VERSION_FILE = join(REPO_ROOT, "agents/_lib/.ggcoder-version");

// gg-framework outputs
const OUT_FRAMEWORK = join(REPO_ROOT, ".gg/framework");
const FRAMEWORK_SUBDIRS = ["skills", "commands", "plans", "reviews"];

// ggcoder output roots (used by --prune)
const GGCODER_OUTPUT_DIRS = [
  OUT_COMMANDS,
  OUT_AGENTS,
  OUT_SKILLS,
  OUT_PROMPTS,
  OUT_DEFAULTS,
];

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry-run");
const PRUNE = args.includes("--prune");
const sourceIdx = args.indexOf("--source");
const SOURCE_FILTER = sourceIdx !== -1 ? args[sourceIdx + 1] : null;
const VALID_SOURCES = ["ggcoder", "gg-framework"];

if (SOURCE_FILTER && !VALID_SOURCES.includes(SOURCE_FILTER)) {
  console.error(`sync-ggcoder: unknown --source "${SOURCE_FILTER}" (valid: ${VALID_SOURCES.join(", ")})`);
  process.exit(2);
}

// ── Manifest ─────────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return { version: 1, sources: {}, files: {} };
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return { version: 1, sources: {}, files: {} };
  }
}

function saveManifest(m) {
  if (DRY) return;
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

function sha256File(p) {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

function fileMtimeMs(p) {
  return statSync(p).mtimeMs;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

function nowIso() {
  return new Date().toISOString();
}

// ── Source-presence check ────────────────────────────────────────────
function sourceInstalled(pkgDir) {
  if (!existsSync(pkgDir)) return false;
  if (!existsSync(join(pkgDir, "package.json"))) return false;
  return true;
}

function sourceVersion(pkgDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Globals populated by main() ──────────────────────────────────────
let manifest;
const stats = {
  ggcoder: { files: 0, bytes: 0, skipped: 0 },
  "gg-framework": { files: 0, bytes: 0, skipped: 0 },
};

// ── Tracked write: extract (generated content) ───────────────────────
// srcPath is read for SHA + mtime. content is the bytes to write.
function trackExtract(srcPath, dstPath, source, content) {
  const relDst = relative(REPO_ROOT, dstPath);
  const srcSha = sha256File(srcPath);
  const srcMtime = fileMtimeMs(srcPath);
  const existing = manifest.files[relDst];

  const canSkip =
    !FORCE &&
    existing &&
    existing.sourceSha === srcSha &&
    existing.sourceMtimeMs === srcMtime &&
    existsSync(dstPath);

  if (canSkip) {
    stats[source].skipped++;
    stats[source].files++;
    stats[source].bytes += existing.size ?? content.length;
    return "skipped";
  }

  if (!DRY) {
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, content);
  }
  stats[source].files++;
  stats[source].bytes += content.length;
  manifest.files[relDst] = {
    source,
    kind: "extract",
    sourceSha: srcSha,
    sourceMtimeMs: srcMtime,
    size: content.length,
    syncedAt: nowIso(),
  };
  return DRY ? "planned" : "wrote";
}

// ── Tracked write: mirror (verbatim copy) ────────────────────────────
function trackMirror(srcPath, dstPath, source) {
  const relDst = relative(REPO_ROOT, dstPath);
  const srcSha = sha256File(srcPath);
  const srcMtime = fileMtimeMs(srcPath);
  const existing = manifest.files[relDst];

  const canSkip =
    !FORCE &&
    existing &&
    existing.sourceSha === srcSha &&
    existing.sourceMtimeMs === srcMtime &&
    existsSync(dstPath);

  if (canSkip) {
    stats[source].skipped++;
    stats[source].files++;
    stats[source].bytes += existing.size ?? statSync(srcPath).size;
    return "skipped";
  }

  const content = readFileSync(srcPath);
  const size = content.length;
  if (!DRY) {
    mkdirSync(dirname(dstPath), { recursive: true });
    writeFileSync(dstPath, content);
  }
  stats[source].files++;
  stats[source].bytes += size;
  manifest.files[relDst] = {
    source,
    kind: "mirror",
    sourceSha: srcSha,
    sourceMtimeMs: srcMtime,
    size,
    syncedAt: nowIso(),
  };
  return DRY ? "planned" : "wrote";
}

// ── ggcoder: prompt commands ─────────────────────────────────────────
function syncPromptCommands() {
  if (!existsSync(join(GGCODER_CORE, "prompt-commands.js"))) return 0;
  const src = readFileSync(join(GGCODER_CORE, "prompt-commands.js"), "utf-8");
  const entries = [];
  const startRegex = /\{\s*name:\s*"([a-z0-9_-]+)"\s*,[\s\S]*?prompt:\s*`/g;
  let m;
  while ((m = startRegex.exec(src)) !== null) {
    const block = m[0];
    const descMatch = /description:\s*"([^"]*)"/.exec(block);
    const name = m[1];
    const description = descMatch ? descMatch[1] : "";
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") depth--;
      i++;
    }
    const prompt = src.slice(m.index + m[0].length, i - 1);
    entries.push({ name, description, prompt });
  }
  let count = 0;
  for (const e of entries) {
    const fm = `---\nname: ${e.name}\ndescription: ${e.description}\n---\n\n${e.prompt.trim()}\n`;
    trackExtract(
      join(GGCODER_CORE, "prompt-commands.js"),
      join(OUT_COMMANDS, `${e.name}.md`),
      "ggcoder",
      fm
    );
    count++;
  }
  return count;
}

// ── ggcoder: bundled agents ──────────────────────────────────────────
function syncBundledAgents() {
  const agentsJs = join(GGCODER_CORE, "agents.js");
  if (!existsSync(agentsJs)) return 0;
  const src = readFileSync(agentsJs, "utf-8");
  const start = src.indexOf("export const BUNDLED_AGENTS = [");
  if (start === -1) return 0;
  const end = src.indexOf("];", start) + 1;
  const arr = src.slice(start, end);
  const entries = [];
  const itemRegex = /name:\s*"([a-z0-9_-]+)"[\s\S]*?systemPrompt:\s*([A-Z_]+)\s*,/g;
  let m;
  while ((m = itemRegex.exec(arr)) !== null) {
    const block = arr.slice(m.index, m.index + 400);
    const descMatch = /description:\s*"([^"]*)"/.exec(block);
    const toolsMatch = /tools:\s*\[([^\]]*)\]/.exec(block);
    const [, name, promptVar] = m;
    const description = descMatch ? descMatch[1] : "";
    const toolsStr = toolsMatch ? toolsMatch[1] : "[]";
    const tools = toolsStr
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const promptDecl = new RegExp(`const\\s+${promptVar}\\s*=\\s*\``, "g");
    const pm = promptDecl.exec(src);
    if (!pm) continue;
    let i = pm.index + pm[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === "`") depth--;
      i++;
    }
    const body = src.slice(pm.index + pm[0].length, i - 1);
    entries.push({ name, description, tools, body });
  }
  let count = 0;
  for (const e of entries) {
    const fm = `---\nname: ${e.name}\ndescription: ${e.description}\ntools: ${JSON.stringify(e.tools)}\n---\n\n${e.body.trim()}\n`;
    trackExtract(agentsJs, join(OUT_AGENTS, `${e.name}.md`), "ggcoder", fm);
    count++;
  }
  return count;
}

// ── ggcoder: hook prompts ────────────────────────────────────────────
function syncHookPrompts() {
  const hooks = [
    { file: "ideal-review.js", consts: ["IDEAL_REVIEW_PROMPT", "LOOP_BREAK_FINAL_PROMPT"] },
    { file: "loop-breaker.js", consts: ["LOOP_BREAK_PROMPT"] },
    { file: "regrounding.js", consts: [] },
    { file: "autopilot-cycle.js", consts: ["AUTOPILOT_INJECTION_PREAMBLE"] },
    { file: "autopilot-verdict.js", consts: ["AUTOPILOT_VERDICT_PROMPT"] },
  ];
  let count = 0;
  for (const { file, consts } of hooks) {
    const path = join(GGCODER_CORE, file);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, "utf-8");
    for (const c of consts) {
      let body = null;
      const tmplRe = new RegExp(`export const ${c}\\s*=\\s*\``, "g");
      const tmplM = tmplRe.exec(src);
      if (tmplM) {
        let i = tmplM.index + tmplM[0].length;
        let depth = 1;
        body = "";
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === "\\" && i + 1 < src.length) {
            const next = src[i + 1];
            if (next === "`") body += "`";
            else if (next === "\\") body += "\\";
            else body += "\\" + next;
            i += 2;
            continue;
          }
          if (ch === "`") {
            depth--;
            i++;
            continue;
          }
          body += ch;
          i++;
        }
      } else {
        const strRe = new RegExp(`export const ${c}\\s*=\\s*([\\s\\S]*?);`, "g");
        const sm = strRe.exec(src);
        if (sm) {
          const concat = sm[1];
          const stringChunks = [...concat.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
          body = stringChunks
            .map((s) =>
              s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
                String.fromCharCode(parseInt(h, 16))
              )
            )
            .join("");
        }
      }
      if (body == null) continue;
      const fm = `---\nname: ${c.toLowerCase()}\ndescription: Extracted from gg-coder ${file}\n---\n\n${body.trim()}\n`;
      trackExtract(path, join(OUT_PROMPTS, `${c.toLowerCase()}.md`), "ggcoder", fm);
      count++;
    }
  }
  return count;
}

// ── ggcoder: style packs ─────────────────────────────────────────────
function syncStylePacks() {
  const path = join(GGCODER_CORE, "style-packs/packs.js");
  if (!existsSync(path)) return 0;
  const src = readFileSync(path, "utf-8");
  const start = src.indexOf("export const PACKS = {");
  if (start === -1) return 0;
  const objBody = src.slice(start);
  const entries = [];
  const re = /^\s{4}([a-z]+):\s*`([\s\S]*?)`\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(objBody)) !== null) {
    entries.push({ lang: m[1], body: m[2] });
  }
  if (!DRY) mkdirSync(join(OUT_DEFAULTS, "style-packs"), { recursive: true });
  let count = 0;
  for (const e of entries) {
    const fm = `---\nname: ${e.lang}\ndescription: Style pack for ${e.lang} (from gg-coder)\n---\n\n${e.body.trim()}\n`;
    trackExtract(
      path,
      join(OUT_DEFAULTS, "style-packs", `${e.lang}.md`),
      "ggcoder",
      fm
    );
    count++;
  }
  return count;
}

// ── ggcoder: bundled skills ──────────────────────────────────────────
function syncBundledSkills() {
  const skillsSrc = join(GGCODER_PKG, "assets/skills");
  if (!existsSync(skillsSrc)) return 0;
  let count = 0;
  for (const name of readdirSync(skillsSrc)) {
    const skillMd = join(skillsSrc, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    trackMirror(skillMd, join(OUT_SKILLS, `${name}.md`), "ggcoder");
    count++;
  }
  return count;
}

// ── gg-framework: file mirror ────────────────────────────────────────
// Mirrors skills/, commands/, plans/, reviews/ from the gg-framework
// package into .gg/framework/<subdir>/. Each file is mirrored verbatim.
function syncFramework() {
  for (const sub of FRAMEWORK_SUBDIRS) {
    const src = join(GG_FRAMEWORK_PKG, sub);
    if (!existsSync(src)) continue;
    const dst = join(OUT_FRAMEWORK, sub);
    mirrorDir(src, dst, "gg-framework");
  }
}

function mirrorDir(srcDir, dstDir, source) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(src, dst, source);
    } else if (entry.isFile()) {
      trackMirror(src, dst, source);
    }
  }
}

// ── Prune ────────────────────────────────────────────────────────────
// Walks the output roots for each source, removes files that are not
// in the manifest. Refuses if manifest is missing or older than 24h.
function pruneOrphans() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error("sync-ggcoder: --prune requires an existing manifest at .gg/.sync-manifest.json");
    process.exit(1);
  }
  const manifestMtime = fileMtimeMs(MANIFEST_PATH);
  const ageMs = Date.now() - manifestMtime;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours > 24) {
    console.error(
      `sync-ggcoder: --prune refused — manifest is ${ageHours.toFixed(1)}h old (>24h). Re-run sync first to refresh.`
    );
    process.exit(1);
  }

  const pruned = [];

  for (const source of VALID_SOURCES) {
    if (SOURCE_FILTER && SOURCE_FILTER !== source) continue;
    const roots =
      source === "ggcoder" ? GGCODER_OUTPUT_DIRS : [OUT_FRAMEWORK];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      walkAndPrune(root, source, pruned);
    }
  }

  if (DRY) {
    for (const p of pruned) console.log(`  would prune: ${p.rel}`);
    console.log(`sync-ggcoder: --prune would remove ${pruned.length} orphan files`);
  } else {
    for (const p of pruned) unlinkSync(p.abs);
    console.log(`sync-ggcoder: --prune removed ${pruned.length} orphan files`);
  }
}

function walkAndPrune(absDir, source, pruned) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkAndPrune(abs, source, pruned);
    } else if (entry.isFile()) {
      const rel = relative(REPO_ROOT, abs);
      // The manifest itself lives under .gg/ but is not a synced file.
      if (rel === ".gg/.sync-manifest.json") continue;
      const entry_ = manifest.files[rel];
      // Keep files belonging to a different source (so --source X --prune
      // doesn't blow away the other source's files).
      if (entry_ && entry_.source !== source) continue;
      if (!entry_) {
        pruned.push({ rel, abs });
      }
    }
  }
}

// ── Logging ──────────────────────────────────────────────────────────
function logSourceSummary(source) {
  const s = stats[source];
  if (s.files === 0) return;
  const skippedNote = s.skipped > 0 ? ` (${s.skipped} unchanged)` : "";
  const mode = DRY ? "planned" : "synced";
  console.log(
    `  ${source}: ${mode} ${s.files} file${s.files === 1 ? "" : "s"}, ${fmtBytes(s.bytes)}${skippedNote}`
  );
}

// ── Per-source top-level ─────────────────────────────────────────────
function syncGgcoder() {
  if (!sourceInstalled(GGCODER_PKG)) {
    console.log(`sync-ggcoder: ggcoder not installed at ${GGCODER_PKG} — skipping`);
    return false;
  }
  const ver = sourceVersion(GGCODER_PKG);
  syncPromptCommands();
  syncBundledAgents();
  syncHookPrompts();
  syncStylePacks();
  syncBundledSkills();
  if (!DRY) {
    mkdirSync(dirname(VERSION_FILE), { recursive: true });
    writeFileSync(VERSION_FILE, ver + "\n");
  }
  manifest.sources.ggcoder = { version: ver, syncedAt: nowIso() };
  logSourceSummary("ggcoder");
  return true;
}

function syncGgFramework() {
  if (!sourceInstalled(GG_FRAMEWORK_PKG)) {
    console.log(
      `sync-ggcoder: gg-framework not installed at ${GG_FRAMEWORK_PKG} — skipping`
    );
    return false;
  }
  const ver = sourceVersion(GG_FRAMEWORK_PKG);
  syncFramework();
  manifest.sources["gg-framework"] = { version: ver, syncedAt: nowIso() };
  logSourceSummary("gg-framework");
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────
function main() {
  manifest = loadManifest();

  // If --prune was requested, validate the manifest BEFORE syncing.
  // Otherwise a fresh sync would create the manifest and bypass the check.
  if (PRUNE) {
    if (!existsSync(MANIFEST_PATH)) {
      console.error("sync-ggcoder: --prune requires an existing manifest at .gg/.sync-manifest.json");
      process.exit(1);
    }
    const manifestMtime = fileMtimeMs(MANIFEST_PATH);
    const ageMs = Date.now() - manifestMtime;
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 24) {
      console.error(
        `sync-ggcoder: --prune refused — manifest is ${ageHours.toFixed(1)}h old (>24h). Re-run sync first to refresh.`
      );
      process.exit(1);
    }
  }

  if (SOURCE_FILTER === "ggcoder") {
    syncGgcoder();
  } else if (SOURCE_FILTER === "gg-framework") {
    syncGgFramework();
  } else {
    syncGgcoder();
    syncGgFramework();
  }

  // Save manifest if anything was touched.
  if (!DRY || stats.ggcoder.files > 0 || stats["gg-framework"].files > 0) {
    saveManifest(manifest);
  }

  // Summary line — file count + bytes per source.
  if (stats.ggcoder.files === 0 && stats["gg-framework"].files === 0) {
    console.log(
      `sync-ggcoder: nothing to do${DRY ? " (dry-run)" : ""} — all sources up to date`
    );
  } else {
    const totalFiles = stats.ggcoder.files + stats["gg-framework"].files;
    const totalBytes = stats.ggcoder.bytes + stats["gg-framework"].bytes;
    console.log(
      `sync-ggcoder: ${DRY ? "would sync" : "synced"} ${totalFiles} files, ${fmtBytes(totalBytes)} total`
    );
  }

  if (PRUNE) {
    pruneOrphans();
  }

  return 0;
}

// Only run main() when invoked directly, not when imported.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  process.exit(main());
}

export {
  loadManifest,
  saveManifest,
  sha256File,
  fileMtimeMs,
  trackExtract,
  trackMirror,
  mirrorDir,
  syncGgcoder,
  syncGgFramework,
  syncFramework,
  syncPromptCommands,
  syncBundledAgents,
  syncHookPrompts,
  syncStylePacks,
  syncBundledSkills,
  pruneOrphans,
  main,
  // path constants (re-exported for tests)
  MANIFEST_PATH,
  REPO_ROOT,
  GGCODER_PKG,
  GGCODER_CORE,
  GG_FRAMEWORK_PKG,
  OUT_FRAMEWORK,
  FRAMEWORK_SUBDIRS,
  OUT_COMMANDS,
  OUT_AGENTS,
  OUT_SKILLS,
  OUT_PROMPTS,
  OUT_DEFAULTS,
  GGCODER_OUTPUT_DIRS,
  VERSION_FILE,
};
