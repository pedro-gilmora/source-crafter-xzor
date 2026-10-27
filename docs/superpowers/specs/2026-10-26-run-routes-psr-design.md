# `@Run`, `@Routes`, page shells (PSR) and endpoints

Status: approved 2026-10-26.

## Goal

One way to start an xzor app in the browser and on the server, one routes block, and a production build that serves each page with exactly the code it needs, from a server the compiler writes.

## Decisions

1. `@Mount(App, "app")` becomes `@Run(App, "app", options?)` in the browser entry.
2. `@ClientRoutes(route) { ... }` and `@ServerRoutes(route) { ... }` become one `@Routes(route) { ... }`. How links navigate moves to `@Run`: `{ navigation: "client" }` (default, History API) or `{ navigation: "server" }` (every link is a page load).
3. The server entry is the file with a class marked `@Run()` (API only) or `@Run<Application>()` (also serves that browser app, through a type-only import), implementing `IServerApplication`, whose members are `Bun.serve` options. `server.ts` by convention; the name is not required.
4. Endpoints are classes marked `@Endpoints("/prefix")` with `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Query` methods (bare or with a relative pattern), found automatically in the server entry's folder and below. Method parameters come in a fixed order: path params, then `query`, then `body`.
5. `xzor build --minify` writes a page shell per `@page` (PSR), and, when a server entry exists, `dist/server.js`, which serves shells, assets and endpoints from memory.
6. No aliases for the old names: they are compile errors that name the replacement (0.1.x).
7. Contracts are plain interfaces an `@Endpoints` class implements, with each method's real return type (sync or `Promise`). The browser reaches them through a generated HTTP client typed `Remote<IContract>`, where every result is a `Promise`. The server never sees `Remote` or the client.

## Layout

One project (one `tsconfig.json`), so one build sees every role. Roles come from markers, not folder names; `xzor init` uses these names by convention:

```
client/     main.ts (@Run(Shell, "app")), pages, components
contracts/  posts.ts (interface IPosts), shared types (Post, NewPost)
server/     server.ts (@Run<Application>() or @Run()), api/posts.ts (@Endpoints)
```

| Role | Found by | Runs in |
|---|---|---|
| Browser app | `@Run(Component, "id")` | browser |
| Server | `@Run()` / `@Run<App>()` | Bun |
| Endpoint | `@Endpoints` class under the server entry's folder | Bun |
| Contract | an interface an `@Endpoints` class `implements` | types only |
| HTTP client | generated per contract | browser |

## Browser entry

```ts
// main.ts
@Run(Shell, "app")                            // client navigation
@Run(Shell, "app", { navigation: "server" })  // or: every link loads its page shell
@Import(DataServices)
export class Application implements IApplication {}
```

- Same rules as `@Mount` today: one per entry, the build writes `.xzor/<entry>` with the subclass and the start call, decorators do nothing at runtime.
- The options object must be a literal (the build reads it). The generated entry passes `navigation` to the runtime's start call, which sets a module-level flag before the app is built; `addRoutes` reads it once, when its router is created (no cost per render).
- `navigation: "server"` keeps today's `@ServerRoutes` behavior: route matched once on load, no History API, `route.navigate` assigns `location.href`, regex sections are a build error (reported on the regex section, naming the `@Run` line).

## Routes block

`@Routes(route) { ...sections... }`: the sections, matching order, `route` object, `href` table, `NavLink`, view transitions and base path are unchanged. Only the keyword and where the engine comes from change. `@Routes` opens a block only when `(name)` is followed by `{`, so an expression `@Routes(x)` elsewhere still parses as an expression.

## Page shells (PSR)

`xzor build --minify` additionally writes:

