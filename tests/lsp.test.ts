// End-to-end: drives `xzor lsp` over stdio against examples/counter, like an editor would.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const root = join(repo, "examples", "counter");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "xzor.exe" : "xzor");

const uriOf = (p: string) =>
  process.platform === "win32"
    ? `file:///${p[0]!.toLowerCase()}%3A${p.slice(2).replaceAll("\\", "/").replaceAll(" ", "%20")}`
    : `file://${p.replaceAll(" ", "%20")}`;

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>;
let nextId = 0;
const pending = new Map<number | string, (m: Msg) => void>();
const diagnostics = new Map<string, any[]>();
const publishes = new Map<string, number>();
const registrations: any[] = [];

function send(msg: object) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  proc.stdin.flush();
}
const request = (method: string, params: unknown) =>
  new Promise<any>((done, fail) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? fail(new Error(JSON.stringify(m.error))) : done(m.result)));
    send({ id, method, params });
  });
const notify = (method: string, params: unknown) => send({ method, params });

async function waitFor<T>(check: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

const app = join(root, "pages", "Home.xzor");
const counter = join(root, "Counter.xzor");
const appText = await Bun.file(app).text();
const counterText = await Bun.file(counter).text();

function pos(text: string, needle: string, delta = 0) {
  const at = text.indexOf(needle) + delta;
  if (at < delta) throw new Error(`${needle} not found`);
  const before = text.slice(0, at);
  const line = before.split("\n").length - 1;
  return { line, character: at - (before.lastIndexOf("\n") + 1) };
}

let init: any;

beforeAll(async () => {
  const build = Bun.spawnSync(["cargo", "build", "-q"], { cwd: repo, stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("cargo build failed");
  proc = Bun.spawn([exe, "lsp"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  (async () => {
    let buf = Buffer.alloc(0);
    for await (const chunk of proc.stdout) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) break;
        const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString())![1]);
        if (buf.length < sep + 4 + len) break;
        const msg: Msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
        buf = buf.subarray(sep + 4 + len);
        if (msg.id !== undefined && msg.method) {
          if (msg.method === "client/registerCapability") registrations.push(...msg.params.registrations);
          send({ id: msg.id, result: null });
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        } else if (msg.method === "textDocument/publishDiagnostics") {
          diagnostics.set(msg.params.uri, msg.params.diagnostics);
          publishes.set(msg.params.uri, (publishes.get(msg.params.uri) ?? 0) + 1);
        }
      }
    }
  })();
  const dynamic = { dynamicRegistration: true };
  const textDocument = Object.fromEntries(
    ["completion", "hover", "definition", "references", "rename", "semanticTokens"].map((k) => [k, dynamic]),
  );
  init = await request("initialize", { processId: null, rootUri: uriOf(root), capabilities: { textDocument } });
  // Feature providers are registered for `.xzor` only, so they don't apply to the synced `.ts` documents.
  expect(init.capabilities.hoverProvider).toBeUndefined();
  expect(init.capabilities.renameProvider).toBeUndefined();
  notify("initialized", {});
  await waitFor(() => (registrations.length ? true : undefined));
  expect(registrations.map((r) => r.method).sort()).toEqual([
    "textDocument/completion",
    "textDocument/definition",
    "textDocument/hover",
    "textDocument/references",
    "textDocument/rename",
    "textDocument/semanticTokens",
  ]);
  expect(registrations.every((r) => JSON.stringify(r.registerOptions.documentSelector) === '[{"language":"xzor"}]')).toBe(true);
  for (const [path, text] of [[counter, counterText], [app, appText]] as const) {
    notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: "xzor", version: 1, text } });
  }
}, 60000);

afterAll(() => proc?.kill());

test("hover on a template expression comes from TypeScript", async () => {
  const hover = await request("textDocument/hover", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "@count</h2>", 2),
  });
  expect(JSON.stringify(hover.contents)).toContain("number");
  expect(hover.range.start).toEqual(pos(counterText, "@count</h2>", 1));
}, 20000);

test("markup values in @code produce no errors", async () => {
  const diags = await waitFor(() => diagnostics.get(uriOf(app)));
  expect(diags.filter((d) => d.severity === 1)).toEqual([]);
}, 20000);

test("go to definition on a component tag opens the component", async () => {
  const defs = await request("textDocument/definition", {
    textDocument: { uri: uriOf(app) },
    position: pos(appText, "<Counter", 3),
  });
  expect(defs[0].uri).toBe(uriOf(counter));
});

