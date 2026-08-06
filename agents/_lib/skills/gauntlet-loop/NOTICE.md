# Attribution

The skill specification `SKILL.md` in this directory is derived from
the public skill `gauntlet-loop` by **Matt Shumer** (robonuggets),
originally published at https://github.com/robonuggets/gauntlet-loop.

Original work © Matt Shumer, licensed under Creative Commons Attribution
4.0 International (CC BY 4.0). A verbatim copy of the upstream license
is included as `LICENSE` in this directory.

Modifications made when vendoring into CorePrt on 2026-08-06:

- Renamed the file from upstream `SKILL.md` (verbatim copy at the top of
  the original) to **Gauntlet Loop (CorePrt fork)** with a **Wiring in
  CorePrt** section that documents how the loop slots into the three-
  agent runtime (fizz/goji/bumble), kind:43001 JOB_REQUEST routing, and
  the bar registry layout under `bars/<name>.json`.
- Added the trigger conventions `bar:<name>` (Nostr event tag) and
  `/gauntlet <bar-name>` (slash command), which CorePrt's
  `autopilot-loop.mjs:detectGauntletTag()` looks up to route turns into
  the gauntlet path.
- Referenced `agents/_lib/skills/gauntlet-loop/bars/thecardyard-home.json`
  as the webrnds-default bar template.
- Left the upstream **Flow**, **Bar tests**, **Prompt template**,
  **Length and voice**, **Two filled examples**, and **What breaks a
  gauntlet loop** sections untouched.

Per CC BY 4.0 Section 3(a)(1), this NOTICE.md satisfies the attribution
requirement by naming the creator, indicating modifications were made,
and linking to the upstream license.