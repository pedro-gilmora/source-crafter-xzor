# Serve command, cache headers and data-aware view transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** `xzor serve` runs any app in production form; non-hashed files stop being fetched twice; view transitions morph elements that appear once the new page's data arrives.

**Architecture:** The shell/static/fallback serving that the generated server emits inline moves into one runtime function, `serveDist(root)`, used by the generated server and by a new launcher script `npm/xzor/bin/serve.ts`. `staticFiles` drops the `ETag` on non-hashed files and answers `If-Modified-Since`. The router's view-transition update callback awaits the new page's pending async hooks with a cap.

**Tech Stack:** Bun 1.4, TypeScript 7, Rust (zero deps), happy-dom.

**Spec:** [docs/superpowers/specs/2026-10-28-serve-cache-transitions-design.md](../superpowers/specs/2026-10-28-serve-cache-transitions-design.md)

## Global Constraints

- Non-hashed files (`main.js`, `main.css`, `index.html`, `dist/index.html`, shells): `cache-control: no-cache`, no `ETag`, `last-modified` = the file's mtime (HTTP date), `If-Modified-Since` equal or later -> 304. Hashed chunks (`dist/chunks/*`) and fonts keep `public, max-age=31536000, immutable` and their `ETag`.
- View transitions: with `viewTransitions(true)`, the update callback passed to `document.startViewTransition` returns a promise that resolves when the matched page's pending `onInitializedAsync`/`onParametersSetAsync` settle, or after 1500 ms, whichever comes first. Without transitions, navigation stays synchronous.
- `xzor serve [dir] [--port N] [--host H]`: builds with `--minify`, then serves; `localhost` unless `--host`; `PORT` env honored when `--port` is absent. Server app (`dist/server.js`): runs it. Browser-only app: serves `dist` through `serveDist`.
- No per-request allocation beyond hand-written code; docs ship with the surface change.
- Commands: `cargo test`, `bun test ./runtime ./tests`, `bun x tsc -p jsconfig.json --noEmit`, `bun run examples`, `bun run docs`. `cargo build` before tests that spawn the binary.

## Review Focus

- A browser that cached `main.css` sends `If-Modified-Since`: gets 304 with no body: test in Task 1.
- Chrome loads `main.css` once per page load from the generated server (manual browser check, recorded by the controller): Task 1.
- A page whose async hook never settles: the transition still commits after 1500 ms: test in Task 2.
- A navigation to a page with no async hooks: the transition commits in the same task as before (no added delay): test in Task 2.
- `xzor serve` on a browser-only app with no `@page`s: serves `index.html` (no shells), no crash: test in Task 3.

---

### Task 1: Cache headers without ETag for non-hashed files

**Files:**
- Modify: `runtime/server.ts` (`staticFiles` ~54-90), `runtime/server.test.ts`, `tests/server.test.ts` if it asserts ETags on `main.*`

**Interfaces:**
- Produces: `staticFiles(root, files)` unchanged signature; non-hashed responses carry `last-modified` and no `etag`.

- [ ] **Step 1: Write failing tests** in `runtime/server.test.ts`: `non-hashed files have no etag and a last-modified`; `if-modified-since equal to last-modified gives 304 with no body`; `an older if-modified-since gives 200`; `hashed chunks keep their etag and immutable`.
- [ ] **Step 2: Run** `bun test ./runtime/server.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** (compare by parsed time in seconds; prebuilt 304 response as today).
- [ ] **Step 4: Run** `cargo build; bun test ./runtime ./tests`, expect PASS.
- [ ] **Step 5: Commit** `fix(server): no ETag on non-hashed files (Chrome fetched main.css twice)`.

### Task 2: View transitions wait for the new page's data

**Files:**
- Modify: `runtime/index.ts` (`notifyNavigated` ~218, the router's page construction and the `settle(...)` calls ~972, ~1061), `runtime/router.test.ts`

**Interfaces:**
- Produces: internal only; `viewTransitions(on)` unchanged.

- [ ] **Step 1: Write failing tests** in `runtime/router.test.ts` (stub `document.startViewTransition` capturing the callback's returned promise): `the transition's update resolves after the new page's onInitializedAsync`; `it resolves after 1500 ms when the hook never settles` (fake timers or a short injectable cap); `a page without async hooks resolves in the same microtask turn as before`; `onParametersSetAsync on a kept page is awaited too`.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement**: collect the pending promises the navigation's commit starts (the `settle` calls for the matched page) into a list the transition's callback awaits with `Promise.race([Promise.allSettled(list), delay(1500)])`; no list, no await.
- [ ] **Step 4: Run** `bun test ./runtime`, expect PASS.
- [ ] **Step 5: Commit** `feat(runtime): view transitions wait for the new page's data`.

