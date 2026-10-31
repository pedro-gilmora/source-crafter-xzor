import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", `tmp-shake-${process.pid}`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a minified app ships only the dom bindings it calls, and no router without routes", () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "Page.xzor"), `@code {\n  count = 1;\n}\n<p>@count</p>\n`);
  writeFileSync(join(dir, "main.ts"), `import { mount } from "@source-crafter/xzor-runtime";\nimport Page from "./Page.xzor";\n\nmount(Page, document.getElementById("app")!);\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  const dist = join(dir, "dist");
  const js = readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, f), "utf8")).join("\n");
  expect(js).toContain("function textAt(");
  for (const unused of ["function routesAt(", "function cascadeAt(", "function piecesAt(", "function keyedAt(", "popstate", "pushState"]) expect(js, unused).not.toContain(unused);
});
