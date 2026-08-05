---
name: elixir
description: Style pack for elixir (from gg-coder)
---

### Elixir

- **Tooling.** Latest stable Elixir + Erlang/OTP. \`mix format\`. \`credo --strict\` + \`dialyzer\` (with \`@spec\` on every public function).
- **Types.** \`@spec\` and \`@type\` on every public function and module — feed Dialyzer. Use structs (\`defstruct\` + \`@enforce_keys\`) for domain data, never bare maps for typed records.
- **Errors.** \`{:ok, value} | {:error, reason}\` tuples for expected outcomes. \`with\` chains for happy-path composition. Bang functions (\`!\`) raise on failure — use sparingly, only when callers genuinely can't recover. Never \`rescue\` arbitrary exceptions in business code.
- **Processes.** Use OTP behaviors (\`GenServer\`, \`Supervisor\`, \`Task.Supervisor\`) — never raw \`spawn\`/\`spawn_link\` in app code. Let-it-crash with a supervision tree, not defensive try/rescue.
- **Structure.** Context modules (Phoenix-style) group functionality by bounded context. Public API on the context module; implementation modules are internal.
- **Avoid.** Macros in app code (libraries may need them; mark with care). \`Process.put\`/\`get\` for state. Atom-keyed maps from untrusted input (\`String.to_atom\` on user data leaks). Hidden side effects in pipelines.
