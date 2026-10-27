---
name: spec-rehydration
description: Use whenever a spec or design is being written, changed or approved in xzor (brainstorming output, docs/superpowers/specs, docs/plans backlog proposals, docs/design.md sections) - pulls every constraint from the features the change touches into the spec, and writes the change back into those features' specs and docs.
---

# Spec rehydration

A spec is only as good as what it remembers. xzor's features lean on each other (a routing change touches codegen, the route table, DI entries, the bundle, the LSP, two editors, the kit, examples and five doc sets), and a spec written from one feature's point of view silently breaks the others. This skill makes every spec carry the points that matter from every feature it touches, and keeps those features' specs current.

Run it at two moments: **before the spec is shown for approval** (hydrate) and **after it is approved** (write back). Not optional for any spec, however small; a rename is a spec too.

## 1. Find what the change touches

Open [features.md](features.md). For each row, ask: does this change alter, rely on, or rename anything this feature owns (syntax, generated code, runtime API, build output, editor behavior, docs)? Then walk the cross-cutting aspects at the bottom of the file the same way. List every hit; when unsure, it's a hit.

## 2. Hydrate: pull the points that matter

For each touched feature, read its spec, its `docs/design.md` section, and grep its code for the names the change affects. Extract only what constrains this change:

- invariants and limits ("at most one per project", "a `.xzor` must not import from `./main`")
- decisions already made and why (don't re-litigate them silently; if the new spec reverses one, say so)
- names, syntax and generated shapes the change must stay compatible with or must migrate
- perf and memory rules (`Conventions` in `.github/copilot-instructions.md`)
- tests that pin the behavior today

Write them into the spec under **`## Touches`**, one subsection per feature:

```markdown
## Touches

### Routing (`@ClientRoutes`/`@ServerRoutes`) - docs/superpowers/specs/2026-10-13-routing-cascading-design.md
- Holds: at most one routes block per project; regex sections are client-only.
- Changes: both keywords become `@Routes`; the engine moves to `@Run`.
- Migrates: parser keyword list, codegen `addRoutes(engine, ...)`, 14 parser tests, grammar, LSP completion.
```

Every touched feature gets a subsection, even if it is "Holds: X. Changes: nothing." That line is the proof it was checked. Cross-cutting aspects that are hit (perf, editors, docs, ...) get one too.

## 3. Check the spec against what it pulled

Before showing the spec: does any "Holds" conflict with the design? Resolve it in the design or call it out as an open question. A spec that contradicts a pulled point without saying so is not ready.

## 4. Write back after approval

The approved spec changes other features, so their records change with it, in the same commit as the spec:

- Each touched feature's spec gets a dated line under a `## Later changes` heading (create it at the end if missing): `- 2026-10-26: <what changed>, see <new spec>.` Never rewrite the old decision text; append.
- `docs/design.md` sections that describe changed behavior are updated (they describe the present).
- [features.md](features.md) gets a row for a new feature, and changed paths for moved code.
- The user-facing docs (README, docs site, user skill, kit skill) are updated by the implementation commit, per the "Docs are mandatory" rule; list them in the plan.

## Red flags

- A `## Touches` section that names only the feature being designed.
- "Changes: nothing" for a feature whose names appear in the diff.
- A decision in an older spec reversed with no `## Later changes` line.
- Writing back before the spec is approved (it may still change).
