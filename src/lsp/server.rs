//! `zor lsp`: answers component questions itself and proxies TypeScript regions to
//! TypeScript 7's native server, mapping positions through codegen's source maps.

use super::features::{self, Context, Symbol};
use super::{offset_at, path_to_uri, position_at, read_message, same_path, uri_to_path, write_message};
use crate::build::{DiFailure, compile_all, declares_provider, di_checked, find_sources, in_project, inject_diags, output_path, project_root};
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
    References,
    Rename,
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
    compiled: Option<Compiled>,
    version: i64,
    ts_open: bool,
    error: Option<crate::Diagnostic>,
    /// Last TypeScript diagnostics, mapped to this document.
    ts: Vec<Json>,
    /// DI diagnostics from the last save.
    di: Vec<Json>,
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

/// Generated code and the source text it came from. While the current text doesn't parse,
/// this is the last good compile, and offsets outside the edited span are carried across.
#[derive(Clone)]
struct Compiled {
    text: String,
    g: Generated,
}

impl Compiled {
    fn to_gen(&self, text: &str, off: usize) -> Option<usize> {
        self.g.to_out(shift(text, &self.text, off)?)
    }

    fn to_src(&self, text: &str, gen_off: usize) -> Option<usize> {
        shift(&self.text, text, self.g.to_src(gen_off)?)
    }

    /// Maps a range in generated code back to `text`.
    fn map_range(&self, text: &str, range: &Json) -> Option<Json> {
        let start = self.to_src(text, offset_of(&self.g.code, &range["start"]))?;
        let end = self.to_src(text, offset_of(&self.g.code, &range["end"])).filter(|e| *e >= start).unwrap_or(start);
        Some(range_json(text, start, end))
    }
}

/// Moves an offset in `from` to the same place in `to`, unless it lies inside the span that differs.
fn shift(from: &str, to: &str, off: usize) -> Option<usize> {
    if from == to {
        return Some(off);
    }
    let (a, b) = (from.as_bytes(), to.as_bytes());
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let room = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(room).take_while(|(x, y)| x == y).count();
    if off <= prefix {
        Some(off)
    } else if off >= a.len() - suffix {
        Some(off - (a.len() - suffix) + (b.len() - suffix))
    } else {
        None
    }
}

fn pos_json(text: &str, off: usize) -> Json {
    let (line, character) = position_at(text, off);
    Json::obj([("line", line.into()), ("character", character.into())])
}

fn lsp_pos((line, character): (usize, usize)) -> Json {
    Json::obj([("line", line.into()), ("character", character.into())])
}

fn range_json(text: &str, start: usize, end: usize) -> Json {
    Json::obj([("start", pos_json(text, start)), ("end", pos_json(text, end))])
}

