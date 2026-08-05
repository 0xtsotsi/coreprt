---
name: csharp
description: Style pack for csharp (from gg-coder)
---

### C#

- **Tooling.** C# 12+ on .NET 8+. \`<Nullable>enable</Nullable>\` and \`<TreatWarningsAsErrors>true</TreatWarningsAsErrors>\` project-wide. \`dotnet format\`. Roslyn analyzers + StyleCop.
- **Types.** \`record\` (positional or with-init) for DTOs and value objects. \`required\` properties over multi-arg constructors. File-scoped namespaces. One public type per file.
- **Nullability.** NRTs on, no \`!\` operator except for proven-non-null cases with a comment. \`is null\` / \`is not null\` over \`==\`.
- **Errors.** Custom exceptions for unrecoverable. \`Result<T, E>\` (e.g. via \`OneOf\`, \`ErrorOr\`, or a small custom type) for expected failures across service boundaries. Never use exceptions for control flow.
- **Async.** \`async Task<Result<T>>\` everywhere. No \`async void\` except event handlers. Always pass \`CancellationToken\` through I/O calls. Avoid \`.Result\`, \`.Wait()\`, and \`.GetAwaiter().GetResult()\` — they deadlock.
- **LINQ.** Keep chains shallow (≤ 3 operators). Pull complex queries into named methods or local functions.
- **Avoid.** Reflection in hot paths. Static mutable state. Source generators in app code (libraries only). Multi-level inheritance. Manual \`IDisposable\` when \`using\` works.
