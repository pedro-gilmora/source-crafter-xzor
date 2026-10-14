import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Same depth below the repo as examples/counter, so its tsconfig paths still resolve.
const dir = join(root, "target", `tmp-rootdirs-${process.pid}`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the bundle resolves imports across the source and .xzor roots, like tsconfig rootDirs", () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "pages"), { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  // A value import from a generated component to a script beside its source.
  writeFileSync(join(dir, "pages", "base.ts"), `export const greeting = "from a script beside the page";\n`);
  writeFileSync(join(dir, "pages", "Home.xzor"), `@import { greeting } from "./base"\n<p class="home">@greeting</p>\n`);
  // And a script in the sources importing a generated module.
  writeFileSync(join(dir, "mount.ts"), `import Home from "./pages/Home.xzor";\nexport { Home };\n`);
  writeFileSync(join(dir, "main.ts"), `import { mount } from "@source-crafter/xzor-runtime";\nimport { Home } from "./mount";\nmount(Home, document.getElementById("app")!);\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  const bundle = readFileSync(join(dir, "dist", "main.js"), "utf8");
  expect(bundle).toContain("from a script beside the page");
}, 120_000);
