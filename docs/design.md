# xzor design

## Goal

`.xzor` is to TypeScript what `.razor` is to C#. You write a component as markup with `@` transitions plus a `@code` block. `xzor` lowers it to a TypeScript class whose `buildRenderTree` calls a `RenderTreeBuilder`. The TypeScript is type-checked, then bundled to JavaScript.

```
X.xzor --xzor (Rust)--> .xzor/X.xzor.ts --tsc 7--> type errors --Bun.build--> dist/*.js
```

The generated TypeScript is an internal step, like Blazor's `obj/`. Editors get IntelliSense through `xzor lsp` (see [superpowers/specs/2026-10-11-lsp-design.md](superpowers/specs/2026-10-11-lsp-design.md)).

## Syntax (v0)

| Syntax | Meaning |
|---|---|
| `@page "/route"`, `@page "/users/:id" as admin` | Route of this component (see [Routing](#routing)) |
| `@import A from "./A.xzor"` | Verbatim ES import |
| `@code { ... }` | Class members |
| `@module { ... }` | Module-level code outside the class, exportable (see [Module code](#module-code-module)) |
| `<style>...</style>`, `X.css.xzor` | The component's own CSS, scoped and reactive (see [Component styles](#component-styles)) |
| `@name`, `@a.b(c)[0]?.d` | Implicit expression; stops at text such as `:` or `.` followed by a non-identifier |
| `@( expr )` | Explicit expression |
| `@[a, b]`, `@[a, b].length` | An array literal is already balanced, so it needs no parentheses |
| `@if (c) { } else if (c) { } else { }` | Control flow |
| `@for (const x of xs) { }` | Loop (any JS `for` head) |
| `@while (cond) { }` | `while` loop, in its own region |
| `@for (…) { } else { }`, `@while (…) { } @else { }` | The `else` renders when no pass ran |
| `@for (const [k, v] of es) @key(k) { }` | What matches a pass to its kept DOM in a fine component (see [Fine components](#fine-components-the-default)) |
| `@attr:class="x @y"`, `@attr:hidden` | Inside a branch: an attribute of the enclosing element while that branch shows. `class` adds to the element's classes; other names replace and are restored when the branch goes. Go-to-definition jumps to the owning element. |
| `@await (load(q)) { pending } then (rows) { … } catch (e) { … }` | Fine components: the pending block, then the value or the error; each arm and its name are optional. The promise re-runs when what it reads changes (`q`), and one it replaced is ignored when it settles. When the expression is one call with arguments (`f(a, b)`, `x.y.f(a)`), the arguments are a binding of their own: the call runs again only when an argument changes (`Object.is`) or what the called function reads does, so `load(key)` with `key` a getter skips a change that leaves `key` the same. The arms re-run on their own reads without a new request. A rejection without `catch` is reported. |
| `@once(expr)`, `@once { … }` | Read once, with nothing bound or tracked, not even by an enclosing region; control flow inside the block is plain JS and attributes are set once. Child components inside stay live. A region or row that rebuilds builds it again, once. |
| `@async`, `@cached` | Directive lines. `@async`: importers load the component on first use (a chunk of its own with `--minify`); its class is a type-only import there. `@cached`: leaving the tree keeps the instance and its DOM, matched by type and `@key` when it comes back (never evicted). |
| `@Volatile get x() { }` | A getter re-run on every read; fine components cache the others (see [Fine components](#fine-components-the-default)) |
| `@* comment *@` | A comment, removed at compile time |
| `@{ const x = f(); <p>@x</p> @: text @x }` | Statements inside `buildRenderTree`. Variables declared there are usable later in the same scope. Markup at statement start and `@:` lines render in place, and markup used as a value becomes a `RenderFragment`. |
| `<text>…</text>` | Renders its content only, with no wrapper element |
| `@inherits Base<T>`, `@implements A, B`, `@attribute dec(args)` | `@dec(args)` then `export default class C extends Base<T> implements A, B`. The base must derive from `ComponentBase`. When the base resolves through an `@import` (a `.ts`, `.d.ts` or `.xzor` file, following re-exports and its own `extends` chain; a bare specifier is found in `node_modules` through `types`, `typings`, `exports` (conditions, subpaths and `*` patterns; `.js` targets read as their `.d.ts`), `index.d.ts` or `@types/<pkg>`), its instance members are usable as bare names in the template, like `@code` members. When a base in the chain can't be read, compiling warns (`could not read base class 'Base'; use this.<member> for its members`, also an LSP warning) and its members need `this.`. tsconfig `paths`, `export =` and bases that are expressions (`extends mixin(A)`) are not followed. |
| `@switch (v) { case a: case b: ... break; default: ... }` | Each case is block-scoped and always ends in `break` (no fall-through into a body). Stacked labels share one body. `break;` is optional. |
| `@@`, `a@b.com` | Literal `@` |
| `&lt;`, `&eacute;`, `&#233;`, `&#xE9;` | Character references in text and in text attribute values (including string props) are decoded at compile time, like Razor: numeric ones and the HTML 4 names. Unknown names stay as written; `<script>`/`<style>` content and expression values are not decoded. |
| `attr="text @expr"`, `attr="@expr"` | Interpolated and typed attribute values (`false`/`null` removes the attribute; on `aria-*` a boolean writes `"true"`/`"false"`) |
| `@onclick="handler"`, `@onclick="() => ..."` | DOM event; typed through `HTMLElementEventMap`; triggers a re-render |
| `@onclick:preventDefault`, `@onclick:stopPropagation="cond"` | Event modifiers. They work without a handler, and take an optional boolean expression. |
| `@attributes="dict"` | Attribute splatting on elements, where later attributes override it. On components, props are spread: `{ ...dict, title: "t" }`. |
| `@leave` | On an element: when a branch, row or component removes it, it gets `data-leaving` and stays until the animations that starts (in it and below) finish: `dialog[data-leaving] { animation: out .2s }`. Animations already running (a spinner inside) and endless ones don't hold it. Without any it goes at once. Entering needs no syntax: an `animation` on the element, or a transition from `@starting-style`, plays when it is inserted. |
| `@show:if (c) { } else if (c) { } else { }`, `@show:switch (x) { case … }` | Fine components: like `@if`/`@switch`, but a branch they leave is hidden, not removed. A branch is built the first time it is chosen and kept; hiding sets `display: none` on its top-level elements (their own inline `display` comes back when shown). Its top level holds elements only. Hidden branches stay live. |
| `@pause`, `@pause { … }` | In a show branch: bare and first, the whole branch; as a block, its content. Stops while the branch is hidden (a change only marks it stale) and catches up once when shown. Elsewhere it is an error. |
| `class:invalid="@err"`, `class:round` | Toggles one class while the value is truthy (alone: always), leaving the element's others. Fine components bind each toggle with `classList`; keep the element's own `class` static there, since a dynamic `class` rewrites them all. In a component's content (an island) it is added after the element's `class`. |
| `<Child prop="x" n="5" />` | Component (capitalized tag); props are type-checked as `Partial<Child>`. As in Blazor, a prop declared with a non-string type (`n: number`, `on: () => void`, or inferred from a non-string initializer) takes its value as a TypeScript expression. String props take text: `string`, string literals, a string default (`name: SnippetName = "hero"`), or an alias of string literals imported from a relative module (`size?: Size` with `export type Size = "s" \| "m"`). |
| `@typeparam T extends X` | Generic component class `C<T extends X>`. Callers can pass the argument as an attribute (`<List T="string" …>` compiles to `List<string>`) or leave it out: `T` is then inferred from the props. Without `T=`, callback props must annotate their own parameters, a type parameter that cannot be inferred becomes `unknown` (not its default), and a prop mismatch is reported at the tag. |
| `@inject IDatabase db // why` | Directive lines (`@inject`, `@inherits`, `@implements`, `@typeparam`, `@attribute`, `@import`, `@page`) accept a trailing `// …` or `@* … *@` comment. |
| `onChange?: EventCallback<T>` | A prop the parent sets with `onChange="handler"`, or `@onchange="handler"` (matched case-insensitively). Calling it re-renders the parent. |
| `@bind="x"`, `@bind:event="oninput"`, `@bind:after="save"` | Two-way binding on inputs. Checkboxes and radios bind `checked`, and numbers stay numbers. `@bind:input="x"` is `@bind` written back on each input. `@bind:debounce="300"` writes back (and runs `@bind:after`) once input pauses that long. |
| `@bind-value="x"` | Two-way binding on a component: passes `value` and a `valueChanged` callback. |
| `@key="expr"` | On an element or component in a list: the diff matches it by key, moving DOM nodes and component state when items reorder. |
| `@cascade:name(value[, fixed]) { … }` | Provides `value` under `name` to every component rendered inside the body, at any depth. `@cascade` is a keyword only when followed by `:` and a name; otherwise it is a normal `@expr`, so `@cascade: on` still reads the member `cascade`. The body is a block scope. Providers nest, and the nearest one wins. `fixed` promises the value never changes, so consumers are not tracked. |
| `@Cascade`, `@Cascade("name")` | In `@code`, on an instance field: it receives the nearest provider's value for its own name or the given one. No import is needed, and the generated code has no decorator call. Methods and statics are errors. |
| `@ref="field"` | On an element, assigns the DOM element, typed from the tag (`<input>` gives `HTMLInputElement`). On a component, assigns the instance. Updated after each render. |
| `protected override onInitialized()` and similar | Lifecycle methods, in Blazor's order: `onInitialized`/`onInitializedAsync` once, `onParametersSet`/`onParametersSetAsync` on mount and whenever props change, then render, then `onAfterRender(first)`/`onAfterRenderAsync(first)`. `shouldRender()` can veto re-renders, and `dispose()` runs when the component leaves the tree. A settled `...Async` promise re-renders the component. |

In template expressions, free identifiers that name `@code` members are rewritten to `this.x`. Loop variables shadow members. `#private` members work the same way: `@#secret`, `@(#secret + 1)` and `@onclick="() => #count++"` become `this.#secret` (`C.#x` for statics), `@this.#secret` is left as written, and `#x in obj` stays a brand check. Private members are never props.

### Markup as values (RenderFragment)

Inside `@code`, markup can be used as a value, like Blazor's `RenderFragment`. It's written `<Tag …>` wherever an expression can start (after `return`, `=`, `(`, `,`, `?`, `:`, `=>`, …), or `@<Tag …>` anywhere. It compiles to `ComponentBase.fragment((__b) => { … })`, typed `RenderFragment` (alias `Renderer`, from `@source-crafter/xzor-runtime`), so TypeScript enforces the declared return or field type. Inside this markup, names follow plain TypeScript scope (write `@this.x`). Render a fragment from the template with `@member` or `@method(args)`; it gets its own region in the diff. Text that fails to parse as markup stays TypeScript (generic arrows `<T,>(x: T) => x`, comparisons).

```xzor
@code {
  cached: RenderFragment = <Summary />;
  panel(kind: Kind): RenderFragment {
    switch (kind) {
      case "a": return <A state="@this.state" />;
      default: return this.cached;
    }
  }
}
@panel(kind)
```

### Slots

Slots work like functions. A component defines where each one renders, optionally with arguments and fallback content. The parent supplies a body, optionally taking parameters.

```xzor
<!-- Card.xzor (definition) -->
<section>
  @slot:header { <h3>@title</h3> }      <!-- named, with fallback content -->
  @slot                                 <!-- the nameless (default) slot -->
</section>

<!-- List.xzor (definition with arguments) -->
@for (const item of items) {
  <li>@slot:item(item, items.indexOf(item) as number) { @item }</li>
}

<!-- Parent (usage, no semicolons) -->
<Card>
  @slot header { <em>Title</em> }
  <p>Content outside any @slot fills the default slot.</p>
</Card>
<List T="string" items="@names">
  @slot item(name, i) { <b>@i: @name.toUpperCase()</b> }   <!-- name: string, inferred -->
</List>
```

The forms are:

| Form | Syntax |
|---|---|
| Definitions | `@slot`, `@slot(args)`, `@slot { fallback }`, `@slot:name`, `@slot:name(args) { fallback }`. Arguments and fallback are each optional. |
| Usage, as direct children of a component tag | `@slot { … }`, `@slot(params) { … }`, `@slot name { … }`, `@slot name(params) { … }`. Parameters may carry types and defaults (`item: T = x`). The body must not be empty. |

The rules:

- Each name, including the nameless `default` slot, is defined at most once and filled at most once. Content outside any `@slot` fills the default slot. Filling it both ways is an error.
- A definition compiles to `__b.addContent(this.slots.name?.(args) ?? fallbackFragment)`. A fill compiles to a lambda in `addComponent(C, props, { name: (params) => fragment })`.
- The component class declares `declare slots: { name?: (p: T, …) => RenderFragment; … }`, so TypeScript checks slot names and parameter types, and infers untyped parameters. xzor infers each argument's type at compile time:
  - a member `x` or `this.x.y` becomes `this["x"]["y"]`
  - a loop variable from `const x of <member path>` becomes `…[number]`; `in` gives `string`, and `let i = 0` gives `number`
  - `expr as T` becomes `T`
  - a literal becomes `number`, `string` or `boolean`
  - markup becomes `RenderFragment`

  Any other argument is an error asking for `as Type`.

### Cascading values

A provider passes a value down to any depth without threading props. A consumer field declares what it receives.

```xzor
<!-- App.xzor -->
@cascade:theme(currentTheme) {
  <Toolbar />
}

<!-- Button.xzor -->
@code {
  @Cascade theme!: string;               // by field name
  @Cascade("theme") mode!: string;       // by explicit name
}
```

- Matching is by name and is not checked across files: a typo or a type mismatch between provider and consumer is not reported.
- `@Cascade` needs no import. Statics and methods are rejected, and with parentheses it takes exactly one string literal (or none: `@Cascade` alone uses the field name).
- A consumer whose provider value changes gets the new value, runs `onParametersSet`/`onParametersSetAsync`, then re-renders, like a prop change. With no provider, the field is left untouched.
- Changes are detected by identity (`Object.is`): mutating the provided object in place notifies nobody. Provide a new object instead.

## Routing

Full design: [the routing and cascading spec](superpowers/specs/2026-10-13-routing-cascading-design.md).

```xzor
@page "/admin/users/:id" as admin
@page "/users/:id/*"

@Routes(route) {
  @admin(page) { <AdminLayout>@page</AdminLayout> }
  @/^\/docs\/(?<area>\w+)/i(page) { <DocsLayout area="@route.match.area">@page</DocsLayout> }
  @"/legal/:doc" { <LegalText doc="@route.params.doc" /> }
  @notFound { <p>Not found</p> }
  @catch(e) { <ErrorPanel error="@e" /> }
  @default(page) { <MainLayout>@page</MainLayout> }
}
```

- **`@page "pattern" [as tag]`**: Bun.serve pattern syntax: `/`-led segments that are literals, `:param`, or a final `*`. A component may have several. Params fill the props of the same name, converted from the prop's declaration: `number` (`Number`, `NaN` is no match), `boolean` (`"true"`/`"false"`), a union of string literals (must be one of them), otherwise `string`. Values are decoded with `decodeURIComponent`. The text matched by `*` fills a prop named `rest` if the page declares one. The optional tag is shared by any number of routes (`default`, `notFound` and `catch` are reserved). Most specific wins, as in Bun: literal, then `:param`, then `*`.
- **The routes block**: `@Routes(route) { ... }`, at most one per project, holding only sections (`{` may be on the next line). `route` is visible in every section. Sections: `@tag(page)` (a tag some `@page` uses), `@/regex/flags(page?)`, `@"pattern"(page?)`, `@notFound`, `@catch(e)` (the matched page's construction, `onInitialized`, rejected `onInitializedAsync` or first render failed; cleared on the next navigation), `@default(page)` (last; `page` renders the matched page).
- **Matching order**: when a `@page` route matches, the sections with `(page)` are tried in source order, then `@default`, then the page renders bare. Without a page route, the page-less sections are tried in order, then `@notFound`, then nothing renders. A `(page)` pattern section's captures are on `route.match`; a page-less one's are on `route.params`.
- **`route`**: `{ path, tag, params, query, match, is(tag), navigate(url, { replace }) }`, also the cascading value `route`. `is(tag)` narrows `params` inside the routes block's sections; elsewhere type the field with the table's `AppRoute` (`@Cascade route!: AppRoute`, `import type { AppRoute } from "./routes"`) to get the same narrowing. A new object is published on each navigation. A page is kept across navigations within one route family of its component: routes that extend, segment by segment, the shortest of its own patterns they start with (`/users/:id`, `/users/:id/:view`, `/users/:id/*`). Its props are set again, params only the other routes of the family fill become `undefined`, and `onParametersSet` runs. A route that extends none of its page's shorter patterns builds a new instance.
- **`href.<Component>(params)`**: from `routes` (imported relatively, e.g. `import { href } from "../routes"`). One overload per `@page` of the component, typed from its props, so `href.UserProfile({ id: "x" })` is a type error when `id` is a `number`. A route without parameters takes no argument (`href.About()`; the parameter defaults to `{}`, so `href.About({})` still works). Values are `encodeURIComponent`ed; the first of the component's patterns whose param names equal the given keys is used.
- **`<NavLink href="/x" activeClass="active" match="prefix|exact">`**: an `<a>` that carries the class and `aria-current="page"` while the current path is on its `href` (resolved against the base URL, compared percent-encoded). It follows navigation by itself, so it also works outside the routes block (a nav bar beside it); it never intercepts clicks on its own.
- **View transitions**: `viewTransitions(true)` (from the runtime, typically in `main.ts`) makes every navigation commit inside `document.startViewTransition` where the browser has it; elsewhere, or with it off, navigation stays synchronous. A skipped transition (hidden tab, a newer navigation) is not an error. Name shared elements with `view-transition-name` in CSS.
- **Sub-path deployments**: with `<base href="/docs/">` (GitHub Pages serves a project at `/<repo>/`), patterns, `route.path` and section regexes are relative to that path (`basePath()`, from the runtime, gives `"/docs"`), `href.<Component>()` prefixes it, and the base root counts as the root for `NavLink`. Write other links relative (`href="users/1"`) so the browser resolves them against the base.
- **Navigation**: `@Routes` is a single-page app on the History API. It intercepts `<a>` clicks that are same-origin, left-button, without modifier keys, with `target` absent or `_self`, no `download` and no `rel="external"`. `popstate` re-renders, and `navigate` uses `pushState` (`replaceState` with `replace`).
- **`.xzor/routes.ts`**: the generated route table (matchers, `href`, `RouteTag`, `RouteParams`, `AppRoute`), written from every `@page` of the project and removed when it has none. A real `routes.ts` at the project root is reserved.
- **Limits**: a trailing slash (`/a/`) is rejected, a duplicate pattern or page component name is an error, and a `@page` component can't hold the routes block (it would render itself; keep the block in a shell component without `@page`).

## Rendering

- An event re-renders only the component that owns the handler. `stateHasChanged()` does the same for any component.
- The new render tree is diffed against the previous one by position, and only changed text, attributes, handlers and nodes are touched. DOM nodes keep their identity, so focus and input state survive.
- Each `@if`, `@for` and `@switch` produces a region, marked by a comment anchor. Its variable output is diffed in isolation, so it never shifts static siblings.
- A child component re-renders only if a prop changed (`Object.is`). Object props always count as changed, as in Blazor.
- Component identity comes from the diff, as in Blazor: a child keeps its instance and state while it stays at the same position with the same type and `@key`. Otherwise it is disposed and a new instance is created.
- Lists with `@key` use a keyed diff: matched nodes are patched and moved, and unmatched ones are removed or created.
- `<svg>` and everything inside it (except under `<foreignObject>`) is created in the SVG namespace, by both the render-tree diff and fine templates. A fine template whose root is an SVG child (`<path>` alone in a region inside an `<svg>`) is created as HTML: keep the `<svg>` in the same template.

## Dependency injection

xzor resolves services at compile time and emits plain TypeScript: no reflection and no runtime container. Full design: [the DI spec](superpowers/specs/2026-10-12-di-bootstrap-design.md).

### Providers and registrations

The decorators come from `@source-crafter/xzor-runtime` and do nothing at runtime. `@ServiceProvider()` marks a reusable provider class in any `.ts` file; xzor generates `.xzor/<rel>.provider.ts` with a subclass `<Name>$` that has one public getter per service.

```ts
@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)   // Database(log: ILogger)
@Scoped(UnitOfWork)
export class DataServices {}
```

| Form | Meaning |
|---|---|
| `@Singleton(Impl)` / `@Singleton<IService>(Impl)` | One instance, in a `static` field shared by every instance and scope. |
| `@Scoped(Impl)` | One instance per scope. |
| `@Transient(Impl)` | A new instance on every resolution. |
| `@Singleton("key", Owner.factory)`, `@Singleton("key", factory)` | A keyed service built by a factory: a public static method of another class, or an exported function (local or imported). The key matches a parameter name before the type is tried. |
| `@Import(OtherProvider)` | Uses another provider's services. The imported provider must be self-sufficient. |

Constructor and factory parameters are resolved by key, then by type. A `?` or defaulted parameter gets `undefined` when nothing matches.

### Components: `@inject`

`@inject IDatabase db` in a `.xzor` adds a constructor parameter and a `readonly db` field. The application builds such components in its generated `createComponent`. A component with `@inject` cannot declare its own `constructor` (ZDI08).

### The application: `@Run`

The entry module declares one class with `@Run(App, "app")` plus registrations and imports. xzor writes `.xzor/<entry>` with the generated subclass and the `mount(App, "app", new Application$())` call, and bundles that instead of the entry. Do not call `mount()` yourself.

```ts
@Run(App, "app")
@Import(DataServices)
@Singleton(AuthService)
@Singleton("requestId", Factories.newRequestId)
export class Application implements IApplication {}
```

What the class implements decides the form: `@Run(App, "app")` on an `IApplication`, `@Run(App)` or `@Run()` on an `IServerApplication` (see [Server apps](#server-apps)). A form that doesn't match is ZDI11.

### Scopes and disposal

- Every provider instance is a scope. `createScope()` returns a new scope sharing the root's singletons with an empty scoped cache.
- Singletons are `static`, so disposing any root releases them for every instance.
- A provider with disposable services gets `dispose()` and `[Symbol.dispose]` (or `disposeAsync()` and `[Symbol.asyncDispose]`). The root releases the singletons first, then its scoped services. A scope releases only its scoped services. Transients are never tracked.
- When a component leaves the tree, the runtime calls its `dispose()` and its `[Symbol.dispose]()` or `[Symbol.asyncDispose]()`.

### Async services

A factory returning `Promise<T>` makes the service async, and that spreads to everything that takes it as `T`. Async services are read through `getXAsync()`. A parameter typed `Promise<T>` receives the promise unawaited and stays synchronous. A component that injects an async service as `T` is resolved asynchronously: its place stays empty until the services are ready.

### Diagnostics

| Id | Error |
|---|---|
| ZDI01 | Service registered twice in one provider, including a local registration of a service that an import already provides (shared dependencies are never overridden). |
| ZDI02 | Unresolved dependency in a provider (includes self-sufficiency of imports). |
| ZDI03 | Dependency cycle. |
| ZDI04 | An `@inject` type is not provided by the application, or there is no `@Run` application. |
| ZDI05 | Ambiguous: two registrations satisfy one unkeyed parameter. |
| ZDI06 | Registration without an implementation or factory. |
| ZDI07 | `@Run` on more than one class, or outside the entry module. |
| ZDI08 | A user constructor in a component with `@inject`. |
| ZDI10 | Reserved. Captive dependencies are allowed: a singleton keeps the scoped instance of the scope that first resolved it. |
| ZDI11 | Invalid registration found by the analyzer (unexported type, generic type, non-public factory, decorator misuse, a `@Run` form that doesn't match what the class implements, a misplaced endpoint decorator, an unexported `@Endpoints` class). |
| ZDI12 | A key matched by parameter name provides a type that is not assignable to the parameter. |
| ZDI13 | Two endpoint methods handle one HTTP method and path (params compared unnamed); both are named. |
| ZDI14 | A path parameter named `query` or `body`. |
| ZDI15 | Endpoint parameters are not the path's `:params` in order, then `query`, then `body`. |
| ZDI16 | `body` on a method that takes none (only `POST`, `PUT`, `PATCH` and `QUERY` do). |
| ZDI17 | An endpoint parameter that is not a path parameter, `query` or `body`. |
| ZDI18 | `query` is not an object type. |
| ZDI19 | A singleton (built once) needs `Request`, directly or through its services; the chain is named (`AuthCache -> CurrentUser -> Request`). |
| ZDI20 | A view reaches `Request`, an `@Endpoints` class or a service whose module imports `bun`, `bun:*` or `node:*`; the chain is named. |
| ZDI21 | A view or a browser-reached service's module imports an `@Endpoints` class as a value (use `import type`). |
| ZDI22 | An endpoint's route path Bun would reject at start: it doesn't start with `/` (an `@Endpoints` prefix without the leading `/`), or a path parameter name starts with a digit or is repeated. |

### Gotchas

- The tsconfig `lib` needs `ESNext.Disposable` (for `Disposable` and `Symbol.dispose`).
- A class cannot reference itself in its own decorators, so a keyed factory is either a public static method of another class or an exported function. It must be exported because the generated code imports it.
- A `.xzor` must not import from `./main`: with `rootDirs`, that resolves to the generated `.xzor/main.ts`.
- Optional members such as `dispose?()` are disposed with an optional call (`d0?.dispose?.()`).
- `@Run` must be in the entry module (`--entry`, default `main.ts`; without `main.ts`, the one project `.ts` declaring `@Run(`, and ZDI07 when several do).
- `routes.ts` at the project root is reserved, like `main.ts`: with `rootDirs`, an import of `<root>/routes` resolves to the generated `.xzor/routes.ts` (the route table, written when the project has `@page`s and removed when it has none).
- Members of an `@inherits` base that can't be read (see the warning) are not rewritten to `this.x` in the template; write `this.x` yourself.

## Server apps

Full design: [the run/routes/PSR spec](superpowers/specs/2026-10-26-run-routes-psr-design.md). A server app is a project whose `@Run` class implements `IServerApplication` (`runtime/server.ts`, the `@source-crafter/xzor-runtime/server` export; it references Bun's types, so the project needs `@types/bun`, which `xzor init --server` adds). Roles come from markers, not folder names: `xzor init --server` and `examples/blog` put views in `client/`, the app in `server/` (`server/api/` for endpoints) and plain shared types and interfaces used by both sides in `contracts/`.

| Form | Class implements | App |
|---|---|---|
| `@Run(Shell, "app")` | `IApplication` | Browser app, as above. |
| `@Run(Shell)` | `IServerApplication` | Server plus views: `Shell` and what it imports are bundled for the browser and render into `<body>`. |
| `@Run()` | `IServerApplication` | API-only server: no views, no browser bundle. |

```ts
// server/app.ts
@Run(Shell)
@Import(DataServices)
@Singleton(Theme)    // reached by a view: registered in the browser too
export class App implements IServerApplication {
  port = 3000;
  routes = { "/health": new Response("ok") };
}

// server/api/posts.ts
@Endpoints("/api/posts")
export class Posts {
  constructor(private store: PostStore) {}

  @Get(":slug")
  get(slug: string): Post | undefined { return this.store.find(slug); }

  @Post
  async create(body: NewPost): Promise<Post> { return this.store.add(body); }
}
```

- **The app class.** `IServerApplication` is `Bun.serve`'s options as optional members (`port`, `tls`, `http2`, `routes`, `fetch`, `error`, ...). The class is a DI application like any other: registrations, `@Import`, constructor injection. The generated server spreads its members into `Bun.serve`, so `routes` is merged after the generated routes (it wins), `fetch` gets what no route matched, and `error` gets errors that aren't an `HttpError`. The generated `Bun.serve` sets `development: !!process.env.XZOR_DEV` (an app's own `development` member wins). When the app has no `error`, or its `error` returns nothing, an unhandled error is logged and answers a plain `500` ("Internal Server Error"); Bun's development error page, with the message and the stack, shows only under `xzor dev`.
- **Entries.** `.xzor/<app file>` is the server (the `App$` subclass, the endpoint instances, the handlers and `Bun.serve`). With `@Run(Shell)` the build also writes `.xzor/client.ts`: the services the views reach and `mount(Shell, document.body, ...)`, bundled as `dist/main.js` like a browser app's entry. It never imports the app file, so `Bun.serve` members and server-only registrations stay out of the browser. `index.html` is the project's own; the build adds the bundle's `<script>` and stylesheet when it lacks them. No `main.ts` is needed: without one, the entry is the project's one `.ts` declaring `@Run(`.
- **Discovery.** Every exported `@Endpoints("/prefix")` class in a `.ts` file under the `@Run` file's folder (not `node_modules`, `.xzor`, `dist`) is served; nothing is registered by hand. The prefix and each method's decorator argument must be string literals.
- **Paths.** The prefix and a method's pattern join on `/` (`"/api/posts"` + `":slug"` = `/api/posts/:slug`; a bare `@Get` is the prefix itself), in Bun's pattern syntax. The joined path must start with `/`: a prefix like `"api/x"` is ZDI22, not a crash at start. A trailing slash is dropped. `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` and `@Query` (the HTTP `QUERY` method) take no argument or a pattern. Bun's route objects have no `QUERY` key, so a path with a `QUERY` handler gets one function that dispatches on `req.method` and answers other methods with 405.
- **Parameters**, in this order: the path's `:params`, all of them and named as in the pattern, converted like `@page` params (`number`, `boolean`, a string-literal union, else `string`); then optionally `query`, an object type read from the search string (only its declared keys, each converted the same way; a key without `?` that is absent answers 400; a string index signature also takes every other search param); then optionally `body`, the parsed JSON (typed, not validated), only on `POST`, `PUT`, `PATCH` and `QUERY`: a request whose `Content-Type` is not `application/json` (parameters such as `; charset=utf-8` are fine) answers 415 before the body is read, because any other type can be a cross-site form post, which carries the visitor's cookies without a preflight; invalid JSON answers 400. A value that fails its conversion answers 400 before the method runs. `query` and `body` are reserved path param names.
- **Results.** A `Response` passes through; `undefined` or `null` is 404; anything else is `Response.json(value)`; `throw new HttpError(status, message)` answers that status with the message as text. A handler is synchronous unless the method's return type is a `Promise`, it takes `body`, or its instance is built asynchronously, because an always-`async` handler costs about 70% more per request (319 ns against 187 ns, Bun 1.4.0). Generated code calls the method directly and costs what a hand-written handler does (187 against 188 ns).
- **Instances and `Request`.** Endpoint instances are built once at server start with constructor injection. Any service or endpoint can take a `Request` constructor parameter (the global type; only in a server app: in a browser app `Request` resolves like any other type, so a registered one is injected and an unregistered one is the usual ZDI02/ZDI04); a class that reaches it, directly or through non-singleton services, or reaches a scoped service, is built per request in a scope (`<App>Scope`) holding that request, decided at build time; the others keep the direct call. The scope is disposed after the response, only when the endpoint reaches a disposable scoped service (an async disposal is awaited before the handler settles); transients aren't tracked and singletons stay with the app. A singleton that needs `Request` is ZDI19.
- **Splitting registrations.** The one set of registrations is split by what each side reaches. The browser container starts from every view's `@inject` and follows constructor parameters; the server container starts from the endpoints' constructors and the app class. A registration both reach exists on both sides and is built separately on each. A view reaching `Request`, an `@Endpoints` class or a server-only module is ZDI20; a view or browser-reached module importing an `@Endpoints` class as a value is ZDI21.
- **Serving** (`staticFiles` in `runtime/server.ts`). With views, the server reads `dist/pages.json` and serves exactly its `files` list, each at its path, plus each `@page` pattern as its shell; nothing else on disk is reachable. The files and their `.br`/`.gz` copies are read at start (compressing at start cost 218 ms and 14 MB for the blog; build-time copies about 10 ms and 9 MB); files over 1 MB are served from `Bun.file`. Each file has one handler holding prebuilt `Response`s (brotli, gzip, raw) and an ETag (`"<hash>"`, with `-br`/`-gz` for the copies): `If-None-Match` answers 304, otherwise a clone of the encoding `Accept-Encoding` allows, with `vary: accept-encoding`. `dist/chunks/*` and fonts get `cache-control: public, max-age=31536000, immutable`; everything else, `no-cache`. `dist/index.html` (the project's with the bundle's tags) answers `/index.html`, where the worker's offline fallback points. A path nothing matches gets that `index.html` with status 404, so the views' `@notFound` renders; an API-only server answers an empty 404. Without `dist/pages.json` the server logs that it serves no pages and answers endpoints only.
- **Build.** `xzor build --minify` bundles the server entry with `target: "bun"` to `dist/server.js` (minified, no map), after the browser bundle, shells and `pages.json`; it is not in `pages.json`, so it is never served. Run it with `bun dist/server.js`: it finds `dist/pages.json` from its own location. Without `--minify` there is no `dist/server.js`.
- **`xzor dev`.** With a server app, `xzor dev` runs the generated server behind its own file server, on a port of its own (`XZOR_DEV=1`, `PORT=0`, bound to `localhost`; the app's `port` and `hostname` are ignored), without shells, assets or compression. Project files are answered as before (HTML with the hot client); what no file answers is proxied to the server, and a `404` to a page request (`accept: text/html`) is answered with `index.html` so client routes load. `.xzor`-only builds still patch in place and leave the server alone. Any other build that type-checks (a `.ts` changed, so nothing could be patched) restarts the server, which waits for the old one to exit; a build that fails its type check keeps the running one.
- **Limits.** One `@Run` class per project and one tsconfig project for every role. No body validation, middleware, OpenAPI, or streaming and WebSocket endpoints (set `websocket` or `routes` on the app by hand). No static-host output, pre-rendered markup or `bun build --compile`.

## Models

A model is a class that tracks its own changes, validates itself and tells the components that read it when it changes. It comes from `@source-crafter/xzor-runtime/model` (`runtime/model.ts`, `runtime/entity-set.ts`). Importing that entry is what turns on the component updates.

```ts
export class Worker extends Model {
  name = "";
  @Validate(minValue(0)) hours = 0;
  @Persist get payment() { return this.hours * 20; }
}
```

### What the build generates

`src/bundle.ts` (`trackModelFields`) rewrites every plain field of a class that directly extends `Model`:

- `hours = 0` becomes a `#hours` slot plus a getter and a setter. The getter reports the read to the component that is rendering. The setter does nothing when the new value is the same (`Model.same`) and otherwise calls `$changed`.
- The class gets `static { Model.$define(this, ["name", "hours"]); }`, which lists its tracked fields. A subclass's fields come after its base's: `$define` records where on the class (`$at`), and its getters add it. No private name is involved, since Bun moves a decorated class's static blocks out of the class.
- If the class has no constructor, it gets `constructor(data?) { super(data); if (new.target === X) this.assign(data); }`. A hand-written constructor must call `this.assign(data)` itself. In a middle level of a hierarchy that makes the most derived instance assign twice (correct, but slower), so prefer leaving constructors to the build.
- `static`, `readonly`, `declare`, `abstract`, `accessor` and `#private` fields, methods, getters and `@Untracked` fields stay plain. A model class the scanner can't rewrite (a base that is not `Model`, an odd member) is left alone, with a warning on stderr.
- The decorators keep working on the original members: `@Validate`, `@Persist` and `@Ignore` are collected before `$define`.

### How components update

While a component renders, every tracked getter it reads records "this component read property N of this model". The component keeps one subscription per model, with a bit per property, and rebuilds them on each render. When a property changes, the model asks each subscribed component whether it read that property. If it did, the component is queued, and queued components render once, in a microtask. A component that already rendered after the change (its own event handler did) is skipped.

This works for changes from anywhere: a service, a timer, another component. Computed getters work through the fields they read. A manual `model.dispatchEvent(new ModelChangeEvent(name, value, previous))` also re-renders the readers of `name`. Writes made during a render don't subscribe the renderer.

Models are also `EventTarget`s: `change` (a `ModelChangeEvent` with `property`, `value`, `previous`) and `state` events. A model nobody watches builds no event.

### State, changes and validation

| Member | Meaning |
|---|---|
| `hasState(flags)`, `markAdded()`, `markModified()`, `markUnchanged()`, `markDeleted()` | Test and set the state: `State.Detached` (1, built with no data), `Unchanged` (2, built from data), `Added` (4), `Deleted` (8) or `Modified` (16). A first edit moves Detached to Added and Unchanged to Modified. The state is not a property: it lives behind the exported `StateKey` symbol, so it never shows in `Object.keys` or a spread. |
| `hasChanges`, `changes` | `changes` is `null` or `{ $$: state, ...fields }`: every serializable field plus the nested models and sets that changed. `@Persist` getters are included, `@Ignore` members are not. `toJSON()` gives `$$` and every field. Data with a `$$` (to the constructor or `assign`) sets the state. |
| `revertChanges()` | Puts the original values back. Added goes back to Detached, Deleted and Modified to Unchanged. |
| `confirmChanges(values?)` | After saving: the current values become the originals, optionally replaced by the server's. Added and Modified become Unchanged. |
| `@Validate(...validators)`, `errors`, `hasErrors`, `hasValidChanges` | A validator returns `true` or a message. `errors` lists the messages per validated field, but only after the model changed. A Detached or Deleted model has no errors. |

Validators: `required`, `email`, `phone`, `maxLength(n)`, `minLength(n)`, `requiredIdValue`, `nonZero`, `minValue(n)`, `maxValue(n)`. `isLike(a, b)` compares with the same rule as the setter: dates by time, arrays and plain objects by content, models by identity.

### EntitySet

`EntitySet.track(Worker, items)` builds an array of models from server data. Its mutating methods (`push`, `splice`, `sort`, ...) keep the list it started with, so it can put it back.

- `delete(...items)`: Added items leave the list, the others become Deleted, Detached ones are left alone.
- `view`: the items that are not Deleted.
- `hasChanges`, `changes` (the items that changed), `hasErrors`.
- `revertChanges()`: restores the list and every item. `confirmChanges(serverItems?)` drops Deleted items and confirms the rest.

A set held by a model field tells the model when it is mutated, so components that read the field draw again. A set is also tracked on its own: reading `view`, `hasChanges` or `hasErrors`, or iterating it with `for...of`, subscribes the reader to its membership, and every mutating method notifies those readers.

### Limits

- `set[i] = x` and `set.length = n` are not noticed. Use the methods. Reading `length`, an index, or calling `map`/`filter`/`reduce` on the set itself does not subscribe to its membership: read `view` or iterate it.
- A set shared by two models notifies only the last one.
- `changes`, `same` and `isLike` don't support plain object graphs with cycles.
- The tsconfig `lib` needs `ESNext.Decorators`.

## Fine components (the default)

Every `.xzor` compiles without a render pass. Its DOM is built once. Each dynamic part is a binding that re-runs only when a tracked field it read changes. `@render` (a whole-component virtual-DOM render pass) was removed and is a compile error; `@fine` is accepted and changes nothing. The virtual-DOM builder remains as the islands' renderer. Design and measurements: `docs/plans/2026-10-16-fine-components.md`.

- **Base class.** The component extends `ComponentBase`, which tracks fields once the model entry (`@source-crafter/xzor-runtime/model`, which projects map too) is loaded; the generated code imports `fine` from it. `FineComponent` is a deprecated alias of `ComponentBase`. The bundle tracks the fields of every generated component and of every project class that extends `ComponentBase`, like a model's, so a handler that does `count++` updates what reads `count`, and an `@inherits` base written in TypeScript is tracked too. A class written by hand with builder calls (no `addFine`) still renders through the virtual DOM. Event handlers don't re-render anything; what they changed shows before they return.
- **What the codegen emits.** `buildRenderTree` holds a single `__b.addFine((__p) => { ... })`. Each run of nodes is a `fine.template` clone (built directly on first use, cloned from the second); dynamic parts bind the nodes in place: `textAt`/`attr` for `@expr` and dynamic attributes, `on` for `@onX`, `regionAt`/`listAt`/`islandAt` before comment anchors. A list row's bindings and handlers are reads the list shares, taking the item (`textItem`, `attrItem`, `regionItem`, `onItem`). Bubbling events go through one listener on the document per type.
- **Bindings.** A binding records the fields it reads each time it runs (the compiler has no types, so there are no compile-time masks), using the model tracker's queue. Several writes in a task re-run a binding once. Derived getters and aggregates (`team.view.reduce(...)`) need nothing by hand. A binding is its own subscription for the first source it reads, so the common case allocates one object. One that reads nothing tracked re-runs after each of its component's handlers; when such bindings are disposed (a row or region going), the component's list of them is compacted in the next microtask, so changes from outside a handler don't keep removed nodes alive.
- **Show blocks.** `fine.showAt(end, run)` takes the same two-mode function as `branchAt`. The branch `run()` picks is built once into its own holder, in source order between the block's anchors, and kept; the others are hidden by their top-level elements' inline `display`. `fine.pauseAt` is a region built once whose bindings, with everything under them (regions, rows, nested shows), get a PAUSED flag while their show branch is hidden: a change marks them STALE instead of running them, and showing runs each stale one once, top-down. Disposing the block disposes every built branch.
- **Cached getters.** A fine component's instance getters are cached (`static { fine.memo(this, [...]) }`) once a second binding reads them (one reader, or reads outside bindings, run them as written): one run per change for all their readers, recorded like a binding and marked stale as soon as a field they read is written, so a handler reading one after a write sees the new value. `@Volatile` on a getter opts out, for one that reads what nothing tracks (`Date.now()`, the DOM). `stateHasChanged()` clears them. Static and `#private` getters are not cached.
- **Structure.** `@if` and `@switch` are branch regions (`fine.branchAt`): a change to what their conditions read re-evaluates only the conditions, and the branch is rebuilt only when another one is chosen; the same branch keeps its nodes, its parts updating on their own. A branch running a `@{ }` block at its top level, and an `@if` that list rows share, rebuild on any change to what they read, like loops that run `@{ }` code. Control flow nested in a region gets its own regions and lists. A lone block takes its place with its anchors only, without a template.
- **Keyed passes.** `@for (const x of items)` is a list; other `@for`s and keyed `@while`s run in place (`keyedAt`). Each pass is matched to a kept row by `@key(expr)` after the loop head, else a `@code` field's `@Key("member")` (for loops over that field, also through `filter`/`slice`/`sort`/`toSorted`/`toReversed`/`reverse`), else a model's `@Key` property, else the item itself (lists) or a hidden pass counter. A row whose key and pass values (or item) are unchanged keeps its nodes and nested regions; a changed one is rebuilt in place, except a list row whose key stays: given a new object (an immutable update), it keeps its nodes, takes the item, and its bindings run again (its `@if`/`@switch` keep their branch when it is the same); a row whose build closes over the item (a nested list or a child component reading it) gets it through `fine.rowItem` and runs everything in it again, so nested rows keep their DOM and child components their instance (new props, `onParametersSet`); a duplicate key throws. An `@if`/`@switch` of a row whose conditions read only plain pass values (no member, index or call) is built with the row. A `@while` without `@key` and a loop running `@{ }` code rebuild whole.
- **`@attr:`** binds the enclosing element (`fine.attrOf`) and is undone when its region or row goes.
- **`@{ }` blocks.** A `@{ }` block becomes a region holding it and the siblings after it, so its locals stay current.
- **Islands.** Child components, slots, `@cascade`, routes blocks, `@attributes`, event modifiers, markup inside `@{ }` and markup values in `@expr` are virtual-DOM subtrees, patched when what they read changes.
- **In the vdom.** The template is one `fine` vnode between two comments. Patches never rebuild it: `stateHasChanged()` re-runs every binding, for changes nothing tracks. Removing the component disposes its bindings.
- **Lifecycle.** A whole-component pass (mount, `stateHasChanged()`, new props from the parent): `shouldRender()` can veto it, and `onAfterRender(first)` follows. It re-runs every binding and keeps the DOM, so focus, scroll and element identity survive. A tracked field's write updates only its bindings, with neither hook.
- **Events.** A delegated handler runs when the event reaches the document, so a listener added directly on an ancestor runs first, and `stopPropagation()` in a fine handler cannot stop it. An element's `@key` is accepted and ignored: rows are keyed as above.
- **`--minify`.** `xzor build --minify` minifies and splits the bundle: the route table loads each `@page` with `lazy(() => import(...))`, so each page and each `@async` component is a chunk under `dist/chunks` (cleared on each build), while `dist/main.js`/`main.css` keep their names. Bun also folds chunk CSS into `main.css`; the chunk copies are deleted. With an `index.html` it also writes page shells and a `pages.json`; every `--minify` build writes compressed copies (below), and a server app also gets `dist/server.js` (see [Server apps](#server-apps)). Each build first removes the previous `dist/pages/`, `dist/pages.json` and top-level `.br`/`.gz` copies.
- **Page shells (`--minify`).** Each `@page` gets `dist/pages/<Name>.html` (two pages from one file share it; equal stems get `-2`): `index.html` with a `<link rel="modulepreload">` in `<head>` for the page's chunk and every chunk its static imports and the entry's reach, hrefs relative to the project root so a `<base>` keeps them working. `dist/pages.json` is `{ routes, files }`: `routes` maps each `@page` pattern to its shell, `files` lists (relative to the project root) what a server serves: outputs, fonts, shells, `index.html`, the local files it references and, for a PWA, `sw.js`, the manifest and its icons; no source maps, no copies. Every text output (`.js`, `.css`, `.html`, `.json`, `.svg`, shells included) also gets a `.br` (quality 11) and a `.gz` (level 6) copy beside it, written last; fonts and images get none. The worker precaches the shells, never `pages.json` (the server's manifest, which the browser does not fetch) nor the copies.

## Components from another project (the xzor-ui kit)

Full design: [the design kit spec](superpowers/specs/2026-10-17-design-kit-design.md).

- **Import through tsconfig `paths`.** `@import Button from "@source-crafter/xzor-ui/Button.xzor"` resolves through the importing project's `compilerOptions.paths` (`"@source-crafter/xzor-ui/*": ["../../ui/.xzor/*.ts"]`). The compiler maps the generated `.xzor/<rel>.xzor.ts` back to the `<rel>.xzor` source to read the props, and follows `paths` and `export { ... } from` re-exports to find string-literal aliases (`tone?: Tone` takes text). The bundle resolves non-relative `.xzor` specifiers through the same `paths`, and relative imports through the rootDirs of the importer's own project.
- **Compile the kit first.** `xzor build` only compiles its own project; run `xzor compile ui` (or `bun run ui`) before building an app that uses the kit. `--watch` does not watch the kit.
- **Tracking.** Generated fine components are field-tracked wherever they live (outside `node_modules`), so a kit component's props update like the app's own.
- **Hoisted props stay literal.** A generic component used without type arguments gets its props hoisted to infer `T`; static text props are emitted `as const`, so `depth="1"` keeps the type `"1"` and doesn't make inference fail.
- **CSS.** `import "@source-crafter/xzor-ui"` pulls in `ui.css`, which Bun bundles into `dist/main.css`; link that in `index.html`. The kit's rules: [`.github/skills/xzor-ui/SKILL.md`](../.github/skills/xzor-ui/SKILL.md).
- **Fonts.** `url(./fonts/*.woff2)` in a style sheet is kept external and the files are copied to `dist/fonts/` (Bun would inline small assets as base64).
- **Editor.** The language server lists the kit's components from the same `paths` (patterns that map to a `.xzor/*.ts` folder) and its classes from the `.css` beside the package entry.

## Build

- Only `.xzor` files inside a tsconfig project are compiled. Each one produces `.xzor/<rel>.xzor.ts` plus a v3 `.xzor.ts.map`, and files are only written when their content changes.
- `tsc` errors are rewritten to point at `.xzor` positions.
- The bundle's source map is composed with the generated files' maps (Bun does not chain input maps), so browser devtools show the `.xzor` sources.
- `xzor build --watch` is event-driven. A Bun watcher (`src/watch.ts`) reports changed paths. xzor recompiles only the changed `.xzor` files and their dependents. It reruns DI when any `.ts` changes in a project with providers, or when an `@inject` set changes. Then it type-checks and bundles. Its own writes (`.xzor/`, `dist/`) are ignored. A `tsconfig.json` or `package.json` change recompiles everything and restarts the analyzer. `node_modules` is not watched, so an `@inherits` base in a package is only read again on such a full rebuild.
- DI analysis runs in a persistent process (`di.ts --serve`). It keeps one TypeScript 7 session per project root, so warm requests take a few milliseconds. `--watch` and the language server reuse it. It is recycled after 500 requests.
- `xzor init --server` (`npm/xzor/bin/init.ts`) sets up a server app: the usual `package.json`/`tsconfig.json`/`.gitignore` plus `@types/bun` (devDependency and `"types": ["bun"]`) and a starter `client/` (`Shell`, `Home`), `contracts/hello.ts` (a shared interface), `server/app.ts` (`@Run(Shell)` on an `IServerApplication`) and `server/api/hello.ts` (one `@Endpoints`), with an `index.html` whose body is empty. `examples/blog` is the reference server app: views in `client/`, `server/{app,posts-store}.ts`, `server/api/posts.ts` and shared types in `contracts/posts.ts`. A component imports the route table relative to the project root (`../../routes` from `client/pages`).
- `xzor dev` (the npm launcher's `bin/dev.ts`, which `xzor init` puts behind `bun run dev`) runs `xzor build --watch --hot` and serves the project folder on port 3000 (or `PORT`, or a free port) bound to `localhost`: it answers files such as `.env` and server code, so other machines can't reach it unless you pass `--host <name>` (`--host` alone is every interface; `--host` is not passed on to `xzor build`): `no-store` responses, unknown paths answered with `index.html` so client routes load, and nothing outside the folder is served. A server app's generated server runs behind it (see [Server apps](#server-apps)). Served HTML gets a `<script src="/__xzor/hot.js">` right after `<head>`, the dev-only client (`bin/hot.ts`) the hot bundle registers its component classes into; it listens for build results over `EventSource`. When a build only changed `.xzor` files, the server sends the recompiled modules and the client patches those classes in place, so the open page shows the edit and every component keeps its state (field values, focus, scroll). A save that changes no generated code (whitespace, format on save) sends nothing. Anything else reloads the page, as does a `#private` member, a new import or a changed base class; arrow-function fields keep their old code until a reload. A patch constructs the new class once to read its fields, and again per instance missing a new field, so field initializers with side effects (timers, sockets) run again; edit such components with a reload. A failed build keeps the last working page.
- PWA: when `<project root>/manifest.webmanifest` sits next to `index.html`, `xzor build` (never `--watch`) writes a dependency-free `<project root>/sw.js` (first line `// Generated by xzor. Do not edit.`; `xzor init` gitignores it) and appends one registration line to the entry bundle, `navigator.serviceWorker.register(new URL("<rel>/sw.js", import.meta.url))`, so the scope is the app's folder, sub-paths included. The precache list is `./`, `index.html`, `manifest.webmanifest`, every icon in the manifest, every local `href`/`src` in `index.html` and every build output except `*.map`. The cache is named `xzor-<version>`, the version being a hash of the precached files' paths and contents, so a rebuild with no change writes the same `sw.js` and a changed file installs a new worker; activation deletes the other `xzor-` caches. The worker only handles same-origin GETs: navigations go network-first and fall back to the cached `index.html` (so deep links work offline), everything else is cache-first. After a deploy, the new worker installs in the background on the first load and serves the new files from the second. The manifest is checked and problems print as `xzor: manifest.webmanifest: ...` on stderr without failing the build (invalid JSON, no `name`/`short_name`, no 192x192 or 512x512 icon, a missing icon file, no `display`). Without a manifest nothing is written and a stale generated `sw.js` is deleted; a `sw.js` you wrote is never touched. `xzor dev` answers `/sw.js` with a worker that unregisters itself, so a production worker never serves stale code in development.
- After stale generated files are pruned, empty folders under `.xzor/` are removed.

## Editor

- Completion in markup: `<` offers the project's components and those reachable through tsconfig `paths`, adding the `@import`. Inside a component tag it offers its props (with their `/** */` comment), `@key`, `@ref` and `@on<event>` for its `EventCallback` props. Inside a static attribute value it offers the string literals of the prop's type (inline unions and imported aliases), the page's `id`s for `commandfor`, `popovertarget`, `for`, `aria-*` ids and props documented "Id of ...", class names from the project's and packages' top-level `.css`, and the values of `command`, `popover`, `popovertargetaction`, `closedby` and `role`.
- Hover on a prop shows its declaration and doc comment; hover on a package component shows its import specifier.
- DI diagnostics appear where the problem is defined or referenced: registration decorators and constructor and factory parameters in `.ts` files, and `@inject` lines in `.xzor` files.
- They update live. Ranges shift as you type. 300 ms after the last change, the analysis reruns with the unsaved text of open documents. Nothing is written to disk until you save.
- The language server opens `.ts` files only for these diagnostics. Every other `.ts` feature stays with VS Code's TypeScript.
- Semantic tokens are TypeScript's, mapped back to the `.xzor`. A client with no xzor grammar sends `initializationOptions: { "syntaxTokens": true }` (the Zed extension does): the server then adds the rest of the syntax where TypeScript gave no token, from the parser's spans (`@` transitions, directives and keywords, `@* *@` comments, tags and attributes) and a small lexer over the TypeScript regions (keywords, strings, template literals, numbers, comments, operators, built-in types), and appends the types the legend lacks. VS Code, which has the TextMate grammar, gets TypeScript's tokens alone.
- Zed (`editors/zed`): a Rust extension built to WebAssembly by Zed. It starts `xzor lsp`, found as `lsp.xzor.binary` in the settings, else the project's `@source-crafter/xzor-cli-<platform>` package, else `xzor` on the `PATH`, and asks for `syntaxTokens`. The `XZor` language reuses the `html` grammar of Zed's HTML extension (Zed needs a Tree-sitter grammar for every language), so the colors come from `"semantic_tokens": "combined"`.

## Module code (`@module`)

`@module { ... }` (one per file) holds TypeScript that sits at the top level of the generated module, after the imports and before the class: constants, types, helper functions, and anything `export`ed. Other files import those names from the `.xzor` (`@import Button, { type Kind, kinds } from "./Button.xzor"`). The template and `@code` use them as written: they are not members, so no `this.` is added. Markup used as a value works as in `@code` (`export const badge = (t: string) => <b>@t</b>;`), but the block runs once per module, so it can't read the component's members; pass them as parameters. Component styles do not reach markup made in `@module`.

## Component styles

A component's top-level `<style>` (one per file), or a sibling `X.css.xzor` (never both), is CSS that applies to that component only.

- **Scope.** The rules are wrapped in `@scope ([data-xz="<id>"]) to (:scope [data-xz] > *)`, and each selector `S` becomes `:where(:scope, :scope *):is(S)` (same specificity; it also matches the component's top elements). Every top element of the template gets the static `data-xz="<id>"`, `<id>` being a hash of the project-relative path. The rules reach the component's own markup and the top elements of its child components, not their insides. A child with no styles of its own is styled like plain markup. Content passed to a child (default content and `@slot` fills) carries the parent's id, so the parent's rules reach it inside the child.
- **Global.** `<style global>`, or `@global` on the first line of `X.css.xzor`, skips the wrapper.
- **Reactive values.** A declaration whose value holds `@name` or `@(expr)` reads `var(--<id>-<n>)`, and the top elements get the attribute `--<id>-<n>` with the value's text (`width: @progress%` gives `String(this.progress) + "%"`). Attributes starting with `--` are custom properties in both renderers, so one change writes one property on the elements that show it; fine components compare before writing. Expressions are type-checked like attribute values. `@` in a selector or an at-rule prelude is an error; CSS at-rules (`@media`, `@container`, `@keyframes`, ...) are left alone, and `@@` is a literal `@`.
- **Conditional rules.** `@if (c) { rules } else if (d) { rules } else { rules }` gives each condition a boolean attribute `data-<id>-<n>` on the top elements, and nests the rules under a guard on the scope root (`:scope[data-<id>-0]`, `:scope:not([data-<id>-0])[data-<id>-1]`, ...). Inside a rule, `@if` guards that rule's elements by the root's state. Values from `@Cascade` fields work like any member.
- **Output.** The lowered sheet is written as `.xzor/<rel>.xzor.css`. The bundler appends `import "./X.xzor.css"` to the generated module it loads, so Bun emits one copy per module in `dist/main.css` and the type check never sees CSS. A style change reloads the page in `xzor dev` instead of patching.
- **Costs.** A component with R top elements and V dynamic declarations gets R x V bindings; a static style adds one attribute to the template and nothing per instance.

## Roadmap

The documentation site's Roadmap page is the public view; this is the short list.

1. Publish xzor-ui to npm as `@source-crafter/xzor-ui`, keeping the import paths apps use today.
2. HTML element and attribute completion in markup.
3. Page shells (preloaded shell rendering, PSR) and server apps with endpoints: built. Proposal and measurements: [backlog-page-shells](plans/backlog-page-shells.md).
4. Contracts and typed clients for endpoints: next.
5. Later: a native rendering target for the same components.
