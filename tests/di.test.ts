import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "fixtures", "di");
const script = join(import.meta.dir, "..", "src", "di.ts");

// Stand-ins for what codegen emits into .zor/ (the folder is gitignored).
const generated: Record<string, string> = {
  "App.tszor.ts": `import { ComponentBase, type RenderTreeBuilder } from "@zor/runtime";
export default class App extends ComponentBase {
  protected override buildRenderTree(__b: RenderTreeBuilder): void {}
}
`,
  "Counter.tszor.ts": `import { ComponentBase, type RenderTreeBuilder } from "@zor/runtime";
import type { IDatabase } from "./services/data";
import { AuthService } from "./main";
export default class Counter extends ComponentBase {
  static readonly inject = ["db", "auth"];
  readonly db: IDatabase;
  readonly auth: AuthService;
  constructor(db: IDatabase, auth: AuthService) { super(); this.db = db; this.auth = auth; }
  protected override buildRenderTree(__b: RenderTreeBuilder): void { __b.addContent(this.db.name); }
}
`,
};

let facts: any;
const provider = (name: string) => facts.providers.find((p: any) => p.class.text === name);
const reg = (p: string, pred: (r: any) => boolean) => provider(p).registrations.find(pred);

beforeAll(() => {
  mkdirSync(join(root, ".zor"), { recursive: true });
  for (const [name, text] of Object.entries(generated)) writeFileSync(join(root, ".zor", name), text);
  const args = ["services/data.ts", "services/hidden.ts", "services/dispose.ts", "services/keys.ts", "main.ts", "--", ".zor/App.tszor.ts", ".zor/Counter.tszor.ts"];
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
  expect([db.file, db.at]).toEqual([".zor/Counter.tszor.ts", generated["Counter.tszor.ts"]!.indexOf("db: IDatabase,")]);
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
  expect(app.mount.component.module).toBe("App.tszor");
  expect(app.mount.component.export).toBe("default");
  expect(app.mount.target).toBe("app");
  expect(app.mount.component.id).toBe(facts.components.find((c: any) => c.class.text === "App").class.id);
  expect(app.imports[0].text).toBe("DataServices");
  expect(app.imports[0].id).toBe("services/data.ts#DataServices");
  expect(provider("DataServices").mount).toBeNull();
});

test("reads component injects", () => {
  const counter = facts.components.find((c: any) => c.class.text === "Counter");
  expect(counter.class.module).toBe("Counter.tszor");
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

// Temp project copies; `paths: false` leaves @zor/runtime unresolvable.
const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
function analyzeTemp(files: Record<string, string>, paths = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "zor-di-")));
  temps.push(dir);
  const runtime = join(import.meta.dir, "..", "runtime", "index.ts").replaceAll("\\", "/");
  const compilerOptions: any = { target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM"], strict: true, noEmit: true, skipLibCheck: true };
  if (paths) compilerOptions.paths = { "@zor/runtime": [runtime] };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["**/*.ts"] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const run = Bun.spawnSync(["bun", script, dir, ...Object.keys(files)]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

test("unresolvable runtime is an error", () => {
  const main = `import { ServiceProvider } from "@zor/runtime";\n\n@ServiceProvider()\nexport class P {}\n`;
  const out = analyzeTemp({ "main.ts": main }, false);
  expect(out.providers).toEqual([]);
  expect(out.errors).toEqual([{ file: "main.ts", at: main.indexOf("@ServiceProvider"), message: "cannot resolve @zor/runtime" }]);
});

test("non-importable types are errors, primitives and lib types are not", () => {
  const main = `import { ServiceProvider, Singleton } from "@zor/runtime";
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

test("decorator misuse", () => {
  const main = `import { Mount, ServiceProvider } from "@zor/runtime";
export class App {}

@Mount(App, "a")
@Mount(App, "b")
@ServiceProvider
export class P {}
`;
  const out = analyzeTemp({ "main.ts": main });
  expect(out.errors).toEqual([
    { file: "main.ts", at: main.indexOf("@ServiceProvider"), message: "@ServiceProvider must be called" },
    { file: "main.ts", at: main.indexOf('@Mount(App, "b")'), message: "duplicate @Mount" },
  ]);
  expect(out.providers[0].mount.target).toBe("a");
});

test("non-public factories are errors", () => {
  const main = `import { ServiceProvider, Singleton } from "@zor/runtime";
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

test("generic service types are errors", () => {
  const main = `import { ServiceProvider, Singleton } from "@zor/runtime";
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
  const main = `import { ServiceProvider, Singleton } from "@zor/runtime";
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
