import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", `tmp-routing-${process.pid}`);
const happyDOM = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  // The bundled app's router keeps listening on this document; later test files get a fresh one.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  GlobalRegistrator.register();
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

// A page that links through the table: the table imports it while it imports the table.
const adminHome = `@page "/admin" as admin
@import { href } from "./routes"

<p class="admin-home">admin <a class="back-link" href="@href.UserPage({ id: 3 })">user 3</a></p>
`;

const app = `@import { href } from "./routes"

<nav>
  <a class="user-link" href="@href.UserPage({ id: 2 })">user 2</a>
  <a class="admin-link" href="@href.AdminHome()">admin</a>
  <a class="missing-link" href="/nope">nope</a>
</nav>
@Routes(route) {
  @admin(page) { <section class="admin">@page</section> }
  @notFound { <p class="missing">no route for @route.path</p> }
  @default(page) { <main class="main">@page</main> }
}
`;

const main = `import { mount } from "@source-crafter/xzor-runtime";
import App from "./App.xzor";

mount(App, document.getElementById("app")!);
`;

const text = (selector: string) => document.querySelector(`#app ${selector}`)?.textContent;
const click = (selector: string) => (document.querySelector(`#app ${selector}`) as HTMLElement).click();

test("pages, links and layouts route a bundled app in the browser", async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  // Bun's default tsconfig turns these on, and the generated table is code the user cannot edit.
  tsconfig.compilerOptions.noUncheckedIndexedAccess = true;
  tsconfig.compilerOptions.noPropertyAccessFromIndexSignature = true;
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(dir, "Home.xzor"), home);
  writeFileSync(join(dir, "UserPage.xzor"), userPage);
  writeFileSync(join(dir, "AdminHome.xzor"), adminHome);
  writeFileSync(join(dir, "App.xzor"), app);
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
  expect(text("section.admin .admin-home")).toContain("admin");
  // The page imports the table that imports it; both loaded and link to each other.
  click(".back-link");
  expect(text("section.admin .user")).toBe("3");

  click(".missing-link");
  expect(text("main.main")).toBeUndefined();
  expect(text(".missing")).toBe("no route for /nope");
}, 120_000);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

test("--minify ships each page in its own chunk, loaded on its first visit", async () => {
  const min = `${dir}-min`;
  rmSync(min, { recursive: true, force: true });
  mkdirSync(min, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(root, "examples", "counter", "tsconfig.json"), "utf8"));
  tsconfig.compilerOptions.paths = { "@source-crafter/xzor-runtime": [join(root, "runtime", "index.ts").replaceAll("\\", "/")], "@source-crafter/xzor-runtime/model": [join(root, "runtime", "model.ts").replaceAll("\\", "/")] };
  writeFileSync(join(min, "tsconfig.json"), JSON.stringify(tsconfig));
  writeFileSync(join(min, "Home.xzor"), home);
  writeFileSync(join(min, "UserPage.xzor"), `@import Chart from "./Chart.xzor"\n${userPage}<Chart label="@String(id * 2)" />\n`);
  writeFileSync(join(min, "Chart.xzor"), `@async\n@code { label = ""; }\n<em class="chart">@label</em>\n`);
  writeFileSync(join(min, "AdminHome.xzor"), adminHome);
  writeFileSync(join(min, "App.xzor"), app);
  writeFileSync(join(min, "main.ts"), main);
  try {
    const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", min, "--minify"], { cwd: root });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode, out).toBe(0);
    const chunks = readdirSync(join(min, "dist", "chunks"));
    for (const page of ["Home", "UserPage", "AdminHome", "Chart"]) expect(chunks.some((c) => c.startsWith(`${page}.xzor-`) && c.endsWith(".js")), chunks.join()).toBe(true);
    // The entry keeps its name for index.html, minified, and holds no page.
    const entry = readFileSync(join(min, "dist", "main.js"), "utf8");
    expect(entry).not.toContain("user-link\n");
    expect(entry).not.toMatch(/\n {2}/);
    expect(entry).not.toContain("admin-home");

    // A fresh document: the previous test's app still intercepts link clicks on this one.
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    await GlobalRegistrator.unregister();
    GlobalRegistrator.register();
    happyDOM().setURL("http://localhost/users/5");
    document.body.innerHTML = `<div id="app"></div>`;
    await import(join(min, "dist", "main.js"));
    await settle();
    expect(text("section.admin .user")).toBe("5");
    expect(text("section.admin .chart")).toBe("10");
    click(".admin-link");
    await settle();
    expect(text("section.admin .admin-home")).toContain("admin");
  } finally {
    rmSync(min, { recursive: true, force: true });
  }
}, 120_000);
