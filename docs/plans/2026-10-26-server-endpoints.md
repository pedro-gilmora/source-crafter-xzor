# Server Apps and Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** A server app (`@Run(Shell)` or `@Run()` on an `IServerApplication`) and `@Endpoints` classes compile to a generated `Bun.serve` that serves endpoints and, with `Shell`, the compiled views (page shells and assets), with one set of registrations split between browser and server.

**Architecture:** A new runtime subpath `@source-crafter/xzor-runtime/server` holds the no-op decorators, `HttpError`, `reply` and the file-serving handler. The DI analyzer (`src/di.ts`, `src/di/`) reads the app kind from the class's `implements`, finds the endpoint classes, validates parameters, splits registrations by reachability, and emits two entries: `.xzor/client.ts` (browser: views' services, `mount(Shell, document.body, ...)`) and `.xzor/<app file>` (Bun: one handler per method and path). The build bundles both; `xzor dev` runs the server.

**Tech Stack:** Bun 1.4 (`Bun.serve` routes, `http2`), TypeScript 7 analyzer session, Rust (zero deps).

**Spec:** [docs/superpowers/specs/2026-10-26-run-routes-psr-design.md](../superpowers/specs/2026-10-26-run-routes-psr-design.md) (sections Decisions, Layout, Server app, Endpoints, Splitting registrations, Serving, Development; Touches: DI, Project setup, `xzor dev`, Perf).

**Depends on:** the `@Run`/`@Routes` plan (`@Run`), the page shells plan (`pages.json`, compressed copies).

## Global Constraints

- Endpoint parameters, in order: the path's `:params` (all, named and ordered as in the pattern), then optional `query`, then optional `body` (only `POST`, `PUT`, `PATCH`, `QUERY`). `query` and `body` are reserved names. Anything else: build error at the parameter.
- Conversions like `@page` params: `number` (`Number`, `NaN` is a 400), `boolean` (`"true"`/`"false"`), string-literal union (must be one), else `string`; `query` reads only declared keys with `searchParams.get`.
- Results: `Response` as is; `undefined`/`null` 404; else `Response.json(value)`; `Promise` awaited; `HttpError(status, message)` that status.
- Handlers are synchronous unless the method's declared return type is a `Promise`.
- Endpoint instances are built once at start; a class needing `Request` (directly or through its services) is built per request in a scope holding it; a singleton or start-built class needing `Request` is a build error naming the chain.
- Discovery: exported `@Endpoints` classes in `.ts` files under the `@Run` file's folder, not `node_modules`, `.xzor`, `dist`.
- App kind from `implements`: `@Run(Shell)` / `@Run()` require `IServerApplication`; `@Run(Shell, "app")` requires `IApplication`; a mismatch is a build error at the decorator.
- Registrations split by reachability: browser = what views reach (contracts resolve to generated clients), server = what endpoints and the app class reach; both sides get shared ones; a view reaching `Request`, an `@Endpoints` class, or a `bun:*`/`node:*` module is a build error naming the chain.
- Paths: prefix and method pattern join on `/` (`"/api/posts"` + `":slug"` = `/api/posts/:slug`, bare = the prefix); Bun pattern syntax, no trailing slash.
- Serving: only `pages.json`'s `files`; one handler per file with prebuilt brotli/gzip/raw `Response`s, precomputed ETag, 304 on `If-None-Match`, `vary: accept-encoding`; `dist/chunks/*` and fonts `public, max-age=31536000, immutable`, others `no-cache`; files over 1 MB through `Bun.file`.
- No compression at server start. Perf targets (spec): sync endpoint about 187 ns/request in-process, blog server start about 10 ms and 9 MB.

## Review Focus

- Two `@Endpoints` classes declaring the same method and path: one error naming both files: test in Task 3.
- A `:param` whose name is `query` or `body`: build error at the pattern: test in Task 3.
- `GET` with a `body` parameter: build error: test in Task 3.
- `If-None-Match` with a stale ETag gets 200 and the new ETag; a client sending no `Accept-Encoding` gets the raw bytes: test in Task 1.
- A browser module importing an `@Endpoints` class as a value: build error "use import type": test in Task 4.

---

### Task 1: Runtime server subpath

**Files:**
- Create: `runtime/server.ts`, `runtime/server.test.ts`
- Modify: `runtime/index.ts` (`Run` overload), `npm/runtime/package.json` (exports `./server`), `src/build.rs` (generated tsconfig `paths`), `Package.ps1` if it lists runtime files

