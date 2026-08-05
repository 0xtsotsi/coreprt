---
name: ruby
description: Style pack for ruby (from gg-coder)
---

### Ruby

- **Tooling.** Ruby 3.3+. \`standardrb\` or \`rubocop\` (strict preset). \`sorbet\` with \`# typed: strict\` on every file in new projects. RSpec for tests.
- **Types.** \`T::Struct\` (Sorbet) for value objects. \`T.nilable\`, \`T::Array[X]\`, etc. on every method signature. RBS files alongside libraries.
- **Errors.** Custom exception classes per domain, inheriting a single base \`AppError\`. \`raise\` for unrecoverable; for expected failures return \`Success(value)\` / \`Failure(err)\` via \`dry-monads\` or a small custom Result type.
- **Structure.** Files match class names. Modules by feature. \`Zeitwerk\` autoloading. Frozen string literals magic comment at the top of every file.
- **Idioms.** \`Data.define\` (Ruby 3.2+) for immutable value objects when not using Sorbet. Keyword arguments over positional past 2 args. Guard clauses over nested \`if\`. \`tap\` for side effects on a chain.
- **Avoid.** \`method_missing\` and \`respond_to_missing?\` in new code. Monkey-patching core classes. \`define_method\` at runtime. \`eval\` family. Heavy DSLs outside the few canonical cases (Rails routes, RSpec, etc. — isolate them).
