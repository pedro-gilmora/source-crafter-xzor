import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
  const args = ["services/data.ts", "services/hidden.ts", "main.ts", "--", ".zor/App.tszor.ts", ".zor/Counter.tszor.ts"];
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
});

test("unexported type", () => {
  expect(facts.errors).toHaveLength(1);
  expect(facts.errors[0].message).toBe("Hidden must be exported to be injected");
  expect(facts.errors[0].file).toBe("services/hidden.ts");
});
