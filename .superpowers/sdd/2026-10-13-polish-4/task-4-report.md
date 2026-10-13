# Task 4 report: per-directory `--watch` on Linux

Status: DONE_WITH_CONCERNS

- `src/watch.ts`: on Linux, one non-recursive `fs.watch` per directory (`Map<relDir, FSWatcher>`), walking the root and skipping `ignored` names. An event for a path that is now a non-ignored directory calls `add(path, true)`, which attaches the watcher first, then lists the directory, prints every file found and recurses. A stat failure or watcher `error` closes the watcher for that path and everything under it. Other platforms keep `recursive: true`. The stdout contract and the stdin-close exit are unchanged. `build.rs` embeds the file with `include_str!`, so the edit flows through.
- `tests/watch-script.test.ts` (new): runs `bun src/watch.ts <tmp>` directly. The created-directory test runs everywhere. The inotify-count test uses `test.skipIf(process.platform !== "linux")`. It counts `inotify wd:` lines in `/proc/<pid>/fdinfo/*` and expects fewer than 20, with 200 nested dirs under `node_modules`. It also checks that a write under `node_modules` prints nothing and that `src/y.ts` is reported. Child processes and temp dirs are cleaned up in `afterEach`.
- Tests on Windows: `bun test tests/watch-script.test.ts tests/watch.test.ts` gives 6 pass, 1 skip. Full `bun test` gives 111 pass, 1 skip, 0 fail.
- TDD note: the cross-platform test passed before the change, as the brief expected, because it guards the Linux path.

Concerns:
- The Linux path was not run here, because WSL has no bun. The controller needs to run `bun test tests/watch-script.test.ts` in WSL.
- Directory events are printed as before (e.g. `a`, `a/b`), alongside the files found inside.
- A file can print twice, once from the scan and once from its own event.

## Fix round

- Stale watchers: each watcher stores its directory inode; the event handler drops and re-adds a directory whose inode changed (removed and recreated under the same name).
- drop() returns early when the key is unwatched; a root error (empty key) closes all watchers.
- Root watch failure writes the error to stderr and exits 1 before the ready line; subdirectory failures stay silent.
- Event handler uses lstat, so symlinked directories are not followed.
- Tests (Linux): recreate, directory rename; (all platforms): root failure exit. Red on the old script (recreate, root failure), green now. WSL: 5 pass; Windows: 7 pass, 3 skip.
- Parked: the d/d self-event.
