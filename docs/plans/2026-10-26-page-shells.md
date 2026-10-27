# Page Shells (PSR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** `xzor build --minify` writes one HTML shell per `@page` preloading exactly its chunks, a `dist/pages.json` manifest, and brotli/gzip copies of text outputs.

**Architecture:** `build.rs` writes the page list (`.xzor/pages.json`: pattern and source file per `@page`) from the route table and passes it to `bundle.ts`; under `--minify`, `bundle.ts` turns on Bun's metafile, finds each page's output and its static-import closure, writes the shells from `index.html`, the manifest, and the compressed copies.

**Tech Stack:** Bun 1.4 (`Bun.build` metafile, `node:zlib`), Rust (zero deps).

**Spec:** [docs/superpowers/specs/2026-10-26-run-routes-psr-design.md](../superpowers/specs/2026-10-26-run-routes-psr-design.md) (sections Page shells, Serving: the build-time copies; Touches: Bundle, PWA).

**Depends on:** nothing (can ship before or after the `@Run`/`@Routes` plan).

## Global Constraints

- Shell = the project's `index.html` with `<link rel="modulepreload" href="...">` lines inserted before `</head>`, one per chunk in the static-import closure of `main.js` and of the page's output, deduplicated, `main.js` excluded, hrefs relative to the project root like `index.html`'s `dist/main.js`.
- `dist/pages.json` = `{ "routes": { "<pattern>": "pages/<Page>.html" }, "files": [ ... ] }`; `files` = browser outputs except `*.map`, the shells, `index.html`; never `server.js`.
- Compressed copies: brotli quality 11 (`.br`), gzip level 6 (`.gz`), for `js`, `css`, `html`, `json`, `svg` only.
- Chunk graph only from the metafile (`import-statement` imports); no regex over code, no file-name guessing.
- Without `--minify`: nothing new is written.
- `src/bundle.ts` is embedded in the binary: `cargo build` after editing it.

## Review Focus

- A page with several patterns (`@page "/a"` and `@page "/a/:id"`): both patterns map to the same shell: test in Task 2.
- `index.html` without `</head>` (or with `</HEAD>`): build error naming the file, not a silent shell without preloads: test in Task 2.
- Project with `<base href="/docs/">`: preload hrefs stay relative (`dist/chunks/...`), so they resolve under the base: test in Task 2.
- A page that is also imported statically elsewhere (no chunk of its own): its shell preloads the entry's closure only, no error: test in Task 2.
- PWA project: shells and `pages.json` join the precache list, `.br`/`.gz` copies don't: test in Task 3.

---

### Task 1: Page list from the build

**Files:**
- Modify: `src/routes.rs` (next to `table` ~204), `src/build.rs` (bundle invocation ~763)
- Test: `src/routes.rs` unit tests

**Interfaces:**
- Produces: `pub fn pages(root: &Path, units: &[Unit]) -> String` returning JSON `[{"pattern":"/posts/:slug","file":"pages/Post.xzor","name":"Post"}, ...]` (file relative to the project root, `/` separators); `build.rs` writes it to `.xzor/pages.json` when the project has `@page`s and passes `--pages <abs path>` to `bundle.ts` under `--minify`.

- [ ] **Step 1: Write failing test** `pages_lists_every_pattern_with_its_file`: two units, one with `@page "/"`, one with `@page "/a"` and `@page "/a/:id"`; JSON has three entries, the second unit's two share `file`.
- [ ] **Step 2: Run** `cargo test pages_lists`, expect FAIL.
- [ ] **Step 3: Implement** `pages` with `json.rs` helpers; wire `build.rs`.
- [ ] **Step 4: Run** `cargo test`, expect PASS.
- [ ] **Step 5: Commit** `feat(build): page list for the bundler`.

### Task 2: Shells and manifest in `bundle.ts`

