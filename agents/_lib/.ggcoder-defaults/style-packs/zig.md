---
name: zig
description: Style pack for zig (from gg-coder)
---

### Zig

- **Tooling.** Pin a specific Zig version per project (the language is pre-1.0 and shifting). \`zig fmt\`. Run all sanitizers in test builds.
- **Errors.** Use Zig's error union type \`!T\` everywhere appropriate. Define a single error set per module, named \`Error\`. Use \`try\` for propagation, \`catch\` for handling at the boundary. Never \`unreachable\` in production paths.
- **Memory.** Explicit allocator passed in to every function that allocates. Pair every \`alloc\` with a \`defer\` \`free\`. Use arena allocators for grouped lifetimes.
- **Comptime.** Use \`comptime\` for genuine compile-time work (generics, config) — not as a substitute for runtime code.
- **Structure.** One concept per file. Public API at the top. Tests in the same file as the code they test.
- **Avoid.** \`@cImport\` outside a single \`c.zig\` boundary module. Heap allocation in hot paths when a fixed-size buffer works. Mixing different allocators in one ownership chain.
