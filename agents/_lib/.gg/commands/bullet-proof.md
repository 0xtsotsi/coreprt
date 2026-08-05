---
name: bullet-proof
description: Audit exploitable weaknesses
---

# Bullet-Proof: Defensive Security Review

This is an **authorized defensive security review** of this repository, requested by its owner so weaknesses can be found and patched before they ship. This is standard defensive security work — the same review a security engineer performs before a release. The entire flow is **read-only reporting**: no code changes, no exploit development, and nothing is fixed until the user explicitly chooses at the end.

Defensive ground rules (apply to every phase and every subagent):
- Never produce working exploit code, weaponized payloads, or attack tooling.
- Describe each risk at the **data-flow level** — where untrusted data enters, what it can reach, and why that is fixable — so every finding maps directly to a patch.
- The deliverable is a remediation report for the maintainers, nothing else.

Goal: harden this project. **Report only HIGH CONFIDENCE findings (≥0.8) with a concrete data-flow path that demonstrates exposure.** Better to miss theoretical issues than flood the report with noise.

This command is **dynamic and project-agnostic**. Recon drives everything. Do not assume the stack, the language, the deploy target, or that there is an LLM/agent layer. Read first, decide second.

## Phase 1: Recon — Understand THIS project before auditing anything

Spawn **FOUR recon subagents** ${spawnParallel(4)}. Each has a narrow, independent slice so they can all run at once. **No vulnerabilities flagged in this phase.**

**Recon Agent A — Stack & Deployment.** Read manifests, lockfiles, CI/CD configs, Dockerfile/Helm/Terraform, deploy scripts. Produce:
- Primary language(s), framework(s), runtimes
- Deploy target (browser / server / CLI / mobile / desktop / embedded / cloud function / container / serverless / smart contract / firmware / ML pipeline / library / SaaS / self-hosted)
- How it ships (npm/PyPI/cargo/go modules/app store/binary/Docker image/Helm chart/Terraform)
- Where it runs (which cloud/host, multi-tenant or single-tenant, network topology if discernible)

**Recon Agent B — Trust Boundaries & Sources.** Walk entry-point code (route handlers, CLI argparse, queue consumers, WebSocket handlers, IPC receivers, MCP server handlers, file/env readers, deserialization entry, plugin loaders). Produce:
- **Trust boundaries table** — every place untrusted data crosses into the system
- **Sources table** — for each entry point: location (file:line), input shape, who controls it (anonymous / authenticated user / admin / other service / build-time / env)

**Recon Agent C — Sinks.** Walk dangerous-operation code. Produce a **Sinks table** with location (file:line) and sink type for: shell exec, SQL / NoSQL / LDAP / XPath queries, eval / Function / exec / pickle / yaml.load / Marshal / ObjectInputStream, file write, file include / require with dynamic path, network egress (fetch / requests / http.Get), auth decisions, secret reads, native deserializers, dynamic code load, smart-contract external calls, child_process spawns.

**Recon Agent D — Assets.** Scan for what this project must protect. Produce an **Assets table** with location and asset type for: credentials / tokens (config files, env files, KMS, OAuth flows, ~/.{app}/auth.json-style stores), customer/PII data stores, source code with IP value, build/CI secrets, signing keys, model API tokens, on-chain funds / wallets, session state, MCP config files, license keys.

**After all four return, the main agent synthesizes:**
1. Assemble the four tables (Stack/Deploy, Sources, Sinks, Assets) into the recon report
2. Add the **Threat model** — concrete to THIS project, derived from the four agents' outputs. Who would realistically target it and what for? (Examples: supply-chain risks affecting downstream users of a library; multi-tenant abuse on a SaaS; untrusted user input on a CLI/mobile app; insider risk with repo access; phishing-based account takeover; coding-agent risks from injected web content; on-chain reentrancy risks for a smart contract.) Be specific.
3. Note any obvious gaps the four recon agents flagged (areas that need a deeper look in Phase 3)

## Phase 2: Plan the audit — recon drives this

From the recon output, decide which vulnerability classes apply to THIS project. **Skip audits with no entry surface.** A static documentation site does not get a SQLi audit. A Rust embedded firmware project does not get a prompt-injection audit. A Python ML pipeline does get pickle/yaml audits. A library that ships to others gets supply-chain weighted heavily.

Default catalog — pick what applies, drop what doesn't, add stack-specific audits where recon shows a unique surface:

