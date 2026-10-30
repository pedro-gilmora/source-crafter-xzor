# One renderer: implementation plan

Spec: [docs/superpowers/specs/2026-10-30-one-renderer-design.md](../superpowers/specs/2026-10-30-one-renderer-design.md) (binding authority). Branch: `feat/one-renderer`. Perf baseline and re-run commands: `target/one-renderer-bench/baseline.md`.

## Global constraints

- TDD: a failing test first for each behavior added or moved; run it red, then green.
- Every task ends green on: `cargo test`, `bun test ./runtime ./tests`, `bun x tsc -p jsconfig.json --noEmit`, `bun run ui`, `bun run examples`, `bun run docs`, `bun run test:grammar`. Run each and read the output. `src/bundle.ts` is embedded: `cargo build` after editing it. Never edit generated `.xzor/` folders.
- Commit at least once per task, and checkpoint-commit (`wip: ...`) whenever a sub-step is green, so a stopped run loses nothing.
- Perf and memory rules (`.github/copilot-instructions.md` Conventions): fields on existing objects, no `WeakMap`s/wrappers/extra closures, no allocation per update beyond the spec's props object. No accessor added to a tracked getter's read path except `Model.$reader`'s forwarding (spec).
- Surface: `.xzor` syntax and the documented runtime API (lifecycle hooks, `stateHasChanged`, `EventCallback`, `NavLink`, `Route`, `viewTransitions`, `mount`, `lazy`, DI decorators, models) keep working unchanged.
- Zero Rust dependencies.
- Comments: one short line, only for what code can't show.

## Task 1: reactivity core and renderer in the main entry

Goal: components no longer depend on `/model` for reactivity; renderer renamed; behavior identical.

1. `git mv runtime/fine.ts runtime/dom.ts`, `runtime/fine.test.ts` -> `runtime/dom.test.ts`. Rename the exported object `fine` -> `dom` (and `El` stays). Update the file header comment (no "fine" wording in names; prose may say "bindings").
2. Move the change queue from `runtime/model.ts` (`changed`, `flush`, `queued`, `$notify`, `$flush`) into the core so `dom.ts` imports it from `./index` (or a new internal `runtime/track.ts` re-exported by nothing public). `dom.ts` must not import `./model`.
3. Reader slot (spec): `ComponentBase.$reader` becomes a plain static field written by `dom.ts`'s `Binding#run`/`untracked`/root build (today they write `Model.$reader`). `Model` gets `static get $reader()`/`set $reader(v)` forwarding to `ComponentBase.$reader`. Remove `setTracking`'s reader forwarding; keep `same` working (`ComponentBase.same` must not need `/model`: move `Model.same`'s comparison or make the core's default correct for components).
4. `runtime/index.ts` imports `./dom` statically (side-effect: installs the hooks today set by `setFineHooks`). Watch the import cycle: `dom.ts` must not touch `index.ts` exports at module-evaluation time (no top-level `ComponentBase` use, e.g. the `FineComponent` alias: delete it).
5. `/model` re-exports: drop `FineComponent`, `fine`, `El` from `runtime/model.ts`; export `dom` and `type El` from `runtime/index.ts` (marked `@internal`).
6. Codegen: generated components import `dom`/`El` from `@source-crafter/xzor-runtime` (not `/model`) and call `dom.*`. Update `src/codegen.rs` strings and its tests; `src/build.rs` tsconfig `paths` stays.
7. `src/bundle.ts` tracked-field rewrite (`modelLocals`): recognizes the same bases as today; remove `FineComponent`.
8. Packaging: `Package.ps1` builds the runtime entries (`runtime/index.ts runtime/model.ts`): check `dom.ts` lands in the right chunk; `npm/runtime/package.json` exports unchanged.
9. Perf check (perf agent): fine cells and rows cell vs baseline, no regression.

## Task 2: `Component`

1. Rename the class `ComponentBase` -> `Component` in `runtime/index.ts`; `export { Component as ComponentBase }` plus `/** @deprecated use Component */` type alias so old imports keep compiling.
2. Generated code extends `Component`; codegen, `src/bundle.ts` (`modelLocals` accepts `Component` and `ComponentBase`), `src/lib.rs` test, `src/inherit.rs` if it names it, `examples/counter/pages/PageBase.ts`, tests that import `ComponentBase` (keep a couple on the alias to pin it).
3. LSP: any completion/hover text naming `ComponentBase`.

## Task 3: the renderer mounts components, fragments, slots, cascades, routes, attributes, modifiers (runtime only)

New `dom` primitives in `runtime/dom.ts`, with tests in `runtime/dom.test.ts` written as the compiler will emit (`class X extends Component { protected override render(__p: Node) { ... } }`). The vDOM and the old codegen stay untouched in this task, so everything else stays green; the new primitives are additive.

