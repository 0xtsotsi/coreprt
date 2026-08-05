---
name: dart
description: Style pack for dart (from gg-coder)
---

### Dart

- **Tooling.** Dart 3+. \`dart format\`. \`very_good_analysis\` or \`flutter_lints\` strict preset. Sound null safety enabled.
- **Types.** Explicit types on every public API. \`final\` everywhere unless mutation is intentional. Records (Dart 3) and patterns for ad-hoc structured data. \`sealed class\` + pattern matching for sum types.
- **Errors.** Custom exceptions for unrecoverable cases. \`Result<T, E>\` sealed class for expected failures. Never throw \`String\` or untyped values.
- **Async.** \`async\`/\`await\`. \`Future\` for one-shot, \`Stream\` for sequences. Always handle errors via \`.catchError\` or try/catch at the boundary.
- **Structure.** One public class per file. Feature folders. \`part\`/\`part of\` only for code generation (\`freezed\`, \`json_serializable\`).
- **Avoid.** \`dynamic\` in new code. Implicit \`new\` (write it out where ambiguous). \`var\` for public API. Mutable static fields. Long widget build methods — extract.
