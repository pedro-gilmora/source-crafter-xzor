# xzor feature map

One row per feature: where its decisions live, its code, its tests and its user docs. Keep it current (spec-rehydration step 4).

User docs everywhere means: `README.md`, `docs/site/pages/*.xzor`, `npm/xzor/skills/xzor/SKILL.md`, and `.github/skills/xzor-ui/SKILL.md` for the kit.

| Feature | Decisions | Code | Tests |
|---|---|---|---|
| Template syntax and directives (`@if`, `@for`, `@switch`, `@show:*`, `@pause`, `@await`, `@bind`, `@key`, `@ref`, `@attributes`, `@once`, `@leave`, `@async`, `@cached`) | design.md Syntax; plans 2026-10-23-show-blocks | `src/parser.rs`, `src/ast.rs`, `src/codegen.rs` | parser/codegen unit tests, `tests/compile.rs` |
| Components (rendering, bindings, child components, regions, events, lifecycle, cached getters, `@Volatile`, hot rebuild) | design.md Components: rendering and bindings; specs 2026-10-30-one-renderer-design; plans 2026-10-16-fine-components | `src/codegen.rs`, `runtime/dom.ts`, `runtime/index.ts` | `runtime/dom.test.ts`, `runtime/component.test.ts`, `runtime/lifecycle.test.ts`, `runtime/index.test.ts` |
| Slots and markup values (`RenderFragment`, `@slot`) | design.md Markup as values, Slots; specs 2026-10-30-one-renderer-design | `src/codegen.rs` (`slot_lambda`, `fragment_of`), `runtime/dom.ts` (`slotAt`, content regions), `runtime/index.ts` (`Component.fragment`) | `runtime/fragment.test.ts`, `runtime/template.test.ts` |
| Cascading values (`@cascade`, `@Cascade`) | specs 2026-10-13-routing-cascading-design | `src/parser.rs`, `src/codegen.rs`, `runtime/dom.ts` (`cascadeAt`), `runtime/index.ts` (`$cascade`) | `runtime/cascade.test.ts`, `tests/cascade.test.ts` |
| Inherited members (`@inherits`) | specs 2026-10-13-inherited-members-design | `src/inherit.rs` | `tests/inherits.test.ts` |
| Generic components (`T=`, hoisted props) | design.md Conventions | `src/codegen.rs` | `tests/typeparam.test.ts` |
| `@module` | design.md Module code | `src/parser.rs`, `src/codegen.rs` | codegen unit tests |
| Component styles (`<style>`, `X.css.xzor`, `@scope`, reactive values, `@if` rules) | design.md Component styles; plans 2026-10-17-module-styles-vs | `src/style.rs`, `src/lib.rs` (`component_style`), `src/bundle.ts` | style unit tests |
| Routing (`@page`, `@Routes` block, `href`, `NavLink`, view transitions, base path) | specs 2026-10-13-routing-cascading-design; plans 2026-10-13-client-routing | `src/routes.rs`, `src/parser.rs` (routes block), `src/codegen.rs` (`dom.routesAt`), `runtime/dom.ts` (`routesAt`), `runtime/index.ts` (router, `NavLink`) | `runtime/router.test.ts`, `tests/routing*.test.ts`, `tests/routes-table.test.ts`, `tests/route-types.test.ts` |
| Dependency injection (`@ServiceProvider`, lifetimes, `@inject`, `@Run` application, scopes, async services) | specs 2026-10-12-di-bootstrap-design; plans 2026-10-12-di | `src/di.ts`, `src/di/`, `src/analyzer.rs`, `src/build.rs` | `runtime/di.test.ts`, `tests/di.test.ts`, `tests/example-di.test.ts` |
| Models and validation (trackable models, `EntitySet`; `/model` reports to the core in the main entry and installs nothing into components) | plans 2026-10-15-trackable-models | `src/entities.rs`, `runtime/model.ts`, `runtime/entity-set.ts` | `runtime/model*.test.ts`, `runtime/entity-set.test.ts`, `runtime/validation.test.ts`, `tests/bundle-model.test.ts` |
| Build pipeline (compile, tsc check, error mapping, source maps, parallel build) | design.md Build; plans 2026-10-14-parallel-build | `src/build.rs`, `src/lib.rs`, `src/main.rs` | `tests/cli.rs`, `tests/compile.rs` |
| Bundle and `--minify` (chunks, CSS folding, fonts, map composition) | design.md Components (`--minify`), Build | `src/bundle.ts` (embedded: rebuild after edits) | `tests/bundle*.test.ts` |
| Page shells (PSR) | specs 2026-10-26-run-routes-psr-design; plans backlog-page-shells | `src/bundle.ts` (`pageShells`, `compressOutputs`), `src/routes.rs` (`pages`), `runtime/server.ts` (`serveDist`), `npm/xzor/bin/serve.ts` | `tests/bundle-shells.test.ts`, `tests/bundle-pwa.test.ts`, `tests/serve.test.ts` |
| Server entry and endpoints (`@Run()` server, `IServerApplication`, `@Endpoints`, `Request` scope, serving) | specs 2026-10-26-run-routes-psr-design; design.md Server apps | `runtime/server.ts`, `src/di.ts`, `src/di/` (`graph.rs`: ZDI13-ZDI21, `emit.rs`: server entry, `client.ts`), `src/build.rs`, `src/bundle.ts` (`dist/server.js`), `npm/xzor/bin/dev.ts`, `npm/xzor/bin/serve.ts`, `runtime/server.ts` (`serveDist`, cache headers) | `runtime/server.test.ts`, `tests/server.test.ts`, `tests/serve.test.ts`, `tests/di.test.ts`, `tests/dev-hot.test.ts` |
| Contracts and clients (`Remote<T>`, generated HTTP clients, `@inject` of a contract) | specs 2026-10-26-run-routes-psr-design; plans 2026-10-26-contracts-clients; design.md Server apps (Contracts and clients) | `runtime/index.ts` (`Remote`, `call`, `HttpError`), `src/di.ts`, `src/di/` (`graph.rs`: ZDI23-ZDI25, `emit.rs`: `.xzor/clients/`, in-process adapter), `src/codegen.rs` (`@inject` typed `Remote<...>`), `src/build.rs`, `examples/blog` | `runtime/index.test.ts`, `tests/di.test.ts`, `src/codegen.rs` and `src/di/graph.rs` unit tests, `tests/lsp.test.ts`, `tests/blog.test.ts` |
| Watch, hot reload, `xzor dev` | design.md Build; plans 2026-10-14-hot-reload | `src/watch.ts`, `src/build.rs` (`watch_plan`), `npm/xzor/bin/dev.ts`, `hot.ts`, `hot-client.ts` | `tests/watch*.test.ts`, `tests/hot.test.ts`, `tests/dev-hot.test.ts`, `tests/bundle-hot.test.ts` |
| PWA (`manifest.webmanifest`, `sw.js`) | plans 2026-10-14-pwa, backlog-pwa | `src/build.rs` | `tests/bundle-pwa.test.ts` |
| `xzor init` templates | - | `npm/xzor/bin/init.ts` | `tests/init.test.ts` |
| Language server (completion, hover, definition, rename, diagnostics, semantic tokens, `syntaxTokens`) | specs 2026-10-11-lsp-design; plans 2026-10-11-lsp | `src/lsp/` | `tests/lsp.test.ts`, lsp unit tests |
| VS Code extension and TextMate grammar | design.md Editor | `editors/vscode/` | `bun run test:grammar` |
| Zed extension | design.md Editor | `editors/zed/` | `cargo check` in `editors/zed` |
| `xzor highlight` | - | `src/highlight.rs` | highlight unit tests |
| xzor-ui kit | specs 2026-10-17-design-kit-design; `.github/skills/xzor-ui/SKILL.md` | `ui/` | `tests/ui.test.ts` |
| Examples | - | `examples/{counter,dashboard,blog,sales}` | `bun run examples` |
| Docs site | - | `docs/site/` | `bun run docs` |
| Packaging and release (npm packages, CLI launcher, CI) | `.github/copilot-instructions.md` Deploy | `Package.ps1`, `npm/`, `.github/workflows/dev.yml` | `./Package.ps1 -test true` |

