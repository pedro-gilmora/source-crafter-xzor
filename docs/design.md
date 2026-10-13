# zor design

## Goal

`.tszor` is to TypeScript what `.razor` is to C#. You write a component as markup with `@` transitions plus a `@code` block. `zor` lowers it to a TypeScript class whose `buildRenderTree` calls a `RenderTreeBuilder`. The TypeScript is type-checked, then bundled to JavaScript.

```
X.tszor --zor (Rust)--> .zor/X.tszor.ts --tsc 7--> type errors --Bun.build--> dist/*.js
```

The generated TypeScript is an internal step, like Blazor's `obj/`. Editors get IntelliSense through `zor lsp` (see [superpowers/specs/2026-10-11-lsp-design.md](superpowers/specs/2026-10-11-lsp-design.md)).

## Syntax (v0)

| Syntax | Meaning |
|---|---|
| `@page "/route"` | `static readonly route` |
| `@import A from "./A.tszor"` | Verbatim ES import |
| `@code { ... }` | Class members |
| `@name`, `@a.b(c)[0]?.d` | Implicit expression; stops at text such as `:` or `.` followed by a non-identifier |
| `@( expr )` | Explicit expression |
| `@if (c) { } else if (c) { } else { }` | Control flow |
| `@for (const x of xs) { }` | Loop (any JS `for` head) |
| `@while (cond) { }` | `while` loop, in its own region |
| `@* comment *@` | A comment, removed at compile time |
| `@{ const x = f(); <p>@x</p> @: text @x }` | Statements inside `buildRenderTree`. Variables declared there are usable later in the same scope. Markup at statement start and `@:` lines render in place, and markup used as a value becomes a `RenderFragment`. |
| `<text>…</text>` | Renders its content only, with no wrapper element |
| `@inherits Base<T>`, `@implements A, B`, `@attribute dec(args)` | `@dec(args)` then `export default class C extends Base<T> implements A, B`. The base must derive from `ComponentBase`. |
| `@switch (v) { case a: case b: ... break; default: ... }` | Each case is block-scoped and always ends in `break` (no fall-through into a body). Stacked labels share one body. `break;` is optional. |
| `@@`, `a@b.com` | Literal `@` |
| `attr="text @expr"`, `attr="@expr"` | Interpolated and typed attribute values (`false`/`null` removes the attribute) |
| `@onclick="handler"`, `@onclick="() => ..."` | DOM event; typed through `HTMLElementEventMap`; triggers a re-render |
| `@onclick:preventDefault`, `@onclick:stopPropagation="cond"` | Event modifiers. They work without a handler, and take an optional boolean expression. |
| `@attributes="dict"` | Attribute splatting on elements, where later attributes override it. On components, props are spread: `{ ...dict, title: "t" }`. |
| `<Child prop="x" n="5" />` | Component (capitalized tag); props are type-checked as `Partial<Child>`. As in Blazor, a prop declared with a non-string type (`n: number`, `on: () => void`, or inferred from a non-string initializer) takes its value as a TypeScript expression. String props take text. |
| `@typeparam T extends X` | Generic component class `C<T extends X>`. Callers can pass the argument as an attribute (`<List T="string" …>` compiles to `List<string>`) or leave it out: `T` is then inferred from the props. Without `T=`, callback props must annotate their own parameters, a type parameter that cannot be inferred becomes `unknown` (not its default), and a prop mismatch is reported at the tag. |
| `@inject IDatabase db // why` | Directive lines (`@inject`, `@inherits`, `@implements`, `@typeparam`, `@attribute`, `@import`, `@page`) accept a trailing `// …` or `@* … *@` comment. |
| `onChange?: EventCallback<T>` | A prop the parent sets with `onChange="handler"`. Calling it re-renders the parent. |
| `@bind="x"`, `@bind:event="oninput"`, `@bind:after="save"` | Two-way binding on inputs. Checkboxes and radios bind `checked`, and numbers stay numbers. |
| `@bind-value="x"` | Two-way binding on a component: passes `value` and a `valueChanged` callback. |
| `@key="expr"` | On an element or component in a list: the diff matches it by key, moving DOM nodes and component state when items reorder. |
| `@ref="field"` | On an element, assigns the DOM element, typed from the tag (`<input>` gives `HTMLInputElement`). On a component, assigns the instance. Updated after each render. |
| `protected override onInitialized()` and similar | Lifecycle methods, in Blazor's order: `onInitialized`/`onInitializedAsync` once, `onParametersSet`/`onParametersSetAsync` on mount and whenever props change, then render, then `onAfterRender(first)`/`onAfterRenderAsync(first)`. `shouldRender()` can veto re-renders, and `dispose()` runs when the component leaves the tree. A settled `...Async` promise re-renders the component. |

In template expressions, free identifiers that name `@code` members are rewritten to `this.x`. Loop variables shadow members.

### Markup as values (RenderFragment)

Inside `@code`, markup can be used as a value, like Blazor's `RenderFragment`. It's written `<Tag …>` wherever an expression can start (after `return`, `=`, `(`, `,`, `?`, `:`, `=>`, …), or `@<Tag …>` anywhere. It compiles to `ComponentBase.fragment((__b) => { … })`, typed `RenderFragment` (alias `Renderer`, from `@zor/runtime`), so TypeScript enforces the declared return or field type. Inside this markup, names follow plain TypeScript scope (write `@this.x`). Render a fragment from the template with `@member` or `@method(args)`; it gets its own region in the diff. Text that fails to parse as markup stays TypeScript (generic arrows `<T,>(x: T) => x`, comparisons).

