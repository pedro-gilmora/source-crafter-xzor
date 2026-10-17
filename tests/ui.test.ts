import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-ui");
const slash = (p: string) => p.replaceAll("\\", "/");

const app = `@import Stat from "@source-crafter/xzor-ui/Stat.xzor"

@code {
  revenue = 10;
}

<Stat label="Revenue" value="@revenue" unit="$" delta="@(-2)" />
<button class="bump" @onclick="() => revenue++">bump</button>
`;

const main = `import "@source-crafter/xzor-ui";
import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

mount(App, document.getElementById("app")!);
`;

const xzor = (...args: string[]) => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", ...args], { cwd: root });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
};

test("an app imports kit components and CSS from @source-crafter/xzor-ui", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = {
    "@source-crafter/xzor-runtime": [slash(join(root, "runtime", "index.ts"))],
    "@source-crafter/xzor-runtime/model": [slash(join(root, "runtime", "model.ts"))],
    "@source-crafter/xzor-ui": [slash(join(root, "ui", "index.ts"))],
    "@source-crafter/xzor-ui/*": [slash(join(root, "ui", ".xzor", "*.ts"))],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "App.xzor"), app);
  writeFileSync(join(dir, "main.ts"), main);
  const kit = xzor("compile", "ui");
  expect(kit.code, kit.out).toBe(0);
  const built = xzor("build", dir);
  expect(built.code, built.out).toBe(0);
  expect(readFileSync(join(dir, "dist", "main.css"), "utf8")).toContain("xz.tokens");

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const stat = document.querySelector("#app .xz-stat")!;
  expect(stat.querySelector("strong")!.textContent).toBe("10$");
  expect(stat.querySelector(".xz-badge")!.getAttribute("data-tone")).toBe("danger");
  (document.querySelector("#app .bump") as HTMLElement).click();
  expect(stat.querySelector("strong")!.textContent).toBe("11$");
}, 180_000);
