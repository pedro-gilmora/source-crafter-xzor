# Client Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@page "/users/:id" as admin` routes (optional shared tag), a generated project route table (`.zor/routes.ts`) with typed `href` builders per page component, and the `@ClientRoutes(route) { … }` / `@ServerRoutes(route) { … }` block rendering in the browser (History API for client; match-once for server). Bun.serve output and per-page bundles are the next plan.

**Architecture:** Codegen records each component's routes and routes-block sections on `Generated`. A new Rust module `src/routes.rs` turns all units of a project into the TypeScript route table (precompiled matchers sorted by Bun precedence, typed `href`, tag/param types) plus project-wide diagnostics. Build/watch write it next to the generated components; the LSP syncs it to TypeScript in memory. The routes block compiles to one `RenderTreeBuilder.addRoutes(...)` call; the runtime renders it with an internal router component that publishes `route` through the existing cascade mechanism.

**Tech Stack:** Rust (no crates), TypeScript runtime, Bun tests with happy-dom, TextMate grammar.

**Spec:** `docs/superpowers/specs/2026-10-13-routing-cascading-design.md` §2–§5 (client part of §5) and rulings 1, 3, 4, 5, 6, 9.

## Global Constraints

- Pattern syntax (Bun.serve): starts with `/`; segments are literal, `:ident`, or a final `*`. Anything else is the compile error `invalid route pattern "<p>": <reason>`.
- Precedence (client = Bun): compare segment by segment, literal > `:param` > `*`; identical patterns (same shape) on two routes = compile error `duplicate route pattern "<p>" (also in <file>)`.
- `*` matches the rest of the path after its prefix, possibly empty; the matched text fills the page prop `rest` only if the page declares `rest`.
- Tags: `as <ident>`, optional, at most one per `@page`, shared by any number of routes (no default, no uniqueness). Reserved: `default`, `notFound`, `catch` = error `"<n>" is reserved in routes`. Two page components with the same class name in one project = error `duplicate page component "<C>" (also in <file>)`.
- Param conversion from the page's prop declaration text: `: number` or numeric initializer → `Number` (NaN = no match); `: boolean` or boolean initializer → `"true"`/`"false"` only; a union of string literals → must be one of them; else `string`. Values are `decodeURIComponent`ed.
- `href.<Component>(params)`: one function per page component with one TypeScript overload per `@page` of it, param type `{ [p in params]: Page["p"] }` (TypeScript checks it; no analyzer); the implementation picks the first of the component's patterns whose param names equal the given keys (`rest` included). Values `encodeURIComponent`ed; `*` rest via `rest`.
- Route table module path: `<project root>/.zor/routes.ts` (project root = nearest ancestor with `tsconfig.json`, as `build::project_root`). Components import it as the relative specifier from their source directory to `<root>/routes` (rootDirs). A real `<root>/routes.ts` is reserved (document it).
- Routes block: at most one per project (error `only one routes block per project (also in <file>)`). Only sections inside; other content = error `only route sections are allowed in @ClientRoutes`/`@ServerRoutes`. Sections: `@<tag>(page)` (page required), `@/re/flags(page?)` (client only; in server: `Bun.serve routes don't support regex; use a pattern`), `@"pattern"(page?)`, `@notFound` (no page), `@catch(e)`, `@default(page)` (page required, must be last: `@default must be the last section`). A tag no route uses: `no route tagged "<n>"`. `{` may be on the next line. Regexes are static constants.
- Matching order per spec §4 (page routes → `(page)` sections in order → `@default` → bare page; no page route → page-less sections in order → `@notFound` → nothing).
- Runtime: no `WeakMap`s added; the router is an internal component (like Blazor's `Router`); `route` is published with `openCascade("route", routeObject)`, a new object per navigation (methods on a class prototype, not closures). Page instance kept across param-only navigation (same pattern, same component): props re-set, `onParametersSet` runs.
- Client navigation intercepts `<a>` clicks: same origin, button 0, no ctrl/meta/shift/alt, no `target` other than `_self`, no `download`, not `rel~="external"`. `popstate` re-renders. `navigate(url, { replace })` uses `pushState`/`replaceState`. Server engine: match once on load, no listeners; `navigate` assigns `location.href`.
- `@catch(e)`: errors from the page's construction/DI arrival, `onInitialized`, rejected `onInitializedAsync`, first render. Implemented via a field on the page's `VComponent` checked on those paths, not a wrapper. Cleared on the next navigation.

## Review Focus

- `/users/new` (literal) beats `/users/:id`; `/users/:id` beats `/users/*` regardless of declaration order or file order (Task 2).
- Param-only navigation `/users/1` → `/users/2` keeps the page instance and runs `onParametersSet` once (Task 5).
- A routes block in a nested folder (`src/app/App.tszor`) imports the table with the right relative path (Task 4).
- Clicking `<a href="/x" target="_blank">` or with ctrl is not intercepted (Task 5).
- Removing the only `@page` of a project in `--watch` rewrites `.zor/routes.ts` (empty table) instead of leaving a stale one (Task 3).

---

### Task 1: `@page` patterns and tags in the parser and codegen

**Files:** Modify `src/ast.rs`, `src/parser.rs`, `src/codegen.rs`, `src/lsp/features.rs` (only where `doc.page` is read). Tests in those files.

**Interfaces:**
- Produces: `Document.pages: Vec<PageRoute>` replacing `page: Option<String>`; `pub struct PageRoute { pub pattern: Src, pub tag: Option<Src> }` (Src offsets point at the text inside the quotes / the tag).
- Produces: `pub fn validate_pattern(p: &str) -> Result<(), String>` and `pub fn param_names(p: &str) -> Vec<&str>` (rest = `"rest"`) in a new `src/routes.rs` (module registered in `lib.rs`), used by later tasks.
- Produces on `Generated`: `pub routes: Vec<RouteInfo>` with `pub struct RouteInfo { pub tag: Option<String>, pub tag_at: usize, pub pattern: String, pub pattern_at: usize, pub params: Vec<(String, ParamKind)> }` and `pub enum ParamKind { String, Number, Boolean, Union(Vec<String>) }` (both in `src/routes.rs`).

- [ ] **Step 1: Failing tests:** parser `parses_several_pages_with_tags` (`@page "/users/:id" as admin` + `@page "/a/*"` → two `PageRoute`s, the second without tag; `@page "/x" // c` still works); errors for bad patterns via `validate_pattern` (`"users"` no leading slash, `"/a/*/b"` star not last, `"/:1x"` bad ident). Codegen `routes_are_recorded_with_param_kinds`: page with `@code { id = 0; on: boolean = false; tab: "a" | "b" = "a"; slug = ""; }` and `@page "/p/:id/:on/:tab/:slug/*" as p` → params `id` Number, `on` Boolean, `tab` Union(["a","b"]), `slug` String, `rest` String (not declared → still listed as `rest`); tag `p`; a `@page` without `as` has `tag: None`. `static readonly route` keeps the first pattern.
- [ ] **Step 2:** `cargo test` fails. **Step 3:** implement. **Step 4:** `cargo test`, `bun test` pass.
- [ ] **Step 5: Commit** `feat: @page patterns and tags`.

### Task 2: Route table generation

**Files:** Modify `src/routes.rs`. Tests: unit tests there; `tests/routes-table.test.ts` (new) that writes a generated table to a temp dir and imports it with Bun to exercise matching.

**Interfaces:**
- Consumes: `RouteInfo`, `ParamKind`, `RoutesBlockInfo` (below; Task 4 fills it — define the type here).
- Produces: `pub struct RoutesBlockInfo { pub engine: Engine, pub at: usize, pub sections: Vec<(String, usize)> }` (tag sections: tag and offset), `pub enum Engine { Client, Server }`; `pub struct Unit<'a> { pub source: &'a Path, pub out: &'a Path, pub text: &'a str, pub class: &'a str, pub routes: &'a [RouteInfo], pub block: Option<&'a RoutesBlockInfo> }` (`text` gives line/col for diagnostics); `pub fn table(root: &Path, units: &[Unit]) -> (String, Vec<(PathBuf, crate::Diagnostic)>)` returning the module text and diagnostics keyed by the offending `.tszor`.
- Produces (TS module shape, consumed by the runtime in Task 5):
  ```ts
  import type { RouteTable } from "@zor/runtime";
  import UserPage from "./users/UserPage.tszor";
  export const routes: RouteTable = [{ tag: "admin", pattern: "/users/:id", component: UserPage, match: (s) => ... }];
  export const href = { UserPage: __href_UserPage };   // overloads: function __href_UserPage(p: { id: UserPage["id"] }): string; …
  export type RouteTag = "admin";
  export type RouteParams = { admin: { id: UserPage["id"] } };   // per tag: union of its routes' params
  ```
  `match(segments: string[])` gets `location.pathname.split("/").slice(1)` (empty trailing segment dropped) and returns the converted props object or `null`. Entries sorted by precedence.

- [ ] **Step 1: Failing tests:** Rust: `table_sorts_by_precedence` (entries order `/users/new`, `/users/:id`, `/users/*` whatever the input order), `duplicate_patterns_and_components_are_reported` (messages from Global Constraints, located at `pattern_at` / the class of the second unit), `shared_tags_are_allowed` (two pages `as admin` → no diagnostics; `RouteParams["admin"]` is the union), `reserved_tags`, `unknown_section_tags` (`no route tagged "x"` at the section offset), `one_routes_block_per_project`. Bun `tests/routes-table.test.ts`: a Rust test (`#[test] fn writes_table_fixture`) writes the table for a fixed unit set to `target/tmp-routes/routes.ts` with stub page modules beside it; the Bun test runs `cargo test writes_table_fixture` in `beforeAll` and imports it; assert `match` conversions (`"7"`→7, `"x"`→null for number; boolean; union; rest), precedence, `href` encoding and overload choice (`href.P({ id: 1 })` vs `href.P({ id: 1, rest: "a/b" })` for a page with `/p/:id` and `/p/:id/*`).
- [ ] **Step 2–4:** fail, implement, pass (`cargo test`, `bun test`).
- [ ] **Step 5: Commit** `feat: generated route table`.

### Task 3: Build and watch write the route table

**Files:** Modify `src/build.rs`, `src/main.rs`, `docs/design.md` (reserved `routes.ts`, rootDirs note). Tests in `src/build.rs`, `tests/watch.test.ts` (one added case).

**Interfaces:**
- Consumes: `routes::table`, `Generated.routes`, `Generated.routes_block: Option<RoutesBlockInfo>` (add the field now, filled in Task 4).
- Produces: `pub fn write_routes(root: &Path, units: &[Compiled]) -> Result<(), String>` — writes `<root>/.zor/routes.ts` with `write_if_changed` when any unit has routes or a block, deletes it when none; table diagnostics become build errors formatted like compile errors (`<path>:<line>:<col>: <message>`).

- [ ] **Step 1: Failing tests:** `write_routes_writes_and_removes` (two pages → file exists with both patterns; no pages → file removed); `table_errors_fail_the_build` (duplicate pattern → `Err` containing both file names); watch test: removing the only page rewrites/removes `.zor/routes.ts`.
- [ ] **Step 2–4:** fail; call `write_routes` after `compile_all` in `build`/`compile` and after each watch batch that recompiled or removed units (before DI and tsc); pass.
- [ ] **Step 5: Commit** `feat: build and watch write the route table`.

### Task 4: The routes block in the parser and codegen

**Files:** Modify `src/ast.rs`, `src/parser.rs`, `src/codegen.rs`, `src/lib.rs`, `src/routes.rs` (pattern matcher codegen shared with Task 2). Tests in those files.

**Interfaces:**
- Consumes: Task 1/2 types; runtime API from Task 5 (names fixed here):
  `RenderTreeBuilder.addRoutes(engine: "client" | "server", table: RouteTable, sections: readonly RouteSection[]): void` with
  ```ts
  type RouteSection =
    | { kind: "tag"; tag: string; render: (route: Route, page: RenderFragment) => RenderFragment }
    | { kind: "regex"; re: RegExp; page: boolean; render: (route: Route, page: RenderFragment) => RenderFragment }
    | { kind: "pattern"; match: (segments: string[]) => Record<string, string> | null; page: boolean; render: (route: Route, page: RenderFragment) => RenderFragment }
    | { kind: "notFound"; render: (route: Route) => RenderFragment }
    | { kind: "catch"; render: (route: Route, error: unknown) => RenderFragment }
    | { kind: "default"; render: (route: Route, page: RenderFragment) => RenderFragment };
  ```
- Produces: `Node::Routes { engine: Engine, var: Src, sections: Vec<RouteSectionNode> }`; `Generated.routes_block`.
- `compile_mapped_with` computes the table import specifier (relative from the source dir to `<root>/routes`, `/` separators, leading `./` or `../`) and passes it to codegen; codegen emits `import { routes as __routes, type RouteParams as __RouteParams } from "<spec>";` only when the component has a routes block. Section bodies are typed: tag sections get `route: Route<__RouteParams["<tag>"]>`, regex sections `route.match` typed from named groups, pattern sections `route.params` as a string record of the pattern's params. Regexes are emitted as `static readonly` fields; pattern-section matchers are emitted as static functions generated by the same Rust code as the table's.

- [ ] **Step 1: Failing tests:** parser: the spec §4 example parses (each section kind, `{` on next line); errors from Global Constraints (loose content, `@default` not last, `@admin` without `(page)`, `@notFound(page)`, regex in `@ServerRoutes`). Outside a routes block `@default`/`@notFound` are plain expressions. Codegen: emitted `addRoutes("client", __routes, [...])` shape for the example; import specifier from `src/app/App.tszor` with root `/p` is `"../../routes"`; regex static field; `routes_block` info has tag sections with offsets.
- [ ] **Step 2–4:** fail, implement, `cargo test` pass.
- [ ] **Step 5: Commit** `feat: routes block syntax`.

### Task 5: Runtime router, navigation, NavLink, @catch

**Files:** Modify `runtime/index.ts`; new `runtime/router.test.ts`.

**Interfaces:**
- Produces (exported from `@zor/runtime`): `type RouteTable`, `type RouteEntry`, `type RouteSection`, `class Route<P = Record<string, unknown>>` with `path`, `tag: string | undefined`, `params: P`, `query: URLSearchParams`, `match: Record<string, string>`, `is(tag: string): boolean`, `navigate(url: string, opts?: { replace?: boolean }): void`; `RenderTreeBuilder.addRoutes(...)` (signature above); `NavLink` component (props `href: string`, `activeClass = "active"`, `match: "prefix" | "exact" = "prefix"`, default slot = content); test hook `setNavigationForTests(nav: { current(): URL; navigate(url: string, replace: boolean): void; subscribe(fn: () => void): () => void } | undefined)`.

- [ ] **Step 1: Failing tests** (hand-written components and a hand-written table in the shape of Task 2): matching order (spec §4 all branches), param conversion via table `match`, same instance on param-only navigation (+1 `onParametersSet`), link interception rules (each excluded case), `popstate`, `navigate` replace vs push, `route` cascaded to a nested `@Cascade route` consumer (static `cascades`), `@catch` for each error source (sync ctor via DI app, `onInitialized` throw, `onInitializedAsync` reject, first render throw) and cleared on next navigation, server engine: no listeners, `navigate` sets `location.href`, NavLink active class prefix/exact.
- [ ] **Step 2–4:** fail, implement, `bun test` pass; `cargo run -q -- build examples/counter` still type-checks.
- [ ] **Step 5: Commit** `feat(runtime): router, navigation, NavLink, @catch`.

### Task 6: End to end and LSP

**Files:** New `tests/routing.test.ts`; modify `src/lsp/server.rs` (sync `.zor/routes.ts` to TypeScript as an in-memory document built from open/disk units; publish table diagnostics on the offending documents), `tests/lsp.test.ts`.

- [ ] **Step 1: Failing tests:** `tests/routing.test.ts` builds a temp project (pages `Home` `/`, `UserPage` `/users/:id as admin` and `AdminHome` `/admin as admin` with `id = 0` on `UserPage`, an `App` with `@ClientRoutes(route)` using `@admin(page)` (an admin layout), `@notFound`, `@default(page)`, and a `<a href="@href.UserPage({ id: 2 })">`), mounts the bundle in happy-dom, clicks the link, asserts the user page renders `2` inside the admin layout, navigates to `/nope` → not-found text. LSP test: diagnostic on `href.UserPage({ id: "x" })` reports a type error; duplicate route pattern across two open documents publishes the duplicate error.
- [ ] **Step 2–4:** fail, implement LSP sync (the route table is regenerated when a `.tszor` with `@page` lines or a routes block changes), pass `cargo test`, `bun test`.
- [ ] **Step 5: Commit** `feat: routing end to end and in the editor`.

### Task 7: Tooling and docs

**Files:** `editors/vscode/syntaxes/tszor.tmLanguage.json`, `editors/vscode/test/gen.ts` (+ regenerated test file), `src/lsp/features.rs` (completions: `@ClientRoutes`/`@ServerRoutes` snippets; inside a routes block: route tags, `notFound`, `catch`, `default`), `docs/design.md` (routing section: syntax, matching rules, engines, reserved `routes.ts`, limits).

- [ ] **Step 1:** Grammar tests: `@page "/users/:id" as admin` (`as` keyword, `admin` tag scope), `@ClientRoutes(route) {`, `@admin(page) {`, `@/^\/a/i(page) {` (regex scope `string.regexp.ts`), `@"/x/:y" {`, `@notFound {`, `@catch(e) {`, `@default(page) {`.
- [ ] **Step 2:** Completion unit tests in `features.rs`.
- [ ] **Step 3:** Implement; `cargo test`, `bun test`, `bun run test:grammar` pass.
- [ ] **Step 4: Commit** `feat(tooling): routing in grammar, completions and docs`.
