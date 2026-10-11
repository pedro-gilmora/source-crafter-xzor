// Bundles a zor app with Bun. `./X.tszor` imports resolve to the generated `<project>/.zor/<rel>/X.tszor.ts`.
// Usage: bun bundle.ts <entry> <outdir>
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const [entry, outdir] = process.argv.slice(2);
if (!entry || !outdir) throw new Error("usage: bun bundle.ts <entry> <outdir>");

function projectRoot(dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "tsconfig.json"))) return d;
    if (dirname(d) === d) return dir;
  }
}

function generatedPath(source: string): string {
  if (existsSync(`${source}.ts`)) return `${source}.ts`;
  const root = projectRoot(dirname(source));
  return join(root, ".zor", `${relative(root, source)}.ts`);
}

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  sourcemap: "linked",
  plugins: [
    {
      name: "zor",
      setup(build) {
        build.onResolve({ filter: /\.tszor$/ }, (args) => ({
          path: generatedPath(resolve(dirname(args.importer), args.path)),
        }));
      },
    },
  ],
});

for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
for (const output of result.outputs) console.log(`  ${output.path}`);
