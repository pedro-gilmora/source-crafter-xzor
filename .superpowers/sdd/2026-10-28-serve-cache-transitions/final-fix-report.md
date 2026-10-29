# Final-review fix wave: serve, cache headers and view transitions

## Fixed
1. Important (allow-list): `src/bundle.ts` now writes `dist/pages.json` for every `--minify` build that has an `index.html` (`routes: {}` without `@page`; server-app output unchanged). `serveDist` lost its `dist/**` glob branch: without `pages.json` it serves only the project's `index.html` (`found` false); with `pages.json` and no routes, `index.html` also answers `/`.
2. Tests: `tests/serve.test.ts` asserts `/dist/main.js.map`, `/main.ts`, `/tsconfig.json`, `/.env`, `/dist/pages.json` return 404 for a browser-only app (with and without `@page`) and a server app (also `/dist/server.js`); the no-`@page` app still serves `/`, `/index.html`, `/dist/main.js`. `tests/bundle-shells.test.ts` covers `pages.json` without `@page`; `runtime/server.test.ts` covers both `serveDist` branches.
3. Docs: README, docs/design.md (also the Serving paragraph) and the user skill state that the app's own `port`/`hostname` override `--port`/`--host` and that `bun dist/server.js` reads `HOST` when the app sets no `hostname`.

## Verification
- `cargo build`: ok. `cargo test`: 321 unit + integration, 0 failed.
- `bun test ./runtime ./tests`: first full run 535 pass, 1 fail; final full run 536 pass, 0 fail.
- Flaky: `tests/blog.test.ts` "the blog's pages read posts through IPosts from the running server, and the bundle holds no post" failed (TS2345 `Remote<IPosts>` in `.xzor/client.ts`) in the first full run and in the immediate solo rerun, then passed on every later run (with the changes stashed and applied). Not reproducible; likely stale state in `target/` left by the concurrent `bun run examples`.
- `bun x tsc -p jsconfig.json --noEmit`: ok. `bun run docs`: ok (55 snippets). `bun run examples`: ok.

Not committed: `examples/*/.zed/`, `dist/`.
