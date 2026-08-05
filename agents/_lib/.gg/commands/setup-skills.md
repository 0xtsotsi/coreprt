---
name: setup-skills
description: Recommend useful skills
---

# Skills Audit: Find useful skills for this project

Analyze this project and recommend skills from the open ecosystem that would make **working on this project more efficient, easier, and safer**. That is the goal, full stop. Every recommendation must pass the test: does this skill save real time, lower real cognitive load, or prevent real mistakes for someone working on THIS project, repeatedly?

Ranked by real impact, not volume.

This project could be anything — a web app, a CLI, a mobile app, a game, firmware, a data pipeline, a library, a scientific tool. Do not assume a stack. Let the codebase tell you what it is, then decide what to look for.

## Phase 1: Understand what this project is

Read just enough to know what kind of project this is. Look at whichever signals actually apply:

- Build / manifest files: \`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`pubspec.yaml\`, \`Podfile\`, Xcode project, Gradle build, \`*.csproj\`, \`CMakeLists.txt\`, Unity/Unreal project files, Makefile — whatever exists.
- Any README, CLAUDE.md, or AGENTS.md.
- Top-level directory layout and obvious entry points.
- Any CI config, lockfile, or config directory that hints at workflow.

**Do NOT read source code yet.** You need only a coarse answer to: what kind of project is this, what platform/stack/language, what stage (greenfield vs mature), and what does the surrounding workflow look like (build, test, release, distribute, deploy — whatever applies for THIS project type).

## Phase 2: Decide which domains to investigate

Based on Phase 1, pick 4–6 domain slices that represent the **recurring work someone actually does on this project** — not abstract "areas of the codebase," but the real activities that eat time, attention, or trust. Do not use a fixed template. The right domains for a Rust CLI are different from an iOS app, a Unity game, a Django backend, a Kubernetes operator, or an ML notebook.

Illustrative only (not prescriptive):

- Web app → shipping features, API changes, handling data safely, deploys
- Mobile app → building screens, store releases, platform quirks, crash & accessibility triage
- CLI tool → adding commands, packaging & distribution, user-facing UX, error handling
- Game → adding content, platform ports, perf passes, build pipeline
- Library → designing public APIs, cutting releases, downstream compatibility, docs/examples
- Data / ML → running experiments, pipeline orchestration, reproducibility, serving models
- Embedded → adding peripherals, size/memory passes, flashing, hardware bring-up

**Announce your chosen domains to the user in one line before spawning agents**, so they can see what you're looking at (e.g. \`Domains: adding content, platform ports, perf passes, build pipeline\`).

## Phase 3: Parallel sweep

Spawn one sub-agent per domain you chose, ${spawnParallel("N")} — one task per domain. Each explores its assigned domain and returns skill-worthy opportunities.

**Skill-worthy means**: a recurring activity someone will do on THIS project — shipping, reviewing, migrating, debugging, onboarding, whatever applies — where a reusable instruction set would make it **faster** (efficient), **lower-effort** (easier), or **less likely to break something** (safer). The test is: will this skill save real time, reduce real cognitive load, or prevent real mistakes, repeatedly, on this project? If no, drop it. A domain returning zero candidates is a valid outcome.

Each sub-agent must return candidates in this exact shape, nothing else:

\`\`\`
[domain] — candidate title
Why: one sentence on the real friction observed in THIS project
Search terms: 2–3 keywords the parent should feed to find-skills
\`\`\`

Don't invent. Don't pad.

## Phase 4: Ecosystem search

After all sub-agents complete, use the **skill** tool to invoke the \`find-skills\` skill. Feed it the aggregated candidate list with search terms. Let find-skills drive discovery across skills.sh, vercel-labs/agent-skills, and anthropics/skills.

For each candidate, record the best 0–1 ecosystem match: skill name, source repo URL, and enough evidence from the skill README/source to prove it fits this project. If no fit exists, record "no match". **Do NOT install anything yet.**

## Phase 5: Prioritized recommendation

Rank every candidate that returned a real match by **crucial factor** — a 0–100% score combining:

- **Frequency** — how often someone will do this work on this project
- **Lift** — how much the skill makes it faster (efficient), lower-effort (easier), or safer (fewer mistakes, broken builds, bad releases) per hit
- **Fit** — how well the ecosystem match actually matches this project

Present highest first, in this exact format:

\`\`\`
# Skills Audit

1. <skill-name> — 92%
   Benefit: <one sentence on what it does for this project>
   Source: <repo URL>
   Scope: project

2. <skill-name> — 78%
   Benefit: …
   Source: …
   Scope: project
\`\`\`

Cap the list at 8. If you'd list more, you're padding. Default scope is \`project\` per find-skills' rules; only mark \`global\` when the skill is genuinely cross-cutting.

If strong candidates had no ecosystem match, list them at the bottom:

\`\`\`
## Gaps worth authoring

- <candidate title> — <why it matters for this project> — consider scaffolding a custom SKILL.md
\`\`\`

## Phase 6: Wait for the user

After presenting the list, ask which (if any) to install. Install nothing without explicit confirmation. Once confirmed, hand off to find-skills to perform the actual install.
