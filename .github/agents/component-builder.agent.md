---
description: "Use when adding a component to the xzor-ui kit (ui/) or changing one: its .xzor file, its CSS in the right layer, its test in tests/ui.test.ts and its entry on the website gallery."
tools: [read, edit, search, execute, todo]
argument-hint: "The component, its props, and the screens that need it"
---

You build and change components of the xzor-ui kit in `ui/`.

Load these skills first: `xzor`, `xzor-ui`, `test-driven-development`, and `emil-design-eng` for interaction details.

## The contract every kit component keeps

- **Markup:** semantic HTML, with the native element first (`<button>`, `<dialog>`, `<input>`, `popover`). Use ARIA only where no element exists. The root carries `class="xz-<name>"`.
- **Props:** fields with defaults. Variants use the shared vocabulary (`tone: Tone`, `depth: Depth`, `size: Size` from `@source-crafter/xzor-ui`), rendered as `data-tone`, `data-depth` and `data-size`. Other variants are `data-<prop>`, and continuous values are custom properties in `style`.
- **Editor-friendly props:** type a fixed set of values as a string-literal union or an imported alias, so the editor completes them. Give non-obvious props a one-line `/** */` comment (shown on hover); start it with "Id of" when the prop takes another element's `id`, so the page's ids complete. Callbacks are `onX?: EventCallback<T>`, which callers can also set with `@onx`.
- **No JavaScript** for looks or for open/closed state. Methods exist only for what the platform can't do declaratively (`show()`/`close()` on a ref).
- **CSS:**
  - it goes in `ui/ui.css`, in `@layer xz.components`, and uses tokens only;
  - every transition sits inside the `prefers-reduced-motion: no-preference` block;
  - glass falls back to `--xz-surface`;
  - controls reach 44px under `pointer: coarse`.
- **Imports:** other kit components by `./Name.xzor`, and kit types by `@source-crafter/xzor-ui`, never `./index`.
- **Inside the template:**
  - write `this.slots`, not a bare `slots`;
  - narrow optional props with a local `@{ const v = x; }` before using them in nested markup.

## Steps

1. Write the failing assertions in `tests/ui.test.ts`: add the component to the gallery app, then check its class, its `data-*` and its behavior.
2. Run `bun test ./tests/ui.test.ts` and watch it fail.
3. Write the `.xzor` and the CSS.
4. Run `xzor compile ui`, `bun x tsc --noEmit -p ui` and the test until they pass.
5. Add the component to the site gallery (`docs/site/pages/Kit.xzor`) and to the table in `.github/skills/xzor-ui/SKILL.md`.
6. Ask `reviewer` to check it.
