# Fine components (`@fine`)

Goal: an opt-in compile mode with no render pass. A `@fine` component builds its DOM once; every dynamic
expression becomes a binding that re-runs only when a model field (or a field of the component) it read
changes. Design and measurements: the render spikes in `target/spike-r4` (variants E4/E5: 0.02 ms per change and
0.16 ms per added row at 5000 rows, against 35 ms and 31 ms for today's re-render).

Decisions (made autonomously; the user reviews later):

- Opt-in per component with `@fine`; today's renderer stays the default and nothing else changes.
- The compiler has no types, so masks are not computed at compile time: a binding collects the fields it reads
  each time it runs (D3's collector), and is its own dep for its first model. Derived getters and aggregates
  (`team.reduce(...)`) need no hand notifications.
- A `@fine` component extends `FineComponent` (runtime `/model` entry). The bundler tracks its fields like a
  model's, so `count++` in a handler updates what reads `count`; no re-render after handlers.
- `stateHasChanged()` on a fine component re-runs all its bindings (for changes nothing tracks).
- Lists: `@for (const x of expr)` with one element as body is a keyed list (rows by identity, `EntitySet`
  splices applied exactly). Any other `@if`/`@for`/`@while`/`@switch`/`@{}` is a region rebuilt on change.
- Not in this milestone, rejected with a compile error: child components, slots, `@cascade`, routes blocks,
  `@ref`, `@attributes`, event modifiers. `@inherits` must name a `FineComponent`.

## Tasks

1. `runtime/fine.ts`: `Binding` (text, attribute, value, region, list), read-collected deps, the model queue
   (`$notify` from `model.ts`), `ListBinding` with `EntitySet` splices, `FineComponent`, `FineBuilder` API.
   Re-exported by `runtime/model.ts`. Tests: `runtime/fine.test.ts`.
2. `runtime/index.ts`: a `fine` vnode (`RenderTreeBuilder.addFine`): built once, kept by patches, refreshed on
   `stateHasChanged`, disposed with its owner.
3. `runtime/entity-set.ts`: report splices and reorders to an attached list binding, and membership changes to
   readers (`for...of`, `view`, `length` through the binding's collector).
4. `src/bundle.ts`: `FineComponent` imported from the model entry is a tracked root; components get no
   generated constructor. Tests: `tests/bundle-model.test.ts`.
5. Parser `@fine`; codegen `fine` path emitting builder calls with source mappings. Tests in `codegen.rs`.
6. Example `examples/counter/pages/TeamFine.xzor` (with totals), `cargo run -- build examples/counter`.
7. Docs (design.md, README, SKILL.md), measurements, perf and memory review.

## Measurements (compiled output, happy-dom, 7 processes per cell, `target/fine-bench`)

| page | rows | heap over plain DOM | one change | keystroke | +1 row |
|---|---|---|---|---|---|
| vdom | 1000 | 7.40 MB | 6.02 ms | 5.73 ms | 4.11 ms |
| `@fine` | 1000 | 4.98 MB | 0.018 ms | 0.049 ms | 0.44 ms |
| vdom | 5000 | 35.88 MB | 31.5 ms | 31.2 ms | 27.8 ms |
| `@fine` | 5000 | 23.93 MB | 0.021 ms | 0.049 ms | 2.63 ms |

Per change it matches the hand-written spikes (D3/E4/E5: 0.02 ms). Two fixes got it there: a `@for` whose binding
is a destructuring pattern (`[field, messages] of Object.entries(...)`) is a region, since its items are new on
every run; and structure inside a region is plain control flow, not nested regions.

Next, by measured gain in the spikes: exact `EntitySet` splices for lists (E4: 0.16 ms per added row at 5000,
against 2.6 ms), delegated events and hoisted `fn(arg)` bindings (heap), no comment anchors where not needed.

### T-form (templates, shared row reads, delegated events)

Codegen emits each run of nodes as a `fine.template` clone, binding the nodes it has in place (`textAt`, `regionAt`,
`listAt`, `islandAt`); a row's bindings and handlers are reads its list shares, taking the item (`textItem`,
`attrItem`, `regionItem`, `onItem`); bubbling events go through one document listener. A template builds directly
on first use and clones from the second, so a component used once keeps no copy.

happy-dom, 7 processes per cell (`bun cells.ts`), F = previous form (`fine.el` + closures):

| page | rows | heap over plain DOM | one change | keystroke | +1 row | mount |
|---|---|---|---|---|---|---|
| F | 1000 | 5.18 MB | 0.019 ms | 0.052 ms | 0.45 ms | 67.5 ms |
| T | 1000 | 2.30 MB | 0.022 ms | 0.054 ms | 0.43 ms | 65.2 ms |
| F | 5000 | 26.16 MB | 0.022 ms | 0.057 ms | 2.80 ms | 239 ms |
| T | 5000 | 10.36 MB | 0.026 ms | 0.064 ms | 2.79 ms | 249 ms |
| F | 2000 static spans | 1.32 MB | 0.011 ms | | | 25.2 ms |
| T | 2000 static spans | 0.24 MB | 0.011 ms | | | 23.2 ms |

Chromium, compiled bundles, medians of 5 interleaved page loads (`target/fine-bench/index.html`), JS heap after GC:

| page | rows | mount script | layout | JS heap | one change | keystroke | +1 row |
|---|---|---|---|---|---|---|---|
| vdom | 1000 | 79.0 ms | 116 ms | 2.69 MB | 21.0 ms | 21.1 ms | 22.5 ms |
| F | 1000 | 61.1 ms | 118 ms | 1.21 MB | 0.024 ms | 0.017 ms | 0.58 ms |
| T | 1000 | 52.4 ms | 115 ms | 0.84 MB | 0.028 ms | 0.020 ms | 0.61 ms |
| vdom | 5000 | 399 ms | 1002 ms | 12.96 MB | 142 ms | 138 ms | 137 ms |
| F | 5000 | 301 ms | 930 ms | 5.71 MB | 0.018 ms | 0.017 ms | 1.68 ms |
| T | 5000 | 272 ms | 826 ms | 3.80 MB | 0.019 ms | 0.019 ms | 1.72 ms |

Against F, T mounts with 10-14% less script and holds 31-34% less JS heap; updates are unchanged. Against vdom it
mounts with 32% less script and holds 69-71% less heap, and updates 1000-7000 times faster.

## Later changes

- 2026-10-29: an element `@key="expr"` that is the only top element (or component) of a `@for`/`@while` body keys that loop, like `@key(expr)` after the head (both at once is an error); any other element `@key` is a build error instead of being ignored.
- 2026-10-30: fine components are the only components: the virtual DOM, islands, `@fine`, `FineComponent` and `buildRenderTree` are gone; child components, slots, markup values, `@cascade`, `@Routes`, `@attributes` and event modifiers are bindings; `runtime/fine.ts` is `runtime/dom.ts` (`dom`), see docs/superpowers/specs/2026-10-30-one-renderer-design.md.
