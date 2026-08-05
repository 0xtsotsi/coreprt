---
name: scala
description: Style pack for scala (from gg-coder)
---

### Scala

- **Tooling.** Scala 3. \`scalafmt\` + \`scalafix\`. \`-Wunused:all\`, \`-Werror\`, \`-explain\` compiler flags. Run on the latest stable Scala 3.
- **Types.** \`case class\` for records, \`enum\` for sum types — never sealed-trait-and-case-objects boilerplate in Scala 3. Opaque types for domain primitives. Avoid implicit conversions; use \`given\`/\`using\` for type-class instances only.
- **Errors.** \`Either[E, A]\` for expected failures, \`Try\` only at the foreign-exception boundary, exceptions only for unrecoverable bugs. With effect libraries (Cats Effect / ZIO): use the effect type's error channel.
- **Effects.** Pick one effect system per repo (Cats Effect IO or ZIO) and stick with it. Avoid mixing Future + IO. Tagless final only when the abstraction is genuinely load-bearing.
- **Structure.** Package by feature. One top-level definition per file when public. Heavy use of \`extension\` methods over implicit classes.
- **Avoid.** \`null\`. \`var\` in business code. Implicit conversions. Operator-soup DSLs in app logic (libraries only). \`asInstanceOf\` outside adapter boundaries.
