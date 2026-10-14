# xzor

A Blazor/Razor-style component compiler written in Rust that targets TypeScript. Design: [docs/design.md](../docs/design.md).

## Workflow (Superpowers skills in `.github/skills/`)

Before any task, check whether a skill applies and follow it:

- New feature or behavior change: `brainstorming`, then `writing-plans` (plans go in `docs/plans/`), then `executing-plans` or `subagent-driven-development`.
- All code: `test-driven-development` (write a failing test first, then make it pass).
- Bugs: `systematic-debugging`.
- Before claiming done: `verification-before-completion`, which means running the commands below and reading their output.

## Commands

- `cargo test`: unit tests (in the modules) and `tests/` integration tests.
- `bun test`: runtime tests (`runtime/*.test.ts`, using happy-dom) and the LSP end-to-end test (`tests/lsp.test.ts`, which builds and drives `xzor lsp`).
- `bun run test:grammar`: VS Code TextMate grammar tests (`editors/vscode/test`). Edit `test/gen.ts`, not the generated `syntax.test.xzor`.
- `bun run build:vscode`, then `vsce package --no-dependencies` in `editors/vscode`: builds the extension (the client starts `xzor lsp`).
- `cargo run -- build examples/counter`: full pipeline (compile, run `bun x tsc` type check, Bun bundle).
- `cargo run -- highlight examples/counter/Counter.xzor`: prints the template with colors.
- `./Package.ps1 [-test true] [-specificVersion x.y.z]`: restore, build, test and pack into `publish/` (npm tarballs `@source-crafter/xzor-runtime`, `@source-crafter/xzor` (the CLI, command `xzor`), `@source-crafter/xzor-cli-<platform>`, plus `xzor-<version>.vsix`). Locally it packs the host binary only; CI (`.github/workflows/dev.yml`, on push to `main`; it publishes only when the head commit starts with `[Release]`) builds every platform and publishes to npm, the VS Code Marketplace and Open VSX. Launcher and package manifests live in `npm/`.

## Conventions

- Memory and performance first: generated code and the runtime allocate no more than hand-written code would. Prefer fields on existing objects over `WeakMap`s, wrappers or extra closures.
- Zero Rust dependencies so far. The local GNU toolchain has no `dlltool`, so crates that depend on `windows-sys` (clap, etc.) fail to build. Avoid them.
- Pipeline: `parser.rs` (AST with `Src` spans, plus token spans) → `codegen.rs` (TypeScript class with `buildRenderTree`, plus source `Mapping`s) → `build.rs` (writes `<project>/.xzor/*.xzor.ts`, writes the route table `.xzor/routes.ts` from the `@page`s (`src/routes.rs`), runs DI analysis (`src/di.ts` → `src/di/` → `.xzor/<entry>` and `.xzor/**/*.provider.ts`), runs the tsc check, then `src/bundle.ts` via Bun).
- DI analysis goes through a persistent `di.ts --serve` process per root (`src/analyzer.rs`). `--watch` is event-driven (`src/watch.ts`, `build::watch_plan`). Both helper scripts are written to `<root>/node_modules/.cache/xzor/`.
- Generic component uses without `T=` hoist props into `const __pN` and infer `T` with a conditional type (zero runtime cost).
- `xzor lsp` (`src/lsp/`): component features live in `features.rs`, and TypeScript regions are proxied to TypeScript 7's `tsc --lsp --stdio` through the mappings. Feature providers are registered dynamically for `xzor` only; `.ts` documents get live DI diagnostics and nothing else. JSON is hand-written in `json.rs`.
- Project tsconfigs need `"rootDirs": [".", ".xzor"]` and `".xzor/**/*.ts"` in `include`; DI projects also need `"ESNext.Disposable"` in `lib`.
- A `.xzor` must not import from `./main`: `rootDirs` resolves it to the generated `.xzor/main.ts`.
- The runtime is `runtime/index.ts`. Keep the generated code and the `RenderTreeBuilder` API in sync.
- Generated `.xzor/` folders are gitignored. Never edit them by hand.
