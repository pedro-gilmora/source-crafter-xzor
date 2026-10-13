import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-inherits");

const base = `import { ComponentBase } from "@zor/runtime";
export interface Named { readonly name: string }
export abstract class Titled extends ComponentBase {
  title = "base";
  abstract readonly name: string;
  describe() { return \`\${this.title}:\${this.name}\`; }
}
export abstract class Generic<T> extends ComponentBase { item?: T; }
export function tag(label: string) { return (target: Function, _ctx: ClassDecoratorContext) => { (target as any).label = label; }; }
`;

test("components use inherited members as bare names and pass the type check", () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "base.ts"), base);
  writeFileSync(
    join(dir, "Card.tszor"),
    `@import { Titled, tag, type Named } from "./base"\n@inherits Titled\n@implements Named\n@attribute tag("card")\n@code { readonly name = "card"; }\n<h1>@title</h1>\n<p>@describe()</p>\n`,
  );
  writeFileSync(join(dir, "Box.tszor"), `@import { Generic } from "./base"\n@typeparam T\n@inherits Generic<T>\n<p>@String(item)</p>\n`);
  writeFileSync(join(dir, "main.ts"), `import Card from "./Card.tszor";\nimport Box from "./Box.tszor";\nexport { Card, Box };\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir, "--no-bundle"], { cwd: root });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, out).toBe(0);
  expect(readFileSync(join(dir, ".zor", "Card.tszor.ts"), "utf8")).toContain("this.describe()");
  expect(readFileSync(join(dir, ".zor", "Box.tszor.ts"), "utf8")).toContain("String(this.item)");
}, 120_000);
