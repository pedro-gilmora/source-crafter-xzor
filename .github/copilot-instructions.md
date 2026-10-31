# xzor

A Blazor/Razor-style component compiler written in Rust that targets TypeScript. Design: [docs/design.md](../docs/design.md).

## Workflow (Superpowers skills in `.github/skills/`)

Before any task, check whether a skill applies and follow it. Use superpowers, ponytail, and a performance and memory sub-agent (`.github/agents/perf.agent.md`) to address every phase: design, plan, implementation and review each get a perf pass with measured numbers, and its regressions are fixed before moving on. Skills by task:

- New feature or behavior change: `brainstorming`, then `writing-plans` (plans go in `docs/plans/`), then `executing-plans` or `subagent-driven-development`.
- Every spec or design, however small: `spec-rehydration`, before it is shown for approval (a `## Touches` section pulling the constraints of every feature it touches, from `.github/skills/spec-rehydration/features.md`) and after approval (a dated `## Later changes` line in each touched feature's spec).
- All code: `test-driven-development` (write a failing test first, then make it pass).
- Bugs: `systematic-debugging`.
- Before claiming done: `verification-before-completion`, which means running the commands below and reading their output.
- **Docs are mandatory.** Any change to the surface (syntax, directives, attributes, CLI flags, runtime or editor behavior) or to the design ships, in the same commit, with updates to every doc it affects: `README.md`, `docs/design.md`, the documentation site (`docs/site/pages`), the user skill `npm/xzor/skills/xzor/SKILL.md`, and `.github/skills/xzor-ui/SKILL.md` for kit changes. Compile any new snippet before committing it.

## Deploy / release (non-negotiable)

When the user says deploy, deployment, release or publish, the pushed head commit **must** start with `[Release]`: CI publishes only then. Never push for a deployment otherwise. Steps, each its own command:

1. Run every check in Commands and read the output; all must pass.
2. Write the message to a file (first line `[Release] <summary>`, then a markdown bullet body for the GitHub release and Telegram) and commit with `git commit --allow-empty --cleanup=verbatim -F <file>`.
3. Verify before pushing: `git log -1 --format=%s` must start with `[Release]`. If the commit failed or the subject differs, stop and fix it; do not push.
4. Only then `git push origin main`, in a separate command. Never chain `commit; push` in one line: a failed commit would push a plain head.
5. Track the CI run to the end (`gh run watch`) and check the GitHub release.

## Commands

- `cargo test`: unit tests (in the modules) and `tests/` integration tests.
- `bun test ./runtime ./tests`: runtime tests (`runtime/*.test.ts`, using happy-dom) and the LSP end-to-end test (`tests/lsp.test.ts`, which runs `cargo build` and drives `target/debug/xzor lsp`, so don't set `CARGO_TARGET_DIR` for it). A bare `bun test` also scans scratch clones in `target/`.
- `bun run test:grammar`: VS Code TextMate grammar tests (`editors/vscode/test`). Edit `test/gen.ts`, not the generated `syntax.test.xzor`.
- Zed extension (`editors/zed`, its own crate): `cargo check` in that folder; install it in Zed with `zed: install dev extension` (Zed builds it for `wasm32-wasip2`) and use Extensions → Rebuild after changes. A query file may only use the `html` grammar's node types, or Zed drops the language (check `%LOCALAPPDATA%\Zed\logs\Zed.log`). A `lsp.xzor.binary.path` in settings needs `"arguments": ["lsp"]`.
- `bun run build:vscode`, then `bun x @vscode/vsce package --no-dependencies --skip-license --allow-missing-repository -o ../../target/xzor-local.vsix` in `editors/vscode` and `code --install-extension target/xzor-local.vsix --force`: builds and installs the extension. The client runs the newest of `target/{release,debug}/xzor`, so after `cargo build` a restart of the extension host is enough. Keep only one xzor extension installed: the current id is `SourceCrafter.xzor-language` (the Marketplace keeps a deleted name reserved forever, so `xzor` can't be reused); uninstall `xzor.xzor`, `PedroGilMora.xzor` and `SourceCrafter.xzor`, which shadow the grammar.
- `cargo run -- build examples/counter`: full pipeline (compile, run `bun x tsc` type check, Bun bundle).
- `cargo run -- highlight examples/counter/Counter.xzor`: prints the template with colors.
- `bun run ui` (`xzor compile ui`): compiles the xzor-ui kit in `ui/`; run it before building anything that imports the kit. `bun run examples` builds `examples/{dashboard,blog,sales}` on it, then `examples/tailwind` (Tailwind CLI, no kit; `bun run tailwind`). Kit rules: `.github/skills/xzor-ui/SKILL.md`; design sub-agents: `.github/agents/`.
- `./Package.ps1 [-test true] [-specificVersion x.y.z]`: restore, build, test and pack into `publish/` (npm tarballs `@source-crafter/xzor-runtime`, `@source-crafter/xzor` (the CLI, command `xzor`), `@source-crafter/xzor-cli-<platform>`, plus `xzor-<version>.vsix`). Locally it packs the host binary only; CI (`.github/workflows/dev.yml`, on push to `main`; it publishes only when the head commit starts with `[Release]`) builds every platform, publishes to npm, and attaches the `.vsix`, the binaries and the npm tarballs to the GitHub release. Launcher and package manifests live in `npm/`.

## Conventions

- Memory and performance first: generated code and the runtime allocate no more than hand-written code would. Prefer fields on existing objects over `WeakMap`s, wrappers or extra closures.
- Zero Rust dependencies so far. The local GNU toolchain has no `dlltool`, so crates that depend on `windows-sys` (clap, etc.) fail to build. Avoid them.
- Pipeline: `parser.rs` (AST with `Src` spans, plus token spans) → `codegen.rs` (TypeScript class with `render(parent)`, plus source `Mapping`s) → `build.rs` (writes `<project>/.xzor/*.xzor.ts`, writes the route table `.xzor/routes.ts` from the `@page`s (`src/routes.rs`), runs DI analysis (`src/di.ts` → `src/di/` → `.xzor/<entry>` and `.xzor/**/*.provider.ts`), runs the tsc check, then `src/bundle.ts` via Bun).
- DI analysis goes through a persistent `di.ts --serve` process per root (`src/analyzer.rs`). `--watch` is event-driven (`src/watch.ts`, `build::watch_plan`). Both helper scripts are written to `<root>/node_modules/.cache/xzor/`.
- Generic component uses without `T=` hoist props into `const __pN` and infer `T` with a conditional type (zero runtime cost).
- Component styles (`src/style.rs`): `lib.rs::component_style` lowers the top-level `<style>` or sibling `X.css.xzor` and injects `data-xz` plus `--<id>-<n>`/`data-<id>-<n>` attributes into the AST's top elements, so the normal attribute codegen binds them; `build.rs` writes `.xzor/X.xzor.css` and `bundle.ts` appends its import at bundle time (never in the type-checked code).
- `xzor lsp` (`src/lsp/`): component features live in `features.rs`, and TypeScript regions are proxied to TypeScript 7's `tsc --lsp --stdio` through the mappings. Feature providers are registered dynamically for `xzor` only; `.ts` documents get live DI diagnostics and nothing else. JSON is hand-written in `json.rs`. Package components come from the tsconfig `paths` (`tsconfig_packages` in `lib.rs`), and attribute values complete from string-literal prop types (`string_values`), page ids and CSS classes.
- Package `.xzor` imports (`@source-crafter/xzor-ui/Button.xzor`) resolve through tsconfig `paths` to their source in the compiler too. `src/bundle.ts` is embedded in the binary: rebuild after editing it.
- The repo's own TypeScript (`src`, `runtime`, `tests`, ...) is typed by the root `jsconfig.json`: any `tsconfig.json` would be taken for an app root.
- Project tsconfigs need `"rootDirs": [".", ".xzor"]` and `".xzor/**/*.ts"` in `include`; DI projects also need `"ESNext.Disposable"` in `lib`.
- A `.xzor` must not import from `./main`: `rootDirs` resolves it to the generated `.xzor/main.ts`.
- The runtime is `runtime/index.ts` (`Component`, router, `mount`) and `runtime/dom.ts` (the `dom` bindings: top-level functions, re-exported as the `dom` namespace by `runtime/bindings.ts`, so unused ones leave the bundle; never collect them back into an object). Keep the generated code and the `dom` API in sync.
- Generated `.xzor/` folders are gitignored. Never edit them by hand.
