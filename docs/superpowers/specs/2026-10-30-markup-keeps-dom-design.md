# Markup keeps its DOM: same-site markup patches instead of rebuilding

Date: 2026-10-30. Status: requested by the user ("build a first state saved across all related pieces of template; reactivity events must clone and patch after every detected mismatch"). Follows [2026-10-30-one-renderer-design.md](2026-10-30-one-renderer-design.md) (Ruling 10 there documented the rebuild; this spec removes it).

## Goal

Markup produced at run time keeps its DOM when it is shown again with new values:

- a markup value returned by a method or getter (`@renderItem(x)`), a slot fill, a `RenderFragment` member;
- markup statements inside `@{ }` (and `@:` lines), re-run when what the block read changes.

Today both rebuild their region on every change (child instances, focus, typed text, scroll are lost). After this change they patch: the live DOM built the first time is the saved state; a change re-runs the build in claim mode, which reuses the existing nodes and component instances in order and re-binds them; only a mismatch (another markup site, or a different shape) clones and builds anew.

## Non-goals

- No virtual DOM, no diff of trees, no copy of the DOM kept aside.
- Lists, keyed loops, `@if`/`@switch` keep their own mechanisms (they already keep DOM).
- Server-side rendering/hydration of HTML from the server: not in scope (the claim mode is a building block for it later).

## Design

### Sites

Every markup literal (a markup value, a slot fill, a section body, each markup statement in `@{ }`) is a site: one module-level constant per literal, created once (`const __s3 = __dom.site()` or the template constant itself). A markup value carries its site: `Component.fragment(build, owner, site)`.

### Content regions (markup values)

A content region showing markup value `v`:

- first time: builds `v` (clone + bind) and remembers `v.site` and the bindings/children it created;
- next value `w`: if `w === v`, nothing; if `w.site === v.site`, **claim**: dispose the old bindings, run `w`'s build in claim mode against the existing nodes between the region's comments; else (other site, text, null) rebuild as today.

### Claim mode: re-point, don't re-navigate

The generated build reaches nodes by template paths (`firstChild`/`nextSibling`), which no longer match the live DOM once lists, regions or content regions inserted nodes. So a claim does not walk the DOM: it re-runs the new value's build against the OLD bindings, in order, and re-points them (design perf pass, `target/one-renderer-bench/claim-baseline.md`):

- At claim start the region's old binding chain is reversed in place into creation order (bindings are prepended), held in one module-level cursor (no allocation).
- `template()()` returns the template's master node during a claim (never cloned, never inserted); one module-level `CLAIM_PARENT` stand-in makes `__p.appendChild`, `anchor`, `anchors`, `el`, `t` no-ops that hand back placeholders, so the generated paths always resolve.
- Each `dom.*` binding call ignores the node it is given, takes the next old binding, checks its kind (and template identity for roots), sets its `read` (and row reads/build for lists, child type/props for components) to the new one and re-runs it: equal values touch nothing, a list reconciles its rows (kept rows re-point their reads), a component at that position keeps its instance when the type matches (props per Ruling 5), regions and kept branches re-point the bindings under them the same way.
- Handlers: in markup values, handlers are registered through a handler record kept in the same chain (like `onItem` for rows), so a claim re-points the element's handler instead of needing the element.
- A markup literal is straight-line code, so one site always issues the same calls in the same order: a kind mismatch cannot happen for markup values; it is asserted and falls back to a full rebuild. (Corrected 2026-10-31: false for structure decided by plain code, `@while` and unkeyed loops; those are pieces regions now, see Later changes.)
- Nothing moves in the document, so focus, selection, typed text and scroll stay.

### `@{ }` markup statements

A `@{ }` block with markup statements is a region whose run emits pieces in order. Each piece is identified by (site, ordinal of that site in this run). The region keeps last run's pieces in two arrays on the region, swapped each run; each emit scans forward for the next old piece of the same site and claims it (re-point, as above); skipped old pieces are disposed at the end; unmatched emits build fresh (a mismatch clones). No Map, no per-run allocation beyond the arrays already held.

### Codegen

- Sites: a module-level constant per markup literal; `Component.fragment(build, this, __sN)`; statement markup in code blocks passes its site to the region's emit.
- No change to `.xzor` syntax.

## Perf

Baseline (happy-dom, n=1000, one label changed in a 1000-row markup value): rebuild today 4.97 ms; the same list written inline 0.31 ms.

Gates (perf agent, design/plan/implementation/review): claim median ≤ 1.0 ms at n=1000 (≥5× faster than today, within ~3× of inline); the `<ul>` and every `<li>` keep identity; heap after 50 claims flat (≤ the inline list's ~50 KB); allocation per claim independent of n (beyond what list reconcile already allocates); existing cells (fine/rows/heavy) don't regress; bundle growth only the site constants and handler records.

## Testing

Runtime tests (generated-code style): same-site value keeps nodes/focus/child instances and updates text/attrs; other site rebuilds; shape mismatch mid-range clones the rest; `@{ }` loop emitting N then N+1 then N-1 pieces keeps the common ones; nested region/list inside claimed markup; component at the same position kept, different type replaced. Codegen tests for sites. E2E: an input inside `@renderItem(x)` keeps focus and typed text across a change.

## Touches

### Components (rendering, bindings) - docs/design.md Components; specs 2026-10-30-one-renderer-design
- Holds: bindings per source, templates cloned on second use, content regions rebuild only for a different value (`!Object.is`), `@{ }` region semantics, child component prop rule (Ruling 5), statics/props split (Ruling 7).
- Changes: content regions and `@{ }` regions claim same-site markup instead of rebuilding; Ruling 10's documented rebuild is removed.
- Migrates: docs/design.md (`@{ }` bullet, Lifecycle sentence), README "No render pass", SKILL statements row; one-renderer spec `## Later changes`.

### Slots and markup values
- Holds: `RenderFragment` type, `Component.fragment(build, owner)`, slot fills built once in statics.
- Changes: fragments carry a site; slot regions claim when the fill changes but comes from the same site.

### Hot reload
- Holds: a template edit rebuilds the instance.
- Changes: none (a rebuild doesn't claim).

### Cross-cutting
- Generated code shape: site constants; compiler and runtime ship together.
- Perf and memory: one site constant per markup literal; no per-update allocation beyond bindings.
- Docs: design.md, README, SKILL, features.md row (Components).

## Later changes

- 2026-10-31 (final review): structure decided by plain code (`@while`, unkeyed loops, loops and branches running `@{ }` code) renders as pieces regions matched by (site, order), never by call count. A piece whose claim fails builds anew in the same run: user code runs once per update. A claimed piece runs again right after its statement, reading locals as a fresh one does. `@ref` in anything a claim re-runs points at the live element. A claim from another owner rebuilds. Pieces carry no key: state follows position. Site and row scans are linear (per-site cursor on the site, stamped with a run number unique across blocks).
- 2026-10-31 (second review): a claim never changes a template's master. A binding in a piece that reads a block's `let` updates by running the block again (which claims), never alone. Tracked values compare plain objects and arrays by content, everything else by identity.
