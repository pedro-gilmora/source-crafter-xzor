import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeMappings, trackModelFields } from "../src/bundle";

const repo = join(import.meta.dir, "..");
// Same depth below the repo as examples/counter, so module resolution matches a real project.
const dir = join(repo, "target", `tmp-model-${process.pid}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const IMPORT = `import { Ignore, Model, Persist, Untracked } from "@source-crafter/xzor-runtime/model";\n`;

const WORKER = `${IMPORT}
export class Worker extends Model {
  name: string = "";
  @Ignore hours: number = 0;

  @Persist get payment(): number {
    return this.hours * 10;
  }
}
`;

const WORKER_OUT = `${IMPORT}
export class Worker extends Model { constructor(data?: object) { super(data); if (new.target === Worker) this.assign(data); }
  #name: string = ""; get name(): string { Model.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(0, p); }
          #hours: number = 0; @Ignore get hours(): number { Model.$reader?.(this, 1); return this.#hours; } set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(1, p); }

  @Persist get payment(): number {
    return this.hours * 10;
  }
static { Model.\$define(this, ["name", "hours"]); } }
`;

test("every field of a model class becomes a private slot with a getter and a setter", () => {
  const out = trackModelFields(WORKER);
  expect(out).toBe(WORKER_OUT);
  expect(out.split("\n")).toHaveLength(WORKER.split("\n").length);
});

const SHAPES = `${IMPORT}
export class Odd extends Model {
  get = 1;
  static = 2;
  note?: string;
  id!: number;
  config = {
    a: 1,
  };
  calc = (x: number) => x * 2;
  private hidden = "";
  @Untracked plain = 0;
  static total = 0;
  readonly fixed = 1;
  declare injected: string;
  accessor auto = 0;
  #secret = 1;
  [key: string]: unknown;
  generic<T = string>(v: T): T { return v; }
  method(): number { return this.get; }
  get computed(): number { return this.id; }
}
`;

test("keyword-ish names, multi-line and arrow initializers, optional and definite fields", () => {
  const out = trackModelFields(SHAPES);
  expect(out.split("\n")).toHaveLength(SHAPES.split("\n").length);
  expect(out).toContain(`  #get = 1; get get() { Model.$reader?.(this, 0); return this.#get; } set get(v) { const p = this.#get; if (Model.same(p, v)) return; this.#get = v; this.$changed(0, p); }\n`);
  expect(out).toContain(`  #static = 2; get static() { Model.$reader?.(this, 1); return this.#static; } set static(v) { const p = this.#static; if (Model.same(p, v)) return; this.#static = v; this.$changed(1, p); }\n`);
  expect(out).toContain(`  #note: string | undefined; get note(): string | undefined { Model.$reader?.(this, 2); return this.#note; } set note(v: string | undefined) { const p = this.#note; if (Model.same(p, v)) return; this.#note = v; this.$changed(2, p); }\n`);
  expect(out).toContain(`  #id!: number; get id(): number { Model.$reader?.(this, 3); return this.#id; } set id(v: number) { const p = this.#id; if (Model.same(p, v)) return; this.#id = v; this.$changed(3, p); }\n`);
  expect(out).toContain(`  #config = {\n    a: 1,\n  }; get config() { Model.$reader?.(this, 4); return this.#config; } set config(v) { const p = this.#config; if (Model.same(p, v)) return; this.#config = v; this.$changed(4, p); }\n`);
  expect(out).toContain(`  #calc = (x: number) => x * 2; get calc() { Model.$reader?.(this, 5); return this.#calc; } set calc(v) { const p = this.#calc; if (Model.same(p, v)) return; this.#calc = v; this.$changed(5, p); }\n`);
  // The access modifier moves to the accessors: TypeScript forbids one on a `#private` field.
  expect(out).toContain(`          #hidden = ""; private get hidden() { Model.$reader?.(this, 6); return this.#hidden; } private set hidden(v) { const p = this.#hidden; if (Model.same(p, v)) return; this.#hidden = v; this.$changed(6, p); }\n`);
  expect(out).toContain(`static { Model.$define(this, ["get", "static", "note", "id", "config", "calc", "hidden"]); } }\n`);
});

