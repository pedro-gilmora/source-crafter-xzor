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
- Pipeline: `parser.rs` (AST with `Src` spans, plus token spans) → `codegen.rs` (TypeScript class with `buildRenderTree`, plus source `Mapping`s) → `build.rs` (writes `<project>/.zor/*.tszor.ts`, runs the tsc check, then `src/bundle.ts` via Bun).
- `zor lsp` (`src/lsp/`): component features live in `features.rs`, and TypeScript regions are proxied to TypeScript 7's `tsc --lsp --stdio` through the mappings. JSON is hand-written in `json.rs`.
- Project tsconfigs need `"rootDirs": [".", ".zor"]` and `".zor/**/*.ts"` in `include`.
- The runtime is `runtime/index.ts`. Keep the generated code and the `RenderTreeBuilder` API in sync.
- Generated `.zor/` folders are gitignored. Never edit them by hand.