**Interfaces:**
- Produces (`runtime/server.ts`):
  - `export interface IServerApplication extends Partial<Bun.Serve.Options<undefined>> {}` (nothing required)
  - `export const Endpoints: (prefix: string) => ClassDecorator`; `Get`, `Post`, `Put`, `Patch`, `Delete`, `Query`: each usable bare (`@Get`) and called (`@Get(":slug")`), no-ops
  - `export class HttpError extends Error { constructor(readonly status: number, message?: string) }`
  - `export function reply(value: unknown): Response` (rules above, sync) and `export function replyAsync(value: Promise<unknown>): Promise<Response>`
  - `export function staticFiles(root: string, files: string[]): Record<string, (req: Request) => Response>` (reads files and their `.br`/`.gz` copies once)
- Produces (`runtime/index.ts`): `Run` overloads `Run(component: Function, target: string): ClassDecorator` (browser app), `Run(component: Function): ClassDecorator` and `Run(): ClassDecorator` (server app); all no-ops.

- [ ] **Step 1: Write failing tests** in `runtime/server.test.ts`: `reply` (object to JSON 200, `undefined` 404, `Response` passthrough, `HttpError(409)` via `replyAsync(Promise.reject(...))` gives 409); `staticFiles` on a temp dir with `a.js`, `a.js.br`, `a.js.gz`, `chunks/b.js`: `accept-encoding: br` gets the `.br` bytes with `content-encoding: br` and `vary: accept-encoding`; no header gets raw; `If-None-Match` with the ETag gets 304 and no body; `chunks/b.js` has `immutable`, `a.js` has `no-cache`.
- [ ] **Step 2: Run** `bun test ./runtime/server.test.ts`, expect FAIL.
- [ ] **Step 3: Implement**; `staticFiles` returns `.clone()` of prebuilt responses.
- [ ] **Step 4: Run** `bun test ./runtime`, expect PASS.
- [ ] **Step 5: Commit** `feat(runtime): server subpath (decorators, reply, static files)`.

### Task 2: Analyzer: server application and endpoints facts

**Files:**
- Modify: `src/di.ts` (decorator kinds, `@Run` reading ~234), `src/di/model.rs`, `tests/di.test.ts`
- Create: `tests/fixtures/server/` (a `client/main.ts` + `server/server.ts` + `server/api/posts.ts` project)

**Interfaces:**
- Produces facts: `Server { class, file, at, root: Option<TypeRef> }` (from `@Run(Shell)` / `@Run()` on a class implementing `IServerApplication`; `root` is `Shell`); `Endpoint { class, file, prefix, ctor: Param[], methods: [{ name, verb, pattern, params: [{ name, type, kind: "path" | "query" | "body" }], returnsPromise: bool, at }] }`; the JSON adds `servers` and `endpoints` arrays.

- [ ] **Step 1: Write failing tests**: the fixture (`server/app.ts` with `@Run(Shell)` on an `IServerApplication`, `client/Shell.xzor`, `server/api/posts.ts`) yields one server with `root` = `Shell`, one endpoint class `Posts` with three methods and their param kinds; `@Get` bare yields `pattern: ""`; `async create(...)` yields `returnsPromise: true`; `@Run(Shell, "app")` on an `IServerApplication` and `@Run(Shell)` on an `IApplication` each report the kind mismatch; the app file is found without `--entry` (scan for `@Run`).
- [ ] **Step 2: Run** `bun test ./tests/di.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** reading with the TypeScript checker (parameter types for conversions, return type for `returnsPromise`); discovery restricted to the server file's folder.
- [ ] **Step 4: Run**, expect PASS. **Step 5: Commit** `feat(di): server and endpoint facts`.

### Task 3: Validation and the generated server

**Files:**
- Modify: `src/di/graph.rs` (new diagnostics), `src/di/emit.rs` (server entry), `src/build.rs` (write `.xzor/<server entry>`), `tests/di.test.ts`

**Interfaces:**
- Consumes: Task 2 facts; `reply`, `replyAsync`, `staticFiles` (Task 1); `pages.json` (page shells plan).
- Produces: `.xzor/<app file>` (server): imports `../<app file>`, the endpoint modules and the runtime server subpath; builds `App$` (server container) and endpoint instances; `Bun.serve({ ...app, routes: { ...shellRoutes, ...staticFiles(dist, files), ...endpointRoutes, ...app.routes } })`; shell and static routes only when `root` is set; unknown paths: `index.html` with 404 when `root` is set, plain 404 otherwise. `.xzor/client.ts` (browser, only when `root` is set): imports the root view and the browser-reached services only (never the app file), builds the browser container, calls `mount(Shell, document.body, new Client$())`; the bundler takes it as the browser entry.

- [ ] **Step 1: Write failing tests** (diagnostic codes continue after the last ZDI number in `graph.rs`): duplicate method and path names both files; `:query` in a pattern; `GET` with `body`; a parameter that is neither a path param nor `query`/`body`; path params out of pattern order. Plus generated-code tests: a sync method emits a non-`async` handler calling `reply(...)`; an async method emits `async (req) => replyAsync(...)`; a `number` param emits a `Number(...)` with a 400 on `NaN`; `query` reads exactly the declared keys.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** First check with a scratch `Bun.serve` whether a route object accepts a `QUERY` key; if not, a path with an `@Query` handler emits one route function switching on `req.method` (405 for the others). Add the test `a QUERY endpoint receives its body`. **Step 4: Run** `cargo test; bun test ./tests/di.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `feat(di): generated Bun.serve for server entries`.

