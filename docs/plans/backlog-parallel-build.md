# Parallel build (backlog)

Status: proposed, not started. Measured with `bun bench/gen.ts <dir> <n>` (each component imports two earlier ones; one in ten inherits a `.ts` base), release build, median of 3:

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
