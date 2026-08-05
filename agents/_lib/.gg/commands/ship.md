---
name: ship
description: Dispatch a plan to the agent fleet — each ## heading becomes a task in its own git worktree.
---

You are the workflow orchestrator. The operator just said `/ship
<plan-name>` or `/ship <path-to-plan.md>`. Your job:

1. Read the plan file. Each `## <Label>:` heading is one task. The
   heading text (after stripping `Feature N:` / `Foundation:` prefix)
   is the title. Body text up to the next `## ...` is the prompt.
2. For each task in order:
   - Run `node agents/_lib/workflow-engine.mjs run <plan.md> --task <id>`
   - This spawns a child runtime.mjs in a fresh git worktree at
     `/tmp/coreprt-ws-<taskid>` with the task prompt.
   - The child subscribes to the public relay, posts its result as
     a kind:9 reply in this channel, and exits.
   - The worktree is cleaned up on success.
3. After all tasks complete, post a kind:9 to the channel summarizing
   which tasks landed, which failed, and the final state of
   `/tmp/coreprt-ws-*/`.

If the operator passes a plan name (no `.md` extension), look it up
in `/Users/gogetta/Documents/projects/CorePrt/.gg/plans/`. If the path
is missing entirely, the operator is asking for a single-shot
review+test+commit — use `git status` to discover the changed files
and call `/review`, `/test`, `/commit` in that order. The agent
runtime forwards `/commit` to the ggcoder `commit` slash command
which already runs the markdownlint + secrets guard + subagent
review gate.

For the canonical plan format, see
`/Users/gogetta/Documents/projects/CorePrt/.gg/plans/2026-08-04-foundation-and-priorities.md`.