test("go to definition on a prop jumps to its member", async () => {
  const defs = await request("textDocument/definition", {
    textDocument: { uri: uriOf(app) },
    position: pos(appText, 'step="5"', 1),
  });
  expect(defs[0].uri).toBe(uriOf(counter));
  expect(defs[0].range.start).toEqual(pos(counterText, "step: number"));
});

test("go to definition from a template expression maps into @code", async () => {
  const defs = await request("textDocument/definition", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "@count</h2>", 2),
  });
  expect(defs[0].uri).toBe(uriOf(counter));
  expect(defs[0].range.start).toEqual(pos(counterText, "count: number"));
}, 20000);

test("slot names complete inside a component tag and jump to their definition", async () => {
  const text = appText.replace("@slot header", "@slot he");
  notify("textDocument/didChange", { textDocument: { uri: uriOf(app), version: 10 }, contentChanges: [{ text }] });
  const items = await request("textDocument/completion", {
    textDocument: { uri: uriOf(app) },
    position: pos(text, "@slot he", 8),
  });
  expect(items.items.map((i: any) => i.label)).toEqual(["header"]);
  notify("textDocument/didChange", { textDocument: { uri: uriOf(app), version: 11 }, contentChanges: [{ text: appText }] });

  const card = join(root, "Card.xzor");
  const cardText = await Bun.file(card).text();
  const defs = await request("textDocument/definition", {
    textDocument: { uri: uriOf(app) },
    position: pos(appText, "@slot header", 7),
  });
  expect(defs[0].uri).toBe(uriOf(card));
  expect(defs[0].range.start).toEqual(pos(cardText, "@slot:header", 6));
}, 20000);

test("slot parameters are typed from the slot definition", async () => {
  const hover = await request("textDocument/hover", {
    textDocument: { uri: uriOf(app) },
    position: pos(appText, "@slot item(step", 11),
  });
  expect(JSON.stringify(hover.contents)).toContain("step: string");
}, 20000);

test("completion offers components and members", async () => {
  const text = appText.replace("<h1>", "<Cou\n  <h1>");
  notify("textDocument/didChange", { textDocument: { uri: uriOf(app), version: 2 }, contentChanges: [{ text }] });
  const tags = await request("textDocument/completion", {
    textDocument: { uri: uriOf(app) },
    position: pos(text, "<Cou", 4),
  });
  expect(tags.items.map((i: any) => i.label)).toContain("Counter");
  notify("textDocument/didChange", { textDocument: { uri: uriOf(app), version: 3 }, contentChanges: [{ text: appText }] });

  const members = await request("textDocument/completion", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "this.step", 5),
  });
  const labels = (members.items ?? members).map((i: any) => i.label);
  expect(labels).toContain("count");
  expect(labels).toContain("increment");
}, 20000);

test("semantic tokens color template references like their declarations", async () => {
  const legend = registrations.find((r) => r.method === "textDocument/semanticTokens").registerOptions.legend;
  const result = await request("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(counter) } });
  const tokens: { line: number; character: number; type: string }[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < result.data.length; i += 5) {
    const [dl, dc, , type] = result.data.slice(i, i + 5);
    line += dl;
    character = dl === 0 ? character + dc : dc;
    tokens.push({ line, character, type: legend.tokenTypes[type] });
  }
  const typeAt = (p: { line: number; character: number }) =>
    tokens.find((t) => t.line === p.line && t.character === p.character)?.type;

  expect(typeAt(pos(counterText, "increment() {"))).toBe("method");
  expect(typeAt(pos(counterText, '@onclick="increment"', 10))).toBe("method");
  expect(typeAt(pos(counterText, "@count</h2>", 1))).toBe("property");

  // A closing component tag is colored like its opening tag.
  const appTokens = await request("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(app) } });
  const appTypes = new Map<string, string>();
  for (let i = 0, l = 0, c = 0; i < appTokens.data.length; i += 5) {
    const [dl, dc, , type] = appTokens.data.slice(i, i + 5);
    l += dl;
    c = dl === 0 ? c + dc : dc;
    appTypes.set(`${l}:${c}`, legend.tokenTypes[type]);
  }
  const appType = (p: { line: number; character: number }) => appTypes.get(`${p.line}:${p.character}`);
  expect(appType(pos(appText, "<List", 1))).toBe("class");
  expect(appType(pos(appText, "</List>", 2))).toBe("class");
}, 20000);

test("type errors land on the .xzor line", async () => {
  const text = counterText.replace('label: string = "Count";', "label: string = 42;");
  const uri = uriOf(counter);
  diagnostics.delete(uri);
  notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
  const diags = await waitFor(() => {
    const d = diagnostics.get(uri);
    return d?.some((x) => x.severity === 1) ? d : undefined;
  });
  const error = diags.find((d) => d.severity === 1);
  expect(error.range.start.line).toBe(pos(text, "label: string = 42").line);
  expect(error.message).toContain("number");
  notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: counterText }] });
}, 20000);