test("untracked, static, readonly, declare, accessor, private and function members are left alone", () => {
  const out = trackModelFields(SHAPES);
  for (const member of [
    "  @Untracked plain = 0;\n",
    "  static total = 0;\n",
    "  readonly fixed = 1;\n",
    "  declare injected: string;\n",
    "  accessor auto = 0;\n",
    "  #secret = 1;\n",
    "  [key: string]: unknown;\n",
    "  generic<T = string>(v: T): T { return v; }\n",
    "  method(): number { return this.get; }\n",
    "  get computed(): number { return this.id; }\n",
  ])
    expect(out).toContain(member);
});

const ASI = `${IMPORT}
export class Project extends Model {
  id: number;
  name: string
  kind:
    | "a"
    | "b"
  children?: Project[]
  @Ignore
  clientId: string
  greet(): string {
    return this.name;
  }
}
`;

test("fields without a semicolon end where the next member starts", () => {
  const out = trackModelFields(ASI);
  expect(out.split("\n")).toHaveLength(ASI.split("\n").length);
  expect(out).toContain(`  #id: number; get id(): number { Model.$reader?.(this, 0); return this.#id; } set id(v: number) { const p = this.#id; if (Model.same(p, v)) return; this.#id = v; this.$changed(0, p); }\n`);
  expect(out).toContain(`  #name: string; get name(): string { Model.$reader?.(this, 1); return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(1, p); }\n`);
  expect(out).toContain(`  #kind:\n    | "a"\n    | "b"; get kind(): | "a" | "b" { Model.$reader?.(this, 2); return this.#kind; } set kind(v: | "a" | "b") { const p = this.#kind; if (Model.same(p, v)) return; this.#kind = v; this.$changed(2, p); }\n`);
  expect(out).toContain(`  #children: Project[] | undefined; get children(): Project[] | undefined { Model.$reader?.(this, 3); return this.#children; }`);
  expect(out).toContain(`\n         \n  #clientId: string; @Ignore get clientId(): string { Model.$reader?.(this, 4); return this.#clientId; }`);
  expect(out).toContain(`  greet(): string {\n    return this.name;\n  }\n`);
  expect(out).toContain(`static { Model.$define(this, ["id", "name", "kind", "children", "clientId"]); } }`);
});

test("a bare field without a type or semicolon ends at its own line", () => {
  const src = `${IMPORT}export class Bare extends Model {\n  id\n  name: string = ""\n}\n`;
  const out = trackModelFields(src);
  expect(out.split("\n")).toHaveLength(src.split("\n").length);
  expect(out).toContain(`  #id; get id() { Model.$reader?.(this, 0); return this.#id; }`);
  expect(out).toContain(`  #name: string = ""; get name(): string { Model.$reader?.(this, 1); return this.#name; }`);
  expect(out).toContain(`Model.$define(this, ["id", "name"])`);
});

const DERIVED = `${IMPORT}
export class Worker extends Model {
  name = "";
  hours = 0;
  rate = 1;
}

export class Manager extends Worker {
  team = 0;
  bonus = 0;
}
`;

test("a class extending a model of the same file continues its base's field indexes", () => {
  const out = trackModelFields(DERIVED, "src/models.ts");
  expect(out.split("\n")).toHaveLength(DERIVED.split("\n").length);
  // A direct subclass of Model always starts at 0, so its indexes stay literal.
  expect(out).toContain(`static { Model.$define(this, ["name", "hours", "rate"]); } }`);
  expect(out).toContain(`export class Manager extends Worker { constructor(data?: object) { super(data); if (new.target === Manager) this.assign(data); }`);
  expect(out).toContain(`  #team = 0; get team() { Worker.$reader?.(this, Manager.#at + 0); return this.#team; } set team(v) { const p = this.#team; if (Worker.same(p, v)) return; this.#team = v; this.$changed(Manager.#at + 0, p); }\n`);
  expect(out).toContain(`  #bonus = 0; get bonus() { Worker.$reader?.(this, Manager.#at + 1); return this.#bonus; }`);
  expect(out).toContain(`static #at = 0; static { this.#at = Worker.$define(this, ["team", "bonus"]); } }\n`);
});

