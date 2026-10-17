# Design kit: sub-agents, a CSS-first component kit, showcase apps and a website

Agreed in chat on 2026-10-17. Goal: give frontend developers a plain, meaningful UI language. Simple and ambitious projects should both be easy to build in xzor, with a "liquid glass" look driven by CSS rather than JavaScript. The repo premise holds: memory and performance first. The kit adds no runtime JavaScript for styling.

Out of scope: GPUI or any native target (a later plan); a scoped `<style>` feature in the compiler (see 2.4).

The work is split into three sub-projects, built in this order. Each one gets its own plan in `docs/plans/`.

## 1. Design sub-agents (sub-project A)

### 1.1 Agents

There are four agents under `.github/agents/`, each a `*.agent.md` file. Each agent loads the shared kit rules (1.2) and works only through the kit's components and tokens.

| Agent | Job | Main inputs |
|---|---|---|
| `designer` | Turns a brief ("a sales app for phones") into screens. It picks layouts, components, tone and depth, and writes `.xzor` pages that use only the kit. | `frontend-design`, the kit rules |
| `component-builder` | Adds or changes a kit component: the `.xzor` file, its CSS in the right `@layer`, an entry on the website and a test. | the kit rules, the repo conventions |
| `motion` | Adds or reviews transitions using Emil Kowalski's rules. Motion is CSS-only (`transition`, `@starting-style`, `view-transition`) and respects reduced motion. | `emil-design-eng`, `animate` |
| `reviewer` | Read-only. It audits a page or component for accessibility, contrast on glass, focus, reduced motion and transparency, performance (no layout thrash, `backdrop-filter` budget), and kit misuse. | `review-animations`, the kit rules |

### 1.2 Adopted skills

The adopted skills are copied (vendored) into `.github/skills/`, each with its license and source commit noted:
- `frontend-design` (anthropics/skills);
- `emil-design-eng`, `animate` and `review-animations` (emilkowalski/skills).

The following are not adopted: `ui-ux-pro-max`, `impeccable` (its launcher downloads a binary), and the remote rule fetch in `web-design-guidelines`.

A new skill, `xzor-ui`, holds the kit rules:
- the component list and props;
- the token names;
- "reactive styling goes through custom properties and `data-*`" (2.4);
- what to avoid: inline colors, nesting glass inside glass, and animating layout properties.

It is also shipped in `npm/xzor/skills/` next to the existing `xzor` skill.

### 1.3 Done when

This check runs once B's first slice exists (`Glass`, `Panel`, `Stack`, `Grid`, `Button`, `Stat`, `Table`, `NavBar`). A ships the agents and skills first; its acceptance waits for that slice. A fresh chat that runs `designer` on the brief "a dashboard with KPIs and a table" produces a page that:
- builds with `xzor build`;
- uses only kit components;
- passes `reviewer` with no blocking findings.

## 2. Component kit and tokens (sub-project B)

### 2.1 CSS

The CSS is a single static file, `ui.css`, linked once. Pages do not import or inject CSS from JavaScript. It has four layers, in this order:

```css
@layer xz.tokens, xz.base, xz.components, xz.utilities;
```

- **Tokens:** custom properties for color (`light-dark()`, `oklch`), radius, space, type scale, blur, glass tint and edge, shadow, and motion (durations and easings).
- **Theme:** `color-scheme: light dark`. A user can force a theme with `data-theme` on `<html>`.
- **Liquid glass:** a layered surface:
  - `backdrop-filter: blur() saturate()`;
  - a translucent tint;
  - an inner highlight edge (`inset` shadow plus a gradient border through `border-image` or a mask);
  - a soft outer shadow.

  `depth` (1–3) scales blur, tint and shadow through tokens only.
- **Fallbacks:**
  - Without `backdrop-filter` support (`@supports not`), glass becomes a solid tinted surface.
  - With `prefers-reduced-transparency`, glass becomes solid.
  - With `prefers-contrast: more`, edges get stronger.
- **Modern features used:** cascade layers, `:has()`, container queries, `light-dark()`, `@starting-style`, `transition-behavior: allow-discrete`, native `popover` and `<dialog>`, CSS anchor positioning (with a `@supports` fallback), `@property` for animatable tokens, and `view-transition` for route changes where supported.
- **Motion:** every animation sits behind `prefers-reduced-motion: no-preference`.

### 2.2 Components

Each component is an `.xzor` file that renders semantic HTML with `class="xz-<name>"`. Variants go in `data-*` attributes; the CSS selects on them. The shared vocabulary of props is:
- `tone`: `neutral | accent | success | warning | danger`;
- `depth`: `0 | 1 | 2 | 3`, where 0 is flat and 1–3 are glass;
- `size`: `sm | md | lg`.

Components use `ChildContent` and named slots wherever content goes.

