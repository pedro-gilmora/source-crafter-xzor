# Unused bindings leave the bundle

Goal: an app ships only the `dom` bindings its generated code calls. Today `dom` is one object literal in `runtime/dom.ts`, so the bundler keeps every member. A prototype (`target/size-probe/domNs.ts`) that turned its members into exported functions behind a namespace measured, minified + gzip: counter −1.1 KB (−4%), sales −2.1 KB (−8%), dashboard −1.8 KB (−8%), blog −1.5 KB (−7%), tailwind −3.6 KB (−23%). Speed and memory: unchanged (same functions, called the same way).

## Design

- `runtime/dom.ts`: each `dom` member becomes a top-level `export function` (internal helpers that clash are renamed, not the members). `dom` stays the public name: `index.ts` does `import * as dom from "./bindings"` (or the equivalent) and re-exports it, so `dom.textAt(...)` and generated `__dom.textAt(...)` keep working and the bundler drops members nobody reads.
- Generated code keeps `import { dom as __dom }` from `@source-crafter/xzor-runtime` if Bun shakes through the re-exported namespace; else codegen imports the namespace from the place that shakes, with no new tsconfig `paths` entry required of projects.
- Internal callers (`NavLink`, dom.ts itself) call the functions directly, so they keep only what they use.
- Router code (`resolveRoute`, `$router`, navigation) is reachable only from `routesAt`, `NavLink`, `navigate` and pages, so an app without them drops it.
- `--minify` chunk splitting is unchanged (it trades total bytes for a smaller first load of lazy pages).

## Touches

### Components (rendering, bindings) - design.md Components; specs one-renderer, markup-keeps-dom
- Holds: the `dom` API and generated code stay in sync; generated code allocates no more than hand-written; `src/bundle.ts` embedded.
- Changes: `dom` is a module namespace, not an object literal; nothing in its call shape changes.
### Routing
- Holds: `routesAt`, `NavLink`, `navigate`, base path behaviour.
- Changes: router code is only bundled when used.
### Bundle and `--minify`
- Holds: chunks, CSS folding, maps.
- Changes: smaller output; no new options.
### Cross-cutting
- Generated code shape: unchanged text, or one import line. Runtime exports: `dom` keeps its name and members.
- Docs: design.md (where `dom` is described as an object), copilot-instructions runtime line if it says so.

## Tasks

1. Test first: a bundle test (`tests/bundle-*.test.ts` style) building a tiny app that uses only `textAt`, asserting a binding it doesn't use (e.g. `routesAt`, `cascadeAt`, `piecesAt`) and the router (`resolveRoute`) are absent from the minified output. Then convert `dom` and wire the namespace; all checks pass.
2. Measure before/after per example (gzip of minified, single file) and the perf harness; record here.
3. Docs.

## Results

Minified + gzip (level 9) of all JS in `dist`, `xzor build --minify` (split) and one file, before (99674c6) and after:

| app | one file before → after | Δ | split before → after | Δ |
|---|---|---|---|---|
| counter | 26.6 → 25.5 KB | −4.2% | 31.5 → 30.5 KB | −3.2% |
| sales | 26.6 → 24.5 KB | −8.0% | 30.0 → 27.9 KB | −6.8% |
| dashboard | 24.0 → 22.2 KB | −7.5% | 26.9 → 25.1 KB | −6.6% |
| blog | 21.2 → 19.7 KB | −7.1% | 28.7 → 27.3 KB | −5.1% |
| tailwind (no pages) | 15.6 → 12.0 KB | −22.9% | 15.6 → 12.0 KB | −22.9% |

Tailwind's bundle no longer holds `popstate`/`pushState`/`startViewTransition`: the router is gone. Speed and memory are unchanged (the same functions, called the same way). `tests/bundle-shake.test.ts` guards it.