test("a base declared after its subclass is still followed", () => {
  const src = `${IMPORT}export class Manager extends Worker {\n  team = 0;\n}\nexport class Worker extends Model {\n  name = "";\n}\n`;
  const out = trackModelFields(src, "src/models.ts");
  expect(out).toContain(`static { this.#at = Worker.$define(this, ["team"]); } }`);
  expect(out).toContain(`static { Model.$define(this, ["name"]); } }`);
});

test("a base in a relative module is read through the resolver", () => {
  const files: Record<string, string> = {
    "./worker": `${IMPORT}export default class Worker extends Model {\n  name = "";\n}\n`,
    "./team": `export { Lead } from "./lead";\n`,
    "./lead": `import Worker from "./worker";\nexport class Lead extends Worker {}\n`,
  };
  const seen: string[] = [];
  const resolve = (spec: string, from: string): string | undefined => {
    seen.push(`${from}:${spec}`);
    return files[spec];
  };
  const src = `import Worker from "./worker";\nimport { Lead } from "./team";\nexport class Manager extends Worker {\n  team = 0;\n}\nexport class Senior extends Lead {\n  level = 0;\n}\n`;
  const out = trackModelFields(src, "src/manager.ts", resolve);
  expect(out).toContain(`static { this.#at = Worker.$define(this, ["team"]); } }`);
  expect(out).toContain(`static { this.#at = Lead.$define(this, ["level"]); } }`);
  expect(seen.filter((s) => s.endsWith("./worker"))).toHaveLength(1); // read once, cached per resolved path
});

test("a cycle between relative modules ends the search", () => {
  const files: Record<string, string> = { "./b": `import { A } from "./a";\nexport class B extends A {}\n`, "./a": `import { B } from "./b";\nexport class A extends B {}\n` };
  const src = `import { A } from "./a";\nimport { Model } from "@source-crafter/xzor-runtime/model";\nexport class C extends A {\n  x = 1;\n}\n`;
  expect(trackModelFields(src, "src/c.ts", (spec) => files[spec])).toBe(src);
});

test("a base shared by many files is read and parsed once when the cache is shared", () => {
  let reads = 0;
  const resolve = (): string | undefined => (reads++, `${IMPORT}export default class Worker extends Model {\n  name = "";\n}\n`);
  const cache = new Map();
  for (const file of ["a", "b"]) {
    const src = `import Worker from "./worker";\nexport class ${file.toUpperCase()} extends Worker {\n  x = 1;\n}\n`;
    expect(trackModelFields(src, `src/${file}.ts`, resolve, cache)).toContain(`this.#at = Worker.$define(this, ["x"])`);
  }
  expect(reads).toBe(1);
});

