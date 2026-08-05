---
name: haskell
description: Style pack for haskell (from gg-coder)
---

### Haskell

- **Tooling.** GHC 9.6+. \`ormolu\` or \`fourmolu\`. HLint with strict suggestions. Stack or Cabal — pick one per repo. \`-Wall -Wcompat -Werror\` for libraries.
- **Types.** Explicit top-level signatures on every binding, even when inferable. Records with named fields and \`DuplicateRecordFields\` + \`OverloadedRecordDot\` (or use \`generic-lens\`). Newtype wrappers for domain primitives.
- **Errors.** \`Either ErrorType a\` for expected failures. \`Maybe\` only for genuine absence, not for "computation failed". Exceptions only at the IO boundary; convert to \`Either\` immediately.
- **Effects.** Pick one effect strategy per repo: plain \`IO\` for simple apps, \`ReaderT\` over \`IO\` for typical services, or a single effect system (effectful / freer-simple). Don't mix.
- **Structure.** One module per type + its operations. No \`Util\` or \`Misc\` modules. Public API surface in module export lists — never \`module X where\` with no export list.
- **Avoid.** Partial functions (\`head\`, \`!!\`, \`fromJust\`) — use total alternatives. Lens-heavy chains in app logic. \`undefined\` in committed code. Orphan instances.
