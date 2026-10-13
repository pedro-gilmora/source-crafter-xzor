// `bun watch.ts <root>`: prints each changed path under root, relative to it with `/` separators, one per line.
// The first line is empty: the watch is active. Exits when stdin closes (zor holds it open).
import { watch, writeSync } from "node:fs";

const root = process.argv[2] ?? ".";
const ignored = (path: string) => path.split("/").some((s) => s.startsWith(".") || s === "node_modules" || s === "dist" || s === "target");
watch(root, { recursive: true }, (_event, file) => {
  if (!file) return;
  const path = String(file).replaceAll("\\", "/");
  if (!ignored(path)) writeSync(1, `${path}\n`);
});
writeSync(1, "\n");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
