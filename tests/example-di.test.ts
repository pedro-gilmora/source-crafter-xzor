import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const example = join(root, "examples", "counter");
const bundle = join(example, "dist", "main.js");
const log = spyOn(console, "log").mockImplementation(() => {});
let greetingBeforeSettings: Element | null | undefined;

/** Waits macrotasks until `done()` holds, failing with `what` after a bounded number of turns. */
async function until(what: string, done: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const logged = (message: string) => log.mock.calls.filter((c) => c[0] === message).length;
const texts = (selector: string) => [...document.querySelectorAll(`#app ${selector}`)].map((e) => e.textContent);
const happyDOM = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

beforeAll(async () => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", "examples/counter"], { cwd: root });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  happyDOM().setURL("http://localhost/");
  document.body.innerHTML = `<div id="app"></div>`;
  await import(bundle);
  // The settings factory resolves on a later macrotask; the import settles on microtasks.
  greetingBeforeSettings = document.querySelector("#app .greeting");
  await until("the async Greeting", () => document.querySelector("#app .greeting") !== null);
  const show = [...document.querySelectorAll("#app nav button")].find((b) => b.textContent === "counter") as HTMLElement;
  show.click();
  await until("the third Counter", () => document.querySelectorAll("#app .counter").length === 3);
}, 120_000);

afterAll(async () => {
  log.mockRestore();
  // The bundled app's router keeps listening on this document; later test files get a fresh one.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  GlobalRegistrator.register();
});

test("Counters show the injected database name", () => {
  expect(texts(".counter .db")).toEqual(["in-memory db", "in-memory db", "in-memory db"]);
});

test("the singleton database is opened once across three Counters", () => {
  expect(logged("database opened")).toBe(1);
});

test("the keyed requestId reaches AuthService and is stable across Counters", () => {
  const ids = texts(".counter .request");
  expect(ids).toHaveLength(3);
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Set(ids).size).toBe(1);
});

test("Greeting's place is empty until the async settings resolve, then filled", () => {
  expect(greetingBeforeSettings).toBeNull();
  expect(document.querySelector("#app .greeting")?.textContent).toBe("Hello from async injected settings");
});

const link = (text: string) => [...document.querySelectorAll("#app a")].find((a) => a.textContent?.trim() === text) as HTMLElement;
const one = (selector: string) => document.querySelector(`#app ${selector}`)?.textContent?.trim();

test("the shell routes every kind of section", async () => {
  link("User 1").click();
  expect(location.pathname).toBe("/users/1");
  expect(one("main.main h2")).toBe("User 1");
  expect(one(".user")).toBe("Viewing user #1 on zor demo (parameter sets: 1)");
  expect(link("User 1").className).toBe("active");
  expect(document.title).toBe("User 1 · zor demo");
  expect(one(".registered")).toBe("Registered as user page");

  // Same pattern, new params: the instance is kept and runs onParametersSet again.
  link("Next user").click();
  expect(one("main.main h2")).toBe("User 2");
  expect(one(".user")).toBe("Viewing user #2 on zor demo (parameter sets: 2)");
  // `/users/:id/*` extends `/users/:id`: one route family, so the instance is still kept.
  link("Posts").click();
  expect(one(".tab")).toBe("Tab: posts");
  expect(one(".user")).toBe("Viewing user #2 on zor demo (parameter sets: 3)");
  // Back to the shorter route: `rest` is cleared, not left over.
  link("Profile").click();
  expect(one(".tab")).toBeUndefined();
  expect(one(".user")).toBe("Viewing user #2 on zor demo (parameter sets: 4)");

  link("Admin").click();
  expect(one(".admin .admin-home")).toBe("Welcome to the admin area.");
  expect(one(".admin-path")).toBe("/admin");
  link("Manage user 2").click();
  await until("the injected admin page", () => one(".admin-user") !== undefined);
  expect(one(".admin-user")).toBe("Managing user 2");
  expect(document.querySelectorAll("#app .dot")).toHaveLength(2);

  link("Terms").click();
  expect(one(".legal h2")).toBe("Legal: terms");
  link("Old link").click();
  expect(one(".moved")).toStartWith('"pricing" has moved.');
  link("Broken page").click();
  await until("the @catch section", () => one(".error") !== undefined);
  expect(one(".error")).toBe("This page failed: Error: this page always fails");
  link("Missing").click();
  expect(one(".missing")).toBe("No page at /nowhere");

  link("Home").click();
  expect(document.querySelector("#app main.main")?.className).toBe("main light");
  (document.querySelector("#app .theme") as HTMLElement).click();
  expect(document.querySelector("#app main.main")?.className).toBe("main dark");
});

test("the emitted provider disposes scoped services per scope and singletons at the root", async () => {
  const { SharedInstance } = await import("../runtime/index");
  const { DataServices$ } = await import(join(example, ".zor", "services", "data.provider.ts"));
  log.mockClear();
  const provider = DataServices$[SharedInstance];
  const scope = provider.createScope();
  scope.unitOfWork.track();
  expect(scope.unitOfWork.db).toBe(provider.database);
  scope.dispose();
  expect(log.mock.calls.map((c) => c[0])).toEqual(["database opened", "unit of work closed after 1 changes"]);
  provider[Symbol.dispose]();
  expect(logged("database closed")).toBe(1);
  provider.dispose();
  expect(logged("database closed")).toBe(1);
});
