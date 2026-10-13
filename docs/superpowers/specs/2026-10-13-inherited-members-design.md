# Inherited members in templates, and tsc mapping with relative build dirs

Agreed in chat on 2026-10-13.

## 1. Inherited members

`@inherits Base` makes Base's instance members usable in the template and in `@code` expressions as bare names. `@title` becomes `this.title` and `@describe()` becomes `this.describe()`, as Razor does by C# scoping.

**How:** codegen reads the base class from its source, the same way it reads imported components' props.
- The base name is the leading identifier of the `@inherits` value (`Titled<T>` gives `Titled`). It is resolved through the component's `@import` lines: default, named, `X as Y` and `type`-only imports all count.
- The specifier is relative (`./`, `../`). It is tried as written, then with `.ts`, `.tsx`, `/index.ts`.
  - A `.tszor` base contributes its `@code` members and its own `@inherits` chain.
  - A `.ts` base: find `class <OriginalName>` (exported or not), take its body by brace matching (skipping strings and comments), and collect members with `member_decls`. Static members are excluded. Constructor parameter properties (`constructor(readonly x: T)`) count. Then follow its `extends <Name>` through that file's own imports, or the same file. The chain is limited to depth 8 and stops at `ComponentBase`.
- Unresolvable bases (packages, re-exports, aliases through `export *`) contribute nothing. The user writes `this.x`, and TypeScript's error already says so.
- Locals still shadow members. Own `@code` members win; there is no conflict either way.
- Zero runtime cost: only the `this.` rewrite changes.

**Invalidation:**
- **`--watch`:** `dependents` also recompiles a `.tszor` whose text mentions the stem of a changed `.ts` file (for example `"./base"`) and that uses `@inherits`.
- **LSP:** when a `.ts` or `.tszor` changes (didChange, didSave or a watched file), open `.tszor` documents that use `@inherits` and mention its stem recompile and refresh their diagnostics.

## 2. tsc error mapping with a relative build dir

`zor build target/x` printed `.zor/Bad.tszor.ts(5,22)` because `map_tsc_line` compared tsc's absolute path with a relative `Compiled.out`. Both are made absolute against `cwd` before comparing.
