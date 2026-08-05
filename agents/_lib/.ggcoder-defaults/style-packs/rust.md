---
name: rust
description: Style pack for rust (from gg-coder)
---

### Rust

- **Tooling.** \`rustfmt\` + \`clippy\` with at minimum \`-W clippy::pedantic\`. Stable channel unless you have a specific reason. \`cargo test\` + \`cargo doc\` in CI.
- **Errors.** Libraries: define typed error enums with \`thiserror\` so callers can match specific variants. Binaries / application code: use \`anyhow::Result\` + \`.context("doing X")\`. Use the \`?\` operator everywhere; reserve \`match\` for cases that need transformation. Never \`unwrap()\` outside tests, examples, or proven-impossible states (add \`// SAFETY:\` comment when truly unavoidable).
- **Types.** Prefer concrete types and \`impl Trait\` returns over \`dyn Trait\` + generics towers. Newtype wrappers (\`struct UserId(Uuid)\`) over raw primitives for domain types. Lifetimes named meaningfully (\`'src\`, \`'arena\`), not \`'a\`, \`'b\`.
- **Modules.** One concept per file. \`mod.rs\` only re-exports. Feature folders. \`pub(crate)\` by default; \`pub\` only for genuine library API.
- **Async.** \`tokio\` is the default runtime. \`async fn\` in traits via \`async-trait\` only when stable async-fn-in-trait won't work. Avoid mixing runtimes.
- **Unsafe.** Forbidden in app code without an explicit \`// SAFETY:\` comment explaining the invariant. Encapsulate in a safe wrapper module.
- **Avoid.** Macro-heavy crates in app logic. Custom \`macro_rules!\` unless it removes >5 real call sites. Trait towers. \`Box<dyn Error>\` (use \`anyhow::Error\`). String-typed APIs where an enum would do.
