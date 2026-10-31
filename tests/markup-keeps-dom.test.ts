import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const slash = (p: string) => p.replaceAll("\\", "/");
const tick = () => new Promise<void>((r) => setTimeout(r));

const main = `import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

(globalThis as any).app = mount(App, document.getElementById("app")!);
`;

/** Builds an app of `files` (App.xzor, ...) in its own folder, mounts it on the page, and gives its component. */
async function load<T>(name: string, files: Record<string, string>): Promise<{ app: T; host: HTMLElement }> {
  const dir = join(root, "target", "tmp-markup-keeps-dom", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [slash(join(root, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [slash(join(root, "runtime", "model.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "main.ts"), main);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  const built = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);
  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  return { app: (globalThis as any).app as T, host: document.getElementById("app")! };
}

test("a markup value from a method keeps its DOM, focus and typed text when it changes", async () => {
  const { app: c, host } = await load<{ name: string; log: string[]; field?: HTMLInputElement }>("value", {
    "App.xzor": `@code {
  name = "a";
  log: string[] = [];
  field?: HTMLInputElement;
  renderItem(name: string) {
    return <label><input class="f" @ref="this.field" /> <span>@name</span> <button @onclick="() => this.log.push(name)">go</button></label>;
  }
}

@renderItem(name)
`,
  });
  const input = host.querySelector("input")!;
  const label = host.querySelector("label")!;
  const button = host.querySelector("button")!;
  expect(host.querySelector("span")!.textContent).toBe("a");
  expect(c.field).toBe(input);

  input.focus();
  input.value = "typed";
  c.name = "b";
  await tick();

  expect(host.querySelector("input")).toBe(input);
  expect(host.querySelector("label")).toBe(label);
  expect(host.querySelector("button")).toBe(button);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("typed");
  expect(host.querySelector("span")!.textContent).toBe("b");
  // The ref is the element on screen, not the template's master.
  expect(c.field).toBe(input);
  // The handler is the new value's.
  button.click();
  expect(c.log).toEqual(["b"]);
}, 120000);

test("a @{ } loop of markup statements keeps the pieces it emits again, across N -> N+1 -> N-1", async () => {
  const { app: c, host } = await load<{ items: { name: string }[] }>("loop", {
    "App.xzor": `@code {
  items = [{ name: "a" }, { name: "b" }, { name: "c" }];
}

<ul>@{
  for (const x of items) {
    <li><input/> @x.name</li>
  }
}</ul>
`,
  });
  const lis = () => [...host.querySelectorAll("li")];
  const inputs = () => [...host.querySelectorAll("input")];
  const first = lis();
  const firstInputs = inputs();
  expect(first.map((l) => l.textContent)).toEqual([" a", " b", " c"]);
  firstInputs.forEach((e, i) => (e.value = "typed" + i));

  c.items = [...c.items, { name: "d" }];
  await tick();
  expect(lis().slice(0, 3)).toEqual(first);
  expect(inputs().slice(0, 3)).toEqual(firstInputs);
  expect(inputs().map((e) => e.value)).toEqual(["typed0", "typed1", "typed2", ""]);
  expect(lis().map((l) => l.textContent)).toEqual([" a", " b", " c", " d"]);

  c.items = [{ name: "a2" }, { name: "b" }, { name: "c" }];
  await tick();
  expect(lis()).toEqual(first);
  expect(inputs().map((e) => e.value)).toEqual(["typed0", "typed1", "typed2"]);
  expect(lis().map((l) => l.textContent)).toEqual([" a2", " b", " c"]);
  expect(host.querySelectorAll("ul > li").length).toBe(3);
}, 120000);

test("an if in a @{ } block that switches the site emitted builds and disposes the right pieces", async () => {
  const { app: c, host } = await load<{ mode: number; tag: string; n: number }>("sites", {
    "App.xzor": `@code {
  mode = 0;
  tag = "x";
  n = 1;
}

<div>@{
  const t = tag;
  if (mode === 0) {
    <p><input/> one @t @n</p>
  } else {
    <section><input/> two @t @n</section>
  }
}<i>end</i></div>
`,
  });
  const p = host.querySelector("p")!;
  const end = host.querySelector("i")!;
  expect(p.textContent).toBe(" one x 1");
  p.querySelector("input")!.value = "typed";

  // Same site again: the piece is claimed, its input and typed text stay.
  c.tag = "y";
  await tick();
  expect(host.querySelector("p")).toBe(p);
  expect(p.querySelector("input")!.value).toBe("typed");
  expect(p.textContent).toBe(" one y 1");
  expect(host.querySelector("i")).toBe(end);

  // Another site: the old piece goes (and stops updating), the new one is built.
  c.mode = 1;
  await tick();
  const section = host.querySelector("section")!;
  expect(host.querySelector("p")).toBeNull();
  expect(p.isConnected).toBe(false);
  expect(section.textContent).toBe(" two y 1");
  c.n = 2;
  await tick();
  expect(section.textContent).toBe(" two y 2");
  expect(p.textContent).toBe(" one y 1");
  expect(host.querySelector("i")).toBe(end);
  expect(host.querySelector("div")!.children.length).toBe(2);

  // Back: a fresh piece, not the disposed one.
  c.mode = 0;
  await tick();
  expect(host.querySelector("section")).toBeNull();
  const again = host.querySelector("p")!;
  expect(again).not.toBe(p);
  expect(again.textContent).toBe(" one y 2");
  expect(host.querySelector("i")).toBe(end);
}, 120000);

test("a child component inside a piece keeps its instance when the block runs again with new props", async () => {
  const { app: c, host } = await load<{ tag: string; child?: { label: string } }>("child", {
    "App.xzor": `@import Child from "./Child.xzor"
@code {
  tag = "x";
  child?: Child;
}

<div>@{
  const t = tag;
  <Child @ref="child" label="@t!" />
}</div>
`,
    "Child.xzor": `@code {
  label = "";
}

<b><input/> @label</b>
`,
  });
  const b = host.querySelector("b")!;
  const child = c.child;
  expect(child).toBeDefined();
  expect(b.textContent).toBe(" x!");
  b.querySelector("input")!.value = "typed";

  c.tag = "y";
  await tick();
  expect(host.querySelector("b")).toBe(b);
  expect(c.child).toBe(child);
  expect(child!.label).toBe("y!");
  expect(b.textContent).toBe(" y!");
  expect(b.querySelector("input")!.value).toBe("typed");
}, 120000);


test("a loop running @{ } code keeps its common rows (nodes and typed values) across N -> N+1 -> N-1", async () => {
  const { app: c, host } = await load<{ names: string[]; n: number }>("code-loop", {
    "App.xzor": `@code {
  names = ["a", "b", "c", "d"];
  n = 3;
}

<ul>@for (let i = 0; i < n; i++) {
  @{ const c = names[i]; }
  <li><input/> @c</li>
}</ul>
`,
  });
  const lis = () => [...host.querySelectorAll("li")];
  const inputs = () => [...host.querySelectorAll("input")];
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const first = lis();
  const firstInputs = inputs();
  expect(first.map((l) => l.textContent)).toEqual([" a", " b", " c"]);
  firstInputs.forEach((e, i) => (e.value = "typed" + i));

  c.n = 4;
  await tick();
  expect(same(lis().slice(0, 3), first)).toBe(true);
  expect(same(inputs().slice(0, 3), firstInputs)).toBe(true);
  expect(inputs().map((e) => e.value)).toEqual(["typed0", "typed1", "typed2", ""]);
  expect(lis().map((l) => l.textContent)).toEqual([" a", " b", " c", " d"]);

  c.n = 2;
  await tick();
  expect(same(lis(), first.slice(0, 2))).toBe(true);
  expect(inputs().map((e) => e.value)).toEqual(["typed0", "typed1"]);
  expect(first[2]!.isConnected).toBe(false);

  // What the code reads is read again: the kept rows follow it.
  c.names = ["A", "B", "C", "D"];
  await tick();
  expect(same(lis(), first.slice(0, 2))).toBe(true);
  expect(lis().map((l) => l.textContent)).toEqual([" A", " B"]);
  expect(inputs().map((e) => e.value)).toEqual(["typed0", "typed1"]);
  expect(host.querySelectorAll("ul > li").length).toBe(2);
}, 120000);

test("a branch running @{ } code keeps its nodes when the same branch runs again, and builds anew for another", async () => {
  const { app: c, host } = await load<{ mode: number; tag: string }>("code-branch", {
    "App.xzor": `@code {
  mode = 0;
  tag = "x";
}

<div>@if (mode === 0) {
  @{ const t = tag; }
  <p><input/> one @t</p>
} else {
  @{ const t = tag; }
  <section><input/> two @t</section>
}<i>end</i></div>
`,
  });
  const p = host.querySelector("p")!;
  const end = host.querySelector("i")!;
  p.querySelector("input")!.value = "typed";

  c.tag = "y";
  await tick();
  expect(host.querySelector("p") === p).toBe(true);
  expect(p.querySelector("input")!.value).toBe("typed");
  expect(p.textContent).toBe(" one y");
  expect(host.querySelector("i") === end).toBe(true);

  c.mode = 1;
  await tick();
  expect(host.querySelector("p")).toBeNull();
  expect(p.isConnected).toBe(false);
  expect(host.querySelector("section")!.textContent).toBe(" two y");
  expect(host.querySelector("input")!.value).toBe("");
  expect(host.querySelector("i") === end).toBe(true);
}, 120000);

test("a top-level @{ } block and the nodes after it keep their DOM when it runs again", async () => {
  const { app: c, host } = await load<{ n: number }>("code-top", {
    "App.xzor": `@code {
  n = 1;
}

<div>@{ const total = n * 2; }<b><input/> @total</b><i>@total</i></div>
`,
  });
  const b = host.querySelector("b")!;
  const i = host.querySelector("i")!;
  b.querySelector("input")!.value = "typed";
  c.n = 5;
  await tick();
  expect(host.querySelector("b") === b).toBe(true);
  expect(host.querySelector("i") === i).toBe(true);
  expect(b.querySelector("input")!.value).toBe("typed");
  expect(b.textContent).toBe(" 10");
  expect(i.textContent).toBe("10");
}, 120000);

test("a child component in a loop running @{ } code keeps its instance and state", async () => {
  const { app: c, host } = await load<{ n: number; tag: string }>("code-child", {
    "App.xzor": `@import Child from "./Child.xzor"
@code {
  n = 2;
  tag = "x";
}

<div>@for (let i = 0; i < n; i++) {
  @{ const t = tag + i; }
  <Child label="@t" />
}</div>
`,
    "Child.xzor": `@code {
  label = "";
}

<b><input/> @label</b>
`,
  });
  const bs = () => [...host.querySelectorAll("b")];
  const first = bs();
  expect(first.map((b) => b.textContent)).toEqual([" x0", " x1"]);
  first.forEach((b, k) => (b.querySelector("input")!.value = "typed" + k));

  c.tag = "y";
  c.n = 3;
  await tick();
  expect(bs().slice(0, 2).every((b, k) => b === first[k])).toBe(true);
  expect(bs().map((b) => b.textContent)).toEqual([" y0", " y1", " y2"]);
  expect(bs().map((b) => b.querySelector("input")!.value)).toEqual(["typed0", "typed1", ""]);

  c.n = 1;
  await tick();
  expect(bs().length).toBe(1);
  expect(bs()[0] === first[0]).toBe(true);
  expect(bs()[0]!.querySelector("input")!.value).toBe("typed0");
}, 120000);


test("nested control flow and elements holding code inside a loop's pieces region keep their DOM", async () => {
  const { app: c, host } = await load<{ rows: number[]; on: boolean }>("code-nested", {
    "App.xzor": `@code {
  rows = [1, 2];
  on = true;
}

<ul>@for (let i = 0; i < rows.length; i++) {
  @{ const r = rows[i]; }
  <li><input/> @r</li>
  @if (on) {
    @{ const dbl = r * 2; }
    <li class="dbl"><input/> @dbl</li>
  }
  <li class="el">@{ const sq = r * r; }<u>@sq</u></li>
} else {
  <li class="none">none</li>
}</ul>
`,
  });
  const lis = () => [...host.querySelectorAll("li")];
  const texts = () => lis().map((l) => l.textContent);
  const first = lis();
  expect(texts()).toEqual([" 1", " 2", "1", " 2", " 4", "4"]);
  first.forEach((l, k) => l.querySelector("input") && (l.querySelector("input")!.value = "typed" + k));

  c.rows = [1, 2, 3];
  await tick();
  expect(lis().slice(0, 6).every((l, k) => l === first[k])).toBe(true);
  expect(texts()).toEqual([" 1", " 2", "1", " 2", " 4", "4", " 3", " 6", "9"]);
  expect(lis()[1]!.querySelector("input")!.value).toBe("typed1");

  // The `@if` inside the pass goes: its pieces leave, the others stay.
  c.on = false;
  await tick();
  expect(texts()).toEqual([" 1", "1", " 2", "4", " 3", "9"]);
  expect(lis()[0] === first[0] && lis()[1] === first[2] && lis()[2] === first[3]).toBe(true);
  expect(lis()[0]!.querySelector("input")!.value).toBe("typed0");

  // The loop's else.
  c.rows = [];
  await tick();
  expect(texts()).toEqual(["none"]);
}, 120000);
