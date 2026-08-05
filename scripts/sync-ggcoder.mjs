#!/usr/bin/env node
// sync-ggcoder.mjs — auto-sync gg-coder built-in capabilities into CorePrt.
//
// Detects installed ggcoder version, compares against stored version. If
// changed, extracts every syncable artifact per docs/gg-coder-inventory.md
// and writes them into agents/_lib/.gg/, agents/_lib/.ggcoder-prompts/, and
// agents/_lib/.ggcoder-defaults/.
//
// Idempotent — re-running with no version change exits 0.
//
// Usage:
//   node scripts/sync-ggcoder.mjs                # sync if version changed
//   node scripts/sync-ggcoder.mjs --force        # always sync
//   node scripts/sync-ggcoder.mjs --dry-run      # show what would sync

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GGCODER_PKG = "/Users/gogetta/.npm-global/lib/node_modules/@kenkaiiii/ggcoder";
const GGCODER_CORE = join(GGCODER_PKG, "dist/core");
const VERSION_FILE = join(REPO_ROOT, "agents/_lib/.ggcoder-version");

const OUT_COMMANDS = join(REPO_ROOT, "agents/_lib/.gg/commands");
const OUT_AGENTS = join(REPO_ROOT, "agents/_lib/.gg/agents");
const OUT_SKILLS = join(REPO_ROOT, "agents/_lib/.gg/skills");
const OUT_PROMPTS = join(REPO_ROOT, "agents/_lib/.ggcoder-prompts");
const OUT_DEFAULTS = join(REPO_ROOT, "agents/_lib/.ggcoder-defaults");

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const DRY = args.has("--dry-run");

function readInstalledVersion() {
  const pkg = JSON.parse(readFileSync(join(GGCODER_PKG, "package.json"), "utf-8"));
  return pkg.version;
}

function readStoredVersion() {
  try {
    return readFileSync(VERSION_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

function ensureDir(p) {
  if (!DRY) mkdirSync(p, { recursive: true });
}

function writeOut(path, content) {
  if (DRY) return;
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

function frontmatter(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

// ── PHASE 1: PROMPT-COMMANDS ─────────────────────────────────
// Parse dist/core/prompt-commands.js for `name:` / `prompt:` / `description:`
// entries. Each entry is a `{ name, description, prompt }` literal.
function syncPromptCommands() {
  const src = readFileSync(join(GGCODER_CORE, "prompt-commands.js"), "utf-8");
  // Each entry is { name: "x", description: "...", prompt: `...` }.
  // Split by top-level `{ name:` and walk through.
  const entries = [];
  const startRegex = /\{\s*name:\s*"([a-z0-9_-]+)"\s*,[\s\S]*?prompt:\s*`/g;
  let m;
  while ((m = startRegex.exec(src)) !== null) {
    // Extract description from the matched block
    const block = m[0];
    const descMatch = /description:\s*"([^"]*)"/.exec(block);
    const name = m[1];
    const description = descMatch ? descMatch[1] : "";
    // Find the matching closing backtick (template literal)
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") depth--;
      i++;
    }
    const prompt = src.slice(m.index + m[0].length, i - 1);
    entries.push({ name, description, prompt });
  }
  let count = 0;
  for (const e of entries) {
    writeOut(join(OUT_COMMANDS, `${e.name}.md`), frontmatter(e.name, e.description, e.prompt));
    count++;
  }
  return count;
}

// ── PHASE 2: BUNDLED-AGENTS ─────────────────────────────────
// dist/core/agents.js exports BUNDLED_AGENTS = [{ name, description, tools,
// systemPrompt, source }]. The systemPrompt is a template-literal constant
// like AUDITOR_PROMPT = `...`. We extract by `name:` matching inside the array.
function syncBundledAgents() {
  const src = readFileSync(join(GGCODER_CORE, "agents.js"), "utf-8");
  // Find the BUNDLED_AGENTS array bounds.
  const start = src.indexOf("export const BUNDLED_AGENTS = [");
  if (start === -1) return 0;
  const end = src.indexOf("];", start) + 1;
  const arr = src.slice(start, end);
  const entries = [];
  // Match each { name: "x", ... systemPrompt: VAR, source: "bundled" } block.
  // Allow optional `aliases: [...]` between name and description.
  const itemRegex = /name:\s*"([a-z0-9_-]+)"[\s\S]*?systemPrompt:\s*([A-Z_]+)\s*,/g;
  let m;
  while ((m = itemRegex.exec(arr)) !== null) {
    const block = arr.slice(m.index, m.index + 400);
    const descMatch = /description:\s*"([^"]*)"/.exec(block);
    const toolsMatch = /tools:\s*\[([^\]]*)\]/.exec(block);
    const [, name, promptVar] = m;
    const description = descMatch ? descMatch[1] : "";
    const toolsStr = toolsMatch ? toolsMatch[1] : "[]";
    const tools = toolsStr.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    // Look up the prompt variable body
    const promptDecl = new RegExp(`const\\s+${promptVar}\\s*=\\s*\``, "g");
    const pm = promptDecl.exec(src);
    if (!pm) continue;
    let i = pm.index + pm[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") depth--;
      i++;
    }
    const body = src.slice(pm.index + pm[0].length, i - 1);
    entries.push({ name, description, tools, body });
  }
  let count = 0;
  for (const e of entries) {
    const fm = `---\nname: ${e.name}\ndescription: ${e.description}\ntools: ${JSON.stringify(e.tools)}\n---\n\n${e.body.trim()}\n`;
    writeOut(join(OUT_AGENTS, `${e.name}.md`), fm);
    count++;
  }
  return count;
}

// ── PHASE 3: IDEAL-REVIEW / LOOP-BREAKER / REGROUNDING PROMPTS ─────
// Each is exported as a constant string. We extract by regex.
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
      // Two shapes supported:
      //   export const NAME = `...`
      //   export const NAME = "..." + "..." + "..."
      // Also handles `\u2014` and similar escape sequences in the string body.
      let body = null;
      // Template-literal form
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
          if (ch === "`") { depth--; i++; continue; }
          body += ch;
          i++;
        }
      } else {
        // Concatenated-string form: extract every "..." chunk between NAME = and the trailing semicolon.
        const strRe = new RegExp(`export const ${c}\\s*=\\s*([\\s\\S]*?);`, "g");
        const sm = strRe.exec(src);
        if (sm) {
          const concat = sm[1];
          const stringChunks = [...concat.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
          body = stringChunks
            .map((s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))))
            .join("");
        }
      }
      if (body == null) continue;
      writeOut(join(OUT_PROMPTS, `${c.toLowerCase()}.md`), frontmatter(c.toLowerCase(), `Extracted from gg-coder ${file}`, body));
      count++;
    }
  }
  return count;
}

