# Application bootstrap and dependency injection: design

Agreed in chat on 2026-10-12. Modeled on SourceCrafter.DependencyInjection (compile-time generated containers). Its "partials" features are out of scope.

## Intent

Replace the bare `mount(App, host)` with a declared application class that also acts as the dependency injection root. zor resolves the whole service graph at compile time and emits plain code: no reflection, no runtime container lookups, and no locks (JavaScript runs on a single thread). Like the rest of the repo, generated code and the runtime are memory- and performance-first: no allocation beyond what hand-written code would need.

## Decisions (from the conversation)

- **Decorators are PascalCase** and come from `@zor/runtime`: `@ServiceProvider`, `@Mount`, `@Import`, `@Singleton`, `@Scoped`, `@Transient`. At runtime they do nothing. They exist for typing and as compile-time markers.
- **`@ServiceProvider()`** declares a reusable provider in any `.ts` file. zor generates an implementation class for it.
- **The application is a class implementing `IApplication`, decorated with `@Mount(App, "app")`** plus the registration decorators. Compiling the entry module turns it into a call to `mount` with an instance of the generated subclass. The user no longer calls `mount` by hand.
- **Component injection uses `@inject Type name`** in a `.tszor`. It becomes a constructor parameter of the generated component class, plus a dedicated field with the same name and type that receives the injected instance. Arguments are resolved at compile time from the application's provider.
- **Imports use a shared default instance.** `@Import(DataServices)` makes the importer delegate to `DataServices[SharedInstance]`: a static getter keyed by a symbol from `@zor/runtime`, which caches the provider's default instance. zor still knows the imported services and their types at compile time.
- **Imported providers must be self-sufficient.** The shared instance is built by `new DataServices$()`, without the importer. A provider's services may depend only on what that provider registers or imports. Anything else is a compile-time error.
- **Caching is `this.#field ??= <build expression>`.** No locks. Async services cache the promise (`#getDatabaseAsync$Promise ??= this.#createDatabase()`), so concurrent awaits share one creation.
- **Disposal follows SourceCrafter:** `dispose()` (plus `[Symbol.dispose]`, or `[Symbol.asyncDispose]` with an async `disposeAsync()` when any disposable service or async factory requires awaiting) is generated only for `@ServiceProvider` classes that register disposable services.
  - A root provider releases everything resolved: the singletons first (reverse creation order), then its own scoped services, in the same order as SourceCrafter.
  - A scope from `createScope()` overrides this and releases only its own scoped services, never the singletons.
  - Singletons are `static`, so disposing any root releases them for every instance. Avoiding that collision is the app developer's job.
  - `dispose()` is idempotent (`#disposed` guard). Each disposer clears the field before releasing it.
  - Transients are never tracked; the caller owns them.
  - Disposing the shared provider also clears its cached `SharedInstance`.
  - Application bootstrappers (`@Mount`) get no `dispose` for now.
- **Analysis** uses TypeScript 7's checker (`typescript/unstable/sync`), driven from a Bun script like `src/bundle.ts`. Rust validates the graph and emits the code. Generated code is TypeScript in `.zor/`, so `tsc` checks it too, and it is bundled to JavaScript.

## Authoring

```ts
// services/data.ts
@ServiceProvider()
@Singleton<ILogger>(ConsoleLogger)
@Singleton<IDatabase>(Database)            // Database(log: ILogger)
@Scoped(UnitOfWork)
export class DataServices {}

// main.ts (the bundle entry)
@Mount(App, "app")
@Import(DataServices)
@Singleton(AuthService)                    // AuthService(db: IDatabase)
@Transient(Clock)
@Singleton("requestId", Factories.newRequestId)
export class Application implements IApplication {}

export class Factories {
  static newRequestId(): string { return crypto.randomUUID(); }
}
```

```tszor
@* Counter.tszor *@
@inject IDatabase db
@inject AuthService auth
<p>@db.name</p>
```

## Registration decorators

| Form | Meaning |
|---|---|
| `@Singleton(Impl)` / `@Singleton<IService>(Impl)` | One instance per generated provider class, stored in a `static` field as in SourceCrafter. Every instance and scope shares it. The type argument is the service type. TypeScript checks that `Impl` is assignable to it, because the decorator is typed `Singleton<T>(impl: new (...a: any[]) => T)`. |
| `@Scoped(...)` | One instance per scope, cached in the scope where it is resolved. |
| `@Transient(...)` | A new instance on every resolution. A transient with no dependencies gets no generated member: it is inlined as `new Impl()` at each use site. A transient with dependencies gets a getter that builds a new instance on every access. |
| `@Singleton("key", Owner.factory)` | Keyed service built by a static factory of another class. A class cannot reference itself in its own decorator arguments (TS2449). It is resolved by parameter name (`requestId: string`) before falling back to the type. Factory parameters are resolved like constructor parameters. A `Promise<T>` return makes the service async. |

Constructor selection: the class's single constructor. Parameters are resolved by key (the parameter name matches a registered key), then by type. A parameter with a default value or `?` is optional, and gets `undefined` when nothing is registered.