1. Root: a component's own DOM build. Add `protected render(parent: Node): void` to `Component` (non-abstract default throws, until Task 4 makes it abstract). Root mounting through `dom`: `mount(type, target, app)` builds via `render` when the class overrides `render` (vDOM path otherwise, until Task 5). Instance fields hold the root holder (bindings, start/end comments, app, scope, loose list created on first use); no `WeakMap`.
2. `stateHasChanged()` on a `render` component: `shouldRender()` check, whole-component pass (today's `refreshAll` + memo reset), then `onAfterRender(false)` after the outermost pass.
3. `dom.component(end: Comment, type, props: () => Record<string, unknown>, statics?: Record<string, unknown>, slots?: object, ref?: (c) => void)`: COMPONENT binding per spec (diffed props in `data`, statics and slots assigned once, change rule, `onParametersSet`, child pass, slots force a pass on parent passes, DI/lazy/cached/cascades/`@catch`/transition waits ported from `index.ts`'s `createComponent`/`arrive`/`revive`/`keep`/`failedComponent`/`settle`/`collect`; dispose like `dispose(VComponent)`). Child end marker = the binding's anchor. Also `dom.componentItem` for list rows if the row's shared reads need it (follow the `textItem` pattern).
4. Fragments: `Component.fragment(build: (parent: Node) => void)` returns a branded build function remembering its creator's holder context. Keep the old builder-shaped `ComponentBase.fragment` working for the vDOM until Task 5 (two brands; `dom` treats only the new one as DOM fragments).
5. Content: a TEXT binding whose value is a new-shape fragment becomes a content region (`#becomeContent`), and back to text when the value is not markup. Old-shape fragments keep the island path until Task 5.
6. `dom.slotAt(end, read: () => Fragment | undefined, fallback?: Build)`: region building the slot fill or the fallback.
7. `dom.cascadeAt(end, name, value: () => unknown, fixed: boolean, build: Build)`: region whose holder carries a scope record; consumers resolved by `dom.component` from the holder chain; value change: assign + `onParametersSet` + pass, as `notifyCascade`.
8. `dom.routesAt(end, table, sections)`: router state per spec (move `Router`, `resolveRoute`, navigation subscription, `@catch`); sections' `render` take/return new fragments; page via `dom.component` keyed by `family ?? pattern` with `nav` stamping as today.
9. `dom.attrs(el, read)` (`@attributes`): previous bag in data; set new, remove missing keys.
10. `dom.on(el, event, handler | undefined, mods: number)` modifiers bitmask (1 preventDefault, 2 stopPropagation); `dom.onItem` too.
11. Perf check (perf agent) on a hand-written rows cell using `dom.component` (target/one-renderer-bench).

## Task 4: codegen emits only `dom` (no islands)

1. `src/codegen.rs`: generate `protected override render(__p: Node): void { ... }` (no `buildRenderTree`, no `addFine`). Components, slot fills, `@slot`, markup values (`Component.fragment((__p) => ...)` new shape), `@cascade`, `@Routes` (route sections with new fragments), `@attributes`, modifiers, and markup inside `@{ }` (statement markup inline into the code region, value markup as fragments) all go through the fine emitter. Delete `is_island`, `FinePart::Island`, and the vDOM emitter (`nodes`, `node`, builder `component`, `inline_nodes`, builder `fragment_of`, builder `slot_lambda`, builder `route_section`) once nothing calls them. Keep generic prop hoisting (`__pN`) inside the props read; keep source mappings exact.
2. Props split: value props in the `props` read; `EventCallback`/lambda props, `@bind-value` callbacks and callback props set like DOM events go in `statics` (spec).
3. Codegen tests: port the vDOM-emitter expectations to the one emitter (the test `parse` helper stops toggling `fine`; every test runs the one emitter). Keep the mapping assertion in `gen_with`.
4. End to end: `tests/*.test.ts`, `bun run ui`, `bun run examples`, `bun run docs`, LSP test green. Generated code imports only from the main entry (plus `/model` for models).

## Task 5: delete the vDOM runtime

1. Delete from `runtime/index.ts`: `RenderTreeBuilder`, `VNode` types, `patchList`, `patchKeyed`, `nodesOf`, `create`, `patch`, `render`, `update`, `mountComponent`, `batch` (if unused), `patchIsland`, `disposeIsland`, `$isFragment`, `setFineHooks`, `FINE`, `setTracking`, `setRenderObserver`, `RenderObserver`, `mountedComponents`, `elementHandlers`; the old fragment brand; `buildRenderTree`. `render` becomes abstract. ISLAND kind leaves `dom.ts`.
2. `runtime/model.ts`: delete the component re-render queue (`Reads`, `read`, `sweep`, `stack`, `setRenderObserver` call).
3. `NavLink` rewritten with `dom` primitives (internal), same behavior (active class, `aria-current`, prefix/exact, base path, observe-only navigation).
4. Port runtime tests written against `RenderTreeBuilder` (`index`, `lifecycle`, `cascade`, `compose`, `fragment`, `di`, `model-render`, `router`, `template`) to `render(__p)` components using `dom`; same assertions. A test that only pinned vDOM internals is deleted, listed in the commit message with the reason.
5. Hot reload (`npm/xzor/bin/hot.ts`): when a patch replaced `render`, rebuild the instance's DOM between its root comments (dispose bindings, run `render`, keep fields); else `stateHasChanged()`. `tests/hot.test.ts` covers a template edit keeping state.

## Task 6: names and docs

1. `@fine`: parser error with the spec's message; TextMate grammar and its test (`editors/vscode/test/gen.ts`), Zed queries, LSP completion, `xzor highlight` stop knowing it.
2. No "fine" in identifiers: `src/codegen.rs` (`fine_nodes` -> e.g. `dom_nodes`, `doc.fine` field removed, `FinePart` -> `Part`...), `runtime/dom.ts` internals, test names, bench scripts are exempt (`target/`).
3. Docs (same commit): `docs/design.md` (Fine components section -> Components/Rendering, removed APIs, `RenderFragment` shape, `@fine` gone), `README.md`, `npm/xzor/skills/xzor/SKILL.md`, `.github/skills/xzor-ui/SKILL.md` if it mentions any of it, `docs/site/pages` (HowItWorks `buildRenderTree`), `.github/copilot-instructions.md` (pipeline line naming `buildRenderTree`), `.github/skills/spec-rehydration/features.md` (rows: Fine components -> Components; code paths `runtime/dom.ts`).
4. Write-back (spec-rehydration step 4): `## Later changes` lines in `docs/plans/2026-10-16-fine-components.md`, `docs/superpowers/specs/2026-10-13-routing-cascading-design.md`, `docs/plans/2026-10-15-trackable-models.md`, `docs/plans/2026-10-14-hot-reload.md`.

## Task 7: final perf pass

Perf agent re-runs the baseline commands (strip nothing: `@fine` is gone from the bench app sources first) and reports against the spec's gates; fix regressions before finishing.

## Perf amendments (plan perf pass; binding on the tasks they name)

- **T3.3**: `refreshAll` stops at a COMPONENT binding (only its re-run decides the child pass); `under`/`pauseIn` still descend into children (`@pause` freezes them). Test: a parent `stateHasChanged` with unchanged primitive props and no slots runs no child binding.
- **T3.1**: the instance is its own ctx (`holder.ctx === component`) and holds its root `bindings`/`start`; `MEMOS` becomes a field; `slots` defaults to one shared frozen empty object; all these fields initialized in the base constructor in a fixed order (one hidden class).
- **T3.7**: the cascade scope is set on the holder/ctx when the region is entered (as `Ctx.scope` today) and read at construction; holders get no parent field.
- **T1.2-1.3**: `$changed` calls the core's `changed` directly; `same` without the `tracking` hop; `model.ts`'s untracked spots write `Component.$reader` directly. T1.9 adds `reader.bench.ts A`: the field read stays at or under 1.15 ns.
- **T5.2**: the queue works on `Binding` only: queued state is the `QUEUED` flag, the prototype accessors (`at`, `renders`, `component`, `owner`) go, flush loops by index over a reused array (no `splice`). Gate: change/keystroke at or under 0.117/0.169 ms (5000).
- **T3.5 / T4.2**: a content region rebuilds only when `!Object.is(prev, value)`; markup-valued props go in `statics` like slot fills. Add a perf cell for an `@expr` returning a fragment that re-runs.
- **T3.3 / T4.2**: in list rows, statics (handlers) read the row's current item (the `onItem`/`textItem` pattern), never through props. Test: click after the row's item is replaced under the same key.
- **T3.11**: add an object-prop cell (RO, `<Row row="@r" />`) at 1000/5000 (mount, row change, parent sHC); gate: RO beats RV.
- **T4.5 (new)**: perf checkpoint after codegen: full re-run block from `baseline.md`; gates: fine table no regression, RV/RF beat the island path at 5000 (22.89 MB / 9.24 ms / 12.6 ms). Fix before Task 5.
- **T3.11, T5.3, T7**: leak check: mount 5000 Row children and 1000 `NavLink`s, clear, `Bun.gc(true)` twice: heap back within 0.1 MB (`@cached` excluded), subscriber/consumer counts 0.
- **T1.9, T7**: record minified `dist/main.js` bytes (counter, dashboard, bench app); temporary growth through Task 4 is accepted; final below the 23460d1 sizes.
- **T3.2**: after-render bookkeeping is a module-level array reused across passes with a depth counter, no closures; `onAfterRenderAsync` is `then`-ed only when it returns a promise.
