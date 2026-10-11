//! `zor lsp`: answers component questions itself and proxies TypeScript regions to
//! TypeScript 7's native server, mapping positions through codegen's source maps.

use super::features::{self, Context, Symbol};
use super::{offset_at, path_to_uri, position_at, read_message, same_path, uri_to_path, write_message};
use crate::build::{compile_all, find_sources, output_path, project_root};
use crate::codegen::Generated;
use crate::json::Json;
use std::collections::HashMap;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};

enum Event {
    Client(Json),
    Ts(Json),
    ClientClosed,
    TsClosed,
}

#[derive(Clone, Copy)]
enum Kind {
    Completion { add_keywords: bool },
    Resolve,
    Hover,
    Definition,
    SemanticTokens,
}

enum Pending {
    /// Holds the client's `initialize` id until TypeScript reports its capabilities.
    Init { client_id: Option<Json> },
    Forward { client_id: Json, uri: String, kind: Kind },
    Diagnostics { uri: String, version: i64 },
    Ignore,
}

struct Doc {
    text: String,
    path: PathBuf,
    gen_uri: String,
    generated: Option<Generated>,
    version: i64,
    ts_open: bool,
    error: Option<crate::Diagnostic>,
}

struct Ts {
    stdin: ChildStdin,
    child: Child,
    ready: bool,
    queue: Vec<String>,
}

struct Server {
    tx: Sender<Event>,
    ts: Option<Ts>,
    next_id: i64,
    pending: HashMap<i64, Pending>,
    docs: HashMap<String, Doc>,
}

pub fn run() -> io::Result<()> {
    let (tx, rx) = mpsc::channel();
    let client_tx = tx.clone();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        loop {
            match read_message(&mut reader) {
                Ok(Some(body)) => {
                    if let Ok(msg) = Json::parse(&body)
                        && client_tx.send(Event::Client(msg)).is_err()
                    {
                        break;
                    }
                }
                _ => {
                    let _ = client_tx.send(Event::ClientClosed);
                    break;
                }
            }
        }
    });
    let mut server = Server { tx, ts: None, next_id: 0, pending: HashMap::new(), docs: HashMap::new() };
    for event in rx {
        match event {
            Event::Client(msg) => {
                if !server.client(msg)? {
                    break;
                }
            }
            Event::Ts(msg) => server.ts_message(msg)?,
            Event::TsClosed => {
                server.ts = None;
                for (_, pending) in std::mem::take(&mut server.pending) {
                    match pending {
                        Pending::Init { client_id: Some(id) } => server.respond(id, capabilities(None))?,
                        Pending::Forward { client_id, .. } => server.respond(client_id, Json::Null)?,
                        _ => {}
                    }
                }
            }
            Event::ClientClosed => break,
        }
    }
    if let Some(mut ts) = server.ts.take() {
        let _ = ts.child.kill();
    }
    Ok(())
}

/// TypeScript 7's native executable, found in `node_modules` above `root`; `ZOR_TSGO` overrides.
fn find_tsgo(root: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ZOR_TSGO") {
        return Some(PathBuf::from(p));
    }
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let exe = if cfg!(windows) { "tsc.exe" } else { "tsc" };
    root.ancestors()
        .map(|d| d.join("node_modules/@typescript").join(format!("typescript-{os}-{arch}")).join("lib").join(exe))
        .find(|p| p.is_file())
}

fn src_to_gen(g: &Generated, off: usize) -> Option<usize> {
    g.mappings.iter().find(|m| m.src <= off && off <= m.src + m.len).map(|m| m.out + off - m.src)
}

fn gen_to_src(g: &Generated, off: usize) -> Option<usize> {
    g.mappings.iter().find(|m| m.out <= off && off <= m.out + m.len).map(|m| m.src + off - m.out)
}

fn pos_json(text: &str, off: usize) -> Json {
    let (line, character) = position_at(text, off);
    Json::obj([("line", line.into()), ("character", character.into())])
}

fn range_json(text: &str, start: usize, end: usize) -> Json {
    Json::obj([("start", pos_json(text, start)), ("end", pos_json(text, end))])
}

fn offset_of(text: &str, pos: &Json) -> usize {
    offset_at(text, pos["line"].as_usize().unwrap_or(0), pos["character"].as_usize().unwrap_or(0))
}