test("find references maps template uses back to the .xzor", async () => {
  const refs = await request("textDocument/references", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "count: number"),
    context: { includeDeclaration: true },
  });
  const starts = refs.filter((r: any) => r.uri === uriOf(counter)).map((r: any) => r.range.start);
  expect(starts).toContainEqual(pos(counterText, "count: number"));
  expect(starts).toContainEqual(pos(counterText, "@count</h2>", 1));
  expect(refs.every((r: any) => !r.uri.includes(".xzor/"))).toBe(true);
}, 20000);

test("rename edits the declaration and template uses", async () => {
  const edit = await request("textDocument/rename", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "@count</h2>", 2),
    newName: "total",
  });
  const edits = edit.changes[uriOf(counter)];
  const starts = edits.map((e: any) => e.range.start);
  expect(starts).toContainEqual(pos(counterText, "count: number"));
  expect(starts).toContainEqual(pos(counterText, "@count</h2>", 1));
  expect(starts).toContainEqual(pos(counterText, "count >= 10"));
  expect(edits.every((e: any) => e.newText === "total")).toBe(true);
  expect(Object.keys(edit.changes).every((u) => !u.includes(".xzor/"))).toBe(true);
}, 20000);

test("renaming a prop also renames its attributes in other components", async () => {
  const edit = await request("textDocument/rename", {
    textDocument: { uri: uriOf(counter) },
    position: pos(counterText, "step: number"),
    newName: "by",
  });
  const starts = edit.changes[uriOf(app)].map((e: any) => e.range.start);
  expect(starts).toContainEqual(pos(appText, 'step="5"'));
}, 20000);

test("TypeScript features keep working while the template has a syntax error", async () => {
  const text = counterText.replace("<h2>@label: @count</h2>", "<h2>@label: @count</h2>\n  <p");
  const uri = uriOf(counter);
  notify("textDocument/didChange", { textDocument: { uri, version: 20 }, contentChanges: [{ text }] });
  const hover = await request("textDocument/hover", {
    textDocument: { uri },
    position: pos(text, "+@step", 2),
  });
  expect(JSON.stringify(hover.contents)).toContain("number");
  expect(hover.range.start).toEqual(pos(text, "+@step", 2));
  notify("textDocument/didChange", { textDocument: { uri, version: 21 }, contentChanges: [{ text: counterText }] });
}, 20000);

// Same depth below the repo as the fixture, so its tsconfig paths and `typescript` still resolve.
const diRoot = join(repo, "target", "tmp-lsp-di", String(process.pid));
const diCounter = join(diRoot, "Counter.xzor");
const diMain = join(diRoot, "main.ts");
const zdi = (uri: string) => diagnostics.get(uri)?.find((d) => d.code === "ZDI04");

test("@inject of an unprovided type reports ZDI04 on save, and clears when fixed", async () => {
  rmSync(diRoot, { recursive: true, force: true });
  cpSync(join(repo, "tests", "fixtures", "lsp-di"), diRoot, {
    recursive: true,
    filter: (src) => !/[\\/](\.xzor|node_modules)$/.test(src),
  });
  const good = await Bun.file(diCounter).text();
  const bad = good.replace("@inject Database db", "@inject Missing m");
  const uri = uriOf(diCounter);
  const save = () => notify("textDocument/didSave", { textDocument: { uri } });
  await Bun.write(diCounter, bad);
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text: bad } });
  save();
  const error = await waitFor(() => zdi(uri), 30000);
  const start = pos(bad, "@inject Missing", 8);
  expect(error.range).toEqual({ start, end: { line: start.line, character: start.character + "Missing".length } });
  expect(error.severity).toBe(1);
  expect(error.source).toBe("xzor");
  expect(error.message).not.toContain("ZDI04");

  await Bun.write(diCounter, good);
  notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: good }] });
  save();
  await waitFor(() => (diagnostics.get(uri) && !zdi(uri) ? true : undefined), 30000);
}, 60000);

