---
name: bash
description: Style pack for bash (from gg-coder)
---

### Bash / Shell

- **Tooling.** \`#!/usr/bin/env bash\` shebang. \`set -euo pipefail; IFS=$'\\n\\t'\` at the top of every script. \`shellcheck\` clean — no exceptions.
- **Style.** Quote every variable expansion (\`"$var"\`). \`[[ ]]\` not \`[ ]\` for tests. \`$(cmd)\` not backticks. Functions over inline blocks past ~10 lines.
- **Errors.** Check command exit codes explicitly when \`set -e\` semantics aren't sufficient (e.g. pipes — use \`pipefail\`). \`trap\` for cleanup. Never \`|| true\` to silence errors without a comment explaining why.
- **Args.** Use \`getopts\` or a small parser, not positional indexing past 2 args. \`--\` to separate flags from arguments when passing to other commands.
- **Structure.** Top of script: shebang, \`set\` flags, \`readonly\` constants, then function definitions, then \`main\` call. One concern per script.
- **Avoid.** \`eval\`. Word splitting / glob expansion by leaving variables unquoted. Mutating \`IFS\` in the middle of a script. Scripts longer than ~100 lines — switch to Python or Go.
