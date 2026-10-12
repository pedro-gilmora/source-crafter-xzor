# Task 1 report: runtime decorators, `IApplication`, app-aware `mount`

Commit: 588fcfa `feat(runtime): app-aware mount and DI decorators`

## Implemented (`runtime/index.ts`)

- Exports: `ServiceProvider`, `Mount`, `Import`, `Singleton`, `Scoped`, `Transient` (overloaded, one shared `noop`), `SharedInstance` (unique symbol), `IApplication`.
- `Ctor<C>` is now `new (...args: any[]) => C`. `static inject` is read with a cast in `construct()`.
- `Mounted` gained `app?: IApplication` and `latest?: VComponent`. `VComponent` gained `pending?: Promise<ComponentBase>`. No new maps.
- `construct(type, app)`: `app.createComponent?.(type) ?? (inject?.length ? throw : new type())`. Error: `zor: Needs needs injected services (dep) but has no application`.
- `create()` uses the owner's app (`mountedComponents.get(owner)?.app`), so nested components and slot fills are built through the app. The app is passed down by `mountComponent(component, app, into?)`.
- Async component: `create()` leaves a placeholder `Mounted` (empty tree, anchor comment, `latest = v`). On fulfilment, `arrive()` mounts it before the anchor inside `batch` (lifecycle and after-render run normally). If `latest` was cleared by `dispose(v)`, it calls `disposeInstance` and inserts nothing. A rejection clears `latest` and rethrows with `queueMicrotask`.
- `patch()` of a still-pending component re-points `mounted.latest` to the newest vnode, so the instance gets the latest props and later patches see its `instance`.
- `disposeInstance`: `dispose()` hook, then `[Symbol.dispose]?.()`, then `[Symbol.asyncDispose]?.()`. The symbols are read through a small cast with a `Symbol.for` fallback, because the examples' ES2022 lib has no `Symbol.dispose` typing.
- `mount(type, target: string | Element, app?)`: an id or a selector (`#`, `.` or `[` means selector), otherwise `getElementById`; a missing target throws `zor: mount target "<t>" not found`. It runs `app.onStarted()` after the first render. A root that resolves to a promise throws `zor: root component X cannot be asynchronous` (my addition; the brief does not cover it).

## Tests (`runtime/di.test.ts`, 12 tests)

The 9 from the brief, plus: missing mount target, rejected async component (captures the microtask throw by wrapping `queueMicrotask`), and an async component that arrives after a parent re-render and gets the latest props and its first-render lifecycle.
Tests compare markup with the empty anchor comments stripped (`html()` helper), since components always keep an anchor.

## TDD evidence

- RED: `bun test runtime/di.test.ts` gave `SyntaxError: Export named 'Import' not found in module 'D:\Code\rs-zor\runtime\index.ts'`, 0 pass, 1 fail. Expected: the exports did not exist.
- Intermediate failures after implementing came from the tests themselves: comment anchors in `innerHTML`, `createComponent` also being asked about the root, and `process.once("uncaughtException")` not firing under bun test. I fixed the tests, not the behavior.
- GREEN: `bun test runtime/di.test.ts` gave 12 pass, 0 fail.
- Full: `bun test` gave 45 pass, 0 fail (includes `tests/lsp.test.ts`).
- `bun x tsc --noEmit -p examples/counter` exited 0. The `.zor` files were already present.

## Files changed

- `runtime/index.ts`
- `runtime/di.test.ts` (new)

## Self-review

- The diff is limited to the brief. Existing `mount(type, Element)` callers are unchanged, and the existing tests are unchanged and pass.
- The hot path (`create`) allocates nothing new for sync components. `construct` is one call plus an optional-chain; the `inject` lookup only happens when the app declines.
- Pending components cost one placeholder `Mounted` and one promise reference, and no maps or closures beyond the two `then` callbacks.

## Concerns