test("a file that does not extend a model gets no warning and comes back identical", () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  try {
    let reads = 0;
    const resolve = (): string | undefined => (reads++, undefined);
    const panel = `import { helper } from "./helper";\nimport { Component } from "preact";\nclass Panel extends Component {\n  x = helper;\n}\n`;
    expect(trackModelFields(panel, "src/panel.ts", resolve)).toBe(panel);
    const plain = `import { x } from "./x";\nclass A extends Object {\n  y = x;\n}\n`;
    expect(trackModelFields(plain, "src/a.ts", resolve)).toBe(plain);
    expect(reads).toBe(0);
    const thing = `import { Component } from "preact";\nexport class Thing extends Component {}\n`;
    const chained = `import { Thing } from "./thing";\nclass P extends Thing {\n  x = 1;\n}\n`;
    expect(trackModelFields(chained, "src/p.ts", () => thing)).toBe(chained);
    expect(errors).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("a class extending a namespace member warns instead of being skipped silently", () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  try {
    const src = `${IMPORT}import * as ns from "./models";\nexport class X extends ns.Worker {\n  y = 1;\n}\n`;
    expect(trackModelFields(src, "src/x.ts", () => WORKER)).toBe(src);
    expect(errors).toEqual([`xzor: src/x.ts:3: X is not tracked: its base ns comes from "./models" and could not be followed`]);
  } finally {
    spy.mockRestore();
  }
});

test("a model class that is not rewritten says so on stderr", () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  try {
    const unreadable = `import { Worker } from "./worker";\nexport class Manager extends Worker {\n  team = 0;\n}\n`;
    expect(trackModelFields(unreadable, "src/manager.ts", () => undefined)).toBe(unreadable);
    expect(errors).toEqual([`xzor: src/manager.ts:2: Manager is not tracked: its base Worker comes from "./worker" and could not be followed`]);

    errors.length = 0;
    const packaged = `${IMPORT}import { Base } from "@acme/models";\nexport class Manager extends Base {\n  team = 0;\n}\n`;
    expect(trackModelFields(packaged, "src/manager.ts")).toBe(packaged);
    expect(errors).toEqual([`xzor: src/manager.ts:3: Manager is not tracked: its base Base comes from "@acme/models" and could not be followed`]);

    errors.length = 0;
    const anon = `${IMPORT}export class Worker extends Model {\n  x = 1;\n}\nexport default class extends Worker {\n  y = 2;\n}\n`;
    const out = trackModelFields(anon, "src/models.ts");
    expect(out).toContain("  y = 2;");
    expect(errors).toEqual(["xzor: src/models.ts:5: an anonymous class is not tracked: name it, so its fields can follow Worker's"]);

    errors.length = 0;
    const unclosed = `${IMPORT}export class Bad extends Model {\n  x = 1;\n`;
    expect(trackModelFields(unclosed, "src/bad.ts")).toBe(unclosed);
    expect(errors).toEqual(["xzor: src/bad.ts:2: Bad is not tracked: its body is not closed"]);

    errors.length = 0;
    trackModelFields(`${IMPORT}export default class extends Model {\n  x = 1;\n}\n`, "src/anon.ts");
    expect(errors).toEqual(["xzor: src/anon.ts:2: an anonymous class gets no constructor: name the class or call this.assign(data) in its constructor"]);
  } finally {
    spy.mockRestore();
  }
});

test("a class extending another Model, or a file with no model class, is untouched", () => {
  const other = `${IMPORT}class Other {}\nexport class A extends Other {\n  x = 1;\n}\n`;
  expect(trackModelFields(other)).toBe(other);
  const noExtends = `${IMPORT}export class G {\n  x = 1;\n}\n`;
  expect(trackModelFields(noExtends)).toBe(noExtends);
  const plain = `export class B {\n  x = 1;\n}\n`;
  expect(trackModelFields(plain)).toBe(plain);
  const elsewhere = `import { Model } from "./model";\nexport class C extends Model {\n  x = 1;\n}\n`;
  expect(trackModelFields(elsewhere)).toBe(elsewhere);
  const typeOnly = `import type { Model } from "@source-crafter/xzor-runtime/model";\nexport class D extends (Model as never) {\n  x = 1;\n}\n`;
  expect(trackModelFields(typeOnly)).toBe(typeOnly);
});

test("an aliased import names the base in the generated code", () => {
  const src = `import { Model as Base } from "@source-crafter/xzor-runtime/model";\nexport class E extends Base {\n  x = 1;\n}\n`;
  const out = trackModelFields(src);
  expect(out).toContain(`if (Base.same(p, v)) return;`);
  expect(out).toContain(`static { Base.$define(this, ["x"]); } }`);
  expect(out).toContain(`if (new.target === E) this.assign(data); }`);
});

