---
name: swift
description: Style pack for swift (from gg-coder)
---

### Swift

- **Tooling.** Swift 5.10+ or 6 with strict concurrency. \`swift-format\` or SwiftLint. \`-warnings-as-errors\` in CI.
- **Types.** \`struct\` by default; \`class\` only for identity-bearing references. \`enum\` with associated values for sum types. \`@frozen\` on stable public enums. Generics over protocol existentials when possible.
- **Optionals.** Use the type system — no \`!\` force-unwraps except for genuinely impossible-to-fail cases (with a comment). \`guard let\` / \`if let\` everywhere else.
- **Errors.** \`throws\` + typed \`throws\` (Swift 6) for expected failures across module boundaries. \`Result<Success, Failure>\` when storing/passing async outcomes. Never use \`try!\` outside tests.
- **Concurrency.** \`async\`/\`await\` + structured concurrency (\`TaskGroup\`, \`async let\`). Actors for mutable shared state. \`@MainActor\` on UI-touching code. Avoid \`Task.detached\`.
- **Structure.** One public type per file. Group files by feature. Extensions for protocol conformances, kept in the same file unless cross-cutting.
- **Avoid.** Implicit-unwrapped optionals (\`Type!\`) in new code. \`NSObject\` inheritance unless interop requires it. Singletons as the primary state container. Reflection (\`Mirror\`) in hot paths.
