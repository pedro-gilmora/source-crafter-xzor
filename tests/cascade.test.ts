import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-cascade");

const app = `@import Badge from "./Badge.tszor"

@code {
  theme = "dark";

  toggle() {
    this.theme = this.theme === "dark" ? "light" : "dark";
  }
}

@cascade:theme(theme) {
  <Badge />
}
<button @onclick="toggle">toggle</button>
`;

const badge = `@code {
  @Cascade theme!: string;
}

<span class="badge">@theme</span>
`;

const main = `import { mount } from "@zor/runtime";
import App from "./App.tszor";

mount(App, document.getElementById("app")!);
`;

test("a @Cascade member follows the value of its @cascade provider", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "App.tszor"), app);
  writeFileSync(join(dir, "Badge.tszor"), badge);
  writeFileSync(join(dir, "main.ts"), main);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, out).toBe(0);
  expect(readFileSync(join(dir, ".zor", "Badge.tszor.ts"), "utf8")).toContain(
    'static readonly cascades = [["theme", "theme"]] as const;',
  );

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const badgeText = () => document.querySelector("#app .badge")?.textContent;
  expect(badgeText()).toBe("dark");
  (document.querySelector("#app button") as HTMLElement).click();
  expect(badgeText()).toBe("light");
}, 120_000);
