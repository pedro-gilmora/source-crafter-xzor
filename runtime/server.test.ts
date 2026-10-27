import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delete, Endpoints, Get, HttpError, Patch, Post, Put, Query, reply, replyAsync, staticFiles, type IServerApplication } from "./server";
import { Run } from "./index";

// The preload's happy-dom replaces Request/Response/Headers; these tests need Bun's.
beforeAll(() => GlobalRegistrator.unregister());
afterAll(() => GlobalRegistrator.register());

describe("reply", () => {
  test("an object is JSON with 200", async () => {
    const res = reply({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ a: 1 });
  });
  test("undefined is 404", () => {
    expect(reply(undefined).status).toBe(404);
  });
  test("a Response passes through", () => {
    const res = new Response("x", { status: 201 });
    expect(reply(res)).toBe(res);
  });
  test("HttpError becomes its status", async () => {
    const res = await replyAsync(Promise.reject(new HttpError(409, "taken")));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("taken");
  });
  test("other errors reject", async () => {
    await expect(replyAsync(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
  test("a resolved value goes through reply", async () => {
    expect((await replyAsync(Promise.resolve([1]))).status).toBe(200);
    expect((await replyAsync(Promise.resolve(undefined))).status).toBe(404);
  });
});

describe("staticFiles", () => {
  let root = "";
  let routes: ReturnType<typeof staticFiles>;
  const req = (path: string, headers: Record<string, string> = {}) => routes[path](new Request("http://x" + path, { headers }));
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "xzor-static-"));
    mkdirSync(join(root, "dist", "chunks"), { recursive: true });
    writeFileSync(join(root, "dist", "a.js"), "raw-a");
    writeFileSync(join(root, "dist", "a.js.br"), "br-a");
    writeFileSync(join(root, "dist", "a.js.gz"), "gz-a");
    writeFileSync(join(root, "dist", "chunks", "b.js"), "raw-b");
    writeFileSync(join(root, "dist", "f.woff2"), "font");
    writeFileSync(join(root, "dist", "big.js"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(root, "dist", "big.js.br"), "big-br");
    routes = staticFiles(root, ["dist/a.js", "dist/chunks/b.js", "dist/f.woff2", "dist/big.js"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("keys are URL paths", () => {
    expect(Object.keys(routes).sort()).toEqual(["/dist/a.js", "/dist/big.js", "/dist/chunks/b.js", "/dist/f.woff2"]);
  });
  test("br is preferred when accepted", async () => {
    const res = req("/dist/a.js", { "accept-encoding": "gzip, br" });
    expect(await res.text()).toBe("br-a");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("content-type")).toContain("javascript");
  });
  test("gzip when br is not accepted", async () => {
    const res = req("/dist/a.js", { "accept-encoding": "gzip" });
    expect(await res.text()).toBe("gz-a");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });
  test("raw without the header", async () => {
    const res = req("/dist/a.js");
    expect(await res.text()).toBe("raw-a");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("accept-encoding");
  });
  test("a missing encoding sibling falls back to raw", async () => {
    const res = req("/dist/chunks/b.js", { "accept-encoding": "br, gzip" });
    expect(await res.text()).toBe("raw-b");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
  test("If-None-Match with the etag is 304 without a body", async () => {
    const etag = req("/dist/a.js").headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const res = req("/dist/a.js", { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    const brEtag = req("/dist/a.js", { "accept-encoding": "br" }).headers.get("etag")!;
    expect(brEtag).not.toBe(etag);
    expect(req("/dist/a.js", { "accept-encoding": "br", "if-none-match": brEtag }).status).toBe(304);
  });
  test("chunks and fonts are immutable, the rest no-cache", () => {
    const immutable = "public, max-age=31536000, immutable";
    expect(req("/dist/chunks/b.js").headers.get("cache-control")).toBe(immutable);
    expect(req("/dist/f.woff2").headers.get("cache-control")).toBe(immutable);
    expect(req("/dist/a.js").headers.get("cache-control")).toBe("no-cache");
  });
  test("files over 1 MB are served from disk with the same headers", async () => {
    const res = req("/dist/big.js", { "accept-encoding": "br" });
    expect(await res.text()).toBe("big-br");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const raw = req("/dist/big.js");
    expect((await raw.text()).length).toBe(1024 * 1024 + 1);
    expect(req("/dist/big.js", { "if-none-match": raw.headers.get("etag")! }).status).toBe(304);
  });
  test("a response can be served twice", async () => {
    expect(await req("/dist/a.js").text()).toBe("raw-a");
    expect(await req("/dist/a.js").text()).toBe("raw-a");
  });
});

describe("decorators", () => {
  test("type-check and no-op on classes and methods, bare or called", () => {
    @Endpoints("/posts")
    class Posts implements IServerApplication {
      port = 3000;
      @Get list() { return []; }
      @Get(":slug") one() { return 1; }
      @Get() all() { return 1; }
      @Post create() {}
      @Put(":id") put() {}
      @Patch(":id") patch() {}
      @Delete(":id") del() {}
      @Query search() {}
    }
    expect(new Posts().list()).toEqual([]);
  });
  test("Run overloads", () => {
    class Shell {}
    @Run(Shell, "app") class A {}
    @Run(Shell) class B {}
    @Run() class C {}
    expect([new A(), new B(), new C()].length).toBe(3);
  });
});
