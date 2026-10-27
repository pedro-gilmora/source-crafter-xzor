# Routing and cascading values

Agreed in chat on 2026-10-13. Items marked *(controller's call)* were proposed and not objected to; they can be revisited.

## Intent

Blazor-like routing for zor apps whose engine is chosen in the template, working both as a browser SPA (History API) and as Bun.serve routes, plus Blazor-like cascading values with a compact syntax. Everything stays compile-time where possible: no route parsing at runtime, no `WeakMap`s, no wrappers the hand-written equivalent wouldn't have (repo premise: memory and performance first).

## Non-goals (deferred)

SSR, prerendering, streaming, server-side data loading, per-route lazy loading in client mode, an `@layout` directive, a `zor serve` command.

## Anti-goals

- A runtime route parser or path-to-regexp style library.
- Route syntax that differs between `@page` and Bun.serve.
- Hidden catch-all server routes.

## 1. Cascading values

Provide (template, any component):

```tszor
@cascade:theme(currentTheme) {
  <Toolbar/> <Content/>
}
@cascade:config(settings, fixed) { ... }
```

Receive (in `@code`):

```ts
@Cascade theme!: Theme;           // name = property name
@Cascade("theme") t!: Theme;      // explicit name
```

- Matched by name. The nearest enclosing provider with that name wins; a missing provider leaves the field as initialized.
- `@Cascade` needs no import: it is zor syntax, not a runtime export. zor recognizes it in `@code` at compile time, emits a static list of cascading members (name and property) on the class, and blanks the decorator out of the generated TypeScript.
- Providers live on the existing component/region vnode (a field), not in a `WeakMap`. Consumers resolve their provider once when mounted (walk up the parent chain) and subscribe. When the provider's value changes (`!==`) on re-render, only subscribed consumers get the new value and re-render (`onParametersSet` runs, like a prop change). `fixed` skips subscription entirely.
- The body of `@cascade` renders in place (like a region); a provider is not a component.

## 2. Routes: `@page`

```tszor
@page "/admin/users/:id" as admin
@page "/admin/users/:id/*" as admin
@page "/users/:id"
```

- Bun.serve pattern syntax: literal segments, `:param` segments, optional trailing `*`. The text matched by `*` fills a prop named `rest` when the page declares one *(controller's call)*.
- Several `@page` per component. Tags: `as <ident>`, at most one per `@page`, optional, shared by any number of routes; a tag groups routes for a routes-block section (typically a layout for a group of pages). A route without `as` has no tag. Tags `default`, `notFound`, `catch` are compile errors. Identical patterns on two routes are a compile error.
- Route params fill the page component's props of the same name. A param's type comes from the prop: `number` (via `Number`, `NaN` = no match), `boolean` (`"true"`/`"false"`, else no match), a string-literal union (value must be one of them), anything else `string`. zor reads the prop's type annotation or initializer; mismatch = the route does not match.
- `static readonly route` stays (first pattern) for compatibility; codegen adds `static readonly routes` with all patterns and tags *(controller's call)*.

## 3. Generated route table

Build writes one project-wide module `.zor/routes.ts` (all `@page` components of the project), after compiling and before the type check:

- one matcher per route, generated as straight code (segment split + comparisons + conversions), no regex for patterns;
- `href.<Component>(params)` builders, one per page component, with one overload per `@page` of it, typed from the props (`href.UserProfile({ id: 1 })` -> `"/users/1"`, `href.UserProfile({ id: "x" })` is a type error); params are `encodeURIComponent`ed. Two page components with the same class name in one project are a compile error;
- `RouteTag` union and a typed params map (per tag, the union of its routes' params) for `route.is(tag)` narrowing.

A component imports it relatively from its source directory to the project root (`rootDirs` maps it to `.zor/routes.ts`). A real `routes.ts` at the project root is therefore reserved (same rule as `main.ts`).

## 4. The routes block

```tszor
@ClientRoutes(route) {
  @admin(page) { <AdminLayout>@page</AdminLayout> }
  @/^\/admin\/(?<area>\w+)/i(page) { <AdminLayout area="@route.match.area">@page</AdminLayout> }
  @"/legal/:doc" { <LegalText doc="@route.params.doc" /> }
  @notFound { <p>Not found</p> }
  @catch(e) { <ErrorPanel error="@e" /> }
  @default(page) { <MainLayout>@page</MainLayout> }
}
```

- `@ClientRoutes(route)` or `@ServerRoutes(route)`; `route` names the route-state variable visible in all sections. `{` may be on the same or next line. At most one routes block per project (compile error otherwise; checked when generating the route table).
- The block holds only sections; any other content is a compile error. Section keywords (`default`, `notFound`, `catch`, route tags, `/regex/`, `"pattern"`) are only recognized directly inside the block.
- Sections:
  - `@<tag>(page)`: a found route with that tag. `(page)` required. A tag no `@page` uses = compile error.
  - `@/regex/flags(page?)`: JS regex literal matched against the pathname (no query). Named groups typed as `route.match.<group>: string`. Only in `@ClientRoutes`; in `@ServerRoutes` it is the compile error `Bun.serve routes don't support regex; use a pattern`. The regex is a static constant.
  - `@"pattern"(page?)`: Bun pattern syntax. Without `(page)`, `route.params` holds its captures (all `string`); with `(page)`, `route.params` stays the page's converted params and the captures are on `route.match`.
  - `@notFound { }`: no `(page)` allowed.
  - `@catch(e) { }`: renders when the matched page fails: its module fails to load, its `onInitialized`/`onInitializedAsync` throws/rejects, or its first render throws. Cleared on the next navigation. Without `@catch` the error propagates as today.
  - `@default(page) { }`: required `(page)`; must be the last section.
- Matching:
  1. A `@page` route matches the path: only sections with `(page)` are tried, in source order (tag, regex, pattern); first match renders with `page` = the page component rendered with its route params as props. None matches: `@default(page)`; no `@default`: the page renders bare.
  2. No `@page` route matches: only sections without `(page)` (regex, pattern) are tried in order; first match renders its body.
  3. Nothing: `@notFound`; absent: nothing renders.
- `route`: `{ path, tag, params, query: URLSearchParams, match, is(tag), navigate(url, { replace? }) }`. `tag` is the matched route's tag or `undefined`; `is(tag)` narrows `params` (useful in pages with several routes, `@catch`, `@default`, regex/pattern sections). `navigate` only does History navigation in client mode; in server mode it assigns `location.href`. `route` is also provided as the cascading value `route`.
- Page components are created with the DI app like any other component (`@inject` works).

## 5. Engines

### `@ClientRoutes`: SPA

- One bundle (as today). The routes block subscribes to a `Navigation` (runtime interface: `current(): URL`, `navigate(url, { replace })`, `subscribe(fn): () => void`).
- Browser implementation: History API (`pushState`/`replaceState`, `popstate`) and interception of `<a>` clicks: same origin, left button, no modifier keys, no `target` other than `_self`, no `download`, not `rel="external"`. Memory implementation for tests.
- Components navigate through the cascading `route` (see ruling 5); there is no injectable `Navigation`.
- `<NavLink href="..." activeClass="active" match="prefix|exact">` component in the runtime.
- Bun.serve output: `.zor/server-routes.ts` exporting `routes` for `Bun.serve({ routes })`: every `@page` pattern and every `@"pattern"` section maps to the app's HTML entry (the project's `index.html`, served as an HTML import so Bun bundles it); unknown paths are not routed (Bun returns 404). Regex sections in client mode are only reachable through client navigation or a user-provided fallback *(controller's call; documented)*.

### `@ServerRoutes`: multi-page

- One HTML + bundle per `@page` route: each entry contains the app (with its routes block) and only that page component; other routes keep their tags and `href` builders but not their components. Links are normal navigations; no History API, no interception. Route state is computed once on load.
- `@"pattern"` sections without `(page)` get their own entry too (their body lives in the app bundle).
- Bun.serve output: `.zor/server-routes.ts` mapping each pattern to its HTML entry (HTML imports).
- zor's own bundle step (`dist/`) builds one bundle per entry *(controller's call: implementation detail left to the builder: a per-entry route table module selected through a Bun build plugin, or per-entry generated modules)*.

## 6. Tooling

- Grammar: `@cascade:name(...)`, `@ClientRoutes`/`@ServerRoutes`, section keywords inside the block, `@page "..." as tag`.
- LSP: directive completions for `@ClientRoutes`, `@ServerRoutes`, `@cascade`; completions of route tags inside a routes block; diagnostics come from compile errors as today.
- Docs: `docs/design.md` syntax table, gotchas (reserved `routes.ts`).

## Order of work

1. Cascading values (independent, also used by the router for `route`).
2. Route table + `@page` tags/patterns + client routes block + Navigation/NavLink.
3. Engines: Bun.serve route generation for both, and per-page bundles for `@ServerRoutes`.

Each part ships working and tested on its own.

## Builder-check rulings *(controller's calls)*

1. **Param types are textual, typing is TypeScript's.** Runtime conversion is decided from the prop's declaration text in the page (`: number`, `: boolean`, a literal string union, or a numeric/boolean initializer); anything else (aliases, imported types, inherited props, generics) converts as `string`. `href.<Component>` params are typed as `Pick<PageClass, param names>`-style references to the page class's own prop types, so tsc checks them without the analyzer.
2. **HTML contract.** The project's `index.html` is the template. `server-routes.ts` uses Bun HTML imports, so Bun bundles from source when serving; zor's `dist/` output stays as today (client mode) and is not what Bun.serve serves. For `@ServerRoutes`, zor writes `.zor/pages/<entry>.html` (the template with its module script pointing at `./<entry>.entry.ts`) and `.zor/pages/<entry>.entry.ts` (imports the app with a route table that holds only that page's component), where `<entry>` is the component name, suffixed `-2`, `-3`… for its later `@page` lines. `zor build` bundles each entry into `dist/<entry>/`.
3. **Editor.** Build, `--watch` and the LSP all produce the route table from the project's `@page` lines (the LSP uses open documents' text) and the LSP syncs it to TypeScript as an in-memory document at `.zor/routes.ts`, like generated components. Project-wide validation (unknown section tags, duplicate patterns or page component names, more than one routes block) happens when the table is generated and is reported on the offending `.tszor`.
4. **Precedence follows Bun:** segment by segment, static > `:param` > `*`; identical patterns on different routes are a compile error. Client and server agree.
5. **No DI requirement.** Routing works without `@Mount`. There is no injectable `Navigation`; components reach navigation through the cascading value `route` (`@Cascade route!: Route`). The browser `Navigation` is internal to the runtime, with a test hook to swap in the memory implementation.
6. **`@catch` scope:** errors thrown by the page's constructor/DI arrival, `onInitialized`, rejected `onInitializedAsync`, and its first render. The page's partial output is discarded and the `@catch` body renders in its place. Module load errors don't apply (no lazy loading yet). Implemented as a field on the page's vnode that the runtime checks on those paths, not a wrapper component.
7. **Cascading is unchecked across files** (as in Blazor): no compile-time match between providers and consumers; a missing provider leaves the field as initialized. Documented.
8. **`@ServerRoutes` and unknown paths:** `@notFound` produces its own entry (`.zor/pages/notFound.*`) exported from `server-routes.ts` as `notFound` for the user's `fetch` fallback (`fetch: () => new Response(...)`) — no hidden catch-all. `@catch` applies per page load. In client mode regex/pattern-only sections are reachable through navigation, and through Bun.serve only if covered by a pattern.
9. **Navigation within a route family keeps the page instance**: routes of one component that extend, segment by segment, the shortest of its own patterns they start with (`/users/:id` and `/users/:id/:view`). New params are set as props and `onParametersSet` runs, like Blazor; params only other routes of the family fill become `undefined`. A route extending none of its page's shorter patterns builds a new instance (not an error).

## Left to the builder

Internal runtime shapes (section descriptors, provider fields), exact generated code for matchers and `href`, the per-entry bundling mechanism, error message texts other than the one fixed above, test file layout.

## Later changes

- 2026-10-26: `@ClientRoutes`/`@ServerRoutes` become one `@Routes(route) { ... }`; the engine moves to the application, `@Run(App, "app", { navigation: "client" | "server" })`. Sections, matching and the other rules hold. See [the @Run, @Routes, PSR and endpoints spec](2026-10-26-run-routes-psr-design.md).
