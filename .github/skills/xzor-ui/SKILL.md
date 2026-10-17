---
name: xzor-ui
description: Use when building or styling screens in an xzor app with the xzor-ui kit (@source-crafter/xzor-ui) - liquid glass surfaces, Button, Sheet, Dialog, Menu, Table, Stat, NavBar, Tabs, Field, toast, themes, icons, tokens - or when adding, reviewing or animating a kit component.
---

# xzor-ui

## Overview

xzor-ui is a CSS-first component kit for xzor. It ships one static style sheet (`ui.css`, in cascade layers) and small `.xzor` components. Components only render semantic HTML with a `class="xz-<name>"` and `data-*` attributes; the CSS does the rest. Opening and closing go through native `popover`, `<dialog>`, `command`/`commandfor` and `popovertarget`, with no JavaScript state.

Prefer a kit component to hand-written markup, and a prop to a class. Never write colors, radii, blur or shadows inline: use the tokens.

## Setup

1. Point the tsconfig `paths` at the kit (in this repo, `ui/`):
   ```json
   "@source-crafter/xzor-ui": ["../../ui/index.ts"],
   "@source-crafter/xzor-ui/*": ["../../ui/.xzor/*.ts"]
   ```
2. Compile the kit before the app: `xzor compile ui` (`bun run ui` in this repo).
3. Import it once in `main.ts`. This brings in the CSS, which Bun bundles to `dist/main.css`:
   ```ts
   import "@source-crafter/xzor-ui";
   ```
   Then link the CSS in `index.html`: `<link rel="stylesheet" href="dist/main.css">`.
4. Import components one by one:
   ```
   @import Button from "@source-crafter/xzor-ui/Button.xzor"
   ```

## Shared props

| Prop | Values | Meaning |
|---|---|---|
| `tone` | `neutral` `accent` `success` `warning` `danger` | Color role |
| `depth` | `"0"` flat, `"1"` `"2"` `"3"` glass | How far it floats: more blur, tint and shadow |
| `size` | `sm` `md` `lg` | Control size |

## Components

| Component | Props | Content |
|---|---|---|
| `Glass` | `depth="1"`, `tone?` | default slot |
| `Panel` | `title`, `depth="1"` | default slot, `@slot actions { }` in the header |
| `Stack` | `direction="column"\|"row"`, `gap`, `align`, `justify="start"\|"center"\|"end"\|"between"`, `wrap` | default slot |
| `Grid` | `min="16rem"` (narrowest column), `gap` | default slot |
| `Toolbar` | `depth`, `sticky` | default slot; `<span class="xz-spacer"></span>` pushes the rest to the end |
| `NavBar` | `kind="top"\|"side"\|"tabs"` (tabs is a floating bottom bar for phones), `label` | `NavItem`s |
| `NavItem` | `href`, `label`, `icon?`, `match="prefix"\|"exact"` | none (marks itself active, with `aria-current`) |
| `Tabs` | `options: string[]`, `@bind-value`, `label` | none: show the panel with `@if` |
| `Button` | `tone`, `variant="soft"\|"solid"\|"ghost"\|"glass"`, `size`, `type`, `disabled`, `icon?`, `label?`, `toggles?`, `opens?`, `closes?`, `onClick?` | text |
| `Menu`, `Popover` | `id` | buttons or links / anything |
| `Sheet` | `id`, `title`, `side="bottom"\|"end"\|"start"`; methods `show()`, `close()` | default slot, `@slot actions { }` |
| `Dialog` | `id`, `title`; methods `show()`, `close()` | default slot, `@slot actions { }` |
| `Field` | `label`, `hint`, `error` | one native `<input>`, `<select>` or `<textarea>` |
| `Segmented` | `options: string[]`, `@bind-value`, `label` | none |
| `Table<T>` | `items`, `columns: Column<T>[]`, `onRow?`, `caption` | none: columns sort on their header |
| `List<T>` | `items`, `depth` | `@slot item(x) { }` |
| `Stat` | `label`, `value`, `unit`, `delta?` (percent, colored by sign) | none |
| `Badge` | `tone` | text |
| `Avatar` | `name`, `src?`, `size` | none (initials without `src`) |
| `Skeleton` | `width`, `height`, `round` | none |
| `Empty` | `title`, `icon="inbox"` | text and actions |
| `Icon` | `name: IconName` | none |

From `@source-crafter/xzor-ui`:
- types: `Tone`, `Depth`, `Size`, `Column<T>`, `IconName`;
- `toast(message, tone?, ms?)`;
- `setTheme("light"|"dark"|"auto")`, `toggleTheme()`, `currentTheme()`.

