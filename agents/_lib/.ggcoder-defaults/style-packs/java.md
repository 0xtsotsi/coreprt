---
name: java
description: Style pack for java (from gg-coder)
---

### Java

- **Tooling.** Java 21+ (LTS). \`google-java-format\` or \`spotless\`. Error Prone + Checker Framework or NullAway in CI. Maven or Gradle Kotlin DSL — pick one per repo and stick.
- **Types.** Use \`record\` for all immutable data carriers. \`sealed interface\` + permits for sum types; pattern-match in \`switch\`. \`Optional<T>\` for return types only — never as a field or parameter.
- **Errors.** Custom unchecked exceptions extending \`RuntimeException\` for business errors. Wrap checked exceptions at adapter boundaries — don't propagate \`IOException\` through service layers. Use sealed \`Result<T, E>\` types for cases where the caller must handle both branches.
- **Nullability.** \`@Nullable\`/\`@NonNull\` (JSpecify) on every API boundary. Treat unannotated as non-null. NullAway in CI.
- **Structure.** Package by feature. Constructor injection only — no field injection, no setter injection. No static mutable state. \`final\` by default on classes and fields.
- **Avoid.** Reflection in business code (frameworks may need it). Lombok in new code (records cover 95% of cases). AOP / proxy magic. Checked exceptions on new APIs. Inheritance beyond one level.
