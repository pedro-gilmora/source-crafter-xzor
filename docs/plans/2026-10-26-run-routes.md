# `@Run` and `@Routes` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** Rename `@Mount` to `@Run` and `@ClientRoutes`/`@ServerRoutes` to `@Routes`, moving the navigation engine from the routes block to `@Run(App, "app", { navigation })`.

**Architecture:** The parser drops the engine from `Node::Routes`; codegen emits `addRoutes(table, sections)`; the runtime reads a module-level navigation mode set by `mount()`; the DI analyzer reads `@Run` and its literal options and passes the mode to the generated `mount()` call; the build rejects regex sections under server navigation.

**Tech Stack:** Rust (zero deps), TypeScript 7, Bun 1.4, happy-dom.

**Spec:** [docs/superpowers/specs/2026-10-26-run-routes-psr-design.md](../superpowers/specs/2026-10-26-run-routes-psr-design.md) (sections Browser entry, Routes block, Touches: Routing, DI, LSP, grammar).

## Global Constraints

- No aliases: `@Mount`, `@ClientRoutes`, `@ServerRoutes` are errors naming the replacement.
- Zero Rust dependencies; generated code allocates no more than hand-written code.
- `@Run` options must be an object literal; the only key this plan reads is `navigation: "client" | "server"` (default `"client"`).
- Docs ship in the same commit as the surface change (README, `docs/design.md`, `docs/site/pages`, `npm/xzor/skills/xzor/SKILL.md`).
- Commands: `cargo test`, `bun test ./runtime ./tests`, `bun run test:grammar`, `bun x tsc -p jsconfig.json --noEmit`, `bun run examples`, `bun run docs`.

## Review Focus

- `@Routes` used as an expression (`@Routes(x)` with no `{` after `)`) still renders as an expression: test in Task 1.
- A component named `Routes` (`<Routes />`, `@import Routes from "./Routes.xzor"`) keeps working next to an `@Routes(route) { }` block: test in Task 1.
- `@Run(App, "app", opts)` where `opts` is a variable: error "@Run options must be an object literal": test in Task 3.
- Server navigation with a regex section: one error at the section, naming the `@Run` file: test in Task 3.
- Old names in a `.ts` entry (`@Mount(`) and a `.xzor` (`@ClientRoutes(`): errors with the replacement, not a generic parse error: tests in Tasks 1 and 3.

---

### Task 1: Parser and codegen: `@Routes`

**Files:**
- Modify: `src/parser.rs` (lookahead ~418, arms ~601, `routes_block` ~989, `route_section` ~1041, tests ~2174-2274), `src/ast.rs` (~154), `src/routes.rs` (`Engine` ~163, `RoutesBlockInfo` ~170), `src/codegen.rs` (~517, ~1282, tests ~3743-3831)

**Interfaces:**
- Produces: `Node::Routes { var: Src, sections: Vec<RouteSectionNode> }` (no `engine`); `RoutesBlockInfo { at: usize, sections: Vec<(String, usize)>, regex: Option<usize> }` (`regex` = source offset of the first regex section); `Engine` removed; generated `__b.addRoutes(__routes, [`.

- [ ] **Step 1: Write failing parser tests** in `src/parser.rs`:
  - `routes_block_parses`: `@Routes(route) { @notFound { <p/> } }` gives `Node::Routes` with one section.
  - `old_routes_keywords_name_the_replacement`: `@ClientRoutes(route) { }` and `@ServerRoutes(route) { }` fail with `"@ClientRoutes was renamed to @Routes; navigation is set on @Run"` (and the same with `@ServerRoutes`).
  - `routes_without_a_block_is_an_expression`: `<p>@Routes(x)</p>` parses as an expression node.
  - `regex_sections_parse_in_routes`: `@Routes(r) { @/x/(page) { <p/> } }` parses (the server check moves to the build).
  - Update `routes_block_errors`, `a_second_routes_block_in_one_document_is_an_error`, `the_routes_header_needs_its_paren_on_the_same_line`, `the_route_variable_cannot_be_a_directive_word` to `@Routes`; error texts use `@Routes`.
