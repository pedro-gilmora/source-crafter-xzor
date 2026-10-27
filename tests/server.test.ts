import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The server fixture built like an app ships: `xzor build --minify` with the type check, then `bun dist/server.js`.
const repo = join(import.meta.dir, "..");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");
const dir = join(repo, "target", "tmp-serve", `e2e-${process.pid}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The first URL the process prints. */
async function printedUrl(out: ReadableStream<Uint8Array>): Promise<URL> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of out) {
    text += decoder.decode(chunk, { stream: true });
    const m = text.match(/https?:\/\/\S+/);
    if (m) return new URL(m[0]);
  }
  throw new Error(`the server printed no URL:\n${text}`);
}

test("a server app builds its browser views and dist/server.js, and the server serves shells, endpoints and files", async () => {
  const b = Bun.spawnSync(["cargo", "build", "-q"], { cwd: repo });
  expect(b.exitCode, b.stderr.toString()).toBe(0);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(import.meta.dir, "fixtures", "server"), dir, { recursive: true, filter: (src) => !/[\\/](\.xzor|node_modules|dist)$/.test(src) });
  // No port: the server takes PORT from the environment.
  const app = join(dir, "server", "app.ts");
  writeFileSync(app, readFileSync(app, "utf8").replace(/\r?\n\s*port = 3000;/, ""));

  const built = Bun.spawnSync([exe, "build", dir, "--minify"], { cwd: repo });
  const log = built.stdout.toString() + built.stderr.toString();
  expect(built.exitCode, log).toBe(0);
  expect(log).toContain("type check passed");
  const dist = (file: string) => readFileSync(join(dir, "dist", file), "utf8");
  // The browser bundle keeps index.html's name; the server bundle ships without a map and is never listed.
  expect(existsSync(join(dir, "dist", "main.js"))).toBe(true);
  expect(existsSync(join(dir, "dist", "client.js"))).toBe(false);
  expect(existsSync(join(dir, "dist", "server.js.map"))).toBe(false);
  const pages = JSON.parse(dist("pages.json"));
  expect(pages.routes).toEqual({ "/": "pages/Home.html", "/posts/:slug": "pages/Post.html" });
  expect(pages.files).toContain("dist/main.js");
  expect(pages.files).toContain("dist/index.html");
  expect(pages.files).not.toContain("dist/server.js");
  expect(pages.files).not.toContain("index.html");
  // index.html has neither the script nor the stylesheet: the build adds both.
  const index = dist("index.html");
  expect(index).toContain('<link rel="stylesheet" href="dist/main.css">\n</head>');
  expect(index).toContain('<script type="module" src="dist/main.js"></script>\n</body>');
  const home = dist("pages/Home.html");
  expect(home).toContain('<link rel="modulepreload" href="dist/chunks/');
  expect(home).toContain('<script type="module" src="dist/main.js"></script>');

  const server = Bun.spawn(["bun", "dist/server.js"], { cwd: dir, env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "inherit" });
  // The test preload's happy-dom fetch can't reach a real server.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  try {
    const url = await printedUrl(server.stdout);
    const call = async (method: string, path: string, body?: unknown): Promise<[number, string]> => {
      const r = await fetch(new URL(path, url), { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return [r.status, await r.text()];
    };
    expect(await call("GET", "/")).toEqual([200, home]);
    expect(await call("GET", "/posts/x")).toEqual([200, dist("pages/Post.html")]);
    expect(await call("POST", "/api/posts", { title: "Hello World" })).toEqual([200, '{"title":"Hello World","slug":"hello-world"}']);
    expect(await call("GET", "/api/posts/hello-world")).toEqual([200, '{"title":"Hello World","slug":"hello-world"}']);
    expect(await call("GET", "/api/posts/x")).toEqual([404, ""]);
    expect(await call("GET", "/dist/main.js")).toEqual([200, dist("main.js")]);
    expect((await call("GET", "/dist/server.js"))[0]).toBe(404);
    expect(await call("GET", "/nope")).toEqual([404, index]);
  } finally {
    server.kill();
    await server.exited;
    GlobalRegistrator.register();
  }
}, 180_000);