/// Maps a range in generated code back to the `.tszor` source.
fn map_range(g: &Generated, gen_text: &str, src_text: &str, range: &Json) -> Option<Json> {
    let start = gen_to_src(g, offset_of(gen_text, &range["start"]))?;
    let end = gen_to_src(g, offset_of(gen_text, &range["end"])).filter(|e| *e >= start).unwrap_or(start);
    Some(range_json(src_text, start, end))
}

impl Server {
    fn send(&self, msg: &Json) -> io::Result<()> {
        write_message(&mut io::stdout().lock(), &msg.to_string())
    }

    fn respond(&self, id: Json, result: Json) -> io::Result<()> {
        self.send(&Json::obj([("jsonrpc", "2.0".into()), ("id", id), ("result", result)]))
    }

    fn notify(&self, method: &str, params: Json) -> io::Result<()> {
        self.send(&Json::obj([("jsonrpc", "2.0".into()), ("method", method.into()), ("params", params)]))
    }

    fn ts_write(&mut self, msg: Json, force: bool) {
        let Some(ts) = self.ts.as_mut() else { return };
        let body = msg.to_string();
        if ts.ready || force {
            if write_message(&mut ts.stdin, &body).is_err() {
                self.ts = None;
            }
        } else {
            ts.queue.push(body);
        }
    }

    fn ts_notify(&mut self, method: &str, params: Json) {
        self.ts_write(Json::obj([("jsonrpc", "2.0".into()), ("method", method.into()), ("params", params)]), false);
    }

    fn ts_request(&mut self, method: &str, params: Json, pending: Pending) -> bool {
        if self.ts.is_none() {
            return false;
        }
        self.next_id += 1;
        let id = self.next_id;
        let force = matches!(pending, Pending::Init { .. });
        self.pending.insert(id, pending);
        let msg = Json::obj([("jsonrpc", "2.0".into()), ("id", (id as usize).into()), ("method", method.into()), ("params", params)]);
        self.ts_write(msg, force);
        true
    }

