# One renderer: components without the virtual DOM

Date: 2026-10-30. Status: approved by the user's request ("go ahead ... do specs, plan and execute surgically with the less impact for surface"), decisions below confirmed in chat.

## Goal

Every component renders the way fine components do today (templates cloned once, bindings that write to the live nodes), and the virtual DOM is deleted: no vnode trees, no `patchList`/`patchKeyed`, no array copies per update. "Fine" stops being a name: there is one kind of component, `Component`.

## Decisions (from the user)

1. The base class is `Component`. (`ComponentBase` stays one release as a deprecated alias, for the least surface impact; `FineComponent` goes.)
2. `stateHasChanged()` keeps its meaning: it tells every watcher (binding) of the component that state changed; each re-checks what it reads and updates only if needed. Tracked state never needs it; it is for changes nothing tracks.
3. The `@fine` directive disappears: in a `.xzor` it is a build error ("`@fine` no longer exists: every component renders this way; remove it").
4. Components written by hand in TypeScript: no public render API. Markup is written in `.xzor`; logic in a `.ts` base class used through `@inherits`. The render primitives the compiler emits stay `@internal`. The runtime's own `NavLink` is written with those internal primitives.
5. `@source-crafter/xzor-runtime/model` is for model reactivity and complements component reactivity: the main entry holds `Component`, the renderer and the reactivity core (reader, change queue); `/model` holds `Model`, `EntitySet`, `@Key`, validation, which report to the same core.

## Non-goals

