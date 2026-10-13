# Inherited members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** bare-name access to `@inherits` base members in templates, with invalidation in `--watch` and the LSP; tsc error mapping for relative build dirs.

**Spec:** [docs/superpowers/specs/2026-10-13-inherited-members-design.md](../superpowers/specs/2026-10-13-inherited-members-design.md)

## Global Constraints

- Memory and performance first. Codegen runs on every LSP keystroke, so base resolution reads only the files on the chain. No crates.
- Generated code changes only by `this.` prefixes.
- Verify with `cargo test`, `bun test`, `bun run test:grammar` and `cargo run -q -- build examples/counter`.

## Review Focus

- A local variable or slot parameter with the same name as a base member still wins. Test in Task 2.
- A static base member is not prefixed with `this.`. Test in Task 2.
- A base with a cyclic or very deep `extends` chain terminates. Test in Task 2.

### Task 1: tsc mapping with a relative build dir

**Files:** `src/build.rs`
- [ ] Failing test `maps_tsc_output_for_relative_out`: a `Compiled` whose `out` is relative (`x/.zor/A.tszor.ts`) and a tsc line with the absolute path `cwd/x/.zor/A.tszor.ts(1,1): error TS1: m`. The line maps to `x/A.tszor(…)`.
- [ ] Fix `map_tsc_line` by making `u.out` absolute against `cwd` before `same_path`.
- [ ] Commit as `fix(build): map tsc errors when the build dir is relative`.

### Task 2: Inherited members

**Files:** `src/lib.rs` (`compile_mapped`, beside `imported_components`), `src/codegen.rs` (`generate_with` gains the base members), `src/build.rs` (`dependents`), `src/lsp/server.rs` (refresh dependents)
**Interfaces:** `pub fn base_members(doc: &ast::Document, path: &Path) -> HashSet<String>` in lib.rs, plus a generator entry `generate_with(doc, class, source, components, inherited: &HashSet<String>)`. Add the parameter, or bundle it into a context struct if cleaner.
- [ ] Failing tests:
  - lib: a `.ts` base with fields, methods, getters, a parameter property and a static member. The generated code contains `this.title`, `this.describe()`, `this.x`, and not `this.create` for the static.
  - A two-level chain (`B extends A` across two files via imports).
  - A `.tszor` base.
  - An `X as Y` import.
  - An unresolvable base leaves names bare.
  - A local shadows a member.
  - A cyclic chain terminates.
- [ ] e2e (bun): the probe project from the spec (abstract `Titled` base with `title` and `describe()`, generic `Generic<T>` base with `item`) builds and passes the type check. Place it under `target/tmp-inherits`.
- [ ] `--watch`: `dependents` covers `.ts` stems for `@inherits` components. Add a unit test, and add one step to tests/watch.test.ts: editing the base `.ts` (renaming a member) recompiles the inheriting component.
- [ ] LSP: an open `.tszor` inheriting from an edited `.ts` refreshes. Add an e2e step in tests/lsp.test.ts: rename the base member in the open `.ts` (didChange), and the `.tszor`'s diagnostics show the TS error without saving it.
- [ ] Update `docs/design.md` (the `@inherits` row: inherited members are usable as bare names when the base resolves through `@import`).
- [ ] Commit as `feat: inherited members usable in templates`.
