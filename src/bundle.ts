// Bundles a xzor app with Bun. `./X.xzor` imports resolve to the generated `<project>/.xzor/<rel>/X.xzor.ts`,
// and the bundle's source map is composed with each generated file's map so it points at the `.xzor` sources.
// Usage: bun bundle.ts <entry> <outdir> [--hot] [--watch]
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

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

// xzor's DI decorators are no-ops read only by the analyzer; stripping them spares the bundle the decorator helpers.
const MARKERS = new Set(["ServiceProvider", "Mount", "Import", "Singleton", "Scoped", "Transient"]);
const RUNTIME_IMPORT = /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@source-crafter\/xzor-runtime["']/g;
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
  if (src[k] !== "(") return { end: j, marker: false };
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

/** Local names bound to `Model` and `Untracked` by value imports from the runtime's model entry. */
function modelLocals(src: string): { model: Set<string>; untracked: Set<string> } {
  const model = new Set<string>();
  const untracked = new Set<string>();
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
  return { model, untracked };
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

/**
 * Every plain field of a direct `Model` subclass (v1: only direct ones) becomes a `#private` slot
 * with a getter that reports the read and a setter that reports the change, plus a `$define` static
 * block and, unless the class writes its own, a constructor. Lines never move: generated text goes
 * on the field's last line, and the modifiers it takes over are blanked, so source maps stay exact.
 * A model class this scanner cannot rewrite is left alone, with a warning naming `file`.
 */
export function trackModelFields(src: string, file?: string): string {
  if (!src.includes(MODEL)) return src;
  const { model, untracked } = modelLocals(src);
  if (model.size === 0) return src;
  const locals = [...model].map((name) => name.replace(/[$]/g, "\\$")).join("|");
  if (!new RegExp(`\\bextends\\s+(?:${locals})\\b`).test(src)) return src;
  // The model locals plus the classes extending them, so an indirect subclass is reported.
  const models = new Set(model);
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < src.length) {
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    if (src.startsWith("class", i) && !/[\w$]/.test(src[i - 1] ?? " ") && !/[\w$]/.test(src[i + 5] ?? " ")) {
      const head = classHead(src, i);
      if (head && models.has(head.base)) {
        if (head.name) models.add(head.name);
        const name = head.name || "an anonymous class";
        if (!model.has(head.base)) {
          warn(src, i, file, `${name} is not tracked: it extends ${head.base}; only direct subclasses of ${[...model][0]} are tracked`);
        } else {
          const close = head.open < 0 ? -1 : skipBalanced(src, head.open, "{", "}") - 1;
          const full: ClassHead = { name: head.name, model: head.base, open: head.open, close };
          const found = close > 0 ? modelFields(src, full, untracked) : undefined;
          if (found) {
            if (!head.name && !found.hasCtor) warn(src, i, file, `${name} gets no constructor: name the class or call this.assign(data) in its constructor`);
            out += src.slice(copied, full.open + 1) + classBody(src, full, found.fields, found.hasCtor);
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

function warn(src: string, at: number, file: string | undefined, message: string): void {
  let line = 1;
  for (let i = 0; i < at; i++) if (src.charCodeAt(i) === 10) line++;
  console.error(`xzor: ${file ?? "<source>"}:${line}: ${message}`);
}

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function classBody(src: string, head: ClassHead, fields: Field[], hasCtor: boolean): string {
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
    out += ` ${decorators}${access}get ${field.name}()${type && `: ${type}`} { ${head.model}.$reader?.(this, ${index}); return this.#${field.name}; }`;
    out += ` ${access}set ${field.name}(v${type && `: ${type}`}) { const p = this.#${field.name}; if (${head.model}.same(p, v)) return; this.#${field.name} = v; this.$changed(${index}, p); }`;
    copied = field.end;
  });
  const names = fields.map((field) => JSON.stringify(field.name)).join(", ");
  return `${out}${src.slice(copied, head.close)}static { ${head.model}.$define(this, [${names}]); } }`;
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

/** The files the worker precaches: the app shell, the local assets `index.html` and the manifest point at, and the outputs. */
export function precacheList(root: string, outputs: string[], manifest = readManifest(root)): string[] {
  const files = new Set(["./", MANIFEST]);
  const index = join(root, "index.html");
  if (existsSync(index)) {
    files.add("index.html");
    for (const m of readFileSync(index, "utf8").matchAll(PAGE_REF)) {
      const asset = m[1]!.startsWith("/") ? undefined : localAsset(m[1]!, root);
      if (asset) files.add(asset);
    }
  }
  for (const icon of manifestIcons(manifest)) {
    const asset = typeof icon?.src === "string" ? iconAsset(icon.src, root) : undefined;
    if (asset) files.add(asset);
  }
  for (const output of outputs) {
    if (output.endsWith(".map")) continue;
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

async function main(entry: string, outdir: string, hot = false, watch = false): Promise<void> {
  const root = projectRoot(dirname(resolve(entry)));
  // Stripped sources by absolute path; the source map shows the originals.
  const originals = new Map<string, string>();
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    sourcemap: "linked",
    plugins: [
      {
        name: "xzor",
        setup(build) {
          build.onResolve({ filter: /\.xzor$/ }, (args) => ({
            path: generatedPath(resolve(dirname(args.importer), args.path)),
          }));
          // Like the type check's rootDirs: a relative import missing beside its importer comes from the other root.
          build.onResolve({ filter: /^\.\.?\// }, (args) => {
            const dir = dirname(args.importer);
            if (!inProject(args.importer, root) || args.importer.replaceAll("\\", "/").includes("/node_modules/")) return undefined;
            if (tryResolve(args.path, dir)) return undefined;
            const path = tryResolve(args.path, mirroredDir(dir, root));
            return path ? { path } : undefined;
          });
          build.onLoad({ filter: /\.ts$/ }, (args) => {
            const path = args.path.replaceAll("\\", "/");
            const text = readFileSync(args.path, "utf8");
            if (path.includes("/.xzor/") && hot && path.endsWith(".xzor.ts") && inProject(args.path, root)) {
              return { contents: hotRegistration(text, relative(root, args.path).replaceAll("\\", "/")), loader: "ts" };
            }
            if (!inProject(args.path, root) || path.includes("/node_modules/") || path.includes("/.xzor/")) return { contents: text, loader: "ts" };
            const rewritten = trackModelFields(stripMarkerDecorators(text), relative(root, args.path).replaceAll("\\", "/"));
            if (rewritten !== text) originals.set(resolve(args.path), text);
            return { contents: rewritten, loader: "ts" };
          });
        },
      },
    ],
  });
  for (const log of result.logs) console.error(log);
  if (!result.success) process.exit(1);
  for (const output of result.outputs) {
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
  if (!watch) {
    const paths = result.outputs.map((o) => o.path);
    writeServiceWorker(root, paths, result.outputs.find((o) => o.kind === "entry-point")?.path);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [entry, outdir] = args.filter((a) => !a.startsWith("--"));
  if (!entry || !outdir) throw new Error("usage: bun bundle.ts <entry> <outdir> [--hot] [--watch]");
  await main(entry, outdir, args.includes("--hot"), args.includes("--watch"));
}
