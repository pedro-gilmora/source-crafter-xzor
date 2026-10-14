# xzor

**Blazor-style components for TypeScript.** You write `.xzor` files: markup with `@` expressions plus a `@code` block. A Rust compiler turns each one into a typed TypeScript class. The TypeScript 7 compiler checks it, and Bun bundles it into a small single-page app.

```
Counter.xzor ──xzor──▶ .xzor/Counter.xzor.ts ──tsc──▶ type errors ──Bun──▶ dist/main.js
```

If you know Razor, you already know most of it. If you don't, the steps below take you from an empty folder to an app with routing and dependency injection.

---

## 0. Install

You need [Bun](https://bun.sh) ≥ 1.4.

```sh
bun add -d @source-crafter/xzor typescript@^7
bun add @source-crafter/xzor-runtime
```

For the editor, download `xzor-<version>.vsix` from the [releases](../../releases) and install it with `code --install-extension xzor-<version>.vsix`. It gives you highlighting, completions, hover, go-to-definition and live diagnostics, including inside the `@` expressions.

`tsconfig.json` must also see the generated files:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "ESNext.Disposable", "DOM"],
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "rootDirs": [".", ".xzor"]          // lets `import X from "./X.xzor"` resolve
  },
  "include": ["**/*.ts", ".xzor/**/*.ts"]
}
```

## 1. Your first component

```xzor
@* Counter.xzor *@
@code {
  count = 0;
}

<button @onclick="() => count++">Clicked @count times</button>
@if (count >= 10) {
  <p>That's a lot of clicks.</p>
}
```

- `@name`, `@a.b(c)` and `@(expr)` print values. Names that refer to `@code` members get `this.` added for you.
- `@if`, `@for`, `@while` and `@switch` are plain TypeScript control flow around markup.
- `@onclick="..."` handles a DOM event, with the type of that event, and then re-renders the component.

```ts
// main.ts
import { type IApplication, Mount } from "@source-crafter/xzor-runtime";
import Counter from "./Counter.xzor";

@Mount(Counter, "app")              // renders into <div id="app">
export class Application implements IApplication {}
```

```sh
bun x xzor build            # compile + type-check + bundle into dist/
bun x xzor build --watch    # rebuild on save
```

Load `dist/main.js` as a module script next to a `<div id="app">`, and that's it.

## 2. Components talk: props, callbacks, binding

```xzor
@* Stepper.xzor *@
@import { type EventCallback } from "@source-crafter/xzor-runtime"
@code {
  value = 0;
  valueChanged?: EventCallback<number>;
}
<button @onclick="() => valueChanged?.(value + 1)">@value</button>
```

```xzor
@import Stepper from "./Stepper.xzor"
@code { n = 1; }

<Stepper @bind-value="n" />     @* two-way binding: passes value + valueChanged *@
<input type="number" @bind="n" />
```

- A capitalized tag is a component. Its attributes are type-checked against the component's fields.
- `@bind` works on inputs (numbers stay numbers, checkboxes bind `checked`), and `@bind-value` works on components.
- `@key="item.id"` in a list keeps DOM nodes and component state when the items reorder.
- The lifecycle follows Blazor's order: `onInitialized(Async)`, then `onParametersSet(Async)`, then render, then `onAfterRender(first)`, and `dispose()` when the component leaves the tree.

## 3. Composition: slots and fragments

```xzor
@* Card.xzor *@
<section>
  @slot:header { <h3>Default title</h3> }   @* named slot, with fallback content *@
  @slot                                     @* default slot *@
</section>
```

```xzor
<Card>
  @slot header { <em>Custom title</em> }
  <p>Everything else goes to the default slot.</p>
</Card>
```

Slots can pass arguments (`@slot:item(item)` in the component, then `@slot item(x) { … }` in the parent), and their types are inferred. Inside `@code`, markup is a value (a `RenderFragment`) that you can return, store and render with `@member`.

## 4. Share state without prop drilling: cascading values

```xzor
@cascade:theme(currentTheme) {
  <Toolbar />                   @* any depth below can read it *@
}
```

```xzor
@code { @Cascade theme!: string; }
```

## 5. Pages and routing

```xzor
@page "/users/:id"
@code { id!: number; }          @* ":id" is converted to number from the field type *@
<h1>User @id</h1>
```

One shell component holds the routes block:

```xzor
@ClientRoutes(route) {
  @notFound { <p>Not found</p> }
  @catch(e) { <p class="error">@e</p> }
  @default(page) { <MainLayout>@page</MainLayout> }
}
```

- `href.UserPage({ id: 7 })` (from `./routes`) builds typed links, and a wrong parameter type is a compile error.
- `<NavLink href="/users" activeClass="active">` marks the link while its route is active.
- Use `@page "/admin/:id" as admin` to tag routes, then lay them out with an `@admin(page) { … }` section.

## 6. Services: compile-time dependency injection

```ts
@ServiceProvider()
@Singleton<IDatabase>(Database)       // Database(log: ILogger) is wired automatically
@Singleton<ILogger>(ConsoleLogger)
@Scoped(UnitOfWork)
export class DataServices {}
```

```xzor
@inject IDatabase db
<small>@db.name</small>
```

There is no reflection and no runtime container. xzor reads your types and generates the plain `new` calls into `.xzor/`. Missing or ambiguous services, lifetime mistakes and cycles are build errors, and the editor shows them as you type. Async factories, keyed services (`@Singleton("key", factory)`) and disposal (`Symbol.dispose`) are supported.

## 7. The full tour

[`examples/counter`](examples/counter) uses every feature above in one app: layouts, an admin area, typed routes, an error page, async settings and scoped services. Build it with `cargo run -- build examples/counter`. For the complete reference, see [docs/design.md](docs/design.md).

---

## How it works (the short version)

| Piece | What it does |
|---|---|
| `src/parser.rs` | Turns `.xzor` into an AST with source spans |
| `src/codegen.rs` | Generates a TypeScript class with `buildRenderTree(builder)`, plus source mappings |
| `src/build.rs` | Writes `.xzor/`, the route table and the DI output, runs `tsc`, then bundles with Bun |
| `src/di.ts` | Reads services and constructors with TypeScript 7's API and generates the providers |
| `runtime/index.ts` | `RenderTreeBuilder`, the diff (by position, or keyed), components, the router and the DI types |
| `src/lsp/` | `xzor lsp`: component features, and a proxy to `tsc --lsp` through the mappings for the TypeScript regions |

The design rules:
- **Pay at compile time, not at runtime.** Generic inference, DI and routing are all generated as plain code.
- **Allocate no more than hand-written code would.**
- **The compiler has zero Rust dependencies.**

## Development

```sh
cargo test                 # compiler unit + integration tests
bun test                   # runtime, build, DI and LSP end-to-end tests
bun run test:grammar       # VS Code grammar tests
./Package.ps1 -test true   # build, test and pack everything into publish/
```

**Releasing:** push to `main` with a commit message that starts with `[Release]`. CI then:
1. builds the binaries for win32-x64, linux-x64 and darwin-arm64;
2. runs every test;
3. publishes the npm packages with the next sequential version (the patch after the latest one on npm);
4. creates a GitHub release with the `.vsix`, the binaries and the tarballs.
