# Roadmap 3: type inference, DI diagnostics everywhere, event-driven watch

Agreed in chat on 2026-10-13. It builds on [2026-10-12-di-bootstrap-design.md](2026-10-12-di-bootstrap-design.md). The repo premise holds: memory and performance first.

## 1. `@typeparam` inference from props

`<Grid Items="@users">` infers `T` from the props, as Blazor does. Today `addComponent(Grid, props)` infers the component type from the class, so `T` becomes `unknown`.

The task starts with a spike of two options:
- (a) a runtime `addComponent` signature that lets TypeScript infer `T` from the props;
- (b) Blazor-style: each generic component gets a type-only static (for example `Grid.$infer(props)`) that codegen calls at the use site.

Either must be erased at compile time or cost nothing at runtime. Choose the one TypeScript 7 handles, and record the choice in this spec. Explicit type arguments (`<Grid T="User">`, if the syntax exists) keep working.

## 2. Keyed dependency type check: ZDI12

When a parameter or `@inject` resolves by key (its name equals a registered key), the keyed service type must be assignable to the parameter type. The analyzer checks this with the checker's `isTypeAssignableTo`. A mismatch is **ZDI12**: `<param>: key "<key>" provides <Service>, which is not assignable to <ParamType>`. It is reported at the parameter (or the `@inject`).

## 3. Optional `dispose?()`

A service type that declares `dispose?()`, `[Symbol.dispose]?()` or `[Symbol.asyncDispose]?()` is disposable "maybe". Typically this is an interface returned by a keyed factory. The generated release is `d0?.dispose?.()`, or the symbol equivalents. It adds one check on the disposal path only.

## 4. Directive comments

Every directive line (`@inject`, `@inherits`, `@implements`, `@typeparam`, `@attribute`, `@import`, `@page`) accepts a trailing `// …` or `@* … *@`. The comment is not part of the directive value. The grammar highlights it as a comment.

## 5. DI diagnostics where they are defined or referenced, live

- **Where:**
  - The `.ts` registration decorators get ZDI01/03/05/06/07/11/12.
  - Constructor and factory parameters get ZDI02/05/12: the analyzer reports each parameter's file and offset.
  - `.tszor` `@inject` lines get ZDI04/05/12.
- **Client:** the VS Code client also opens `.ts` files (`documentSelector` adds `typescript`). The server keeps their text but offers no features for them besides DI diagnostics.
- **Live ranges:** on every `didChange`, the server shifts the published DI ranges of that document by the edit, at once and without reanalysis. Ranges that fall inside an edited span are dropped until the next analysis.
- **Live reanalysis:** 300 ms after the last change, the server reruns the analysis with the unsaved text of open documents as overlays, through the persistent analyzer.

## 6. Persistent analyzer

- `di.ts --serve` keeps one TypeScript 7 API session alive.
- It reads one JSON request per stdin line, `{ root, files, components, overlays: { [path]: text } }`, and writes one Facts JSON per stdout line. Each request calls `updateSnapshot` with the changed files and overlays, and nothing else.
- Rust keeps one child process per project root, through an `Analyzer` handle, and restarts it if it dies.
- `zor build` uses one request. `--watch` and the LSP reuse the process.

## 7. Event-driven, incremental `--watch`

- **Watcher:** `src/watch.ts` (Bun) runs `fs.watch(root, { recursive: true })` and prints one changed path per line. This needs no Rust crates.
- **Batching:** Rust batches events for 50 ms and ignores `.zor/`, `dist/`, `node_modules/` and dot-dirs. That covers external and internal edits without looping on our own writes.
- **Per batch:**
  - only the changed `.tszor` files recompile;
  - DI reruns only if a provider `.ts` changed, a `.tszor`'s `@inject` set changed, or a `.tszor` was added or removed;
  - the type check and the bundle always run.

## 8. `.zor` cleanup

After pruning stale generated files, empty directories under `.zor/` are removed bottom-up.

## Diagnostics added

| Id | Error |
|---|---|
| ZDI12 | A key matched by parameter name provides a type that is not assignable to the parameter. |