- [ ] **Step 2: Run** `cargo test parser` and expect the new tests to fail.
- [ ] **Step 3: Implement.** The lookahead opens a block when the word is `Routes`, `(` follows on the same line, and the matching `)` is followed (after blanks and newlines) by `{`; `ClientRoutes`/`ServerRoutes` with `(` give the rename error; `routes_block(&mut self) -> PResult<Node>` and `route_section(&mut self) -> PResult<RouteSectionNode>` lose `engine` and `keyword`; remove `Engine`; `RoutesBlockInfo.regex` is filled where codegen builds it (~517).
- [ ] **Step 4: Write failing codegen test** `routes_block_emits_sections_for_the_runtime` asserts `__b.addRoutes(__routes, [\n`; delete the `"server"` assertion (~3831).
- [ ] **Step 5: Implement** the emission at ~1287: `self.line("__b.addRoutes(__routes, [");`.
- [ ] **Step 6: Run** `cargo test` and expect PASS except tests that compile examples or runtime code (fixed in Tasks 2-5).
- [ ] **Step 7: Commit** `feat(parser): @Routes replaces @ClientRoutes/@ServerRoutes`.

### Task 2: Runtime: navigation set by `mount()`, `Run` decorator

**Files:**
- Modify: `runtime/index.ts` (`addRoutes` ~672, `nav:` ~678, `mount` ~1517, decorators ~462, comments ~178/185/199/298/671), `runtime/router.test.ts`, every `runtime/*.test.ts` using `Mount`

**Interfaces:**
- Produces: `addRoutes(table: RouteTable, sections: readonly RouteSection[]): void`; `mount<C>(type: Ctor<C>, target: string | Element, app?: IApplication, navigation?: "server"): C` (sets module-level `let serverNavigation = navigation === "server"` before `construct`); `export const Run = (_component: Function, _target: string, _options?: { navigation?: "client" | "server" }): ClassDecorator => noop;` (`Mount` export removed).

- [ ] **Step 1: Write failing tests** in `runtime/router.test.ts`: `server navigation matches once and links load the page`: `mount(App, host, undefined, "server")` with an `@Routes` block; clicking a link does not call the history stub, and `route.navigate("/x")` assigns `location.href`. `client navigation is the default`: `mount(App, host)` intercepts the click.
- [ ] **Step 2: Run** `bun test ./runtime/router.test.ts`, expect FAIL.
- [ ] **Step 3: Implement**: `nav: serverNavigation ? undefined : nav`; rename tests' `addRoutes("client", ...)`/`"server"` calls and `Mount` imports.
- [ ] **Step 4: Run** `bun test ./runtime`, expect PASS.
- [ ] **Step 5: Commit** `feat(runtime): navigation mode comes from mount; Run decorator`.

### Task 3: DI analyzer and build: `@Run`, options, regex check

**Files:**
- Modify: `src/di.ts` (decorator kinds, `deco.kind === "Mount"` ~234), `src/di/model.rs` (`Mount`), `src/di/graph.rs` (ZDI07 ~89, ZDI04 wording), `src/di/emit.rs` (~405), `src/build.rs` (`declares_provider` ~647, after DI: regex check), `tests/di.test.ts`, `tests/fixtures/di/main.ts`, `tests/fixtures/lsp-di/main.ts`, `tests/bundle-strip.test.ts`, `tests/cli.rs`

**Interfaces:**
- Consumes: `RoutesBlockInfo.regex` (Task 1), `mount(..., navigation?)` (Task 2).
- Produces: model `Mount { component, target, at, navigation: Option<String> }`; generated `mount(App, "app", new Application$())` unchanged for client, `mount(App, "app", new Application$(), "server")` for server.

