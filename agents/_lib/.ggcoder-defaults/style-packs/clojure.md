---
name: clojure
description: Style pack for clojure (from gg-coder)
---

### Clojure

- **Tooling.** Latest stable Clojure. \`clj-kondo\` linter (treat warnings as errors). \`cljfmt\` formatter. \`tools.deps\` (\`deps.edn\`) over Leiningen for new projects.
- **Specs/schemas.** Use Malli (preferred) or Spec at every external boundary. Schema-driven generative tests on core data. Keep schemas alongside the namespace they describe.
- **Errors.** Return \`{:ok ...}\` / \`{:error ...}\` maps for expected failures. \`ex-info\` with structured data for genuine exceptions. Never bare \`throw\` of a string. \`try\`/\`catch\` only at process or request boundaries.
- **State.** Atoms for shared local state, refs only when coordination is required, never global vars for mutable state. Components / Integrant / Mount for system lifecycle — pick one per repo.
- **Structure.** Namespace per concept. Keep functions small, composable, pure where possible. Side effects pushed to the edge.
- **Avoid.** Macros in app code unless they remove genuine ceremony. Dynamic vars (\`*var*\`) for hidden parameters. \`def\` inside functions. \`eval\` in production code. Threading-macro chains longer than ~5 steps without a named intermediate.
