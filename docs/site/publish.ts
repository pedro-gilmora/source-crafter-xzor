// `bun docs/site/publish.ts [base]`: highlights the snippets, builds the site with xzor and writes docs/site/_site.
// `base` is the path GitHub Pages serves it under (`/<repo>/`); "/" serves it from the root.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const root = join(here, "../..");
const base = (process.argv[2] ?? "/").replace(/^\/?/, "/").replace(/\/?$/, "/");
const out = join(here, "_site");

await import("./highlight.ts");
const build = Bun.spawnSync(["cargo", "run", "-q", "--release", "--", "build", "docs/site"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(here, "dist"), join(out, "dist"), { recursive: true });
cpSync(join(here, "styles.css"), join(out, "styles.css"));
const html = (await Bun.file(join(here, "index.html")).text()).replace('<base href="/" />', `<base href="${base}" />`);
await Bun.write(join(out, "index.html"), html);
// GitHub Pages answers unknown paths with 404.html: the same app, which then routes the address itself.
await Bun.write(join(out, "404.html"), html);
// The PWA files, when the site has them, keep their relative paths.
for (const file of ["sw.js", "manifest.webmanifest"]) if (existsSync(join(here, file))) cpSync(join(here, file), join(out, file));
if (existsSync(join(here, "manifest.webmanifest"))) {
  const { icons = [] } = await Bun.file(join(here, "manifest.webmanifest")).json();
  for (const { src } of icons) {
    if (typeof src !== "string" || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src) || !existsSync(join(here, src))) continue;
    mkdirSync(join(out, src, ".."), { recursive: true });
    cpSync(join(here, src), join(out, src));
  }
}
await Bun.write(join(out, ".nojekyll"), "");
console.log(`site written to ${out} (base ${base})`);