fn offset_of(text: &str, pos: &Json) -> usize {
    offset_at(text, pos["line"].as_usize().unwrap_or(0), pos["character"].as_usize().unwrap_or(0))
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
            "textDocument/references" => self.forward_at(method, id, params, Kind::References),
            "textDocument/rename" => self.forward_at(method, id, params, Kind::Rename),
            "textDocument/semanticTokens/full" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
                let gen_uri = self.docs.get(&uri).filter(|d| d.compiled.is_some()).map(|d| d.gen_uri.clone());
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
                self.docs.insert(uri.clone(), Doc { text, path, gen_uri, compiled: None, version: 0, ts_open: false, error: None, ts: Vec::new(), di: Vec::new() });
                self.refresh(&uri)?;
            }
            "textDocument/didChange" => {
                let changes = params["contentChanges"].as_array().cloned().unwrap_or_default();
                if let (Some(doc), Some(text)) = (self.docs.get_mut(&uri), changes.last().and_then(|c| c["text"].as_str())) {
                    doc.text = text.to_string();
                    self.refresh(&uri)?;
                }
            }
            "textDocument/didSave" => self.saved(&uri)?,
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
                doc.compiled = Some(Compiled { text: doc.text.clone(), g });
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
                // TypeScript keeps the last good generated code; positions are shifted across the edit.
                doc.error = Some(d);
                self.publish(uri, Vec::new())?;
            }
        }
        Ok(())
    }

    /// On save of a `.tszor` or a provider `.ts`: recompiles the project, runs the DI analysis and
    /// publishes its `@inject` diagnostics. Provider graph errors in `.ts` files show in `zor build` only.
    fn saved(&mut self, uri: &str) -> io::Result<()> {
        let Some(path) = uri_to_path(uri) else { return Ok(()) };
        let ext = path.extension().and_then(|e| e.to_str());
        let relevant = match ext {
            Some("tszor") => true,
            Some("ts") => std::fs::read_to_string(&path).is_ok_and(|t| declares_provider(&t)),
            _ => false,
        };
        if !relevant || !in_project(&path) {
            return Ok(());
        }
        let root = project_root(&path);
        let marks = match compile_all(&root) {
            // The entry check is irrelevant here: only component diagnostics are published.
            Ok(units) => match di_checked(&root, "main.ts", &units) {
                Err(DiFailure::Diags(d)) => inject_diags(&root, &d, &units),
                _ => Vec::new(),
            },
            Err(_) => Vec::new(),
        };
        let uris: Vec<String> = self.docs.keys().cloned().collect();
        for uri in uris {
            let doc = self.docs.get_mut(&uri).expect("key from docs");
            let di: Vec<Json> = marks
                .iter()
                .filter(|m| same_path(&m.source, &doc.path))
                .map(|m| {
                    Json::obj([
                        ("range", Json::obj([("start", lsp_pos(m.start)), ("end", lsp_pos(m.end))])),
                        ("severity", 1usize.into()),
                        ("source", "zor".into()),
                        ("code", m.code.into()),
                        ("message", format!("{}: {}", m.code, m.message).into()),
                    ])
                })
                .collect();
            if doc.di != di {
                doc.di = di;
                self.emit(&uri)?;
            }
        }
        Ok(())
    }

    fn publish(&mut self, uri: &str, ts_diagnostics: Vec<Json>) -> io::Result<()> {
        if let Some(doc) = self.docs.get_mut(uri) {
            doc.ts = ts_diagnostics;
        }
        self.emit(uri)
    }

    fn emit(&self, uri: &str) -> io::Result<()> {
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
        all.extend(doc.di.iter().cloned());
        all.extend(doc.ts.iter().cloned());
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
        let c = doc.compiled.as_ref().expect("forward requires generated code");
        params.set("textDocument", Json::obj([("uri", doc.gen_uri.clone().into())]));
        params.set("position", pos_json(&c.g.code, gen_off));
        let pending = Pending::Forward { client_id: id.clone(), uri: uri.to_string(), kind };
        if self.ts_request(method, params, pending) { Ok(()) } else { self.respond(id, Json::Null) }
    }

    /// Forwards a position request to TypeScript when the position maps into generated code.
    fn forward_at(&mut self, method: &str, id: Json, params: &Json, kind: Kind) -> io::Result<()> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        let gen_off = self.docs.get(&uri).and_then(|doc| {
            let off = offset_of(&doc.text, &params["position"]);
            doc.compiled.as_ref()?.to_gen(&doc.text, off)
        });
        match gen_off {
            Some(gen_off) => self.forward(method, id, &uri, gen_off, kind, params.clone()),
            None => self.respond(id, Json::Null),
        }
    }

    fn completion(&mut self, id: Json, params: &Json) -> io::Result<()> {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
        let Some(doc) = self.docs.get(&uri) else { return self.respond(id, Json::Null) };
        let off = offset_of(&doc.text, &params["position"]);
        let ctx = features::context(&doc.text, off);
        let mapped = doc.compiled.as_ref().and_then(|c| c.to_gen(&doc.text, off));
        match (&ctx, mapped) {
            (Context::Tag { .. } | Context::Attr { .. } | Context::SlotName { .. }, _) | (_, None) => {
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
            Context::Tag { start, .. }
            | Context::Attr { start, .. }
            | Context::Directive { start, .. }
            | Context::SlotName { start, .. } => start,
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
                Symbol::Slot { component, name } => comps
                    .iter()
                    .find(|c| &c.name == component && c.slots.iter().any(|(n, _)| n == name))
                    .map(|_| format!("```ts\n(slot) {component}.{name}\n```")),
            };
            if let Some(value) = value {
                let contents = Json::obj([("kind", "markdown".into()), ("value", value.into())]);
                let range = range_json(&doc.text, start, end);
                return self.respond(id, Json::obj([("contents", contents), ("range", range)]));
            }
        }
        match doc.compiled.as_ref().and_then(|c| c.to_gen(&doc.text, off)) {
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
                Symbol::Slot { component, name } => comps.iter().find(|c| &c.name == component).and_then(|c| {
                    let (n, at) = c.slots.iter().find(|(n, _)| n == name)?;
                    Some((c.path.clone(), *at, at + n.len()))
                }),
            };
            if let Some((path, start, end)) = target {
                let text = self.text_of(&path).unwrap_or_default();
                let loc = Json::obj([("uri", path_to_uri(&path).into()), ("range", range_json(&text, start, end))]);
                return self.respond(id, Json::Arr(vec![loc]));
            }
        }
        match doc.compiled.as_ref().and_then(|c| c.to_gen(&doc.text, off)) {
            Some(gen_off) => self.forward("textDocument/definition", id, &uri, gen_off, Kind::Definition, params.clone()),
            None => self.respond(id, Json::Null),
        }
    }

    /// Source path, current text and compile for a generated `.zor/…​.tszor.ts` path.
    fn source_of_generated(&self, gen_path: &Path) -> Option<(PathBuf, String, Compiled)> {
        let zor_dir = gen_path.ancestors().find(|a| a.file_name().is_some_and(|n| n == ".zor"))?;
        let rel = gen_path.strip_prefix(zor_dir).ok()?;
        let rel = rel.to_string_lossy();
        let source = zor_dir.parent()?.join(rel.strip_suffix(".ts")?);
        if let Some(doc) = self.docs.values().find(|d| same_path(&d.path, &source)) {
            return Some((source, doc.text.clone(), doc.compiled.clone()?));
        }
        let text = std::fs::read_to_string(&source).ok()?;
        let g = crate::compile_mapped(&text, &source).ok()?;
        Some((source, text.clone(), Compiled { text, g }))
    }

    /// A location's `(uri, range)` with generated files mapped to their `.tszor`;
    /// `None` for generated scaffolding that has no source.
    fn map_location(&self, uri: &str, range: &Json) -> Option<(String, Json)> {
        let Some((source, text, c)) = uri_to_path(uri).and_then(|p| self.source_of_generated(&p)) else {
            return Some((uri.to_string(), range.clone()));
        };
        Some((path_to_uri(&source), c.map_range(&text, range)?))
    }

    fn map_definition(&self, loc: &Json) -> Json {
        let uri = loc["uri"].as_str().unwrap_or_default();
        let (uri, range) = self.map_location(uri, &loc["range"]).unwrap_or_else(|| {
            let source = uri_to_path(uri).and_then(|p| self.source_of_generated(&p)).map(|s| s.0).unwrap_or_default();
            (path_to_uri(&source), range_json("", 0, 0))
        });
        Json::obj([("uri", uri.into()), ("range", range)])
    }

    fn map_references(&self, result: &Json) -> Json {
        let mut out: Vec<Json> = Vec::new();
        for loc in result.as_array().into_iter().flatten() {
            let Some((uri, range)) = self.map_location(loc["uri"].as_str().unwrap_or_default(), &loc["range"]) else { continue };
            let loc = Json::obj([("uri", uri.into()), ("range", range)]);
            if !out.contains(&loc) {
                out.push(loc);
            }
        }
        Json::Arr(out)
    }

    /// Maps a rename's edits to `.tszor` files, dropping edits on generated scaffolding.
    fn map_workspace_edit(&self, edit: &Json) -> Json {
        let mut groups: Vec<(String, Vec<Json>)> = Vec::new();
        if let Some(Json::Obj(changes)) = edit.get("changes") {
            groups.extend(changes.iter().map(|(uri, edits)| (uri.clone(), edits.as_array().cloned().unwrap_or_default())));
        }
        for change in edit["documentChanges"].as_array().into_iter().flatten() {
            let uri = change["textDocument"]["uri"].as_str().unwrap_or_default().to_string();
            groups.push((uri, change["edits"].as_array().cloned().unwrap_or_default()));
        }
        let mut changes: Vec<(String, Json)> = Vec::new();
        for (uri, edits) in groups {
            for e in edits {
                let Some((uri, range)) = self.map_location(&uri, &e["range"]) else { continue };
                let e = Json::obj([("range", range), ("newText", e["newText"].clone())]);
                match changes.iter_mut().find(|(u, _)| *u == uri) {
                    Some((_, Json::Arr(list))) => {
                        if !list.contains(&e) {
                            list.push(e);
                        }
                    }
                    _ => changes.push((uri, Json::Arr(vec![e]))),
                }
            }
        }
        Json::obj([("changes", Json::Obj(changes))])
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
                let Some(c) = doc.compiled.as_ref().filter(|_| doc.version == version) else { return Ok(()) };
                let items = result["items"].as_array().cloned().unwrap_or_default();
                let mapped = items.iter().filter_map(|d| map_diagnostic(&doc.text, c, d)).collect();
                self.publish(&uri, mapped)?;
            }
            Pending::Forward { client_id, uri, kind } => {
                let mapped = match kind {
                    Kind::Resolve => strip_edits(result),
                    _ => match self.docs.get(&uri) {
                        Some(doc) => match (&doc.compiled, kind) {
                            (Some(c), Kind::Completion { add_keywords }) => {
                                let mut out = map_completions(c, &doc.text, result);
                                if add_keywords
                                    && let Some(Json::Arr(mut items)) = out.get("items").cloned()
                                {
                                    items.extend(self.keyword_items(&uri));
                                    out.set("items", Json::Arr(items));
                                }
                                out
                            }
                            (Some(c), Kind::Hover) => {
                                let mut out = result;
                                if !out.is_null() {
                                    match c.map_range(&doc.text, &out["range"]) {
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
                                Json::Arr(locs) => Json::Arr(locs.iter().map(|l| self.map_definition(l)).collect()),
                                Json::Obj(_) => self.map_definition(&result),
                                _ => Json::Null,
                            },
                            (Some(_), Kind::References) => self.map_references(&result),
                            (Some(_), Kind::Rename) if !result.is_null() => self.map_workspace_edit(&result),
                            (Some(c), Kind::SemanticTokens) => map_semantic_tokens(c, &doc.text, &result),
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

}

fn map_diagnostic(text: &str, c: &Compiled, d: &Json) -> Option<Json> {
    let gen_start = offset_of(&c.g.code, &d["range"]["start"]);
    let gen_end = offset_of(&c.g.code, &d["range"]["end"]);
    let (start, end) = match c.to_src(text, gen_start) {
        Some(s) => (s, c.to_src(text, gen_end).filter(|e| *e >= s).unwrap_or(s)),
        None if d["severity"].as_usize() == Some(1) => {
            let s = shift(&c.text, text, c.g.to_src_nearest(gen_start))?;
            (s, s)
        }
        None => return None,
    };
    let mut out = d.clone();
    out.set("range", range_json(text, start, end));
    Some(out)
}

/// Completion edits target generated code; drop edits that can't be mapped back.
fn map_completions(c: &Compiled, text: &str, result: Json) -> Json {
    let map_item = |mut item: Json| -> Json {
        if let Some(edit) = item.get("textEdit").cloned() {
            let range = edit.get("range").or_else(|| edit.get("replace")).cloned().unwrap_or_default();
            match c.map_range(text, &range) {
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
        "hoverProvider":true,"definitionProvider":true,"referencesProvider":true,"renameProvider":true}"#,
    )
    .expect("valid capabilities");
    if let Some(legend) = legend {
        caps.set("semanticTokensProvider", Json::obj([("legend", legend), ("full", true.into())]));
    }
    Json::obj([("capabilities", caps), ("serverInfo", Json::obj([("name", "zor".into())]))])
}

/// Keeps TypeScript's semantic tokens that fall inside one mapping, at their `.tszor` position.
fn map_semantic_tokens(c: &Compiled, text: &str, result: &Json) -> Json {
    let g = &c.g;
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
        let src = m.src + start - m.out;
        let Some(at) = shift(&c.text, text, src).filter(|at| shift(&c.text, text, src + end - start) == Some(at + end - start)) else {
            continue;
        };
        let (src_line, src_ch) = position_at(text, at);
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
