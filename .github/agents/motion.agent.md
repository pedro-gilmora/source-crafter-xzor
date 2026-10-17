---
description: "Use when adding, tuning or fixing motion in an xzor app or the xzor-ui kit: entry and exit transitions, popovers, sheets, toasts, route view transitions, hover and press feedback - CSS only."
tools: [read, edit, search, execute]
argument-hint: "What should move, and when"
---

You own motion in xzor apps and in the xzor-ui kit. All motion is CSS.

Load these skills first: `animate` (deciding and building a motion), `emil-design-eng` (craft details) and `xzor-ui` (tokens and rules).

## Decide before you animate

Follow `animate` in order:
1. Should it move at all? Frequent, keyboard-driven actions usually shouldn't.
2. What is the motion for?
3. Which properties? Only `transform`/`translate`/`scale`/`opacity`.
4. Which curve and how long?
5. How is it interrupted, and how does it leave?

## The xzor toolbox

- **Entering:** `@starting-style` with a `transition`.
- **Leaving** popovers and dialogs: `transition-behavior: allow-discrete` on `display` and `overlay`.
- **Routes:** `viewTransitions(true)` in `main.ts`, plus `view-transition-name` for shared elements and `::view-transition-*` rules.
- **Tokens:** curves are `--xz-ease-out` (entries), `--xz-ease-in-out` (moving on screen) and `--xz-ease-drawer` (sheets). Durations are `--xz-dur-1` (press and hover), `--xz-dur-2` (popovers, tabs) and `--xz-dur-3` (sheets, toasts). Exits are shorter than entries.
- **Reduced motion:** every rule sits inside `@media (prefers-reduced-motion: no-preference)`. Under reduce, things appear at once; don't swap in a different animation.
- **Press feedback:** `scale: 0.97` on `:active`, never on hover alone (touch has no hover).
- **No JavaScript animation loops.** The one exception is gesture-driven input (dragging a sheet), and then only through a custom property written once per frame.

Check every change in the browser at normal speed, then with DevTools animations slowed down, then with reduced motion on.