test("a watched provider .ts change reruns the DI analysis", async () => {
  const uri = uriOf(diCounter);
  const main = await Bun.file(diMain).text();
  const changed = () =>
    notify("workspace/didChangeWatchedFiles", {
      changes: [
        { uri: uriOf(join(diRoot, ".xzor", "main.ts")), type: 2 },
        { uri: uriOf(diMain), type: 2 },
      ],
    });
  const unprovided = main.replace(/@Singleton\(Database\)\r?\n/, "");
  expect(unprovided).not.toBe(main);
  await Bun.write(diMain, unprovided);
  changed();
  const error = await waitFor(() => zdi(uri), 30000);
  expect(error.range.start).toEqual(pos(await Bun.file(diCounter).text(), "@inject Database", 8));

  await Bun.write(diMain, main);
  changed();
  await waitFor(() => (!zdi(uri) ? true : undefined), 30000);
  notify("textDocument/didClose", { textDocument: { uri } });
}, 60000);

const code = (uri: string, c: string) => diagnostics.get(uri)?.find((d) => d.code === c);
/** Waits for the next publish to `uri` after `act` and returns its diagnostics. */
async function nextPublish(uri: string, act: () => void) {
  const before = publishes.get(uri) ?? 0;
  act();
  await waitFor(() => ((publishes.get(uri) ?? 0) > before ? true : undefined), 5000);
  return diagnostics.get(uri)!;
}

test("an open provider .ts shows ZDI02 at the parameter without saving, and edits shift or drop it", async () => {
  const uri = uriOf(diMain);
  const main = await Bun.file(diMain).text();
  const ctor = "  constructor(readonly missing: Missing) {}\n";
  const bad = main
    .replace('import { Database } from "./services";', 'import { Database, Missing } from "./services";\n\nexport class Repo {\n' + ctor + "}")
    .replace("@Singleton(Database)", "@Singleton(Database)\n@Singleton(Repo)");
  expect(bad).toContain(ctor);
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: bad } });
  const error = await waitFor(() => code(uri, "ZDI02"), 10000);
  const start = pos(bad, "missing: Missing");
  expect(error.range).toEqual({ start, end: { line: start.line, character: start.character + "missing".length } });
  expect(error.message).toContain("Missing");

  const above = bad.replace("export class Repo {", "// a note\nexport class Repo {");
  const sentAt = performance.now();
  const shifted = await nextPublish(uri, () =>
    notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: above }] }),
  );
  // Well under the 300 ms debounce, so the range was shifted, not reanalyzed.
  expect(performance.now() - sentAt).toBeLessThan(200);
  const moved = shifted.find((d) => d.code === "ZDI02");
  expect(moved.range.start).toEqual({ line: start.line + 1, character: start.character });
  expect(moved.range.end).toEqual({ line: start.line + 1, character: start.character + "missing".length });

  const fixed = above.replace(ctor, "");
  const dropped = await nextPublish(uri, () =>
    notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: fixed }] }),
  );
  expect(dropped.find((d) => d.code === "ZDI02")).toBeUndefined();
  await Bun.sleep(1500);
  expect(code(uri, "ZDI02")).toBeUndefined();
}, 30000);

test("an unsaved @inject edit in a .xzor shows ZDI04", async () => {
  const uri = uriOf(diCounter);
  const good = await Bun.file(diCounter).text();
  const bad = good.replace("@inject Database db", "@inject Missing m");
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text: good } });
  notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: bad }] });
  const error = await waitFor(() => zdi(uri), 10000);
  expect(error.range.start).toEqual(pos(bad, "@inject Missing", 8));
  expect(await Bun.file(diCounter).text()).toBe(good);
  notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: good }] });
  await waitFor(() => (!zdi(uri) ? true : undefined), 10000);
}, 30000);