    fn start_ts(&mut self, root: &Path, client_id: Json) -> io::Result<()> {
        let Some(exe) = find_tsgo(root) else {
            self.notify(
                "window/logMessage",
                Json::obj([("type", 2usize.into()), ("message", "zor: TypeScript 7 not found; TypeScript features are off".into())]),
            )?;
            return self.respond(client_id, capabilities(None));
        };
        let Ok(mut child) = Command::new(&exe)
            .args(["--lsp", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return self.respond(client_id, capabilities(None));
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = child.stdin.take().expect("piped stdin");
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(body)) = read_message(&mut reader) {
                if let Ok(msg) = Json::parse(&body)
                    && tx.send(Event::Ts(msg)).is_err()
                {
                    return;
                }
            }
            let _ = tx.send(Event::TsClosed);
        });
        self.ts = Some(Ts { stdin, child, ready: false, queue: Vec::new() });
        let root_uri = path_to_uri(root);
        let params = Json::parse(&format!(
            r#"{{"processId":null,"rootUri":{u},"workspaceFolders":[{{"uri":{u},"name":"root"}}],
            "capabilities":{{"textDocument":{{"diagnostic":{{}},"definition":{{"linkSupport":false}},
            "hover":{{"contentFormat":["markdown","plaintext"]}},
            "semanticTokens":{{"requests":{{"full":true}},"formats":["relative"],"tokenTypes":{types},"tokenModifiers":{mods}}},
            "completion":{{"completionItem":{{"snippetSupport":true,"resolveSupport":{{"properties":["documentation","detail"]}}}}}}}}}}}}"#,
            u = Json::from(root_uri),
            types = r#"["namespace","class","enum","interface","typeParameter","type","parameter","variable","property","enumMember","function","method","keyword","string","number","regexp","operator","decorator"]"#,
            mods = r#"["declaration","static","async","readonly","defaultLibrary","local","deprecated"]"#
        ))
        .expect("valid initialize params");
        self.ts_request("initialize", params, Pending::Init { client_id: Some(client_id) });
        Ok(())
    }

    /// Handles one client message; `false` means exit.
    fn client(&mut self, msg: Json) -> io::Result<bool> {
        let method = msg["method"].as_str().unwrap_or_default().to_string();
        let params = msg["params"].clone();
        match msg.get("id").cloned() {
            Some(id) if !method.is_empty() => self.request(&method, id, &params)?,
            Some(_) => {}
            None => return self.notification(&method, &params),
        }
        Ok(true)
    }

    fn request(&mut self, method: &str, id: Json, params: &Json) -> io::Result<()> {
        match method {
            "initialize" => {
                let root_uri = params["rootUri"].as_str().or(params["workspaceFolders"][0]["uri"].as_str());
                match root_uri.and_then(uri_to_path) {
                    Some(root) => {
                        let _ = compile_all(&root);
                        self.start_ts(&root, id)
                    }
                    None => self.respond(id, capabilities(None)),
                }
            }
            "shutdown" => {
                self.ts_request("shutdown", Json::Null, Pending::Ignore);
                self.respond(id, Json::Null)
            }
            "textDocument/completion" => self.completion(id, params),
            "completionItem/resolve" => {
                if self.ts_request(method, params.clone(), Pending::Forward { client_id: id.clone(), uri: String::new(), kind: Kind::Resolve }) {
                    Ok(())
                } else {
                    self.respond(id, params.clone())
                }
            }
            "textDocument/hover" => self.hover(id, params),
            "textDocument/definition" => self.definition(id, params),
            "textDocument/semanticTokens/full" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
                let gen_uri = self.docs.get(&uri).filter(|d| d.generated.is_some()).map(|d| d.gen_uri.clone());
                let empty = Json::obj([("data", Json::Arr(vec![]))]);
                match gen_uri {
                    Some(gen_uri) => {
                        let params = Json::obj([("textDocument", Json::obj([("uri", gen_uri.into())]))]);
                        let pending = Pending::Forward { client_id: id.clone(), uri, kind: Kind::SemanticTokens };
                        if self.ts_request(method, params, pending) { Ok(()) } else { self.respond(id, empty) }
                    }
                    None => self.respond(id, empty),
                }
            }
            _ => self.send(&Json::obj([
                ("jsonrpc", "2.0".into()),
                ("id", id),
                ("error", Json::obj([("code", (-32601i64).into()), ("message", format!("unsupported: {method}").into())])),
            ])),
        }
    }

    fn notification(&mut self, method: &str, params: &Json) -> io::Result<bool> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        match method {
            "exit" => return Ok(false),
            "textDocument/didOpen" => {
                let Some(path) = uri_to_path(&uri) else { return Ok(true) };
                let text = params["textDocument"]["text"].as_str().unwrap_or_default().to_string();
                let gen_uri = path_to_uri(&output_path(&path));
                self.docs.insert(uri.clone(), Doc { text, path, gen_uri, generated: None, version: 0, ts_open: false, error: None });
                self.refresh(&uri)?;
            }
            "textDocument/didChange" => {
                let changes = params["contentChanges"].as_array().cloned().unwrap_or_default();
                if let (Some(doc), Some(text)) = (self.docs.get_mut(&uri), changes.last().and_then(|c| c["text"].as_str())) {
                    doc.text = text.to_string();
                    self.refresh(&uri)?;
                }
            }
            "textDocument/didSave" => {
                if let Some(doc) = self.docs.get(&uri) {
                    let _ = compile_all(&doc.path);
                }
            }
            "textDocument/didClose" => {
                if let Some(doc) = self.docs.remove(&uri) {
                    if doc.ts_open {
                        self.ts_notify("textDocument/didClose", Json::obj([("textDocument", Json::obj([("uri", doc.gen_uri.into())]))]));
                    }
                    self.notify("textDocument/publishDiagnostics", Json::obj([("uri", uri.into()), ("diagnostics", Json::Arr(vec![]))]))?;
                }
            }
            _ => {}
        }
        Ok(true)
    }

    /// Recompiles a document, syncs the generated code to TypeScript and requests diagnostics.
    fn refresh(&mut self, uri: &str) -> io::Result<()> {
        let Some(doc) = self.docs.get_mut(uri) else { return Ok(()) };
        match crate::compile_mapped(&doc.text, &doc.path) {
            Ok(g) => {
                doc.error = None;
                doc.version += 1;
                let (gen_uri, version, code, was_open) = (doc.gen_uri.clone(), doc.version, g.code.clone(), doc.ts_open);
                doc.generated = Some(g);
                doc.ts_open = self.ts.is_some();
                if was_open {
                    self.ts_notify(
                        "textDocument/didChange",
                        Json::obj([
                            ("textDocument", Json::obj([("uri", gen_uri.clone().into()), ("version", (version as usize).into())])),
                            ("contentChanges", Json::Arr(vec![Json::obj([("text", code.into())])])),
                        ]),
                    );
                } else {
                    self.ts_notify(
                        "textDocument/didOpen",
                        Json::obj([(
                            "textDocument",
                            Json::obj([
                                ("uri", gen_uri.clone().into()),
                                ("languageId", "typescript".into()),
                                ("version", (version as usize).into()),
                                ("text", code.into()),
                            ]),
                        )]),
                    );
                }
                let params = Json::obj([("textDocument", Json::obj([("uri", gen_uri.into())]))]);
                if !self.ts_request("textDocument/diagnostic", params, Pending::Diagnostics { uri: uri.to_string(), version }) {
                    self.publish(uri, Vec::new())?;
                }
            }
            Err(d) => {
                doc.error = Some(d);
                doc.generated = None;
                self.publish(uri, Vec::new())?;
            }
        }
        Ok(())
    }

    fn publish(&self, uri: &str, ts_diagnostics: Vec<Json>) -> io::Result<()> {
        let Some(doc) = self.docs.get(uri) else { return Ok(()) };
        let mut all = Vec::new();
        if let Some(e) = &doc.error {
            let end = (e.offset + 1).min(doc.text.len());
            all.push(Json::obj([
                ("range", range_json(&doc.text, e.offset, end)),
                ("severity", 1usize.into()),
                ("source", "zor".into()),
                ("message", e.message.clone().into()),
            ]));
        }
        all.extend(ts_diagnostics);
        self.notify("textDocument/publishDiagnostics", Json::obj([("uri", uri.into()), ("diagnostics", Json::Arr(all))]))
    }

    /// Components defined in the project that contains `doc_path`.
    fn components(&self, doc_path: &Path) -> Vec<features::Component> {
        let root = project_root(doc_path);
        find_sources(&root)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| {
                let text = self.text_of(&p)?;
                Some(features::component_from_source(&p, &text))
            })
            .collect()
    }

    fn text_of(&self, path: &Path) -> Option<String> {
        self.docs
            .values()
            .find(|d| same_path(&d.path, path))
            .map(|d| d.text.clone())
            .or_else(|| std::fs::read_to_string(path).ok())
    }

    fn forward(&mut self, method: &str, id: Json, uri: &str, gen_off: usize, kind: Kind, mut params: Json) -> io::Result<()> {
        let doc = &self.docs[uri];
        let g = doc.generated.as_ref().expect("forward requires generated code");
        params.set("textDocument", Json::obj([("uri", doc.gen_uri.clone().into())]));
        params.set("position", pos_json(&g.code, gen_off));
        let pending = Pending::Forward { client_id: id.clone(), uri: uri.to_string(), kind };
        if self.ts_request(method, params, pending) { Ok(()) } else { self.respond(id, Json::Null) }
    }

    fn completion(&mut self, id: Json, params: &Json) -> io::Result<()> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        let Some(doc) = self.docs.get(&uri) else { return self.respond(id, Json::Null) };
        let off = offset_of(&doc.text, &params["position"]);
        let ctx = features::context(&doc.text, off);
        let mapped = doc.generated.as_ref().and_then(|g| src_to_gen(g, off));
        match (&ctx, mapped) {
            (Context::Tag { .. } | Context::Attr { .. }, _) | (_, None) => {
                let items = self.local_completions(&uri, off);
                self.respond(id, Json::obj([("isIncomplete", false.into()), ("items", Json::Arr(items))]))
            }
            (_, Some(gen_off)) => {
                let add_keywords = matches!(ctx, Context::Directive { .. });
                self.forward("textDocument/completion", id, &uri, gen_off, Kind::Completion { add_keywords }, params.clone())
            }
        }
    }

    fn local_completions(&self, uri: &str, off: usize) -> Vec<Json> {
        let doc = &self.docs[uri];
        let start = match features::context(&doc.text, off) {
            Context::Tag { start, .. } | Context::Attr { start, .. } | Context::Directive { start, .. } => start,
            Context::Other => off,
        };
        let comps = self.components(&doc.path);
        features::completions(&doc.text, off, &doc.path, &comps)
            .into_iter()
            .map(|c| {
                let mut item = Json::obj([
                    ("label", c.label.into()),
                    ("kind", (c.kind as usize).into()),
                    ("detail", c.detail.into()),
                    ("insertTextFormat", (if c.snippet { 2usize } else { 1 }).into()),
                    ("textEdit", Json::obj([("range", range_json(&doc.text, start, off)), ("newText", c.insert.into())])),
                ]);
                if let Some((at, text)) = c.extra_edit {
                    item.set(
                        "additionalTextEdits",
                        Json::Arr(vec![Json::obj([("range", range_json(&doc.text, at, at)), ("newText", text.into())])]),
                    );
                }
                item
            })
            .collect()
    }

    fn hover(&mut self, id: Json, params: &Json) -> io::Result<()> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        let Some(doc) = self.docs.get(&uri) else { return self.respond(id, Json::Null) };
        let off = offset_of(&doc.text, &params["position"]);
        if let Some((symbol, start, end)) = features::symbol_at(&doc.text, off) {
            let comps = self.components(&doc.path);
            let value = match &symbol {
                Symbol::Component(name) => comps
                    .iter()
                    .find(|c| &c.name == name)
                    .map(|c| format!("```ts\n(component) {name}\n```\n{}", c.path.display())),
                Symbol::Prop { component, name } => comps
                    .iter()
                    .find(|c| &c.name == component)
                    .and_then(|c| c.props.iter().find(|p| &p.name == name))
                    .map(|p| format!("```ts\n(prop) {component}.{}\n```", p.decl)),
            };
            if let Some(value) = value {
                let contents = Json::obj([("kind", "markdown".into()), ("value", value.into())]);
                let range = range_json(&doc.text, start, end);
                return self.respond(id, Json::obj([("contents", contents), ("range", range)]));
            }
        }
        match doc.generated.as_ref().and_then(|g| src_to_gen(g, off)) {
            Some(gen_off) => self.forward("textDocument/hover", id, &uri, gen_off, Kind::Hover, params.clone()),
            None => self.respond(id, Json::Null),
        }
    }

    fn definition(&mut self, id: Json, params: &Json) -> io::Result<()> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        let Some(doc) = self.docs.get(&uri) else { return self.respond(id, Json::Null) };
        let off = offset_of(&doc.text, &params["position"]);
        if let Some((symbol, _, _)) = features::symbol_at(&doc.text, off) {
            let comps = self.components(&doc.path);
            let target = match &symbol {
                Symbol::Component(name) => comps.iter().find(|c| &c.name == name).map(|c| (c.path.clone(), 0, 0)),
                Symbol::Prop { component, name } => comps.iter().find(|c| &c.name == component).and_then(|c| {
                    let p = c.props.iter().find(|p| &p.name == name)?;
                    Some((c.path.clone(), p.offset, p.offset + p.name.len()))
                }),
            };
            if let Some((path, start, end)) = target {
                let text = self.text_of(&path).unwrap_or_default();
                let loc = Json::obj([("uri", path_to_uri(&path).into()), ("range", range_json(&text, start, end))]);
                return self.respond(id, Json::Arr(vec![loc]));
            }
        }
        match doc.generated.as_ref().and_then(|g| src_to_gen(g, off)) {
            Some(gen_off) => self.forward("textDocument/definition", id, &uri, gen_off, Kind::Definition, params.clone()),
            None => self.respond(id, Json::Null),
        }
    }

    /// Source text and mappings for a generated `.zor/…​.tszor.ts` path.
    fn source_of_generated(&self, gen_path: &Path) -> Option<(PathBuf, String, Generated)> {
        let zor_dir = gen_path.ancestors().find(|a| a.file_name().is_some_and(|n| n == ".zor"))?;
        let rel = gen_path.strip_prefix(zor_dir).ok()?;
        let rel = rel.to_string_lossy();
        let source = zor_dir.parent()?.join(rel.strip_suffix(".ts")?);
        if let Some(doc) = self.docs.values().find(|d| same_path(&d.path, &source)) {
            return Some((source, doc.text.clone(), doc.generated.clone()?));
        }
        let text = std::fs::read_to_string(&source).ok()?;
        let g = crate::compile_mapped(&text, &source).ok()?;
        Some((source, text, g))
    }

    fn map_location(&self, loc: &Json) -> Json {
        let Some(path) = loc["uri"].as_str().and_then(uri_to_path) else { return loc.clone() };
        let Some((source, text, g)) = self.source_of_generated(&path) else { return loc.clone() };
        let range = map_range(&g, &g.code, &text, &loc["range"]).unwrap_or_else(|| range_json(&text, 0, 0));
        Json::obj([("uri", path_to_uri(&source).into()), ("range", range)])
    }

    fn ts_message(&mut self, msg: Json) -> io::Result<()> {
        let id = msg["id"].as_f64().map(|n| n as i64);
        if let Some(method) = msg["method"].as_str() {
            if let Some(id) = msg.get("id").cloned() {
                let result = if method == "workspace/configuration" {
                    let n = msg["params"]["items"].as_array().map_or(0, Vec::len);
                    Json::Arr(vec![Json::Null; n])
                } else {
                    Json::Null
                };
                self.ts_write(Json::obj([("jsonrpc", "2.0".into()), ("id", id), ("result", result)]), true);
            }
            return Ok(());
        }
        let Some(pending) = id.and_then(|id| self.pending.remove(&id)) else { return Ok(()) };
        let result = msg["result"].clone();
        match pending {
            Pending::Init { client_id } => {
                self.ts_write(Json::obj([("jsonrpc", "2.0".into()), ("method", "initialized".into()), ("params", Json::obj([]))]), true);
                if let Some(ts) = self.ts.as_mut() {
                    ts.ready = true;
                    for body in std::mem::take(&mut ts.queue) {
                        let _ = write_message(&mut ts.stdin, &body);
                    }
                }
                if let Some(client_id) = client_id {
                    let legend = result["capabilities"]["semanticTokensProvider"]["legend"].clone();
                    self.respond(client_id, capabilities((!legend.is_null()).then_some(legend)))?;
                }
            }
            Pending::Ignore => {}
            Pending::Diagnostics { uri, version } => {
                let Some(doc) = self.docs.get(&uri) else { return Ok(()) };
                let Some(g) = doc.generated.as_ref().filter(|_| doc.version == version) else { return Ok(()) };
                let items = result["items"].as_array().cloned().unwrap_or_default();
                let mapped = items.iter().filter_map(|d| self.map_diagnostic(&doc.text, g, d)).collect();
                self.publish(&uri, mapped)?;
            }
            Pending::Forward { client_id, uri, kind } => {
                let mapped = match kind {
                    Kind::Resolve => strip_edits(result),
                    _ => match self.docs.get(&uri) {
                        Some(doc) => match (&doc.generated, kind) {
                            (Some(g), Kind::Completion { add_keywords }) => {
                                let mut out = map_completions(g, &doc.text, result);
                                if add_keywords
                                    && let Some(Json::Arr(mut items)) = out.get("items").cloned()
                                {
                                    items.extend(self.keyword_items(&uri));
                                    out.set("items", Json::Arr(items));
                                }
                                out
                            }
                            (Some(g), Kind::Hover) => {
                                let mut out = result;
                                if !out.is_null() {
                                    match map_range(g, &g.code, &doc.text, &out["range"]) {
                                        Some(r) => out.set("range", r),
                                        None => {
                                            if let Json::Obj(o) = &mut out {
                                                o.retain(|(k, _)| k != "range");
                                            }
                                        }
                                    }
                                }
                                out
                            }
                            (Some(_), Kind::Definition) => match &result {
                                Json::Arr(locs) => Json::Arr(locs.iter().map(|l| self.map_location(l)).collect()),
                                Json::Obj(_) => self.map_location(&result),
                                _ => Json::Null,
                            },
                            (Some(g), Kind::SemanticTokens) => map_semantic_tokens(g, &doc.text, &result),
                            _ => Json::Null,
                        },
                        None => Json::Null,
                    },
                };
                self.respond(client_id, mapped)?;
            }
        }
        Ok(())
    }

    /// zor keywords offered alongside TypeScript completions right after `@`.
    fn keyword_items(&self, uri: &str) -> Vec<Json> {
        let doc = &self.docs[uri];
        features::completions("@", 1, &doc.path, &[])
            .into_iter()
            .map(|c| {
                Json::obj([
                    ("label", c.label.into()),
                    ("kind", (c.kind as usize).into()),
                    ("detail", c.detail.into()),
                    ("insertTextFormat", 2usize.into()),
                    ("insertText", c.insert.into()),
                    ("sortText", "~".into()),
                ])
            })
            .collect()
    }

    fn map_diagnostic(&self, text: &str, g: &Generated, d: &Json) -> Option<Json> {
        let gen_start = offset_of(&g.code, &d["range"]["start"]);
        let gen_end = offset_of(&g.code, &d["range"]["end"]);
        let (start, end) = match gen_to_src(g, gen_start) {
            Some(s) => (s, gen_to_src(g, gen_end).filter(|e| *e >= s).unwrap_or(s)),
            None if d["severity"].as_usize() == Some(1) => {
                let m = g.mappings.iter().filter(|m| m.out <= gen_start).max_by_key(|m| m.out);
                let s = m.map_or(0, |m| m.src + m.len);
                (s, s)
            }
            None => return None,
        };
        let mut out = d.clone();
        out.set("range", range_json(text, start, end));
        Some(out)
    }
}

