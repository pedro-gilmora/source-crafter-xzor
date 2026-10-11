// End-to-end: drives `zor lsp` over stdio against examples/counter, like an editor would.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const root = join(repo, "examples", "counter");
const exe = join(repo, "target", "debug", process.platform === "win32" ? "zor.exe" : "zor");

const uriOf = (p: string) =>
  process.platform === "win32"
    ? `file:///${p[0]!.toLowerCase()}%3A${p.slice(2).replaceAll("\\", "/").replaceAll(" ", "%20")}`
    : `file://${p.replaceAll(" ", "%20")}`;

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any };
let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>;
let nextId = 0;
const pending = new Map<number, (m: Msg) => void>();
const diagnostics = new Map<string, any[]>();

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

const app = join(root, "App.tszor");
const counter = join(root, "Counter.tszor");
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
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        } else if (msg.method === "textDocument/publishDiagnostics") {
          diagnostics.set(msg.params.uri, msg.params.diagnostics);
        }
      }
    }
  })();
  init = await request("initialize", { processId: null, rootUri: uriOf(root), capabilities: {} });
  expect(init.capabilities.hoverProvider).toBe(true);
  notify("initialized", {});
  for (const [path, text] of [[counter, counterText], [app, appText]] as const) {
    notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: "tszor", version: 1, text } });
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
  const legend = init.capabilities.semanticTokensProvider.legend;
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
}, 20000);

test("type errors land on the .tszor line", async () => {
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
