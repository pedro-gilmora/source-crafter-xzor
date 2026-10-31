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

const list = `@typeparam T

@code {
  items: T[] = [];
  selected?: T;
}

<ul>
  @for (let i = 0; i < items.length; i++) {
    <li>@(String(items[i]))</li>
  }
</ul>
`;

const host = (body: string) => `@import Row from "./Row.xzor"
@import List from "./List.xzor"

@code {
  names: string[] = ["a", "b"];
}

${body}
`;

function build(name: string, body: string, listSource = list, files: Record<string, string> = {}) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  // The example's relative `paths` entry does not reach the runtime from here.
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "Row.xzor"), row);
  writeFileSync(join(dir, "List.xzor"), listSource);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
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
  // Line 10 of Host.xzor is the `<Row lable=...>` line.
  expect(r.out).toMatch(/Host\.xzor\(10,\d+\): error TS2561/);
  expect(r.out).toContain("'lable' does not exist in type 'Partial<Row>'");
}, 120_000);

test("a generic component without T= has its props checked outside a row", () => {
  const r = build("generic-plain", `<List items="@names" selected="@(3)" />`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.xzor\(8,\d+\): error TS/);
}, 120_000);

test("a generic component without T= has its props checked in a @for row", () => {
  const r = build("generic-row-bad", `<ul>\n  @for (const n of names) {\n    <List items="@names" selected="@(3)" />\n  }\n</ul>`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.xzor\(10,\d+\): error TS/);
}, 120_000);

test("a generic component without T= has its props checked in a row, mistyped and misspelled", () => {
  const bad = build("generic-row-misspelled", `<ul>\n  @for (const n of names) {\n    <List items="@names" selcted="@n" />\n  }\n</ul>`);
  expect(bad.code).not.toBe(0);
  expect(bad.out).toMatch(/Host\.xzor\(10,\d+\): error TS/);
}, 120_000);

test("a correct generic component in a @for row compiles, with and without T=", () => {
  const r = build("generic-row-ok", `<ul>\n  @for (const n of names) {\n    <List items="@names" selected="@n" />\n    <List T="string" items="@names" selected="@n" />\n    <List items="@[n.length]" selected="@n.length" />\n  }\n</ul>`);
  expect(r.code, r.out).toBe(0);
}, 120_000);

test("explicit T= in a @for row still checks the props", () => {
  const r = build("generic-row-explicit", `<ul>\n  @for (const n of names) {\n    <List T="string" items="@names" selected="@(3)" />\n  }\n</ul>`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.xzor\(10,\d+\): error TS2322/);
}, 120_000);

test("a mistyped prop on a plain child component fails at the .xzor line", () => {
  const r = build("mistyped", `<Row label="x" count="@('x')" />`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.xzor\(8,\d+\): error TS2322/);
  expect(r.out).toContain("Type 'string' is not assignable to type 'number'");
}, 120_000);

// The constraint's type is imported by the component, not by the host that uses it.
const bounded = list.replace("@typeparam T", "@import { type Item } from \"./item\"\n@typeparam T extends Item");
const item = { "item.ts": "export type Item = { length: number };\n" };

test("a generic component with a constraint is checked in a row and outside it", () => {
  const ok = build("bounded-ok", `<List items="@names" selected="@names[0]" />\n<ul>\n  @for (const n of names) {\n    <List items="@names" selected="@n" />\n  }\n</ul>`, bounded, item);
  expect(ok.code, ok.out).toBe(0);
  const bad = build("bounded-bad", `<ul>\n  @for (const n of names) {\n    <List items="@names" selected="@(3)" />\n  }\n</ul>`, bounded, item);
  expect(bad.code).not.toBe(0);
  expect(bad.out).toMatch(/Host\.xzor\(10,\d+\): error TS/);
}, 120_000);