// Bundles a xzor app with Bun. `./X.xzor` imports resolve to the generated `<project>/.xzor/<rel>/X.xzor.ts`,
// and the bundle's source map is composed with each generated file's map so it points at the `.xzor` sources.
// Usage: bun bundle.ts <entry|-> <outdir> [--hot] [--watch] [--minify] [--pages <file>] [--server <file>]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

type Segment = number[];
type SourceMap = { version: number; sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Absolute segments per generated line: [col] or [col, source, line, col]. */
export function decodeMappings(mappings: string): Segment[][] {
  const state = [0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    state[0] = 0;
    return line
      .split(",")
      .filter(Boolean)
      .map((seg) => {
        const values: number[] = [];
        let value = 0;
        let shift = 0;
        for (const ch of seg) {
          const digit = BASE64.indexOf(ch);
          value |= (digit & 31) << shift;
          shift += 5;
          if ((digit & 32) === 0) {
            values.push(value & 1 ? -(value >> 1) : value >> 1);
            value = shift = 0;
          }
        }
        return values.slice(0, 4).map((v, i) => (state[i]! += v));
      });
  });
}

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += BASE64[digit];
  } while (v > 0);
  return out;
}

export function encodeMappings(lines: Segment[][]): string {
  const state = [0, 0, 0, 0];
  return lines
    .map((line) => {
      state[0] = 0;
      return line
        .map((seg) =>
          seg
            .slice(0, 4)
            .map((v, i) => {
              const delta = v - state[i]!;
              state[i] = v;
              return vlq(delta);
            })
            .join(""),
        )
        .join(",");
    })
    .join(";");
}

/** Lookup in a decoded map: the segment covering (line, col), shifted by the distance into it. */
function lookup(lines: Segment[][], line: number, col: number): Segment | undefined {
  const seg = [...(lines[line] ?? [])].reverse().find((s) => s[0]! <= col);
  if (!seg || seg.length < 4) return undefined;
  return [seg[0]!, seg[1]!, seg[2]!, seg[3]! + (col - seg[0]!)];
}

/**
 * Replaces segments that point into generated files with the positions their own maps give.
 * `inner(source)` returns a generated file's map and the directory its `sources` are relative to
 * (relative to the outer map's directory).
 */
export function composeMaps(outer: SourceMap, inner: (source: string) => { map: SourceMap; dir: string } | undefined): SourceMap {
  const sources: string[] = [];
  const contents: (string | null)[] = [];
  const indexOf = (source: string, content: string | null) => {
    let i = sources.indexOf(source);
    if (i < 0) {
      i = sources.push(source) - 1;
      contents.push(content);
    }
    return i;
  };
  const inners = outer.sources.map((s) => {
    const found = inner(s);
    return found && { ...found, lines: decodeMappings(found.map.mappings) };
  });
  const lines = decodeMappings(outer.mappings).map((line) =>
    line.flatMap((seg): Segment[] => {
      if (seg.length < 4) return [seg];
      const via = inners[seg[1]!];
      if (!via) return [[seg[0]!, indexOf(outer.sources[seg[1]!]!, outer.sourcesContent?.[seg[1]!] ?? null), seg[2]!, seg[3]!]];
      const hit = lookup(via.lines, seg[2]!, seg[3]!);
      if (!hit) return [[seg[0]!]];
      const name = posix.normalize(`${via.dir}/${via.map.sources[hit[1]!]}`);
      return [[seg[0]!, indexOf(name, via.map.sourcesContent?.[hit[1]!] ?? null), hit[2]!, hit[3]!]];
    }),
  );
  return { version: 3, sources, sourcesContent: contents, names: [], mappings: encodeMappings(lines) };
}

function projectRoot(dir: string): string {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "tsconfig.json"))) return d;
    if (dirname(d) === d) return dir;
  }
}

/** Whether `path` is inside the directory `root`. */
export function inProject(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel);
}

/** Whether the bundle rewrites `path`'s models: a project `.ts` file outside `.xzor/` and `node_modules/`. */
function rewritable(path: string, root: string): boolean {
  const p = path.replaceAll("\\", "/");
  return p.endsWith(".ts") && inProject(path, root) && !p.includes("/node_modules/") && !p.includes("/.xzor/");
}

/** Files whose model and component fields become tracked: project sources, and generated components (the app's or a kit's). */
export function tracksFields(path: string, root: string, _text?: string): boolean {
  if (rewritable(path, root)) return true;
  const p = path.replaceAll("\\", "/");
  return p.includes("/.xzor/") && p.endsWith(".xzor.ts") && !p.includes("/node_modules/");
}

function generatedPath(source: string): string {
  if (existsSync(`${source}.ts`)) return `${source}.ts`;
  const root = projectRoot(dirname(source));
  return join(root, ".xzor", `${relative(root, source)}.ts`);
}

/** `rootDirs: [".", ".xzor"]`: the importer's directory in the other root (sources <-> `.xzor/`). */
export function mirroredDir(dir: string, root: string): string {
  const xzor = join(root, ".xzor");
  return inProject(dir, xzor) || dir === xzor ? join(root, relative(xzor, dir)) : join(xzor, relative(root, dir));
}

function tryResolve(spec: string, dir: string): string | undefined {
  try {
    return Bun.resolveSync(spec, dir);
  } catch {
    return undefined;
  }
}

const DOM_IMPORT = /\bimport\s*\{([^}]*?)\bdom as __dom\b,?([^}]*)\}\s*from\s*"@source-crafter\/xzor-runtime";/;
const bindingsByDir = new Map<string, string | undefined>();

/**
 * Generated code's `dom` import, taken from the runtime's `bindings` module itself (beside the runtime's entry) on
 * the same line: Bun keeps every member of a namespace re-exported through `index`, and only the called ones of this.
 */
export function importBindings(text: string, file: string): string {
  const dir = dirname(file);
  if (!bindingsByDir.has(dir)) {
    const index = tryResolve("@source-crafter/xzor-runtime", dir);
    const found = index && [".ts", ".js"].map((ext) => join(dirname(index), `bindings${ext}`)).find(existsSync);
    bindingsByDir.set(dir, found);
  }
  const bindings = bindingsByDir.get(dir);
  return bindings ? text.replace(DOM_IMPORT, (_, a: string, b: string) => `import {${a}${b}} from "@source-crafter/xzor-runtime"; import * as __dom from ${JSON.stringify(bindings.replaceAll("\\", "/"))};`) : text;
}