/// Completion edits target generated code; drop edits that can't be mapped back.
fn map_completions(g: &Generated, text: &str, result: Json) -> Json {
    let map_item = |mut item: Json| -> Json {
        if let Some(edit) = item.get("textEdit").cloned() {
            let range = edit.get("range").or_else(|| edit.get("replace")).cloned().unwrap_or_default();
            match map_range(g, &g.code, text, &range) {
                Some(r) => {
                    let new_text = edit["newText"].clone();
                    item.set("textEdit", Json::obj([("range", r), ("newText", new_text)]));
                }
                None => {
                    if let Json::Obj(o) = &mut item {
                        if item_insert_text_missing(o) {
                            let new_text = edit["newText"].clone();
                            o.push(("insertText".into(), new_text));
                        }
                        o.retain(|(k, _)| k != "textEdit");
                    }
                }
            }
        }
        strip_edits(item)
    };
    match result {
        Json::Arr(items) => Json::Arr(items.into_iter().map(map_item).collect()),
        Json::Obj(mut list) => {
            let items = list.iter().find(|(k, _)| k == "items").and_then(|(_, v)| v.as_array().cloned()).unwrap_or_default();
            list.retain(|(k, _)| k != "itemDefaults" && k != "items");
            let mut out = Json::Obj(list);
            out.set("items", Json::Arr(items.into_iter().map(map_item).collect()));
            out
        }
        other => other,
    }
}

