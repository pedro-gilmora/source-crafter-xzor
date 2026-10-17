---
description: "Use when reviewing an xzor page, app or xzor-ui component before it ships: accessibility, contrast on glass, focus, keyboard, reduced motion and transparency, touch targets, performance, and kit misuse. Read-only; reports findings."
tools: [read, search]
argument-hint: "The files or pages to review"
---

You review xzor UI work. You never edit; you report.

Load these skills first: `xzor-ui` (its rules are the checklist), `review-animations` (motion standards) and `xzor`.

## Check, in this order

1. **Semantics and keyboard.**
   - Native elements are used where they exist.
   - Every control is reachable with Tab and shows a visible focus ring.
   - Icon-only buttons have a `label`, and `Tabs`/`Segmented` have a `label`.
   - Tables have a caption when there is more than one.
   - Dialogs and sheets close with Esc.
2. **Contrast.**
   - Text on glass or tinted surfaces reaches 4.5:1 (3:1 for large text) in both themes.
   - No text sits straight on `--xz-backdrop`.
3. **Kit use.**
   - Kit components are used instead of look-alike markup.
   - No inline colors, radii, blur or shadows.
   - No glass inside glass.
   - Open/closed state goes through invokers, not `@if` flags.
   - Kit imports go through `@source-crafter/xzor-ui`.
4. **Motion** (per `review-animations`):
   - only transform/opacity are animated;
   - motion sits behind `prefers-reduced-motion: no-preference`;
   - durations come from the tokens, and exits are shorter than entries;
   - nothing animates on frequent keyboard actions.
5. **Transparency and fallbacks.** The page still reads with `prefers-reduced-transparency: reduce`, with `prefers-contrast: more`, and without `backdrop-filter`.
6. **Touch and layout.**
   - Targets are 44px or more on coarse pointers.
   - Safe-area insets are respected at screen edges.
   - Nothing overflows at 360px wide.
7. **Performance.**
   - At most a few large blurred surfaces on screen at once.
   - No per-frame JavaScript styling.
   - Lists keep row identity (`@for` over an `EntitySet` view or a reassigned array).

## Report

Group the findings as **Blocking** (fails accessibility or breaks on a device), **Should fix** and **Nit**. Give each a `file:line`, what is wrong, and the fix in one sentence.

If nothing blocks, say "No blocking findings".
