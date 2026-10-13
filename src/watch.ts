// `bun watch.ts <root>`: prints each changed path under root, relative to it with `/` separators, one per line.
// The first line is empty: the watch is active. Exits when stdin closes (zor holds it open).
import { lstatSync, readdirSync, statSync, watch, writeSync, type FSWatcher } from "node:fs";

const root = process.argv[2] ?? ".";
const ignored = (path: string) => path.split("/").some((s) => s.startsWith(".") || s === "node_modules" || s === "dist" || s === "target");
const print = (path: string) => writeSync(1, `${path}\n`);

if (process.platform !== "linux") {
  watch(root, { recursive: true }, (_event, file) => {
    if (!file) return;
    const path = String(file).replaceAll("\\", "/");
    if (!ignored(path)) print(path);
  });
} else {
  // Linux has no native recursive watch: one watcher per directory, so ignored trees cost no inotify watches.
  const watchers = new Map<string, { w: FSWatcher; ino: number }>();
  const drop = (dir: string) => {
    if (!watchers.has(dir)) return;
    for (const [key, e] of watchers) if (!dir || key === dir || key.startsWith(`${dir}/`)) (e.w.close(), watchers.delete(key));
  };
  // Watches `dir` (relative, "" is the root) and its subtree; `report` prints the files found in it.
  const add = (dir: string, report: boolean) => {
    if (watchers.has(dir)) return;
    let w: FSWatcher;
    try {
      w = watch(dir ? `${root}/${dir}` : root, (_event, file) => {
        if (!file) return;
        const path = dir ? `${dir}/${file}` : String(file);
        if (ignored(path)) return;
        try {
          const st = lstatSync(`${root}/${path}`);
          if (st.isDirectory()) {
            // Same name, new inode: the directory was removed and recreated.
            if (watchers.get(path)?.ino !== st.ino) drop(path);
            add(path, true);
          }
        } catch {
          drop(path);
        }
        print(path);
      });
    } catch (e) {
      if (dir) return;
      writeSync(2, `${(e as Error).message}\n`);
      process.exit(1);
    }
    w.on("error", (e) => {
      // Losing the root watcher leaves nothing to report: end the script so zor says the watcher exited.
      if (dir) return drop(dir);
      writeSync(2, `${e.message}\n`);
      process.exit(1);
    });
    let ino = 0;
    try {
      ino = statSync(dir ? `${root}/${dir}` : root).ino;
    } catch {}
    watchers.set(dir, { w, ino });
    let entries;
    try {
      entries = readdirSync(dir ? `${root}/${dir}` : root, { withFileTypes: true });
    } catch {
      return drop(dir);
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (ignored(path)) continue;
      if (entry.isDirectory()) add(path, report);
      else if (report) print(path);
    }
  };
  add("", false);
}
writeSync(1, "\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
