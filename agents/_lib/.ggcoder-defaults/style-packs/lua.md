---
name: lua
description: Style pack for lua (from gg-coder)
---

### Lua

- **Tooling.** Lua 5.4 or LuaJIT — declare which. \`stylua\` for formatting. \`luacheck\` with strict globals. Annotate with LuaCATS / EmmyLua for editor support.
- **Types.** \`---@type\`, \`---@param\`, \`---@return\` annotations on every public function. \`---@class\` for tables used as records.
- **Tables.** Decide if a table is a record, array, or map at the call site and stick to it. Don't mix array and map fields. Sequence tables (\`{ "a", "b" }\`) treated as 1-indexed sequences without holes.
- **Errors.** Return \`value, nil\` on success / \`nil, errString\` on failure for expected outcomes. \`error()\` only for unrecoverable programmer errors. \`pcall\` at module / request boundaries.
- **Modules.** \`local M = {}; … return M\` pattern. No global side effects on require. \`local\` everything unless explicit module export.
- **Avoid.** Implicit globals — set \`luacheck\` to flag them. Metatable cleverness in app logic. \`setfenv\`/\`getfenv\` (gone in 5.2+) or environment hacks. String-key tables when an index would work.
