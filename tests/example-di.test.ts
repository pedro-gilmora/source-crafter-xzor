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

beforeAll(async () => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", "examples/counter"], { cwd: root });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  document.body.innerHTML = `<div id="app"></div>`;
  await import(bundle);
  // The settings factory resolves on a later macrotask; the import settles on microtasks.
  greetingBeforeSettings = document.querySelector("#app .greeting");
  await until("the async Greeting", () => document.querySelector("#app .greeting") !== null);
  const show = [...document.querySelectorAll("#app nav button")].find((b) => b.textContent === "counter") as HTMLElement;
  show.click();
  await until("the third Counter", () => document.querySelectorAll("#app .counter").length === 3);
}, 120_000);

afterAll(() => log.mockRestore());

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
