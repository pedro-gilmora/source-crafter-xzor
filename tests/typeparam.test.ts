import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const base = join(root, "target", "tmp-typeparam");

const list = `@typeparam T

@code {
  items: T[] = [];
  selected?: T;
}

<ul>
  @for (let i = 0; i < items.length; i++) {
    <li>@slot:item(items[i] as T) { @(String(items[i])) }</li>
  }
</ul>
`;

const host = (body: string) => `@import List from "./List.tszor"

@code {
  names: string[] = ["a", "b"];
}

<List items="@names" selected="@names[0]">
  @slot item(x) { ${body} }
</List>
`;

function build(name: string, body: string) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  // The example's relative `paths` entry does not reach the runtime from here.
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "List.tszor"), list);
  writeFileSync(join(dir, "Host.tszor"), host(body));
  writeFileSync(join(dir, "main.ts"), `import Host from "./Host.tszor";\nexport { Host };\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir, "--no-bundle"], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

test("a generic component infers its type parameter from props, including slot parameters", () => {
  const r = build("ok", "@x.toUpperCase()");
  expect(r.code, r.out).toBe(0);
});

test("a slot body that misuses the inferred type fails at the .tszor line", () => {
  const r = build("bad", "@{ const n: number = x; }");
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Host\.tszor\(\d+,\d+\)/);
  expect(r.out).toContain("string");
});
