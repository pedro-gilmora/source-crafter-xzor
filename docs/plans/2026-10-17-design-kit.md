# Design kit implementation plan

> For agentic workers: use executing-plans; steps are checkboxes.

**Goal:** design sub-agents, a CSS-first liquid-glass component kit (`ui/`), three showcase apps and the docs site on the kit.

**Architecture:** the kit is its own TypeScript project (`ui/tsconfig.json`) compiled with `xzor compile ui` into `ui/.xzor/`. Apps import it as `@source-crafter/xzor-ui` (TS helpers plus `ui.css`) and `@source-crafter/xzor-ui/<Name>.xzor` (components) through tsconfig `paths`, which the future npm package can keep.

**Tech stack:** xzor (fine components), plain CSS, Bun, happy-dom. No new npm packages.

**Spec:** [docs/superpowers/specs/2026-10-17-design-kit-design.md](../superpowers/specs/2026-10-17-design-kit-design.md)

## Global constraints

- No new dependencies, either npm or Rust.
- No JavaScript for styling or for showing and hiding things. Use native `popover`, `<dialog>`, `command`/`commandfor` and `popovertarget`.
- Every reactive style goes through `data-*` attributes or a custom property in `style`.
- Every animation sits behind `prefers-reduced-motion: no-preference`. Glass becomes solid under `prefers-reduced-transparency` and when `backdrop-filter` is unsupported.
- Icons are drawn by hand, 24×24 with a 2-unit stroke, one `path` per icon, with no third-party set. This changes the spec's "vendored from Lucide" to "own set".

## Review focus

1. **SVG inside templates.** `<svg>` and `<path>` must be created in the SVG namespace by both runtimes, or icons render as nothing. Test: `runtime/fine.test.ts` and `runtime/index.test.ts`.
2. **Kit props updating after mount.** Kit components live outside the app root, and their fields must still be tracked. Test: `tests/ui.test.ts`, which changes a `Stat` value and expects the DOM to follow.
3. **An app importing the kit.** This has to work end to end: resolving `@source-crafter/xzor-ui/X.xzor`, the type check, the bundle, and the CSS emitted in the bundle. Test: `tests/ui.test.ts`.
4. **Route view-transitions.** When turned off, or in a browser without `startViewTransition`, navigation must stay synchronous. Test: `runtime/router.test.ts`.
5. **Dialogs and sheets.** They must open and close through attributes only (`commandfor`/`command`) and through the instance methods `show()`/`close()`. Test: `tests/ui.test.ts`.

---

### Task 1: Runtime: SVG namespace and view transitions

**Files:** `runtime/index.ts`, `runtime/fine.ts`, `runtime/index.test.ts`, `runtime/fine.test.ts`, `runtime/router.test.ts`.

- [ ] **SVG tests.** Assert that `<svg><path d="M0 0"/></svg>` gives `namespaceURI === "http://www.w3.org/2000/svg"` for both `svg` and `path`. Test it in vdom with a hand-written `buildRenderTree`, and in fine with `fine.template([["svg", ["viewBox","0 0 24 24"], ["path", ["d","M0 0"]]]])`. Also assert that `viewBox` keeps its case. Run them and see them fail.
- [ ] **SVG fix.**
  - In the vdom `create` element case, use `createElementNS(SVG_NS, tag)` when the tag is `svg` or the parent is SVG. The parent comes from a new `svg` parameter, and `patchList` derives it from `parent.namespaceURI`.
  - Fine: give `make(spec, svg = false)` the same rule.
- [ ] **View-transition tests** in `runtime/router.test.ts`.
  - Export `viewTransitions(on: boolean): void`.
  - With it on and a stub `document.startViewTransition = (cb) => { called++; cb(); }`, a navigation calls the stub once and the page updates.
  - With it off, the stub is not called.
- [ ] **View-transition implementation.** In `notifyNavigated`, when the flag is on and `document.startViewTransition` exists, run the subscriber loop inside it.
- [ ] Run `bun test runtime`. Everything passes. Commit.

### Task 2: Kit infrastructure: compile, resolve, bundle

**Files:** `src/bundle.ts` (the `.xzor` `onResolve` handles relative specs only, and `tracksFields` accepts generated fine components from any `.xzor/` outside `node_modules`), `ui/tsconfig.json`, `ui/index.ts`, `ui/ui.css` (tokens only for now), `package.json` (a `ui` script: `cargo run -q -- compile ui`), and `tests/ui.test.ts`.

- [ ] **Failing test** in `tests/ui.test.ts`:
  - Build a temp app in `target/tmp-ui` with these tsconfig `paths`:
    - `"@source-crafter/xzor-ui": [<repo>/ui/index.ts]`;
    - `"@source-crafter/xzor-ui/*": [<repo>/ui/.xzor/*.ts]`.
  - Run `xzor compile ui`, then `xzor build target/tmp-ui`.
  - Mount, then assert that the kit's `Stat` renders and that changing the app field passed as `value` updates the text.
  - Assert that `dist/main.css` contains `@layer xz.tokens`.
- [ ] Make it pass with the `bundle.ts` changes above, plus `ui/index.ts` doing `import "./ui.css"` and exporting `toast`, `setTheme`, `icons` and `type IconName`. Commit.

### Task 3: The kit

**Files:** `ui/ui.css` and `ui/*.xzor`:
- `Glass`, `Panel`, `Sheet`, `Dialog`;
- `Stack`, `Grid`, `Toolbar`, `NavBar`, `NavItem`;
- `Button`, `Menu`, `Popover`;
- `Field`, `Segmented`;
- `List`, `Table`, `Stat`, `Badge`, `Avatar`;
- `Tabs`, `Skeleton`, `Empty`, `Icon`.