test("feature requests on a .ts document return nothing", async () => {
  const uri = uriOf(diMain);
  const text = await Bun.file(diMain).text();
  const position = pos(text, "Database");
  expect(await request("textDocument/hover", { textDocument: { uri }, position })).toBeNull();
  const items = await request("textDocument/completion", { textDocument: { uri }, position });
  expect(items === null || (items.items ?? items).length === 0).toBe(true);
  expect(await request("textDocument/definition", { textDocument: { uri }, position })).toBeNull();
  const tokens = await request("textDocument/semanticTokens/full", { textDocument: { uri } });
  expect(tokens === null || tokens.data.length === 0).toBe(true);
  notify("textDocument/didClose", { textDocument: { uri } });
  notify("textDocument/didClose", { textDocument: { uri: uriOf(diCounter) } });
  rmSync(diRoot, { recursive: true, force: true });
}, 30000);

test("an open .xzor refreshes when a base .ts anywhere in its @inherits chain changes, without saving", async () => {
  const dir = join(repo, "target", "tmp-lsp-inherits", String(process.pid));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(repo, "tests", "fixtures", "lsp-di", "tsconfig.json"), join(dir, "tsconfig.json"));
  const base = (name: string) =>
    `import { ComponentBase } from "@source-crafter/xzor-runtime";\nexport abstract class Titled extends ComponentBase { ${name} = "t"; }\n`;
  // D -> Mid (mid.ts) -> Titled (base.ts): D's text never mentions base.
  const mid = `import { Titled } from "./base";\nexport abstract class Mid extends Titled {}\n`;
  const text = `@import { Mid } from "./mid"\n@inherits Mid\n<p>@title</p>\n`;
  const [basePath, midPath, comp] = [join(dir, "base.ts"), join(dir, "mid.ts"), join(dir, "D.xzor")];
  await Bun.write(basePath, base("title"));
  await Bun.write(midPath, mid);
  await Bun.write(comp, text);
  const [baseUri, uri] = [uriOf(basePath), uriOf(comp)];
  notify("textDocument/didOpen", { textDocument: { uri: baseUri, languageId: "typescript", version: 1, text: base("title") } });
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text } });
  const ok = await waitFor(() => diagnostics.get(uri), 20000);
  expect(ok.filter((d) => d.severity === 1)).toEqual([]);
  notify("textDocument/didChange", { textDocument: { uri: baseUri, version: 2 }, contentChanges: [{ text: base("heading") }] });
  const error = await waitFor(() => diagnostics.get(uri)?.find((d) => d.severity === 1), 20000);
  expect(error.message).toContain("title");
  expect(error.range.start).toEqual(pos(text, "title</p>"));
  expect(await Bun.file(basePath).text()).toBe(base("title"));
  notify("textDocument/didClose", { textDocument: { uri } });
  notify("textDocument/didClose", { textDocument: { uri: baseUri } });
  rmSync(dir, { recursive: true, force: true });
}, 60000);

test("an @inherits base that can't be read shows a warning on the base name", async () => {
  const dir = join(repo, "target", "tmp-lsp-inherits", `warn-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(repo, "tests", "fixtures", "lsp-di", "tsconfig.json"), join(dir, "tsconfig.json"));
  const text = `@import { Base } from "pkg-missing"\n@inherits Base\n<p/>\n`;
  const comp = join(dir, "W.xzor");
  await Bun.write(comp, text);
  const uri = uriOf(comp);
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text } });
  const warning = await waitFor(() => diagnostics.get(uri)?.find((d) => d.severity === 2), 20000);
  expect(warning.source).toBe("xzor");
  expect(warning.message).toBe("could not read base class 'Base'; use this.<member> for its members");
  const start = pos(text, "Base\n<p/>");
  expect(warning.range).toEqual({ start, end: { line: start.line, character: start.character + "Base".length } });
  notify("textDocument/didClose", { textDocument: { uri } });
  rmSync(dir, { recursive: true, force: true });
}, 60000);

/** A project with the fixture's tsconfig, at the same depth below the repo so its paths resolve. */
function project(name: string): string {
  const dir = join(repo, "target", "tmp-lsp-routes", `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(repo, "tests", "fixtures", "lsp-di", "tsconfig.json"), join(dir, "tsconfig.json"));
  return dir;
}

test("a link built with href is typed from the route table of the open documents", async () => {
  const dir = project("href");
  const page = `@page "/users/:id"\n\n@code {\n  id = 0;\n}\n\n<p>@id</p>\n`;
  const bad = `@import { href } from "./routes"\n\n<a href="@href.UserPage({ id: "x" })">user</a>\n`;
  const good = bad.replace('{ id: "x" }', "{ id: 2 }");
  const [pagePath, appPath] = [join(dir, "UserPage.xzor"), join(dir, "App.xzor")];
  await Bun.write(pagePath, page);
  await Bun.write(appPath, bad);
  const uri = uriOf(appPath);
  notify("textDocument/didOpen", { textDocument: { uri: uriOf(pagePath), languageId: "xzor", version: 1, text: page } });
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text: bad } });

  const error = await waitFor(() => diagnostics.get(uri)?.find((d) => d.severity === 1), 30000);
  expect(error.message).toContain("number");
  expect(error.range.start.line).toBe(pos(bad, "href.UserPage").line);
  notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: good }] });
  await waitFor(() => (diagnostics.get(uri)?.every((d: any) => d.severity !== 1) ? true : undefined), 30000);

  notify("textDocument/didClose", { textDocument: { uri } });
  notify("textDocument/didClose", { textDocument: { uri: uriOf(pagePath) } });
  rmSync(dir, { recursive: true, force: true });
}, 90000);