- [ ] **Step 1: Write failing tests** in `tests/di.test.ts`:
  - `@Run(App, "app")` generates the same entry `@Mount` did.
  - `@Run(App, "app", { navigation: "server" })` generates `mount(App, "app", new Application$(), "server");`.
  - `@Run(App, "app", opts)` reports `@Run options must be an object literal` at `opts`.
  - `@Mount(App, "app")` reports `@Mount was renamed to @Run`.
  - two `@Run` classes report ZDI07 `@Run is declared on more than one class: A, B`.
- [ ] **Step 2: Run** `bun test ./tests/di.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** in `src/di.ts`, `model.rs`, `emit.rs`, `graph.rs`; `declares_provider` matches `@ServiceProvider(`, `@Run(` and `@Mount(` (so the rename error is reported).
- [ ] **Step 4: Write failing test** in `tests/routing.test.ts`: a project with `@Run(App, "app", { navigation: "server" })` and `@Routes(r) { @/x/(page) { <p/> } }` fails `xzor build` with `Bun.serve routes don't support regex; use a pattern` at the regex section's line in the `.xzor`.
- [ ] **Step 5: Implement** the check in `src/build.rs` after DI: when the entry's mount has `navigation == Some("server")` and a unit's `RoutesBlockInfo.regex` is `Some(at)`, report at that unit and offset.
- [ ] **Step 6: Run** `cargo test` and `bun test ./runtime ./tests`, expect PASS except example/doc builds (Task 5).
- [ ] **Step 7: Commit** `feat(di): @Run replaces @Mount; navigation option; server navigation rejects regex sections`.

### Task 4: Editors

**Files:**
- Modify: `src/lsp/features.rs` (~463, test `routes_block_directives_complete` ~847), `editors/vscode/syntaxes/xzor.tmLanguage.json` (~203), `editors/vscode/test/gen.ts` (~118-133), then regenerate `editors/vscode/test/syntax.test.xzor` via `bun editors/vscode/test/gen.ts`

- [ ] **Step 1: Write failing test**: `routes_block_directives_complete` expects one item, label `Routes`, insert `Routes(${1:route}) {\n\t$0\n}`, detail `Routes block (navigation is set on @Run)`.
- [ ] **Step 2: Run** `cargo test routes_block_directives_complete`, expect FAIL.
- [ ] **Step 3: Implement** the snippet; grammar `begin` becomes `(?<![[:alnum:]])(@)(Routes)[ \\t]*(?=\\()` and its comment `@Routes(route) { sections }`; `gen.ts` cases use `@Routes(route) {` and drop the `@ServerRoutes` case.
- [ ] **Step 4: Run** `cargo test`, `bun editors/vscode/test/gen.ts`, `bun run test:grammar`, expect PASS.
- [ ] **Step 5: Commit** `feat(editor): @Routes completion and grammar`.

### Task 5: Migrate examples, templates and docs

**Files:**
- Modify: `examples/{blog,counter,dashboard,sales}/main.ts` and `Routes.xzor`, `npm/xzor/bin/init.ts`, `tests/*` still using old names, `README.md`, `docs/design.md` (Routing, The application: `@Run`), `docs/site/pages/*.xzor` and snippets, `npm/xzor/skills/xzor/SKILL.md`

- [ ] **Step 1:** `grep -rn "ClientRoutes\|ServerRoutes\|@Mount\|Mount," --include=*.{ts,xzor,md,rs}` outside `docs/plans` and `docs/superpowers` lists only historical docs.
- [ ] **Step 2:** `design.md` Routing documents `@Routes` and `navigation` on `@Run`; the DI section's "The application" heading becomes `@Run`; compile every changed snippet (`bun run docs`).
- [ ] **Step 3: Run** all commands in Global Constraints; expect all PASS, `bun run examples` and `bun run docs` with no errors.
- [ ] **Step 4: Commit** `refactor: @Run and @Routes across examples, templates and docs`.