test("a class with its own constructor keeps it, and an anonymous one gets none", () => {
  const own = `${IMPORT}export class F extends Model {\n  constructor(name: string) {\n    super({ name });\n  }\n  x = 1;\n}\n`;
  const out = trackModelFields(own);
  expect(out).not.toContain("constructor(data?: object)");
  expect(out).toContain(`static { Model.$define(this, ["x"]); } }`);
  const anon = `${IMPORT}export default class extends Model {\n  x = 1;\n}\n`;
  const outAnon = trackModelFields(anon);
  expect(outAnon).not.toContain("constructor(");
  expect(outAnon).toContain(`#x = 1; get x() { Model.$reader?.(this, 0); return this.#x; }`);
});

test("a decorator on its own line moves to the getter without moving a line", () => {
  const src = `${IMPORT}export class G extends Model implements Record<string, unknown> {\n  [key: string]: unknown;\n  @Ignore\n  hours: number = 0;\n  static { console.log("ready"); }\n}\n`;
  const out = trackModelFields(src);
  expect(out.split("\n")).toHaveLength(src.split("\n").length);
  expect(out).toContain(`\n         \n  #hours: number = 0; @Ignore get hours(): number { Model.$reader?.(this, 0); return this.#hours; }`);
  expect(out).toContain(`  static { console.log("ready"); }\n`);
  expect(out).toContain(`static { Model.$define(this, ["hours"]); } }`);
});

// A real project, bundled by src/bundle.ts and run.
const MAIN = `import { Model, State, Validate, required } from "@source-crafter/xzor-runtime/model";

export class Worker extends Model {
  name = "";
  hours = 0;
  rate: number = 1
}

export class Contact extends Model {
  @Validate(required) name = "";
}

export { State };
export { Lead } from "./lead";
`;

const STAFF = `import { Model } from "@source-crafter/xzor-runtime/model";

export class Staff extends Model {
  name = "";
  hours = 0;
  rate = 1;
}
`;

const LEAD = `import { Ignore } from "@source-crafter/xzor-runtime/model";
import { Staff } from "./staff";

export class Lead extends Staff {
  team = 0;
  @Ignore bonus = 0;
}
`;

function project(): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const paths = {
    "@source-crafter/xzor-runtime/model": [join(repo, "runtime", "model.ts").replaceAll("\\", "/")],
  };
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        paths,
      },
      include: ["**/*.ts"],
      exclude: ["dist"],
    }),
  );
  writeFileSync(join(dir, "main.ts"), MAIN);
  writeFileSync(join(dir, "staff.ts"), STAFF);
  writeFileSync(join(dir, "lead.ts"), LEAD);
}

test("a bundled model tracks its changes, and the map still points at the original source", async () => {
  project();
  const run = Bun.spawnSync(["bun", join(repo, "src", "bundle.ts"), join(dir, "main.ts"), join(dir, "dist")], { cwd: repo });
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  const { Worker, State } = await import(pathToFileURL(join(dir, "dist", "main.js")).href);
  const worker = new Worker({ name: "Ada", hours: 2 });
  expect(worker.name).toBe("Ada");
  expect(worker.rate).toBe(1);
  expect(worker.hasState(State.Unchanged)).toBe(true);
  expect(worker.hasChanges).toBe(false);

  worker.hours = 3;
  expect(worker.hasState(State.Modified)).toBe(true);
  expect(worker.changes).toMatchObject({ hours: 3 });

  worker.revertChanges();
  expect(worker.hours).toBe(2);
  expect(worker.hasState(State.Unchanged)).toBe(true);

  const { Contact } = await import(pathToFileURL(join(dir, "dist", "main.js")).href);
  const contact = new Contact({ name: "Ada" });
  expect(contact.hasErrors).toBe(false);
  contact.name = " ";
  expect(contact.hasErrors).toBe(true);
  expect(contact.errors).toEqual({ name: ["Field is required"] });

  const map = JSON.parse(readFileSync(join(dir, "dist", "main.js.map"), "utf8"));
  const source = map.sources.findIndex((s: string) => s.endsWith("main.ts"));
  expect(map.sourcesContent[source]).toBe(MAIN);
  const line = MAIN.split("\n").indexOf("  hours = 0;");
  const mapped = decodeMappings(map.mappings).flat();
  expect(mapped.some((seg) => seg.length >= 4 && seg[1] === source && seg[2] === line)).toBe(true);
}, 120_000);