// xzor's DI decorators are no-ops read only by the analyzer; stripping them spares the bundle the decorator helpers.
const MARKERS = new Set(["ServiceProvider", "Run", "Import", "Singleton", "Scoped", "Transient", "Endpoints", "Get", "Post", "Put", "Patch", "Delete", "Query"]);
const RUNTIME_IMPORT = /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@source-crafter\/xzor-runtime(?:\/server)?["']/g;
const IDENT = /[A-Za-z_$][\w$]*/y;

/** Local names bound to xzor's marker decorators by value imports from `@source-crafter/xzor-runtime`. */
function markerLocals(src: string): Set<string> {
  const locals = new Set<string>();
  for (const m of src.matchAll(RUNTIME_IMPORT)) {
    if (m[1]) continue;
    for (const spec of m[2]!.split(",")) {
      const [name, as, alias] = spec.trim().split(/\s+/);
      if (name && MARKERS.has(name)) locals.add(as === "as" && alias ? alias : name);
    }
  }
  return locals;
}

/** The end of the string, template or comment starting at `i`, or -1. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === c || src[j] === "\n") return j + 1;
    }
    return src.length;
  }
  if (c === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (src[j] === "`") return j + 1;
      else if (src[j] === "$" && src[j + 1] === "{") {
        const end = skipBalanced(src, j + 1, "{", "}");
        if (end < 0) return src.length;
        j = end - 1;
      }
    }
    return src.length;
  }
  if (c === "/" && src[i + 1] === "/") {
    const j = src.indexOf("\n", i);
    return j < 0 ? src.length : j;
  }
  if (c === "/" && src[i + 1] === "*") {
    const j = src.indexOf("*/", i + 2);
    return j < 0 ? src.length : j + 2;
  }
  return -1;
}