// ── PHASE 4: STYLE-PACKS ─────────────────────────────────
// style-packs/packs.js exports PACKS = { typescript: "...", ... }. 25 entries.
function syncStylePacks() {
  const path = join(GGCODER_CORE, "style-packs/packs.js");
  if (!existsSync(path)) return 0;
  const src = readFileSync(path, "utf-8");
  // Match `key: \`...\`` blocks at top level of the PACKS object.
  const start = src.indexOf("export const PACKS = {");
  if (start === -1) return 0;
  const objBody = src.slice(start);
  const entries = [];
  const re = /^\s{4}([a-z]+):\s*`([\s\S]*?)`\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(objBody)) !== null) {
    entries.push({ lang: m[1], body: m[2] });
  }
  ensureDir(join(OUT_DEFAULTS, "style-packs"));
  let count = 0;
  for (const e of entries) {
    writeOut(join(OUT_DEFAULTS, "style-packs", `${e.lang}.md`), frontmatter(e.lang, `Style pack for ${e.lang} (from gg-coder)`, e.body));
    count++;
  }
  return count;
}

// ── PHASE 5: BUNDLED SKILLS ─────────────────────────────────
// assets/skills/* — copy verbatim from gg-coder/assets/skills/
function syncBundledSkills() {
  const skillsSrc = join(GGCODER_PKG, "assets/skills");
  if (!existsSync(skillsSrc)) return 0;
  let count = 0;
  for (const name of readdirSync(skillsSrc)) {
    const skillMd = join(skillsSrc, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const body = readFileSync(skillMd, "utf-8");
    writeOut(join(OUT_SKILLS, `${name}.md`), body);
    count++;
  }
  return count;
}

// ── Main ─────────────────────────────────────────────────
function main() {
  const installed = readInstalledVersion();
  const stored = readStoredVersion();
  if (!FORCE && installed === stored) {
    console.log(`gg-coder ${installed} already in sync. Use --force to override.`);
    return 0;
  }
  console.log(`gg-coder ${stored ?? "(unset)"} → ${installed}${DRY ? " (dry-run)" : ""}`);

  ensureDir(OUT_COMMANDS);
  ensureDir(OUT_AGENTS);
  ensureDir(OUT_SKILLS);
  ensureDir(OUT_PROMPTS);
  ensureDir(OUT_DEFAULTS);

  const c1 = syncPromptCommands();
  const c2 = syncBundledAgents();
  const c3 = syncHookPrompts();
  const c4 = syncStylePacks();
  const c5 = syncBundledSkills();

  if (!DRY) writeFileSync(VERSION_FILE, installed + "\n");

  console.log(`synced ${c1} commands, ${c2} agents, ${c3} hook prompts, ${c4} style packs, ${c5} skills`);
  return 0;
}

process.exit(main());