**Files:**
- Modify: `src/bundle.ts` (`main` ~981, `Bun.build` ~999, outputs loop)
- Create: `tests/bundle-shells.test.ts`

**Interfaces:**
- Consumes: `--pages <path>` (Task 1).
- Produces: `export function pageShells(template: string, metafile: BuildMetafile, outdir: string, root: string, pages: PageEntry[]): { shells: Map<string, string>; routes: Record<string, string> }` (pure: shell file name to HTML, pattern to shell path), with `type PageEntry = { pattern: string; file: string; name: string }`; `main` writes `dist/pages/<name>.html` and `dist/pages.json`.

- [ ] **Step 1: Write failing tests** in `tests/bundle-shells.test.ts` (build a small project like `tests/routing.test.ts`'s `--minify` test, with `index.html` and three pages, one with two patterns):
  - `each page gets a shell preloading its closure`: `dist/pages/Post.html` contains a `modulepreload` for the `Post.xzor-*.js` chunk and for every chunk `main.js` imports, none for `Home.xzor-*`, none for `main.js`.
  - `pages.json maps every pattern`: both patterns of the two-pattern page point at its shell; `files` contains `dist/main.js`, the chunks, `index.html`, the shells, and no `.map`.
  - `hrefs stay relative under a base`: with `<base href="/docs/">`, hrefs start with `dist/`.
  - `index.html without </head> fails the build` with `index.html has no </head>`.
  - `a page without its own chunk preloads the entry's closure only`.
  - `pageShells` unit test on a hand-written metafile (no Bun build) for the closure and dedupe.
- [ ] **Step 2: Run** `cargo build; bun test ./tests/bundle-shells.test.ts`, expect FAIL.
- [ ] **Step 3: Implement**: `metafile: true` when minifying; page output = the output whose `entryPoint` or inputs include the page's file; closure walks `imports` with `kind === "import-statement"`.
- [ ] **Step 4: Run** `cargo build; bun test ./runtime ./tests`, expect PASS.
- [ ] **Step 5: Commit** `feat(bundle): page shells and pages.json under --minify`.

### Task 3: Compressed copies, PWA, docs

**Files:**
- Modify: `src/bundle.ts` (after outputs are final; `precacheList` ~884), `tests/bundle-shells.test.ts`, `tests/bundle-pwa.test.ts`, `docs/design.md` (Build, `--minify`), `README.md`, `docs/site/pages` (where `--minify` is described), `npm/xzor/skills/xzor/SKILL.md`, `docs/plans/backlog-page-shells.md` (status: built)

**Interfaces:**
- Produces: `export function compressOutputs(paths: string[]): string[]` (writes `.br`/`.gz` next to each text output, returns the written paths).

- [ ] **Step 1: Write failing tests**: `text outputs get .br and .gz copies` (`main.js.br` decompresses with `brotliDecompressSync` to `main.js`'s bytes; `main.js.gz` likewise with `gunzipSync`); `fonts are not compressed` (no `fonts/*.woff2.br`); in `bundle-pwa.test.ts`: `shells and pages.json are precached, compressed copies are not`.
- [ ] **Step 2: Run** `cargo build; bun test ./tests/bundle-shells.test.ts ./tests/bundle-pwa.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** with `brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })` and `gzipSync(buf, { level: 6 })`; `precacheList` skips `.br`/`.gz`.
- [ ] **Step 4: Measure** the blog: `cargo run -q -- build examples/blog --minify --timings` before and after; record the delta in the commit body (spec expects about +90 ms). Restore with `cargo run -q -- build examples/blog`.
- [ ] **Step 5: Docs**: `design.md` `--minify` bullet lists shells, `pages.json` and copies; README and site where `--minify` appears; user skill.
- [ ] **Step 6: Run** every command in the `@Run` plan's Global Constraints, expect PASS.
- [ ] **Step 7: Commit** `feat(bundle): brotli and gzip copies; page shells documented`.
