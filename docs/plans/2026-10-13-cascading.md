# Cascading Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@cascade:name(value[, fixed]) { body }` provides a value to every component rendered inside `body`; `@Cascade prop!: T` / `@Cascade("name") prop!: T` in `@code` receives it.

**Architecture:** The provider is a region vnode carrying a cascade record (`name`, `value`, `fixed`, consumers, parent record). The render walk threads the current innermost record down through `create`/`patch`/`mountComponent` and stores it on `Mounted`, so `update()` re-renders with the right scope. Consumers resolve once on creation/arrival and subscribe; a changed provider value re-sets only its consumers. Codegen turns `@Cascade` decorators into a static `cascades` list and blanks the decorator text (no decorator runtime cost).

**Tech Stack:** Rust (parser/codegen, no crates), TypeScript runtime (`runtime/index.ts`), `bun test` with happy-dom, TextMate grammar.

**Spec:** `docs/superpowers/specs/2026-10-13-routing-cascading-design.md` §1 and ruling 7.

## Global Constraints

- Memory and performance first: no `WeakMap`, no wrapper components, no per-render allocations beyond the provider record (one per provider vnode, reused across renders by carrying it from the old vnode like `anchor`).
- Matching is by name; nearest provider wins; no provider leaves the property untouched (`undefined` unless initialized).
- `fixed` providers never record consumers.
- A consumer whose provider value changes (`!Object.is`) gets the new value assigned, `onParametersSet`/`onParametersSetAsync` run, then it re-renders — same path as a prop change.
- A disposed consumer is removed from its provider's consumers.
- `@Cascade` needs no import; it is zor syntax inside `@code`. Generated code contains no decorator call.
- Runtime API names (fixed, used by codegen): `RenderTreeBuilder.openCascade(name: string, value: unknown, fixed?: boolean): void` closed by `closeRegion()`; `static readonly cascades: readonly (readonly [prop: string, name: string])[]` on the component class.

## Review Focus

- A consumer inside a component that re-renders on its own (`stateHasChanged`) keeps the right scope (Task 1).
- Nested providers with the same name: the inner one wins; changing the outer value does not touch consumers of the inner one (Task 1).
- An async (DI) consumer that arrives after the provider value changed gets the current value (Task 1).
- `@Cascade` inside a string or comment in `@code` is not treated as a decorator (Task 2).
- `@cascade:x(a ? b : c, fixed)` and values containing commas inside calls/objects (`f(a, b)`, `{ a, b }`) parse as one value (Task 2).

---

### Task 1: Runtime cascade providers and consumers

**Files:**
- Modify: `runtime/index.ts`
- Test: `runtime/cascade.test.ts` (new; components hand-written the way codegen will emit them)

**Interfaces:**
- Produces: `openCascade(name, value, fixed?)` on `RenderTreeBuilder`; recognition of `static cascades` on component classes.

- [ ] **Step 1: Failing tests** in `runtime/cascade.test.ts`:
  - `a consumer receives the nearest provider's value`: `Root` provides `theme = "dark"` around `Child` (static `cascades = [["theme","theme"]]`) which renders `@theme`; text is `dark`. Nested `openCascade("theme","inner")` around a second child → `inner`.
  - `changing the provider re-renders only its consumers`: Root has `theme` field and a non-consumer sibling counting renders; set `theme="light"`, `stateHasChanged()`; consumer shows `light`, its `onParametersSet` ran once more, sibling not re-rendered beyond Root's own pass semantics (assert consumer render count +1, non-consumer child with unchanged primitive props not re-rendered).
  - `fixed providers do not update consumers`: `openCascade("cfg", v, true)`; change v and re-render Root; consumer keeps the first value.
  - `consumer re-rendering itself keeps its scope`: consumer `stateHasChanged()` after a grandchild consumer was added inside it — grandchild still resolves.
  - `disposed consumers are unsubscribed`: render consumer conditionally in a region; remove it; change value; no error and the disposed instance is not updated (its render count unchanged).
  - `missing provider leaves the field`: consumer with initializer `theme = "none"` and no provider → `none`.
  - `async consumer gets the current value on arrival`: an `IApplication` whose `createComponent` resolves later (pattern in `runtime/di.test.ts`); change provider value before resolution; arrived consumer shows the new value.
- [ ] **Step 2:** `bun test runtime/cascade.test.ts` — fails (`openCascade` missing).
- [ ] **Step 3: Implement.** `VRegion` gains an optional `cascade` record `{ name, value, fixed, consumers: ComponentBase[] | undefined, parent: record | undefined }`. `Mounted` gains the scope record it was created in. `create`/`patch`/`patchList`/`mountComponent`/`arrive`/`update` pass the innermost record (a region with `cascade` sets it for its children). Consumers resolve in `create` (sync) and `arrive` (async), before `mountComponent`. On region patch: carry the record from the old vnode, and if the value changed and not fixed, update each consumer (assign, `parametersSet`, `update`) after patching the region's children. Unsubscribe in `dispose`. Keep existing public API unchanged otherwise.
- [ ] **Step 4:** `bun test` — all pass.
- [ ] **Step 5: Commit** `feat(runtime): cascading values`.

