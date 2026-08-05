---
name: commit
description: Lint markdown + shell sanity, agent code review, commit with AI message, push
---

1. Run quality checks:
   - validate markdown: `find . -name '*.md' -not -path './CorePrt-relay/*' -not -path './CorePrt-bundles/*' -print0 | xargs -0 -n1 npx --no markdownlint-cli`
   - shell sanity (if any changed): `find . -name '*.sh' -not -path './CorePrt-relay/*' -print0 | xargs -0 -n1 bash -n`
   - secrets guard: `git diff --cached --name-only | grep -E '(\.env$|-secrets-|-owner-keys-|keygen-output)' && echo "BLOCKED: possible secret file staged" && exit 1`
   Fix ALL errors before continuing. Use `markdownlint --fix` where available.

2. Review changes: `git status && git diff --staged && git diff`

3. Fast review gate: spawn ONE subagent with the full diff. Instructions: review ONLY
   the diff for real bugs, regressions, leftover debug code, and unintended changes.
   Score each issue 0-100 confidence (pre-existing issues and stylistic nitpicks = false
   positives, score low). Report ONLY issues with confidence >= 80, with file:line and a
   one-line fix. If none, reply "CLEAR". This is a last check, not a deep audit - be fast.

4. If CLEAR: proceed to step 5 and push WITHOUT asking. If issues >= 80: STOP, show them,
   ask exactly: "Want me to fix this first, or commit and push anyway?
   A) Fix it first, then commit & push   B) Commit & push anyway"
   On A: fix, re-run step 1, continue (no re-review). On B: continue as-is.

5. Stage relevant files: `git add <specific files>` (never `git add -A`)

6. Commit message: verb (Add/Update/Fix/Remove/Refactor) + specific, one line preferred.

7. Commit AND push without pausing:
   `git commit -m "<message>" && git push`