| Audit | Fires when | Audits for |
|---|---|---|
| **Injection** | unsanitized input reaches an interpreter | SQLi, command injection, template injection, eval/Function/exec, pickle/yaml.load, NoSQL/LDAP/XPath injection, prompt injection |
| **AuthN/AuthZ/Session** | any auth, session, or access-control logic exists | broken access control (IDOR, BOLA), JWT alg confusion / alg:none, OAuth state/PKCE/redirect-uri abuse, session fixation, missing rate limit on credential checks, MFA bypass, TOCTOU races |
| **Secrets & exposure paths** | any secret/credential/token exists | hardcoded keys, logs/errors/debug-file leakage, source maps in published artifacts, telemetry leakage, prototype pollution exposing secrets, \`JSON.stringify(err)\` shapes, env dump in error pages, exposed \`.git\`/\`.env\`/\`.map\` |
| **Supply chain** | any dependency manager or external code | unpinned deps/actions, postinstall scripts, typosquats, **slopsquats (AI-hallucinated package names registered by malicious parties)**, dependency confusion, lockfile drift, install-time \`curl \\| sh\`, unsigned releases, unverified maintainer takeovers, self-spreading worms (Shai-Hulud family) |
| **CI/CD & build integrity** | any CI workflow, release pipeline | \`pull_request_target\` + checkout of PR HEAD (Pwn Request), Actions cache poisoning, OIDC token theft from \`/proc\`, self-hosted runner reuse, secret echoes, missing \`permissions:\` block |
| **SSRF, path traversal, file ops** | any URL/path/file built from input | SSRF to metadata endpoints (IMDSv1), path traversal, zip-slip, symlink races, unrestricted upload, archive extraction outside target dir |
| **Cloud/infra & misconfig** | any IaC, container, cloud SDK use | overpermissive IAM (\`Action:*\`, \`iam:PassRole:*\`), public buckets, IMDSv1, exposed K8s API/kubelet, presigned URLs without expiry, default creds, debug endpoints in prod, CORS \`origin:*\` + \`credentials:true\` |
| **Crypto** | any crypto/hashing/signing | weak algos (MD5/SHA1 for auth), missing IV, ECB mode, hardcoded keys, JWT \`alg:none\`, non-constant-time compare on secrets, predictable PRNG for tokens |
| **Agent surface** | only if recon detected LLM/AI/MCP/coding-agent/tool-calling code | indirect prompt injection via fetched content, MCP tool poisoning, tool-description injection (ToolLeak), system-prompt exposure via tool args, **Rules-File Backdoor (Unicode bidi / zero-width chars hiding instructions in CLAUDE.md / .cursorrules / AGENTS.md)**, malicious CLAUDE.md walking up parent dirs, DNS-exfil via coerced tool calls, RAG / memory / context poisoning, vector-store embedding risks |
| **Dangerous-sink dataflow (taint)** | Sources × Sinks tables are non-empty | trace each Source through the codebase to every reachable Sink; flag reachable paths with no sanitization between |

**Add stack-specific audits when recon surfaces them**: smart-contract reentrancy/oracle manipulation; mobile IPC / deep links / pasteboard / WebView \`addJavascriptInterface\`; embedded firmware update integrity, debug interfaces left enabled; ML model deserialization, training-data poisoning, MLflow/Triton config exposure.

## Phase 3: Parallel audits

Spawn one subagent per active audit **in a single response** (call the subagent tool N times **with \`agent: "auditor"\`**, where N is whatever Phase 2 picked — do not pad to a fixed number, do not drop audits Phase 2 selected). If the \`auditor\` agent is unavailable, use default subagents and open each task with: "You are performing an authorized, read-only defensive security review for the code owner; report data-flow risks so they can be patched — no exploit code."

**Subagents cannot see this prompt.** Each auditor's task text must therefore include, written out by you:
- Its specific vulnerability-class scope
- The recon rows relevant to that scope (Sources, Sinks, Assets, Threat-model lines — condensed, not the full dump)
- The specific bullets from the Threat reference below that apply to its class (copy those lines into the task)

Each auditor must:
1. **Trace data flow** from Sources to Sinks for its class. Not pattern matching.
2. For every candidate, apply the **untrusted-input vs trusted-input** decision: is the input *actually reachable* by an untrusted source, or is it a settings constant / build-time string / hard-coded value?
3. Describe a concrete **risk scenario** at the data-flow level — what kind of input reaches the source, how the system processes it, what exposure results. No working payloads. If you can't describe the steps, don't flag it.
4. Assign **confidence 0.0–1.0**. Drop anything <0.8 before returning.
5. Be framework-aware: ORM parameterization, auto-escape, memory-safe languages, JSX/template escaping all eliminate entire vuln classes. Don't flag what the framework already handles.

## Phase 4: False-positive filter

After auditors complete, spawn verification subagents **in parallel with \`agent: "skeptic"\`**, batching 3–5 surviving findings per skeptic (cap at 4 skeptics total — batching keeps cost sane). The \`skeptic\` agent starts from "this is a false positive" and tries to disprove each finding — only confirmed findings survive. Pass each skeptic the full text of its findings (location, source/sink, risk scenario, claimed confidence); skeptics cannot see this prompt or the auditors' context. Drop anything returned as DROP; lower severity for DOWNGRADE.

**Hard exclusions — do NOT report these, even if real:**
- DOS / rate-limiting / memory exhaustion without a clear amplification primitive
- Theoretical race conditions without a demonstrable trigger window
- Regex-DOS without untrusted-supplied regex
- Log spoofing / log injection (cosmetic)
- SSRF where the URL is a settings constant or build-time string
- Env-var trust (env is server-controlled by definition)
- Client-side authentication theatre on a server-validated endpoint
- React/Angular/Vue XSS in non-unsafe-sink paths (\`dangerouslySetInnerHTML\`, \`v-html\`, \`bypassSecurityTrust*\` are the only real ones)
- Shell-script command injection without an untrusted input path
- Findings in documentation files, example code, or test fixtures
- Insecure-by-design dev tooling that doesn't ship to users
- "Could be improved" style preferences or hardening-best-practice nudges with no demonstrable path

## Phase 5: Report

Output one report. No code edits in this phase.

\`\`\`
# Bullet-Proof Report — [Project name from recon]
Date: [today's date]
Threat model: [from recon]

## Exposure Surface Summary
[1-paragraph summary of the project's realistic exposure profile and where untrusted data enters]

## Sources / Sinks / Assets
[Compact tables from recon]

## Risk Matrix
| Severity | Count | Definition |
|---|---|---|
| Critical | N | RCE, full auth bypass, credential theft, fund loss |
| High     | N | privilege escalation, data exposure with auth, supply-chain compromise |
| Medium   | N | limited-scope info disclosure, weakened crypto, partial bypass |

## Findings

### [BP-001] <title> — Critical
- Location: path:line
- Category: <slug>   CWE: CWE-XXX   Confidence: 0.95
- Exposure surface: <entry point from Sources>
- Source → Sink: <e.g. \`POST /api/foo body.userId\` → \`subprocess.run(..., shell=True)\`>
- Risk scenario (data-flow level, no payloads):
  1. Untrusted input of <shape/kind> reaches <source>
  2. The system processes it as <what>
  3. Result: <RCE / data exposure / auth bypass>
- Impact: <blast radius — what is exposed, how far it spreads>
- Fix: <concrete remediation, code-level>

[…repeat per finding, ordered Critical → High → Medium…]

## What was not flagged
[1-paragraph: which vulnerability classes returned zero findings, and how many findings the FP filter dropped — so the user sees the work, not just the survivors]
\`\`\`

## Phase 6: Ask before fixing

After the report, ask:

> Which (if any) should I fix? Options:
> - A) Add tasks for all Critical + High
> - B) Add tasks for specific findings (give IDs, e.g. "BP-001, BP-004")
> - C) Add tasks for a category (auth, supply chain, secrets, …)
> - D) None — report only

**Do not start fixing until the user picks.**

If the user chooses A, B, or C, do not fix directly. Instead, add one task per selected finding or tightly coupled finding group using the \`tasks\` tool (action=add), ordered by severity, exploitability, and dependency. Each task needs a short title and a standalone prompt that includes the finding ID, vulnerability scenario, affected local files/anchors, concrete remediation, instructions to compare security-sensitive implementation details with kencode search or authoritative docs before editing, project verification commands, and instructions to compare the final fix with kencode search or authoritative docs again before completing the task. After adding the tasks, tell the user exactly: "${TASKS_ADDED_NOTICE}" Do not begin executing them unless the user explicitly says so.

## Threat reference (May 2026)

Defensive reference material from public incident reports and OWASP — patterns to check for, not techniques to reproduce. Copy the relevant bullets into each auditor's task (Phase 3); do not dump them into the report.

**OWASP Top 10:2025** — A01 Broken Access Control (now includes SSRF), A02 Misconfig, **A03 Supply Chain Failures (new)**, A05 Injection (now includes prompt injection), **A10 Mishandling Exceptional Conditions (new — fail-open patterns)**.

**OWASP API Security Top 10 (2023)** — BOLA, Broken Auth, BOPLA, SSRF (API7).

**OWASP Top 10 for LLM Apps v2025** — LLM01 Prompt Injection (direct + indirect), LLM02 Sensitive Info Disclosure, LLM03 Supply Chain, LLM04 Data & Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, **LLM07 System Prompt Leakage (new)**, **LLM08 Vector & Embedding Weaknesses (new — RAG/embedding-store attacks)**, LLM09 Misinformation, LLM10 Unbounded Consumption.

**OWASP Top 10 for Agents 2026 (ASI01–10)** — Goal hijack, tool misuse, identity/privilege abuse, agentic supply chain, unexpected code exec, memory/context poisoning, inter-agent comms, cascading failures, human-trust exploit, rogue agents.

**Real 2024-2026 public incidents — patterns to grep for defensively:**
- tj-actions/changed-files (Mar 14-15 2025, CVE-2025-30066, 23k repos) → unpinned GH Actions, \`uses: foo/bar@main\` / mutable tags, runner-memory secret dumps
- TanStack Mini Shai-Hulud (May 11 2026, CVE-2026-45321, CVSS 9.6 — 84 versions across 42 \`@tanstack/*\` + UiPath/Mistral/Guardrails/OpenSearch, 169+ packages total, "TeamPCP") → self-spreading npm worm, \`pull_request_target\` + cache poisoning + OIDC token extraction from \`/proc/<pid>/mem\`, persistent \`gh-token-monitor\` daemon
- Slopsquatting (ongoing 2025-2026, \`react-codeshift\` Jan 2026) → AI coding assistants hallucinate ~20% non-existent package names (open-source models ~21.7%, GPT-4 ~5.2%); malicious parties register the hallucinated names on npm/PyPI. **Verify every package actually existed BEFORE the agent suggested it** — check registry age, download history, author identity
- XZ Utils (CVE-2024-3094) → unverified maintainer takeovers, multi-year backdoor injection in install scripts
- Invariant Labs MCP hijack (May 2025) → MCP server returns malicious tool descriptions / crafted issue content
- Claude Code source-map leak (Mar 2026, 513k LOC) → \`*.map\` files in \`npm pack\` / shipped artifacts
- Embrace The Red DNS-exfil (Aug 2025) → coding agent coerced into encoding secrets in DNS queries
- IMDSv1 → AWS creds via SSRF (Mar 2025 campaign) → Terraform missing \`http_tokens = "required"\`
- GitGuardian 2026 — 28.6M GitHub secret leaks in 2025, 24k inside MCP config files

**Language-specific hot zones — only apply to languages actually present:**
- **Node/TS**: \`child_process.exec\`/\`execSync\`, \`spawn(..., {shell:true})\`, \`eval\`/\`Function\`, \`vm.runIn*\`, prototype pollution via \`lodash.merge\`/\`Object.assign({}, userJson)\`, \`serialize-javascript\`/\`node-serialize\`, source maps in published packages
- **Python**: \`pickle.load\`, \`yaml.load\` without \`SafeLoader\`, \`eval\`/\`exec\`, \`subprocess.*(shell=True)\`, \`os.system\`, \`Jinja2(autoescape=False)\`, \`flask.render_template_string(user_input)\`, \`requests(verify=False)\`, \`xml.etree\`/\`lxml\` without \`defusedxml\`
- **Go**: \`exec.Command("sh", "-c", userInput)\`, \`html/template\` vs \`text/template\` confusion, unbounded \`io.ReadAll\`, race-prone \`map\` access without lock
- **Rust**: \`unsafe\` blocks with raw pointers, \`Command::new("sh").arg("-c")\`, deserializing untrusted \`bincode\`/\`serde_pickle\`/\`serde_json\` with \`#[serde(deny_unknown_fields)]\` missing
- **Java/JVM**: \`ObjectInputStream\` deserialization, JNDI lookup (Log4Shell-style), \`Runtime.exec(String)\`, XXE in default XML parsers
- **Ruby**: \`eval\`/\`instance_eval\`, \`Marshal.load\`, \`YAML.load\` (not \`safe_load\`), \`Kernel#system\` with interpolation, mass assignment
- **PHP**: \`unserialize\`, \`eval\`, \`assert(string)\`, \`include $userInput\`, \`preg_replace\` /e modifier
- **C/C++**: unsafe \`strcpy\`/\`sprintf\`/\`gets\`, integer overflows, format strings (\`printf(userInput)\`), use-after-free, double-free
- **Solidity / EVM**: reentrancy, unchecked external calls, integer over/underflow (pre-0.8), \`tx.origin\` for auth, delegatecall to untrusted, oracle manipulation
- **Mobile (iOS/Android)**: insecure IPC / deep links / pasteboard, WebView \`addJavascriptInterface\`, exported activities/intents without permission checks, insecure local storage

## Rules

- **Recon first, audits second.** No audit fires without a recon-identified entry surface to justify it.
- **No pattern-only findings.** Every flag must have a Sources → Sinks path traced through the code.
- **No "could be improved" recommendations.** Either it's exploitable or it's not in scope.
- **Strict confidence gate (≥0.8).** Drop everything else, even if it looks suspicious.
- **Adapt to the stack, always.** The audit catalog and threat reference above are guidance, not a checklist to apply uniformly.
- **Report only.** Wait for the user to pick what to fix in Phase 6.