Async services, as in SourceCrafter: a service is async when its factory returns `Promise<T>`, or when any dependency it awaits is async. Async-ness spreads up the graph automatically.
- An async service is resolved by a method `getXAsync(): Promise<T>`, with two flat fields, the value `#x` and the promise `#x$Promise` (both `static` for singletons). No getter is emitted for it, and there are no holder objects.
- The first call checks the dependencies' value fields. If all are set, it builds synchronously and caches `Promise.resolve(instance)`. Otherwise it caches `this.#createX()`, a private `async` method that starts every pending dependency before its first `await`. Later calls return the cached promise and allocate nothing:

```ts
getAuthServiceAsync(): Promise<AuthService> {
  if (this.#authService$Promise) return this.#authService$Promise;
  const v0 = this.tryGetDatabase();
  return (this.#authService$Promise = v0 !== undefined
    ? Promise.resolve((this.#authService = new AuthService(this.clock, v0)))
    : this.#authService$create());
}
async #authService$create(): Promise<AuthService> {
  const p0 = this.getDatabaseAsync();
  return (this.#authService = new AuthService(this.clock, await p0));
}
```

- A cached (singleton or scoped) dependency already resolved inside another awaited dependency's subtree is read from its value field, not awaited again, as in SourceCrafter. Transients are always awaited.
- A rejected promise stays cached, as in SourceCrafter.
- A parameter typed `Promise<T>` receives the promise itself, unawaited. It does not make its dependent async.
- Components are resolved like any other dependency (as transients). A component with an `@inject` of an async service (typed `T`) is resolved asynchronously: `createComponent` returns a `Promise`, and the runtime keeps the component's place empty until the promise settles. If the place is removed first, the component is disposed as soon as it arrives.
- Settled-state fast path, with no extra allocations: the value field set by `#createX()` (or by the synchronous path) is exposed through a public `tryGetX(): T | undefined`. For a component whose dependencies all have values, `createComponent` returns the instance itself, which avoids an empty first render. `Bun.peek` cannot help: it reads JavaScriptCore's internal promise state through a private intrinsic, and browsers cannot polyfill it.
- Disposal awaits a cached promise before releasing its value. A rejected promise is skipped, not rethrown. A provider that holds any async disposable gets `disposeAsync()`/`[Symbol.asyncDispose]`.

## Scopes

- Every provider instance is a scope, the root included. As in SourceCrafter, the generated provider has `root` (itself, or the root it was created from) and `createScope()`, which returns a new instance pointing to the same root (`createScope()` on a scope also uses the root, not the scope). The new scope:
  - shares the singletons, which are `static`;
  - starts with an empty scoped cache;
  - creates transients on every resolution, as everywhere.
- A scoped service is cached in the scope that resolves it. An application that imports a provider is itself the scope for that provider's scoped services: it caches them in its own fields and builds them with the imported provider's singletons (taken from `SharedInstance`) and its scoped services (resolved in the same application scope).
- A singleton of an imported provider is read through `DataServices[SharedInstance]`. Because it is `static`, it is shared by every application and every `DataServices$` instance in the bundle.

## Generated code

Example: `.zor/services/data.provider.ts`:

```ts
import { SharedInstance } from "@zor/runtime";
import { DataServices } from "../../services/data";

export class DataServices$ extends DataServices implements Disposable {
  static #shared?: DataServices$;
  static get [SharedInstance](): DataServices$ { return (DataServices$.#shared ??= new DataServices$()); }

  #root?: DataServices$;
  get root(): DataServices$ { return this.#root ?? this; }
  createScope(): DataServices$ { const scope = new DataServices$(); scope.#root = this.root; return scope; }

  static #logger?: ConsoleLogger;
  get logger(): ILogger { return (DataServices$.#logger ??= new ConsoleLogger()); }
  static #database?: Database;
  get database(): IDatabase { return (DataServices$.#database ??= new Database(this.logger)); }
  #unitOfWork?: UnitOfWork;
  get unitOfWork(): UnitOfWork { return (this.#unitOfWork ??= new UnitOfWork(this.database)); }

  #disposed = false;
  [Symbol.dispose](): void { this.dispose(); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (!this.#root) {                                        // a scope never releases the singletons
      const database = DataServices$.#database; DataServices$.#database = undefined; database?.dispose();
      if (DataServices$.#shared === this) DataServices$.#shared = undefined;
    }
    this.#disposeScoped();
  }
  #disposeScoped(): void {
    const unitOfWork = this.#unitOfWork; this.#unitOfWork = undefined; unitOfWork?.dispose();
  }
}
```

Here `UnitOfWork` and `Database` are disposable and `ConsoleLogger` is not.

`.zor/main.ts` becomes the bundle entry. It contains the generated application class and the mount call:

```ts
import { mount, SharedInstance } from "@zor/runtime";
import { Application } from "../main";
import { DataServices$ } from "./services/data.provider";
import App from "../App.tszor";
import Counter from "../Counter.tszor";

class Application$ extends Application {
  get database(): IDatabase { return DataServices$[SharedInstance].database; }   // imported singleton: delegated
  #unitOfWork?: UnitOfWork;                                                         // imported scoped: cached in this scope
  get unitOfWork(): UnitOfWork { return (this.#unitOfWork ??= new UnitOfWork(this.database)); }
  #auth?: AuthService;
  get authService(): AuthService { return (this.#auth ??= new AuthService(this.database)); }
  /** Components with `@inject` are built here; others use `new type()`. */
  createComponent(type: unknown) {
    if (type === Counter) return new Counter(this.database, this.authService);
    return undefined;
  }
}

mount(App, "app", new Application$());
```

Getter names are the camelCased service type name without a leading `I` (`IDatabase` gives `database`), or the key for keyed services.

Generated component (from `@inject IDatabase db`):

```ts
export default class Counter extends ComponentBase {
  readonly db: IDatabase;
  constructor(db: IDatabase, auth: AuthService) { super(); this.db = db; this.auth = auth; }
}
```

## Runtime changes (`@zor/runtime`)

- The decorators listed above, as typed no-op functions. Also `SharedInstance` (a `unique symbol`), and `IApplication` with optional hooks (`onStarted?(): void | Promise<void>`).
- `mount(type, target, app?)`. `target` is an element id, or a CSS selector if it contains `#`, `.` or `[`. When the runtime creates a component whose class has a non-empty `static inject`, it calls `app.createComponent(type)`; other components are built with `new type()`. The result may be a `Promise`, as described in the async section. The application travels down the tree with each mounted component. A component with `@inject` mounted without an application throws an error naming the missing services.
- When a component leaves the tree, the runtime calls its `dispose()` hook, then `[Symbol.dispose]()` or `[Symbol.asyncDispose]()` when the component implements `Disposable` or `AsyncDisposable`.
- The application is stored on each component's existing mount record, and a pending component promise is stored on its existing `VComponent`. No new maps or wrapper objects.

## Pipeline

1. **Finding classes.** `zor build` (and the language server on save) finds `.ts` files in the project that use `@ServiceProvider` or `@Mount`, by a text scan, then runs the analyzer (`src/di.ts`, Bun with `typescript/unstable/sync`). For each decorated class it returns JSON describing:
   - registrations: lifetime, service type, implementation, key, factory
   - each implementation's constructor parameters and each factory's parameters: name, optionality, resolved type identity and printed text
   - disposability: `dispose()`, `[Symbol.dispose]` or `[Symbol.asyncDispose]`
   - the async-ness of factories
   - `@Import` targets
   - each `@inject` component's constructor parameters, read from the generated `.zor` component
2. **Building the graph.** Rust builds the graph per provider, validates it and emits the files above. Errors carry `.ts`/`.tszor` positions.
3. **Bundling.** `src/bundle.ts` uses `.zor/<entry>.ts` as the entry when the entry module declares `@Mount`.

## Diagnostics

| Id | Error |
|---|---|
| ZDI01 | Service registered twice in one provider (two imports registering the same type count too). |
| ZDI02 | Unresolved dependency: `X` (needed by `Y` in provider `P`) is not registered or imported by `P`. This covers self-sufficiency. |
| ZDI03 | Dependency cycle `A -> B -> A`. |
| ZDI04 | A `@inject` type in a component is not provided by the application. |
| ZDI05 | Ambiguous: two registrations satisfy one unkeyed parameter. |
| ZDI06 | Interface-only registration without an implementation or factory. |
| ZDI07 | `@Mount` on more than one class in a bundle entry, or on a class not implementing `IApplication`. |
| ZDI08 | A user constructor in a `@code` block that also uses `@inject`. |
| ZDI10 | Captive dependency: a singleton depends on a scoped service, directly or through transients. |

## My calls (review these)

- **Type identity:** service types are matched by the symbol the checker resolves (declaration plus export), not by name text. Aliases and `import { IDatabase as Db }` resolve to the same service.
- **Analyzer process:** Rust runs `bun src/di.ts <project>`, the way it runs `src/bundle.ts`. The script prints one JSON document on stdout, and errors carry file offsets that Rust maps to positions.
- **`@inject` resolution:** same rules as constructor parameters. A key equal to the field name wins (`@inject string requestId`), then the type.
- **Component dispatch:** `createComponent` receives the component class itself (the value `addComponent` already gets) and compares by identity.
- **Singleton lifetime:** as in SourceCrafter, singletons are `static` fields of the generated provider, shared by every instance. Disposing any root releases them for all; collisions are the app developer's design concern.
- Getter naming as described above. Getters are public, so the provider is usable from plain TypeScript (`DataServices$[SharedInstance].database`). Private members derive from the getter: `#x`, `#x$Promise` and `#x$create`.
- Factories must be public static methods, and service types must not be generic. The analyzer reports both.
- Component construction is centralized in `Application$.createComponent`. Components never import the application.
- Language server, v1: `@inject` errors appear in `.tszor` files. Provider graph errors in `.ts` files appear in `zor build` output and on save, but not as live editor squiggles.

## Non-goals (v1)

- Application disposal and page lifecycle (`pagehide`, bfcache).
- Collections (`T[]` of all registrations), open generics and generic factories.
- `GetRequiredService<T>()`-style runtime lookup.
- JSON settings and environment names.
- Locks.
