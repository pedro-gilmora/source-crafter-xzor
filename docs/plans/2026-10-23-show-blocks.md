# `@show:if`, `@show:switch` and `@pause` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** control flow that hides branches instead of removing them (Vue's `v-show`, with `else if`/`else` and `switch`), with hidden branches live by default and `@pause` to stop parts of them while hidden.

**Architecture:** the parser wraps an `@if`/`@switch` in `Node::Show` and reads `@pause` as `Node::Pause`. Fine codegen emits `fine.showAt(end, run)`, the `branchAt` two-mode function (`run()` picks, `run(parent)` builds the chosen branch), and `fine.pauseAt(end, build)` for paused parts. The runtime builds a branch the first time it is chosen, keeps it, hides its top-level elements with inline `display: none`, and pauses the bindings under its `@pause` regions while it is hidden (a paused binding marks itself stale; showing replays the stale ones).

**Tech Stack:** Rust (no crates), TypeScript 7, Bun + happy-dom.

**Spec:** the conversation of 2026-10-23 (summarised here).

## Global Constraints

- Syntax: `@show:if (c) { } else if (c) { } else { }`, `@show:switch (x) { case a: … default: … }`.
- `@pause` bare, first in a show branch: the whole branch; `@pause { … }`: its block, anywhere inside a show branch.
- Hidden branches stay live by default; `@pause` stops them while hidden and they catch up once when shown.
- A branch is built the first time it is chosen, then kept. Choosing re-evaluates only the conditions.
- Hiding: inline `display: none` on each top-level element; showing restores the element's previous inline `display`.
- A show branch's top level holds elements (and whitespace, comments, `@pause`) only; anything else is a compile error that says to wrap it in an element.
- `@pause` outside a show branch, or bare and not first in its branch: compile error. Show blocks in `@render` components: compile error.
- No wrapper elements; no pausing by default; no `@show` in the virtual DOM.

## Review Focus

- A hidden branch's live part keeps updating; a paused part doesn't run while hidden and is current right after showing.
- Disposing the component (or an enclosing region) disposes every built branch, shown or not.
- An element with a static inline `display` gets it back when shown.
- `stateHasChanged()` refreshes the shown branch and live hidden ones; paused ones only mark stale.
- A pause region rebuilt inside a live part while hidden starts live: accepted (live is correct).

## Tasks

### Task 1: runtime `showAt` and `pauseAt`

**Files:** `runtime/fine.ts`, `runtime/fine.test.ts`.

- [ ] Failing tests: branches built lazily, hidden with `display: none` and restored (static inline display kept), same DOM node across hide/show, live hidden branch updates, paused region doesn't run while hidden and catches up on show, dispose disposes hidden branches.
- [ ] Flags `SHOW`, `PAUSE`, `PAUSED`, `STALE` on `Binding`; `Show` state (`index`, `run`, `branches[]` of `{ holder, els, display }`); `stateHasChanged` SHOW path; `dispose`, `refreshAll` for SHOW; `pauseAt` = branch region with a constant index and the PAUSE flag; pause/resume walk regions, rows and shows.
- [ ] Green; commit `feat(fine): showAt keeps chosen branches and hides the others; pauseAt pauses while hidden`.

### Task 2: parser and codegen

**Files:** `src/ast.rs`, `src/parser.rs`, `src/codegen.rs` (+ walkers in `src/style.rs`, `src/lsp/features.rs` that match every node).

- [ ] Failing parser tests (`Node::Show`, `Node::Pause(None | Some(body))`) and codegen tests (`fine.showAt(`, `if (!__p) return i;`, `fine.pauseAt(`, bare `@pause` wrapping the rest, every compile error above).
- [ ] Implement; `cargo test`, full JS tests, examples and docs site build.
- [ ] Commit `feat: @show:if and @show:switch hide branches instead of removing them; @pause stops them while hidden`.

### Task 3: editor, docs, e2e

**Files:** `src/lsp/features.rs` (completions `show:if`, `show:switch`, `pause`), `editors/vscode/test/gen.ts` + grammar, `tests/bundle-keyed.test.ts` (e2e), `README.md`, `docs/design.md`, `docs/site/pages`, `npm/xzor/skills/xzor/SKILL.md`.

- [ ] E2E through `xzor build`: tabs with `@show:switch`, input value kept across switches, paused list catches up.
- [ ] Completions and grammar with tests; docs everywhere; snippets compiled.
- [ ] Perf pass (mount, toggle, hidden updates live vs paused), fix regressions; commit.
