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

test("a model class that is not rewritten says so on stderr", () => {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  try {
    const indirect = `${IMPORT}export class Base extends Model {\n  x = 1;\n}\nexport class Child extends Base {\n  y = 2;\n}\n`;
    const out = trackModelFields(indirect, "src/models.ts");
    expect(out).toContain(`static { Model.$define(this, ["x"]); } }`);
    expect(out).toContain("  y = 2;");
    expect(errors).toEqual(["xzor: src/models.ts:5: Child is not tracked: it extends Base; only direct subclasses of Model are tracked"]);

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
}

test("a bundled model tracks its changes, and the map still points at the original source", async () => {
  project();
  const run = Bun.spawnSync(["bun", join(repo, "src", "bundle.ts"), join(dir, "main.ts"), join(dir, "dist")], { cwd: repo });
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  const { Worker, State } = await import(pathToFileURL(join(dir, "dist", "main.js")).href);
  const worker = new Worker({ name: "Ada", hours: 2 });
  expect(worker.name).toBe("Ada");
  expect(worker.rate).toBe(1);
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);

  worker.hours = 3;
  expect(worker.state).toBe(State.Modified);
  expect(worker.changes).toMatchObject({ hours: 3 });

  worker.revertChanges();
  expect(worker.hours).toBe(2);
  expect(worker.state).toBe(State.Unchanged);

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

test("the original source type-checks against the runtime", () => {
  project();
  const run = Bun.spawnSync(["bun", "x", "tsc", "--noEmit", "--pretty", "false", "-p", dir], { cwd: repo });
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
}, 120_000);