## Cross-cutting aspects

Walk these for every spec; each one hit gets its own `## Touches` subsection.

- **Surface names**: keywords, directives, decorators, runtime exports, CLI flags. A rename reaches the parser, codegen, runtime, LSP completion, TextMate grammar, Zed queries, `xzor highlight`, examples, `xzor init` templates, the kit, tests and all docs.
- **Generated code shape**: `.xzor/*.xzor.ts`, `.xzor/routes.ts`, `.xzor/<entry>`, providers. Must stay in sync with the runtime API, type-check under tsc, and keep source mappings for the LSP.
- **Perf and memory**: no allocation beyond hand-written code, fields over `WeakMap`s and closures; measured by the `perf` agent at design, plan, implementation and review.
- **Errors and diagnostics**: compiler messages, tsc error mapping, DI diagnostic codes (`ZDI..`), LSP diagnostics.
- **Build modes**: plain, `--minify`, `--watch`, `--hot`, `xzor dev`, PWA; each may need its own behavior.
- **Editors**: VS Code, Zed, and the LSP features both share.
- **Compatibility**: tsconfig rules (`rootDirs`, `paths`, `ESNext.Disposable`), sub-path deploys (`<base href>`), package imports through `paths`.
- **Zero Rust dependencies** and the Windows GNU toolchain limits.
- **Docs**: every user doc listed above, plus `docs/design.md` and this map.
