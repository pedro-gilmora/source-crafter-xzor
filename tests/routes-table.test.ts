import { beforeAll, expect, mock, test } from "bun:test";
import { join } from "node:path";
import * as runtime from "../runtime/index";
import type { RouteEntry } from "../runtime/index";

// The table imports `basePath` from the package, which this standalone fixture has no install of.
mock.module("@source-crafter/xzor-runtime", () => runtime);

const root = join(import.meta.dir, "..");
const dir = join(root, "target", "tmp-routes");

let routes: RouteEntry[];
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
    "/",
    "/a b",
    "/café/:q",
    "/docs/*",
    "/f/:on/:tab",
    "/p/:id",
    "/p/:id/*",
    "/s/:slug",
    "/users/new",
    "/users/:id",
    "/users/*",
    "/*",
  ]);
});

test("the root route matches no segments and wins over the catch-all", () => {
  expect(entry("/").match([])).toEqual({});
  expect(entry("/").match([""])).toBeNull();
  expect(entry("/*").match([])).toEqual({});
  expect(routes.indexOf(entry("/"))).toBeLessThan(routes.indexOf(entry("/*")));
});

test("malformed percent escapes do not match and never throw", () => {
  expect(entry("/users/:id").match(["users", "%"])).toBeNull();
  expect(entry("/s/:slug").match(["s", "%zz"])).toBeNull();
  expect(entry("/f/:on/:tab").match(["f", "%", "a"])).toBeNull();
  expect(entry("/f/:on/:tab").match(["f", "true", "%zz"])).toBeNull();
  expect(entry("/users/*").match(["users", "%zz"])).toBeNull();
});

test("numbers are decimal only", () => {
  for (const bad of ["0x10", "1e3", "Infinity", "%20", "", " 1", "+1"]) {
    expect(entry("/p/:id").match(["p", bad])).toBeNull();
  }
  expect(entry("/p/:id").match(["p", "-1.5"])).toEqual({ id: -1.5 });
});

test("booleans compare the decoded segment", () => {
  expect(entry("/f/:on/:tab").match(["f", "%74rue", "a"])).toEqual({ on: true, tab: "a" });
});

test("rest only reaches the page that declares it", () => {
  expect(entry("/docs/*").match(["docs", "a", "b"])).toEqual({});
  expect(href.Docs({})).toBe("/docs/");
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

test("literal segments match the percent-encoded path a browser reports", () => {
  const path = (url: string) => new URL(url, "http://x").pathname;
  const segments = (p: string) => p.slice(1).split("/");

  const accented = href.Cafe({ q: "a b" });
  expect(accented).toBe("/caf%C3%A9/a%20b");
  expect(path(accented)).toBe(accented);
  expect(entry("/café/:q").match(segments(path(accented)))).toEqual({ q: "a b" });
  // The same path written with the raw characters, as the browser encodes it.
  expect(entry("/café/:q").match(segments(path("/café/a b")))).toEqual({ q: "a b" });

  const spaced = href.Cafe({});
  expect(spaced).toBe("/a%20b");
  expect(entry("/a b").match(segments(path(spaced)))).toEqual({});
});

test("href ignores keys whose value is undefined", () => {
  expect(href.P({ id: 1, rest: undefined })).toBe("/p/1");
  expect(href.UserPage({ id: undefined, rest: undefined })).toBe("/users/new");
});
