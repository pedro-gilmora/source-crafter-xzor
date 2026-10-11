# zor language server: design

Approved in chat on 2026-10-11.

## Intent

Give `.tszor` authors IntelliSense, go-to-definition and diagnostics in any LSP editor (VS Code first, Visual Studio later). zor answers component questions itself. Everything inside TypeScript regions is answered by TypeScript 7.

## Decisions (from the conversation)

- A standalone LSP: `zor lsp` in the Rust binary, speaking JSON-RPC over stdio. No new crates. JSON and framing are hand-written.
- The TypeScript engine is TypeScript 7's native server (`tsc --lsp --stdio`, found under `node_modules/@typescript/typescript-<platform>/lib/`). zor proxies to it.
- Generated TypeScript is an internal step, like Blazor's `obj/`. It lives in `<project>/.zor/<relative path>.tszor.ts` and no longer sits next to the sources. The project is the nearest directory with a `tsconfig.json`.
- The type checker is TypeScript 7. Run `bun x tsc` when Bun is on PATH, otherwise `npx tsc`. `--checker` overrides. (The `bun-check` npm package is a runtime version guard, not a type checker.)

## Constraints found in the spike

- tsgo resolves imports only against files on disk. So the server writes `.zor/*.tszor.ts` for every `.tszor` in the workspace at startup and on save. Live edits are sent as open-document content, which wins over disk.
- `tsconfig.json` must include `.zor/**/*.ts` explicitly (dot-folders are skipped by `**`), and declare `"rootDirs": [".", ".zor"]` so `./X.tszor` resolves from both sides.
- tsgo uses pull diagnostics (`textDocument/diagnostic`).

## Features

| Request | Inside a TS region (code block, `@expr`, `@( )`, conditions, handlers, attribute expressions) | Elsewhere (markup) |
|---|---|---|
| completion | Forwarded to tsgo, with edit ranges mapped back. After `@ident`, zor keywords are added. | `<` gives components (imported, plus project `.tszor` files, with an auto `@import`). Inside a component tag, its props. `@on` gives DOM event names. `@` gives the zor keywords. |
| hover | Forwarded | Component tag shows the component and its source path. Prop shows its declaration line. |
| definition | Forwarded; locations in `.zor` files are mapped back to their `.tszor` | Component tag jumps to its `.tszor` file. Prop jumps to its member in `@code`. |
| diagnostics | tsgo diagnostics on the generated file, mapped back. Unmappable ones attach to the nearest preceding mapped position. | zor parse errors |

## Source mapping

Codegen emits `Mapping { src, gen, len }` segments for every run of characters copied verbatim from the source: code block lines, expressions (split around inserted `this.`), conditions, loop heads, case labels, imports, component and prop names. Invariant: `gen_text[gen..gen+len] == src_text[src..src+len]`.

## Non-goals (v1)

Rename, references across files, formatting, semantic tokens, and HTML element or attribute completion.
