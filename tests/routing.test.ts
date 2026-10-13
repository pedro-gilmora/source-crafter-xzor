import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", `tmp-routing-${process.pid}`);
const happyDOM = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  happyDOM().setURL("http://localhost/");
  document.body.innerHTML = "";
});

const home = `@page "/"

<p class="home">home</p>
`;

const userPage = `@page "/users/:id" as admin

@code {
  id = 0;
}

<p class="user">@id</p>
`;

const adminHome = `@page "/admin" as admin

<p class="admin-home">admin</p>
`;

const app = `@import { href } from "./routes"

<nav>
  <a class="user-link" href="@href.UserPage({ id: 2 })">user 2</a>
  <a class="admin-link" href="@href.AdminHome({})">admin</a>
  <a class="missing-link" href="/nope">nope</a>
</nav>
@ClientRoutes(route) {
  @admin(page) { <section class="admin">@page</section> }
  @notFound { <p class="missing">no route for @route.path</p> }
  @default(page) { <main class="main">@page</main> }
}
`;

const main = `import { mount } from "@zor/runtime";
import App from "./App.tszor";

mount(App, document.getElementById("app")!);
`;

const text = (selector: string) => document.querySelector(`#app ${selector}`)?.textContent;
const click = (selector: string) => (document.querySelector(`#app ${selector}`) as HTMLElement).click();

test("pages, links and layouts route a bundled app in the browser", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@zor/runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "Home.tszor"), home);
  writeFileSync(join(dir, "UserPage.tszor"), userPage);
  writeFileSync(join(dir, "AdminHome.tszor"), adminHome);
  writeFileSync(join(dir, "App.tszor"), app);
  writeFileSync(join(dir, "main.ts"), main);
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", dir], { cwd: root });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode, out).toBe(0);

  happyDOM().setURL("http://localhost/");
  document.body.innerHTML = `<div id="app"></div>`;
  await import(join(dir, "dist", "main.js"));
  // A page without a tag falls to @default.
  expect(text("main.main .home")).toBe("home");

  // The generated href builder fills the link, and the click is a History navigation.
  expect(document.querySelector("#app .user-link")?.getAttribute("href")).toBe("/users/2");
  click(".user-link");
  expect(location.pathname).toBe("/users/2");
  expect(text("section.admin .user")).toBe("2");

  click(".admin-link");
  expect(text("section.admin .admin-home")).toBe("admin");

  click(".missing-link");
  expect(text("main.main")).toBeUndefined();
  expect(text(".missing")).toBe("no route for /nope");
}, 120_000);