/** `src[i]` is `open`; the index after its matching `close`, or -1. An `=>` arrow does not close `<`. */
function skipBalanced(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  while (i < src.length) {
    const end = skipLiteral(src, i);
    if (end >= 0) {
      i = end;
      continue;
    }
    const c = src[i];
    if (c === open) depth++;
    else if (c === close && !(close === ">" && src[i - 1] === "=") && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

/** The end of the decorator `@a.b<T>(...)` at `i`, and whether it is a marker call. */
function decorator(src: string, i: number, locals: Set<string>): { end: number; marker: boolean } | undefined {
  let j = i + 1;
  let dotted = false;
  let name = "";
  for (;;) {
    IDENT.lastIndex = j;
    const m = IDENT.exec(src);
    if (!m) return undefined;
    name = m[0];
    j += name.length;
    if (src[j] !== ".") break;
    dotted = true;
    j++;
  }
  let k = skipSpace(src, j);
  if (src[k] === "<") {
    const end = skipBalanced(src, k, "<", ">");
    if (end < 0) return undefined;
    k = skipSpace(src, end);
  }
  if (src[k] !== "(") return { end: j, marker: !dotted && locals.has(name) };
  const end = skipBalanced(src, k, "(", ")");
  if (end < 0) return undefined;
  return { end, marker: !dotted && locals.has(name) };
}

/**
 * Blanks xzor's marker decorators (imported from `@source-crafter/xzor-runtime`, aliases included) in a TypeScript source.
 * Every character but line breaks becomes a space, so positions and source maps stay exact.
 */
export function stripMarkerDecorators(src: string): string {
  if (!src.includes("@source-crafter/xzor-runtime")) return src;
  const locals = markerLocals(src);
  if (locals.size === 0) return src;
  let out = "";
  let copied = 0;
  // Only whitespace, comments or decorators since the line start: an `@` here starts a decorator.
  let tokenStart = true;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      tokenStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    const end = skipLiteral(src, i);
    if (end >= 0) {
      if (c !== "/") tokenStart = false;
      i = end;
      continue;
    }
    if (c === "@" && tokenStart) {
      const d = decorator(src, i, locals);
      if (d) {
        if (d.marker) {
          out += src.slice(copied, i) + src.slice(i, d.end).replace(/[^\r\n]/g, " ");
          copied = d.end;
        }
        i = d.end;
        continue;
      }
    }
    tokenStart = false;
    i++;
  }
  return copied === 0 ? src : out + src.slice(copied);
}

const MODEL = "@source-crafter/xzor-runtime/model";
const MODEL_IMPORT = /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@source-crafter\/xzor-runtime\/model["']/g;
// The names an `import`/`export ... from` binds: a default, then the named ones.
const BINDING_IMPORT = /\b(?:import|export)\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
const MODIFIERS = new Set(["public", "protected", "private", "override", "static", "declare", "readonly", "abstract", "accessor", "async", "get", "set"]);
const ACCESS = new Set(["public", "protected", "private", "override"]);
// Tokens that continue a member across a line break, at the end of the line or at the start of the next.
const CONT_END = ".|&,=(:[`+-*?<";
const CONT_START = ".|&,=(`+-*?>";
const CONT_WORDS = new Set(["extends", "keyof", "typeof", "infer", "in", "of", "is", "as", "instanceof"]);
const NO_LOCALS = new Set<string>();

type Field = {
  decStart: number;
  decEnd: number;
  access: [number, number][];
  nameStart: number;
  name: string;
  flag: string;
  flagEnd: number;
  typeStart: number;
  typeEnd: number;
  end: number;
  semi: boolean;
};

type ClassHead = { name: string; model: string; open: number; close: number };

/** Local names bound to `Model`, a component base (`Component`, or the deprecated `ComponentBase`) and `Untracked` by value imports from the runtime. */
function modelLocals(src: string): { model: Set<string>; componentBases: Set<string>; untracked: Set<string> } {
  const model = new Set<string>();
  const componentBases = new Set<string>();
  const untracked = new Set<string>();
  for (const m of src.matchAll(RUNTIME_IMPORT)) {
    if (m[1]) continue;
    for (const spec of m[2]!.split(",")) {
      const [name, as, alias] = spec.trim().split(/\s+/);
      if (name === "Component" || name === "ComponentBase") componentBases.add(as === "as" && alias ? alias : name);
    }
  }
  for (const m of src.matchAll(MODEL_IMPORT)) {
    if (m[1]) continue;
    for (const spec of m[2]!.split(",")) {
      const parts = spec.trim().split(/\s+/);
      if (parts[0] === "type") continue;
      const [name, as, alias] = parts;
      const local = as === "as" && alias ? alias : name;
      if (!local) continue;
      if (name === "Model") model.add(local);
      else if (name === "Untracked") untracked.add(local);
    }
  }
  return { model, componentBases, untracked };
}

/** Reads the source of a module a project file imports relatively, so `extends` can be followed into it. */
export type ModelResolver = (spec: string, from: string) => string | undefined;

type Imported = { spec: string; name: string };
type Imports = { model: Set<string>; componentBases: Set<string>; untracked: Set<string>; imports: Map<string, Imported> };
type FileModels = Imports & { bases: Map<string, string> };
// `files` caches one analysis per resolved path (shared across a build); `open` stops import cycles.
type Scope = { resolve: ModelResolver | undefined; files: Map<string, FileModels | undefined>; open: Set<string> };

function isClassToken(src: string, i: number): boolean {
  return src.startsWith("class", i) && !/[\w$]/.test(src[i - 1] ?? " ") && !/[\w$]/.test(src[i + 5] ?? " ");
}

/** Whether the `class` token at `i` is the module's default export. */
function isDefaultExport(src: string, i: number): boolean {
  let j = skipBack(src, i);
  if (!src.endsWith("default", j)) return false;
  j = skipBack(src, j - 7);
  return src.endsWith("export", j);
}

function skipBack(src: string, i: number): number {
  while (i > 0 && /\s/.test(src[i - 1]!)) i--;
  return i;
}

const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g;

/** The runtime locals and the names a file's imports bind (a namespace import binds `*`). */
function fileImports(src: string): Imports {
  const { model, componentBases, untracked } = modelLocals(src);
  const imports = new Map<string, Imported>();
  for (const m of src.matchAll(NAMESPACE_IMPORT)) imports.set(m[1]!, { spec: m[2]!, name: "*" });
  for (const m of src.matchAll(BINDING_IMPORT)) {
    if (m[1]) continue;
    const spec = m[4]!;
    if (m[2]) imports.set(m[2], { spec, name: "default" });
    for (const part of m[3]?.split(",") ?? []) {
      const parts = part.trim().split(/\s+/);
      if (!parts[0] || parts[0] === "type") continue;
      const [name, as, alias] = parts;
      imports.set(as === "as" && alias ? alias : name!, { spec, name: name! });
    }
  }
  return { model, componentBases, untracked, imports };
}

/** `head` plus every class's base. */
function fileModels(src: string, head: Imports = fileImports(src)): FileModels {
  const bases = new Map<string, string>();
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if (isClassToken(src, i)) {
      const head = classHead(src, i);
      if (head) {
        if (head.name) bases.set(head.name, head.base);
        if (isDefaultExport(src, i)) bases.set("default", head.base);
      }
    }
    i++;
  }
  return { ...head, bases };
}

/**
 * Whether `name` in `file` is a model class (`"component"` for a component, tracked the same way); the import
 * that could not be followed when it may be one.
 */
function modelOf(info: FileModels, file: string, name: string, scope: Scope): boolean | "component" | Imported {
  if (info.model.has(name)) return true;
  if (info.componentBases.has(name)) return "component";
  const key = `${file}|${name}`;
  if (scope.open.has(key)) return false;
  scope.open.add(key);
  try {
    const base = info.bases.get(name);
    if (base !== undefined) return modelOf(info, file, base, scope);
    const imported = info.imports.get(name);
    if (!imported) return false;
    if (imported.name === "*" || !imported.spec.startsWith(".")) return imported;
    const path = join(dirname(file), imported.spec).replaceAll("\\", "/");
    let other = scope.files.get(path);
    if (other === undefined && !scope.files.has(path)) {
      const text = scope.resolve?.(imported.spec, file);
      other = text === undefined ? undefined : fileModels(text);
      scope.files.set(path, other);
    }
    return other ? modelOf(other, path, imported.name, scope) : imported;
  } finally {
    scope.open.delete(key);
  }
}

/** Whether some class extends a name bound by a relative import, which the resolver could follow. */
function extendsRelative(src: string, head: Imports, resolve: ModelResolver | undefined): boolean {
  if (!resolve) return false;
  for (const m of src.matchAll(/\bextends\s+([\w$]+)/g)) if (head.imports.get(m[1]!)?.spec.startsWith(".")) return true;
  return false;
}

/**
 * Every plain field of a model class — one extending the runtime `Model`, or another model of the
 * same file or of a relative module — becomes a `#private` slot with a getter that reports the read
 * and a setter that reports the change, plus the `$define` call that records its names and, unless
 * the class writes its own, a constructor. Lines never move: generated text goes on the field's last
 * line, and the modifiers it takes over are blanked, so source maps stay exact. A model class this
 * scanner cannot rewrite is left alone, with a warning naming `file`.
 */
export function trackModelFields(src: string, file?: string, resolve?: ModelResolver, files: Map<string, FileModels | undefined> = new Map()): string {
  if (!src.includes("extends")) return src;
  const head = fileImports(src);
  if (head.model.size === 0 && head.componentBases.size === 0 && !extendsRelative(src, head, resolve)) return src;
  const info = fileModels(src, head);
  const scope: Scope = { resolve, files, open: new Set() };
  const from = file ?? "";
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if (isClassToken(src, i)) {
      const head = classHead(src, i);
      const kind = head ? modelOf(info, from, head.base, scope) : false;
      if (head && kind !== false) {
        const name = head.name || "an anonymous class";
        const derived = !info.model.has(head.base) && !info.componentBases.has(head.base);
        // A component is built by the runtime (or its injector), never from server data.
        const component = kind === "component";
        if (kind !== true && kind !== "component") {
          // A package base only matters to a component or a file that uses the model runtime.
          if (kind.spec.startsWith(".") || info.componentBases.size > 0 || [...info.imports.values()].some((i) => i.spec === MODEL)) {
            warn(src, i, file, `${name} is not tracked: its base ${head.base} comes from "${kind.spec}" and could not be followed`);
          }
        } else if (derived && !head.name) {
          warn(src, i, file, `${name} is not tracked: name it, so its fields can follow ${head.base}'s`);
        } else {
          const close = head.open < 0 ? -1 : skipBalanced(src, head.open, "{", "}") - 1;
          const full: ClassHead = { name: head.name, model: head.base, open: head.open, close };
          const found = close > 0 ? modelFields(src, full, info.untracked) : undefined;
          if (found) {
            if (!head.name && !found.hasCtor && !component) warn(src, i, file, `${name} gets no constructor: name the class or call this.assign(data) in its constructor`);
            out += src.slice(copied, full.open + 1) + classBody(src, full, found.fields, found.hasCtor || component, derived);
            copied = full.close + 1;
            i = copied;
            continue;
          }
          const reason = head.open < 0 ? "its declaration could not be parsed" : close < 0 ? "its body is not closed" : "a member could not be parsed";
          warn(src, i, file, `${name} is not tracked: ${reason}`);
        }
      }
    }
    i++;
  }
  return copied === 0 ? src : out + src.slice(copied);
}

function skipTrivia(src: string, i: number): number {
  for (;;) {
    i = skipSpace(src, i);
    if (src[i] !== "/" || (src[i + 1] !== "/" && src[i + 1] !== "*")) return i;
    i = skipLiteral(src, i);
  }
}

function isWord(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95 || code === 36;
}

function startsName(src: string, i: number): boolean {
  const c = src.charCodeAt(i);
  // A name, `#private`, `[computed]`, `*generator` or a string name.
  return isWord(c) || c === 35 || c === 91 || c === 42 || c === 39 || c === 34;
}

/** Automatic semicolon insertion: at the line break `nl`, whether a member whose text ends at `last` is complete. */
function memberEnds(src: string, last: number, nl: number, limit: number): boolean {
  const prev = last > 0 ? src[last - 1]! : "\n";
  if (prev === ">" && src[last - 2] === "=") return false;
  if (CONT_END.includes(prev)) return false;
  let w = last;
  while (w > 0 && isWord(src.charCodeAt(w - 1))) w--;
  if (w < last && CONT_WORDS.has(src.slice(w, last))) return false;
  const j = skipTrivia(src, nl + 1);
  if (j >= limit) return true;
  if (CONT_START.includes(src[j]!)) return false;
  IDENT.lastIndex = j;
  const m = IDENT.exec(src);
  return !m || !CONT_WORDS.has(m[0]);
}

/** The end of the member starting at `i`: after its `;`, after a method body, or where ASI ends it. */
function skipMember(src: string, i: number, limit: number): number {
  let assigned = false;
  let last = i;
  while (i < limit) {
    const c = src[i]!;
    if (c === "\n") {
      if (memberEnds(src, last, i, limit)) return last;
      i++;
      continue;
    }
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      if (c !== "/") last = lit;
      i = lit;
      continue;
    }
    if (c === ";") return i + 1;
    if (c === "(" || c === "[" || c === "{") {
      const end = skipBalanced(src, i, c, c === "(" ? ")" : c === "[" ? "]" : "}");
      if (end < 0) return -1;
      if (c === "{" && !assigned) {
        const after = skipTrivia(src, end);
        return src[after] === ";" ? after + 1 : end;
      }
      i = end;
      last = end;
      continue;
    }
    if (c === "}") return i;
    if (c === "<") {
      // A type parameter list (`foo<T = U>()`), whose `=` does not start an initializer.
      const end = skipBalanced(src, i, "<", ">");
      if (end > 0 && src[skipTrivia(src, end)] === "(") {
        i = end;
        last = end;
        continue;
      }
    }
    if (c === "=" && src[i + 1] !== "=" && src[i + 1] !== ">" && !"=!<>+-*/%&|^".includes(src[i - 1]!)) assigned = true;
    i++;
    if (c !== " " && c !== "\t" && c !== "\r") last = i;
  }
  return -1;
}

