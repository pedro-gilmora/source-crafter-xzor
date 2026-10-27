import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("init --server writes client/, contracts/ and server/ with @types/bun", () => {
  const cwd = mkdtempSync(join(tmp, "s-"));
  const p = Bun.spawnSync(["bun", init, "--server"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const read = (f: string) => readFileSync(join(cwd, f), "utf8");
  expect(read("server/app.ts")).toContain("@Run(Shell)");
  expect(read("server/app.ts")).toContain("implements IServerApplication");
  expect(read("server/api/hello.ts")).toContain('@Endpoints("/api/hello")');
  expect(read("contracts/hello.ts")).toContain("interface IHello");
  expect(read("client/Home.xzor")).toContain('@page "/"');
  expect(existsSync(join(cwd, "client/Shell.xzor"))).toBe(true);
  expect(existsSync(join(cwd, "main.ts"))).toBe(false);
  expect(read("index.html")).not.toContain('id="app"');
  expect(JSON.parse(read("package.json")).devDependencies["@types/bun"]).toBeTruthy();
  expect(JSON.parse(read("tsconfig.json")).compilerOptions.types).toEqual(["bun"]);
});
