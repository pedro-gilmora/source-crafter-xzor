import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-cascade");

const app = `@import Badge from "./Badge.tszor"

@code {
  theme = "dark";
  role = "admin";

  toggle() {
    this.theme = this.theme === "dark" ? "light" : "dark";
    this.role = "guest";
  }
}

@cascade:theme(theme) {
  @cascade:role(role, fixed) {
    <Badge />
  }
}
<button @onclick="toggle">toggle</button>
`;

const base = `@code {
  @Cascade theme!: string;
}
`;

const badge = `@import Base from "./Base.tszor"
@inherits Base

@code {
  @Cascade role!: string;
}

<span class="badge">@theme</span>
<span class="role">@role</span>
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
  writeFileSync(join(dir, "Base.tszor"), base);
  writeFileSync(join(dir, "Badge.tszor"), badge);
  writeFileSync(join(dir, "main.ts"), main);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, out).toBe(0);
  expect(readFileSync(join(dir, ".zor", "Badge.tszor.ts"), "utf8")).toContain(
    'static readonly cascades: readonly (readonly [string, string])[] = [...((Base as { cascades?: readonly (readonly [string, string])[] }).cascades ?? []), ["role", "role"]] as const;',
  );

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const text = (sel: string) => document.querySelector(`#app ${sel}`)?.textContent;
  expect(text(".badge")).toBe("dark");
  expect(text(".role")).toBe("admin");
  (document.querySelector("#app button") as HTMLElement).click();
  expect(text(".badge")).toBe("light");
  expect(text(".role")).toBe("admin");
}, 120_000);
