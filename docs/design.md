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
| `@name`, `@a.b(c)[0]?.d` | Implicit expression; stops at text such as `:` or `.` followed by a non-identifier |
| `@( expr )` | Explicit expression |
| `@if (c) { } else if (c) { } else { }` | Control flow |
| `@for (const x of xs) { }` | Loop (any JS `for` head) |
| `@while (cond) { }` | `while` loop, in its own region |
| `@* comment *@` | A comment, removed at compile time |
| `@{ const x = f(); <p>@x</p> @: text @x }` | Statements inside `buildRenderTree`. Variables declared there are usable later in the same scope. Markup at statement start and `@:` lines render in place, and markup used as a value becomes a `RenderFragment`. |
| `<text>…</text>` | Renders its content only, with no wrapper element |
| `@inherits Base<T>`, `@implements A, B`, `@attribute dec(args)` | `@dec(args)` then `export default class C extends Base<T> implements A, B`. The base must derive from `ComponentBase`. When the base resolves through an `@import` (a `.ts`, `.d.ts` or `.xzor` file, following re-exports and its own `extends` chain; a bare specifier is found in `node_modules` through `types`, `typings`, `exports` (conditions, subpaths and `*` patterns; `.js` targets read as their `.d.ts`), `index.d.ts` or `@types/<pkg>`), its instance members are usable as bare names in the template, like `@code` members. When a base in the chain can't be read, compiling warns (`could not read base class 'Base'; use this.<member> for its members`, also an LSP warning) and its members need `this.`. tsconfig `paths`, `export =` and bases that are expressions (`extends mixin(A)`) are not followed. |
| `@switch (v) { case a: case b: ... break; default: ... }` | Each case is block-scoped and always ends in `break` (no fall-through into a body). Stacked labels share one body. `break;` is optional. |
| `@@`, `a@b.com` | Literal `@` |
| `&lt;`, `&eacute;`, `&#233;`, `&#xE9;` | Character references in text and in text attribute values (including string props) are decoded at compile time, like Razor: numeric ones and the HTML 4 names. Unknown names stay as written; `<script>`/`<style>` content and expression values are not decoded. |
| `attr="text @expr"`, `attr="@expr"` | Interpolated and typed attribute values (`false`/`null` removes the attribute) |
| `@onclick="handler"`, `@onclick="() => ..."` | DOM event; typed through `HTMLElementEventMap`; triggers a re-render |
| `@onclick:preventDefault`, `@onclick:stopPropagation="cond"` | Event modifiers. They work without a handler, and take an optional boolean expression. |
| `@attributes="dict"` | Attribute splatting on elements, where later attributes override it. On components, props are spread: `{ ...dict, title: "t" }`. |
| `<Child prop="x" n="5" />` | Component (capitalized tag); props are type-checked as `Partial<Child>`. As in Blazor, a prop declared with a non-string type (`n: number`, `on: () => void`, or inferred from a non-string initializer) takes its value as a TypeScript expression. String props take text: `string`, string literals, a string default (`name: SnippetName = "hero"`), or an alias of string literals imported from a relative module (`size?: Size` with `export type Size = "s" \| "m"`). |
| `@typeparam T extends X` | Generic component class `C<T extends X>`. Callers can pass the argument as an attribute (`<List T="string" …>` compiles to `List<string>`) or leave it out: `T` is then inferred from the props. Without `T=`, callback props must annotate their own parameters, a type parameter that cannot be inferred becomes `unknown` (not its default), and a prop mismatch is reported at the tag. |
| `@inject IDatabase db // why` | Directive lines (`@inject`, `@inherits`, `@implements`, `@typeparam`, `@attribute`, `@import`, `@page`) accept a trailing `// …` or `@* … *@` comment. |
| `onChange?: EventCallback<T>` | A prop the parent sets with `onChange="handler"`. Calling it re-renders the parent. |
| `@bind="x"`, `@bind:event="oninput"`, `@bind:after="save"` | Two-way binding on inputs. Checkboxes and radios bind `checked`, and numbers stay numbers. |
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