Wiring that needs no code:
```xzor
<Button toggles="more" icon="dots" label="More" />
<Menu id="more"><button>Rename</button><button>Delete</button></Menu>

<Button opens="cart" icon="cart">Cart</Button>
<Sheet id="cart" title="Your cart">...  @slot actions { <Button closes="cart">Close</Button> }</Sheet>
```
To open from code (a row click, for instance), give the sheet `@ref="details"` with a field `details?: Sheet`, then call `this.details?.show()`.

Native controls are styled when they sit in a `Field`. Write `<input type="checkbox" role="switch">` for a switch, and `class="xz-input"` outside a `Field`. Keep `@bind` on the native element.

## Reactive styling

- A variant is a prop the component turns into `data-*` (`tone="@(ok ? 'success' : 'danger')"`).
- A continuous value is a custom property: `<div class="bar" style="--progress: @(read * 100)%">`, and the CSS reads `var(--progress)`. That is one attribute write per change, with no style recalculation outside it.
- Never toggle classes or `hidden` to show a popover or sheet: use the invokers above.
- A component's `<style>` block is not scoped. Put page CSS in the app's own `.css`, after `ui.css`, and in the `xz.utilities` layer or unlayered.

## Tokens

- **Color:** `--xz-bg`, `--xz-surface`, `--xz-text`, `--xz-muted`, `--xz-line`, `--xz-neutral`, `--xz-accent`, `--xz-success`, `--xz-warning`, `--xz-danger`, `--xz-on-tone`; inside a toned element, `--xz-tone`.
- **Hue:** change the whole palette with `--xz-hue`.
- **Toasts:** `--xz-toast-offset` lifts them above a bottom tab bar.
- **Space:** `--xz-space-1` to `-7` (0.25rem to 3rem).
- **Radius:** `--xz-radius-sm`, `--xz-radius`, `--xz-radius-lg`, `--xz-radius-pill`.
- **Text:** `--xz-text-sm`, `-md`, `-lg`, `-xl`, `-2xl`.
- **Glass:** `--xz-glass-tint`, `--xz-glass-edge`, `--xz-glass-rim`, `--xz-blur-1` to `-3`, `--xz-shadow-1` to `-3`.
- **Motion:** `--xz-ease-out`, `--xz-ease-in-out`, `--xz-ease-drawer`, `--xz-dur-1` (120ms), `-2` (200ms), `-3` (320ms).

Utilities: `.xz-page` (centered content width), `.xz-container` (a container-query box), `.xz-spacer`, `.xz-muted`, `.xz-visually-hidden`.

## Rules

- **Glass needs something behind it.** The body draws soft color fields (`--xz-backdrop`). Don't put glass on glass: a `depth` 1–3 element inside another one shows nothing through it. Use `depth="0"` or no surface inside a glass panel.
- **Contrast:** body text goes on `--xz-surface` or glass, never on raw `--xz-accent`. Solid buttons use `--xz-on-tone`.
- **Motion:** use `transform`, `opacity`, `translate` and `scale` only, behind `@media (prefers-reduced-motion: no-preference)`. Entry 200–320ms with `--xz-ease-out`; exits faster.
- **Touch:** targets of 44px or more on coarse pointers (the kit does this for its own controls). Use `env(safe-area-inset-*)` at screen edges.
- **Route transitions:** call `viewTransitions(true)` from `@source-crafter/xzor-runtime` in `main.ts`, and name shared elements with `view-transition-name` in CSS.
- **Accessibility:**
  - every icon-only `Button` has a `label`;
  - every `Segmented` and `Tabs` has a `label`;
  - tables have a `caption` when the page has more than one.

## Common mistakes

| Wrong | Right |
|---|---|
| `<div class="card">` with hand-written blur | `<Panel>` or `<Glass depth="1">` |
| `style="background: #fff"` | tokens, or a `tone` |
| `@onclick="() => open = true"` plus `@if (open)` for a sheet | `<Button opens="id">` + `<Sheet id="id">` |
| `<Button icon="x" />` with no text | `<Button icon="x" label="Close" />` |
| `@import Button from "../../ui/Button.xzor"` | `@import Button from "@source-crafter/xzor-ui/Button.xzor"` |
| `@if (x !== undefined) { @x.toFixed() }` (narrowing is lost inside bindings) | `@if (x !== undefined) { @{ const v = x; } @v.toFixed() }` |
