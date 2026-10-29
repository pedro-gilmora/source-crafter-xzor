import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

// `xzor serve` (npm/xzor/bin/serve.ts) on built-from-source apps: a browser-only app served from dist/, a server app run through dist/server.js.
const repo = join(import.meta.dir, "..");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");
const script = join(repo, "npm", "xzor", "bin", "serve.ts");
const base = join(repo, "target", "tmp-serve", `serve-${process.pid}`);
const toPosix = (p: string) => p.replaceAll("\\", "/");

const html = `<!doctype html>\n<html>\n<head>\n  <title>x</title>\n</head>\n<body><div id="app"></div><script type="module" src="dist/main.js"></script></body>\n</html>\n`;
const sources: Record<string, string> = {
  "Home.xzor": `@page "/"\n\n<p class="home">home</p>\n`,
  "Post.xzor": `@page "/posts/:slug"\n\n@code {\n  slug = "";\n}\n\n<p class="post">@slug</p>\n`,
  "App.xzor": `@Routes(route) {\n  @default(page) { <main>@page</main> }\n}\n`,
  "main.ts": `import { mount } from "@source-crafter/xzor-runtime";\nimport App from "./App.xzor";\n\nmount(App, document.getElementById("app")!);\n`,
};
const plain: Record<string, string> = {
  "Home.xzor": `<p class="home">home</p>\n`,
  "main.ts": `import { mount } from "@source-crafter/xzor-runtime";\nimport Home from "./Home.xzor";\n\nmount(Home, document.getElementById("app")!);\n`,
};

/** What lies in or beside dist/ but is not part of the build's served files. */
const hidden = ["/dist/main.js.map", "/main.ts", "/tsconfig.json", "/.env", "/dist/pages.json"];
const expectHidden = async (url: URL) => {
  for (const path of hidden) expect([path, (await fetch(new URL(path, url))).status]).toEqual([path, 404]);
};

