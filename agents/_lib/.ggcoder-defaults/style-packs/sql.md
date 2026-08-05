---
name: sql
description: Style pack for sql (from gg-coder)
---

### SQL

- **Tooling.** \`sqlfluff\` with a strict dialect-specific preset. Migrations are append-only, numbered, and reversible — never edit an applied migration.
- **Style.** Uppercase keywords. One clause per line, trailing commas in select lists, leading commas allowed if the team agrees. Always alias tables; always qualify columns with the alias.
- **Selects.** Never \`SELECT *\` in application code. CTEs over nested subqueries. Window functions over self-joins where they work.
- **Schema.** Explicit \`NOT NULL\` on every column that should have it. Foreign keys with \`ON DELETE\` actions specified. Generated/identity columns for surrogate keys; never auto-incrementing without a \`PRIMARY KEY\`.
- **Migrations.** One change per migration. Idempotent where the engine supports it. Always include a rollback plan in a comment. No data migrations mixed with schema migrations.
- **Avoid.** String interpolation into queries from app code — use parameterized queries. \`SELECT INTO\` for permanent tables. ORM lazy-loading patterns hidden behind \`N+1\` queries. Wide tables with \`JSON\` columns where a relational design fits.
