import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const init = resolve(import.meta.dir, "../npm/xzor/bin/init.ts");
const tmp = join(import.meta.dir, "../target/tmp-init");
mkdirSync(tmp, { recursive: true });

const run = (gitignore?: string) => {
  const cwd = mkdtempSync(join(tmp, "p-"));
  if (gitignore !== undefined) writeFileSync(join(cwd, ".gitignore"), gitignore);
  const p = Bun.spawnSync(["bun", init], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  return readFileSync(join(cwd, ".gitignore"), "utf8").split(/\r?\n/);
};

test("init's .gitignore lists sw.js as a file and the folders with a slash", () => {
  const lines = run();
  expect(lines).toContain("sw.js");
  expect(lines).not.toContain("sw.js/");
  expect(lines).toEqual(expect.arrayContaining(["node_modules/", ".xzor/", "dist/"]));
});

test("init keeps an existing sw.js or /sw.js line without duplicating it", () => {
  for (const entry of ["sw.js", "/sw.js"]) {
    const lines = run(`${entry}\n`);
    expect(lines.filter((l) => l.replace(/^\//, "") === "sw.js")).toHaveLength(1);
  }
});
