# xzor

**Write components the Blazor way. Ship plain, typed TypeScript.**

```xzor
<button @onclick="() => count++">Clicked @count times</button>
```

A `.xzor` file is HTML with `@` expressions plus a `@code` block. The xzor compiler, written in Rust, turns it into a TypeScript class. TypeScript 7 checks it, and Bun bundles it into a small single-page app. You get:

- **Types everywhere**: props, events, slots, routes and services are checked at build time, and your editor shows the errors as you type.
- **No runtime magic**: routing and dependency injection are generated as plain code. There is no reflection and no container.
- **A small, fast runtime**: it diffs the render tree and touches only the DOM nodes that changed.

The [documentation site](https://pedro-gilmora.github.io/source-crafter-xzor/) is itself an xzor app: see [`docs/site`](docs/site).

---

## Get started in one minute

Run the installer for your platform in an empty folder (or an existing project):

| Platform | Command |
|---|---|
| **Windows** (PowerShell) | `irm https://raw.githubusercontent.com/pedro-gilmora/source-crafter-xzor/main/install.ps1 \| iex` |
| **Linux / macOS** | `curl -fsSL https://raw.githubusercontent.com/pedro-gilmora/source-crafter-xzor/main/install.sh \| bash` |

From a clone of this repo, run `.\install.ps1 my-app` or `bash install.sh my-app` instead. The installer:

1. installs [Bun](https://bun.sh) if you don't have it;
2. adds `@source-crafter/xzor`, `@source-crafter/xzor-runtime` and TypeScript 7 to the project;
3. runs `xzor init`: it creates `package.json`, `tsconfig.json` and `.gitignore`, or adds only what's missing to the ones you already have (scripts, `rootDirs`, `lib`, `include`), plus a starter app if the folder has no `main.ts`. It also installs the **xzor skill** in `.github/skills/xzor/SKILL.md`, so your AI assistant can write xzor from a plain description ("a todo page with a pending counter and an about page") without inventing Blazor APIs;
4. installs the VS Code extension if `code` is on your `PATH` (highlighting, completions, hover, go to definition and live errors).

Then:

```sh
bun run dev        # builds, serves the app (open the printed URL); saving a .xzor updates it in place, keeping state
```

<details>
<summary>Prefer to set it up by hand?</summary>

```sh
bun add -d @source-crafter/xzor typescript@^7
bun add @source-crafter/xzor-runtime
bun x xzor init    # sets up package.json, tsconfig.json and .gitignore
```

**`tsconfig.json`**: what `xzor init` makes sure of. The two `.xzor` entries let TypeScript see the generated code.

```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "ESNext.Disposable", "DOM"],
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "rootDirs": [".", ".xzor"]
  },
  "include": ["**/*.ts", ".xzor/**/*.ts"]
}
```

The extension is the `xzor-<version>.vsix` on the [releases page](../../releases): `code --install-extension xzor-<version>.vsix`.
</details>

---

## Learn it in six steps

Each step builds on the previous one. Every snippet starts with the file it belongs to.

### 1. A component and an app

A component has two parts: **`@code`** holds its state and methods, and **the template** (everything else) is the HTML it renders.

**`Counter.xzor`**

```xzor
@code {
  count = 0;
}

<button @onclick="() => count++">Clicked @count times</button>
@if (count >= 10) {
  <p>That's a lot of clicks!</p>
}
```

**`main.ts`**: the entry point. It says which component to show and where.

```ts
import { type IApplication, Mount } from "@source-crafter/xzor-runtime";
import Counter from "./Counter.xzor";

@Mount(Counter, "app")              // renders into <div id="app">
export class Application implements IApplication {}
```

**`index.html`**

```html
<div id="app"></div>
<script type="module" src="./dist/main.js"></script>
```

That's a working app. A few things to notice:

- `@count` prints a value. Use `@(a + b)` for anything longer than a name or a member chain.
- You write `count`, not `this.count`: names that refer to `@code` members get `this.` added for you.
- `@onclick` gets a typed DOM event and re-renders the component when the handler is done.
- `@if`, `@for`, `@while` and `@switch` are ordinary TypeScript control flow wrapped around markup.

### 2. Components that talk to each other

A field in `@code` is a **prop**: the parent sets it as an attribute.

**`Stepper.xzor`**: a child that reports changes to its parent.

```xzor
@import { type EventCallback } from "@source-crafter/xzor-runtime"

@code {
  value = 0;                                  // set by the parent
  valueChanged?: EventCallback<number>;       // called to tell the parent
}

<button @onclick="() => valueChanged?.(value + 1)">@value</button>
```

**`Counter.xzor`**: the parent.

```xzor
@import Stepper from "./Stepper.xzor"

@code {
  n = 1;
}

<Stepper @bind-value="n" />          @* passes value and listens to valueChanged *@
<input type="number" @bind="n" />    @* stays a number, not a string *@
```

- A capitalized tag is a component. A misspelled prop or a wrong type is a build error.
- In lists, add `@key="item.id"`: rows keep their DOM and state when they reorder.
- Lifecycle methods follow Blazor's order: `onInitialized(Async)`, then `onParametersSet(Async)`, then the render, then `onAfterRender(first)`. `dispose()` runs when the component leaves the page.

### 3. Slots: components that wrap content

**`Card.xzor`**: the component decides *where* the content goes.

```xzor
<section class="card">
  @slot:header { <h3>Untitled</h3> }    @* a named slot, with fallback content *@
  @slot                                 @* the default slot *@
</section>
```

**`Home.xzor`**: the parent decides *what* goes there.

```xzor
<Card>
  @slot header { <em>Today</em> }
  <p>Anything outside a @slot block goes to the default slot.</p>
</Card>
```

A slot can also pass data back: the component writes `@slot:item(item)` and the parent writes `@slot item(x) { <b>@x.name</b> }`, with `x` typed for you.

### 4. Share a value with everything below: cascading values

Use this for things such as the theme or the current user, so you don't have to pass a prop through every level.

**`layouts/Shell.xzor`**, template: provides the value.

```xzor
@cascade:theme(theme) {
  @slot
}
```

**`layouts/MainLayout.xzor`**, `@code`: any component below it, at any depth, receives it.

```xzor
@code {
  @Cascade theme!: string;
}
```

### 5. Pages and routing

Give a component a URL with `@page`. URL parameters fill the props with the same name, converted to the prop's type.

**`pages/UserPage.xzor`**

```xzor
@page "/users/:id"

@code {
  id = 0;           // "/users/42" sets id to the number 42
}

<h2>User @id</h2>
```

Keep all your routes in one file, **`Routes.xzor`**. It decides which layout each page renders in and what to show when nothing matches:

```xzor
@import MainLayout from "./layouts/MainLayout.xzor"

@ClientRoutes(route) {
  @notFound { <p>Nothing at @route.path</p> }
  @catch(error) { <p class="error">This page failed: @(String(error))</p> }
  @default(page) { <MainLayout>@page</MainLayout> }
}
```

**`main.ts`**: mount the routes instead of a single component.

```ts
import { type IApplication, Mount } from "@source-crafter/xzor-runtime";
import Routes from "./Routes.xzor";

@Mount(Routes, "app")
export class Application implements IApplication {}
```

**`layouts/MainLayout.xzor`**: links that know where they point.

```xzor
@import { NavLink } from "@source-crafter/xzor-runtime"
@import { href } from "../routes"

<nav>
  <NavLink href="/" match="exact">Home</NavLink>
  <NavLink href="@href.UserPage({ id: 1 })">User 1</NavLink>   @* id: "1" is a build error *@
</nav>
<main>@slot</main>
```

- `href.UserPage(...)` is generated from your `@page`s, so a link to a route that doesn't exist won't compile.
- `NavLink` adds the `active` class while you're on its page.
- Give some routes a tag (`@page "/admin" as admin`) and wrap them all in another layout with `@admin(page) { <AdminLayout>@page</AdminLayout> }`.

### 6. Services: dependency injection at compile time

Declare your services once.

**`services/data.ts`**

```ts
import { Scoped, ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";

@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)       // Database's constructor asks for an ILogger: it gets one
@Scoped(UnitOfWork)
export class DataServices {}
```

**`main.ts`**: register them with the application.

```ts
@Mount(Routes, "app")
@Import(DataServices)
export class Application implements IApplication {}
```

**`Counter.xzor`**: ask for one with `@inject`.

```xzor
@inject IDatabase db

<small>Connected to @db.name</small>
```

xzor reads your types and generates the plain `new Database(new ConsoleLogger())` code. A missing service, an ambiguous one or a dependency cycle is a build error with a clear message. Async factories, keyed services (`@Singleton("key", factory)`) and disposal (`Symbol.dispose`) work too.

---

## Develop with hot reload, ship an installable app

### Hot reload in `xzor dev`

Save a `.xzor` file and the open page shows the change at once. Only the components you changed are updated in place, and they keep their state (field values, focus, scroll). Any other change reloads the page. A `#private` member, a new import or a changed base class also reload, and arrow-function fields keep their old code until a reload. A failed build keeps the last working page.

### Installable and offline

An app with a `manifest.webmanifest` next to its `index.html` becomes a PWA (an app people can install and open offline) after `xzor build`:

1. Add the manifest, a 192x192 and a 512x512 icon, and `<link rel="manifest" href="manifest.webmanifest">` in `index.html`.
2. Run `xzor build`. It writes `sw.js` beside `index.html` and registers it from the bundle. `xzor init` puts `sw.js` in `.gitignore`; deploy it with the app.
3. Offline, a page load falls back to the cached app. After you deploy a new version, it shows up on the second load (the first one fetches it in the background).

```json
{
  "name": "My app",
  "short_name": "App",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#0b0e1a",
  "theme_color": "#0b0e1a",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

The build warns (never fails) when the manifest is not valid JSON, has no `name` or `short_name`, no `display`, a missing icon file or no 192/512 icon. Nothing is cached in `xzor dev`. Without a manifest, the build is the same as before.

---

## Trackable models

A model is a class that knows what changed in it. Extend `Model` and write plain fields. The build makes each field watch itself.

**`models/worker.ts`**

```ts
import { Model, Persist, Validate, maxValue, minValue, required } from "@source-crafter/xzor-runtime/model";

export class Worker extends Model {
  @Validate(required) name = "";
  @Validate(minValue(0), maxValue(24)) hours = 0;
  @Persist get payment() { return this.hours * 20; }    // sent to the server with the fields
}
```

```ts
const ada = new Worker({ name: "Ada", hours: 8 });   // built from server data: Unchanged
ada.hours = 10;
ada.state;          // State.Modified
ada.changes;        // { state: 16, name: "Ada", hours: 10, payment: 200 }
ada.revertChanges();  // back to 8; or ada.confirmChanges() after saving
```

- **Components update by themselves.** A component that reads `ada.hours` while it renders draws again when that value changes, from anywhere: a service, a timer or another component. Several changes in a row draw once.
- **Checks.** `@Validate(...)` fields fill `errors` (messages per field) and `hasErrors`. `hasValidChanges` tells you when it is safe to save.
- **Lists.** `EntitySet.track(Worker, items)` is an array of models. `delete(item)`, `view` (without deleted ones), `changes`, `hasErrors`, `revertChanges()` and `confirmChanges()` work on the whole list.
- **Limits.** The class must extend `Model` directly. `set[i] = x` is not noticed (use `push`, `splice`, ...). Add `"ESNext.Decorators"` to `lib` in `tsconfig.json`.

See [`examples/counter/pages/Team.xzor`](examples/counter/pages/Team.xzor).

---

## See it all together

[`examples/counter`](examples/counter) is a small app that uses every feature above: `Routes.xzor`, layouts, an admin area, typed links, an error page, async settings, scoped services and a team page with trackable models. Build it with `cargo run -- build examples/counter`.

When you need the details, see the full reference: [docs/design.md](docs/design.md).

## How it works

```
Counter.xzor ──xzor──▶ .xzor/Counter.xzor.ts ──tsc──▶ type errors ──Bun──▶ dist/main.js
```

| Piece | Job |
|---|---|
| `src/parser.rs` | Reads `.xzor` into a syntax tree that remembers source positions |
| `src/codegen.rs` | Writes the TypeScript class (`buildRenderTree`), with source maps back to your file |
| `src/build.rs` | Writes `.xzor/` (components, route table, DI), runs `tsc`, then bundles with Bun |
| `src/di.ts` | Reads your services with TypeScript's API and generates the code that creates them |
| `runtime/index.ts` | The render tree, the diff, components, the router and the DI types |
| `src/lsp/` | The language server behind the VS Code extension |

The rules the project follows:
- **Work at build time, not at runtime.**
- **Allocate no more than hand-written code would.**
- **No Rust dependencies.**

## Contributing

```sh
cargo test                 # compiler tests
bun test                   # runtime, build, DI and language server tests
bun run test:grammar       # VS Code syntax highlighting tests
./Package.ps1 -test true   # build, test and pack everything into publish/
bun run docs               # build the documentation site into docs/site/_site
```

**Releasing:** push to `main` with a commit message that starts with `[Release]`. CI then builds the binaries for Windows, Linux and macOS, runs every test, publishes to npm with the next version (`0.1.0`, `0.1.1`, …), and attaches the `.vsix`, the binaries and the npm tarballs to a GitHub release.
