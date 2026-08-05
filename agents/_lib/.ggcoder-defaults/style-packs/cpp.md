---
name: cpp
description: Style pack for cpp (from gg-coder)
---

### C++

- **Tooling.** C++20 minimum, C++23 when toolchain allows. \`clang-format\` + \`clang-tidy\` with \`cppcoreguidelines-*\` and \`modernize-*\` checks. AddressSanitizer + UBSan in test builds. CMake with presets.
- **Resources.** RAII universal. \`std::unique_ptr\` by default, \`std::shared_ptr\` only when ownership is genuinely shared. Never raw owning pointers. Never \`new\`/\`delete\` in app code.
- **Types.** \`std::string_view\` and \`std::span\` for non-owning views. \`std::optional<T>\` for nullable returns. \`auto\` for obvious types, explicit for API surfaces.
- **Errors.** \`std::expected<T, E>\` (C++23) — or \`tl::expected\` if stuck on older toolchain — for expected failures. \`throw\` only for genuinely exceptional cases (allocation failure, programmer errors). Exception specifications via \`noexcept\` on functions that must not throw.
- **Generics.** Concepts (C++20), never SFINAE. \`std::ranges\` over raw iterator pairs.
- **Headers/modules.** C++20 modules when supported; otherwise include guards via \`#pragma once\`. No transitive includes — each file includes what it uses.
- **Avoid.** C-style casts (use \`static_cast\` / \`reinterpret_cast\`). Raw arrays in new code (use \`std::array\` or \`std::vector\`). Macros for anything other than include guards or platform conditionals. Template metaprogramming beyond \`if constexpr\` + concepts. Multiple inheritance of non-interface classes.