fn item_insert_text_missing(o: &[(String, Json)]) -> bool {
    !o.iter().any(|(k, _)| k == "insertText")
}

fn capabilities(legend: Option<Json>) -> Json {
    let mut caps = Json::parse(
        r#"{"textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":false}},
        "completionProvider":{"triggerCharacters":["<","@",".","\""],"resolveProvider":true},
        "hoverProvider":true,"definitionProvider":true}"#,
    )
    .expect("valid capabilities");
    if let Some(legend) = legend {
        caps.set("semanticTokensProvider", Json::obj([("legend", legend), ("full", true.into())]));
    }
    Json::obj([("capabilities", caps), ("serverInfo", Json::obj([("name", "zor".into())]))])
}

/// Keeps TypeScript's semantic tokens that fall inside one mapping, at their `.tszor` position.
fn map_semantic_tokens(g: &Generated, text: &str, result: &Json) -> Json {
    let data: Vec<usize> = result["data"].as_array().map(|a| a.iter().filter_map(Json::as_usize).collect()).unwrap_or_default();
    let mut tokens: Vec<[usize; 5]> = Vec::new();
    let (mut line, mut ch) = (0, 0);
    for t in data.chunks_exact(5) {
        if t[0] > 0 {
            line += t[0];
            ch = t[1];
        } else {
            ch += t[1];
        }
        let start = offset_at(&g.code, line, ch);
        let end = offset_at(&g.code, line, ch + t[2]);
        let Some(m) = g.mappings.iter().find(|m| m.out <= start && end <= m.out + m.len) else { continue };
        let (src_line, src_ch) = position_at(text, m.src + start - m.out);
        tokens.push([src_line, src_ch, t[2], t[3], t[4]]);
    }
    tokens.sort();
    tokens.dedup_by(|a, b| a[0] == b[0] && a[1] == b[1]);
    let mut out = Vec::with_capacity(tokens.len() * 5);
    let (mut prev_line, mut prev_ch) = (0, 0);
    for [l, c, len, ty, mods] in tokens {
        let dc = if l == prev_line { c - prev_ch } else { c };
        out.extend([l - prev_line, dc, len, ty, mods].map(Json::from));
        (prev_line, prev_ch) = (l, c);
    }
    Json::obj([("data", Json::Arr(out))])
}

/// Auto-import edits would target the generated file, so they are removed.
fn strip_edits(mut item: Json) -> Json {
    if let Json::Obj(o) = &mut item {
        o.retain(|(k, _)| k != "additionalTextEdits" && k != "command");
    }
    item
}
