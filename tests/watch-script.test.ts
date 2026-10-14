import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "src", "watch.ts");
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Spawns `bun src/watch.ts <root>` and resolves once the empty "ready" line arrived. */
async function start(root: string) {
  const proc = Bun.spawn(["bun", script, root], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  cleanups.push(() => {
    proc.kill();
    rmSync(root, { recursive: true, force: true });
  });
  let output = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) output += decoder.decode(chunk);
  })();
  const until = async (done: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await Bun.sleep(25);
    return done();
  };
  expect(await until(() => output.includes("\n"), 10_000)).toBe(true);
  return {
    pid: proc.pid,
    lines: () => output.split("\n").slice(1).filter(Boolean),
    until,
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), "xzor-watch-"));

test("reports a file inside a directory created after start", async () => {
  const root = tmp();
  const w = await start(root);
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "a", "b", "x.xzor"), "<p/>");
  expect(await w.until(() => w.lines().includes("a/b/x.xzor"), 3000)).toBe(true);
});

test.skipIf(process.platform !== "linux")("does not watch inside ignored directories", async () => {
  const root = tmp();
  let deep = join(root, "node_modules");
  for (let i = 1; i <= 200; i++) {
    deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
  }
  mkdirSync(join(root, "src"));
  const w = await start(root);
  let watches = 0;
  for (const fd of readdirSync(`/proc/${w.pid}/fdinfo`)) {
    try {
      watches += readFileSync(`/proc/${w.pid}/fdinfo/${fd}`, "utf8").split("\n").filter((l) => l.startsWith("inotify wd:")).length;
    } catch {}
  }
  expect(watches).toBeLessThan(20);
  writeFileSync(join(root, "node_modules", "d1", "x.ts"), "");
  await Bun.sleep(500);
  expect(w.lines()).toEqual([]);
  writeFileSync(join(root, "src", "y.ts"), "");
  expect(await w.until(() => w.lines().includes("src/y.ts"), 3000)).toBe(true);
});

test.skipIf(process.platform !== "linux")("re-watches a directory removed and recreated under the same name", async () => {
  const root = tmp();
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "d", "a.ts"), "");
  const w = await start(root);
  rmSync(join(root, "d"), { recursive: true });
  mkdirSync(join(root, "d"));
  await Bun.sleep(300);
  writeFileSync(join(root, "d", "new.ts"), "");
  expect(await w.until(() => w.lines().includes("d/new.ts"), 3000)).toBe(true);
});

test.skipIf(process.platform !== "linux")("re-watches a renamed directory under its new name", async () => {
  const root = tmp();
  mkdirSync(join(root, "a"));
  const w = await start(root);
  renameSync(join(root, "a"), join(root, "z"));
  await Bun.sleep(300);
  writeFileSync(join(root, "z", "x.ts"), "");
  expect(await w.until(() => w.lines().includes("z/x.ts"), 3000)).toBe(true);
});

test("exits non-zero with the error on stderr when the root cannot be watched", async () => {
  const proc = Bun.spawn(["bun", script, join(tmp(), "missing")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => proc.kill());
  expect(await proc.exited).not.toBe(0);
  expect((await new Response(proc.stderr).text()).length).toBeGreaterThan(0);
  expect(await new Response(proc.stdout).text()).toBe("");
});