- `dist/pages/<Page>.html` for each `@page` component: the project's `index.html` with `<link rel="modulepreload" href="...">` before `</head>` for every chunk in the static-import closure of `main.js` and of the page's chunk (deduplicated, `main.js` itself excluded, hrefs written like the `index.html` reference to `dist/main.js` so `<base href>` keeps working).
- `dist/pages.json`: `{ "routes": { "<pattern>": "pages/<Page>.html", ... }, "files": [...] }`: every `@page` pattern with its shell, and the list of files the server may serve (the browser build's outputs except maps, the shells, `index.html`). The server serves that list and nothing else.
- `.br` and `.gz` copies (brotli quality 11, gzip level 6) of every text output (`js`, `css`, `html`, `json`, `svg`); already-compressed types (`woff2`, `woff`, images) are not compressed.

The chunk graph comes from Bun's metafile (`metafile: true`): each output's `import-statement` imports, and the output that holds each page module, so nothing is guessed from file names or parsed from code. No per-page entry script: preloading the page chunk makes the router's `import()` resolve from the module map (measured in the POC, `docs/plans/backlog-page-shells.md`). Without `--minify` nothing is written (one bundle, nothing to preload).

## Server entry

```ts
// server/server.ts
import type { Application } from "../client/main";

@Run<Application>()  // or @Run(): API only, no shells or assets
@Import(DataServices)
export class Server implements IServerApplication {
  port = 3000;
  http2 = true;
  tls = { key: Bun.file("key.pem"), cert: Bun.file("cert.pem") };
  routes = { "/health": new Response("ok") };  // merged after the generated routes
}
```

- `IServerApplication` (from `@source-crafter/xzor-runtime/server`) is `Bun.serve`'s options minus `fetch` being required. The class is a DI application like the browser one: registrations, `@Import`, constructor injection.
- `@Run<T extends IApplication>()` tells the build which browser app to serve; the import is type-only, so no browser code or CSS reaches the server. `@Run()` serves endpoints and its own `routes` only.
- The build writes `.xzor/<server entry>`: builds `Server$`, the endpoint instances, and calls `Bun.serve({ ...members, routes: { ...shells, ...assets, ...endpoints, ...members.routes } })` (shells and assets only with `<Application>`). `fetch` (if declared) gets what no route matched; otherwise, serving an app, unknown paths get `index.html` with status 404 so the client `@notFound` renders, and an API-only server answers 404.
- `xzor build --minify` bundles it with `target: "bun"` to `dist/server.js`. Run with `bun dist/server.js` from the project root. It is not in `pages.json`'s file list, so it is never served.

## Endpoints

```ts
// server/api/posts.ts
@Endpoints("/api/posts")
export class Posts implements IPosts {
  constructor(private store: PostStore) {}

  @Get(":slug")
  get(slug: string): Post | undefined { return this.store.find(slug); }

  @Get
  list(query: { tag?: string; page?: number }): Post[] { return this.store.list(query); }

  @Post
  async create(body: NewPost): Promise<Post> { return this.store.add(body); }
}
```

- **Discovery**: every exported `@Endpoints` class in `.ts` files under the server entry's folder (not `node_modules`, `.xzor`, `dist`). `implements` is optional: a class without a contract is still served, it just gets no generated client.
- **Paths**: prefix and method pattern join on `/` (`"/api/posts"` + `":slug"` = `/api/posts/:slug`; bare = the prefix). Bun pattern syntax, no trailing slash. Two handlers for one method and path: build error naming both.
- **Parameters**, in this order (build errors point at the method):
  1. the path's `:params`, all of them, named and ordered as in the pattern, converted like `@page` params (`number`, `boolean`, string-literal union, else `string`);
  2. optionally `query`: an object type, each key converted the same way, read from the search string;
  3. optionally `body`: the parsed JSON body (typed, not validated), only on `POST`, `PUT`, `PATCH` and `QUERY`.

  `query` and `body` are reserved names (a path param can't use them). Anything else is a build error. The request itself (headers, cookies) is a DI service: any service or endpoint class can take `Request` as a constructor parameter, resolved from the request's scope. Classes that need it, directly or through their services, are built per request in a scope holding that `Request` (decided at build time; the others keep the direct call). A singleton, or anything built once at server start, that needs `Request` is a build error naming the chain (`AuthCache -> CurrentUser -> Request`). Contracts only carry what a browser can send.
- **Methods**: `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, and `@Query` (the HTTP `QUERY` method: a safe read with a body). If `Bun.serve` route objects don't take a `QUERY` key, a path with a `QUERY` handler gets one route function that switches on `req.method`.
- **Results**: `Response` as is; `undefined`/`null` gives 404; any other value `Response.json(value)`; `Promise` awaited first; `throw new HttpError(status, message)` gives that status; a path or query value that fails its conversion gives 400 before the method runs.
- **Generated handlers**: one per method and path, calling the method directly. Synchronous unless the method's declared return type is a `Promise` (an always-`async` handler costs 319 ns against 187 ns per request). `query` reads only the declared keys (`searchParams.get("tag")`) into one object literal.
- **Instances**: built once at server start with constructor injection; a class that injects a scoped service is built per request in a new scope instead (decided at build time).
- **Browser safety**: a browser module importing an `@Endpoints` class as a value is a build error ("use import type").

## Contracts and clients

```ts
// contracts/posts.ts: the server's real signatures, sync where the work is sync
export interface IPosts {
  get(slug: string): Post | undefined;
  list(query: { tag?: string; page?: number }): Post[];
  create(body: NewPost): Promise<Post>;
}
```

- **`Remote<T>`** (types only, from the runtime): every method of `T` with its result `R` turned into `Promise<Awaited<R>>`; non-method members become `never`. Parameter names, optional parameters and doc comments carry over.
- **Generated client**: for each interface an `@Endpoints` class implements, the build writes `.xzor/clients/<IContract>.ts`, a class whose methods keep the contract's parameters in the same order and `fetch` the matching route (path params encoded into the path, `query` into the search string, `body` as JSON), read `Response.json()` back, and throw a non-2xx status as `HttpError`, and registers it in each browser app for `Remote<IContract>`. Only clients a browser app injects are bundled.
- **In `.xzor` files**, `@inject IPosts posts` where `IPosts` is a contract generates the field as `readonly posts: Remote<IPosts>`: the component writes the contract's name and type-checks against the async view. Hover shows the `Remote` type.
- **In `.ts` files** of a browser app, write `Remote<IPosts>` (a constructor parameter typed `IPosts` there is a build error suggesting `Remote<IPosts>`): `tsc` reads `.ts` files as written, so nothing can rewrite them.
- **On the server** `IPosts` is the real interface: `implements IPosts` checks each method exactly as declared, and a server service can inject `IPosts` and get the `@Endpoints` instance.

## Serving

- At start the server reads the files in `pages.json`'s list and their `.br`/`.gz` copies (no compression at start: measured 218 ms and 14 MB for the blog with brotli at start, about 10 ms and 9 MB with build-time copies). Files over 1 MB are served with `Bun.file`, their copies too.
- Each file gets one handler holding prebuilt `Response`s (brotli, gzip, raw) and a precomputed ETag. It answers `If-None-Match` with 304, otherwise returns a `.clone()` of the encoding `Accept-Encoding` allows, with `vary: accept-encoding`. Choosing the encoding per request turns off Bun's static-route ETag handling, so the handler does it.
- `dist/chunks/*` and fonts: `cache-control: public, max-age=31536000, immutable`. Shells, `index.html`, `main.js`, `main.css`: `no-cache`.

## Development

`xzor dev` with a server entry: runs the generated server instead of the static file server, in dev mode (no shells, no compression, `index.html` with the hot client for page paths, endpoints live). It restarts the server when a file under the server entry's folder, or a contract it implements, changes; `.xzor` edits keep patching in place as today.

## Out of scope

Body validation, middleware, OpenAPI, streaming or WebSocket endpoints in contracts, static-host output (`dist/<path>/index.html`), pre-rendered markup, `bun build --compile`, separate tsconfig projects per role.

## Touches

### Routing - specs/2026-10-13-routing-cascading-design.md, design.md Routing
- Holds: at most one routes block per project; a `@page` component can't hold it; sections, matching order, `route`, `href`, `NavLink`, base path, view transitions unchanged; regex sections are client-only.
- Changes: `@ClientRoutes`/`@ServerRoutes` become `@Routes`; `Engine` leaves the parser and `Node::Routes` (`src/routes.rs` `Engine`, `RoutesBlockInfo.engine`); `addRoutes(engine, ...)` loses `engine` and reads the navigation set at start; the regex-section check moves to the build, which knows the entry's `navigation`.
- Migrates: `src/parser.rs` (DIRECTIVES, the `(` lookahead at ~419, routes_block, about 14 error-message tests), `src/codegen.rs` (~1282 and its tests), `runtime/index.ts` (`addRoutes`, comments at 178/185/199/298/671), `runtime/router.test.ts`, `tests/routing*.test.ts`, 4 examples' `Routes.xzor`, docs site snippets.

### Dependency injection - specs/2026-10-12-di-bootstrap-design.md, design.md Dependency injection
- Holds: decorators are no-ops at runtime; one application decorator per entry (ZDI07); constructor parameters resolve by key then type; singletons static, scoped per scope; async services spread; `@inject` needs an application (ZDI04); a component with `@inject` can't declare a constructor (ZDI08).
- Changes: `@Mount` becomes `@Run` (`src/build.rs` `declares_provider` at ~648 checks `@Run(` and `@Run<`; `src/di.ts`/`src/di/` read it); ZDI07/ZDI04 messages say `@Run`; a second application kind (server) with its own generated entry; `@Endpoints` classes are resolved like providers' services (constructor injection, scoped-per-request rule) and registered on the server under the contracts they implement; each browser app gets the generated clients registered under `Remote<IContract>` (a generic type as a DI key: the analyzer resolves it like any other type).
- Migrates: `IApplication` stays; `mount()` stays the runtime's internal start call (generated code only) and gains the navigation option.

### Bundle and `--minify` - design.md Fine components (`--minify`), Build
- Holds: `dist/main.js`/`main.css` keep their names; chunks in `dist/chunks` (cleared each build); chunk CSS folded into `main.css`; fonts copied to `dist/fonts`; maps composed; `src/bundle.ts` is embedded (rebuild after edits).
- Changes: `--minify` turns on `metafile: true`, then writes `dist/pages/*.html`, `dist/pages.json` and the `.br`/`.gz` copies (about 90 ms more for the blog, brotli 11 on 112 kB of text); with a server entry, a second `Bun.build` (`target: "bun"`) of `.xzor/<server entry>` to `dist/server.js`.

### PWA - plans/2026-10-14-pwa.md, design.md Build
- Holds: precache list (index.html, manifest, icons, local refs, outputs except maps); navigations network-first, falling back to the cached `index.html`.
- Changes: nothing in the worker. Shells are build outputs, so they join the precache list; the offline fallback stays `index.html` (it renders any page, and the chunks are cached).

### Watch, hot reload, `xzor dev` - plans/2026-10-14-hot-reload.md
- Holds: `.xzor`-only changes patch in place; anything else reloads; `/sw.js` answered with a retiring worker in dev; unknown paths get `index.html`.
- Changes: with a server entry, `xzor dev` runs the generated server in dev mode and restarts it on server-side `.ts` changes (see Development).

### Language server - specs/2026-10-11-lsp-design.md
- Holds: completion snippets for directives; semantic tokens from TypeScript plus `syntaxTokens`; hover and diagnostics go through the generated code's mappings.
- Changes: completion offers `@Routes(${1:route})` instead of the two old snippets (`src/lsp/features.rs` ~464 and tests ~847); the old names get a diagnostic with the replacement (from the parser error). Hover on an `@inject` of a contract shows `Remote<IContract>` (it is the generated field's type, through the existing mapping).

### Component codegen (`@inject`) - design.md Components: `@inject`
- Holds: `@inject T name` adds a constructor parameter and a `readonly name` field; the type text is copied as written.
- Changes: when `T` is a contract (known from the DI analysis, which already runs before the type check), the field and parameter are typed `Remote<T>`. The compiler learns the contract names from the analyzer's output, so `.xzor` codegen gains one input: the set of contract names.

### VS Code grammar, Zed, `xzor highlight`
- Changes: TextMate regex `(ClientRoutes|ServerRoutes)` becomes `Routes` (`editors/vscode/syntaxes/xzor.tmLanguage.json` ~203; `editors/vscode/test/gen.ts` ~118, then regenerate). Zed gets the change through the LSP's `syntaxTokens` (no query mentions the names). `src/highlight.rs` follows the parser's directive list.

### Project setup and packaging
- Holds: tsconfig `rootDirs`, `include`, `ESNext.Disposable`/`ESNext.Decorators`; a `.xzor` must not import from `./main` (the server entry's type-only import of the browser entry is a `.ts` outside `.xzor/` and is erased; the plan pins with a test that `rootDirs` resolves it to the real entry, which exports `Application`, not to the generated one).
- Changes: `npm/runtime/package.json` gains the `./server` export (`IServerApplication`, `Run` server overload, `Endpoints`, `Get`...`Delete`, `HttpError`, `reply`); it references Bun's types, so a project with a server entry needs `@types/bun` (`xzor init` adds it); `Remote<T>` is in the main export (types only, used by browser code); the generated tsconfig `paths` gain `@source-crafter/xzor-runtime/server`.

### `xzor init`, examples, kit
- Changes: templates and the 4 examples' `main.ts` use `@Run`, their `Routes.xzor` use `@Routes`. The blog example becomes the reference app in the `client/`, `contracts/`, `server/` layout: one contract (`IPosts`), its `@Endpoints` class, and pages reading posts through `@inject IPosts`. `xzor init` gains a template with that layout. The kit has no routes block and no `@Mount`: nothing changes.

### Perf and memory
- Holds: generated code allocates no more than hand-written code; fields over `WeakMap`s and closures.
- Measured at design (perf pass, Bun 1.4.0): generated sync endpoint 187 ns/request against 188 hand-written; number param check +12 ns; always-`async` 319 ns (so handlers are sync unless needed); server start for the blog about 10 ms and 9 MB with build-time compression (218 ms and 14 MB compressing at start); chunk graph from the metafile instead of a regex pass (2.3 ms, but regex could match strings in code). To measure in the plan: requests/second for a shell, a chunk (with the 304 handler) and an endpoint against a hand-written `Bun.serve`.

### Errors and diagnostics
- New: old keywords (`@ClientRoutes`, `@ServerRoutes`, `@Mount`) name their replacement; regex section under server navigation; unknown endpoint parameter; duplicate method and path; `@Endpoints` imported as a value into the browser; `@Run` options not a literal.

### Docs
- `README.md`, `docs/design.md` (Routing, Dependency injection, Build, new Server section), docs site pages that show routes or `@Mount` (Start, Learn, HowItWorks, Recipes), `npm/xzor/skills/xzor/SKILL.md`, `docs/plans/backlog-page-shells.md` (status: being built), and `.github/skills/spec-rehydration/features.md` (new rows: Server entry, Endpoints; Page shells code paths).