- `bun test` prints a Rust warning during `tests/lsp.test.ts` (`error finalizing incremental compilation session directory ... Acceso denegado (os error 5)`). It comes from the Windows cargo incremental dir while the LSP is built; it was there before my change and tests pass, but the output is not strictly pristine.
- Root `mount` rejects async roots; later tasks' generated `@Mount` code should not rely on an async root.
- `onStarted` and `[Symbol.asyncDispose]` promise rejections are not handled (`void`).

## Fix round 1

Changes in `runtime/index.ts` (items from the review):

1. `VComponent.pending` deleted, with all assignments (`create`, `arrive`, `patch`).
2. Both promise handlers capture only `mounted`. The rejection handler clears `mounted.latest` and calls `rethrow`; it no longer captures `v` or touches a vnode.
3. `Mounted` is always `{ tree, anchor, app, latest: undefined }` (one shape; `app` and `latest` are now required properties). `mountComponent` re-stores `tree`/`app` only in the `into` branch.
4. `create`/`patch`/`patchList`/`patchKeyed` take `app` next to `owner`; `mountComponent` and `update` (via `m.app`) pass it. The `mountedComponents.get(owner)?.app` lookup is gone.
5. `arrive` reads `latest` and `anchor.parentNode` first and clears `latest`. If the vnode is gone or the anchor has no parent, it disposes the instance. Otherwise `applyProps`, `ref`, `mountComponent` and the insertion run in `batch` inside `try`; `v.instance` is set at the end of the batch, before the after-render callbacks. On a throw it deletes the `mountedComponents` entry (if `v.instance` was not set yet) and calls `rethrow`; the placeholder stays empty, like a rejected component.
6. `surface(result)` does `result.catch(rethrow)` only when `result instanceof Promise`; used for `onStarted` and `[Symbol.asyncDispose]`. `rethrow` (microtask throw) is shared with the component rejection path.
7. `SELECTOR` is a module-level constant.

Tests added in `runtime/di.test.ts` (now 19 tests):

- Item 8a: `pending component inside a removed ancestor is disposed once and nothing is inserted`.
- Item 8b: `pending component moved by a keyed diff arrives in its new position` (expects `<i>x</i><b>late</b>`).
- Item 8c: `[Symbol.asyncDispose] runs once for a component removed before arrival`.
- Item 8d: `a component arriving after its anchor was detached is disposed` (second `mount` into the same host).
- Item 5: `a component that throws while mounting on arrival surfaces the error and leaves its place empty`.
- Item 6: `a rejected onStarted surfaces the error` and `a rejected [Symbol.asyncDispose] surfaces the error`.
- Helper `thrownFrom` captures the microtask throws.

Commands:

- `bun test runtime/`: 36 pass, 0 fail.
- `bun test`: 52 pass, 0 fail.
- `bun x tsc --noEmit -p examples/counter`: exit 0.

## Fix round 2

Changes in `runtime/index.ts`:

1. `arrive` catch: after the existing cleanup it sets `mounted.tree = []` and disposes the partial tree (`partial.forEach(dispose)`), so the placeholder never keeps nodes that were not inserted. The error is still rethrown via `rethrow`.
2. `dispose`: a child VComponent without `instance` no longer assumes `mounted` (`if (v.mounted) v.mounted.latest = undefined`).
3. Removed the dead `into.app = app` in `mountComponent` (`arrive` always passes `mounted.app`).

Tests (`runtime/di.test.ts`, now 20 tests): `an arriving component whose child throws can be removed and disposes the children built before the throw`. The async parent has a sound child and a child whose `onInitialized` throws. It checks that the error surfaces through the microtask, the sound child is disposed, the placeholder stays empty, and removing it does not throw. Added a trailing newline to the file.

RED: without the `index.ts` change the new test fails (`expect(...).toEqual`), the others pass.

Commands:

- `bun test runtime/`: 37 pass, 0 fail.
- `bun test`: 53 pass, 0 fail.
- `bun x tsc --noEmit -p examples/counter`: exit 0.
