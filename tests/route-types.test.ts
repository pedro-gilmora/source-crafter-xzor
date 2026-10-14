import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const base = join(root, "target", "tmp-route-types");

const userPage = `@page "/users/:id" as admin

@code {
  id = 0;
}

<p>@id</p>
`;

const app = (body: string) => `@ClientRoutes(route) {
  @default(page) {
    ${body}
    @page
  }
}
`;

function build(name: string, body: string) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  tsconfig.compilerOptions.strict = true;
  tsconfig.compilerOptions.noUncheckedIndexedAccess = true;
  tsconfig.compilerOptions.noPropertyAccessFromIndexSignature = true;
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "UserPage.tszor"), userPage);
  writeFileSync(join(dir, "App.tszor"), app(body));
  writeFileSync(join(dir, "main.ts"), `import App from "./App.tszor";\nexport { App };\n`);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir, "--no-bundle"], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

test("route.is(tag) narrows params to the tag's route", () => {
  const r = build("ok", `@if (route.is("admin")) { <b>@route.params.id.toFixed(0)</b> }`);
  expect(r.code, r.out).toBe(0);
});

test("route.is rejects a tag no page declares", () => {
  const r = build("typo", `@if (route.is("typo")) { <b/> }`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/App\.tszor\(\d+,\d+\)/);
  expect(r.out).toContain('"typo"');
});

test("route.is does not leave params untyped for a tag of another page", () => {
  const r = build("params", `@if (route.is("admin")) { <b>@route.params.nope</b> }`);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/Property 'nope' does not exist/);
});
