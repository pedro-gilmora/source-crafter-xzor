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
| `@switch (v) { case a: case b: ... break; default: ... }` | Each case is block-scoped and always ends in `break` (no fall-through into a body). Stacked labels share one body. `break;` is optional. |
| `@@`, `a@b.com` | Literal `@` |
| `attr="text @expr"`, `attr="@expr"` | Interpolated and typed attribute values (`false`/`null` removes the attribute) |
| `@onclick="handler"`, `@onclick="() => ..."` | DOM event; typed through `HTMLElementEventMap`; triggers a re-render |
| `<Child prop="x" n="5" />` | Component (capitalized tag); props are type-checked as `Partial<Child>`. As in Blazor, a prop declared with a non-string type (`n: number`, `on: () => void`, or inferred from a non-string initializer) takes its value as a TypeScript expression. String props take text. |

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

## Rendering

- An event re-renders only the component that owns the handler. `stateHasChanged()` does the same for any component.
- The new render tree is diffed against the previous one by position, and only changed text, attributes, handlers and nodes are touched. DOM nodes keep their identity, so focus and input state survive.
- Each `@if`, `@for` and `@switch` produces a region, marked by a comment anchor. Its variable output is diffed in isolation, so it never shifts static siblings.
- A child component re-renders only if a prop changed (`Object.is`). Object props always count as changed, as in Blazor.

## Roadmap

1. Rename and find references, through the same mappings.
2. `@key` for loop items (today items are matched by index).
3. Child content and `@bind`, plus component events (`EventCallback`).
4. Lifecycle hooks (`onInitialized`, `onParametersSet`, async).
5. TextMate grammar and LSP semantic tokens from the parser's token spans.
6. Watch mode and incremental compilation.
