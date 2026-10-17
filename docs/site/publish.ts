// `bun docs/site/publish.ts [base]`: highlights the snippets, builds the kit, the site and the example apps with xzor,
// and writes docs/site/_site (the apps under examples/<name>/).
// `base` is the path GitHub Pages serves it under (`/<repo>/`); "/" serves it from the root.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const here = import.meta.dir;
const root = join(here, "../..");
const base = (process.argv[2] ?? "/").replace(/^\/?/, "/").replace(/\/?$/, "/");
const out = join(here, "_site");
const examples = ["dashboard", "blog", "sales"];

const xzor = (...args: string[]) => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--release", "--", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) process.exit(run.exitCode ?? 1);
};

await import("./highlight.ts");
xzor("compile", "ui");
xzor("build", "docs/site");
for (const name of examples) xzor("build", `examples/${name}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(here, "dist"), join(out, "dist"), { recursive: true });
const html = (await Bun.file(join(here, "index.html")).text()).replace('<base href="/" />', `<base href="${base}" />`);
await Bun.write(join(out, "index.html"), html);
// GitHub Pages answers unknown paths with 404.html: the same app, which then routes the address itself.
// A deep link into an example app (which has no 404 of its own there) goes to that app's start.
const toExample = `<script>const m = location.pathname.match(/^(.*\\/examples\\/[^/]+\\/)./); if (m) location.replace(m[1]);</script>`;
await Bun.write(join(out, "404.html"), html.replace("<head>", `<head>\n    ${toExample}`));
// The PWA files, when the site has them, keep their relative paths.
for (const file of ["sw.js", "manifest.webmanifest"]) if (existsSync(join(here, file))) cpSync(join(here, file), join(out, file));
if (existsSync(join(here, "manifest.webmanifest"))) {
  const manifest = await Bun.file(join(here, "manifest.webmanifest")).json().catch(() => null);
  const icons: unknown[] = Array.isArray(manifest?.icons) ? manifest.icons : [];
  for (const icon of icons) {
    const src = (icon as { src?: unknown } | null)?.src;
    if (typeof src !== "string" || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    // Only files inside the site; a `../` src would write outside `_site`.
    const rel = relative(here, resolve(here, src));
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(join(here, rel)) || !statSync(join(here, rel)).isFile()) continue;
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    cpSync(join(here, rel), join(out, rel));
  }
}
await Bun.write(join(out, ".nojekyll"), "");

// Each example: its page with the base it is served under, its bundle and, for the PWA, its manifest, icons and worker.
for (const name of examples) {
  const app = join(root, "examples", name);
  const dest = join(out, "examples", name);
  mkdirSync(dest, { recursive: true });
  cpSync(join(app, "dist"), join(dest, "dist"), { recursive: true });
  const page = (await Bun.file(join(app, "index.html")).text()).replace('<base href="/" />', `<base href="${base}examples/${name}/" />`);
  await Bun.write(join(dest, "index.html"), page);
  for (const extra of ["manifest.webmanifest", "sw.js", "icons"]) {
    if (existsSync(join(app, extra))) cpSync(join(app, extra), join(dest, extra), { recursive: true });
  }
}
console.log(`site written to ${out} (base ${base})`);