### Task 2: `@cascade` and `@Cascade` in the compiler

**Files:**
- Modify: `src/ast.rs`, `src/parser.rs`, `src/codegen.rs`
- Test: unit tests in those files; `tests/cascade.test.ts` (new, end-to-end: builds a temp project with `cargo run -- build` like `tests/inherits.test.ts`, mounts it with happy-dom and checks output)

**Interfaces:**
- Consumes: Task 1 runtime API (Global Constraints).
- Produces: `Node::Cascade { name: Src, value: Src, fixed: bool, body: Vec<Node> }`.

- [ ] **Step 1: Failing tests:**
  - parser `parses_cascade_blocks`: `@cascade:theme(currentTheme) { <A/> }` → name `theme`, value `currentTheme`, fixed false; `@cascade:cfg(f(a, b), fixed)` → value `f(a, b)`, fixed true; `@cascade:x(a ? b : c)` value whole. Errors: `@cascade(x) {}` → `expected a name after @cascade:`; `@cascade:x(a, b) {}` → `the second @cascade argument must be fixed`; missing body → `expected { after @cascade:x(...)`.
  - codegen `cascade_blocks_open_a_cascade_region`: with `@code { theme = "dark"; }` the output contains `__b.openCascade("theme", this.theme);` … `__b.closeRegion();` and the value is source-mapped.
  - codegen `cascade_decorators_become_a_static_list`: `@code { @Cascade theme!: string; @Cascade("route") r?: unknown; }` → `static readonly cascades = [["theme", "theme"], ["r", "route"]] as const;`, the generated class has fields `theme!: string;` and `r?: unknown;` with no `@Cascade` text left, and `member_decls` yields `theme` and `r` (not `Cascade`). `"@Cascade x"` inside a string in `@code` is untouched.
  - `tests/cascade.test.ts`: `App.tszor` provides `theme` from a field and has a button that toggles it; `Badge.tszor` declares `@Cascade theme!: string` and renders it; after click the badge text changes.
- [ ] **Step 2:** `cargo test` / `bun test tests/cascade.test.ts` — fail.
- [ ] **Step 3: Implement.** Parser: `@cascade:` in template context (same contexts as `@if`); split args at the top-level comma (respect brackets, strings, templates, regex via existing helpers). Codegen: emit `openCascade` with the value through the existing expression rewrite + mapping; blank `@Cascade` / `@Cascade("…")` decorator text in `@code` with spaces (lengths and mappings preserved) and emit the static list; teach `member_decls` to skip decorators (`@ident` with optional `(...)`) so names stay right everywhere it is used.
- [ ] **Step 4:** `cargo test`, `bun test` — pass.
- [ ] **Step 5: Commit** `feat: @cascade blocks and @Cascade members`.

### Task 3: Tooling and docs

**Files:**
- Modify: `editors/vscode/syntaxes/tszor.tmLanguage.json`, `editors/vscode/test/gen.ts` (+ regenerated `syntax.test.tszor`), `src/lsp/features.rs` (directive completions), `docs/design.md`

- [ ] **Step 1:** Grammar tests in `gen.ts`: `@cascade:theme(currentTheme) {` → `@` `keyword.control.transition.tszor`, `cascade` `keyword.control.tszor`, `theme` `entity.name.function.slot.tszor`-style name scope (`variable.other.constant.cascade.tszor`), `currentTheme` `variable.other.readwrite.ts`; `@cascade:cfg(f(a, b), fixed) {` → `fixed` `keyword.other.fixed.tszor`. In `@code`: `  @Cascade theme!: string;` → `@Cascade` `entity.name.function.decorator.ts` (TS grammar's decorator scope; assert whatever the embedded TS grammar yields for decorators).
- [ ] **Step 2:** `bun run test:grammar` fails; implement grammar rule (model on the `slot` rule); passes.
- [ ] **Step 3:** LSP: add `cascade` to template-position completions with snippet `cascade:$1($2) {\n\t$0\n}` and detail `Cascading value for the components inside`; add a unit test next to the existing completion tests in `features.rs`.
- [ ] **Step 4:** `docs/design.md`: syntax table rows for `@cascade:name(value[, fixed]) { }` and `@Cascade` / `@Cascade("name")`, the by-name/unchecked note (spec ruling 7).
- [ ] **Step 5:** `cargo test`, `bun test`, `bun run test:grammar` pass. Commit `feat(tooling): cascading values in grammar, completions and docs`.