@ClientRoutes(route) {
  @admin(page) { <AdminLayout>@page</AdminLayout> }
  @/^\/docs\/(?<area>\w+)/i(page) { <DocsLayout area="@route.match.area">@page</DocsLayout> }
  @"/legal/:doc" { <LegalText doc="@route.params.doc" /> }
  @notFound { <p>Not found</p> }
  @catch(e) { <ErrorPanel error="@e" /> }
  @default(page) { <MainLayout>@page</MainLayout> }
}
```

- **`@page "pattern" [as tag]`**: Bun.serve pattern syntax: `/`-led segments that are literals, `:param`, or a final `*`. A component may have several. Params fill the props of the same name, converted from the prop's declaration: `number` (`Number`, `NaN` is no match), `boolean` (`"true"`/`"false"`), a union of string literals (must be one of them), otherwise `string`. Values are decoded with `decodeURIComponent`. The text matched by `*` fills a prop named `rest` if the page declares one. The optional tag is shared by any number of routes (`default`, `notFound` and `catch` are reserved). Most specific wins, as in Bun: literal, then `:param`, then `*`.
- **The routes block**: `@ClientRoutes(route) { ... }` or `@ServerRoutes(route) { ... }`, at most one per project, holding only sections (`{` may be on the next line). `route` is visible in every section. Sections: `@tag(page)` (a tag some `@page` uses), `@/regex/flags(page?)` (client only), `@"pattern"(page?)`, `@notFound`, `@catch(e)` (the matched page's construction, `onInitialized`, rejected `onInitializedAsync` or first render failed; cleared on the next navigation), `@default(page)` (last; `page` renders the matched page).
- **Matching order**: when a `@page` route matches, the sections with `(page)` are tried in source order, then `@default`, then the page renders bare. Without a page route, the page-less sections are tried in order, then `@notFound`, then nothing renders. A `(page)` pattern section's captures are on `route.match`; a page-less one's are on `route.params`.
- **`route`**: `{ path, tag, params, query, match, is(tag), navigate(url, { replace }) }`, also the cascading value `route`. `is(tag)` narrows `params` inside the routes block's sections; elsewhere type the field with the table's `AppRoute` (`@Cascade route!: AppRoute`, `import type { AppRoute } from "./routes"`) to get the same narrowing. A new object is published on each navigation. A page is kept across navigations within one route family of its component: routes that extend, segment by segment, the shortest of its own patterns they start with (`/users/:id`, `/users/:id/:view`, `/users/:id/*`). Its props are set again, params only the other routes of the family fill become `undefined`, and `onParametersSet` runs. A route that extends none of its page's shorter patterns builds a new instance.
- **`href.<Component>(params)`**: from `routes` (imported relatively, e.g. `import { href } from "../routes"`). One overload per `@page` of the component, typed from its props, so `href.UserProfile({ id: "x" })` is a type error when `id` is a `number`. A route without parameters takes no argument (`href.About()`; the parameter defaults to `{}`, so `href.About({})` still works). Values are `encodeURIComponent`ed; the first of the component's patterns whose param names equal the given keys is used.
- **`<NavLink href="/x" activeClass="active" match="prefix|exact">`**: an `<a>` that carries the class while the current path is on its `href` (resolved against the base URL, compared percent-encoded). It follows navigation by itself, so it also works outside the routes block (a nav bar beside it); it never intercepts clicks on its own.
- **Sub-path deployments**: with `<base href="/docs/">` (GitHub Pages serves a project at `/<repo>/`), patterns, `route.path` and section regexes are relative to that path (`basePath()`, from the runtime, gives `"/docs"`), `href.<Component>()` prefixes it, and the base root counts as the root for `NavLink`. Write other links relative (`href="users/1"`) so the browser resolves them against the base.
- **Engines**: `@ClientRoutes` is a single-page app on the History API. It intercepts `<a>` clicks that are same-origin, left-button, without modifier keys, with `target` absent or `_self`, no `download` and no `rel="external"`. `popstate` re-renders, and `navigate` uses `pushState` (`replaceState` with `replace`). `@ServerRoutes` (one page per entry, no History API) is coming in the next part.
- **`.xzor/routes.ts`**: the generated route table (matchers, `href`, `RouteTag`, `RouteParams`, `AppRoute`), written from every `@page` of the project and removed when it has none. A real `routes.ts` at the project root is reserved.
- **Limits**: a trailing slash (`/a/`) is rejected, regex sections only work in `@ClientRoutes` (`@ServerRoutes` takes string patterns), a duplicate pattern or page component name is an error, and a `@page` component can't hold the routes block (it would render itself; keep the block in a shell component without `@page`).

## Rendering

- An event re-renders only the component that owns the handler. `stateHasChanged()` does the same for any component.
- The new render tree is diffed against the previous one by position, and only changed text, attributes, handlers and nodes are touched. DOM nodes keep their identity, so focus and input state survive.
- Each `@if`, `@for` and `@switch` produces a region, marked by a comment anchor. Its variable output is diffed in isolation, so it never shifts static siblings.
- A child component re-renders only if a prop changed (`Object.is`). Object props always count as changed, as in Blazor.
- Component identity comes from the diff, as in Blazor: a child keeps its instance and state while it stays at the same position with the same type and `@key`. Otherwise it is disposed and a new instance is created.
- Lists with `@key` use a keyed diff: matched nodes are patched and moved, and unmatched ones are removed or created.

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

### The application: `@Mount`

The entry module declares one class with `@Mount(App, "app")` plus registrations and imports. xzor writes `.xzor/<entry>` with the generated subclass and the `mount(App, "app", new Application$())` call, and bundles that instead of the entry. Do not call `mount()` yourself.

```ts
@Mount(App, "app")
@Import(DataServices)
@Singleton(AuthService)
@Singleton("requestId", Factories.newRequestId)
export class Application implements IApplication {}
```

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
| ZDI04 | An `@inject` type is not provided by the application, or there is no `@Mount` application. |
| ZDI05 | Ambiguous: two registrations satisfy one unkeyed parameter. |
| ZDI06 | Registration without an implementation or factory. |
| ZDI07 | `@Mount` on more than one class, or outside the entry module. |
| ZDI08 | A user constructor in a component with `@inject`. |
| ZDI10 | Reserved. Captive dependencies are allowed: a singleton keeps the scoped instance of the scope that first resolved it. |
| ZDI11 | Invalid registration found by the analyzer (unexported type, generic type, non-public factory, decorator misuse). |
| ZDI12 | A key matched by parameter name provides a type that is not assignable to the parameter. |

### Gotchas

- The tsconfig `lib` needs `ESNext.Disposable` (for `Disposable` and `Symbol.dispose`).
- A class cannot reference itself in its own decorators, so a keyed factory is either a public static method of another class or an exported function. It must be exported because the generated code imports it.
- A `.xzor` must not import from `./main`: with `rootDirs`, that resolves to the generated `.xzor/main.ts`.
- Optional members such as `dispose?()` are disposed with an optional call (`d0?.dispose?.()`).
- `@Mount` must be in the entry module (`--entry`, default `main.ts`).
- `routes.ts` at the project root is reserved, like `main.ts`: with `rootDirs`, an import of `<root>/routes` resolves to the generated `.xzor/routes.ts` (the route table, written when the project has `@page`s and removed when it has none).
- Members of an `@inherits` base that can't be read (see the warning) are not rewritten to `this.x` in the template; write `this.x` yourself.

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
- The class gets `static { Model.$define(this, ["name", "hours"]); }`, which lists its tracked fields. A subclass's fields come after its base's.
- If the class has no constructor, it gets `constructor(data?) { super(data); if (new.target === X) this.assign(data); }`. A hand-written constructor must call `this.assign(data)` itself.
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

A set held by a model field tells the model when it is mutated, so components that read the field draw again.

### Limits

- Only direct subclasses of `Model` are tracked (v1).
- `set[i] = x` and `set.length = n` are not noticed. Use the methods.
- A set shared by two models notifies only the last one.
- An EntitySet held directly by a component re-renders on changes made in that component's event handlers only; to see list changes from timers or services, keep the list in a model field.
- `changes`, `same` and `isLike` don't support plain object graphs with cycles.
- The tsconfig `lib` needs `ESNext.Decorators`.

## Build

- Only `.xzor` files inside a tsconfig project are compiled. Each one produces `.xzor/<rel>.xzor.ts` plus a v3 `.xzor.ts.map`, and files are only written when their content changes.
- `tsc` errors are rewritten to point at `.xzor` positions.
- The bundle's source map is composed with the generated files' maps (Bun does not chain input maps), so browser devtools show the `.xzor` sources.
- `xzor build --watch` is event-driven. A Bun watcher (`src/watch.ts`) reports changed paths. xzor recompiles only the changed `.xzor` files and their dependents. It reruns DI when any `.ts` changes in a project with providers, or when an `@inject` set changes. Then it type-checks and bundles. Its own writes (`.xzor/`, `dist/`) are ignored. A `tsconfig.json` or `package.json` change recompiles everything and restarts the analyzer. `node_modules` is not watched, so an `@inherits` base in a package is only read again on such a full rebuild.
- DI analysis runs in a persistent process (`di.ts --serve`). It keeps one TypeScript 7 session per project root, so warm requests take a few milliseconds. `--watch` and the language server reuse it. It is recycled after 500 requests.
- `xzor dev` (the npm launcher's `bin/dev.ts`, which `xzor init` puts behind `bun run dev`) runs `xzor build --watch --hot` and serves the project folder on port 3000 (or `PORT`, or a free port): `no-store` responses, unknown paths answered with `index.html` so client routes load, and nothing outside the folder is served. Served HTML gets a `<script src="/__xzor/hot.js">` right after `<head>`, the dev-only client (`bin/hot.ts`) the hot bundle registers its component classes into; it listens for build results over `EventSource`. When a build only changed `.xzor` files, the server sends the recompiled modules and the client patches those classes in place, so the open page shows the edit and every component keeps its state (field values, focus, scroll). A save that changes no generated code (whitespace, format on save) sends nothing. Anything else reloads the page, as does a `#private` member, a new import or a changed base class; arrow-function fields keep their old code until a reload. A patch constructs the new class once to read its fields, and again per instance missing a new field, so field initializers with side effects (timers, sockets) run again; edit such components with a reload. A failed build keeps the last working page.
- PWA: when `<project root>/manifest.webmanifest` sits next to `index.html`, `xzor build` (never `--watch`) writes a dependency-free `<project root>/sw.js` (first line `// Generated by xzor. Do not edit.`; `xzor init` gitignores it) and appends one registration line to the entry bundle, `navigator.serviceWorker.register(new URL("<rel>/sw.js", import.meta.url))`, so the scope is the app's folder, sub-paths included. The precache list is `./`, `index.html`, `manifest.webmanifest`, every icon in the manifest, every local `href`/`src` in `index.html` and every build output except `*.map`. The cache is named `xzor-<version>`, the version being a hash of the precached files' paths and contents, so a rebuild with no change writes the same `sw.js` and a changed file installs a new worker; activation deletes the other `xzor-` caches. The worker only handles same-origin GETs: navigations go network-first and fall back to the cached `index.html` (so deep links work offline), everything else is cache-first. After a deploy, the new worker installs in the background on the first load and serves the new files from the second. The manifest is checked and problems print as `xzor: manifest.webmanifest: ...` on stderr without failing the build (invalid JSON, no `name`/`short_name`, no 192x192 or 512x512 icon, a missing icon file, no `display`). Without a manifest nothing is written and a stale generated `sw.js` is deleted; a `sw.js` you wrote is never touched. `xzor dev` answers `/sw.js` with a worker that unregisters itself, so a production worker never serves stale code in development.
- After stale generated files are pruned, empty folders under `.xzor/` are removed.

## Editor

- DI diagnostics appear where the problem is defined or referenced: registration decorators and constructor and factory parameters in `.ts` files, and `@inject` lines in `.xzor` files.
- They update live. Ranges shift as you type. 300 ms after the last change, the analysis reruns with the unsaved text of open documents. Nothing is written to disk until you save.
- The language server opens `.ts` files only for these diagnostics. Every other `.ts` feature stays with VS Code's TypeScript.

## Roadmap

1. Rename and find references, through the same mappings.
2. Keep TypeScript features working while the template has syntax errors.
3. Color markup inside `@code` as markup.
4. PWA support: `@Pwa({...})` next to `@Mount` generates the manifest, a service worker and its registration, on top of content-hashed assets ([plan](plans/backlog-pwa.md)).