### Task 3: `serveDist` and `xzor serve`

**Files:**
- Modify: `runtime/server.ts` (new `serveDist`), `src/di/emit.rs` (~871-900: the generated server calls `serveDist` instead of inlining), `npm/xzor/bin/xzor.js` (dispatch `serve`), `package.json` (`"serve"` script for the repo), `tests/server.test.ts`, `tests/di.test.ts` (generated text)
- Create: `npm/xzor/bin/serve.ts`, `tests/serve.test.ts`; add `bin/serve.ts` to `npm/xzor/package.json` `files`

**Interfaces:**
- Produces: `export function serveDist(root: string): { routes: Record<string, (req: Request) => Response>; fallback: (req: Request) => Response; found: boolean }` — reads `dist/pages.json` (routes -> shells, files -> `staticFiles`, `/index.html` alias), fallback = `index.html` with 404 (`dist/index.html` if present); `found` false when `pages.json` is missing (then `routes` holds `index.html` only if it exists).
- `serve.ts` argv: `<xzor binary> [dir] [--port N] [--host H]`; runs `<binary> build <dir> --minify`, then `bun <dir>/dist/server.js` (env `PORT`, `HOST`) if it exists, else `Bun.serve({ hostname, port, routes, fetch: fallback })` from `serveDist(dir)`; prints `xzor: serving <url>`.
- Repo script: `"serve": "cargo build -q && bun npm/xzor/bin/serve.ts target/debug/xzor"` so `bun run serve examples/blog` works.

- [ ] **Step 1: Write failing tests**: `tests/serve.test.ts`: browser-only app (copy `examples/counter`-like fixture with `@page`s and `index.html`) served by `serve.ts` on port 0 answers a page route with its shell (`modulepreload`), `/dist/main.js` 200, `/nope` 404 with index.html; a server app (the server fixture) is run through `dist/server.js`; a browser-only app with no `@page` serves `index.html`; listens on localhost by default. `tests/di.test.ts`: the generated server imports `serveDist` and no longer inlines the pages.json logic; existing server tests still pass.
- [ ] **Step 2: Run**, expect FAIL.
- [ ] **Step 3: Implement.** Keep the generated server's behavior identical (same routes, alias, fallback, `XZOR_DEV` handling, log line when `pages.json` is missing).
- [ ] **Step 4: Run** `cargo build; cargo test; bun test ./runtime ./tests`, expect PASS. Run `bun run serve examples/blog` briefly and GET `/` (200).
- [ ] **Step 5: Commit** `feat(cli): xzor serve runs any app in production form`.

### Task 4: Blog layout shift, docs

**Files:**
- Modify: `examples/blog/client/app.css` (`main.page { min-height: 100dvh }`), `README.md`, `docs/design.md` (Server apps: serving headers, `xzor serve`; Routing: view transitions wait), `docs/site/pages` (Start/Recipes where running apps is described), `npm/xzor/skills/xzor/SKILL.md`, `.github/skills/spec-rehydration/features.md` (Page shells and Server rows: `serveDist`, `serve.ts`)

- [ ] **Step 1:** Edit docs and CSS; `bun run docs` and `bun run examples` pass.
- [ ] **Step 2: Controller check (browser):** build the blog with `--minify`, serve it, load `/` and a post: one `main.css` request per load; layout shift score below 0.1 on `/`; clicking a post title morphs the headline (view-transition snapshot contains the `post-<slug>` name).
- [ ] **Step 3: Commit** `docs: xzor serve, cache headers, view transitions; blog reserves its main area`.
