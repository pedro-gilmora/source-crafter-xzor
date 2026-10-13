# rs-zor

A Blazor/Razor-style component compiler written in Rust that targets TypeScript. Design: [docs/design.md](../docs/design.md).

## Workflow (Superpowers skills in `.github/skills/`)

Before any task, check whether a skill applies and follow it:

- New feature or behavior change: `brainstorming`, then `writing-plans` (plans go in `docs/plans/`), then `executing-plans` or `subagent-driven-development`.
- All code: `test-driven-development` (write a failing test first, then make it pass).
- Bugs: `systematic-debugging`.
- Before claiming done: `verification-before-completion`, which means running the commands below and reading their output.

## Commands

- `cargo test`: unit tests (in the modules) and `tests/` integration tests.
- `bun test`: runtime tests (`runtime/*.test.ts`, using happy-dom) and the LSP end-to-end test (`tests/lsp.test.ts`, which builds and drives `zor lsp`).
- `bun run test:grammar`: VS Code TextMate grammar tests (`editors/vscode/test`). Edit `test/gen.ts`, not the generated `syntax.test.tszor`.
- `bun run build:vscode`, then `vsce package --no-dependencies` in `editors/vscode`: builds the extension (the client starts `zor lsp`).
- `cargo run -- build examples/counter`: full pipeline (compile, run `bun x tsc` type check, Bun bundle).
- `cargo run -- highlight examples/counter/Counter.tszor`: prints the template with colors.

## Conventions

- Memory and performance first: generated code and the runtime allocate no more than hand-written code would. Prefer fields on existing objects over `WeakMap`s, wrappers or extra closures.
- Zero Rust dependencies so far. The local GNU toolchain has no `dlltool`, so crates that depend on `windows-sys` (clap, etc.) fail to build. Avoid them.
- Pipeline: `parser.rs` (AST with `Src` spans, plus token spans) → `codegen.rs` (TypeScript class with `buildRenderTree`, plus source `Mapping`s) → `build.rs` (writes `<project>/.zor/*.tszor.ts`, runs DI analysis (`src/di.ts` → `src/di/` → `.zor/<entry>` and `.zor/**/*.provider.ts`), runs the tsc check, then `src/bundle.ts` via Bun).
- DI analysis goes through a persistent `di.ts --serve` process per root (`src/analyzer.rs`). `--watch` is event-driven (`src/watch.ts`, `build::watch_plan`). Both helper scripts are written to `<root>/node_modules/.cache/zor/`.
- Generic component uses without `T=` hoist props into `const __pN` and infer `T` with a conditional type (zero runtime cost).
- `zor lsp` (`src/lsp/`): component features live in `features.rs`, and TypeScript regions are proxied to TypeScript 7's `tsc --lsp --stdio` through the mappings. Feature providers are registered dynamically for `tszor` only; `.ts` documents get live DI diagnostics and nothing else. JSON is hand-written in `json.rs`.
- Project tsconfigs need `"rootDirs": [".", ".zor"]` and `".zor/**/*.ts"` in `include`; DI projects also need `"ESNext.Disposable"` in `lib`.
- A `.tszor` must not import from `./main`: `rootDirs` resolves it to the generated `.zor/main.ts`.
- The runtime is `runtime/index.ts`. Keep the generated code and the `RenderTreeBuilder` API in sync.
- Generated `.zor/` folders are gitignored. Never edit them by hand.
