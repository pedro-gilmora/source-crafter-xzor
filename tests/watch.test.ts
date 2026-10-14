import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-watch");
const exe = join(root, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");

let proc: ReturnType<typeof Bun.spawn>;
let output = "";
// Lines seen so far; `waitFor` consumes up to and including its match.
let cursor = 0;

async function pump(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) output += decoder.decode(chunk);
}

async function waitFor(text: string, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const at = output.indexOf(text, cursor);
    if (at >= 0) {
      const seen = output.slice(cursor, at + text.length);
      cursor = at + text.length;
      return seen;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for "${text}". Output so far:\n${output}`);
}

/** Lets in-flight events settle, then asserts nothing else was printed (no rebuild loop). */
async function quiet(ms = 1500) {
  const before = output.length;
  await Bun.sleep(ms);
  expect(output.slice(before)).toBe("");
}

beforeAll(async () => {
  expect(Bun.spawnSync(["cargo", "build", "-q"], { cwd: root }).exitCode).toBe(0);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  writeFileSync(join(dir, "A.xzor"), "<p>a</p>\n");
  writeFileSync(join(dir, "B.xzor"), "<p>b</p>\n");
  writeFileSync(join(dir, "main.ts"), `import A from "./A.xzor";\nexport { A };\n`);
  proc = Bun.spawn([exe, "build", dir, "--watch", "--no-bundle"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  const first = await waitFor("watching");
  expect(first).toContain("compiled 2 component(s)");
  expect(first).toContain("type check passed");
}, 120_000);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("an edit recompiles only that component, once", async () => {
  writeFileSync(join(dir, "A.xzor"), "<p>a2</p>\n");
  const seen = await waitFor("watching");
  expect(seen).toContain("compiled 1 component(s)");
  expect(seen).toContain("type check passed");
  expect(readFileSync(join(dir, ".xzor", "A.xzor.ts"), "utf8")).toContain("a2");
  await quiet();
}, 30_000);

test("a type error is reported, and fixing it rebuilds", async () => {
  writeFileSync(join(dir, "B.xzor"), "@code { n: number = \"x\"; }\n<p>@n</p>\n");
  const bad = await waitFor("watching");
  expect(bad).toMatch(/B\.xzor\(\d+,\d+\)/);
  writeFileSync(join(dir, "B.xzor"), "<p>b</p>\n");
  expect(await waitFor("watching")).toContain("type check passed");
  await quiet();
}, 30_000);

test("a new component is picked up and a deleted one is removed", async () => {
  writeFileSync(join(dir, "C.xzor"), "<p>c</p>\n");
  expect(await waitFor("watching")).toContain("compiled 1 component(s)");
  rmSync(join(dir, "C.xzor"));
  await waitFor("watching");
  await Bun.sleep(100);
  expect(() => readFileSync(join(dir, ".xzor", "C.xzor.ts"))).toThrow();
  await quiet();
}, 30_000);

test("removing the only page removes the route table", async () => {
  writeFileSync(join(dir, "E.xzor"), `@page "/e"\n<p>e</p>\n`);
  expect(await waitFor("watching")).toContain("type check passed");
  expect(readFileSync(join(dir, ".xzor", "routes.ts"), "utf8")).toContain(`"/e"`);
  rmSync(join(dir, "E.xzor"));
  await waitFor("watching");
  expect(() => readFileSync(join(dir, ".xzor", "routes.ts"))).toThrow();
  await quiet();
}, 30_000);

test("the route table is rebuilt only when components change, and removed with the last unit of a project", async () => {
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "tsconfig.json"), "{}");
  writeFileSync(join(dir, "sub", "P.xzor"), `@page "/p"\n<p>p</p>\n`);
  await waitFor("watching");
  const table = join(dir, "sub", ".xzor", "routes.ts");
  expect(readFileSync(table, "utf8")).toContain(`"/p"`);

  // A .ts-only batch leaves the table alone.
  rmSync(table);
  writeFileSync(join(dir, "util.ts"), "export const u = 1;\n");
  await waitFor("watching");
  await Bun.sleep(100);
  expect(() => readFileSync(table)).toThrow();

  writeFileSync(join(dir, "sub", "P.xzor"), `@page "/q"\n<p>p</p>\n`);
  await waitFor("watching");
  expect(readFileSync(table, "utf8")).toContain(`"/q"`);
  rmSync(join(dir, "sub", "P.xzor"));
  await waitFor("watching");
  expect(() => readFileSync(table)).toThrow();
  await quiet();
}, 30_000);

test("a tsconfig.json change rebuilds everything", async () => {
  writeFileSync(join(dir, "tsconfig.json"), readFileSync(join(dir, "tsconfig.json"), "utf8") + "\n");
  const seen = await waitFor("watching");
  expect(seen).toContain("project configuration changed");
  expect(seen).toContain("compiled 2 component(s)");
  await quiet();
}, 30_000);

test("renaming a member of an inherited .ts base recompiles the inheriting component", async () => {
  const base = (name: string) =>
    `import { ComponentBase } from "@source-crafter/xzor-runtime";\nexport abstract class Titled extends ComponentBase { ${name} = "t"; }\n`;
  writeFileSync(join(dir, "base.ts"), base("title"));
  await waitFor("watching");
  writeFileSync(join(dir, "D.xzor"), `@import { Titled } from "./base"\n@inherits Titled\n<p>@title</p>\n`);
  expect(await waitFor("watching")).toContain("type check passed");
  expect(readFileSync(join(dir, ".xzor", "D.xzor.ts"), "utf8")).toContain("this.title");
  writeFileSync(join(dir, "base.ts"), base("heading"));
  const seen = await waitFor("watching");
  expect(seen).toContain("compiled 1 component(s)");
  expect(seen).toMatch(/D\.xzor\(\d+,\d+\)/);
  expect(readFileSync(join(dir, ".xzor", "D.xzor.ts"), "utf8")).toContain("addContent(title)");
  await quiet();
}, 30_000);

// `--hot` with bundling on, in its own project so the suite above keeps `--no-bundle`.
describe("build --watch --hot", () => {
  const hotDir = join(root, "target", "tmp-watch-hot");
  let hotProc: ReturnType<typeof Bun.spawn>;
  let hotOut = "";
  let hotCursor = 0;

  async function hotWait(text: string, ms = 30_000): Promise<string> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const at = hotOut.indexOf(text, hotCursor);
      if (at >= 0) {
        const seen = hotOut.slice(hotCursor, at + text.length);
        hotCursor = at + text.length;
        return seen;
      }
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for "${text}". Output so far:\n${hotOut}`);
  }

  beforeAll(async () => {
    rmSync(hotDir, { recursive: true, force: true });
    mkdirSync(hotDir, { recursive: true });
    const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
    tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
    writeFileSync(join(hotDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    writeFileSync(join(hotDir, "App.xzor"), "<p>app</p>\n");
    writeFileSync(join(hotDir, "main.ts"), `import App from "./App.xzor";\nexport { App };\n`);
    hotProc = Bun.spawn([exe, "build", hotDir, "--watch", "--hot"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    for (const stream of [hotProc.stdout, hotProc.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) hotOut += decoder.decode(chunk);
      })();
    }
    const first = await hotWait("watching", 60_000);
    expect(first).toContain("type check passed");
    expect(first).not.toContain("xzor: hot");
  }, 120_000);

  afterAll(() => {
    hotProc?.kill();
    rmSync(hotDir, { recursive: true, force: true });
  });

  test("hot lines for a .xzor-only change", async () => {
    writeFileSync(join(hotDir, "App.xzor"), "<p>app2</p>\n");
    const seen = await hotWait("watching");
    const hot = seen.indexOf("xzor: hot .xzor/App.xzor.ts");
    expect(hot).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("main.js")).toBeGreaterThan(hot);
  }, 40_000);

  test("no hot lines when a .ts changes", async () => {
    writeFileSync(join(hotDir, "main.ts"), `import App from "./App.xzor";\nexport { App };\n// touched\n`);
    const seen = await hotWait("watching");
    expect(seen).toContain("main.js");
    expect(seen).not.toContain("xzor: hot");
  }, 40_000);

  test("no hot lines on a compile error", async () => {
    writeFileSync(join(hotDir, "App.xzor"), "<p>\n");
    const seen = await hotWait("watching");
    expect(seen).not.toContain("xzor: hot");
  }, 40_000);
});
