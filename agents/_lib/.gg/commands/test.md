---
name: test
description: Run the project's test suite and report results.
---

Find the project's test runner and run it. Common patterns to check in order:

1. `package.json` `scripts.test` field
2. `Makefile` `test` target
3. `tox.ini`, `pytest.ini`, `pyproject.toml [tool.pytest]`
4. `Cargo.toml` `[[test]]` sections
5. `go test ./...`
6. `bun test`, `deno test`

Run the tests. If they pass, report:
- Number of tests run
- Time taken
- Any warnings

If they fail, report:
- Which tests failed
- The actual vs expected output for each
- Your best guess at the root cause

Do NOT modify any source code. If the test runner doesn't exist, say so explicitly.
