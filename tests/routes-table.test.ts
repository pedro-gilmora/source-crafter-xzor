import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-routes");

type Entry = {
  tag: string | undefined;
  pattern: string;
  component: unknown;
  match: (s: string[]) => Record<string, unknown> | null;
};

let routes: Entry[];
let href: Record<string, (p: Record<string, unknown>) => string>;

beforeAll(async () => {
  const run = Bun.spawnSync(["cargo", "test", "-q", "writes_table_fixture"], { cwd: root });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  const m = await import(join(dir, "routes.ts"));
  routes = m.routes;
  href = m.href;
}, 180_000);

const entry = (pattern: string) => routes.find((r) => r.pattern === pattern)!;

test("entries are sorted by precedence", () => {
  expect(routes.map((r) => r.pattern)).toEqual([
    "/f/:on/:tab",
    "/p/:id",
    "/p/:id/*",
    "/users/new",
    "/users/:id",
    "/users/*",
  ]);
});

test("matchers convert the segments of their pattern", () => {
  expect(entry("/users/:id").match(["users", "7"])).toEqual({ id: 7 });
  expect(entry("/users/:id").match(["users", "x"])).toBeNull();
  expect(entry("/users/:id").match(["users"])).toBeNull();
  expect(entry("/users/:id").match(["users", "7", "x"])).toBeNull();
  expect(entry("/p/:id").match(["p", "%32"])).toEqual({ id: 2 });
  expect(entry("/f/:on/:tab").match(["f", "true", "a"])).toEqual({ on: true, tab: "a" });
  expect(entry("/f/:on/:tab").match(["f", "1", "a"])).toBeNull();
  expect(entry("/f/:on/:tab").match(["f", "false", "c"])).toBeNull();
  expect(entry("/users/new").match(["users", "new"])).toEqual({});
  expect(entry("/users/new").match(["users", "old"])).toBeNull();
  expect(entry("/users/*").match(["users", "a", "b"])).toEqual({ rest: "a/b" });
  expect(entry("/users/*").match(["users"])).toEqual({ rest: "" });
  expect(entry("/users/*").match(["other"])).toBeNull();
});

test("entries carry their tag and page component", () => {
  expect(entry("/users/:id").tag).toBe("admin");
  expect(entry("/users/new").tag).toBeUndefined();
  expect(entry("/p/:id").component).toBe(entry("/p/:id/*").component);
  expect(entry("/p/:id").component).not.toBe(entry("/users/*").component);
});

test("href encodes values and picks the route by parameter names", () => {
  expect(href.P({ id: 1 })).toBe("/p/1");
  expect(href.P({ id: 1, rest: "a b/c" })).toBe("/p/1/a%20b/c");
  expect(href.UserPage({})).toBe("/users/new");
  expect(href.UserPage({ id: 42 })).toBe("/users/42");
  expect(href.UserPage({ rest: "x/y" })).toBe("/users/x/y");
  expect(href.Flags({ on: true, tab: "a" })).toBe("/f/true/a");
  expect(() => href.P({})).toThrow("no route of P matches these parameters");
});
