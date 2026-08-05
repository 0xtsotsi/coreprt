---
name: ship
description: Run review, test, and commit in sequence for the current changes.
---

End-to-end quality gate. Run these in order, stopping on any failure:

1. `/review` — if there are blockers (❌), stop and report
2. `/test` — if any test fails, stop and report
3. `/commit` — only if both pass

Final output: one line summarizing whether the change is ready to ship, plus the commit SHA from step 3.
