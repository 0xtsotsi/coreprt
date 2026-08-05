---
name: fsharp
description: Style pack for fsharp (from gg-coder)
---

### F#

- **Tooling.** Latest stable F# on .NET 8+. \`fantomas\` formatter. \`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>\`. FSharpLint or analyzers.
- **Types.** Records and discriminated unions for all domain types. Single-case DUs for domain primitives. Avoid classes in new code except for interop. Type providers only when the source schema is stable.
- **Errors.** \`Result<'T, 'TError>\` for expected failures, \`Option\` for absence. \`ResultBuilder\` (\`result { ... }\`) computation expression for sequencing. Exceptions only at the .NET interop boundary.
- **Structure.** Modules over classes. File order matters in F# — put types and core helpers first, composition later. One concept per file. Keep \`open\` statements at the top.
- **Async.** \`Async\` for F#-native flows, \`Task\` at .NET boundaries. Use \`task { }\` computation expression when interop matters.
- **Avoid.** Mutable state outside small, well-contained pockets. Object expressions where a module function would do. \`obj\` and downcasts in business code. \`null\` even for interop — wrap immediately in \`Option\`.
