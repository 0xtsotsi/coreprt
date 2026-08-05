---
name: reflect
description: Force Ken to review the most recent turn even when the autopilot gate would skip it.
---

Force a Ken review of the just-completed turn. The autopilot normally
gates on changed lines + tool-call count (see autopilot-loop.mjs) and
skips turns that don't cross the threshold. /reflect overrides that
gate and forces Ken to look at the current diff.

Ken reviews the diff and returns one verdict:
- ALL_CLEAR — work is sound, nothing to do
- IGNORE — turn was mechanical, no real change to review
- HUMAN — operator decision needed; explanation follows
- PROMPT — issue a fix; the prompt body follows the keyword

If Ken says PROMPT, the autopilot loop re-injects the fix as a fresh
kind:9 in the channel; the build session picks it up on the next
subscription tick and processes it normally. The loop is capped at
3 rounds, then hands to the operator.

This is gg-coder's autopilot cycle, ported. The toggle is off — this
fires on every turn, and /reflect lets the operator force a review on
demand.
