// `xzor init`, run by the launcher under Bun.
// Creates package.json, tsconfig.json and .gitignore, or adds only what xzor needs to the existing ones.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

function update(file: string, fresh: object, change: (json: any) => void) {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const json = exists ? Bun.JSONC.parse(text) : fresh;
  const before = JSON.stringify(json);
  change(json);
  if (exists && JSON.stringify(json) === before) return console.log(`  ${file}: already set up`);
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${file}: ${exists ? "updated" : "created"}${/\/[/*]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, "")) ? " (its comments were not kept)" : ""}`);
}
const add = (list: string[], ...items: string[]) => [...list, ...items.filter((i) => !list.some((l) => l.toLowerCase() === i.toLowerCase()))];

update("package.json", {}, (p) => {
  if (!p.name) Object.assign(p, { name: basename(process.cwd()).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), private: true, type: "module" });
  p.scripts ??= {};
  // A project that already has `build` (vite, tsc, ...) keeps it and gets `build:xzor`.
  for (const [name, command] of [["build", "xzor build"], ["dev", "xzor build --watch"]]) {
    if (!Object.values(p.scripts).includes(command)) p.scripts[name in p.scripts ? `${name}:xzor` : name] = command;
  }
});

update("tsconfig.json", { compilerOptions: { target: "ES2022", strict: true, noEmit: true, skipLibCheck: true }, exclude: ["dist", "node_modules"] }, (t) => {
  const o = (t.compilerOptions ??= {});
  o.module ??= "ESNext";
  o.moduleResolution ??= "bundler";
  o.lib = add(o.lib ?? [o.target ?? "ES2022"], "ESNext.Disposable", "DOM");
  // `import X from "./X.xzor"` resolves to the generated .xzor/X.xzor.ts.
  o.rootDirs = add(o.rootDirs ?? [], ".", ".xzor");
  t.include = add(t.include ?? ["**/*.ts"], ".xzor/**/*.ts");
});

const ignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
const lines = ignore.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""));
const missing = ["node_modules", ".xzor", "dist"].filter((l) => !lines.includes(l));
if (missing.length) {
  appendFileSync(".gitignore", (ignore && !ignore.endsWith("\n") ? "\n" : "") + missing.map((l) => `${l}/\n`).join(""));
  console.log(`  .gitignore: ${ignore ? "updated" : "created"}`);
}

if (!existsSync("main.ts")) {
  writeFileSync("main.ts", `import { type IApplication, Mount } from "@source-crafter/xzor-runtime";
import Counter from "./Counter.xzor";

@Mount(Counter, "app")
export class Application implements IApplication {}
`);
  if (!existsSync("Counter.xzor"))
    writeFileSync("Counter.xzor", `@code {
  count = 0;
}

<button @onclick="() => count++">Clicked @count times</button>
@if (count >= 10) {
  <p>That's a lot of clicks!</p>
}
`);
  if (!existsSync("index.html"))
    writeFileSync("index.html", `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>xzor app</title></head>
  <body>
    <div id="app"></div>
    <script type="module" src="./dist/main.js"></script>
  </body>
</html>
`);
  console.log("  starter app: main.ts, Counter.xzor, index.html");
}
