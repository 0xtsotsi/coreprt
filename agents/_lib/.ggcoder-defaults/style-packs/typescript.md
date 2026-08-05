---
name: typescript
description: Style pack for typescript (from gg-coder)
---

### TypeScript

- **Tooling.** \`tsc --strict\` always. Enable \`noUncheckedIndexedAccess\`, \`exactOptionalPropertyTypes\`, \`noImplicitOverride\`. **Biome** (single Rust binary — format + lint) as the default for new projects; fall back to Prettier + \`@typescript-eslint/strict-type-checked\` only when Biome's rule coverage is insufficient. Don't run both in one project.
- **Types.** Explicit return types on every exported function and async function. Inference is fine inside function bodies. Never use \`any\`. Prefer \`satisfies\` over \`as\` for narrowing literal-typed values; reserve \`as\` for genuinely unavoidable casts (and \`as const\`). Never use the non-null \`!\` operator. Branded types (\`type UserId = string & { __brand: "UserId" }\`) for domain primitives. Ban the \`Function\` type and \`Object\` type.
- **Data.** Validate every external boundary (HTTP, env, file, IPC) with Zod or Valibot. Never trust untyped JSON. Discriminated unions over class hierarchies. \`Readonly<T>\` for immutable shapes.
- **Errors.** Zero-dep discriminated-union returns for expected failures: \`type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }\`. Type-narrowable, no runtime dependency, model-friendly. Reserve \`throw\` for truly unrecoverable bugs (impossible states, assertion failures). Never throw for control flow.
- **Modules.** Named exports only — no \`export default\`. One concept per file. No barrel files (\`index.ts\` re-exports). Feature folders (\`users/\`), not layer folders (\`controllers/services/repos/\`).
- **Async.** \`async/await\` only — no \`.then\` chains. Always await or explicitly return promises. No floating promises. Pass \`AbortSignal\` through every async function that does I/O or long work; respect it.
- **Avoid.** \`enum\` (use \`as const\` objects + \`typeof\` unions). Class inheritance beyond one level. \`namespace\`. Decorators outside framework-required slots. Conditional/mapped types in app code (keep in \`types.ts\` if unavoidable).
