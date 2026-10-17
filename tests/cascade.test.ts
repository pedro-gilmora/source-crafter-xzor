import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-cascade");

const app = `@import Badge from "./Badge.xzor"

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
@cascade:a(1) { @{ const tag = "a"; } <i class="one">@tag</i> }
@cascade:b(2) { @{ const tag = "b"; } <i class="two">@tag</i> }
<button @onclick="toggle">toggle</button>
`;

const base = `@code {
  @Cascade theme!: string;
}
`;

const badge = `@import Base from "./Base.xzor"
@inherits Base

@code {
  @Cascade role!: string;
}

<span class="badge">@theme</span>
<span class="role">@role</span>
`;

const main = `import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

mount(App, document.getElementById("app")!);
`;

test("a @Cascade member follows the value of its @cascade provider", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "App.xzor"), app);
  writeFileSync(join(dir, "Base.xzor"), base);
  writeFileSync(join(dir, "Badge.xzor"), badge);
  writeFileSync(join(dir, "main.ts"), main);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, out).toBe(0);
  expect(readFileSync(join(dir, ".xzor", "Badge.xzor.ts"), "utf8")).toContain(
    'static readonly cascades: readonly (readonly [string, string])[] = [...((Base as { cascades?: readonly (readonly [string, string])[] }).cascades ?? []), ["role", "role"]] as const;',
  );

  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  const text = (sel: string) => document.querySelector(`#app ${sel}`)?.textContent;
  expect(text(".badge")).toBe("dark");
  expect(text(".role")).toBe("admin");
  // Sibling cascade bodies are separate JS block scopes, so both can declare `tag`.
  expect([text(".one"), text(".two")]).toEqual(["a", "b"]);
  (document.querySelector("#app button") as HTMLElement).click();
  expect(text(".badge")).toBe("light");
  expect(text(".role")).toBe("admin");
}, 120_000);
