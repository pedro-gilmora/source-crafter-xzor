import { afterAll, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The blog built like it ships (`xzor build --minify`), its views reading posts through the generated IPosts client from `bun dist/server.js`.
const repo = join(import.meta.dir, "..");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");
// Same depth as examples/blog, so its tsconfig paths still reach ../../runtime and ../../ui.
const dir = join(repo, "target", `tmp-blog-${process.pid}`);
const happyDOM = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  // The bundled app's router keeps listening on this document; later test files get a fresh one.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  GlobalRegistrator.register();
});

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

const until = async (what: string, ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}:\n${document.body.innerHTML.slice(0, 600)}`);
};

test("the blog's pages read posts through IPosts from the running server, and the bundle holds no post", async () => {
  const b = Bun.spawnSync(["cargo", "build", "-q"], { cwd: repo });
  expect(b.exitCode, b.stderr.toString()).toBe(0);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(repo, "examples", "blog"), dir, { recursive: true, filter: (src) => !/[\\/](\.xzor|\.zed|node_modules|dist)$/.test(src) });
  // A slug with a space and a slash must survive the client's encoding and the server's decoding.
  const data = join(dir, "server", "posts-data.ts");
  const text = readFileSync(data, "utf8");
  expect(text).toContain('"page-transitions-for-free"');
  writeFileSync(data, text.replace('"page-transitions-for-free"', '"page transitions/for free"'));

  const built = Bun.spawnSync([exe, "build", dir, "--minify"], { cwd: repo });
  const log = built.stdout.toString() + built.stderr.toString();
  expect(built.exitCode, log).toBe(0);
  expect(log).toContain("type check passed");
  // No post reaches the browser: the data lives on the server only.
  const dist = (file: string) => readFileSync(join(dir, "dist", file), "utf8");
  for (const f of ["main.js", "pages/Post.html"]) expect(dist(f)).not.toContain("Glass is a stack of small effects");
  expect(dist("main.js")).not.toContain("Page transitions for free");
  expect(dist("server.js")).toContain("Glass is a stack of small effects");

  const server = Bun.spawn(["bun", "dist/server.js"], { cwd: dir, env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "inherit" });
  try {
    const url = await printedUrl(server.stdout);
    // The client fetches relative paths: the page lives on the server's origin.
    const slug = encodeURIComponent("page transitions/for free");
    expect(slug).toBe("page%20transitions%2Ffor%20free");
    happyDOM().setURL(new URL(`/posts/${slug}`, url).href);
    expect(location.pathname).toBe(`/posts/${slug}`);
    await import(join(dir, "dist", "main.js"));
    await until("the post title", () => document.querySelector("article h1")?.textContent === "Page transitions for free");
    expect(document.querySelector("article")?.textContent).toContain("Wrap the update in");
    // "Read next" comes with the post: the one after it in the list, by summary.
    await until("read next", () => document.querySelector(".next strong")?.textContent === "Components that measure their own box");

    // The wire: a list carries no body, tags answer on their own path, and a post slugged `tags` is not shadowed.
    const api = async (path: string) => (await fetch(new URL(path, url))).text();
    const listed = await api("/api/posts");
    expect(listed).toContain("Page transitions for free");
    expect(listed).not.toContain('"body"');
    expect(JSON.parse(await api("/api/tags"))).toEqual(["css", "design", "html", "layout", "motion"]);
    expect((await fetch(new URL("/api/posts/tags", url))).status).toBe(404);

    // The home page lists every post through list(), and a link keeps the slug encoded.
    (document.querySelector("a.brand") as HTMLElement).click();
    await until("the home list", () => document.querySelectorAll(".posts article").length === 4);
    const link = document.querySelector(`.posts a[href$="${slug}"]`) as HTMLElement | null;
    expect(link?.textContent).toBe("Page transitions for free");

    // A tag page lists the tags from tags() and its posts from list({ tag }); clicking another tag reuses the page and reloads.
    (document.querySelector(".posts .tags a") as HTMLElement).click();
    await until("#css", () => document.querySelector("h1")?.textContent === "#css" && document.querySelectorAll(".posts article").length === 4);
    expect([...document.querySelectorAll(".tag-list a")].map((a) => a.textContent)).toEqual(["#css", "#design", "#html", "#layout", "#motion"]);
    (document.querySelector('.tag-list a[href="/tags/layout"]') as HTMLElement).click();
    await until("#layout", () => document.querySelector("h1")?.textContent === "#layout" && document.querySelectorAll(".posts article").length === 1);
    expect(document.querySelector(".posts article h2")?.textContent).toBe("Components that measure their own box");
  } finally {
    server.kill();
    await server.exited;
  }
}, 240_000);
