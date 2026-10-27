# Granular Hot Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** In `xzor dev`, saving a `.xzor` file updates the components it changed in the open page without a reload, keeping every component's state (field values, input focus, scroll); anything that can't be patched safely falls back to today's full reload.

**Architecture:** Patching is done in place on the original classes, so the diff's `o.type === n.type` keeps every instance. (1) `xzor build --watch --hot` prints `xzor: hot <id>` for each component whose generated code changed, only for batches that touched nothing but `.xzor` files, only after a passing check, and before the bundle's path lines. (2) With `--hot`, `src/bundle.ts` appends to each generated `.xzor.ts` one registration call passing its default-export class and a getter of its value imports. (3) A dev-only client (`npm/xzor/bin/hot.ts`) keeps the registry, tracks live instances by wrapping `onInitialized`/`dispose` on registered prototypes, and applies an update: evaluate the new module body with the registered imports, copy prototype methods and statics onto the old class, add missing fields from a probe instance, call `stateHasChanged()` on every live instance of it. (4) `xzor dev` serves that client, turns `hot` lines into one SSE message with the transpiled module bodies, and keeps sending `reload` otherwise.

**Tech Stack:** Rust std; Bun (`Bun.Transpiler`, `Bun.serve`); happy-dom for tests. No runtime package changes.

**Spec:** this plan (the user delegated the design: "go like that as you say"); the reload behavior it extends is `npm/xzor/bin/dev.ts`.

## Global Constraints

- Production output unchanged: without `--hot`, generated files and bundles are byte-identical to today; `runtime/index.ts` is not modified.
- Zero Rust crates; no new npm dependencies.
- Module id = the generated file's path relative to the project root, `/`-separated (e.g. `.xzor/Card.xzor.ts`); the same string in the `hot` line, the bundle registration and the SSE message.
- Hot line format: `xzor: hot <id>`, one per component, printed after the check passes and before the bundle's `  <path>` lines; never printed when the build fails.
- A batch is hot-eligible only if: every changed path is a `.xzor` file, nothing was removed or added, DI did not rerun, no config change, and `.xzor/routes.ts` did not change. Otherwise no hot lines (the page reloads as today).
- The client falls back to `location.reload()` when: the new module needs an import binding not registered; the new class's `extends` differs; the module text contains a `#private` name (`/(^|[^\w$"'`])#[A-Za-z_$]/`); evaluation or re-render throws; the id is unknown.
- Known limit, documented: arrow-function fields (`handler = () => ...`) keep their old closures until a reload.
- Dev-only memory: the registry holds one entry per component class; live-instance tracking removes instances on `dispose`.

## Review Focus

- Two quick saves of the same file: the second update applies on top of the first (patched classes keep working as the base of the next patch).
- A component edited while it isn't on the page: the update applies to the class; it renders the new markup when it next mounts.
- A parent and child both recompiled in one batch (dependents): one SSE message with both; the page ends consistent.
- An edit that adds a field with an initializer used in markup: existing instances get the initial value, no `undefined` in the page.
- A syntax error in the `.xzor`: no hot line, no reload, the page stays as it was.

---

### Task 1: `--hot` in the watch build

