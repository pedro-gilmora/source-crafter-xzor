import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { pageShells } from "../src/bundle";

const root = join(import.meta.dir, "..");
const base = join(root, "target", `tmp-shells-${process.pid}`);
const toPosix = (p: string) => p.replaceAll("\\", "/");

afterAll(() => rmSync(base, { recursive: true, force: true }));

const index = (head = "") => `<!doctype html>\n<html>\n<head>\n  <title>x</title>${head}\n</head>\n<body><div id="app"></div><script type="module" src="dist/main.js"></script></body>\n</html>\n`;

const files: Record<string, string> = {
  "Home.xzor": `@page "/"\n\n<p class="home">home</p>\n`,
  "Post.xzor": `@page "/posts/:slug"\n@page "/p/:slug"\n\n@code {\n  slug = "";\n}\n\n<p class="post">@slug</p>\n`,
  "About.xzor": `@page "/about"\n\n<p class="about">about</p>\n`,
  "App.xzor": `@Routes(route) {\n  @default(page) { <main>@page</main> }\n}\n`,
  "main.ts": `import { mount } from "@source-crafter/xzor-runtime";\nimport App from "./App.xzor";\n\nmount(App, document.getElementById("app")!);\n`,
};

/** Builds a project with `--minify` and returns its folder and the build's output. */
function build(name: string, html: string | undefined, sources = files): { dir: string; exitCode: number; out: string } {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [toPosix(join(root, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [toPosix(join(root, "runtime", "model.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  if (html !== undefined) writeFileSync(join(dir, "index.html"), html);
  for (const [file, text] of Object.entries(sources)) writeFileSync(join(dir, file), text);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir, "--minify"], { cwd: root });
  return { dir, exitCode: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

const preloads = (html: string): string[] => [...html.matchAll(/<link rel="modulepreload" href="([^"]*)">/g)].map((m) => m[1]!);

test("each page gets a shell preloading its closure", () => {
  const { dir, exitCode, out } = build("closure", index());
  expect(exitCode, out).toBe(0);
  const chunks = readdirSync(join(dir, "dist", "chunks")).filter((c) => c.endsWith(".js"));
  const entry = readFileSync(join(dir, "dist", "main.js"), "utf8");
  const shared = chunks.filter((c) => !c.includes(".xzor-"));
  expect(shared.length, chunks.join()).toBeGreaterThan(0);
  for (const c of shared) expect(entry, c).toContain(c);

  const html = readFileSync(join(dir, "dist", "pages", "Post.html"), "utf8");
  const hrefs = preloads(html);
  expect(hrefs.some((h) => /^dist\/chunks\/Post\.xzor-[^/]+\.js$/.test(h)), hrefs.join()).toBe(true);
  for (const c of shared) expect(hrefs, c).toContain(`dist/chunks/${c}`);
  expect(hrefs.some((h) => h.includes("Home.xzor-"))).toBe(false);
  expect(hrefs.some((h) => h.includes("About.xzor-"))).toBe(false);
  expect(hrefs.includes("dist/main.js")).toBe(false);
  expect(new Set(hrefs).size).toBe(hrefs.length);
  // index.html unchanged but for the links, which sit in the head.
  expect(html.indexOf("modulepreload")).toBeLessThan(html.indexOf("</head>"));
  expect(html.replace(/<link rel="modulepreload"[^\n]*\n?/g, "")).toBe(index());
}, 120_000);

test("pages.json maps every pattern", () => {
  const { dir, exitCode, out } = build("manifest", index());
  expect(exitCode, out).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "dist", "pages.json"), "utf8")) as { routes: Record<string, string>; files: string[] };
  expect(manifest.routes).toEqual({
    "/": "pages/Home.html",
    "/posts/:slug": "pages/Post.html",
    "/p/:slug": "pages/Post.html",
    "/about": "pages/About.html",
  });
  for (const shell of new Set(Object.values(manifest.routes))) expect(existsSync(join(dir, "dist", shell)), shell).toBe(true);
  const chunks = readdirSync(join(dir, "dist", "chunks")).filter((c) => c.endsWith(".js"));
  expect(manifest.files).toContain("dist/main.js");
  expect(manifest.files).toContain("index.html");
  for (const c of chunks) expect(manifest.files).toContain(`dist/chunks/${c}`);
  for (const shell of ["Home", "Post", "About"]) expect(manifest.files).toContain(`dist/pages/${shell}.html`);
  expect(manifest.files.some((f) => f.endsWith(".map"))).toBe(false);
  expect(manifest.files.some((f) => f.endsWith("server.js"))).toBe(false);
  expect(manifest.files.every((f) => !f.includes("\\") && !f.startsWith("/"))).toBe(true);
}, 120_000);

test("hrefs stay relative under a base", () => {
  const { dir, exitCode, out } = build("base", index().replace("<head>", `<head>\n  <base href="/docs/">`));
  expect(exitCode, out).toBe(0);
  const html = readFileSync(join(dir, "dist", "pages", "Post.html"), "utf8");
  const hrefs = preloads(html);
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) expect(h.startsWith("dist/"), h).toBe(true);
}, 120_000);

test("index.html without </head> fails the build", () => {
  const { exitCode, out } = build("nohead", `<html><body><div id="app"></div></body></html>`);
  expect(exitCode).not.toBe(0);
  expect(out).toContain("index.html has no </head>");
}, 120_000);

test("a page the entry imports itself preloads only what the entry already loads", () => {
  // The entry's own import makes the page's module a chunk shared with it, so the shell adds nothing beyond the entry's closure.
  const sources = { ...files, "main.ts": files["main.ts"]!.replace(`import App`, `import Home from "./Home.xzor";\nimport App`).replace("mount(", "console.log(Home);\nmount(") };
  const { dir, exitCode, out } = build("inline", index(), sources);
  expect(exitCode, out).toBe(0);
  const hrefs = preloads(readFileSync(join(dir, "dist", "pages", "Home.html"), "utf8"));
  const entry = readFileSync(join(dir, "dist", "main.js"), "utf8");
  expect(hrefs.length).toBeGreaterThan(0);
  for (const h of hrefs) {
    expect(h.startsWith("dist/chunks/"), h).toBe(true);
    expect(entry, h).toContain(h.slice("dist/chunks/".length));
  }
}, 120_000);

test("no index.html writes no shells", () => {
  const { dir, exitCode, out } = build("noindex", undefined);
  expect(exitCode, out).toBe(0);
  expect(existsSync(join(dir, "dist", "pages"))).toBe(false);
  expect(existsSync(join(dir, "dist", "pages.json"))).toBe(false);
}, 120_000);

test("pageShells: closure of static imports, deduped, dynamic imports left out", () => {
  const outdir = join(root, "x", "dist");
  const meta = {
    inputs: {},
    outputs: {
      "main.js": {
        entryPoint: "x/main.ts",
        inputs: { "x/main.ts": {} },
        imports: [
          { path: "./chunks/Post.xzor-a.js", kind: "dynamic-import" },
          { path: "./chunks/Home.xzor-b.js", kind: "dynamic-import" },
          { path: "./chunks/main-c.js", kind: "import-statement" },
        ],
      },
      "./chunks/main-c.js": { inputs: { "runtime/index.ts": {} }, imports: [] },
      "./chunks/Post.xzor-a.js": {
        entryPoint: "x/.xzor/Post.xzor.ts",
        inputs: { "x/.xzor/Post.xzor.ts": {} },
        imports: [
          { path: "./chunks/main-c.js", kind: "import-statement" },
          { path: "./chunks/lib-d.js", kind: "import-statement" },
          { path: "./chunks/Late.xzor-e.js", kind: "dynamic-import" },
        ],
      },
      "./chunks/lib-d.js": { inputs: {}, imports: [{ path: "./chunks/main-c.js", kind: "import-statement" }] },
      "./chunks/Home.xzor-b.js": { entryPoint: "x/.xzor/Home.xzor.ts", inputs: { "x/.xzor/Home.xzor.ts": {} }, imports: [{ path: "./chunks/main-c.js", kind: "import-statement" }] },
      "./chunks/Late.xzor-e.js": { inputs: {}, imports: [] },
    },
  };
  const pages = [
    { pattern: "/posts/:slug", file: "Post.xzor", name: "Post" },
    { pattern: "/p/:slug", file: "Post.xzor", name: "Post" },
    { pattern: "/", file: "Home.xzor", name: "Home" },
    { pattern: "/gone", file: "Gone.xzor", name: "Gone" },
  ];
  const { shells, routes } = pageShells("<head></head>", meta, outdir, join(root, "x"), pages);
  expect(routes).toEqual({ "/posts/:slug": "pages/Post.html", "/p/:slug": "pages/Post.html", "/": "pages/Home.html", "/gone": "pages/Gone.html" });
  expect([...shells.keys()].sort()).toEqual(["pages/Gone.html", "pages/Home.html", "pages/Post.html"]);
  const links = (name: string) => preloads(shells.get(name)!);
  expect(links("pages/Post.html").sort()).toEqual(["dist/chunks/Post.xzor-a.js", "dist/chunks/lib-d.js", "dist/chunks/main-c.js"]);
  expect(links("pages/Home.html").sort()).toEqual(["dist/chunks/Home.xzor-b.js", "dist/chunks/main-c.js"]);
  expect(links("pages/Gone.html")).toEqual(["dist/chunks/main-c.js"]);
});

test("pageShells: no </head> throws", () => {
  expect(() => pageShells("<body></body>", { inputs: {}, outputs: {} }, "/o/dist", "/o", [])).toThrow("index.html has no </head>");
});

test("text outputs get .br and .gz copies", () => {
  const { dir, exitCode, out } = build("copies", index());
  expect(exitCode, out).toBe(0);
  const dist = join(dir, "dist");
  const texts = [join(dist, "main.js"), join(dist, "pages", "Post.html"), ...readdirSync(join(dist, "chunks")).filter((c) => c.endsWith(".js")).map((c) => join(dist, "chunks", c))];
  for (const file of texts) {
    const bytes = readFileSync(file);
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).equals(bytes), `${file}.br`).toBe(true);
    expect(gunzipSync(readFileSync(`${file}.gz`)).equals(bytes), `${file}.gz`).toBe(true);
  }
  // Copies are not listed: the server picks them by the request's Accept-Encoding.
  const manifest = JSON.parse(readFileSync(join(dist, "pages.json"), "utf8")) as { files: string[] };
  expect(manifest.files.some((f) => /\.(br|gz)$/.test(f))).toBe(false);
}, 120_000);

