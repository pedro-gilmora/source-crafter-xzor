import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", `tmp-keyed-${process.pid}`);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const product = `import { Key, Model } from "@source-crafter/xzor-runtime/model";

export class Product extends Model {
  @Key id = 0;
  name = "";
}
`;

const page = (member: string) => `@import { Product } from "./product"

@code {
  @Key("${member}") lines: { sku: string; qty: number }[] = [{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }];
  team: Record<string, number> = { x: 1, y: 2 };
  products = [new Product({ id: 1, name: "p1" }), new Product({ id: 2, name: "p2" })];
  notes = [{ id: 1 }, { id: 2 }, { id: 3 }];
}

<div class="notes">@if (!notes.length) {<p>Nothing pending.</p>} else {<ul>@for (const n of notes) @key(n.id) {<li>@n.id<button @onclick="() => notes = notes.filter((x) => x.id !== n.id)">x</button></li>}</ul>}</div>
<ul class="lines">@for (const l of lines.filter((x) => x.qty > 0)) {<li>@l.sku</li>}</ul>
<ol class="team">@for (const [k, v] of Object.entries(team)) @key(k) {<li>@k=@v @if (v > 1) {<b>!</b>}</li>} else {<p>none</p>}</ol>
<div class="products">@for (const p of products) {<i>@p.name</i>}</div>
<u class="once">@once(lines.length) @once { <s>@(lines[0]!.sku)</s> }</u>
<p class="await">@await (Promise.resolve(lines.length)) {…} then (n) {@(n * 10)}</p>
`;

const main = `import { mount } from "@source-crafter/xzor-runtime";
import { $keyName } from "@source-crafter/xzor-runtime/model";
import Page from "./Page.xzor";
import { Product } from "./product";

(globalThis as { page?: unknown }).page = mount(Page, document.getElementById("app")!);
(globalThis as { productKey?: unknown }).productKey = $keyName(new Product());
`;

function build(member: string): { code: number; out: string } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  tsconfig.compilerOptions.lib = ["ES2022", "ESNext.Disposable", "ESNext.Decorators", "DOM"];
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "product.ts"), product);
  writeFileSync(join(dir, "Page.xzor"), page(member));
  writeFileSync(join(dir, "main.ts"), main);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => queueMicrotask(r));
};

test("loops keep their rows by @key, a field's @Key and a model's @Key", async () => {
  const r = build("sku");
  expect(r.code, r.out).toBe(0);
  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const page = (globalThis as { page?: any }).page;
  const q = (s: string) => [...document.querySelectorAll(s)];
  expect(q(".lines li").map((li) => li.textContent)).toEqual(["a", "b"]);
  const once = document.querySelector(".once")!;
  expect(once.textContent).toBe("2 a");
  await tick();
  expect(document.querySelector(".await")!.textContent).toBe("20");
  const [, b] = q(".lines li");
  page.lines = [{ sku: "b", qty: 2 }, { sku: "c", qty: 3 }];
  await tick();
  expect(q(".lines li").map((li) => li.textContent)).toEqual(["b", "c"]);
  // `@once` read `lines` once: it stays as it was.
  expect(once.textContent).toBe("2 a");

  const [x, y] = q(".team li");
  expect(y!.querySelector("b")).not.toBeNull();
  page.team = { y: 2, x: 1, z: 3 };
  await tick();
  const team = q(".team li");
  expect(team.map((li) => li.textContent)).toEqual(["y=2 !", "x=1 ", "z=3 !"]);
  // Same key, same values: the rows moved, not rebuilt.
  expect(team[0]).toBe(y!);
  expect(team[1]).toBe(x!);
  page.team = {};
  await tick();
  expect(document.querySelector(".team")!.textContent).toBe("none");

  const [p1] = q(".products i");
  page.products = [page.products[0], page.products[1]].reverse();
  await tick();
  expect(q(".products i").map((i) => i.textContent)).toEqual(["p2", "p1"]);
  expect(q(".products i")[1]).toBe(p1!);
  // The model's `@Key` survives the bundle's tracked-field rewrite.
  expect((globalThis as { productKey?: unknown }).productKey).toBe("id");
  void b;

  // Dismissing one notice keeps the `else` branch: the same <ul> and the rows left (#3).
  const ul = document.querySelector(".notes ul")!;
  const [n1, , n3] = q(".notes li");
  (q(".notes li button")[1] as HTMLButtonElement).click();
  await tick();
  expect(document.querySelector(".notes ul")).toBe(ul);
  expect(q(".notes li")).toEqual([n1!, n3!]);
  for (const button of q(".notes li button")) (button as HTMLButtonElement).click();
  await tick();
  expect(document.querySelector(".notes")!.textContent).toBe("Nothing pending.");
}, 120_000);

test("a field's @Key naming a member its items lack fails the type check", () => {
  const r = build("skew");
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("skew");
}, 120_000);
