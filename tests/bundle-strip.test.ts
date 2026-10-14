import { expect, test } from "bun:test";
import { join } from "node:path";
import { inProject, stripMarkerDecorators } from "../src/bundle";

const IMPORT = `import { Import, Mount, Scoped, ServiceProvider, Singleton, Transient } from "@xzor/runtime";\n`;

function expectBlanked(src: string, out: string): void {
  expect(out.length).toBe(src.length);
  expect([...out.matchAll(/\n/g)].map((m) => m.index)).toEqual([...src.matchAll(/\n/g)].map((m) => m.index));
}

test("blanks marker decorators and keeps imports, exports, length and line breaks", () => {
  const src = `${IMPORT}\n@ServiceProvider()\n@Singleton<ILogger>(ConsoleLogger)\n  @Scoped(UnitOfWork)\nexport class DataServices {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out).toBe(`${IMPORT}\n${" ".repeat(18)}\n${" ".repeat(34)}\n${" ".repeat(21)}\nexport class DataServices {}\n`);
});

test("multi-line arguments", () => {
  const src = `${IMPORT}@Mount(\n  App,\n  "app",\n)\n@Singleton(\n  "settings",\n  Factories.load,\n)\nexport class Application {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out.slice(IMPORT.length).trim()).toBe("export class Application {}");
});

test("generics with nested angle brackets and arrows", () => {
  const src = `${IMPORT}@Singleton<Map<string, Array<() => Promise<X>>>>(Impl)\nexport class P {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out.slice(IMPORT.length).trim()).toBe("export class P {}");
});

test("strings, templates and comments containing parentheses", () => {
  const src = `${IMPORT}@Singleton("a)b", () => \`)\${f(")")})\` /* ) */)\n@Transient(Clock) // )\nexport class P {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out.slice(IMPORT.length).trim()).toBe("// )\nexport class P {}");
});

test("aliased imports are stripped by their local name only", () => {
  const src = `import { Singleton as Single } from "@xzor/runtime";\n@Single(A)\n@Singleton(B)\nexport class P {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out).toContain("@Singleton(B)");
  expect(out).not.toContain("@Single(A)");
});

test("other decorators stay, including ones on the same line", () => {
  const src = `${IMPORT}import { sealed } from "./sealed";\n@sealed() @Singleton(A) @deco.member(1)\nexport class P {}\n`;
  const out = stripMarkerDecorators(src);
  expectBlanked(src, out);
  expect(out).toContain("@sealed() ");
  expect(out).toContain("@deco.member(1)");
  expect(out).not.toContain("@Singleton");
});

test("files without a value import from @xzor/runtime are unchanged", () => {
  const typeOnly = `import type { Singleton } from "@xzor/runtime";\n@Singleton(A)\nclass P {}\n`;
  expect(stripMarkerDecorators(typeOnly)).toBe(typeOnly);
  const other = `import { Singleton } from "./mine";\n@Singleton(A)\nclass P {}\n`;
  expect(stripMarkerDecorators(other)).toBe(other);
});

test("an @ inside a string or mid-expression is not a decorator", () => {
  const src = `${IMPORT}const s = "@Singleton(A)";\nconst t = x @Singleton(B);\n`;
  expect(stripMarkerDecorators(src)).toBe(src);
});

test("only files under the project root are stripped", () => {
  const root = join(import.meta.dir, "app");
  expect(inProject(join(root, "main.ts"), root)).toBe(true);
  expect(inProject(join(root, "services", "data.ts"), root)).toBe(true);
  expect(inProject(join(root, "..foo.ts"), root)).toBe(true);
  expect(inProject(root, root)).toBe(false);
  expect(inProject(join(import.meta.dir, "lib", "x.ts"), root)).toBe(false);
  expect(inProject(join(import.meta.dir, "app2", "x.ts"), root)).toBe(false);
});