test("hover on an @inject of a contract shows Remote<...> once the analysis knows the contract", async () => {
  const dir = project("contract");
  const runtime = join(repo, "runtime").replaceAll("\\", "/");
  const compilerOptions = {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM", "ESNext.Disposable"], strict: true, noEmit: true, skipLibCheck: true,
    rootDirs: [".", ".xzor"],
    paths: { "@source-crafter/xzor-runtime": [`${runtime}/index.ts`], "@source-crafter/xzor-runtime/server": [`${runtime}/server.ts`] },
  };
  const view = `@import { type IPosts } from "./contract"\n@inject IPosts posts\n\n<p>x</p>\n`;
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions, include: ["**/*.ts", ".xzor/**/*.ts"] }),
    "contract.ts": "export interface IPosts {\n  get(slug: string): string | undefined;\n}\n",
    "api/posts.ts": `import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";\nimport type { IPosts } from "../contract";\n\n@Endpoints("/api/posts")\nexport class Posts implements IPosts {\n  @Get(":slug")\n  get(slug: string) { return slug; }\n}\n`,
    "app.ts": `import { Run } from "@source-crafter/xzor-runtime";\nimport type { IServerApplication } from "@source-crafter/xzor-runtime/server";\nimport Shell from "./Shell.xzor";\n\n@Run(Shell)\nexport class App implements IServerApplication {\n  port = 0;\n}\n`,
    "Shell.xzor": view,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    await Bun.write(join(dir, file), text);
  }
  const uri = uriOf(join(dir, "Shell.xzor"));
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text: view } });
  const hovered = async () => {
    const hover = await request("textDocument/hover", { textDocument: { uri }, position: pos(view, "posts\n", 1) });
    return hover ? JSON.stringify(hover.contents) : "";
  };
  let text = "";
  // The first compile has no contracts; polling lets the analysis land and the document refresh.
  const end = Date.now() + 60000;
  while (!text.includes("Remote<IPosts>") && Date.now() < end) {
    text = await hovered();
    if (!text.includes("Remote<IPosts>")) await Bun.sleep(300);
  }
  expect(text).toContain("Remote<IPosts>");
  notify("textDocument/didClose", { textDocument: { uri } });
  rmSync(dir, { recursive: true, force: true });
}, 120000);

