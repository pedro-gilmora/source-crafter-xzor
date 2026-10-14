import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// An app served under a sub-path (GitHub Pages: /<repo>/) declares it with `<base href>`.
const root = join(import.meta.dir, "..");
const dir = join(root, "target", `tmp-routing-base-${process.pid}`);
const happyDOM = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  GlobalRegistrator.register();
});

const files: Record<string, string> = {
  "Home.xzor": `@page "/"\n\n<p class="home">home</p>\n`,
  "UserPage.xzor": `@page "/users/:id"\n\n@code {\n  id = 0;\n}\n\n<p class="user">@id</p>\n`,
  "App.xzor": `@import { href } from "./routes"
@import { NavLink } from "@source-crafter/xzor-runtime"

<nav>
  <NavLink href="./" match="prefix">Home</NavLink>
  <NavLink href="@href.UserPage({ id: 2 })">User 2</NavLink>
  <a class="missing-link" href="nope">nope</a>
</nav>
@ClientRoutes(route) {
  @notFound { <p class="missing">no route for @route.path</p> }
  @default(page) { <main class="main" data-path="@route.path">@page</main> }
}
`,
  "main.ts": `import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

mount(App, document.getElementById("app")!);
`,
};

const one = (selector: string) => document.querySelector(`#app ${selector}`);
const link = (text: string) => [...document.querySelectorAll("#app a")].find((a) => a.textContent === text) as HTMLElement;

test("routes, href and NavLink work below <base href>", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);

  happyDOM().setURL("http://localhost/repo/");
  document.head.innerHTML = `<base href="/repo/">`;
  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));

  expect(one("main .home")?.textContent).toBe("home");
  expect(one("main")?.getAttribute("data-path")).toBe("/");
  expect(link("Home").className).toBe("active");

  expect(link("User 2").getAttribute("href")).toBe("/repo/users/2");
  link("User 2").click();
  expect(location.pathname).toBe("/repo/users/2");
  expect(one("main .user")?.textContent).toBe("2");
  expect(one("main")?.getAttribute("data-path")).toBe("/users/2");
  expect(link("User 2").className).toBe("active");
  // The base's root is every path's prefix, so it is only active on itself.
  expect(link("Home").className).toBe("");

  link("nope").click();
  expect(location.pathname).toBe("/repo/nope");
  expect(one(".missing")?.textContent).toBe("no route for /nope");
}, 120_000);
