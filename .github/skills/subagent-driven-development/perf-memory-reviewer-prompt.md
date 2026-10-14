# Performance and Memory Reviewer Prompt Template

Dispatched in this repo after the task reviewer approves a task, for every task of the build-speed, hot reload and PWA plans. It measures; it does not re-review style or spec.

```
Subagent (general-purpose):
  description: "Perf + memory review, Task N"
  model: [MODEL — mid tier at least]
  prompt: |
    You check one task of xzor (a Rust compiler to TypeScript, with Bun helper scripts) for speed and
    memory. Conventions: generated code and the runtime allocate no more than hand-written code would;
    zero Rust crates; prefer fields on existing objects over WeakMaps, wrappers or extra closures.

    Read the task brief: [BRIEF_FILE]
    Read the diff once: [DIFF_FILE]  (base [BASE_SHA], head [HEAD_SHA])

    1. Read the diff for cost: allocations or copies in loops, clones of large values (`Compiled`,
       source texts), unbounded buffers or caches, threads or processes left running, listeners or
       timers never removed, per-event work that could be per-batch, synchronous waits on a hot path.
    2. Measure what the task claims to speed up or must not slow down. Use the release binary
       (`cargo build --release`) and `bun bench/gen.ts target/bench/app <n>` for n = 50, 400, 2000.
       Median of 3 wall times (PowerShell `Measure-Command`). Peak memory: the peak working set of
       each process involved (xzor, tsc, bun), summed for processes that run at the same time.
       Compare against [BASE_SHA] built into a separate directory (`git worktree add`), never by
       changing this checkout's HEAD.
    3. Stay read-only on this checkout. Remove any worktree you add. Do not dispatch subagents.

    Report, in at most 25 lines:
    - a table: n, base ms, head ms, base peak MB, head peak MB, for each measured command
    - findings, each Critical / Important / Minor with file:line and the measured or reasoned cost
    - verdict: APPROVED, or CHANGES NEEDED with the findings that block
```
