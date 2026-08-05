---
name: review
description: Review the current diff or staged changes for code quality issues.
---

You are reviewing code, not writing it. Read the changed files with the read tool, then run git diff (or git diff --staged) and analyze. Look for:

1. **Bugs and logic errors** — off-by-one, null checks, race conditions
2. **Security issues** — input validation, auth checks, secrets in code
3. **Style consistency** — does the new code match the surrounding file's style
4. **Test coverage** — does the change need tests? Are existing tests still valid?
5. **Documentation** — are public APIs documented? Are complex flows commented?

Output a structured review:
- ✅ What's good
- ⚠️ Concerns (with file:line references)
- ❌ Blocker issues that must be fixed before merge
- 📋 Suggestions (nice-to-have)

Be specific. Reference exact lines. Don't speculate — if you're not sure, say "uncertain, recommend human review of X."