| Group | Components |
|---|---|
| Surfaces | `Glass`, `Panel`, `Sheet` (bottom/side, native `<dialog>`), `Dialog` |
| Layout | `Stack`, `Grid`, `Toolbar`, `NavBar` (top and mobile tab bar) |
| Actions | `Button`, `IconButton`, `Menu` (popover plus anchor), `Popover` |
| Input | `Field` (label, hint, error), `Input`, `Select`, `Switch`, `Segmented` |
| Data | `List`, `Table` (generic `T`, sortable header slot), `Stat` (KPI), `Badge`, `Avatar` |
| Navigation | `Tabs` |
| Feedback | `Toast` (popover, queued), `Skeleton`, `Empty` |

Rules for the components:
- Open and close state uses native `popover`, `<dialog>` and `:popover-open`. JavaScript only calls `showPopover()` and `showModal()`; it never toggles classes for visibility.
- Accessibility follows the native element first; ARIA is used only where there is no native element.

### 2.3 Distribution and icons

- **Location:** the kit lives in `ui/` (`ui/ui.css`, `ui/*.xzor`, `ui/icons/`). The in-repo apps and the site use it through relative imports. Each app's `tsconfig.json` `rootDirs` and `include` cover `../../ui` and its `.xzor` output, and the build compiles kit sources as part of each app. If the build cannot reach sources outside the root, the plan adds the smallest change that lets it, for example a `sources` entry in the project config.
- **npm package (`@source-crafter/xzor-ui`):** deferred to its own plan. The open question (precompiled package vs. `xzor add` vs. compiling from packages) is decided there.
- **Icons:** an `Icon` component renders an inline SVG `<use href="#name">` from one sprite. The sprite is a small set vendored from Lucide (ISC license, noted next to it), covering only the icons the apps need. Apps may add their own symbols to the sprite.

### 2.4 Reactive styling

No compiler change is needed.
- A reactive value goes in as a custom property: `style="--pct: @(Pct)%"`.
- A reactive variant goes in as a `data-*` attribute.
- The CSS reads both.

Today `style` and `class` attributes already compile to fine bindings. A `<style>` block inside a component is not scoped and re-renders as text, so kit components never use one.

### 2.5 Done when

- Every component has a happy-dom test (structure, `data-*` variants, open/close where it applies).
- A page with every component appears on the website (3.2).
- `ui.css` is valid under `bun x lightningcss`, or an equivalent check if that tool is not used.

## 3. Showcase apps and website (sub-project C)

### 3.1 Apps

The apps live in `examples/`. Each one builds with `xzor build` and uses only the kit plus app code.
- **`dashboard`:** a sidebar `NavBar`, `Stat` KPIs, a sortable `Table`, filters in a `Toolbar` with `Segmented`, a detail `Sheet`, and a dark/light toggle.
- **`blog`:**
  - routes for the list, the post and the tag (blog posts are static data in TypeScript);
  - article typography;
  - `view-transition` between the list and a post;
  - a reading-progress bar through a custom property.
- **`sales`** (mobile web app):
  - a bottom `NavBar` tab bar;
  - a product `List`, a cart in a bottom `Sheet`, and checkout `Field`s;
  - `Toast` on add;
  - an installable PWA (manifest plus a minimal service worker);
  - safe-area insets and touch targets of 44 px or more.

### 3.2 Website

The website is the existing `docs/site/`, rebuilt on the kit. It keeps its current docs content, `publish.ts`, service worker and the GitHub Pages deployment in CI. Its hand-written `styles.css` is replaced by `ui.css` plus a few site-only rules. `publish.ts` also publishes the three apps under `/examples/<name>/` in the same Pages artifact, each with its own base path. It adds:
- a home page with the pitch and a live glass demo;
- a component gallery: each component with its variants, live props controls, and the `.xzor` source next to it;
- "combinations", meaning recipes frontend developers search for:
  - glass navbar over scrolling content;
  - a bottom sheet with snap points;
  - a command menu (popover plus anchor);
  - a toast stack;
  - a KPI grid with container queries;
  - a data table with a sticky header;
  - theme switching;
  - route view-transitions;
  - a skeleton → content transition;
- links to the three apps, running live.

### 3.3 Done when

- All three apps and the site build.
- Lighthouse scores 100 for accessibility and 95 or more for performance on the site home page and the sales app on mobile, from client rendering alone (no SSG). This is checked by hand before release, not as a CI gate.
- `reviewer` has no blocking findings on any page.

## 4. Runtime change: route view-transitions

The router gains one opt-in, for example `viewTransitions: true` in the router options. When it is on and `document.startViewTransition` exists, a navigation commits its render inside `startViewTransition`. Otherwise nothing changes. This means one branch on the navigation path and no extra allocation when it is off. It comes with runtime tests, and with design doc and skill updates. Shared-element names come from CSS (`view-transition-name`) in the kit and apps.

## 5. Decisions taken without the user (2026-10-17, to review)

1. The website replaces the styling of `docs/site/` instead of starting a second site.
2. The npm package for the kit is deferred; the in-repo apps use relative paths.
3. Route view-transitions are included, as the opt-in runtime change in section 4.
