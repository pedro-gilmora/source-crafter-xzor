# Serve command, cache headers, and data-aware view transitions

Status: approved 2026-10-28.

## Goal

Run any xzor app in production form with one command, stop the generated server from fetching `main.css` twice, and keep view transitions working when the new page loads its data asynchronously.

## Decisions

1. **`xzor serve [dir] [--port N] [--host H]`**: builds with `--minify`, then serves.
   - Server app (`dist/server.js` exists): runs `bun dist/server.js` with `PORT`/`HOST`.
   - Browser-only app: serves `dist/` with the same page shells (`pages.json` routes), precompressed copies and headers as a server app, through the runtime's `staticFiles` and a shell router. So "PSR" works for browser-only apps too.
   - The npm launcher dispatches `serve` like `dev` (`npm/xzor/bin/serve.ts`); inside this repo, `bun run serve <dir>` (root `package.json` script) does the same with `target/debug/xzor`.
   - `localhost` by default; `--host` opts in, as in `xzor dev`.
2. **Cache headers**: files that aren't content-hashed (`main.js`, `main.css`, `index.html`, shells) get `cache-control: no-cache` and no `ETag`; revalidation uses `Last-Modified` (the build time). Measured: an `ETag` without a freshness lifetime makes Chrome fetch the stylesheet a second time per page load (initiator "other", answered 304); without the `ETag` it loads once. Hashed chunks and fonts keep `immutable` and their `ETag`.
3. **View transitions wait for the new page's data**: when `viewTransitions(true)` is on, the transition's update callback resolves only after the matched page's pending `onInitializedAsync`/`onParametersSetAsync` settle, capped at 1500 ms (then it commits what is there). Elements with a `view-transition-name` that appear once the data arrives are captured in the new snapshot, so they morph.
4. **Layout shift in the blog**: `main.page { min-height: 100dvh }` in the blog's CSS keeps the footer below the fold while data loads (measured CLS 0.39 before).

## Out of scope

Inlining API data into shells (server-side data), prefetching API data from shells, content-hashed `main.js`/`main.css`.

## Touches

### Page shells and serving - specs/2026-10-26-run-routes-psr-design.md (Page shells, Serving)
- Holds: `pages.json` is the allow-list; precompressed copies; `/index.html` alias; 404 fallback to `index.html`.
- Changes: non-hashed files lose their `ETag` and use `Last-Modified`; browser-only apps are served with shells by `xzor serve`.

### Routing - specs/2026-10-13-routing-cascading-design.md
- Holds: navigation commits inside `startViewTransition` when on; a skipped transition is not an error; navigation stays synchronous without it.
- Changes: with transitions on, the commit's update callback awaits the new page's pending async lifecycle hooks (capped at 1500 ms).

### `xzor dev` and the CLI launcher - plans/2026-10-14-hot-reload.md
- Holds: `dev` behavior unchanged; `localhost` default with `--host`.
- Changes: the launcher gains `serve`.

### Perf and memory
- Holds: no per-request allocation beyond hand-written code.
- Changes: no `ETag` comparison for non-hashed files (one header check for `If-Modified-Since` instead).

### Docs
- README, `docs/design.md` (Server apps: serving, CLI; Routing: view transitions), docs site, user skill, feature map.