**Files:**
- Modify: `src/main.rs` (`--hot` parsing and `USAGE`; `Options.hot`; `watch_loop` eligibility and the hot id list; `finish` prints the hot lines)
- Modify: `src/build.rs` (`bundle` takes `hot: bool` and passes `--hot` as the bundle script's third argument; `write_routes` reports whether `routes.ts` changed)
- Test: `tests/watch.test.ts`

**Interfaces:**
- Produces: `xzor build --watch --hot`; `--hot` without `--watch` is an error `--hot needs --watch`. `pub fn bundle(dir: &Path, entry: &str, hot: bool) -> Result<String, String>`. `write_routes(...) -> Result<bool, String>` (true when any `routes.ts` was written or deleted). Hot ids are the recompiled units whose `generated.code` differs from the previous unit's (new units make the batch ineligible).

- [ ] **Step 1: Write the failing tests** in `tests/watch.test.ts`, following its existing spawn pattern but with `--hot` and bundling on (an `index`-less project with `main.ts` importing `App.xzor` is enough):
  - `hot lines for a .xzor-only change`: edit `App.xzor` text; the rebuild's stdout has `xzor: hot .xzor/App.xzor.ts` and it comes before the line ending in `main.js`.
  - `no hot lines when a .ts changes`: edit `main.ts` (append a comment); the rebuild prints the bundle lines and no `xzor: hot`.
  - `no hot lines on a compile error`: write `<p>` into `App.xzor`; no `xzor: hot`.
- [ ] **Step 2: Run** `bun test tests/watch.test.ts` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** per Interfaces and Global Constraints.
- [ ] **Step 4: Run** `cargo test` and `bun test` — expect PASS.
- [ ] **Step 5: Commit** `feat: build --watch --hot reports patchable components`.

### Task 2: Registration in hot bundles

**Files:**
- Modify: `src/bundle.ts` (`main(entry, outdir, hot)`; the `onLoad` for `.ts` appends the registration to generated `.xzor.ts` files when `hot`)
- Test: `tests/bundle-hot.test.ts`

**Interfaces:**
- Produces: `export function hotRegistration(ts: string, id: string): string` — returns `ts` plus one appended line:
  `;globalThis.__xzorHot?.register(<id JSON>, <DefaultClass>, () => ({ <value import locals> }));`
  Value import locals come from `new Bun.Transpiler({ loader: "ts" }).transformSync(ts)`'s import declarations (type-only imports are gone there); default class from `export default class (\w+)`. No default class → `ts` unchanged. Appending keeps every existing position, so the composed source maps stay exact.

- [ ] **Step 1: Write the failing tests**: (a) for the Card source above (imports `ComponentBase` value plus types), the appended line is exactly `;globalThis.__xzorHot?.register(".xzor/Card.xzor.ts", Card, () => ({ ComponentBase }));`; (b) `import X, { a as b } from "./x"` with both used yields `{ X, b }`; (c) no default class → unchanged; (d) bundling `examples/counter` with `hot` puts `__xzorHot` in `dist/main.js`, and without it the output has no `__xzorHot`.
- [ ] **Step 2: Run** `bun test tests/bundle-hot.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — expect PASS.
- [ ] **Step 5: Commit** `feat: hot bundles register component classes`.

### Task 3: Hot client

**Files:**
- Create: `npm/xzor/bin/hot.ts`
- Test: `tests/hot.test.ts` (happy-dom, like `runtime/*.test.ts`)

**Interfaces:**
- Consumes: Task 2's `register(id, cls, imports)` contract.
- Produces: `export function installHot(target: { __xzorHot?: unknown }): HotRegistry` where `HotRegistry = { register(id: string, cls: Function, imports: () => Record<string, unknown>): void; apply(update: { id: string; code: string }[]): boolean }`. `code` is JS: the module with import declarations removed and `export default class X` turned into `class X`, ending with `return X;` (Task 4 produces it). `apply` returns false after calling `target.location?.reload()` when any fallback condition holds; true otherwise. Updates in one call are all evaluated before any is applied.
- Instance tracking: a `Set` of live instances; registered prototypes get own `onInitialized` and `dispose` wrappers that add/remove `this` and call the previous method; re-wrapped after each patch.

- [ ] **Step 1: Write the failing tests** with the real runtime (`runtime/index.ts`) and `mount`:
  - `patches render and keeps state`: class `C` with `n = 0` and markup `<b>n:@n</b>`; mount, set `n = 5` via a click handler; apply new code rendering `<i>count @n</i>`; DOM shows `count 5`, same instance.
  - `adds new fields`: new code adds `label = "hi"` rendered; DOM shows `hi`.
  - `child keeps state when parent is patched`: parent renders a child with state; patch parent; child instance and its state unchanged.
  - `second patch applies on the first`.
  - `falls back`: missing import binding; `#private` member; throwing render — each calls `reload` and returns false.
- [ ] **Step 2: Run** `bun test tests/hot.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test` — expect PASS.
- [ ] **Step 5: Commit** `feat: hot client patches components in place`.

### Task 4: `xzor dev` wiring, docs, end to end

**Files:**
- Modify: `npm/xzor/bin/dev.ts` (spawn with `--hot`; collect `xzor: hot` ids per rebuild; on the bundle line send `data: {"hot":[{id,code}]}` if any ids, else `data: reload`; serve `/__xzor/hot.js`, built once at startup with `Bun.build` (`format: "iife"`) from a small entry that calls `installHot(globalThis)` and listens on `/__xzor/reload` (`reload` → `location.reload()`, `{hot}` → `apply`); inject it as a classic `<script src="/__xzor/hot.js"></script>` right after `<head>` so it runs before the app's module scripts; replaces today's inline reload script; `prepareModule(ts: string): string` exported)
- Modify: `npm/xzor/package.json` (`files` adds `bin/hot.ts`)
- Modify: the docs that describe `xzor dev` (find with a search for `live reload`; site, README, skill) — one short paragraph: what is patched, the fallbacks, the arrow-field limit
- Test: `tests/dev-hot.test.ts` for `prepareModule`

**Interfaces:**
- Consumes: Task 1's hot lines, Task 3's `installHot` and `apply`.
- `prepareModule(ts)`: `Bun.Transpiler` (`loader: "ts"`) output with import declarations removed, `export default class X` → `class X`, other `export ` keywords removed, then `\nreturn X;`.

- [ ] **Step 1: Write the failing test**: `prepareModule` on the Card source above has no `import`/`export`, contains `class Card extends ComponentBase`, ends with `return Card;`.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** `bun test` — expect PASS.
- [ ] **Step 5: End to end** (browser, `examples/counter` under `xzor dev`): increment the counter, type in an input, edit a `.xzor`'s markup text → page shows the new text, the counter value and the typed text are kept, no navigation happened (`performance.navigation`/a window marker survives); edit a `.ts` → full reload. Record what was checked in the report.
- [ ] **Step 6: Commit** `feat: xzor dev hot-patches edited components`.

## Later changes

- 2026-10-26: with a server entry, `xzor dev` runs the generated server in dev mode instead of the static file server, and restarts it on server-side `.ts` changes; `.xzor` edits keep patching in place. See [the @Run, @Routes, PSR and endpoints spec](../superpowers/specs/2026-10-26-run-routes-psr-design.md).