test("fonts are not compressed", () => {
  const sources = { ...files, "styles.css": `@font-face { font-family: F; src: url(./a.woff2) format("woff2"); }\nbody { font-family: F }\n`, "a.woff2": "wOF2 not a real font", "css.d.ts": `declare module "*.css";\n`, "main.ts": `import "./styles.css";\n${files["main.ts"]}` };
  const { dir, exitCode, out } = build("fonts", index(), sources);
  expect(exitCode, out).toBe(0);
  expect(existsSync(join(dir, "dist", "a.woff2")), "font copied").toBe(true);
  expect(readdirSync(join(dir, "dist")).filter((f) => f.includes(".woff2.")), "font copies").toEqual([]);
}, 120_000);

test("pages.json lists the local files index.html references", () => {
  const html = index(`\n  <link rel="icon" href="favicon.svg">\n  <link rel="icon" href="https://x/y.png">`);
  const { dir, exitCode, out } = build("favicon", html, { ...files, "favicon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
  expect(exitCode, out).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "dist", "pages.json"), "utf8")) as { files: string[] };
  expect(manifest.files).toContain("favicon.svg");
  expect(manifest.files.some((f) => f.includes("https:") || f.includes("y.png"))).toBe(false);
  expect(manifest.files).not.toContain("sw.js");
}, 120_000);

test("a PWA project lists its worker, manifest and icons", () => {
  const web = JSON.stringify({ name: "T", short_name: "T", display: "standalone", icons: [{ src: "icon.png", sizes: "192x192" }, { src: "/icon512.png", sizes: "512x512" }] });
  const { dir, exitCode, out } = build("pwa", index(), { ...files, "manifest.webmanifest": web, "icon.png": "a", "icon512.png": "b" });
  expect(exitCode, out).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "dist", "pages.json"), "utf8")) as { files: string[] };
  for (const f of ["sw.js", "manifest.webmanifest", "icon.png", "icon512.png"]) expect(manifest.files, f).toContain(f);
  expect(manifest.files).toEqual([...manifest.files].sort());
  // The worker's own list holds the shells and pages.json, not the copies.
  const worker = readFileSync(join(dir, "sw.js"), "utf8");
  expect(worker).toContain("dist/pages/Post.html");
  expect(worker).toContain("dist/pages.json");
}, 120_000);