test("a model deriving from one in another file tracks both levels", async () => {
  project();
  const run = Bun.spawnSync(["bun", join(repo, "src", "bundle.ts"), join(dir, "main.ts"), join(dir, "dist")], { cwd: repo });
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  const { Lead, State } = await import(pathToFileURL(join(dir, "dist", "main.js")).href);
  const lead = new Lead({ name: "Ada", hours: 2, team: 3 });
  expect([lead.name, lead.hours, lead.rate, lead.team, lead.bonus]).toEqual(["Ada", 2, 1, 3, 0]);
  expect(lead.hasState(State.Unchanged)).toBe(true);
  expect(lead.hasChanges).toBe(false);

  const seen: string[] = [];
  lead.addEventListener("change", (e: { property: string }) => void seen.push(e.property));
  lead.team = 4;
  lead.hours = 5;
  expect(seen).toEqual(["team", "hours"]);
  expect(lead.changes).toMatchObject({ team: 4, hours: 5 });
  expect(lead.toJSON()).not.toHaveProperty("bonus");

  lead.revertChanges();
  expect([lead.hours, lead.team]).toEqual([2, 3]);
  expect(lead.hasState(State.Unchanged)).toBe(true);
}, 120_000);

test("a derived model's private offset never collides with a field or a private of that name", async () => {
  project();
  const src = `${IMPORT}export class Base extends Model {\n  id = 1;\n}\nexport class Entry extends Base {\n  at = 5;\n  #at$ = 3;\n  get hidden() { return this.#at$; }\n}\nexport class Other extends Base {\n  #at = 7;\n  n = 1;\n  get hidden() { return this.#at; }\n}\n`;
  writeFileSync(join(dir, "entry.ts"), src);
  const run = Bun.spawnSync(["bun", join(repo, "src", "bundle.ts"), join(dir, "entry.ts"), join(dir, "dist")], { cwd: repo });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const { Entry, Other } = await import(pathToFileURL(join(dir, "dist", "entry.js")).href);
  const entry = new Entry({ id: 2, at: 9 });
  expect([entry.id, entry.at, entry.hidden]).toEqual([2, 9, 3]);
  const seen: string[] = [];
  entry.addEventListener("change", (e: { property: string }) => void seen.push(e.property));
  entry.at = 4;
  entry.id = 6;
  expect(seen).toEqual(["at", "id"]);
  const other = new Other({ id: 1, n: 8 });
  expect([other.n, other.hidden]).toEqual([8, 7]);
}, 120_000);

test("a base the bundle does not rewrite is reported, not followed", () => {
  project();
  writeFileSync(join(dir, "base.tsx"), `${IMPORT}export class Base extends Model {\n  id = 1;\n}\n`);
  writeFileSync(join(dir, "derived.ts"), `import { Base } from "./base";\nexport class Derived extends Base {\n  x = 2;\n}\nconsole.log(new Derived().x);\n`);
  const run = Bun.spawnSync(["bun", join(repo, "src", "bundle.ts"), join(dir, "derived.ts"), join(dir, "dist")], { cwd: repo });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(run.stderr.toString()).toContain(`derived.ts:2: Derived is not tracked: its base Base comes from "./base" and could not be followed`);
}, 120_000);

test("the original source type-checks against the runtime", () => {
  project();
  const run = Bun.spawnSync(["bun", "x", "tsc", "--noEmit", "--pretty", "false", "-p", dir], { cwd: repo });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
}, 120_000);
