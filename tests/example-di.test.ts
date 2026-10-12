import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bundle = join(root, "examples", "counter", "dist", "main.js");
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  const run = Bun.spawnSync(["cargo", "run", "-q", "--", "build", "examples/counter"], { cwd: root });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  document.body.innerHTML = `<div id="app"></div>`;
  await import(bundle);
  for (let i = 0; i < 5; i++) await macrotask();
}, 120_000);

test("Counter shows the injected database name", () => {
  const names = [...document.querySelectorAll("#app .counter .db")].map((e) => e.textContent);
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n === "in-memory db")).toBe(true);
});

test("Greeting appears once the async settings resolve", () => {
  expect(document.querySelector("#app .greeting")?.textContent).toBe("Hello from async settings");
});