```tszor
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

```tszor
<!-- Card.tszor (definition) -->
<section>
  @slot:header { <h3>@title</h3> }      <!-- named, with fallback content -->
  @slot                                 <!-- the nameless (default) slot -->
</section>

<!-- List.tszor (definition with arguments) -->
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
- The component class declares `declare slots: { name?: (p: T, …) => RenderFragment; … }`, so TypeScript checks slot names and parameter types, and infers untyped parameters. zor infers each argument's type at compile time:
  - a member `x` or `this.x.y` becomes `this["x"]["y"]`
  - a loop variable from `const x of <member path>` becomes `…[number]`; `in` gives `string`, and `let i = 0` gives `number`
  - `expr as T` becomes `T`
  - a literal becomes `number`, `string` or `boolean`
  - markup becomes `RenderFragment`

  Any other argument is an error asking for `as Type`.

## Rendering

- An event re-renders only the component that owns the handler. `stateHasChanged()` does the same for any component.
- The new render tree is diffed against the previous one by position, and only changed text, attributes, handlers and nodes are touched. DOM nodes keep their identity, so focus and input state survive.
- Each `@if`, `@for` and `@switch` produces a region, marked by a comment anchor. Its variable output is diffed in isolation, so it never shifts static siblings.
- A child component re-renders only if a prop changed (`Object.is`). Object props always count as changed, as in Blazor.
- Component identity comes from the diff, as in Blazor: a child keeps its instance and state while it stays at the same position with the same type and `@key`. Otherwise it is disposed and a new instance is created.
- Lists with `@key` use a keyed diff: matched nodes are patched and moved, and unmatched ones are removed or created.

## Dependency injection

zor resolves services at compile time and emits plain TypeScript: no reflection and no runtime container. Full design: [the DI spec](superpowers/specs/2026-10-12-di-bootstrap-design.md).

### Providers and registrations

The decorators come from `@zor/runtime` and do nothing at runtime. `@ServiceProvider()` marks a reusable provider class in any `.ts` file; zor generates `.zor/<rel>.provider.ts` with a subclass `<Name>$` that has one public getter per service.

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
| `@Singleton("key", Owner.factory)` | A keyed service built by a public static method of another class. The key matches a parameter name before the type is tried. |
| `@Import(OtherProvider)` | Uses another provider's services. The imported provider must be self-sufficient. |

Constructor and factory parameters are resolved by key, then by type. A `?` or defaulted parameter gets `undefined` when nothing matches.

### Components: `@inject`

`@inject IDatabase db` in a `.tszor` adds a constructor parameter and a `readonly db` field. The application builds such components in its generated `createComponent`. A component with `@inject` cannot declare its own `constructor` (ZDI08).

### The application: `@Mount`

The entry module declares one class with `@Mount(App, "app")` plus registrations and imports. zor writes `.zor/<entry>` with the generated subclass and the `mount(App, "app", new Application$())` call, and bundles that instead of the entry. Do not call `mount()` yourself.

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
- A class cannot reference itself in its own decorators, so keyed factories must be public static methods of another class.
- A `.tszor` must not import from `./main`: with `rootDirs`, that resolves to the generated `.zor/main.ts`.
- Optional members such as `dispose?()` are disposed with an optional call (`d0?.dispose?.()`).
- `@Mount` must be in the entry module (`--entry`, default `main.ts`).

## Build

- Only `.tszor` files inside a tsconfig project are compiled. Each one produces `.zor/<rel>.tszor.ts` plus a v3 `.tszor.ts.map`, and files are only written when their content changes.
- `tsc` errors are rewritten to point at `.tszor` positions.
- The bundle's source map is composed with the generated files' maps (Bun does not chain input maps), so browser devtools show the `.tszor` sources.
- `zor build --watch` is event-driven. A Bun watcher (`src/watch.ts`) reports changed paths. zor recompiles only the changed `.tszor` files and their dependents. It reruns DI when any `.ts` changes in a project with providers, or when an `@inject` set changes. Then it type-checks and bundles. Its own writes (`.zor/`, `dist/`) are ignored. `tsconfig.json` and `package.json` changes need a restart.
- DI analysis runs in a persistent process (`di.ts --serve`). It keeps one TypeScript 7 session per project root, so warm requests take a few milliseconds. `--watch` and the language server reuse it. It is recycled after 500 requests.
- After stale generated files are pruned, empty folders under `.zor/` are removed.

## Editor

- DI diagnostics appear where the problem is defined or referenced: registration decorators and constructor and factory parameters in `.ts` files, and `@inject` lines in `.tszor` files.
- They update live. Ranges shift as you type. 300 ms after the last change, the analysis reruns with the unsaved text of open documents. Nothing is written to disk until you save.
- The language server opens `.ts` files only for these diagnostics. Every other `.ts` feature stays with VS Code's TypeScript.

## Roadmap

1. Rename and find references, through the same mappings.
2. Keep TypeScript features working while the template has syntax errors.
3. Color markup inside `@code` as markup.
