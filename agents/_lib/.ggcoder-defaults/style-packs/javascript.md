---
name: javascript
description: Style pack for javascript (from gg-coder)
---

### JavaScript

- **Tooling.** ESM only (\`"type": "module"\`). **Biome** (single Rust binary — format + lint) as the default for new projects; or Prettier + ESLint with \`eslint:recommended\` and \`eslint-plugin-import\`. Don't run both in one project. If types matter at all, use TypeScript instead of JSDoc.
- **Types.** If you must stay on JS, annotate exported functions with JSDoc \`@param\`/\`@returns\` so the LSP can infer. Otherwise treat the project as untyped and validate aggressively at boundaries.
- **Data.** Validate every external boundary with Zod. Use plain objects + factory functions, not classes, for data shapes. \`Object.freeze\` for constants.
- **Errors.** Return \`{ ok: true, value } | { ok: false, error }\` discriminated objects for expected failures. \`throw\` only for unrecoverable bugs. Always handle promise rejections.
- **Modules.** Named exports only. One concept per file. Use feature folders. No CommonJS \`require\` in new code.
- **Async.** \`async/await\` exclusively. \`Promise.all\` for parallel work; never sequential awaits in a loop unless ordering is required.
- **Avoid.** \`var\`. Implicit globals. \`==\` (use \`===\`). Prototype mutation. \`with\`. \`eval\`. \`arguments\` (use rest params).
