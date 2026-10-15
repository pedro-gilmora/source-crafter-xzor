// Bundles a xzor app with Bun. `./X.xzor` imports resolve to the generated `<project>/.xzor/<rel>/X.xzor.ts`,
// and the bundle's source map is composed with each generated file's map so it points at the `.xzor` sources.
// Usage: bun bundle.ts <entry> <outdir> [--hot]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

async function main(entry: string, outdir: string, hot = false): Promise<void> {
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
            const stripped = stripMarkerDecorators(text);
            if (stripped !== text) originals.set(resolve(args.path), text);
            return { contents: stripped, loader: "ts" };
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
}

if (import.meta.main) {
  const [entry, outdir, flag] = process.argv.slice(2);
  if (!entry || !outdir) throw new Error("usage: bun bundle.ts <entry> <outdir> [--hot]");
  await main(entry, outdir, flag === "--hot");
}