- No change to `.xzor` syntax (other than `@fine` going), lifecycle hooks, DI, routing, models, styles or the build pipeline's outputs other than the generated component code.
- No new public API.
- List reconciliation allocations (`reconcile`'s `keys`/`at`/`order`) are a separate follow-up.

## Design

### Runtime layout

- `runtime/index.ts`: `Component` and its tracked fields, the reactivity core (the one reader slot, `same`, the change queue now in `model.ts`: `changed`/`flush`/`$notify`/`$flush`), the renderer (today's `runtime/fine.ts`, moved to `runtime/dom.ts` and imported statically by `index.ts`), component mounting (construct/DI, lazy, cached, cascades, lifecycle, `@catch`, view-transition waits), router, `mount`, `lazy`, `NavLink`, `call`/`segment`/`HttpError`/`Remote`, `viewTransitions`, decorators.
- `runtime/dom.ts` (internal, was `fine.ts`): bindings, templates, regions, lists, keyed loops, show blocks, `@await`, memos, events, plus the new kinds below. Its export used by generated code is `dom` (was `fine`), marked `@internal`.
- `runtime/model.ts`: `Model`, `State`, `ModelChangeEvent`, decorators, validators, `isLike`, `$keyName`, `EntitySet` re-export. It imports the core from `./index`; it no longer installs anything into components (`setTracking`, `setRenderObserver`, the component re-render queue and its `Reads` bookkeeping are deleted: no component re-renders from model reads, bindings track models directly).
- The reader slot: a plain static field `Component.$reader`, the only one bindings write. Generated component getters read it (`Component.$reader?.(this, i)`, or a subclass through static inheritance: measured 1.10 vs 1.11 ns). `Model` (an `EventTarget`, so no inheritance) gets a static `get`/`set $reader` forwarding to it (+0.1 ns per model read, measured); generated model getters keep `Model.$reader?.(this, i)`. No second field kept in sync.

### Component

```ts
export abstract class Component {
  protected abstract render(parent: Node): void; // generated: template clones and dom.* bindings (was buildRenderTree + addFine)
  // lifecycle, unchanged: onInitialized[Async], onParametersSet[Async], onAfterRender[Async], shouldRender, dispose
  stateHasChanged(): void; // re-runs every binding of this component (today's fine `refresh`), then onAfterRender(false)
}
```

A mounted component keeps, in fields on the instance (no `WeakMap`): its root holder (bindings), its start/end comments, its application, its cascade scope, its loose-binding list. `shouldRender()` false skips a `stateHasChanged` pass, as it skips `update` today. `onAfterRender(first)` runs after the first build and after each whole-component pass (`stateHasChanged`, new parameters), after the outermost pass ends, as today.

### Child components are bindings

`<Card title="t" @key="k" @ref="r">…</Card>` compiles to a `COMPONENT` binding before an anchor (no island):

- `read()` returns the props object for value props only (allocated when it runs: on mount, when what it read changed, or on a parent pass) and is diffed against the previous one kept in the binding's data. Event callbacks, lambdas and slot fills are not in it: they are a static argument built once (`dom.component(end, Card, () => ({ title }), { onSave }, slots)`), so their identity never makes a prop look changed.
- On re-run: same rule as today's `patch`: a prop that is not `Object.is` equal, or any object prop, counts as changed; changed props are assigned, then `onParametersSet[Async]` and a whole-component pass on the child. Unchanged: nothing. A child given slot fills gets a pass whenever its binding re-runs on a parent pass (today a child with slots always refreshes), so a parent `stateHasChanged()` still reaches the slot content's untracked reads.
- The child's end marker is the binding's anchor (one comment per child, not three); its loose-binding list is created on first use.
- Construction: `construct` as today (DI `app.createComponent`, `@async` lazy with its anchor until the chunk arrives, `@cached` revival by type and key), `@ref` after props, `@Cascade` members resolved from the holder's scope, `@catch` `onError` for routed pages, the view-transition wait (`awaiting`/`settle`/`collect`) unchanged.
- Dispose: as today's `dispose(VComponent)` (cached ones kept detached).
- In a list row, the row's key keys the component (rows are already keyed; an element/component `@key` on the row root keys the loop since 0.1.20).

### Markup values

- `RenderFragment` becomes `((parent: Node) => void) & { [FRAGMENT]: true }`; `Component.fragment(build)` brands it. A fragment remembers the holder context it was created in, so a handler inside it runs its creator's after-handler pass.
- An `@expr` whose value is a fragment: today's TEXT binding switches to a content region that builds the fragment (and back to text if the value stops being markup). Replaces `#becomeIsland`.
- `@slot` / `@slot:name(args) { fallback }`: a region that builds `this.slots.name?.(args)` or the fallback. Slot fills on a component tag compile to fragments closing over the parent.
- Markup inside `@{ }`: statement-level markup (`CodePart::Render`) is emitted inline into the code region; markup used as a value (`CodePart::Markup`) is a fragment.

### Other islands, now bindings

- `@cascade:name(value[, fixed])`: a region whose holder carries a new scope record (`{ name, value, fixed, consumers, parent }`); value changes reach consumers as today (assign, then `onParametersSet` and a pass).
- `@Routes`: `dom.routesAt(end, table, sections)`: the router state as today (`resolveRoute`, `Route`, navigation subscription, `@catch`), the section rendered as a region, the page as a component binding keyed by its route family.
- `@attributes="bag"`: an attribute binding that keeps the previous bag in its data and removes the keys the new bag lacks (no array of names built per run).
- Event modifiers: `dom.on(el, event, handler | undefined, mods)` with `mods` a bitmask constant (prevent default, stop propagation); the delegated dispatcher honors `stopPropagation`.

### Removed

`RenderTreeBuilder`, `buildRenderTree`, `VNode`/`VText`/`VElement`/`VRegion`/`VComponent`/`VFine`, `patchList`, `patchKeyed`, `nodesOf`, `create`, `patch`, `render`, `patchIsland`, `disposeIsland`, `$isFragment` (internal), `setFineHooks`, `FINE`, `setTracking`, `setRenderObserver`, `RenderObserver`, `FineComponent`, `fine` (export of `/model`), the ISLAND binding kind, the `@fine` directive, the vDOM emitter in `src/codegen.rs` (`nodes`, `node`, `component`'s builder form, `inline_nodes`, `fragment_of` builder form, `slot_lambda` builder form, `route_section` builder form, `is_island`).

### Hot reload

`installHot` keeps patching prototypes and calling `stateHasChanged()`. A patch that replaced `render` rebuilds the instance's DOM between its root comments (bindings disposed, `render` run again, fields kept); otherwise a pass is enough.

### Generated code

```ts
export default class Counter extends Component {
  // fields, members, lifecycle as today
  protected override render(__p: Node): void {
    const _e0 = __t0();
    dom.textAt(_e0.firstChild!.firstChild as Text, () => this.count);
    dom.component(_e0.lastChild as Comment, Stepper, () => ({ value: this.count }), { valueChanged: (v) => (this.count = v) });
    __p.appendChild(_e0);
  }
}
const __t0 = dom.template([...]);
```

Imports come from `@source-crafter/xzor-runtime` only (`Component`, `dom`, types); `/model` only when the component uses models.

## Perf

Measured by the `perf` agent at design (baseline: `target/one-renderer-bench/baseline.md`, with the commands to re-run it), after the core task, and at the end, on `target/fine-bench` (happy-dom, compiled bundles) plus the child-component cell (`target/one-renderer-bench`, `rows-cells.ts`): a list of rows each a `<Row id label />`, mount, one-row change, parent `stateHasChanged`.

Baseline (commit 23460d1): fine cells at 5000: heap 7.91 MB, change 0.117 ms, keystroke 0.169 ms, grow+sHC 25.0 ms. Child-component cell at 5000 (island path): heap 22.89 MB, mount 222.8 ms, row change 9.24 ms, parent sHC 12.6 ms; inline-`<li>` floor: mount 62.2 ms, row change 2.39 ms, sHC 2.95 ms.

Gates: the fine cells do not regress on heap, change, keystroke or grow+sHC; the child-component cell beats the island path at 5000 on heap, row change and parent sHC. No allocation per update beyond the props object of a binding that re-ran.

## Testing

- Behavior is preserved test by test: every runtime test written against `RenderTreeBuilder` (`runtime/index.test.ts`, `lifecycle`, `cascade`, `compose`, `fragment`, `di`, `model-render`, `router`, `template`) is ported to components written the way the compiler emits them (`render(parent)` with `dom.*`), or deleted with the reason in the plan when it only pinned vDOM internals.
- `src/codegen.rs` tests: the vDOM-emitter expectations move to the one emitter; the test `parse` helper no longer sets `fine`.
- End to end (`tests/*.test.ts`), examples, kit, docs site, LSP test: unchanged behavior, all green.

## Touches

### Template syntax and directives - design.md Syntax
- Holds: syntax unchanged; `@key` on a row's top element keys the loop (0.1.20); `@attributes`, event modifiers, `@ref`, `@leave`, `@once`, `@await`, `@show`, `@pause` keep their semantics.
- Changes: `@fine` is removed (build error). `@attributes` and modifiers stop being islands.
- Migrates: parser directive list, codegen, TextMate grammar (`@fine`), Zed queries if they name it, LSP completion of `@fine`, `xzor highlight`.

### Fine components - design.md Fine components, Rendering; plans 2026-10-16-fine-components
- Holds: templates cloned on second use; bindings track per source with bitmasks (30 fields, `state` bit); loose bindings re-run after handlers; delegated events; memos (`@Volatile`); keyed lists/loops; show/pause; `@await`; 8-field `Binding`.
- Changes: becomes "Components"; `fine.ts` -> `dom.ts`, `fine` -> `dom`; ISLAND kind replaced by COMPONENT, CONTENT, CASCADE, ROUTES, ATTRS behavior; FINE symbol -> instance fields.
- Migrates: design.md section renamed and rewritten; `## Later changes` line in the plan.

### Slots and markup values - design.md Markup as values, Slots
- Holds: `@slot` names/args/fallback, slot fills, markup as values typed `RenderFragment`.
- Changes: `RenderFragment`'s shape (builder callback -> DOM build function).
- Migrates: codegen `slot_lambda`, `fragment_of`, slot declarations' types; `runtime/fragment.test.ts`, `template.test.ts`.

### Cascading values - specs 2026-10-13-routing-cascading-design
- Holds: nearest provider wins; `fixed` keeps the first value; consumers get `onParametersSet` then a pass; one subscription per instance.
- Changes: the provider is a region binding instead of a vDOM region record.
- Migrates: `runtime/cascade.test.ts`, `tests/cascade.test.ts`.

### Routing - specs 2026-10-13-routing-cascading-design; plans 2026-10-13-client-routing; specs 2026-10-28-serve-cache-transitions-design
- Holds: section order and matching, `Route`, `href`, `NavLink` (active class, `aria-current`, base path), page instance kept per route family, `@catch` with stale-failure drop, view transitions wait for chunk + hooks (+ re-render hooks), 1500 ms cap.
- Changes: `addRoutes` -> `dom.routesAt`; `NavLink` rewritten with internal primitives.
- Migrates: `runtime/router.test.ts` (largest port), `tests/routing*.test.ts`.

### Dependency injection - specs 2026-10-12-di-bootstrap-design
- Holds: `static inject`, `app.createComponent`, async services, `@Run` mount, errors when a component is not registered.
- Changes: nothing in DI; generated providers unchanged. `src/di/emit.rs` imports of `ComponentBase` (if any) follow the rename.
- Migrates: `runtime/di.test.ts`.

### Models and validation - plans 2026-10-15-trackable-models
- Holds: model API, `Model.$reader?.(this, i)` in generated model getters, bit layout, `same`, `EntitySet`, validators.
- Changes: `/model` no longer installs component tracking or exports `FineComponent`/`fine`; the queue moves to the core.
- Migrates: `runtime/model-render.test.ts`, `tests/bundle-model.test.ts`; `src/bundle.ts` tracked-field rewrite recognizes `Component` (and the `ComponentBase` alias).

### Inherited members, generic components, `@module`, component styles
- Holds: `@inherits` bases extend `Component` (or the alias); hoisted `__pN` props for generics; `@module`; style attributes bound like other attributes.
- Changes: generic hoisting moves into the component binding's props read.
- Migrates: codegen tests; `src/lib.rs` warning test naming `ComponentBase`; `examples/counter/pages/PageBase.ts`.

### Watch, hot reload, `xzor dev` - plans 2026-10-14-hot-reload
- Holds: prototype patching, private-name reload, field probes, `stateHasChanged` after patch.
- Changes: a replaced `render` rebuilds the instance's DOM.
- Migrates: `tests/hot.test.ts`, `tests/bundle-hot.test.ts`, `tests/dev-hot.test.ts`.

### Bundle and `--minify`, page shells, server apps, contracts
- Holds: chunks per `@page`/`@async`, CSS append, shells, `dist/server.js`.
- Changes: none beyond generated imports (`Component`, `dom` from the main entry).
- Migrates: `tests/bundle*.test.ts` expectations that name `addFine`, `fine.`, `/model`.

### Language server, editors, `xzor highlight`
- Holds: mappings from generated code back to `.xzor` (LSP features ride on them).
- Changes: generated shape changes, so mappings must stay exact (codegen tests assert every mapping's text).
- Migrates: `tests/lsp.test.ts` if it names generated code; grammar test for `@fine`.

### xzor-ui kit, examples, `xzor init`, docs site
- Holds: all `.xzor`; must build and behave the same.
- Changes: none in sources except `PageBase.ts` (`Component`).
- Migrates: `bun run ui`, `bun run examples`, `bun run docs` green; `tests/ui.test.ts`.

### Cross-cutting
- Surface names: `Component` (new), `ComponentBase` (deprecated alias), `FineComponent`/`RenderTreeBuilder`/`buildRenderTree` removed; README, design.md, user skill, kit skill, docs site, `features.md` rows (Fine components -> Components; Slots code paths).
- Generated code shape: everything in `.xzor/*.xzor.ts` changes; compiler and runtime ship together (same version).
- Perf and memory: see Perf.
- Errors: `@fine` error message; tsc mapping unchanged.
- Build modes: `--hot` rebuild path above; others unchanged.
- Zero Rust dependencies: unchanged.

## Risks

- `runtime/router.test.ts` and `runtime/index.test.ts` are large and written against the builder; porting them is most of the work. Mitigation: port mechanically to `render(parent)` components, keep assertions.
- Slot content and handlers crossing components (owner context) is where subtle bugs hide: fragments carry their creator's context (above), with tests for a handler in slot content updating the parent's loose bindings.
- Hot reload of templates: covered by `tests/hot.test.ts` and `bundle-hot`.

## Later changes

- 2026-10-30: Ruling 10's rebuild of same-site markup is superseded: same-site markup keeps its DOM, see docs/superpowers/specs/2026-10-30-markup-keeps-dom-design.md.