/** The end of a field's type annotation: the top-level `=` or `;` after it, or where ASI ends the field. */
function annotationEnd(src: string, i: number, limit: number): number {
  let last = i;
  while (i < limit) {
    const c = src[i]!;
    if (c === "\n") {
      if (memberEnds(src, last, i, limit)) return last;
      i++;
      continue;
    }
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      if (c !== "/") last = lit;
      i = lit;
      continue;
    }
    if (c === ";" || c === "}") return i;
    if (c === "(" || c === "[" || c === "{") {
      const end = skipBalanced(src, i, c, c === "(" ? ")" : c === "[" ? "]" : "}");
      if (end < 0) return -1;
      i = end;
      last = end;
      continue;
    }
    if (c === "=" && src[i + 1] !== ">") return i;
    i++;
    if (c !== " " && c !== "\t" && c !== "\r") last = i;
  }
  return -1;
}

/** `class [N] extends B`, with the body's `{`, or -1 for a head this scanner does not understand. */
function classHead(src: string, i: number): { name: string; base: string; open: number } | undefined {
  let j = skipTrivia(src, i + 5);
  let name = "";
  IDENT.lastIndex = j;
  let m = IDENT.exec(src);
  if (m && m[0] !== "extends") {
    name = m[0];
    j = skipTrivia(src, j + name.length);
  }
  if (src[j] === "<") {
    const end = skipBalanced(src, j, "<", ">");
    if (end < 0) return undefined;
    j = skipTrivia(src, end);
  }
  if (!src.startsWith("extends", j)) return undefined;
  j = skipTrivia(src, j + 7);
  IDENT.lastIndex = j;
  m = IDENT.exec(src);
  if (!m) return undefined;
  const base = m[0];
  j = skipTrivia(src, j + base.length);
  if (src[j] === "<") {
    const end = skipBalanced(src, j, "<", ">");
    if (end < 0) return { name, base, open: -1 };
    j = skipTrivia(src, end);
  }
  if (src.startsWith("implements", j)) {
    while (j < src.length && src[j] !== "{") {
      if (src[j] === "<") {
        const end = skipBalanced(src, j, "<", ">");
        if (end < 0) return { name, base, open: -1 };
        j = end;
        continue;
      }
      j++;
    }
  }
  return { name, base, open: src[j] === "{" ? j : -1 };
}

/** The fields to rewrite, or `undefined` for a body this scanner does not understand. */
function modelFields(src: string, head: ClassHead, untracked: Set<string>): { fields: Field[]; hasCtor: boolean } | undefined {
  const fields: Field[] = [];
  let hasCtor = false;
  let i = skipTrivia(src, head.open + 1);
  while (i < head.close) {
    let decStart = -1;
    let decEnd = -1;
    let skip = false;
    while (src[i] === "@") {
      const d = decorator(src, i, NO_LOCALS);
      if (!d) return undefined;
      if (decStart < 0) decStart = i;
      decEnd = d.end;
      const named = /^@\s*([\w$]+)/.exec(src.slice(i, d.end));
      if (named && untracked.has(named[1]!)) skip = true;
      i = skipTrivia(src, d.end);
    }
    const access: [number, number][] = [];
    for (;;) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(src);
      if (!m) break;
      const word = m[0];
      const after = skipTrivia(src, i + word.length);
      if (word === "static" && src[after] === "{") {
        skip = true;
        break;
      }
      if (!MODIFIERS.has(word) || !startsName(src, after)) break;
      if (ACCESS.has(word)) access.push([i, i + word.length]);
      else skip = true;
      i = after;
    }
    IDENT.lastIndex = i;
    const named = IDENT.exec(src);
    if (skip || !named) {
      i = skipMember(src, i, head.close);
      if (i < 0) return undefined;
      i = skipTrivia(src, i);
      continue;
    }
    const name = named[0];
    const nameStart = i;
    let flagEnd = i + name.length;
    let k = skipTrivia(src, flagEnd);
    let flag = "";
    if (src[k] === "?" || src[k] === "!") {
      flag = src[k]!;
      flagEnd = k + 1;
      k = skipTrivia(src, flagEnd);
    }
    let typeStart = -1;
    let typeEnd = -1;
    if (src[k] === ":") {
      typeStart = k;
      typeEnd = annotationEnd(src, k + 1, head.close);
      if (typeEnd < 0) return undefined;
      k = typeEnd;
    }
    // A bare `id` (no type, no initializer, no `;`) ends at its own line, not at the next member.
    const bare = typeStart < 0 && !"=;(<".includes(src[k] ?? "");
    const end = skipMember(src, bare ? flagEnd : k, head.close);
    if (end < 0) return undefined;
    if (src[k] === "(" || src[k] === "<") {
      if (name === "constructor") hasCtor = true;
      i = skipTrivia(src, end);
      continue;
    }
    fields.push({ decStart, decEnd, access, nameStart, name, flag, flagEnd, typeStart, typeEnd, end, semi: src[end - 1] === ";" });
    i = skipTrivia(src, end);
  }
  return { fields, hasCtor };
}

