import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-watch");
const exe = join(root, "target", "debug", process.platform === "win32" ? "zor.exe" : "zor");

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
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  writeFileSync(join(dir, "A.tszor"), "<p>a</p>\n");
  writeFileSync(join(dir, "B.tszor"), "<p>b</p>\n");
  writeFileSync(join(dir, "main.ts"), `import A from "./A.tszor";\nexport { A };\n`);
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
  writeFileSync(join(dir, "A.tszor"), "<p>a2</p>\n");
  const seen = await waitFor("watching");
  expect(seen).toContain("compiled 1 component(s)");
  expect(seen).toContain("type check passed");
  expect(readFileSync(join(dir, ".zor", "A.tszor.ts"), "utf8")).toContain("a2");
  await quiet();
}, 30_000);

test("a type error is reported, and fixing it rebuilds", async () => {
  writeFileSync(join(dir, "B.tszor"), "@code { n: number = \"x\"; }\n<p>@n</p>\n");
  const bad = await waitFor("watching");
  expect(bad).toMatch(/B\.tszor\(\d+,\d+\)/);
  writeFileSync(join(dir, "B.tszor"), "<p>b</p>\n");
  expect(await waitFor("watching")).toContain("type check passed");
  await quiet();
}, 30_000);

test("a new component is picked up and a deleted one is removed", async () => {
  writeFileSync(join(dir, "C.tszor"), "<p>c</p>\n");
  expect(await waitFor("watching")).toContain("compiled 1 component(s)");
  rmSync(join(dir, "C.tszor"));
  await waitFor("watching");
  await Bun.sleep(100);
  expect(() => readFileSync(join(dir, ".zor", "C.tszor.ts"))).toThrow();
  await quiet();
}, 30_000);

test("removing the only page removes the route table", async () => {
  writeFileSync(join(dir, "E.tszor"), `@page "/e"\n<p>e</p>\n`);
  expect(await waitFor("watching")).toContain("type check passed");
  expect(readFileSync(join(dir, ".zor", "routes.ts"), "utf8")).toContain(`"/e"`);
  rmSync(join(dir, "E.tszor"));
  await waitFor("watching");
  expect(() => readFileSync(join(dir, ".zor", "routes.ts"))).toThrow();
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
    `import { ComponentBase } from "@zor/runtime";\nexport abstract class Titled extends ComponentBase { ${name} = "t"; }\n`;
  writeFileSync(join(dir, "base.ts"), base("title"));
  await waitFor("watching");
  writeFileSync(join(dir, "D.tszor"), `@import { Titled } from "./base"\n@inherits Titled\n<p>@title</p>\n`);
  expect(await waitFor("watching")).toContain("type check passed");
  expect(readFileSync(join(dir, ".zor", "D.tszor.ts"), "utf8")).toContain("this.title");
  writeFileSync(join(dir, "base.ts"), base("heading"));
  const seen = await waitFor("watching");
  expect(seen).toContain("compiled 1 component(s)");
  expect(seen).toMatch(/D\.tszor\(\d+,\d+\)/);
  expect(readFileSync(join(dir, ".zor", "D.tszor.ts"), "utf8")).toContain("addContent(title)");
  await quiet();
}, 30_000);
