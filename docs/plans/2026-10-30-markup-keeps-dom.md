# Markup keeps its DOM: implementation plan

Spec: [docs/superpowers/specs/2026-10-30-markup-keeps-dom-design.md](../superpowers/specs/2026-10-30-markup-keeps-dom-design.md) (binding). Branch: `feat/one-renderer`. Perf baseline and harness: `target/one-renderer-bench/claim-baseline.md`, `target/one-renderer-bench/claim/` (`bun drive.ts`).

## Global constraints

Same as [2026-10-30-one-renderer.md](2026-10-30-one-renderer.md) Global constraints (TDD, all checks green per task, checkpoint commits, perf/memory rules, zero Rust deps, short comments).

## Task 1: claim mode in the runtime (markup values)

`runtime/dom.ts`, tests in `runtime/dom.test.ts` (generated-code style).

1. Markup values carry a site: `Component.fragment(build, owner?, site?)` stores it (field on the branded function; one property, no wrapper).
2. Content region (TEXT binding showing markup): same value -> nothing; same site -> claim; else rebuild.
3. Claim: reverse the region's old binding chain in place into creation order; module-level cursor; `template()()` returns the master during a claim; one module-level `CLAIM_PARENT` making `appendChild`/`anchor`/`anchors`/`el`/`t` hand back placeholders; each binding call takes the next old binding, checks kind (+ template identity for roots), re-points (`read`; list items/reads/build — kept rows re-point their reads; component type match keeps instance with Ruling 5 props; regions/branches/show re-point recursively) and re-runs. Kind mismatch: assert-and-rebuild fallback.
4. Handlers inside markup values: register through a record in the binding chain (like `onItem`), so a claim re-points the handler without the element.
5. Tests: same-site value keeps every node identity, a focused input and its typed value, and a child component instance (props updated); a text/attr/handler change shows; other site rebuilds; nested list inside (one row changed -> row identity kept); nested `@if` flipping branch inside a claimed value; disposal after claims leaves no subscribers; perf: claim of 1000 rows with one changed label ≤ 1.0 ms (assert loosely in a test, measure with the harness).

## Task 2: codegen sites

`src/codegen.rs`: one module-level site constant per markup literal (markup value, slot fill, route section body, `@{ }` statement markup); `__Component.fragment(build, this, __sN)`; handlers inside markup values emitted through the Task 1 handler record. Codegen tests (`gen_with` mappings exact). E2E: an input inside `@renderItem(x)` keeps focus and typed text across a change (tests/*.test.ts building a scratch app, happy-dom).

## Task 3: `@{ }` pieces

Region holding a code block with markup statements: pieces identified by (site, ordinal); two swapped arrays on the region; claim matching pieces in order, dispose skipped ones, build unmatched. Codegen passes the site per statement markup. Tests: a loop emitting N, N+1, N-1 pieces keeps the common ones (node identity, input value); a different site at a position builds fresh; a nested component in a piece keeps its instance.

## Task 4: docs, perf, review

Docs: remove the rebuild caveat (design.md `@{ }` bullet and Lifecycle sentence, README "No render pass", SKILL statements row); write-back `## Later changes` in the one-renderer spec (Ruling 10 superseded) and features.md Components row if paths change. Perf agent: spec gates. Final review.