function browserApp(name: string, files: Record<string, string>): string {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(repo, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [toPosix(join(repo, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [toPosix(join(repo, "runtime", "model.ts"))],
    "@source-crafter/xzor-runtime/server": [toPosix(join(repo, "runtime", "server.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "index.html"), html);
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

const running: Bun.Subprocess[] = [];
/** Runs `xzor serve` and resolves with the URL it prints; `stop` ends it and the server it started. */
async function serve(dir: string, ...args: string[]): Promise<{ url: URL; out: string; stop: () => Promise<void> }> {
  const proc = Bun.spawn(["bun", script, exe, dir, ...args], { cwd: repo, stdout: "pipe", stderr: "inherit" });
  running.push(proc);
  const stop = async () => {
    // Killing only the launcher would leave a server app's `dist/server.js` running.
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
    else proc.kill();
    await proc.exited;
  };
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of proc.stdout) {
    out += decoder.decode(chunk, { stream: true });
    const m = /xzor: serving (\S+)/.exec(out);
    if (m) return { url: new URL(m[1]!), out, stop };
  }
  throw new Error(`xzor serve printed no URL:\n${out}`);
}

beforeAll(async () => {
  const b = Bun.spawnSync(["cargo", "build", "-q"], { cwd: repo });
  expect(b.exitCode, b.stderr.toString()).toBe(0);
  // The test preload's happy-dom fetch can't reach a real server.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
}, 120_000);
afterAll(async () => {
  for (const p of running) if (p.exitCode === null) p.kill();
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  for (const d of [base, `${base}-server`]) rmSync(d, { recursive: true, force: true });
});

test("a browser-only app is served from dist/: page shells, files, and index.html as the 404", async () => {
  const dir = browserApp("pages", sources);
  const s = await serve(dir, "--port", "0");
  try {
    expect(s.url.hostname).toBe("localhost");
    const dist = (file: string) => readFileSync(join(dir, "dist", file), "utf8");
    const home = await fetch(new URL("/", s.url));
    expect(home.status).toBe(200);
    const text = await home.text();
    expect(text).toBe(dist("pages/Home.html"));
    expect(text).toContain("modulepreload");
    const post = await fetch(new URL("/posts/x", s.url));
    expect([post.status, await post.text()]).toEqual([200, dist("pages/Post.html")]);
    const js = await fetch(new URL("/dist/main.js", s.url));
    expect([js.status, await js.text()]).toEqual([200, dist("main.js")]);
    const miss = await fetch(new URL("/nope", s.url));
    expect([miss.status, await miss.text()]).toEqual([404, html]);
    expect(existsSync(join(dir, "dist", "main.js.map"))).toBe(true);
    await expectHidden(s.url);
  } finally {
    await s.stop();
  }
}, 120_000);

test("a browser-only app with no @page serves index.html and its bundle", async () => {
  const dir = browserApp("plain", plain);
  const s = await serve(dir, "--port=0");
  try {
    const index = await fetch(new URL("/", s.url));
    expect([index.status, await index.text()]).toEqual([200, html]);
    expect((await fetch(new URL("/index.html", s.url))).status).toBe(200);
    expect((await fetch(new URL("/dist/main.js", s.url))).status).toBe(200);
    expect((await fetch(new URL("/nope", s.url))).status).toBe(404);
    expect(existsSync(join(dir, "dist", "main.js.map"))).toBe(true);
    await expectHidden(s.url);
  } finally {
    await s.stop();
  }
}, 120_000);

/** The server fixture; its `port = 3000` is replaced by `members` so the server takes PORT and HOST from the environment. */
function serverApp(members = ""): string {
  const dir = `${base}-server`;
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(import.meta.dir, "fixtures", "server"), dir, { recursive: true, filter: (src) => !/[\\/](\.xzor|node_modules|dist)$/.test(src) });
  const app = join(dir, "server", "app.ts");
  writeFileSync(app, readFileSync(app, "utf8").replace(/\r?\n\s*port = 3000;/, members));
  return dir;
}
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const reach = (port: string) => fetch(`http://${lan}:${port}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => "unreachable");

test("a server app listens on localhost unless --host says otherwise", async () => {
  const dir = serverApp();
  const local = await serve(dir, "--port", "0");
  try {
    expect((await fetch(new URL("/", local.url))).status).toBe(200);
    if (lan) expect(await reach(local.url.port)).toBe("unreachable");
  } finally {
    await local.stop();
  }
  const open = await serve(dir, "--port", "0", "--host", "0.0.0.0");
  try {
    if (lan) expect(await reach(open.url.port)).toBe(200);
    else expect((await fetch(`http://127.0.0.1:${open.url.port}/`)).status).toBe(200);
  } finally {
    await open.stop();
  }
}, 120_000);

test("a server app's own hostname wins over --host", async () => {
  const dir = serverApp('\n  hostname = "localhost";');
  const s = await serve(dir, "--port", "0", "--host", "0.0.0.0");
  try {
    expect((await fetch(new URL("/", s.url))).status).toBe(200);
    if (lan) expect(await reach(s.url.port)).toBe("unreachable");
  } finally {
    await s.stop();
  }
}, 120_000);

test("a server app runs through dist/server.js", async () => {
  const dir = serverApp();
  const s = await serve(dir, "--port", "0");
  try {
    expect(existsSync(join(dir, "dist", "server.js"))).toBe(true);
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    await expectHidden(s.url);
    expect((await fetch(new URL("/dist/server.js", s.url))).status).toBe(404);
    // An endpoint: only the server answers it.
    const api = await fetch(new URL("/api/posts/x", s.url));
    expect(api.status).toBe(404);
    const created = await fetch(new URL("/api/posts", s.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hello World" }) });
    expect([created.status, await created.text()]).toEqual([200, '{"title":"Hello World","slug":"hello-world"}']);
    expect((await fetch(new URL("/", s.url))).status).toBe(200);
  } finally {
    await s.stop();
  }
}, 120_000);

test("a failed build stops before serving", async () => {
  const dir = browserApp("broken", { ...sources, "main.ts": `const x: number = "no";\nexport {};\n` });
  const run = Bun.spawnSync(["bun", script, exe, dir, "--port", "0"], { cwd: repo });
  expect(run.exitCode).not.toBe(0);
  expect(run.stdout.toString()).not.toContain("xzor: serving");
}, 120_000);
