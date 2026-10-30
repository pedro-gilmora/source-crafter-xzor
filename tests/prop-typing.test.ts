import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const base = join(root, "target", "tmp-prop-typing");

const row = `@code {
  label: string = "";
  count: number = 0;
}

<li>@label @count</li>
`;

const host = (body: string) => `@import Row from "./Row.xzor"

@code {
  names: string[] = ["a", "b"];
}

${body}
`;

function build(name: string, body: string) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  // The example's relative `paths` entry does not reach the runtime from here.
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "Row.xzor"), row);
  writeFileSync(join(dir, "Host.xzor"), host(body));
  writeFileSync(join(dir, "main.ts"), `import Host from "./Host.xzor";\nexport { Host };\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir, "--no-bundle"], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

test("valid props on a child, plain and in a list row, type check", () => {
  const r = build("ok", `<Row label="x" count="@(1)" />\n<ul>@for (const n of names) {<Row label="@n" count="@n.length" />}</ul>`);
  expect(r.code, r.out).toBe(0);
}, 120_000);

test("a misspelled prop on a child component in a @for row fails at the .xzor line", () => {
  const r = build("misspelled", `<ul>\n  @for (const n of names) {\n    <Row lable="@n" />\n  }\n</ul>`);
  expect(r.code).not.toBe(0);
  // Line 9 of Host.xzor is the `<Row lable=...>` line.
  expect(r.out).toMatch(/Host\.xzor\(9,\d+\): error TS2561/);
  expect(r.out).toContain("'lable' does not exist in type 'Partial<Row>'");
}, 120_000);

test("a mistyped prop on a plain child component fails at the .xzor line", () => {
  const r = build("mistyped", `<Row label="x" count="@('x')" />`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.xzor\(7,\d+\): error TS2322/);
  expect(r.out).toContain("Type 'string' is not assignable to type 'number'");
}, 120_000);
