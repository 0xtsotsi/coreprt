---
name: c
description: Style pack for c (from gg-coder)
---

### C

- **Tooling.** C11 or C17. \`clang-format\` + \`clang-tidy\`. \`-Wall -Wextra -Wpedantic -Werror\` always. AddressSanitizer + UBSan in test builds. Run a fuzzer on parsers.
- **Memory.** Pair every \`malloc\` with a clear owner and a single \`free\` site. Prefer arena/region allocators for groups of related allocations. Zero-initialize structs. Never trust \`strlen\` on untrusted input — track lengths explicitly.
- **Types.** \`stdint.h\` integer types (\`int32_t\`, \`size_t\`, \`uintptr_t\`) — never bare \`int\`/\`long\` for sizes or counts. \`bool\` from \`stdbool.h\`. Use \`enum\` for tagged unions; carry a tag field.
- **Errors.** Return \`int\` status codes or a small enum; pass results back via out-pointers. Always check return values. Define \`Result_T\` structs for richer cases. Never use \`errno\` across thread boundaries without copying.
- **Structure.** One concept per \`.c\` + \`.h\` pair. Header declares public API only; static functions are file-local. No global mutable state (use opaque handles).
- **Strings.** Length-prefixed slices or explicit \`(ptr, len)\` pairs over null-terminated wherever possible. \`snprintf\` with explicit buffer sizes — never \`sprintf\`, \`strcpy\`, \`gets\`.
- **Avoid.** Macros beyond \`#include\` guards, platform conditionals, and named constants. Variable-length arrays. Implicit int. \`goto\` except for unified cleanup paths.