function warn(src: string, at: number, file: string | undefined, message: string): void {
  let line = 1;
  for (let i = 0; i < at; i++) if (src.charCodeAt(i) === 10) line++;
  console.error(`xzor: ${file ?? "<source>"}:${line}: ${message}`);
}

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function classBody(src: string, head: ClassHead, fields: Field[], hasCtor: boolean, derived: boolean): string {
  const names = fields.map((field) => JSON.stringify(field.name)).join(", ");
  // A derived class's fields continue after its base's, a count only the base knows: `$define` stores it as the
  // class's `$at`. The call stays in a static block, which runs after the member decorators `$define` takes over;
  // Bun moves a decorated class's static blocks out of it, so the block names nothing private.
  const at = derived ? `${head.name}.$at + ` : "";
  let out = hasCtor || !head.name ? "" : ` constructor(data?: object) { super(data); if (new.target === ${head.name}) this.assign(data); }`;
  let copied = head.open + 1;
  fields.forEach((field, index) => {
    const spans = field.decStart < 0 ? field.access : [[field.decStart, field.decEnd] as [number, number], ...field.access];
    for (const [start, end] of spans) {
      out += src.slice(copied, start) + blank(src.slice(start, end));
      copied = end;
    }
    out += `${src.slice(copied, field.nameStart)}#${field.name}${field.flag === "!" ? "!" : ""}`;
    let type = "";
    copied = field.flagEnd;
    if (field.typeStart >= 0) {
      const raw = src.slice(field.typeStart + 1, field.typeEnd);
      out += `${src.slice(copied, field.typeStart)}:${field.flag === "?" ? `${raw.trimEnd()} | undefined` : raw}`;
      type = raw.replace(/\s+/g, " ").trim() + (field.flag === "?" ? " | undefined" : "");
      copied = field.typeEnd;
    }
    const access = field.access.map(([start, end]) => `${src.slice(start, end)} `).join("");
    const decorators = field.decStart < 0 ? "" : `${src.slice(field.decStart, field.decEnd).replace(/\s+/g, " ")} `;
    out += src.slice(copied, field.end);
    if (!field.semi) out += ";";
    out += ` ${decorators}${access}get ${field.name}()${type && `: ${type}`} { ${head.model}.$reader?.(this, ${at}${index}); return this.#${field.name}; }`;
    out += ` ${access}set ${field.name}(v${type && `: ${type}`}) { const p = this.#${field.name}; if (${head.model}.same(p, v)) return; this.#${field.name} = v; this.$changed(${at}${index}, p); }`;
    copied = field.end;
  });
  const define = `static { ${head.model}.$define(this, [${names}]); } `;
  return `${out}${src.slice(copied, head.close)}${define}}`;
}

const IMPORT_CLAUSE = /^import\s+([^"']+?)\s+from\s*["'][^"']+["']/gm;
const hotTranspiler = new Bun.Transpiler({ loader: "ts" });

/** Local names bound by the value imports of a TypeScript source (the transpiler drops type-only ones).
 *  Mirrored by `importLocals` in npm/xzor/bin/dev.ts; tests/dev-hot.test.ts keeps them in step. */
export function valueImportLocals(ts: string): string[] {
  const locals: string[] = [];
  for (const m of hotTranspiler.transformSync(ts).matchAll(IMPORT_CLAUSE)) {
    const clause = m[1]!;
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of clause.replace(/\{[^}]*\}/, "").split(",")) {
      const local = part.trim().replace(/^\*\s*as\s+/, "");
      if (local) locals.push(local);
    }
    for (const spec of named?.[1]!.split(",") ?? []) {
      const local = spec.trim().split(/\s+as\s+/).pop()!;
      if (local) locals.push(local);
    }
  }
  return locals;
}

/** Appends the dev registration of a generated component's default class (no existing position moves). */
export function hotRegistration(ts: string, id: string): string {
  const cls = /export default class (\w+)/.exec(ts)?.[1];
  if (!cls) return ts;
  return `${ts};globalThis.__xzorHot?.register(${JSON.stringify(id)}, ${cls}, () => ({ ${valueImportLocals(ts).join(", ")} }));`;
}

/** Appended to a registered component: hands the hot client the runtime's `$rebuild` (and turns on the start comments it needs). */
const HOT_LINK = `;import { $hot as __xzorHook } from "@source-crafter/xzor-runtime";globalThis.__xzorHot?.link(__xzorHook());`;