TypeScript files: `ui/icons.ts`, `ui/toast.ts`, `ui/theme.ts`. Tests go in `tests/ui.test.ts`.

**Changes from the spec's component table:**
- `Input`, `Select` and `Switch` are native elements styled by the kit (`.xz-field input`, `input[role=switch]`), so `@bind` keeps working.
- `IconButton` is `<Button icon="x" label="..."/>`.
- `Toast` is the `toast(message, tone?)` function: a manual popover stack, so it needs no component.

**Shared props:** `tone: Tone = "neutral"`, `depth: Depth = "1"` and `size: Size = "md"`, each rendered as `data-tone`, `data-depth` and `data-size`. `Tone`, `Depth` and `Size` are string-literal aliases exported from `ui/index.ts`.

**APIs (fields):**

| Component | Fields | Slots |
|---|---|---|
| `Button` | `variant: "solid"\|"soft"\|"ghost"\|"glass"`, `type`, `disabled`, `icon?`, `label?` (aria-label), `toggles?` (popover id), `opens?` (dialog id, `command="show-modal"`), `closes?` (dialog id, `command="close"`), `onClick?` | default |
| `Sheet` / `Dialog` | `id`, `title`, `side: "bottom"\|"end"\|"start"` (Sheet only) | default, `actions` |
| `Menu` / `Popover` | `id` | default |
| `Field` | `label`, `hint?`, `error?` | default |
| `Segmented` | `options: string[]`, `value`, `valueChanged?` (works with `@bind-value`) | none |
| `Tabs` | same fields as `Segmented` | none |
| `Table<T>` | `items: Iterable<T>`, `columns: Column<T>[]`, `onRow?: EventCallback<T>` | none |
| `List<T>` | `items` | `item(x)` |
| `Stat` | `label`, `value`, `delta?`, `unit?` | none |
| `Grid` | `min = "16rem"`, as `style="--min:..."` | default |
| `Stack` | `direction`, `gap`, `align` | default |
| `NavBar` | `kind: "top"\|"side"\|"tabs"` | default |
| `NavItem` | `href`, `icon?`, `label`, `match` (wraps `NavLink`) | none |

- `Column<T>` is `{ label; value(row): string|number; align?: "start"|"end"; sort?: boolean }`.
- `Sheet` and `Dialog` expose `show()` and `close()`, and use `closedby="any"`.
- `Menu` and `Popover` are anchored to their invoker with `position-area`, and fall back to centered when anchor positioning is unsupported.

**Steps:**
- [ ] **Tests first.** One gallery app in `tests/ui.test.ts` mounts every component. Per component, assert:
  - its class and `data-*` attributes;
  - Button's `commandfor`/`command`/`popovertarget`;
  - that clicking a Table header sorts the rows;
  - that Segmented calls `valueChanged`;
  - that `Sheet.show()` sets `open`;
  - that `toast("Saved")` adds `.xz-toast` and removes it after its timeout (fake timers).
- [ ] Write the components and the CSS until the tests pass.
- [ ] Commit.

### Task 4: Agents and skills

**Files:**
- `.github/skills/{frontend-design,emil-design-eng,animate,review-animations}/`, copied from the clones, each with a `SOURCE.md` giving the repository, commit and license;
- `.github/skills/xzor-ui/SKILL.md`, also copied to `npm/xzor/skills/xzor-ui/SKILL.md`;
- `.github/agents/{designer,component-builder,motion,reviewer}.agent.md`.

- [ ] Write them. The `reviewer` agent gets read-only tools.
- [ ] Check: each agent names its skills, and the `xzor-ui` skill lists exactly the components and tokens in `ui/`.
- [ ] Commit.

### Task 5: Showcase apps

**Files:** `examples/{dashboard,blog,sales}/`, each with `index.html`, `main.ts`, `Routes.xzor`, pages and `tsconfig.json` (with the `paths` from Task 2). The root `package.json` gets an `examples` script that compiles the kit and then builds all three.

- [ ] Write each app as the spec describes:
  - **dashboard:** KPIs, a sortable table, `Segmented` filters, a detail `Sheet` and a theme toggle.
  - **blog:** list, post and tag routes, view transitions, and a reading-progress bar driven by `--progress`.
  - **sales:** a tabs `NavBar`, products, a cart `Sheet`, checkout `Field`s, `toast`, a manifest with icons, safe areas, and touch targets of 44 px or more.
- [ ] Each app passes `xzor build`.
- [ ] Check them in the browser: in light and dark themes, at a mobile width, and with reduced motion.
- [ ] Commit.

### Task 6: Site on the kit

**Files:** `docs/site/*`, rebuilt on the kit, and `docs/site/publish.ts`, which compiles `ui` first and publishes the apps under `/examples/<name>/` with `<base href>`.

- [ ] Write the pages:
  - **Gallery:** every component with its variants and a live props control, with its source shown by the existing `Code` snippet highlighter.
  - **Recipes:** the nine combinations from the spec.
- [ ] `bun docs/site/publish.ts` writes `_site`, with the apps inside it.
- [ ] Check it in the browser.
- [ ] Commit.

### Task 7: Docs and verification

- [ ] Update `README.md`, `docs/design.md` (the kit, SVG and view transitions), the `xzor` skill (`viewTransitions`, SVG) and `.github/copilot-instructions.md` (the `ui/` commands).
- [ ] Run `cargo test`, `bun test` and `bun run test:grammar`. Everything passes.
- [ ] Commit.