test("a saved DI run types the generated file of a closed view that injects a contract", async () => {
  const dir = project("contract-closed");
  const runtime = join(repo, "runtime").replaceAll("\\", "/");
  const compilerOptions = {
    target: "ES2022", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM", "ESNext.Disposable"], strict: true, noEmit: true, skipLibCheck: true,
    rootDirs: [".", ".xzor"],
    paths: { "@source-crafter/xzor-runtime": [`${runtime}/index.ts`], "@source-crafter/xzor-runtime/server": [`${runtime}/server.ts`] },
  };
  const view = `@import { type IPosts } from "./contract"\n@inject IPosts posts\n\n<p>x</p>\n`;
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions, include: ["**/*.ts", ".xzor/**/*.ts"] }),
    "contract.ts": "export interface IPosts {\n  get(slug: string): string | undefined;\n}\n",
    "api/posts.ts": `import { Endpoints, Get } from "@source-crafter/xzor-runtime/server";\nimport type { IPosts } from "../contract";\n\n@Endpoints("/api/posts")\nexport class Posts implements IPosts {\n  @Get(":slug")\n  get(slug: string) { return slug; }\n}\n`,
    "app.ts": `import { Run } from "@source-crafter/xzor-runtime";\nimport type { IServerApplication } from "@source-crafter/xzor-runtime/server";\nimport Shell from "./Shell.xzor";\n\n@Run(Shell)\nexport class App implements IServerApplication {\n  port = 0;\n}\n`,
    "Shell.xzor": "<p>shell</p>\n",
    "Closed.xzor": view,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    await Bun.write(join(dir, file), text);
  }
  const shell = uriOf(join(dir, "Shell.xzor"));
  notify("textDocument/didOpen", { textDocument: { uri: shell, languageId: "xzor", version: 1, text: files["Shell.xzor"] } });
  notify("textDocument/didSave", { textDocument: { uri: shell } });
  const out = join(dir, ".xzor", "Closed.xzor.ts");
  // The first run compiles without contracts and the analysis then retypes the closed view's file on disk.
  const typed = async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()).includes("Remote<IPosts>");
  for (const end = Date.now() + 60000; !(await typed()) && Date.now() < end; ) await Bun.sleep(300);
  expect(await Bun.file(out).text()).toContain("Remote<IPosts>");
  notify("textDocument/didClose", { textDocument: { uri: shell } });
  rmSync(dir, { recursive: true, force: true });
}, 120000);

test("a route pattern duplicated by another open document is reported on the pattern", async () => {
  const dir = project("dup");
  const a = `@page "/dup"\n<p>a</p>\n`;
  const b = `@page "/dup"\n<p>b</p>\n`;
  const [aPath, bPath] = [join(dir, "A.xzor"), join(dir, "B.xzor")];
  await Bun.write(aPath, a);
  await Bun.write(bPath, b);
  const uri = uriOf(bPath);
  notify("textDocument/didOpen", { textDocument: { uri: uriOf(aPath), languageId: "xzor", version: 1, text: a } });
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text: b } });

  const dup = (u: string) => diagnostics.get(u)?.find((d) => d.message.startsWith("duplicate route pattern"));
  const error = await waitFor(() => dup(uri), 30000);
  expect(error.message).toBe('duplicate route pattern "/dup" (also in A.xzor)');
  expect(error.source).toBe("xzor");
  expect(error.severity).toBe(1);
  const start = pos(b, "/dup");
  expect(error.range).toEqual({ start, end: { line: start.line, character: start.character + "/dup".length } });
  // The first page keeps the pattern, so only the second document is at fault.
  expect(dup(uriOf(aPath))).toBeUndefined();

  notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: b.replace("/dup", "/other") }],
  });
  await waitFor(() => (dup(uri) ? undefined : true), 30000);

  notify("textDocument/didClose", { textDocument: { uri } });
  notify("textDocument/didClose", { textDocument: { uri: uriOf(aPath) } });
  rmSync(dir, { recursive: true, force: true });
}, 90000);

test("kit components, prop values, ids and classes complete through tsconfig paths", async () => {
  const path = join(repo, "examples", "dashboard", "pages", "LspProbe.xzor");
  const uri = uriOf(path);
  const text = `<Butt\n<Button tone="\n<Button opens="\n<div class="xz-gl\n<dialog id="edit"></dialog>\n`;
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "xzor", version: 1, text } });
  const labels = async (needle: string) => {
    const r = await request("textDocument/completion", { textDocument: { uri }, position: pos(text, needle, needle.length) });
    return r.items as any[];
  };

  const tag = (await labels("<Butt")).find((i) => i.label === "Button");
  expect(tag.additionalTextEdits[0].newText).toBe('@import Button from "@source-crafter/xzor-ui/Button.xzor"\n');
  expect((await labels('<Button tone="')).map((i) => i.label)).toEqual(expect.arrayContaining(["neutral", "accent", "danger"]));
  expect((await labels('<Button opens="')).map((i) => i.label)).toEqual(["edit"]);
  expect((await labels('<div class="xz-gl')).map((i) => i.label)).toContain("xz-glass");

  const hover = await request("textDocument/hover", { textDocument: { uri }, position: pos(text, 'opens="', 1) });
  expect(hover.contents.value).toContain("Id of a `Sheet` or `Dialog` this button opens.");
  notify("textDocument/didClose", { textDocument: { uri } });
}, 30000);