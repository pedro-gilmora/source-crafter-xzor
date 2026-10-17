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
