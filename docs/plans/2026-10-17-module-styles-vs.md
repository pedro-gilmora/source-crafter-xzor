# @module, scoped styles and Visual Studio 2026 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends with a perf pass (`.github/agents/perf.agent.md`).

**Goal:** three additions: a `@module { }` block for module-level code (including markup values) outside the component class; scoped, reactive component styles (`<style>` in the `.xzor` or a sibling `X.css.xzor`, exclusive); and a Visual Studio 2026 extension on the same language server.

**Architecture:**
- `@module` is parsed like `@code` (TypeScript plus markup as values) and emitted at the top level of the generated file, after the imports and before the class, with no `this.` rewriting.
- Styles are lowered to plain attributes on the component's root elements, so the existing fine and render-pass attribute paths do the binding with no new runtime path:
  - every root element gets a static `data-xz="<id>"`; the CSS is wrapped in `@scope ([data-xz="<id>"]) to (:scope [data-xz] > *)`, so it reaches the component's own markup and the roots of its child components, not their insides (`<style global>` or `@global` skips the wrapper);
  - a declaration whose value holds `@expr` becomes `prop: var(--<id>-<n>)`, and the roots get an attribute `--<id>-<n>` whose value is the interpolated text; attributes whose name starts with `--` are written with `style.setProperty` in both renderers. One custom property per declaration: an update touches one property;
  - `@if (c) { rules } else if (d) { rules } else { rules }` becomes one attribute `data-<id>-<n>` holding the index of the branch that holds, and the rules are nested under `:scope[data-<id>-<n>="<i>"]` (`:scope` inside a branch becomes `&`);
  - the top-level elements of slot fills written in the component get `data-xz="<id>"` and the same `--` and `data-<id>-<n>` bindings, since they sit in the child's DOM and would not inherit the parent's custom properties;
  - `<id>` hashes the project-relative path (stable across CSS edits); components without styles get no attribute and no CSS import.
- Runtime (perf pass, design): fine `setAttr` branches on `--` names first and compares `getPropertyValue` before `setProperty` (38 ns unchanged vs 1055 ns); the render pass already diffs attributes, so it only maps `--` names to `setProperty`/`removeProperty`. One read closure per declaration is shared by all roots.
- The CSS is written to `.xzor/<rel>.xzor.css` and imported by the generated module (`import "./X.xzor.css";`), so Bun bundles one copy per module into `dist/main.css`.
- Visual Studio: a classic VSSDK extension (`editors/vs`), because the out-of-process VisualStudio.Extensibility model can't ship TextMate grammars yet. An `ILanguageClient` starts `xzor lsp` (same discovery as the VS Code client), and a `.pkgdef` registers the existing `xzor.tmLanguage.json`.

**Tech stack:** Rust (no crates), TypeScript 7, Bun, happy-dom, .NET Framework 4.7.2 VSSDK (`Microsoft.VisualStudio.SDK`, `Microsoft.VSSDK.BuildTools`, `Microsoft.VisualStudio.LanguageServer.Client`).

## Files

- `src/ast.rs`: `Document.module: Option<Vec<CodePart>>`, `Document.style: Option<StyleBlock { body: Src, global: bool }>`.
- `src/parser.rs`: `@module { }` (one per file); a top-level `<style>` read as raw text into `doc.style` (one per file).
- `src/style.rs` (new): `lower(css: &Src, id: &str, global: bool) -> Result<Lowered, (String, usize)>` with `Lowered { css: String, attrs: Vec<Attr> }`; `style_id(class, css) -> String`.
- `src/codegen.rs`: emit `@module` before the class; inject the style attributes into root elements and slot-fill roots before generating; add the CSS import; `Generated.css: Option<String>`.
- `src/lib.rs` / `src/build.rs`: read `X.css.xzor` (error when `X.xzor` also has a `<style>`); `find_sources` skips `*.css.xzor`; write `.xzor/<rel>.xzor.css`; a change to `X.css.xzor` or to a component's `<style>` recompiles `X.xzor` and reloads instead of hot-patching.
- `runtime/index.ts`, `runtime/fine.ts`: `--` attribute names go through `style.setProperty`/`removeProperty`.
- `src/lsp/features.rs`, `editors/vscode/syntaxes/xzor.tmLanguage.json`: `module` directive; CSS inside `<style>` and `.css.xzor`.
- `editors/vs/` (new): `Xzor.VisualStudio.csproj`, `source.extension.vsixmanifest`, `XzorLanguageClient.cs`, `xzor.pkgdef`, grammar copied at build time.
- Docs: `docs/design.md`, `README.md`, both skills, `.github/copilot-instructions.md`; CI packs the VSIX.

## Tasks

### Task 1: `@module`
- [ ] Parser test: `@module { export const n = 1; const f = <b>x</b>; }` fills `doc.module`; a second `@module` is an error; `@module` not followed by `{` stays an expression.
- [ ] Codegen test: module code sits between the imports and `export default class`, markup becomes `ComponentBase.fragment(...)` with no `this.`; the template's `@n` stays `n`.
- [ ] Integration test: another component imports `{ n }` from the `.xzor` and the project type-checks.
- [ ] LSP directive completion and grammar keyword.
- [ ] Perf pass: generated module code allocates once per module; commit.

### Task 2: scoped styles
- [ ] `style.rs` unit tests: scope wrapper, `global`, one var per dynamic declaration (units kept: `width: @p%` gives the attribute value `"" + p + "%"`), `@if/else` chains, `@@`, CSS at-rules (`@media`, `@container`, `@keyframes`, ...) left alone, errors for `@` in selectors.
- [ ] Runtime tests (both renderers): an attribute `--x-0` sets and removes a custom property.
- [ ] Codegen tests: roots and slot-fill roots get `data-xz`; dynamic attributes bound per root; CSS import line.
- [ ] Build tests: `.xzor/X.xzor.css` written; `X.css.xzor` used; both at once is an error; `X.css.xzor` is not a component.
- [ ] End-to-end: a styled component in happy-dom updates one custom property per change.
- [ ] Perf pass: per-update cost of a dynamic declaration (fine and render) and heap per instance against a hand-written baseline; commit.

### Task 3: Visual Studio 2026
- [ ] `editors/vs` project builds a VSIX with `msbuild /restore` (targets `[17.0,19.0)`, so VS 2022 and 2026).
- [ ] Manual check in VS 2026: highlighting, completion, hover and go to definition on `docs/site/pages/Kit.xzor`.
- [ ] `Package.ps1` and CI pack `xzor-vs-<version>.vsix` on Windows and attach it to the release.
- [ ] Perf pass: server start is lazy (first `.xzor` opened), one process per solution; commit.

### Task 4: docs and release notes
- [ ] design.md sections, README, skills, roadmap entries; commit.
