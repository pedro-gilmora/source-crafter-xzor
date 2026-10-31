import { beforeAll, afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "fixtures", "di");
const script = join(import.meta.dir, "..", "src", "di.ts");

// Stand-ins for what codegen emits into .xzor/ (the folder is gitignored).
const generated: Record<string, string> = {
  "App.xzor.ts": `import { Component } from "@source-crafter/xzor-runtime";
export default class App extends Component {
  protected override render(__p: Node): void {}
}
`,
  "Counter.xzor.ts": `import { Component } from "@source-crafter/xzor-runtime";
import type { IDatabase } from "./services/data";
import { AuthService } from "./main";
export default class Counter extends Component {
  static readonly inject = ["db", "auth"];
  readonly db: IDatabase;
  readonly auth: AuthService;
  constructor(db: IDatabase, auth: AuthService) { super(); this.db = db; this.auth = auth; }
  protected override render(__p: Node): void { __p.appendChild(document.createTextNode(this.db.name)); }
}
`,
};

let facts: any;
const provider = (name: string) => facts.providers.find((p: any) => p.class.text === name);
const reg = (p: string, pred: (r: any) => boolean) => provider(p).registrations.find(pred);

beforeAll(() => {
  mkdirSync(join(root, ".xzor"), { recursive: true });
  for (const [name, text] of Object.entries(generated)) writeFileSync(join(root, ".xzor", name), text);
  const args = ["services/data.ts", "services/hidden.ts", "services/dispose.ts", "services/keys.ts", "main.ts", "--", ".xzor/App.xzor.ts", ".xzor/Counter.xzor.ts"];
  const run = Bun.spawnSync(["bun", script, root, ...args]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  facts = JSON.parse(run.stdout.toString());
});

test("reads registrations", () => {
  const regs = provider("DataServices").registrations;
  expect(regs.map((r: any) => r.lifetime)).toEqual(["singleton", "singleton", "scoped"]);
  const db = regs.find((r: any) => r.service.text === "IDatabase");
  expect(db.service).toEqual({ id: "services/data.ts#IDatabase", text: "IDatabase", module: "services/data", export: "IDatabase" });
  expect(db.impl.text).toBe("Database");
  expect(db.params).toHaveLength(1);
  expect(db.params[0].name).toBe("log");
  expect(db.params[0].type.text).toBe("ILogger");
  expect(db.dispose).toBe("dispose");
  expect(regs[0].dispose).toBeNull();
  expect(regs[0].at).toBe(readFileSync(join(root, "services", "data.ts"), "utf8").indexOf("@Singleton<ILogger>"));
});

test("reads dispose members", () => {
  const dispose = (name: string) => reg("DisposeServices", (r) => r.impl?.text === name).dispose;
  expect(dispose("SyncSymbol")).toBe("Symbol.dispose");
  expect(dispose("AsyncSymbol")).toBe("Symbol.asyncDispose");
  expect(dispose("Both")).toBe("Symbol.asyncDispose");
  expect(dispose("NotCallable")).toBeNull();
  expect(provider("DisposeServices").registrations.filter((r: any) => r.impl).map((r: any) => r.disposeOptional)).toEqual([false, false, false, false]);
});

test("optional disposer", () => {
  const maybe = reg("DisposeServices", (r) => r.key === "maybe");
  expect(maybe.service.text).toBe("MaybeDisposable");
  expect(maybe.dispose).toBe("dispose");
  expect(maybe.disposeOptional).toBe(true);
});

test("parameter positions", () => {
  const keys = readFileSync(join(root, "services", "keys.ts"), "utf8");
  const [port, clock] = reg("KeyServices", (r) => r.impl?.text === "Server").params;
  expect([port.file, port.at]).toEqual(["services/keys.ts", keys.indexOf("port: string")]);
  expect([clock.file, clock.at]).toEqual(["services/keys.ts", keys.indexOf("clock: IClock")]);
  const counter = facts.components.find((c: any) => c.class.text === "Counter");
  const db = counter.injects[0];
  expect([db.file, db.at]).toEqual([".xzor/Counter.xzor.ts", generated["Counter.xzor.ts"]!.indexOf("db: IDatabase,")]);
});

test("factory parameter positions", () => {
  const keys = readFileSync(join(root, "services", "keys.ts"), "utf8");
  const label = reg("KeyServices", (r) => r.key === "label");
  expect(label.params).toHaveLength(1);
  expect([label.params[0].file, label.params[0].at]).toEqual(["services/keys.ts", keys.indexOf("port: number")]);
});

test("bad keys", () => {
  const [port, clock] = reg("KeyServices", (r) => r.impl?.text === "Server").params;
  expect(port.badKeys).toEqual(["services/keys.ts#KeyServices:0"]);
  expect(clock.badKeys).toEqual([]);
  expect(reg("DataServices", (r) => r.impl?.text === "Database").params[0].badKeys).toEqual([]);
});

test("type identity ignores aliases", () => {
  const db = reg("DataServices", (r) => r.service.text === "IDatabase");
  const auth = reg("Application", (r) => r.impl?.text === "AuthService");
  expect(auth.lifetime).toBe("singleton");
  expect(auth.params[0].type.id).toBe(db.service.id);
});

test("reads keyed factories", () => {
  const id = reg("Application", (r) => r.key === "requestId");
  expect(id.factory).toEqual({ owner: { id: "main.ts#Factories", text: "Factories", module: "main", export: "Factories" }, member: "_newRequestId" });
  expect(id.async).toBe(false);
  expect(id.impl).toBeNull();
  expect(id.service).toEqual({ id: "string", text: "string", module: null, export: null });
  const cache = reg("Application", (r) => r.key === "cache");
  expect(cache.async).toBe(true);
  expect(cache.service.text).toBe("Cache");
  expect(cache.service.id).toBe("main.ts#Cache");
});

test("reads mount and imports", () => {
  const app = provider("Application");
  expect(app.file).toBe("main.ts");
  expect(app.mount.component.module).toBe("App.xzor");
  expect(app.mount.component.export).toBe("default");
  expect(app.mount.target).toBe("app");
  expect(app.mount.component.id).toBe(facts.components.find((c: any) => c.class.text === "App").class.id);
  expect(app.imports[0].text).toBe("DataServices");
  expect(app.imports[0].id).toBe("services/data.ts#DataServices");
  expect(provider("DataServices").mount).toBeNull();
});

test("reads component injects", () => {
  const counter = facts.components.find((c: any) => c.class.text === "Counter");
  expect(counter.class.module).toBe("Counter.xzor");
  expect(counter.injects.map((p: any) => [p.name, p.type.text])).toEqual([["db", "IDatabase"], ["auth", "AuthService"]]);
  expect(counter.injects[0].type.id).toBe("services/data.ts#IDatabase");
  expect(facts.components.find((c: any) => c.class.text === "App").injects).toEqual([]);
});

test("promise params", () => {
  const report = reg("Application", (r) => r.impl?.text === "Report");
  expect(report.lifetime).toBe("transient");
  expect(report.params[0]).toMatchObject({ name: "cache", optional: false, promise: true, type: { text: "Cache" } });
  expect(report.params[1]).toMatchObject({ name: "requestId", optional: true, promise: false, type: { text: "string" } });
  // Keyed matches compare against the awaited `T` and the non-nullable type.
  expect(report.params.map((p: any) => p.badKeys)).toEqual([[], []]);
});

test("unexported type", () => {
  expect(facts.errors).toHaveLength(1);
  expect(facts.errors[0].message).toBe("Hidden must be exported to be injected");
  expect(facts.errors[0].file).toBe("services/hidden.ts");
});

// A `--serve` child on `dir`; `request` takes an object (or raw line) and returns the parsed response line.
function startServe(dir: string) {
  const proc = Bun.spawn(["bun", script, "--serve", dir], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const request = async (body: object | string) => {
    const start = performance.now();
    proc.stdin.write((typeof body === "string" ? body : JSON.stringify(body)) + "\n");
    proc.stdin.flush();
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`analyzer exited: ${await new Response(proc.stderr).text()}`);
      buffered += decoder.decode(value, { stream: true });
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    return { facts: JSON.parse(line), ms: performance.now() - start };
  };
  const stop = async () => {
    proc.stdin.end();
    await proc.exited;
  };
  return { proc, request, stop };
}

test("--serve answers several requests with one process and sees overlays", async () => {
  const { proc, request, stop } = startServe(root);
  const data = readFileSync(join(root, "services", "data.ts"), "utf8");
  const overlay = data.replace("@Scoped(UnitOfWork)", "@Scoped(UnitOfWork)\n@Transient(ConsoleLogger)").replace("import { Scoped,", "import { Scoped, Transient,");
  const lifetimes = (f: any) => f.providers.find((p: any) => p.class.text === "DataServices").registrations.map((r: any) => r.lifetime);
  try {
    const first = await request({ files: ["services/data.ts"], components: [], overlays: {} });
    expect(lifetimes(first.facts)).toEqual(["singleton", "singleton", "scoped"]);
    const second = await request({ files: ["services/data.ts"], components: [], overlays: { "services/data.ts": overlay } });
    expect(lifetimes(second.facts)).toEqual(["singleton", "singleton", "scoped", "transient"]);
    const third = await request({ files: ["services/data.ts"], components: [], overlays: {} });
    expect(lifetimes(third.facts)).toEqual(["singleton", "singleton", "scoped"]);
    expect(proc.exitCode).toBeNull();
    console.log(`di --serve: first ${first.ms.toFixed(1)} ms, second ${second.ms.toFixed(1)} ms, third ${third.ms.toFixed(1)} ms (pid ${proc.pid})`);
  } finally {
    await stop();
  }
  expect(proc.exitCode).toBe(0);
});

// A copy of the fixture under target/ (the tsconfig's `../../../runtime` path keeps resolving at this depth).
function fixtureCopy(name: string) {
  const dir = join(import.meta.dir, "..", "target", "tmp-serve", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(root, dir, { recursive: true });
  temps.push(dir);
  return dir;
}

test("--serve does not rebuild for a requested file outside the program", async () => {
  const dir = fixtureCopy("outside");
  const outside = join(dir, "..", `outside-${process.pid}.ts`);
  writeFileSync(outside, "export class Out {}\n");
  temps.push(outside);
  const body = { files: ["services/data.ts", outside], components: [], overlays: {} };
  const { request, stop } = startServe(dir);
  try {
    expect((await request(body)).facts.rebuilt).toBe(true);
    expect((await request(body)).facts.rebuilt).toBe(false);
    expect((await request(body)).facts.rebuilt).toBe(false);
    // Touching the file counts as a creation again.
    const later = new Date(Date.now() + 5000);
    utimesSync(outside, later, later);
    expect((await request(body)).facts.rebuilt).toBe(true);
    expect((await request(body)).facts.rebuilt).toBe(false);
  } finally {
    await stop();
  }
});

test("--serve survives a malformed line", async () => {
  const { request, stop } = startServe(root);
  const body = { files: ["services/data.ts"], components: [], overlays: {} };
  try {
    expect((await request(body)).facts.providers).toHaveLength(1);
    const bad = await request("{not json");
    expect(typeof bad.facts.fatal).toBe("string");
    expect((await request(body)).facts.providers).toHaveLength(1);
  } finally {
    await stop();
  }
});

test("--serve picks up a disk edit between requests", async () => {
  const dir = fixtureCopy("disk");
  const file = join(dir, "services", "data.ts");
  const data = readFileSync(file, "utf8");
  const edited = data.replace("@Scoped(UnitOfWork)", "@Scoped(UnitOfWork)\n@Transient(ConsoleLogger)").replace("import { Scoped,", "import { Scoped, Transient,");
  const lifetimes = (f: any) => f.providers.find((p: any) => p.class.text === "DataServices").registrations.map((r: any) => r.lifetime);
  const body = { files: ["services/data.ts"], components: [], overlays: {} };
  const { request, stop } = startServe(dir);
  try {
    expect(lifetimes((await request(body)).facts)).toEqual(["singleton", "singleton", "scoped"]);
    writeFileSync(file, edited);
    // Make the mtime differ even on coarse clocks.
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(lifetimes((await request(body)).facts)).toEqual(["singleton", "singleton", "scoped", "transient"]);
  } finally {
    await stop();
  }
});

// Temp project copies; `paths: false` leaves @source-crafter/xzor-runtime unresolvable.
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
function analyzeTemp(files: Record<string, string>, paths = true, options: object = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xzor-di-")));
  temps.push(dir);
  const runtime = join(import.meta.dir, "..", "runtime", "index.ts").replaceAll("\\", "/");
  const compilerOptions: any = { target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM"], strict: true, noEmit: true, skipLibCheck: true, ...options };
  if (paths) compilerOptions.paths = { "@source-crafter/xzor-runtime": [runtime], "@source-crafter/xzor-runtime/server": [runtime.replace(/index\.ts$/, "server.ts")] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["**/*.ts"] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const run = Bun.spawnSync(["bun", script, dir, ...Object.keys(files)]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

test("unresolvable runtime is an error", () => {
  const main = `import { ServiceProvider } from "@source-crafter/xzor-runtime";\n\n@ServiceProvider()\nexport class P {}\n`;
  const out = analyzeTemp({ "main.ts": main }, false);
  expect(out.providers).toEqual([]);
  expect(out.errors).toEqual([{ file: "main.ts", at: main.indexOf("@ServiceProvider"), message: "cannot resolve @source-crafter/xzor-runtime" }]);
});

test("non-importable types are errors, primitives and lib types are not", () => {
  const main = `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
export class Svc {}
export type Shape = { a: number };
export type Either = Svc | Date;
export type Both = Svc & { x: 1 };
export type Other = { b: 1 };
export class Uses {
  constructor(
    readonly shape: Shape,
    readonly either: Either,
    readonly both: Both,
    readonly lit: { a: 1 },
    readonly date: Date,
    readonly map: Map<string, number>,
    readonly el: HTMLElement,
    readonly pr: Promise<Svc>,
    readonly s: string,
    readonly n: number,
    readonly b: boolean,
    readonly big: bigint,
    readonly sym: symbol,
  ) {}
}
export class ShapeImpl {}
@ServiceProvider()
@Singleton(Uses)
@Singleton<Other>(ShapeImpl)
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  const suffix = " must be a class, interface or enum to be injected";
  expect(out.errors.map((e: any) => e.message)).toEqual(["Other", "Shape", "Either", "Both", "{ a: 1; }"].map((t) => t + suffix));
  expect(out.errors[0].at).toBe(main.indexOf("Other>(ShapeImpl)"));
  expect(out.errors[1].at).toBe(main.indexOf("readonly shape: Shape"));
  const params = out.providers[0].registrations[0].params;
  const prims = params.slice(4).map((p: any) => [p.type.text, p.type.module]);
  expect(prims).toEqual([["Date", null], ["Map<string, number>", null], ["HTMLElement", null], ["Svc", "main"], ["string", null], ["number", null], ["boolean", null], ["bigint", null], ["symbol", null]]);
});

test("Bun's ambient Request is a global type without the DOM lib", () => {
  const main = `import { ServiceProvider, Scoped } from "@source-crafter/xzor-runtime";
export class User {
  constructor(readonly req: Request) {}
}
@ServiceProvider()
@Scoped(User)
export class P {}
`;
  const typeRoots = [join(import.meta.dir, "..", "node_modules", "@types").replaceAll("\\", "/")];
  const out = analyzeTemp({ "main.ts": main }, true, { lib: ["ESNext"], types: ["bun"], typeRoots });
  expect(out.errors).toEqual([]);
  expect(out.providers[0].registrations[0].params[0].type).toEqual({ id: "Request", text: "Request", module: null, export: null });
});

test("decorator misuse", () => {
  const main = `import { Run, ServiceProvider } from "@source-crafter/xzor-runtime";
export class App {}

@Run(App, "a")
@Run(App, "b")
@ServiceProvider
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([
    { file: "main.ts", at: main.indexOf("@ServiceProvider"), message: "@ServiceProvider must be called" },
    { file: "main.ts", at: main.indexOf('@Run(App, "b")'), message: "duplicate @Run" },
  ]);
  expect(out.providers[0].mount.target).toBe("a");
});

test("@Run generates the same facts @Mount did", () => {
  const main = `import { Run } from "@source-crafter/xzor-runtime";\nexport class App {}\n\n@Run(App, "app")\nexport class P {}\n`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([]);
  expect(out.providers[0].mount.target).toBe("app");
  expect(out.providers[0].mount.component.text).toBe("App");
});

test("@Run needs a component and a string literal target", () => {
  const bad = (call: string) => {
    const main = `import { Run } from "@source-crafter/xzor-runtime";\nexport class App {}\nconst target = "app";\n\n${call}\nexport class P {}\n`;
    return analyzeTemp({ "main.ts": main }).errors.map((e: any) => e.message);
  };
  const message = "@Run expects a component and a string literal target";
  expect(bad("@Run(App, 1)")).toEqual([message]);
  expect(bad("@Run(App, target)")).toEqual([message]);
  expect(bad('@Run(App, "app", 1)')).toEqual([message]);
});

test("@Mount was renamed to @Run", () => {
  const main = `import { Mount } from "@source-crafter/xzor-runtime";\nexport class App {}\n\n@Mount(App, "app")\nexport class P {}\n`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([{ file: "main.ts", at: main.indexOf("@Mount"), message: "@Mount was renamed to @Run" }]);
});

test("non-public factories are errors", () => {
  const main = `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
export class Factories {
  private static hidden(): string { return ""; }
  static #secret(): string { return ""; }
  protected static guarded(): string { return ""; }
  static open(): string { return ""; }
}
@ServiceProvider()
@Singleton("a", Factories.hidden)
@Singleton("c", Factories.#secret)
@Singleton("d", Factories.guarded)
@Singleton("b", Factories.open)
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([
    { file: "main.ts", at: main.indexOf("Factories.hidden)"), message: "Factories.hidden must be public" },
    { file: "main.ts", at: main.indexOf("Factories.#secret)"), message: "Factories.#secret must be public" },
    { file: "main.ts", at: main.indexOf("Factories.guarded)"), message: "Factories.guarded must be public" },
  ]);
});

test("function factories, local or imported", () => {
  const main = `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
import { loadPort as port, type Port } from "./ports";
export function newId(): string { return ""; }
export const later = async (id: string): Promise<number> => id.length;
function hidden(): string { return ""; }
@ServiceProvider()
@Singleton("id", newId)
@Singleton("len", later)
@Singleton("port", port)
@Singleton("h", hidden)
export class P {}
`;
  const ports = `export interface Port { n: number }
export function loadPort(): Port { return { n: 1 }; }
`;
  const out = analyzeTemp({ "main.ts": main, "ports.ts": ports });
  expect(out.errors).toEqual([{ file: "main.ts", at: main.indexOf("hidden)"), message: "hidden must be exported to be used as a factory" }]);
  const [id, len, p] = out.providers[0].registrations;
  expect(id.factory).toEqual({ owner: { id: "main.ts#newId", text: "newId", module: "main", export: "newId" }, member: null });
  expect([id.async, id.service.text]).toEqual([false, "string"]);
  expect(len.factory.owner.export).toBe("later");
  expect([len.async, len.service.text, len.params.map((x: { name: string }) => x.name)]).toEqual([true, "number", ["id"]]);
  expect(p.factory).toEqual({ owner: { id: "ports.ts#loadPort", text: "loadPort", module: "ports", export: "loadPort" }, member: null });
  expect(p.service.text).toBe("Port");
});

test("generic service types are errors", () => {
  const main = `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
export class Repo<T> { item?: T }
export class User {}
export class UserRepo extends Repo<User> {}
@ServiceProvider()
@Singleton(Repo)
@Singleton<Repo<User>>(UserRepo)
@Singleton(UserRepo)
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([
    { file: "main.ts", at: main.indexOf("Repo)"), message: "generic service types are not supported: Repo<T>" },
    { file: "main.ts", at: main.indexOf("Repo<User>>"), message: "generic service types are not supported: Repo<User>" },
  ]);
});

test("lib generic types are allowed for keyed factories", () => {
  const main = `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
export class Repo<T> { item?: T }
export class User {}
export class Factories {
  static counts(): Map<string, number> { return new Map(); }
  static names(): string[] { return []; }
  static env(): Record<string, string> { return {}; }
  static repo(): Repo<User> { return new Repo<User>(); }
}
@ServiceProvider()
@Singleton("counts", Factories.counts)
@Singleton("names", Factories.names)
@Singleton("env", Factories.env)
@Singleton("repo", Factories.repo)
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([{ file: "main.ts", at: main.indexOf("Factories.repo)"), message: "generic service types are not supported: Repo<User>" }]);
  const [counts, names, env] = out.providers[0].registrations;
  expect(counts.service).toMatchObject({ text: "Map<string, number>", module: null, export: null });
  expect(names.service).toMatchObject({ module: null, export: null });
  expect(env.service).toMatchObject({ module: null, export: null });
});

// The server fixture: `server/app.ts` (`@Run(Shell)` on an IServerApplication), `server/api/posts.ts`, and an
// `@Endpoints` class outside the app's folder (`other/stray.ts`).
const serverRoot = join(import.meta.dir, "fixtures", "server");
let serverFacts: any;
function server() {
  if (serverFacts) return serverFacts;
  mkdirSync(join(serverRoot, ".xzor", "client"), { recursive: true });
  writeFileSync(join(serverRoot, ".xzor", "client", "Shell.xzor.ts"), generated["App.xzor.ts"]!.replace("class App", "class Shell"));
  const run = Bun.spawnSync(["bun", script, serverRoot, "server/app.ts", "server/api/posts.ts", "other/stray.ts"]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  return (serverFacts = JSON.parse(run.stdout.toString()));
}

test("reads the server application", () => {
  const f = server();
  expect(f.errors).toEqual([]);
  const app = readFileSync(join(serverRoot, "server", "app.ts"), "utf8");
  expect(f.servers).toEqual([
    {
      class: { id: "server/app.ts#App", text: "App", module: "server/app", export: "App" },
      file: "server/app.ts",
      at: app.indexOf("@Run(Shell)"),
      root: { id: "client/Shell.xzor.ts#default", text: "Shell", module: "client/Shell.xzor", export: "default" },
    },
  ]);
  // Still a DI application (registrations), but not a browser mount.
  const p = f.providers.find((p: any) => p.class.text === "App");
  expect(p.mount).toBeNull();
  expect(p.registrations.map((r: any) => r.impl.text)).toEqual(["PostStore"]);
});

test("reads endpoints under the app's folder only", () => {
  const f = server();
  expect(f.endpoints.map((e: any) => e.class.text)).toEqual(["Posts"]);
  const posts = f.endpoints[0];
  const text = readFileSync(join(serverRoot, "server", "api", "posts.ts"), "utf8");
  expect(posts.class).toEqual({ id: "server/api/posts.ts#Posts", text: "Posts", module: "server/api/posts", export: "Posts" });
  expect([posts.file, posts.at, posts.prefix]).toEqual(["server/api/posts.ts", text.indexOf("Posts implements"), "/api/posts"]);
  expect(posts.ctor.map((p: any) => [p.name, p.type.id])).toEqual([["store", "server/store.ts#PostStore"]]);
  expect(posts.contracts).toEqual([{ id: "contracts/posts.ts#IPosts", text: "IPosts", module: "contracts/posts", export: "IPosts" }]);
  const methods = posts.methods.map((m: any) => [m.name, m.verb, m.pattern, m.path, m.returnsPromise, m.at]);
  expect(methods).toEqual([
    ["get", "GET", ":slug", "/api/posts/:slug", false, text.indexOf("get(slug")],
    ["list", "GET", "", "/api/posts", false, text.indexOf("list(query")],
    ["create", "POST", "", "/api/posts", true, text.indexOf("create(body")],
  ]);
  const [get, list, create] = posts.methods;
  expect(get.params).toEqual([{ name: "slug", kind: "path", type: "string", optional: false, conv: "string", keys: null, anyKey: false, at: text.indexOf("slug: string") }]);
  expect(list.params).toEqual([
    {
      name: "query",
      kind: "query",
      type: "{ tag?: string | undefined; page?: number | undefined; }",
      optional: false,
      conv: null,
      keys: [
        { name: "tag", optional: true, conv: "string" },
        { name: "page", optional: true, conv: "number" },
      ],
      anyKey: false,
      at: text.indexOf("query: {"),
    },
  ]);
  expect(create.params).toEqual([{ name: "body", kind: "body", type: "NewPost", optional: false, conv: null, keys: null, anyKey: false, at: text.indexOf("body: NewPost") }]);
});

test("@Endpoints contracts are the exported interfaces the class implements", () => {
  const app = `import { Run } from "@source-crafter/xzor-runtime";\nimport type { IServerApplication } from "@source-crafter/xzor-runtime/server";\n\n@Run()\nexport class App implements IServerApplication {}\n`;
  const api = `import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";

export interface IA { a(): void }
export interface IB { b(): void }
interface Local { c(): void }
export class Base {}
export type Alias = { d(): void };

@Endpoints("/api")
export class Items extends Base implements IB, Local, Disposable, Alias, IA {
  @Get
  a() {}
  b() {}
  c() {}
  d() {}
  [Symbol.dispose]() {}
}
`;
  const out = analyzeTemp({ "app.ts": app, "api.ts": api }, true, { lib: ["ESNext", "DOM", "ESNext.Disposable"] });
  expect(out.errors).toEqual([]);
  expect(out.endpoints[0].contracts.map((c: any) => c.id)).toEqual(["api.ts#IB", "api.ts#IA"]);
});

test("Remote<IPosts> is a Remote ref and a contract-typed parameter is an interface", () => {
  const app = `import { Run, Singleton, type Remote } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import type { IPosts } from "./posts";

export class Digest {
  constructor(readonly remote: Remote<IPosts>, readonly direct: IPosts) {}
}

@Run()
@Singleton(Digest)
export class App implements IServerApplication {}
`;
  const posts = "export interface IPosts {\n  hit(): number;\n}\n";
  const out = analyzeTemp({ "app.ts": app, "posts.ts": posts });
  expect(out.errors).toEqual([]);
  const [remote, direct] = out.providers[0].registrations[0].params;
  expect(remote.type).toMatchObject({ id: "Remote<posts.ts#IPosts>", text: "Remote<IPosts>", module: null });
  expect(remote.interface).toBe(false);
  expect(direct.type.id).toBe("posts.ts#IPosts");
  expect(direct.interface).toBe(true);
});

test("endpoint parameter kinds and conversions", () => {
  const app = `import { Run } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";

@Run()
export class App implements IServerApplication {}
`;
  const api = `import { Endpoints, Delete, Patch, Put, Query } from "@source-crafter/xzor-runtime/server";

@Endpoints("/api/:org/items/")
export class Items {
  @Put(":id")
  put(org: string, id: number, flag: boolean, body: { a: 1 }): void {}

  @Patch("/:mode")
  patch(org: string, mode: "on" | "off", query?: { on?: boolean; kind?: "a" | "b"; n: number }): void {}

  @Delete()
  remove(org: string, extra: string): Promise<void> { return Promise.resolve(); }

  @Query
  find(org: string, query: string, body: unknown) {}
}
`;
  const out = analyzeTemp({ "app.ts": app, "api.ts": api });
  expect(out.errors).toEqual([]);
  expect(out.servers[0].root).toBeNull();
  const [put, patch, remove, find] = out.endpoints[0].methods;
  expect([put.verb, put.path, patch.verb, patch.path, remove.verb, remove.pattern, remove.path, find.verb, find.path]).toEqual([
    "PUT", "/api/:org/items/:id", "PATCH", "/api/:org/items/:mode", "DELETE", "", "/api/:org/items", "QUERY", "/api/:org/items",
  ]);
  const kinds = (m: any) => m.params.map((p: any) => [p.name, p.kind, p.conv]);
  expect(kinds(put)).toEqual([["org", "path", "string"], ["id", "path", "number"], ["flag", "other", null], ["body", "body", null]]);
  expect(kinds(patch)).toEqual([["org", "path", "string"], ["mode", "path", ["off", "on"]], ["query", "query", null]]);
  expect(patch.params[2].optional).toBe(true);
  expect(patch.params[2].keys).toEqual([
    { name: "on", optional: true, conv: "boolean" },
    { name: "kind", optional: true, conv: ["a", "b"] },
    { name: "n", optional: false, conv: "number" },
  ]);
  expect(kinds(remove)).toEqual([["org", "path", "string"], ["extra", "other", null]]);
  expect(remove.returnsPromise).toBe(true);
  // A `query` that is not an object type has no keys (Task 3 reports it).
  expect(find.params[1]).toMatchObject({ kind: "query", keys: null });
  expect(find.returnsPromise).toBe(false);
});

// `keys` and `anyKey` depend only on the `query` parameter's own type, so each case runs alone.
test.each([
  ["{}", [], false],
  ["Record<string, string>", [], true],
  ["{ tag?: string }", [{ name: "tag", optional: true, conv: "string" }], false],
  ["{ tag?: string; [k: string]: string | undefined }", [{ name: "tag", optional: true, conv: "string" }], true],
  ["string", null, false],
])("query: %s", (type, keys, anyKey) => {
  const app = `import { Run } from "@source-crafter/xzor-runtime";\nimport type { IServerApplication } from "@source-crafter/xzor-runtime/server";\n\n@Run()\nexport class App implements IServerApplication {}\n`;
  const api = `import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";\n\n@Endpoints("/api")\nexport class Items {\n  @Get\n  list(query: ${type}) {}\n}\n`;
  const out = analyzeTemp({ "app.ts": app, "api.ts": api });
  expect(out.errors).toEqual([]);
  expect(out.endpoints[0].methods[0].params[0]).toMatchObject({ kind: "query", keys, anyKey });
});

test("@Run form must match what the class implements", () => {
  const head = `import { Run, type IApplication } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
export class Shell {}

`;
  const analyze = (deco: string, iface: string) => analyzeTemp({ "main.ts": `${head}${deco}\nexport class A implements ${iface} {}\n` });
  const messages = (deco: string, iface: string) => analyze(deco, iface).errors.map((e: any) => e.message);
  const serverForm = '@Run(component, "target") is for an IApplication; an IServerApplication takes @Run(component) or @Run()';
  const browserForm = '@Run(component) and @Run() are for an IServerApplication; an IApplication takes @Run(component, "target")';
  expect(messages('@Run(Shell, "app")', "IServerApplication")).toEqual([serverForm]);
  expect(messages("@Run(Shell)", "IApplication")).toEqual([browserForm]);
  expect(messages("@Run()", "IApplication")).toEqual([browserForm]);
  const browser = analyze('@Run(Shell, "app")', "IApplication");
  expect([browser.errors, browser.servers, browser.providers[0].mount.target]).toEqual([[], [], "app"]);
  const api = analyze("@Run()", "IServerApplication");
  expect([api.errors, api.providers[0].mount, api.servers[0].root]).toEqual([[], null, null]);
  // Implementing neither keeps the browser form (as before).
  expect(analyzeTemp({ "main.ts": `${head}@Run(Shell)\nexport class A {}\n` }).errors.map((e: any) => e.message)).toEqual(["@Run expects a component and a string literal target"]);
});

test("a browser app has no servers or endpoints", () => {
  expect([facts.servers, facts.endpoints]).toEqual([[], []]);
});

// Server projects built with the xzor binary (`--no-check --no-bundle`), under target/ so Bun resolves the runtime.
const repo = join(import.meta.dir, "..");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");
let cargoBuilt = false;
function xzorBuild(dir: string) {
  if (!cargoBuilt) {
    const b = Bun.spawnSync(["cargo", "build", "-q"], { cwd: repo });
    expect(b.exitCode, b.stderr.toString()).toBe(0);
    cargoBuilt = true;
  }
  const run = Bun.spawnSync([exe, "build", dir, "--no-check", "--no-bundle"], { cwd: repo });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

const apiApp = `import { Run } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";

@Run()
export class App implements IServerApplication {
  port = 0;
}
`;

function serverProject(name: string, files: Record<string, string>) {
  const dir = join(repo, "target", "tmp-serve", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  temps.push(dir);
  const runtime = join(repo, "runtime").replaceAll("\\", "/");
  const compilerOptions = {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM", "ESNext.Disposable"], strict: true, noEmit: true, skipLibCheck: true,
    rootDirs: [".", ".xzor"],
    paths: { "@source-crafter/xzor-runtime": [`${runtime}/index.ts`], "@source-crafter/xzor-runtime/server": [`${runtime}/server.ts`] },
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["**/*.ts", ".xzor/**/*.ts"] }));
  for (const [file, text] of Object.entries({ "app.ts": apiApp, ...files })) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const endpoints = (body: string, imports = "Get") =>
  `import { Endpoints, ${imports} } from "@source-crafter/xzor-runtime/server";\n\n${body}`;

test.each([
  [
    "duplicate method and path",
    {
      "api/a.ts": endpoints(`@Endpoints("/api/x")\nexport class A {\n  @Get\n  list() {}\n}\n`),
      "api/b.ts": endpoints(`@Endpoints("/api")\nexport class B {\n  @Get("x")\n  all() {}\n}\n`),
    },
    "ZDI13",
    ["GET /api/x is handled twice", "A.list (api/a.ts)", "B.all (api/b.ts)"],
  ],
  [
    ":query in a pattern",
    { "api.ts": endpoints(`@Endpoints("/api")\nexport class A {\n  @Get(":query")\n  get(query: { a?: string }) {}\n}\n`) },
    "ZDI14",
    ["A.get: :query in /api/:query is reserved"],
  ],
  [
    "GET with body",
    { "api.ts": endpoints(`@Endpoints("/api")\nexport class A {\n  @Get\n  get(body: { a: string }) {}\n}\n`) },
    "ZDI16",
    ["A.get: GET takes no body (only POST, PUT, PATCH and QUERY do)"],
  ],
  [
    "a parameter that is not a path param, query or body",
    { "api.ts": endpoints(`@Endpoints("/api")\nexport class A {\n  @Get\n  get(slug: string) {}\n}\n`) },
    "ZDI17",
    ["A.get: slug is not a path parameter of /api, nor query or body"],
  ],
  [
    "path params out of pattern order",
    { "api.ts": endpoints(`@Endpoints("/api/:a")\nexport class A {\n  @Get(":b")\n  get(b: string, a: string) {}\n}\n`) },
    "ZDI15",
    ["A.get: parameters must be the path parameters of /api/:a/:b in order (a, b), then query, then body"],
  ],
  [
    "a query that is not an object type",
    { "api.ts": endpoints(`@Endpoints("/api")\nexport class A {\n  @Get\n  get(query: string) {}\n}\n`) },
    "ZDI18",
    ["A.get: query must be an object type, not string"],
  ],
  [
    "a prefix without a leading slash",
    { "api.ts": endpoints(`@Endpoints("api/x")\nexport class A {\n  @Get(":id")\n  get(id: string) {}\n}\n`) },
    "ZDI22",
    ['A.get: "api/x/:id" is not a valid route path', "it must start with /"],
  ],
  [
    "a repeated path parameter",
    { "api.ts": endpoints(`@Endpoints("/api/:id")\nexport class A {\n  @Get(":id")\n  get(id: string, id2: string) {}\n}\n`) },
    "ZDI22",
    ['A.get: "/api/:id/:id" is not a valid route path', "a path parameter name is repeated"],
  ],
])("endpoint error: %s", (name, files, code, parts) => {
  const dir = serverProject(name.replace(/\W+/g, "-"), files);
  const { code: exit, out } = xzorBuild(dir);
  expect(exit).not.toBe(0);
  expect(out).toContain(code);
  for (const part of parts) expect(out).toContain(part);
});

test("the generated server: sync and async handlers, query keys, shells and assets", () => {
  const dir = join(repo, "target", "tmp-serve", `fixture-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(serverRoot, dir, { recursive: true, filter: (src) => !/[\\/](\.xzor|node_modules)$/.test(src) });
  temps.push(dir);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "server", "app.ts"), "utf8");
  expect(text).toContain('import { HttpError, type IServerApplication, reply, replyAsync, serveDist } from "@source-crafter/xzor-runtime/server";');
  expect(text).toContain("class App$ extends App {");
  expect(text).toContain("const app = new App$();");
  expect(text).toContain("const posts = new Posts(app.postStore);");
  expect(text).toContain('const posts$get = (req: Bun.BunRequest<"/api/posts/:slug">) => reply(posts.get(req.params.slug));');
  expect(text).toMatch(/const posts\$create = async \(req: Bun\.BunRequest<"\/api\/posts">\) => \{[^]*?return replyAsync\(posts\.create\(body\$\)\);/);
  expect([...text.matchAll(/search\$\.get\("(\w+)"\)/g)].map((m) => m[1])).toEqual(["tag", "page"]);
  expect(text).not.toContain("Object.fromEntries");
  expect(text).toContain('const root = join(import.meta.dir, import.meta.file === "server.js" ? ".." : "../..");');
  expect(text).toContain("const dist = serveDist(root, !process.env.XZOR_DEV);");
  expect(text).toContain("...(dist.found ? dist.routes : null),");
  // The pages.json logic lives in the runtime's serveDist, not in the generated server.
  for (const inlined of ["staticFiles", "pages.json\"", "pagesJson", "readFileSync", "existsSync"]) expect(text).not.toContain(inlined);
  expect(text).toContain('"/api/posts": { GET: posts$list, POST: posts$create },');
  expect(text).toContain("...options.routes,");
  expect(text).toContain("?? dist.fallback,");
  expect(text).toContain('{ port: Number(process.env.PORT), hostname: "127.0.0.1" } : { hostname: options.hostname ?? process.env.HOST }');
  // Only the server entry: no browser mount, and the app's file is no longer a plain provider.
  expect(text).not.toContain("mount(");
  expect(existsSync(join(dir, ".xzor", "server", "app.provider.ts"))).toBe(false);
});

test("the generated server answers endpoints in-process", async () => {
  const api = endpoints(
    `import { HttpError } from "@source-crafter/xzor-runtime/server";

@Endpoints("/api/items")
export class Items {
  @Get(":id")
  get(id: number) { return { id }; }

  @Get
  list(query: { tag?: string; on?: boolean }) { return query; }

  @Query
  find(body: { q: string }) { return { found: body.q }; }

  @Delete(":id")
  remove(id: number): void { throw new HttpError(409, "busy " + id); }

  @Post
  async add(body: { name: string }): Promise<{ name: string }> { return body; }
}
`,
    "Delete, Get, Post, Query",
  );
  const dir = serverProject("in-process", { "api.ts": api });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(text).toContain("const p$0 = Number(req.params.id);");
  expect(text).toContain("if (Number.isNaN(p$0)) return bad();");
  expect(text).not.toContain("staticFiles");
  // The test preload installs happy-dom's Response and fetch, which Bun.serve can't take.
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  const { server } = await import(join(dir, ".xzor", "app.ts"));
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(new URL(path, server.url), { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return [r.status, await r.text()];
  };
  try {
    expect(await call("GET", "/api/items/7")).toEqual([200, '{"id":7}']);
    expect(await call("GET", "/api/items/seven")).toEqual([400, ""]);
    expect(await call("GET", "/api/items?tag=a&on=true&other=1")).toEqual([200, '{"tag":"a","on":true}']);
    expect(await call("GET", "/api/items?on=maybe")).toEqual([400, ""]);
    expect(await call("QUERY", "/api/items", { q: "x" })).toEqual([200, '{"found":"x"}']);
    expect(await call("POST", "/api/items", { name: "n" })).toEqual([200, '{"name":"n"}']);
    // A body is read only from a JSON request: a cross-site form post is a "simple" request with another type.
    const post = async (type: string): Promise<[number, string]> => {
      const r = await fetch(new URL("/api/items", server.url), { method: "POST", headers: { "content-type": type }, body: '{"name":"n"}' });
      return [r.status, await r.text()];
    };
    expect(await post("text/plain")).toEqual([415, ""]);
    expect(await post("application/x-www-form-urlencoded")).toEqual([415, ""]);
    expect(await post("application/jsonx")).toEqual([415, ""]);
    expect(await post("application/json; charset=utf-8")).toEqual([200, '{"name":"n"}']);
    expect(await post("Application/JSON")).toEqual([200, '{"name":"n"}']);
    expect(await call("PUT", "/api/items")).toEqual([405, ""]);
    expect(await call("DELETE", "/api/items/3")).toEqual([409, "busy 3"]);
    expect(await call("GET", "/nope")).toEqual([404, ""]);
  } finally {
    server.stop(true);
    GlobalRegistrator.register();
  }
});

// Serves the generated entry of a built project in-process; the test preload's happy-dom Response and fetch can't go into Bun.serve.
async function served(entry: string, run: (call: (method: string, path: string, body?: unknown) => Promise<[number, string]>) => Promise<void>) {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  await GlobalRegistrator.unregister();
  try {
    const { server } = await import(entry);
    try {
      await run(async (method, path, body) => {
        const r = await fetch(new URL(path, server.url), { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return [r.status, await r.text()];
      });
    } finally {
      server.stop(true);
    }
  } finally {
    GlobalRegistrator.register();
  }
}

test.each([
  ["without an app error handler", "", undefined],
  ["with an app error handler", `\n  error(e: unknown) { return new Response("custom " + (this as any).tag, { status: 500 }); }\n  tag = "app";`, "custom app"],
])("an endpoint's HttpError keeps its status, sync or async, %s", async (name, extra, other) => {
  const app = apiApp.replace("  port = 0;", `  port = 0;${extra}`);
  const api = endpoints(
    `import { HttpError } from "@source-crafter/xzor-runtime/server";

@Endpoints("/api/e")
export class E {
  @Get("sync")
  sync(): void { throw new HttpError(409, "sync busy"); }

  @Get("async")
  async later(): Promise<void> { throw new HttpError(410, "async gone"); }

  @Post
  create(body: { a: string }): void { throw new HttpError(422, "bad body"); }

  @Get("plain")
  plain(): void { throw new Error("Boom"); }
}
`,
    "Get, Post",
  );
  const dir = serverProject("http-error-" + name.replace(/\W+/g, "-"), { "app.ts": app, "api.ts": api });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/e/sync")).toEqual([409, "sync busy"]);
    expect(await call("GET", "/api/e/async")).toEqual([410, "async gone"]);
    expect(await call("POST", "/api/e", { a: "x" })).toEqual([422, "bad body"]);
    // Any other error goes to the app's own handler; without one it is a plain 500 with nothing of the error in it.
    expect(await call("GET", "/api/e/plain")).toEqual([500, other ?? "Internal Server Error"]);
  });
});

// `CurrentUser(req: Request)` is scoped: `Me` reaches it and is built per request; `Count` is built once.
const requestApp = (regs: string) => `import { Run, Scoped, Singleton } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import { CurrentUser } from "./user";
import { Store } from "./store";
import { AuthCache } from "./auth";

@Run()
${regs}
export class App implements IServerApplication {
  port = 0;
}
`;
const requestFiles: Record<string, string> = {
  "app.ts": requestApp("@Scoped(CurrentUser)\n@Singleton(Store)"),
  "user.ts": `export class CurrentUser {
  name: string;
  constructor(req: Request) { this.name = new URL(req.url).searchParams.get("u") ?? "anon"; }
}
`,
  "store.ts": "export class Store {\n  n = 0;\n}\n",
  "auth.ts": `import { CurrentUser } from "./user";\n\nexport class AuthCache {\n  constructor(readonly user: CurrentUser) {}\n}\n`,
  "api/me.ts": endpoints(`import { CurrentUser } from "../user";
import { Store } from "../store";

@Endpoints("/api/me")
export class Me {
  constructor(private user: CurrentUser, private store: Store) {}
  @Get
  get() { return { name: this.user.name, n: ++this.store.n }; }
}
`),
  "api/count.ts": endpoints(`import { Store } from "../store";

@Endpoints("/api/count")
export class Count {
  constructor(private store: Store) {}
  @Get
  get() { return { n: this.store.n }; }
}
`),
};

test("an endpoint that needs the Request is built per request in a scope; others once", async () => {
  const dir = serverProject("request-scope", requestFiles);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(text).toContain("class App$Scope {");
  expect(text).toContain("get currentUser(): CurrentUser { return (this.#currentUser ??= new CurrentUser(this.#request)); }");
  expect(text).toContain("get store(): Store { return this.#app.store; }");
  expect(text).toContain("const count = new Count(app.store);");
  expect(text).toContain('const count$get = (_req: Bun.BunRequest<"/api/count">) => reply(count.get());');
  expect(text).toContain("const s$ = new App$Scope(app, req);");
  expect(text).toContain("return reply(new Me(s$.currentUser, s$.store).get());");
  // The app itself never builds a service that needs the request.
  expect(text.slice(0, text.indexOf("class App$Scope"))).not.toContain("CurrentUser(");
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/me?u=bob")).toEqual([200, '{"name":"bob","n":1}']);
    expect(await call("GET", "/api/me")).toEqual([200, '{"name":"anon","n":2}']);
    expect(await call("GET", "/api/count")).toEqual([200, '{"n":2}']);
  });
});

test("a service injecting an @Endpoints contract gets the endpoint's own instance", async () => {
  const dir = serverProject("contract-instance", {
    "app.ts": `import { Run, Singleton } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import { Digest } from "./digest";

@Run()
@Singleton(Digest)
export class App implements IServerApplication {
  port = 0;
}
`,
    "contract.ts": "export interface IPosts {\n  hit(): number;\n}\n",
    "digest.ts": 'import type { IPosts } from "./contract";\n\nexport class Digest {\n  constructor(readonly posts: IPosts) {}\n}\n',
    "api/posts.ts": endpoints(`import type { IPosts } from "../contract";
import { Digest } from "../digest";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  n = 0;
  hit() { return ++this.n; }
  @Get
  list() { return { n: this.hit() }; }
}

@Endpoints("/api/digest")
export class Summary {
  constructor(private digest: Digest) {}
  @Get
  get() { return { n: this.digest.posts.hit() }; }
}
`),
  });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/posts")).toEqual([200, '{"n":1}']);
    expect(await call("GET", "/api/digest")).toEqual([200, '{"n":2}']);
    expect(await call("GET", "/api/posts")).toEqual([200, '{"n":3}']);
  });
});

test("a singleton that needs the Request is an error naming the chain", () => {
  const app = requestApp("@Scoped(CurrentUser)\n@Singleton(Store)\n@Singleton(AuthCache)");
  const dir = serverProject("request-captive", { ...requestFiles, "app.ts": app });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("ZDI19");
  expect(out).toContain("AuthCache -> CurrentUser -> Request is built once but needs the request");
});

// Only a server app has a `Request` to inject: in a browser app it is a type like any other.
const browserFiles = (regs: string, view = "<p>hi</p>"): Record<string, string> => ({
  "app.ts": `import { Run, Singleton, type IApplication } from "@source-crafter/xzor-runtime";
import Shell from "./Shell.xzor";
import { Clock } from "./clock";
import { makeRequest } from "./make";

@Run(Shell, "app")
${regs}
export class App implements IApplication {}
`,
  "Shell.xzor": view,
  "clock.ts": "export class Clock {\n  constructor(readonly req: Request) {}\n}\n",
  "make.ts": 'export const makeRequest = (): Request => new Request("http://localhost/");\n',
});

test("a browser app resolves a Request parameter like any type", () => {
  const dir = serverProject("browser-request", browserFiles('@Singleton(Clock)\n@Singleton("req", makeRequest)'));
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(text).toContain("new Clock(");
  expect(text).toContain("makeRequest");
  expect(text).not.toContain("#request");
});

test("a browser app without a registered Request reports the usual DI errors", () => {
  const service = xzorBuild(serverProject("browser-no-request", browserFiles("@Singleton(Clock)")));
  expect(service.code).not.toBe(0);
  expect(service.out).toContain("ZDI02");
  expect(service.out).toContain("Request (needed by Clock in provider App) is not registered or imported");
  expect(service.out).not.toContain("#request");
  const view = xzorBuild(serverProject("browser-no-request-view", browserFiles("", "@inject Request req\n<p>hi</p>")));
  expect(view.code).not.toBe(0);
  expect(view.out).toContain("ZDI04");
  expect(view.out).toContain("Request (injected as req in Shell) is not provided by App");
});

test("an endpoint without a disposable scoped service emits no dispose call", () => {
  const dir = serverProject("scope-no-dispose", requestFiles);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(text).toContain("const s$ = new App$Scope(app, req);");
  expect(text).not.toMatch(/dispos|finally/i);
});

// `Conn` is scoped and disposable: `Job` (sync and async handlers) reaches it, `Stat` reads how many were disposed.
const connFiles = (dispose: string): Record<string, string> => ({
  "app.ts": requestApp("@Scoped(Conn)\n@Singleton(Store)").replace('import { CurrentUser } from "./user";', 'import { Conn } from "./conn";'),
  "store.ts": "export class Store {}\n",
  "auth.ts": "export class AuthCache {}\n",
  "conn.ts": `const g = globalThis as any;\ng.opened = 0;\ng.disposed = 0;\n\nexport class Conn {\n  constructor() { g.opened++; }\n  ${dispose}\n}\n`,
  "api/job.ts": endpoints(`import { Conn } from "../conn";
import { Store } from "../store";

@Endpoints("/api/job")
export class Job {
  constructor(private conn: Conn) {}
  @Get
  now() { return { open: (globalThis as any).opened - (globalThis as any).disposed }; }
  @Get("later")
  async later(): Promise<{ open: number }> { await Promise.resolve(); return { open: (globalThis as any).opened - (globalThis as any).disposed }; }
}

@Endpoints("/api/stat")
export class Stat {
  constructor(private store: Store) {}
  @Get
  get() { return { opened: (globalThis as any).opened, disposed: (globalThis as any).disposed }; }
}
`),
});

test.each([
  ["Symbol.dispose", "[Symbol.dispose]() { g.disposed++; }", "s$.dispose();", ""],
  ["Symbol.asyncDispose", "async [Symbol.asyncDispose]() { await Promise.resolve(); g.disposed++; }", "await s$.disposeAsync();", "async "],
])("a per-request scope disposes its %s service once per request, sync and async handlers", async (name, dispose, call, asyncKw) => {
  const dir = serverProject("scope-dispose-" + name.replace(/\W+/g, "-"), connFiles(dispose));
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  // The sync handler awaits an async disposal; the async one awaits its reply first; Stat's scope-free handler has neither.
  expect(text).toMatch(new RegExp(`const job\\$now = ${asyncKw}\\(req: [^]*?try \\{\\n    return reply\\(new Job\\(s\\$\\.conn\\)\\.now\\(\\)\\);\\n  \\} finally \\{\\n    ${call.replace(/[$.()]/g, "\\$&")}\\n  \\}`));
  expect(text).toMatch(new RegExp(`const job\\$later = async \\(req: [^]*?return await replyAsync\\(new Job\\(s\\$\\.conn\\)\\.later\\(\\)\\);\\n  \\} finally \\{\\n    ${call.replace(/[$.()]/g, "\\$&")}`));
  expect(text.match(/finally/g)).toHaveLength(2);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/job")).toEqual([200, '{"open":1}']);
    expect(await call("GET", "/api/job/later")).toEqual([200, '{"open":1}']);
    expect(await call("GET", "/api/job")).toEqual([200, '{"open":1}']);
    expect(await call("GET", "/api/stat")).toEqual([200, '{"opened":3,"disposed":3}']);
  });
});

test("a per-request scope disposes only its scoped services, never a singleton it reaches", async () => {
  const files = connFiles("[Symbol.dispose]() { g.disposed++; }");
  const dir = serverProject("scope-singleton-dispose", {
    ...files,
    "app.ts": requestApp("@Scoped(Conn)\n@Singleton(Pool)\n@Singleton(Store)")
      .replace('import { CurrentUser } from "./user";', 'import { Conn } from "./conn";\nimport { Pool } from "./pool";'),
    "pool.ts": `const g = globalThis as any;\ng.poolDisposed = 0;\n\nexport class Pool {\n  [Symbol.dispose]() { g.poolDisposed++; }\n}\n`,
    "api/job.ts": endpoints(`import { Conn } from "../conn";
import { Pool } from "../pool";
import { Store } from "../store";

@Endpoints("/api/job")
export class Job {
  constructor(private conn: Conn, private pool: Pool) {}
  @Get
  now() { return { ok: true }; }
}

@Endpoints("/api/stat")
export class Stat {
  constructor(private store: Store) {}
  @Get
  get() { return { disposed: (globalThis as any).disposed, pool: (globalThis as any).poolDisposed }; }
}
`),
  });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const text = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(text).not.toContain("App$Scope.#pool");
  expect(text.slice(text.indexOf("class App$Scope"))).toMatch(/dispose\(\): void \{[^}]*#conn/);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/job")).toEqual([200, '{"ok":true}']);
    expect(await call("GET", "/api/job")).toEqual([200, '{"ok":true}']);
    expect(await call("GET", "/api/stat")).toEqual([200, '{"disposed":2,"pool":0}']);
  });
});

// A server app with views: `@Singleton(Theme)` reached by a view, `@Import(DataServices)` only by the server.
const viewsApp = `import { Import, Run, Singleton } from "@source-crafter/xzor-runtime";
import type { IServerApplication } from "@source-crafter/xzor-runtime/server";
import Shell from "./Shell.xzor";
import { DataServices } from "./data";
import { Theme } from "./theme";

@Run(Shell)
@Singleton(Theme)
@Import(DataServices)
export class App implements IServerApplication {
  port = 0;
}
`;
const viewsFiles: Record<string, string> = {
  "app.ts": viewsApp,
  "theme.ts": "export class Theme {\n  dark = false;\n}\n",
  "store.ts": "export class Store {}\n",
  "data.ts": `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
import { Store } from "./store";

@ServiceProvider()
@Singleton(Store)
export class DataServices {}
`,
  "Shell.xzor": '@import Header from "./Header.xzor"\n\n<Header />\n',
  "Header.xzor": '@import { type Theme } from "./theme"\n@inject Theme theme\n\n<header>@theme.dark</header>\n',
};

test("a server app with views: the browser entry registers only what the views reach", () => {
  const dir = serverProject("split", viewsFiles);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const client = readFileSync(join(dir, ".xzor", "client.ts"), "utf8");
  expect(client).toContain("class Client$ {");
  expect(client).toContain("get theme(): Theme { return (Client$.#theme ??= new Theme()); }");
  expect(client).toContain("if (type === Header) return new Header(this.theme);");
  expect(client).toContain("mount(Shell, document.body, new Client$());");
  expect(client).toContain('import { Theme } from "../theme";');
  expect(client).not.toMatch(/Store|DataServices/);
  expect(client).not.toMatch(/from "\.\.\/app"/);
  const server = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(server).toContain("get theme(): Theme");
  expect(server).toContain("get store(): Store");
  expect(server).not.toContain("mount(");
});

test("a server app whose views inject nothing mounts without a container", () => {
  const dir = serverProject("split-plain", { ...viewsFiles, "Header.xzor": "<header>h</header>\n" });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const client = readFileSync(join(dir, ".xzor", "client.ts"), "utf8");
  expect(client).toContain("mount(Shell, document.body);");
  expect(client).not.toMatch(/Theme|Client\$/);
});

// Server-only code a view must not reach: the request, an `@Endpoints` class, a `bun:*` module.
const leakApp = (regs: string) => viewsApp.replace("@Singleton(Theme)", `@Singleton(Theme)\n${regs}`).replace('import { Theme } from "./theme";', `import { Theme } from "./theme";
import { CurrentUser } from "./user";
import { Feed } from "./feed";
import { Db } from "./db";
import { Posts } from "./api/posts";`).replace("Import, Run, Singleton", "Import, Run, Scoped, Singleton");
const leakFiles: Record<string, string> = {
  ...viewsFiles,
  "user.ts": "export class CurrentUser {\n  constructor(readonly req: Request) {}\n}\n",
  "db.ts": 'import { Database } from "bun:sqlite";\n\nexport class Db {\n  db = new Database(":memory:");\n}\n',
  "feed.ts": 'import type { Db } from "./db";\n\nexport class Feed {\n  constructor(readonly db: Db) {}\n}\n',
  "api/posts.ts": endpoints(`@Endpoints("/api/posts")\nexport class Posts {\n  @Get\n  list() { return []; }\n}\n`),
};
const header = (ty: string) => `@import { type ${ty} } from "./${ty === "CurrentUser" ? "user" : ty === "Posts" ? "api/posts" : ty.toLowerCase()}"\n@inject ${ty} x\n\n<header>h</header>\n`;

test.each([
  ["the request", "@Scoped(CurrentUser)", "CurrentUser", "Header -> CurrentUser -> Request: a view can't reach the request"],
  ["a bun: module", "@Singleton(Db)\n@Singleton(Feed)", "Feed", "Header -> Feed -> Db -> bun:sqlite: a view can't reach a server-only module"],
  ["an @Endpoints class", "@Singleton(Posts)", "Posts", "Header -> Posts: a view can't reach an @Endpoints class"],
])("a view reaching %s is an error naming the chain", (_, regs, ty, message) => {
  const dir = serverProject(`leak-${ty}`, { ...leakFiles, "app.ts": leakApp(regs), "Header.xzor": header(ty) });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("ZDI20");
  expect(out).toContain(message);
});

test("the server alone may reach the request and bun: modules", () => {
  const dir = serverProject("leak-server-only", { ...leakFiles, "app.ts": leakApp("@Scoped(CurrentUser)\n@Singleton(Db)\n@Singleton(Feed)") });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  expect(readFileSync(join(dir, ".xzor", "client.ts"), "utf8")).not.toMatch(/CurrentUser|Feed|Db/);
});

test.each([
  ["a view", { "Header.xzor": '@import { Posts } from "./api/posts"\n\n<header>@Posts.name</header>\n' }, "Header.xzor"],
  ["a browser-reached service", { "theme.ts": 'import { Posts } from "./api/posts";\n\nexport class Theme {\n  dark = Posts.name === "";\n}\n' }, "theme.ts"],
])("%s importing an @Endpoints class as a value is an error", (_, files, file) => {
  const dir = serverProject(`value-${file}`, { ...leakFiles, "app.ts": leakApp(""), ...files });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain(`${file}(1,`);
  expect(out).toContain("ZDI21");
  expect(out).toContain("Posts is an @Endpoints class: use import type");
});

test("import type of an @Endpoints class in browser code is allowed", () => {
  const theme = 'import type { Posts } from "./api/posts";\n\nexport class Theme {\n  dark = false;\n  posts?: Posts;\n}\n';
  const dir = serverProject("value-type", { ...leakFiles, "app.ts": leakApp(""), "theme.ts": theme });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
});

test("two @Endpoints classes implementing one contract is ZDI23 naming both files", () => {
  const impl = (name: string) => endpoints(`import type { IPosts } from "../contract";\n\n@Endpoints("/api/${name}")\nexport class ${name} implements IPosts {\n  hit() { return 1; }\n  @Get\n  list() {}\n}\n`);
  const dir = serverProject("contract-twice", { "contract.ts": "export interface IPosts {\n  hit(): number;\n}\n", "api/a.ts": impl("A"), "api/b.ts": impl("B") });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("ZDI23");
  expect(out).toContain("IPosts is implemented by two @Endpoints classes: A (api/a.ts) and B (api/b.ts)");
});

test.each([
  ["@inject IPosts", '@import { type IPosts } from "./contract"\n@inject IPosts posts\n\n<header>h</header>\n', "IPosts"],
  ["@inject Remote<IPosts>", '@import { type IPosts } from "./contract"\n@import { type Remote } from "@source-crafter/xzor-runtime"\n@inject Remote<IPosts> posts\n\n<header>h</header>\n', "Remote<IPosts>"],
])("a view with %s that no @Endpoints class implements is ZDI24", (_, header, name) => {
  const dir = serverProject(`contract-none-${name.replace(/\W+/g, "")}`, { ...viewsFiles, "contract.ts": "export interface IPosts {\n  hit(): number;\n}\n", "Header.xzor": header });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("ZDI24");
  expect(out).toContain("no @Endpoints class implements IPosts");
  expect(out).toContain("injected as posts in Header");
});

const clientContract = `export interface Item {
  slug: string;
}

export interface IPosts {
  get(slug: string): Item | undefined;
  list(query: { tag?: string; page?: number }): Item[];
  create(body: { slug: string }): Promise<Item>;
  tag(id: number, label: string, body: { x: string }): void;
}
`;
const clientFiles: Record<string, string> = {
  ...viewsFiles,
  "contract.ts": clientContract,
  "api/posts.ts": endpoints(`import type { IPosts, Item } from "../contract";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  @Get(":slug")
  get(slug: string): Item | undefined { return undefined; }
  @Get
  list(query: { tag?: string; page?: number }): Item[] { return []; }
  @Post
  async create(body: { slug: string }): Promise<Item> { return body; }
  @Put(":id/tag/:label")
  tag(id: number, label: string, body: { x: string }): void {}
}
`, "Get, Post, Put"),
  "Header.xzor": '@import { type IPosts } from "./contract"\n@inject IPosts posts\n\n<header>h</header>\n',
};

test("a view injecting a contract gets its generated client in the browser container", () => {
  const dir = serverProject("client-plain", clientFiles);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const client = readFileSync(join(dir, ".xzor", "client.ts"), "utf8");
  expect(client).toContain('import { IPostsClient } from "./clients/IPosts";');
  expect(client).toContain("import type { IPosts } from \"../contract\";");
  expect(client).toContain("get remoteIPosts(): Remote<IPosts> { return (Client$.#remoteIPosts ??= new IPostsClient()); }");
  expect(client).toContain("if (type === Header) return new Header(this.remoteIPosts);");
  expect(client).not.toMatch(/from "\.\.\/(app|api)/);
  const text = readFileSync(join(dir, ".xzor", "clients", "IPosts.ts"), "utf8");
  expect(text).toContain('import { call, segment } from "@source-crafter/xzor-runtime";');
  expect(text).toContain('import type { Posts } from "../../api/posts";');
  expect(text).toContain("export class IPostsClient {");
  expect(text).toContain(
    '  async get(slug: Parameters<Posts["get"]>[0]) {\n    return call("GET", "/api/posts/" + segment(slug), undefined, undefined) as Promise<Awaited<ReturnType<Posts["get"]>>>;\n  }',
  );
  expect(text).toContain('list(query: Parameters<Posts["list"]>[0]) {\n    return call("GET", "/api/posts", query, undefined)');
  expect(text).toContain('create(body: Parameters<Posts["create"]>[0]) {\n    return call("POST", "/api/posts", undefined, body)');
  expect(text).toContain('call("PUT", "/api/posts/" + segment(id) + "/tag/" + segment(label), undefined, body)');
  expect(text).toMatch(/\n  async tag\(/);
  expect(text).toMatch(/\n  list\(/);
  const server = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(server).not.toMatch(/IPostsClient|clients\//);
});

test("a generated client rejects a path parameter that would leave its route, before fetching", () => {
  const dir = serverProject("client-dots", clientFiles);
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const script = join(dir, "dots.ts");
  writeFileSync(
    script,
    `import { IPostsClient } from "./.xzor/clients/IPosts";
const urls: string[] = [];
globalThis.fetch = (async (url: string) => (urls.push(url), Response.json({ slug: "x" }))) as unknown as typeof fetch;
const client = new IPostsClient();
const results: string[] = [];
for (const v of ["", ".", "..", "a/b"]) {
  const p = client.get(v);
  results.push(p instanceof Promise ? await p.then(() => "ok", (e) => e.constructor.name + ":" + e.status) : "sync");
}
results.push(await client.tag(1, "..", { x: "" }).then(() => "ok", (e) => e.status));
console.log(JSON.stringify({ results, urls }));
`,
  );
  const run = Bun.spawnSync(["bun", script], { cwd: dir });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({ results: ["HttpError:400", "HttpError:400", "HttpError:400", "ok", 400], urls: ["/api/posts/a%2Fb"] });
});

test("Remote<IPosts> in a view or a browser service resolves to the client, and the project type-checks", () => {
  const dir = serverProject("client-remote", {
    ...clientFiles,
    "app.ts": viewsApp.replace("@Singleton(Theme)", "@Singleton(Theme)\n@Singleton(Feed)").replace('import { Theme } from "./theme";', 'import { Theme } from "./theme";\nimport { Feed } from "./feed";'),
    "feed.ts": 'import type { Remote } from "@source-crafter/xzor-runtime";\nimport type { IPosts } from "./contract";\n\nexport class Feed {\n  constructor(readonly posts: Remote<IPosts>) {}\n  async first() { return (await this.posts.list({ tag: "a" }))[0]; }\n}\n',
    "Header.xzor": '@import { type Feed } from "./feed"\n@import { type IPosts } from "./contract"\n@import { type Remote } from "@source-crafter/xzor-runtime"\n@inject Feed feed\n@inject Remote<IPosts> posts\n\n<header>h</header>\n',
  });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const client = readFileSync(join(dir, ".xzor", "client.ts"), "utf8");
  expect(client.match(/new IPostsClient\(\)/g)).toHaveLength(1);
  expect(client).toMatch(/new Feed\(this\.remoteIPosts\)/);
  // The scratch project has no Bun/node types, so only the lines about the client files are asserted.
  const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", dir, "--noEmit"], { cwd: repo });
  const errors = (tsc.stdout.toString() + tsc.stderr.toString()).split("\n").filter((l) => /\.xzor\/clients?[./]|\/feed\.ts|remoteIPosts|IPostsLocal/.test(l));
  expect(errors.join("\n"), "tsc").toBe("");
  const server = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(server).toContain("class IPostsLocal$ {");
  expect(server).toContain("get remoteIPosts(): Remote<IPosts> { return (App$.#remoteIPosts ??= new IPostsLocal$(this.posts)); }");
  expect(server).toContain('get(slug: Parameters<Posts["get"]>[0]) { return Promise.resolve(this.#target.get(slug)); }');
  expect(server).toContain('create(body: Parameters<Posts["create"]>[0]) { return this.#target.create(body); }');
  expect(server).not.toContain("as unknown");
  expect(server).not.toMatch(/IPostsClient/);
});

// `@inject IPosts posts` is typed `Remote<IPosts>` once DI knows the contract: the async view type-checks, the sync one doesn't.
test.each([
  ["awaited", "async load(slug: string) { this.title = (await this.posts.get(slug))?.slug ?? \"\"; }", false],
  ["sync", "load(slug: string) { this.title = this.posts.get(slug).slug; }", true],
])("a view's @inject of a contract is Remote<...>: %s use", (name, method, fails) => {
  const header = `@import { type IPosts } from "./contract"\n@inject IPosts posts\n\n<header>@title</header>\n\n@code {\n  title = "";\n  ${method}\n}\n`;
  const dir = serverProject(`client-typed-${name}`, { ...clientFiles, "Header.xzor": header });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const generated = readFileSync(join(dir, ".xzor", "Header.xzor.ts"), "utf8");
  expect(generated).toContain("readonly posts: Remote<IPosts>;");
  expect(generated).toContain('import { Component as __Component, dom as __dom, type El, type Remote } from "@source-crafter/xzor-runtime";');
  const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", dir, "--noEmit"], { cwd: repo });
  // The scratch project has no Bun/node types, so only the lines about the view are asserted.
  const errors = (tsc.stdout.toString() + tsc.stderr.toString()).split("\n").filter((l) => /Header\.xzor/.test(l) && !/xzor-runtime\/model/.test(l));
  if (fails) expect(errors.join("\n")).toMatch(/Property 'slug' does not exist on type 'Promise<Item \| undefined>'/);
  else expect(errors.join("\n"), "tsc").toBe("");
});

test("on the server, Remote<IPosts> in a shared service is an in-process adapter returning real Promises", async () => {
  const dir = serverProject("client-local", {
    ...clientFiles,
    "app.ts": viewsApp.replace("@Singleton(Theme)", "@Singleton(Theme)\n@Singleton(Feed)").replace('import { Theme } from "./theme";', 'import { Theme } from "./theme";\nimport { Feed } from "./feed";'),
    "feed.ts": 'import type { Remote } from "@source-crafter/xzor-runtime";\nimport type { IPosts } from "./contract";\n\nexport class Feed {\n  constructor(readonly posts: Remote<IPosts>) {}\n}\n',
    "api/posts.ts": endpoints(
      `import type { IPosts, Item } from "../contract";
import { Feed } from "../feed";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  @Get(":slug")
  get(slug: string): Item | undefined { return { slug }; }
  @Get
  list(query: { tag?: string; page?: number }): Item[] { return []; }
  @Post
  async create(body: { slug: string }): Promise<Item> { return body; }
  @Put(":id/tag/:label")
  tag(id: number, label: string, body: { x: string }): void {}
}

@Endpoints("/api/feed")
export class FeedApi {
  constructor(private feed: Feed) {}
  @Get
  async check() {
    const sync = this.feed.posts.get("a");
    const later = this.feed.posts.create({ slug: "b" });
    return { syncPromise: sync instanceof Promise, asyncPromise: later instanceof Promise, sync: await sync.then((i) => i?.slug), async: (await later.then((i) => i)).slug };
  }
}
`,
      "Get, Post, Put",
    ),
  });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/feed")).toEqual([200, '{"syncPromise":true,"asyncPromise":true,"sync":"a","async":"b"}']);
  });
});

test("a contract used by services in an @Import-ed provider: client in the browser, endpoint on the server", async () => {
  const dir = serverProject("client-imported", {
    ...clientFiles,
    "data.ts": `import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";
import { Store } from "./store";
import { Feed } from "./feed";
import { Digest } from "./digest";

@ServiceProvider()
@Singleton(Store)
@Singleton(Feed)
@Singleton(Digest)
export class DataServices {}
`,
    "feed.ts": 'import type { Remote } from "@source-crafter/xzor-runtime";\nimport type { IPosts } from "./contract";\n\nexport class Feed {\n  constructor(readonly posts: Remote<IPosts>) {}\n}\n',
    "digest.ts": 'import type { IPosts } from "./contract";\n\nexport class Digest {\n  constructor(readonly posts: IPosts) {}\n  first() { return this.posts.get("a")?.slug; }\n}\n',
    "Header.xzor": '@import { type Feed } from "./feed"\n@inject Feed feed\n\n<header>h</header>\n',
    "api/posts.ts": endpoints(
      `import type { IPosts, Item } from "../contract";
import { Digest } from "../digest";

@Endpoints("/api/posts")
export class Posts implements IPosts {
  @Get(":slug")
  get(slug: string): Item | undefined { return { slug }; }
  @Get
  list(query: { tag?: string; page?: number }): Item[] { return []; }
  @Post
  async create(body: { slug: string }): Promise<Item> { return body; }
  @Put(":id/tag/:label")
  tag(id: number, label: string, body: { x: string }): void {}
}

@Endpoints("/api/digest")
export class DigestApi {
  constructor(private digest: Digest) {}
  @Get
  first() { return { first: this.digest.first() }; }
}
`,
      "Get, Post, Put",
    ),
  });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  const client = readFileSync(join(dir, ".xzor", "client.ts"), "utf8");
  expect(client).toMatch(/new Feed\(this\.remoteIPosts\)/);
  expect(client).toContain("new IPostsClient()");
  const server = readFileSync(join(dir, ".xzor", "app.ts"), "utf8");
  expect(server).not.toMatch(/IPostsClient/);
  await served(join(dir, ".xzor", "app.ts"), async (call) => {
    expect(await call("GET", "/api/digest")).toEqual([200, '{"first":"a"}']);
  });
});

test("no client is written when no view reaches a contract", () => {
  const dir = serverProject("client-none", { ...clientFiles, "Header.xzor": "<header>h</header>\n" });
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  expect(existsSync(join(dir, ".xzor", "clients"))).toBe(false);
});

test("a browser-reached service taking a contract by its own name is ZDI25", () => {
  const dir = serverProject("client-contract-service", {
    ...clientFiles,
    "app.ts": viewsApp.replace("@Singleton(Theme)", "@Singleton(Theme)\n@Singleton(Feed)").replace('import { Theme } from "./theme";', 'import { Theme } from "./theme";\nimport { Feed } from "./feed";'),
    "feed.ts": 'import type { IPosts } from "./contract";\n\nexport class Feed {\n  constructor(readonly posts: IPosts) {}\n}\n',
    "Header.xzor": '@import { type Feed } from "./feed"\n@inject Feed feed\n\n<header>h</header>\n',
  });
  const { code, out } = xzorBuild(dir);
  expect(code).not.toBe(0);
  expect(out).toContain("ZDI25");
  expect(out).toContain("IPosts is a contract: use Remote<IPosts> in browser code");
  expect(out).toContain("feed.ts");
  expect(out).not.toContain("ZDI20");
});

test("the generated server serves shells and files from a page-shells pages.json", async () => {
  const dir = join(repo, "target", "tmp-serve", `shells-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(serverRoot, dir, { recursive: true, filter: (src) => !/[\\/](\.xzor|node_modules)$/.test(src) });
  temps.push(dir);
  const app = join(dir, "server", "app.ts");
  writeFileSync(app, readFileSync(app, "utf8").replace("port = 3000", "port = 0"));
  // The format the page-shells build writes: `routes` relative to dist, `files` relative to the project root.
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>index</title>",
    "dist/main.js": "console.log(1);",
    "dist/pages/Post.html": "<!doctype html><title>post</title>",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  writeFileSync(join(dir, "dist", "pages.json"), JSON.stringify({ routes: { "/posts/:slug": "pages/Post.html" }, files: Object.keys(files).sort() }));
  const { code, out } = xzorBuild(dir);
  expect(code, out).toBe(0);
  await served(join(dir, ".xzor", "server", "app.ts"), async (call) => {
    expect(await call("GET", "/posts/hello")).toEqual([200, files["dist/pages/Post.html"]]);
    expect(await call("GET", "/dist/main.js")).toEqual([200, files["dist/main.js"]]);
    expect(await call("GET", "/index.html")).toEqual([200, files["index.html"]]);
    expect(await call("GET", "/nope")).toEqual([404, files["index.html"]]);
  });
});
