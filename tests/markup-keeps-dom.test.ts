import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-markup-keeps-dom");
const slash = (p: string) => p.replaceAll("\\", "/");

const app = `@code {
  name = "a";
  log: string[] = [];
  field?: HTMLInputElement;
  renderItem(name: string) {
    return <label><input class="f" @ref="this.field" /> <span>@name</span> <button @onclick="() => this.log.push(name)">go</button></label>;
  }
}

@renderItem(name)
`;

const main = `import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

(globalThis as any).app = mount(App, document.getElementById("app")!);
`;

const tick = () => new Promise<void>((r) => setTimeout(r));

test("a markup value from a method keeps its DOM, focus and typed text when it changes", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [slash(join(root, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [slash(join(root, "runtime", "model.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "App.xzor"), app);
  writeFileSync(join(dir, "main.ts"), main);
  const built = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  expect(built.exitCode, built.stdout.toString() + built.stderr.toString()).toBe(0);

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const c = (globalThis as any).app as { name: string; log: string[]; field?: HTMLInputElement };
  const host = document.getElementById("app")!;
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