const SW_HEADER = "// Generated by xzor. Do not edit.";
const MANIFEST = "manifest.webmanifest";
const PAGE_REF = /\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A reference that can be precached: no scheme, inside the project root, an existing file; `undefined` otherwise. */
function localAsset(ref: string, root: string): string | undefined {
  if (ref.startsWith("#") || ref.startsWith("//") || SCHEME.test(ref)) return undefined;
  const path = relative(root, resolve(root, ref.split(/[?#]/)[0]!)).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
  const file = join(root, path);
  return existsSync(file) && statSync(file).isFile() ? path : undefined;
}

type Manifest = Record<string, unknown> | null;

/** The parsed manifest, or the parse error. */
function parseManifest(text: string): Manifest | Error {
  try {
    return JSON.parse(text);
  } catch (e) {
    return e as Error;
  }
}

function manifestIcons(manifest: Manifest | Error): { src?: unknown; sizes?: unknown }[] {
  const icons = manifest instanceof Error ? undefined : manifest?.icons;
  return Array.isArray(icons) ? icons : [];
}

// A root-absolute icon (`/icons/x.png`) is the project's own file when the app is served from the domain root.
const iconAsset = (src: string, root: string) => localAsset(src.startsWith("/") && !src.startsWith("//") ? src.slice(1) : src, root);

/** The problems of a web manifest, reported as warnings; an empty list means it is usable. */
export function checkManifest(text: string, root: string, parsed = parseManifest(text)): string[] {
  if (parsed instanceof Error) return [`invalid JSON: ${parsed.message}`];
  const manifest = parsed;
  const problems: string[] = [];
  for (const field of ["name", "short_name", "display"]) if (!manifest?.[field]) problems.push(`missing "${field}"`);
  const icons = manifestIcons(manifest);
  for (const size of ["192x192", "512x512"]) {
    if (!icons.some((i) => typeof i?.sizes === "string" && i.sizes.split(/\s+/).includes(size))) problems.push(`no icon with "sizes" ${size}`);
  }
  for (const icon of icons) {
    const src = icon?.src;
    if (typeof src === "string" && !src.startsWith("//") && !SCHEME.test(src) && !iconAsset(src, root)) problems.push(`icon not found: ${src}`);
  }
  return problems;
}

/** The project's manifest; a missing one has no icons. */
function readManifest(root: string): Manifest | Error {
  const path = join(root, MANIFEST);
  return existsSync(path) ? parseManifest(readFileSync(path, "utf8")) : null;
}

/** The existing local files `index.html` references, relative to the root. */
function indexAssets(root: string): string[] {
  const index = join(root, "index.html");
  if (!existsSync(index)) return [];
  const found: string[] = [];
  for (const m of readFileSync(index, "utf8").matchAll(PAGE_REF)) {
    const asset = m[1]!.startsWith("/") ? undefined : localAsset(m[1]!, root);
    if (asset) found.push(asset);
  }
  return found;
}

/** The manifest's icons that are files of the project, relative to the root. */
function iconFiles(root: string, manifest: Manifest | Error): string[] {
  const found: string[] = [];
  for (const icon of manifestIcons(manifest)) {
    const asset = typeof icon?.src === "string" ? iconAsset(icon.src, root) : undefined;
    if (asset) found.push(asset);
  }
  return found;
}

/** The files the worker precaches: the app shell, the local assets `index.html` and the manifest point at, and the outputs. */
export function precacheList(root: string, outputs: string[], manifest = readManifest(root)): string[] {
  const files = new Set(["./", MANIFEST]);
  if (existsSync(join(root, "index.html"))) files.add("index.html");
  for (const asset of [...indexAssets(root), ...iconFiles(root, manifest)]) files.add(asset);
  for (const output of outputs) {
    if (/\.(map|br|gz)$/.test(output)) continue;
    const rel = relative(root, output).replaceAll("\\", "/");
    if (rel && !rel.startsWith("..")) files.add(rel);
  }
  return [...files].sort();
}

/** Hex hash of the precached paths and contents in list order: a rebuild with no change keeps the cache name. `known` holds contents already in memory. */
export function precacheVersion(root: string, files: string[], known: Map<string, string>): string {
  let hash = 0n;
  for (const file of files) {
    const path = join(root, file);
    const text = known.get(file);
    if (text === undefined && (file.endsWith("/") || !existsSync(path))) continue;
    hash = BigInt(Bun.hash(file, hash));
    hash = BigInt(Bun.hash(text ?? readFileSync(path), hash));
  }
  return hash.toString(16);
}

/** The worker source: precache on install, drop older `xzor-` caches on activate, serve same-origin GETs offline. */
export function serviceWorker(version: string, files: string[]): string {
  return `${SW_HEADER}
const CACHE = ${JSON.stringify(`xzor-${version}`)};
const FILES = ${JSON.stringify(files)};

// A new version takes over at once; a page opened under the old one gets the new files on its next load.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith("xzor-")).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    const shell = new URL("index.html", self.registration.scope).href;
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match(shell, { ignoreVary: true })).then((hit) => hit ?? Response.error())));
    return;
  }
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request, { ignoreVary: true })).then((hit) => hit ?? fetch(request)));
});
`;
}

/**
 * Writes `<root>/sw.js` and registers it from the entry bundle when the project has a web manifest;
 * without one, a worker this wrote before is removed. Never called under `--watch`.
 */
function writeServiceWorker(root: string, outputs: string[], entryOutput: string | undefined): void {
  const worker = join(root, "sw.js");
  if (!existsSync(join(root, MANIFEST))) {
    if (existsSync(worker) && readFileSync(worker, "utf8").startsWith(SW_HEADER)) rmSync(worker);
    return;
  }
  const text = readFileSync(join(root, MANIFEST), "utf8");
  const manifest = parseManifest(text);
  for (const problem of checkManifest(text, root, manifest)) console.error(`xzor: ${MANIFEST}: ${problem}`);
  // Contents already in memory, so the worker version does not re-read the bundle just written.
  const known = new Map<string, string>();
  if (entryOutput) {
    const rel = relative(dirname(entryOutput), root).replaceAll("\\", "/") || ".";
    const bundle = readFileSync(entryOutput, "utf8");
    const line = `if ("serviceWorker" in navigator) navigator.serviceWorker.register(new URL(${JSON.stringify(`${rel}/sw.js`)}, import.meta.url));\n`;
    // After all code, before the trailing source map comment: no mapped position moves.
    const at = bundle.lastIndexOf("\n//# sourceMappingURL=") + 1;
    const full = at > 0 ? bundle.slice(0, at) + line + bundle.slice(at) : bundle.endsWith("\n") ? bundle + line : `${bundle}\n${line}`;
    writeFileSync(entryOutput, full);
    known.set(relative(root, entryOutput).replaceAll("\\", "/"), full);
  }
  const files = precacheList(root, outputs, manifest);
  writeFileSync(worker, serviceWorker(precacheVersion(root, files, known), files));
}

const TEXT_OUTPUT = /\.(js|css|html|json|svg)$/;

/** Writes a `.br` and a `.gz` copy beside each text file (fonts and images are already compressed) and returns the paths written. */
export function compressOutputs(paths: string[]): string[] {
  const written: string[] = [];
  for (const path of paths) {
    if (!TEXT_OUTPUT.test(path)) continue;
    const bytes = readFileSync(path);
    writeFileSync(`${path}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
    writeFileSync(`${path}.gz`, gzipSync(bytes, { level: 6 }));
    written.push(`${path}.br`, `${path}.gz`);
  }
  return written;
}

/** One `@page` pattern as `build.rs` lists it: `file` is relative to the project root. */
export type PageEntry = { pattern: string; file: string; name: string };

type MetaOutput = { entryPoint?: string; inputs: Record<string, unknown>; imports: { path: string; kind: string }[] };
/** The part of Bun's metafile the shells read: output keys and their imports are relative to `outdir`, input keys to the working directory. */
export type BuildMetafile = { inputs: Record<string, unknown>; outputs: Record<string, MetaOutput> };

/**
 * One shell per page: `template` (`index.html`) with a `modulepreload` link, before `</head>`, for the page's chunk
 * and every chunk its static imports and the entry's reach. `shells` maps `pages/<Name>.html` to the HTML, `routes`
 * each pattern to its shell. Hrefs are relative to the project root, so a `<base>` keeps them working.
 */
export function pageShells(template: string, metafile: BuildMetafile, outdir: string, root: string, pages: PageEntry[]): { shells: Map<string, string>; routes: Record<string, string> } {
  const at = template.search(/<\/head\s*>/i);
  if (at < 0) throw new Error("index.html has no </head>");
  const outputs = new Map<string, MetaOutput>();
  for (const [key, out] of Object.entries(metafile.outputs)) outputs.set(resolve(outdir, key), out);
  // The entry is the output nothing imports; the chunks of dynamic imports are imported.
  const imported = new Set<string>();
  const statics = new Map<string, string[]>();
  for (const [path, out] of outputs) {
    const list: string[] = [];
    for (const imp of out.imports) {
      const target = resolve(outdir, imp.path);
      imported.add(target);
      if (imp.kind === "import-statement") list.push(target);
    }
    statics.set(path, list);
  }
  const roots = [...outputs].filter(([path, out]) => out.entryPoint !== undefined && !imported.has(path)).map(([path]) => path);
  const entries = new Set(roots);
  const closure = (from: string, seen: Set<string>): void => {
    if (seen.has(from)) return;
    seen.add(from);
    for (const next of statics.get(from) ?? []) closure(next, seen);
  };
  const base = new Set<string>();
  for (const entry of roots) closure(entry, base);
  const ownerOf = (candidates: string[]): string | undefined => {
    let found: string | undefined;
    for (const [path, out] of outputs) {
      if (out.entryPoint !== undefined && candidates.includes(resolve(out.entryPoint))) return path;
      if (found === undefined && Object.keys(out.inputs).some((i) => candidates.includes(resolve(i)))) found = path;
    }
    return found;
  };
  const shells = new Map<string, string>();
  const routes: Record<string, string> = {};
  const byFile = new Map<string, string>();
  const names = new Set<string>();
  for (const page of pages) {
    let shell = byFile.get(page.file);
    if (shell === undefined) {
      // Two pages with one stem (`a/Post`, `b/Post`) must not share a shell.
      let name = page.name;
      for (let n = 2; names.has(name); n++) name = `${page.name}-${n}`;
      names.add(name);
      shell = `pages/${name}.html`;
      byFile.set(page.file, shell);
      const source = resolve(root, page.file);
      const owner = ownerOf([source, `${source}.ts`, join(root, ".xzor", `${page.file}.ts`)]);
      const seen = new Set(base);
      if (owner !== undefined) closure(owner, seen);
      const links: string[] = [];
      for (const path of seen) {
        if (entries.has(path)) continue;
        links.push(`<link rel="modulepreload" href="${encodeURI(relative(root, path).replaceAll("\\", "/")).replaceAll("&", "&amp;")}">\n`);
      }
      shells.set(shell, template.slice(0, at) + links.join("") + template.slice(at));
    }
    routes[page.pattern] = shell;
  }
  return { shells, routes };
}

/**
 * `template` with the browser bundle's module script before `</body>` and its stylesheet link (when `css` is given)
 * before `</head>`, each unless the template already points at a file of that name. Hrefs are relative to the root.
 */
export function withBundle(template: string, script: string, css?: string): string {
  const has = (tag: string, attr: string, href: string) =>
    new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']?(?:[^"'\\s>]*/)?${basename(href).replaceAll(".", "\\.")}(?![\\w.-])`, "i").test(template);
  const insert = (text: string, at: number, line: string) => (at < 0 ? text + line : text.slice(0, at) + line + text.slice(at));
  let out = template;
  if (css && !has("link", "href", css)) out = insert(out, out.search(/<\/head\s*>/i), `<link rel="stylesheet" href="${css}">\n`);
  if (!has("script", "src", script)) out = insert(out, out.search(/<\/body\s*>/i), `<script type="module" src="${script}"></script>\n`);
  return out;
}

/**
 * `entry` is the browser entry (none for an API-only server). `server` marks a server app: its browser bundle is
 * named `main` and, under `minify`, `server` is bundled with `target: "bun"` to `<outdir>/server.js`, minified, with no map.
 */
async function main(entry: string | undefined, outdir: string, hot = false, watch = false, minify = false, pagesFile?: string, server?: string): Promise<void> {
  const root = projectRoot(dirname(resolve((entry ?? server)!)));
  // Stripped sources by absolute path; the source map shows the originals.
  const originals = new Map<string, string>();
  // Sources of the modules a model's `extends` is followed into, read once each.
  const bases = new Map<string, string | undefined>();
  const models = new Map<string, FileModels | undefined>();
  const readBase = (spec: string, from: string): string | undefined => {
    const dir = dirname(resolve(root, from));
    const path = tryResolve(spec, dir) ?? tryResolve(spec, mirroredDir(dir, root));
    if (!path || !rewritable(path, root)) return undefined;
    if (!bases.has(path)) bases.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
    return bases.get(path);
  };
  // Fonts the CSS points at (`./fonts/x.woff2`), by that spec: copied under `outdir` after the build.
  const fonts = new Map<string, string>();
  // Chunk names carry a hash: the last build's would pile up.
  rmSync(join(outdir, "chunks"), { recursive: true, force: true });
  // So are the shells, pages.json and compressed copies of a --minify build.
  rmSync(join(outdir, "pages"), { recursive: true, force: true });
  rmSync(join(outdir, "pages.json"), { force: true });
  if (server) rmSync(join(outdir, "server.js"), { force: true });
  if (existsSync(outdir)) for (const f of readdirSync(outdir)) if (/\.(br|gz)$/.test(f)) rmSync(join(outdir, f), { force: true });
  const run = (config: Bun.BuildConfig) => Bun.build({
    ...config,
    plugins: [
      {
        name: "xzor",
        setup(build) {
          // Bun inlines assets under 128 KB as base64, which would hold the first paint behind the CSS.
          build.onResolve({ filter: /^\.\/.*\.woff2?$/ }, (args) => {
            fonts.set(args.path, resolve(dirname(args.importer), args.path));
            return { path: args.path, external: true };
          });
          // Relative only: a package specifier (`@scope/kit/X.xzor`) goes through the tsconfig `paths`.
          build.onResolve({ filter: /^\.\.?\/.*\.xzor$/ }, (args) => ({
            path: generatedPath(resolve(dirname(args.importer), args.path)),
          }));
          // Like the type check's rootDirs: a relative import missing beside its importer comes from the
          // other root of the importer's own project (the app's, or a kit's outside it).
          build.onResolve({ filter: /^\.\.?\// }, (args) => {
            const dir = dirname(args.importer);
            if (args.importer.replaceAll("\\", "/").includes("/node_modules/")) return undefined;
            if (tryResolve(args.path, dir)) return undefined;
            const path = tryResolve(args.path, mirroredDir(dir, inProject(args.importer, root) ? root : projectRoot(dir)));
            return path ? { path } : undefined;
          });
          build.onLoad({ filter: /\.ts$/ }, (args) => {
            const path = args.path.replaceAll("\\", "/");
            let text = readFileSync(args.path, "utf8");
            const tracked = tracksFields(args.path, root, text);
            if (tracked) {
              const rewritten = trackModelFields(stripMarkerDecorators(text), relative(root, args.path).replaceAll("\\", "/"), readBase, models);
              if (rewritten !== text) originals.set(resolve(args.path), text);
              text = rewritten;
            }
            if (path.includes("/.xzor/") && path.endsWith(".xzor.ts")) text = importBindings(text, args.path);
            // A component's lowered `<style>` sits beside its module; appended, so no line moves under the source map.
            if (path.includes("/.xzor/") && path.endsWith(".xzor.ts") && existsSync(`${args.path.slice(0, -3)}.css`)) {
              text += `\nimport "./${basename(args.path).slice(0, -3)}.css";\n`;
            }
            if (path.includes("/.xzor/") && hot && path.endsWith(".xzor.ts") && inProject(args.path, root)) {
              const registered = hotRegistration(text, relative(root, args.path).replaceAll("\\", "/"));
              return { contents: registered === text ? text : registered + HOT_LINK, loader: "ts" };
            }
            return { contents: text, loader: "ts" };
          });
        },
      },
    ],
  });
  // The entry keeps the name index.html loads (`main` for a server app, whose entry is `.xzor/client.ts`).
  const entryName = server ? "main.[ext]" : "[dir]/[name].[ext]";
  const [result, bundled] = await Promise.all([
    entry &&
      run({
        entrypoints: [entry],
        outdir,
        target: "browser",
        sourcemap: "linked",
        metafile: minify,
        // Lazy pages and `@async` components become chunks.
        ...(minify ? { minify: true, splitting: true, naming: { entry: entryName, chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" } } : { naming: { entry: entryName } }),
      }),
    server && minify && run({ entrypoints: [server], outdir, target: "bun", minify: true, naming: "server.[ext]" }),
  ]);
  for (const r of [result, bundled]) {
    if (!r) continue;
    for (const log of r.logs) console.error(log);
    if (!r.success) process.exit(1);
  }
  // Never listed, served, compressed or mapped: `bun dist/server.js` runs it.
  for (const o of bundled ? bundled.outputs : []) console.log(`  ${o.path}`);
  // Bun also writes each chunk's CSS into the entry's, and nothing loads the chunk copy.
  const outputs = (result ? result.outputs : []).filter((o) => {
    const dup = minify && o.path.endsWith(".css") && /[\\/]chunks[\\/]/.test(o.path);
    if (dup) rmSync(o.path, { force: true });
    return !dup;
  });
  for (const [spec, file] of fonts) {
    const to = join(outdir, spec);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file, to);
  }
  for (const output of outputs) {
    if (output.path.endsWith(".map")) {
      const mapDir = dirname(output.path);
      const outer: SourceMap = JSON.parse(readFileSync(output.path, "utf8"));
      const composed = composeMaps(outer, (source) => {
        const file = resolve(mapDir, source);
        if (!file.endsWith(".xzor.ts") || !existsSync(`${file}.map`)) return undefined;
        const dir = relative(mapDir, dirname(file)).replaceAll("\\", "/") || ".";
        return { map: JSON.parse(readFileSync(`${file}.map`, "utf8")), dir };
      });
      composed.sources.forEach((source, i) => {
        const original = originals.get(resolve(mapDir, source));
        if (original !== undefined && composed.sourcesContent) composed.sourcesContent[i] = original;
      });
      writeFileSync(output.path, JSON.stringify(composed));
    }
    console.log(`  ${output.path}`);
  }
  const paths = outputs.map((o) => o.path);
  // Written outside Bun's outputs; the worker precaches them and the copies are made of them.
  const extra: string[] = [];
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  // A server app's index.html is served as `dist/index.html`, the project's with the bundle's script and stylesheet added.
  const listed = new Set(server ? [] : ["index.html"]);
  const pagesJson = join(outdir, "pages.json");
  let routes: Record<string, string> | undefined;
  // Every minified build with an index.html gets it: it is the allow-list `serveDist` serves from (an app with no `@page` has no routes).
  if (minify && result) {
    const index = join(dirname(resolve(outdir)), "index.html");
    if (existsSync(index)) {
      let template = readFileSync(index, "utf8");
      if (server) {
        const css = outputs.some((o) => basename(o.path) === "main.css");
        template = withBundle(template, rel(join(outdir, "main.js")), css ? rel(join(outdir, "main.css")) : undefined);
        const served = join(outdir, "index.html");
        writeFileSync(served, template);
        extra.push(served);
        listed.add(rel(served));
      }
      const built = pagesFile
        ? pageShells(template, result.metafile!, resolve(outdir), root, JSON.parse(readFileSync(pagesFile, "utf8")) as PageEntry[])
        : { routes: {}, shells: new Map<string, string>() };
      routes = built.routes;
      rmSync(join(outdir, "pages"), { recursive: true, force: true });
      mkdirSync(join(outdir, "pages"), { recursive: true });
      for (const o of outputs) if (!o.path.endsWith(".map")) listed.add(rel(o.path));
      for (const spec of fonts.keys()) listed.add(rel(join(outdir, spec)));
      for (const [shell, html] of built.shells) {
        writeFileSync(join(outdir, shell), html);
        extra.push(join(outdir, shell));
        listed.add(rel(join(outdir, shell)));
      }
    }
  }
  if (!watch) writeServiceWorker(root, [...paths, ...extra], outputs.find((o) => o.kind === "entry-point")?.path);
  if (routes) {
    // The files a server serves: the build, what index.html references and, for a PWA, the worker, manifest and icons.
    for (const asset of indexAssets(root)) listed.add(asset);
    if (!watch && existsSync(join(root, MANIFEST))) {
      for (const asset of ["sw.js", MANIFEST, ...iconFiles(root, readManifest(root))]) listed.add(asset);
    }
    writeFileSync(pagesJson, JSON.stringify({ routes, files: [...listed].sort() }));
  }
  if (minify) compressOutputs([...paths, ...extra]);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const at = ["--pages", "--server"].map((f) => args.indexOf(f)).filter((i) => i >= 0);
  // `--pages` and `--server` take a value, which is not a positional.
  const [entry, outdir] = args.filter((a, i) => !a.startsWith("--") && !at.includes(i - 1));
  if (!entry || !outdir) throw new Error("usage: bun bundle.ts <entry|-> <outdir> [--hot] [--watch] [--minify] [--pages <file>] [--server <file>]");
  await main(entry === "-" ? undefined : entry, outdir, args.includes("--hot"), args.includes("--watch"), args.includes("--minify"), args.includes("--pages") ? value("--pages") : undefined, args.includes("--server") ? value("--server") : undefined);
}
