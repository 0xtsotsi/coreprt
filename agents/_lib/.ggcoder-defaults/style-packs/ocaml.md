---
name: ocaml
description: Style pack for ocaml (from gg-coder)
---

### OCaml

- **Tooling.** OCaml 5+ via opam. \`dune\` build system. \`ocamlformat\` with the project preset locked. Merlin for editor support.
- **Types.** Annotate every public binding in \`.mli\` interface files. Phantom types or private types for domain invariants. Avoid open polymorphic variants in libraries (use plain variants).
- **Errors.** \`Result.t\` from the stdlib for expected failures. Exceptions only for impossible states or at the I/O boundary. \`( let* )\` syntax for monadic chaining over nested \`match\`.
- **Modules.** Heavy use of modules and module signatures. One main type per module, named \`t\`, with operations as \`Module.op\`. Functors only when they buy real abstraction; otherwise plain modules.
- **Structure.** One \`.ml\` per concept with a matching \`.mli\` exposing only public API. Dune libraries grouped by feature.
- **Avoid.** \`Obj.magic\` outside truly unavoidable interop. Global mutable state. Polymorphic equality (\`=\`) on complex types — use type-specific \`equal\` functions. Pervasives \`Stdlib\` shadowing without a clear reason.
