---
name: kotlin
description: Style pack for kotlin (from gg-coder)
---

### Kotlin

- **Tooling.** Kotlin 2.0+. \`ktlint\` + \`detekt\`. Strict explicit API mode in libraries.
- **Types.** \`data class\` for value objects. \`sealed class\` / \`sealed interface\` for sum types — exhaustive \`when\` over \`if\`. Inline \`value class\` for domain primitives. Avoid \`Any\` and platform types.
- **Nullability.** Use the type system — never \`!!\`. Prefer \`?.let\`, \`requireNotNull\`, or explicit \`if\` checks. Treat all Java interop returns as nullable.
- **Errors.** \`Result<T>\` or a custom sealed \`Either\`-like type for expected failures. Reserve exceptions for bugs. \`runCatching\` only at adapter edges.
- **Coroutines.** Structured concurrency via \`coroutineScope\` / \`supervisorScope\`. Never \`GlobalScope\`. \`Dispatchers.IO\` for blocking work, \`Default\` for CPU. Always pass a \`CoroutineContext\` or scope into suspend functions that launch children.
- **Structure.** Package by feature. One top-level public declaration per file (extension functions excepted). Use \`internal\` visibility liberally.
- **Avoid.** Companion-object factories when a top-level function works. Nested classes for grouping (use packages). Reflection. Overusing operator overloading.
