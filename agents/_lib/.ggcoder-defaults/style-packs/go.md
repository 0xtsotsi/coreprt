---
name: go
description: Style pack for go (from gg-coder)
---

### Go

- **Tooling.** \`gofmt\` non-negotiable. \`go vet\` + \`staticcheck\` in CI. \`golangci-lint\` with a conservative preset. Latest stable Go.
- **Errors.** \`if err != nil { return fmt.Errorf("doing X: %w", err) }\` — wrap with context at every layer. Define sentinel errors as \`var ErrXxx = errors.New("xxx")\` at package level. Use \`errors.Is\`/\`errors.As\` for matching. Never \`panic\` outside \`init\` or truly impossible states.
- **Types.** Small interfaces defined at the consumer, not the producer (\`io.Reader\`-style, 1-3 methods). Accept interfaces, return structs. No empty interface \`any\` except at adapter boundaries.
- **Concurrency.** \`context.Context\` is the first parameter on every I/O or long-running function — always propagate, never \`context.Background()\` deep in a call chain. Goroutines launched only with clear lifecycle ownership (\`errgroup\`, \`sync.WaitGroup\`, or paired \`done\` channel).
- **Logging.** \`log/slog\` (stdlib, Go 1.21+) for structured logging — never \`log\`, \`fmt.Println\`, or third-party loggers in new code. Pass a \`*slog.Logger\` via context or as a struct field on services. Use \`slog.With(...)\` to attach request-scoped attrs.
- **Structure.** Flat package layout by feature (\`user/\`, \`order/\`), not by layer. \`cmd/<binary>/main.go\` for executables. \`internal/\` for packages not meant to be imported externally. No \`utils\` or \`common\` packages.
- **Generics.** Use only when they remove real duplication. Concrete types are the default.
- **Avoid.** \`init()\` functions with side effects. Global mutable state. Returning bare \`error\` without wrapping context. Naked returns in functions longer than 5 lines. \`interface{}\` in new code.
