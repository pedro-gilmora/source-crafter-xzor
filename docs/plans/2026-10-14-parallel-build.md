# Faster Parallel Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After each task's review, dispatch `.github/skills/subagent-driven-development/perf-memory-reviewer-prompt.md`; its blocking findings enter the fix loop like the task reviewer's.

**Goal:** `xzor build` and every `--watch` rebuild finish sooner: components compile in parallel, and the type check runs at the same time as the bundle.

**Architecture:** `build::compile_many` compiles a list of sources on scoped std threads and returns results in input order; `compile_all` and `watch_loop` use it. `finish` (in `main.rs`) starts the checker on a thread, bundles on the main thread with its output captured, then prints the checker's output, then the bundle's, so the console reads as today and `xzor dev` still reloads only after a passing check. `--timings` prints each stage's duration.

**Tech Stack:** Rust std (`std::thread::scope`, `AtomicUsize`, `OnceLock`), no crates; Bun for tests.

**Spec:** [docs/plans/backlog-parallel-build.md](backlog-parallel-build.md)

## Global Constraints

- Zero Rust dependencies.
- Output byte-identical to the sequential build: same generated files, same diagnostics in the same order.
- Workers = `std::thread::available_parallelism()` capped at 8 and at the number of files; one file per worker at a time.
- Console order unchanged: type checker output and `xzor: type check passed`, then the bundle's `  <path>` lines.
- A failed check still fails the build, and the bundle's `  <path>` lines are not printed (`xzor dev` reloads on them).
- Baseline at 400 components (release, warm, Windows): compile ~115 ms, tsc ~205 ms, bundle ~210 ms, full build ~530 ms.

## Review Focus

- One component with a parse error among many: the build reports exactly the sequential error text, others still written.
- A checker that fails while the bundle succeeds: exit code non-zero, no `dist` path lines on stdout.
- A bundle that fails while the check passes: exit code non-zero, the checker's output still printed.
- `--no-check` or `--no-bundle`: no thread spawned for the missing stage, behavior as today.
- A single-file project: one worker, no thread overhead beyond it.

---

### Task 1: `--timings`

**Files:**
- Modify: `src/main.rs` (`Options`, argument parsing, `USAGE`, the `build` arm, `finish`, `rebuild`)
- Test: `tests/cli.rs`