### Task 4: Registration split, `Request` scope, captive and leak checks

**Files:**
- Modify: `src/di/graph.rs`, `src/di/emit.rs`, `tests/di.test.ts`

- [ ] **Step 1: Write failing tests**: with `@Run(Shell)`, `@Singleton(Theme)` and `@Import(DataServices)` on the app, and a view injecting `Theme`: `.xzor/client.ts` registers `Theme` and nothing from `DataServices`, and does not import the app file; the server entry registers both. An endpoint class injecting `CurrentUser(req: Request)` is built per request (generated handler opens a scope with the request); a class without it is built once; a `@Singleton(AuthCache)` taking `CurrentUser` reports `AuthCache -> CurrentUser -> Request is built once but needs the request`; a view injecting `CurrentUser` reports `Header -> CurrentUser -> Request: a view can't reach the request`; a view reaching a service whose module imports `bun:sqlite` reports the chain; a `.xzor` importing `Posts` as a value reports `Posts is an @Endpoints class: use import type`.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement.** **Step 4: Run**, expect PASS.
- [ ] **Step 5: Commit** `feat(di): registrations split between browser and server; Request scopes; leak checks`.

### Task 5: Build, measure, dev, example, docs

**Files:**
- Modify: `src/bundle.ts` or `src/build.rs` (second `Bun.build`, `target: "bun"`, to `dist/server.js`), `npm/xzor/bin/dev.ts`, `npm/xzor/bin/init.ts` (server template, `@types/bun`), `examples/blog` (move to the `client/`, `contracts/`, `server/` layout with `server/app.ts` holding `@Run(Shell)`; `PostStore`, `Posts` endpoints; its `index.html` body loses `<div id="app">`), `README.md`, `docs/design.md` (new Server section), `docs/site/pages` (Start, Learn, Recipes), `npm/xzor/skills/xzor/SKILL.md`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing end-to-end test** in `tests/server.test.ts`: build the fixture with `--minify`, start `bun dist/server.js` on port 0 (`PORT=0`, read the printed URL), then: `GET /` returns the Home shell with `modulepreload`s; `GET /posts/x` returns the Post shell; `GET /api/posts/x` returns JSON; `GET /api/posts/x` for a missing post 404; `GET /dist/server.js` 404; `GET /nope` 404 with `index.html`'s body.
- [ ] **Step 2: Run**, expect FAIL. **Step 3: Implement** the server bundle and the blog move. **Step 4: Run** `bun test ./runtime ./tests`, expect PASS.
- [ ] **Step 5: Measure** with a scratch script under `target/`: blog server start time and resident memory (spec target about 10 ms, 9 MB); requests/second for a shell, a chunk (304 path and 200 path) and `GET /api/posts/:slug` against a hand-written `Bun.serve` doing the same; record numbers in the commit body; fix any regression over 10% before committing.
- [ ] **Step 6: Implement `xzor dev`**: with a server entry, run the generated server in dev mode (`XZOR_DEV=1`: no shells, no compression, `index.html` plus the hot client for page paths) and restart it on `.ts` changes under the server folder or in a contract an endpoint class implements; test in `tests/dev-hot.test.ts`: `an endpoint edit restarts the server and the new JSON is served`.
- [ ] **Step 7: Docs** per Global Constraints of the `@Run` plan, plus `design.md` Server section and the spec-rehydration feature map rows (code and test paths).
- [ ] **Step 8: Run** every command, expect PASS. **Step 9: Commit** `feat: server entries and endpoints`.
