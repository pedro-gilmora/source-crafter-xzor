# Parallel build

Status: done on `perf/parallel-build` ([plan](2026-10-14-parallel-build.md)): `--timings`, parallel compile (std threads, up to 8 workers), and the type check running alongside the bundle. Full `xzor build`, release, median of 3, 32 logical CPUs:

| Components | Before | After | Stages after (`--timings`) |
|---:|---:|---:|---|
| 50 | 263 ms | 191 ms | compile 4, check 170, bundle 77 |
| 400 | 531 ms | 288 ms | compile 27, check 239, bundle 223 |
| 2000 | 2,265 ms | 1,889 ms | compile 157, routes 40, check 554, bundle 1,809 |

Generated output is byte-identical. Because the bundle no longer waits for the check, `dist/` is rewritten even when the check fails; the build still exits non-zero and `xzor dev` does not reload, so deploy scripts must honor the exit code. Memory: xzor's own peak rises 3 to 6 MB; while tsc and Bun run together the combined peak rises by up to ~120 MB at 400 components (+12 MB at 2000, where the peaks don't coincide).

Next, by measured cost:
1. **Bundle at scale**: 1.8 s at 2000. `composeMaps` in `src/bundle.ts` copies and reverses a line's segments for every lookup (`lookup`); a binary search over the decoded line should remove most of it. Measure Bun.build alone versus the map composition first.
2. **Two-phase compile** (header cache, below): compile is 157 ms at 2000, just over the 150 ms target; only worth it after the bundle.

## Original proposal

Measured with `bun bench/gen.ts <dir> <n>` (each component imports two earlier ones; one in ten inherits a `.ts` base), release build, median of 3:

| Components | Compile (xzor) | Type check (tsc) | Bundle (Bun) |
|---:|---:|---:|---:|
| 50 | 18 ms | 147 ms | 66 ms |
| 400 | 97 ms | 194 ms | 207 ms |
| 2000 | 501 ms | 543 ms | 1,367 ms |

Compiling a `.xzor` reads only sources (its own, imported components', `@inherits` bases), never another compilation's output, so there is no required order: all files compile in one parallel batch.

1. **Measure**: `--timings` (per-stage durations) and `bench/run.ts` (median wall time and peak memory of xzor, tsc and Bun for 50/400/2000 components; sequential vs parallel vs overlapped).
2. **Overlap type check and bundle**: both only read generated `.ts`. Saves the shorter one (~540 ms at 2000). Measure the combined memory peak; keep sequential behind an option if it is too high.
3. **Two-phase parallel compile** (std threads, no crates): phase 1 reads and parses each file once into a read-only header cache (props, type params, inherited members); phase 2 generates in parallel from it. Workers = cores, capped; one file per worker at a time. Expected ~500 ms -> 100-150 ms at 2000.

Tests on each step: parallel output byte-identical to sequential, diagnostics in the same order, worker cap respected, one read per file in phase 1. `--watch` benefits without changing its logic.