**Interfaces:**
- Produces: `Options.timings: bool`; when set, every build and every watch rebuild ends with one stdout line
  `xzor: timings compile=<n>ms routes=<n>ms di=<n>ms check=<n>ms bundle=<n>ms total=<n>ms`
  (integer milliseconds; a skipped stage prints `0ms`; in watch mode `compile` is the batch's recompile).

- [ ] **Step 1: Write the failing test** `build_prints_timings` in `tests/cli.rs`: project `[("App.xzor", "<p/>")]`, run `xzor build <root> --no-check --no-bundle --timings`; assert success and that stdout has a line matching `^xzor: timings compile=\d+ms routes=\d+ms di=\d+ms check=0ms bundle=0ms total=\d+ms$`. Skip when `!has_bun()`.
- [ ] **Step 2: Run** `cargo test --test cli build_prints_timings` — expect FAIL (`unknown option --timings`).
- [ ] **Step 3: Implement** with `Instant` around each stage; add `--timings` to `USAGE` ("Print how long each stage took").
- [ ] **Step 4: Run** `cargo test --test cli` — expect PASS.
- [ ] **Step 5: Commit** `feat: build --timings prints per-stage durations`.

### Task 2: Parallel compile

**Files:**
- Modify: `src/build.rs` (`compile_all`, new `compile_many`)
- Modify: `src/main.rs` (`watch_loop`'s `for src in &recompile` loop)
- Test: `src/build.rs` `mod tests`

**Interfaces:**
- Produces: `pub fn compile_many(sources: &[PathBuf]) -> Vec<Result<Compiled, String>>` — one result per source, same order. Workers per Global Constraints, pulling the next index from a shared `AtomicUsize`; `compile_one` per file.
- `compile_all` keeps its signature and joins errors in source order. `watch_loop` zips `recompile` with `compile_many(&recompile)` and keeps its per-result handling unchanged.

- [ ] **Step 1: Write the failing test** `compile_many_matches_sequential`: temp project (use `temp`) with `tsconfig.json` `{}` and 40 components `C0..C39`, each importing the previous one (`@import C{i-1} from "./C{i-1}.xzor"` and `<C{i-1} />`), plus `Bad.xzor` containing `<p>` (unclosed). Sources sorted. Assert `compile_many(&sources)` equals `sources.iter().map(|s| compile_one(s))` element-wise: `Ok` pairs have equal `generated.code` and `out`; `Err` pairs have equal strings; exactly one `Err`.
- [ ] **Step 2: Run** `cargo test compile_many_matches_sequential` — expect FAIL (not defined).
- [ ] **Step 3: Implement** `compile_many` with `std::thread::scope`; use it in `compile_all` and `watch_loop`.
- [ ] **Step 4: Run** `cargo test` and `bun test tests/watch.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `perf: compile components in parallel`.

### Task 3: Type check alongside the bundle

**Files:**
- Modify: `src/build.rs` (`check` split so its output can be printed later; `bundle` returns its captured stdout; `bun --version` probe cached in a `OnceLock<bool>`)
- Modify: `src/main.rs` (`finish`)
- Test: `tests/cli.rs`

**Interfaces:**
- Consumes: Task 1's timings (`check` and `bundle` are each their own wall time; `total` covers both).
- Produces: `pub fn check_output(dir: &Path, checker: Option<&str>, compiled: &[Compiled]) -> (bool, String)` — success and the mapped output, printing nothing; `check` keeps its signature and prints it. `pub fn bundle(dir: &Path, entry: &str) -> Result<String, String>` — Ok(stdout) on success; stderr stays inherited.
- `finish`: with both stages on, `std::thread::scope` runs `check_output` on a thread while `bundle` runs; then print the check output (and `xzor: type check passed` on success), then the bundle stdout only if both succeeded. Errors: check failure first, else bundle failure.

- [ ] **Step 1: Write the failing tests** in `tests/cli.rs` (skip when `!has_bun()`), project with `App.xzor` `<p/>` and `main.ts` `import App from "./App.xzor";\nconsole.log(App);\n`:
  - `check_runs_while_bundling`: write `wait.ts` in the project: polls every 20 ms for `<dir>/dist/main.js` (dir = `process.argv[2]`) up to 5 s, prints `saw bundle` or `no bundle`, exits 0. Run `build <root> --checker "bun <root>/wait.ts {dir}"` (pass the path with `/`). Assert success and stdout contains `saw bundle`, and `saw bundle` appears before `dist`.
  - `failed_check_hides_bundle_paths`: `--checker "bun -e process.exit(1)"`. Assert failure, stdout has no line ending in `main.js`.
- [ ] **Step 2: Run** `cargo test --test cli check_runs_while_bundling failed_check_hides_bundle_paths` — expect the first to FAIL (`no bundle`).
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `cargo test` and `bun test` — expect PASS (189+ pass), including `tests/watch.test.ts`.
- [ ] **Step 5: Commit** `perf: type check alongside the bundle`.

### Task 4: Measure and record

**Files:**
- Modify: `docs/plans/backlog-parallel-build.md` (status, measured table)

- [ ] **Step 1:** Release build; `bun bench/gen.ts target/bench/app <n>` for 50, 400, 2000; median of 3 `xzor build --timings` runs each, plus peak working set (xzor + concurrent tsc + bun). Same for the commit before Task 1.
- [ ] **Step 2:** Replace the backlog's status and table with before/after (wall time per stage, total, peak MB). Note the two-phase header cache as not needed if compile at 2000 is under 150 ms; otherwise keep it listed as next.
- [ ] **Step 3: Commit** `docs: parallel build measurements`.
