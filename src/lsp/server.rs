//! `xzor lsp`: answers component questions itself and proxies TypeScript regions to
//! TypeScript 7's native server, mapping positions through codegen's source maps.

use super::features::{self, Context, Symbol};
use super::{offset_at, path_key, path_to_uri, position_at, read_message, same_path, uri_to_path, write_message};
use crate::build::{
    self, Analyzer, DiFailure, LocatedDiag, compile_all, compile_one, declares_provider, di_run, find_sources, located_diags, output_path_in,
    project_root, project_sources, tsconfig_root,
};
use crate::codegen::Generated;
use crate::json::Json;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime};

/// Quiet time after the last edit before the DI analysis reruns with the unsaved text.
const DI_DEBOUNCE: Duration = Duration::from_millis(300);

enum Event {
    Client(Json),
    Ts(Json),
    ClientClosed,
    TsClosed,
    /// A DI run's result; `marks` is `None` when compiling or the analyzer failed, `providers` when the run panicked.
    Di { root: PathBuf, generation: u64, marks: Option<Vec<LocatedDiag>>, providers: Option<Vec<PathBuf>>, worker: Box<DiWorker> },
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
    /// The directory of the nearest `tsconfig.json`, if any.
    root: Option<PathBuf>,
    /// A `.ts` document: only its text is kept, for DI diagnostics and analysis overlays.
    ts_file: bool,
    gen_uri: String,
    compiled: Option<Compiled>,
    version: i64,
    ts_open: bool,
    error: Option<crate::Diagnostic>,
    /// Last TypeScript diagnostics, mapped to this document.
    ts: Vec<Json>,
    /// DI diagnostics from the last analysis.
    di: Vec<Json>,
    /// Route errors from the last route table of this document's project.
    routes: Vec<Json>,
}

/// What the route table needs from a `.xzor` no open document covers.
struct RouteUnit {
    text: String,
    routes: Vec<crate::routes::RouteInfo>,
    block: Option<crate::routes::RoutesBlockInfo>,
}

/// One project's `.xzor/routes.ts`, synced to TypeScript as an in-memory document.
struct RoutesRoot {
    root: PathBuf,
    uri: String,
    text: String,
    version: i64,
    ts_open: bool,
    /// Route info of the `.xzor` files read from disk, by modification time; `None` when a file has none.
    cache: HashMap<PathBuf, (SystemTime, Option<RouteUnit>)>,
    /// Route errors of the last table, by `.xzor`.
    marks: Vec<(PathBuf, Vec<Json>)>,
}

/// DI state of one project root.
struct DiRoot {
    root: PathBuf,
    /// Bumped per request; results of older runs are dropped.
    generation: u64,
    /// Absolute provider `.ts` files seen by the last run.
    providers: Vec<PathBuf>,
    /// Kept across runs; `None` while a run holds it.
    worker: Option<Box<DiWorker>>,
    /// Whether the next run writes the generated providers (a save or file event, not a live edit).
    write: bool,
}

/// What DI runs of one root keep: the analyzer process, and per-file results keyed by modification time.
struct DiWorker {
    analyzer: Analyzer,
    /// `.ts` files on disk: whether they declare a provider.
    providers: HashMap<PathBuf, (SystemTime, bool)>,
    /// `.xzor` files compiled from disk, and whether their generated file was written.
    units: HashMap<PathBuf, (SystemTime, build::Compiled, bool)>,
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
    di_running: bool,
    /// Roots to analyze once the running analysis finishes.
    di_queue: Vec<PathBuf>,
    di_roots: Vec<DiRoot>,
    /// Last DI diagnostics per (root, source), open or not.
    di_marks: Vec<(PathBuf, PathBuf, Vec<Json>)>,
    /// Roots to analyze live once `di_deadline` passes.
    di_due: Vec<PathBuf>,
    di_deadline: Option<Instant>,
    /// Route table state of the projects with an open document.
    routes: Vec<RoutesRoot>,
    /// The client's `initialize` capabilities.
    client_caps: Json,
    /// TypeScript's semantic token legend.
    legend: Option<Json>,
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
    let mut server = Server {
        tx,
        ts: None,
        next_id: 0,
        pending: HashMap::new(),
        docs: HashMap::new(),
        di_running: false,
        di_queue: Vec::new(),
        di_roots: Vec::new(),
        di_marks: Vec::new(),
        di_due: Vec::new(),
        di_deadline: None,
        routes: Vec::new(),
        client_caps: Json::Null,
        legend: None,
    };
    loop {
        let event = match server.di_deadline {
            Some(deadline) => match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    server.di_deadline = None;
                    for root in std::mem::take(&mut server.di_due) {
                        server.di_request(root, false);
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(event) => event,
                Err(_) => break,
            },
        };
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
                        Pending::Init { client_id: Some(id) } => server.respond(id, capabilities(&None, &server.client_caps))?,
                        Pending::Forward { client_id, .. } => server.respond(client_id, Json::Null)?,
                        _ => {}
                    }
                }
            }
            Event::Di { root, generation, marks, providers, worker } => server.di_done(root, generation, marks, providers, worker)?,
            Event::ClientClosed => break,
        }
    }
    if let Some(mut ts) = server.ts.take() {
        let _ = ts.child.kill();
    }
    Ok(())
}

/// TypeScript 7's native executable, found in `node_modules` above `root`; `XZOR_TSGO` overrides.
fn find_tsgo(root: &Path) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("XZOR_TSGO") {
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

/// The route info of a `.xzor` read from disk; `None` when it has no pages and no routes block.
fn route_unit(path: &Path, text: String) -> Option<RouteUnit> {
    // Compiling is the cost; a project without routes only pays for this scan.
    if !text.contains("@page") && !text.contains("@ClientRoutes") && !text.contains("@ServerRoutes") {
        return None;
    }
    let g = crate::compile_mapped_with(&text, path, &|p| std::fs::read_to_string(p).ok()).ok()?;
    if g.routes.is_empty() && g.routes_block.is_none() {
        return None;
    }
    Some(RouteUnit { text, routes: g.routes, block: g.routes_block })
}

/// The component class a `.xzor` compiles to.
fn class_of(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    crate::codegen::class_name(name.strip_suffix(".xzor").unwrap_or(&name))
}

/// Length of the route token (tag, pattern or block keyword) starting at `at`.
fn route_token(text: &str, at: usize) -> usize {
    let rest = text.get(at..).unwrap_or_default();
    rest.find(|c: char| c.is_whitespace() || matches!(c, '"' | '(' | ')' | '{')).unwrap_or(rest.len())
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
                Json::obj([("type", 2usize.into()), ("message", "xzor: TypeScript 7 not found; TypeScript features are off".into())]),
            )?;
            return self.respond(client_id, capabilities(&None, &self.client_caps));
        };
        let Ok(mut child) = Command::new(&exe)
            .args(["--lsp", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return self.respond(client_id, capabilities(&None, &self.client_caps));
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
        // VS Code's own TypeScript support serves `.ts` documents; they only get DI diagnostics here.
        // Null (not empty) results let the editor fall through to that provider where it picks just one.
        if params["textDocument"]["uri"].as_str().is_some_and(|u| u.ends_with(".ts")) {
            let empty = match method {
                "textDocument/completion" => Json::obj([("isIncomplete", false.into()), ("items", Json::Arr(vec![]))]),
                "textDocument/references" => Json::Arr(vec![]),
                _ => Json::Null,
            };
            return self.respond(id, empty);
        }
        match method {
            "initialize" => {
                self.client_caps = params["capabilities"].clone();
                let root_uri = params["rootUri"].as_str().or(params["workspaceFolders"][0]["uri"].as_str());
                match root_uri.and_then(uri_to_path) {
                    Some(root) => {
                        let _ = compile_all(&root);
                        self.start_ts(&root, id)
                    }
                    None => self.respond(id, capabilities(&None, &self.client_caps)),
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
            "initialized" => {
                let registrations = registrations(&self.legend, &self.client_caps);
                if !registrations.is_empty() {
                    self.send(&Json::obj([
                        ("jsonrpc", "2.0".into()),
                        ("id", "xzor/register".into()),
                        ("method", "client/registerCapability".into()),
                        ("params", Json::obj([("registrations", Json::Arr(registrations))])),
                    ]))?;
                }
            }
            "textDocument/didOpen" => {
                let Some(path) = uri_to_path(&uri) else { return Ok(true) };
                let text = params["textDocument"]["text"].as_str().unwrap_or_default().to_string();
                let ts_file = path.extension().is_some_and(|e| e == "ts");
                let root = tsconfig_root(&path);
                let gen_uri = if ts_file {
                    String::new()
                } else {
                    path_to_uri(&output_path_in(root.as_deref().unwrap_or(path.parent().unwrap_or(Path::new("."))), &path))
                };
                let di = self.di_of(&path);
                let routes = self.routes_of(&path);
                let shown = !di.is_empty() || !routes.is_empty();
                self.di_schedule(&path, root.as_deref(), Some(&text));
                let doc = Doc {
                    text,
                    path,
                    root,
                    ts_file,
                    gen_uri,
                    compiled: None,
                    version: 0,
                    ts_open: false,
                    error: None,
                    ts: Vec::new(),
                    di,
                    routes,
                };
                self.docs.insert(uri.clone(), doc);
                if !ts_file {
                    self.refresh(&uri)?;
                } else if shown {
                    self.emit(&uri)?;
                }
            }
            "textDocument/didChange" => {
                let changes = params["contentChanges"].as_array().cloned().unwrap_or_default();
                let Some(text) = changes.last().and_then(|c| c["text"].as_str()) else { return Ok(true) };
                let Some(doc) = self.docs.get_mut(&uri) else { return Ok(true) };
                let old = std::mem::replace(&mut doc.text, text.to_string());
                let (path, ts_file, root) = (doc.path.clone(), doc.ts_file, doc.root.clone());
                // Published DI ranges follow the edit at once; the analysis reruns after `DI_DEBOUNCE`.
                if !doc.di.is_empty() {
                    for (_, _, list) in self.di_marks.iter_mut().filter(|(_, p, _)| same_path(p, &path)) {
                        *list = shift_diags(&old, text, list);
                    }
                    let di = self.di_of(&path);
                    self.docs.get_mut(&uri).expect("checked above").di = di;
                    self.emit(&uri)?;
                }
                if !ts_file {
                    self.refresh(&uri)?;
                }
                self.refresh_inheritors(&path)?;
                self.di_schedule(&path, root.as_deref(), Some(text));
            }
            "textDocument/didSave" => {
                if let Some(path) = uri_to_path(&uri).filter(|_| !self.docs.contains_key(&uri)) {
                    self.refresh_inheritors(&path)?;
                }
                let root = match self.docs.get(&uri) {
                    Some(d) => self.di_root_of(&d.path, d.root.as_deref(), Some(&d.text)),
                    None => uri_to_path(&uri).and_then(|p| self.di_root_of(&p, tsconfig_root(&p).as_deref(), None)),
                };
                if let Some(root) = root {
                    self.di_request(root, true);
                }
            }
            "workspace/didChangeWatchedFiles" => {
                let mut roots: Vec<PathBuf> = Vec::new();
                let mut route_roots: Vec<PathBuf> = Vec::new();
                for change in params["changes"].as_array().into_iter().flatten() {
                    let uri = change["uri"].as_str().unwrap_or_default();
                    // DI writes `.xzor/` files; reacting to them would loop.
                    if uri.contains("/.xzor/") || uri.contains("/node_modules/") {
                        continue;
                    }
                    let Some(path) = uri_to_path(uri) else { continue };
                    // Open `.xzor` documents are covered by `didSave`.
                    if self.docs.values().any(|d| same_path(&d.path, &path)) {
                        continue;
                    }
                    self.refresh_inheritors(&path)?;
                    if path.extension().is_some_and(|e| e == "xzor")
                        && let Some(root) = tsconfig_root(&path).filter(|r| self.tracks_routes(r) && !route_roots.iter().any(|x| same_path(x, r)))
                    {
                        route_roots.push(root);
                    }
                    if let Some(root) = self.di_root_of(&path, tsconfig_root(&path).as_deref(), None).filter(|r| !roots.iter().any(|x| same_path(x, r))) {
                        roots.push(root);
                    }
                }
                for root in route_roots {
                    self.sync_routes(&root, None)?;
                }
                for root in roots {
                    self.di_request(root, true);
                }
            }
            "textDocument/didClose" => {
                if let Some(doc) = self.docs.remove(&uri) {
                    if doc.ts_open {
                        self.ts_notify("textDocument/didClose", Json::obj([("textDocument", Json::obj([("uri", doc.gen_uri.into())]))]));
                    }
                    self.notify("textDocument/publishDiagnostics", Json::obj([("uri", uri.into()), ("diagnostics", Json::Arr(vec![]))]))?;
                    let routed = doc.compiled.as_ref().is_some_and(|c| !c.g.routes.is_empty() || c.g.routes_block.is_some());
                    match doc.root.clone() {
                        Some(root) if !self.has_docs(&root) => {
                            self.di_retire(&root);
                            self.routes_retire(&root);
                        }
                        // Its unsaved text no longer overlays the disk.
                        root => {
                            self.di_schedule(&doc.path, root.as_deref(), None);
                            if let Some(root) = root.filter(|r| routed || self.tracks_routes(r)) {
                                self.sync_routes(&root, None)?;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        Ok(true)
    }

    /// Recompiles a document, syncs the generated code to TypeScript and requests diagnostics.
    fn refresh(&mut self, uri: &str) -> io::Result<()> {
        let Some(doc) = self.docs.get(uri) else { return Ok(()) };
        // `@inherits` bases and imported components open in the editor are read from their unsaved text.
        let read = |p: &Path| match self.docs.values().find(|d| same_path(&d.path, p)) {
            Some(d) => Some(d.text.clone()),
            None => std::fs::read_to_string(p).ok(),
        };
        let compiled = crate::compile_mapped_with(&doc.text, &doc.path, &read);
        let root = doc.root.clone();
        let doc = self.docs.get_mut(uri).expect("checked above");
        match compiled {
            Ok(g) => {
                doc.error = None;
                doc.version += 1;
                // The project's table is built from the open documents, so it follows their route lines.
                let resync = match &doc.compiled {
                    // Moved route lines only matter when this document shows route errors at their old place.
                    Some(c) => {
                        crate::routes::routes_differ((&c.g.routes, c.g.routes_block.as_ref()), (&g.routes, g.routes_block.as_ref()))
                            || (!doc.routes.is_empty() && (c.g.routes != g.routes || c.g.routes_block != g.routes_block))
                    }
                    None => !g.routes.is_empty() || g.routes_block.is_some(),
                };
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
                if let Some(root) = root.filter(|r| resync || !self.tracks_routes(r)) {
                    self.sync_routes(&root, Some(uri))?;
                }
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

    /// Refreshes the open `.xzor` documents whose `@inherits` chain probed the changed `path`.
    fn refresh_inheritors(&mut self, path: &Path) -> io::Result<()> {
        let uris: Vec<String> = self
            .docs
            .iter()
            .filter(|(_, d)| {
                !d.ts_file && !same_path(&d.path, path) && d.compiled.as_ref().is_some_and(|c| c.g.deps.iter().any(|p| same_path(p, path)))
            })
            .map(|(u, _)| u.clone())
            .collect();
        for uri in uris {
            self.refresh(&uri)?;
        }
        Ok(())
    }

    /// Whether a route table is already tracked for the project at `root`.
    fn tracks_routes(&self, root: &Path) -> bool {
        self.routes.iter().any(|r| same_path(&r.root, root))
    }

    /// The route errors last found for `path`.
    fn routes_of(&self, path: &Path) -> Vec<Json> {
        self.routes.iter().flat_map(|r| &r.marks).filter(|(p, _)| same_path(p, path)).flat_map(|(_, d)| d.iter().cloned()).collect()
    }

    /// Forgets the route table of a root whose last document closed.
    fn routes_retire(&mut self, root: &Path) {
        let Some(i) = self.routes.iter().position(|r| same_path(&r.root, root)) else { return };
        let state = self.routes.remove(i);
        if state.ts_open {
            self.ts_notify("textDocument/didClose", Json::obj([("textDocument", Json::obj([("uri", state.uri.into())]))]));
        }
    }

    /// Rebuilds `<root>/.xzor/routes.ts` from the project's `.xzor` files (open documents' text first,
    /// then disk), syncs it to TypeScript as an in-memory document like a generated component, and
    /// publishes the project-wide route errors. `skip` is the document whose TypeScript diagnostics the
    /// caller requests itself.
    fn sync_routes(&mut self, root: &Path, skip: Option<&str>) -> io::Result<()> {
        let i = match self.routes.iter().position(|r| same_path(&r.root, root)) {
            Some(i) => i,
            None => {
                // TypeScript resolves `./routes` through `rootDirs` only when the directory exists.
                let _ = std::fs::create_dir_all(root.join(".xzor"));
                let uri = path_to_uri(&root.join(".xzor").join("routes.ts"));
                let state =
                    RoutesRoot { root: root.to_path_buf(), uri, text: String::new(), version: 0, ts_open: false, cache: HashMap::new(), marks: Vec::new() };
                self.routes.push(state);
                self.routes.len() - 1
            }
        };
        let mut paths: Vec<PathBuf> = project_sources(root).into_iter().filter(|p| p.extension().is_some_and(|e| e == "xzor")).collect();
        // Sorted so a duplicate pattern always lands on the same document.
        paths.sort();
        let mut old = std::mem::take(&mut self.routes[i].cache);
        let mut cache = HashMap::with_capacity(paths.len());
        for path in &paths {
            if self.docs.values().any(|d| same_path(&d.path, path) && d.compiled.is_some()) {
                continue;
            }
            let Ok(mtime) = std::fs::metadata(path).and_then(|m| m.modified()) else { continue };
            let unit = match old.remove(path) {
                Some((m, unit)) if m == mtime => unit,
                _ => std::fs::read_to_string(path).ok().and_then(|t| route_unit(path, t)),
            };
            cache.insert(path.clone(), (mtime, unit));
        }
        let outs: Vec<PathBuf> = paths.iter().map(|p| output_path_in(root, p)).collect();
        let classes: Vec<String> = paths.iter().map(|p| class_of(p)).collect();
        let (table, marks, empty) = {
            let mut views: Vec<crate::routes::Unit> = Vec::new();
            for (k, path) in paths.iter().enumerate() {
                let open = self.docs.values().find(|d| same_path(&d.path, path)).and_then(|d| d.compiled.as_ref().map(|c| (&d.text, c)));
                let (text, routes, block) = match open {
                    Some((text, c)) => (text.as_str(), &c.g.routes, c.g.routes_block.as_ref()),
                    None => match cache.get(path).and_then(|(_, u)| u.as_ref()) {
                        Some(u) => (u.text.as_str(), &u.routes, u.block.as_ref()),
                        None => continue,
                    },
                };
                if routes.is_empty() && block.is_none() {
                    continue;
                }
                views.push(crate::routes::Unit { source: path, out: &outs[k], text, class: &classes[k], routes, block });
            }
            let (table, diags) = crate::routes::table(root, &views);
            let mut marks: Vec<(PathBuf, Vec<Json>)> = Vec::new();
            for (file, d) in diags {
                let text = views.iter().find(|v| same_path(v.source, &file)).map_or("", |v| v.text);
                let end = d.offset + route_token(text, d.offset);
                let json = Json::obj([
                    ("range", range_json(text, d.offset, end)),
                    ("severity", 1usize.into()),
                    ("source", "xzor".into()),
                    ("message", d.message.into()),
                ]);
                match marks.iter_mut().find(|(p, _)| same_path(p, &file)) {
                    Some((_, list)) => list.push(json),
                    None => marks.push((file, vec![json])),
                }
            }
            (table, marks, views.is_empty())
        };
        self.routes[i].cache = cache;
        self.routes[i].marks = marks;
        // A project with no routes at all gets no table, unless one was already synced.
        let changed = self.routes[i].text != table && !(empty && !self.routes[i].ts_open);
        if changed {
            self.routes[i].text = table.clone();
            self.routes[i].version += 1;
            let (uri, version, was_open) = (self.routes[i].uri.clone(), self.routes[i].version as usize, self.routes[i].ts_open);
            if was_open {
                self.ts_notify(
                    "textDocument/didChange",
                    Json::obj([
                        ("textDocument", Json::obj([("uri", uri.into()), ("version", version.into())])),
                        ("contentChanges", Json::Arr(vec![Json::obj([("text", table.into())])])),
                    ]),
                );
            } else {
                self.ts_notify(
                    "textDocument/didOpen",
                    Json::obj([(
                        "textDocument",
                        Json::obj([
                            ("uri", uri.into()),
                            ("languageId", "typescript".into()),
                            ("version", version.into()),
                            ("text", table.into()),
                        ]),
                    )]),
                );
            }
            self.routes[i].ts_open = self.ts.is_some();
        }
        let uris: Vec<String> = self.docs.iter().filter(|(_, d)| !d.ts_file).map(|(u, _)| u.clone()).collect();
        for uri in uris {
            let found = self.routes_of(&self.docs[&uri].path);
            let doc = self.docs.get_mut(&uri).expect("key from docs");
            if doc.routes != found {
                doc.routes = found;
                self.emit(&uri)?;
            }
            // The table they import changed, so their type errors may have.
            let doc = &self.docs[&uri];
            if changed && skip != Some(uri.as_str()) && doc.ts_open && doc.root.as_deref().is_some_and(|r| same_path(r, root)) {
                let (gen_uri, version) = (doc.gen_uri.clone(), doc.version);
                let params = Json::obj([("textDocument", Json::obj([("uri", gen_uri.into())]))]);
                self.ts_request("textDocument/diagnostic", params, Pending::Diagnostics { uri, version });
            }
        }
        Ok(())
    }

    /// The project root to analyze when `path` changes: a `.xzor` in a tsconfig project (`root`), or a `.ts`
    /// there when the project has providers (they import other `.ts` files) or it declares one. `text` is the
    /// document's text when open.
    fn di_root_of(&self, path: &Path, root: Option<&Path>, text: Option<&str>) -> Option<PathBuf> {
        let name = path.file_name()?.to_string_lossy();
        if !(name.ends_with(".xzor") || (name.ends_with(".ts") && !name.ends_with(".d.ts"))) {
            return None;
        }
        let root = root?;
        let relevant = name.ends_with(".xzor")
            || self.di_roots.iter().any(|r| same_path(&r.root, root) && !r.providers.is_empty())
            || match text {
                Some(t) => declares_provider(t),
                None => std::fs::read_to_string(path).is_ok_and(|t| declares_provider(&t)),
            };
        relevant.then(|| root.to_path_buf())
    }

    /// Whether a document of the project at `root` is open.
    fn has_docs(&self, root: &Path) -> bool {
        self.docs.values().any(|d| d.root.as_deref().is_some_and(|r| same_path(r, root)))
    }

    /// Forgets the DI state of a root whose last document closed, and stops its analyzer.
    fn di_retire(&mut self, root: &Path) {
        self.di_due.retain(|r| !same_path(r, root));
        if self.di_due.is_empty() {
            self.di_deadline = None;
        }
        self.di_marks.retain(|(r, _, _)| !same_path(r, root));
        if let Some(state) = self.di_roots.iter_mut().find(|r| same_path(&r.root, root)) {
            state.generation += 1;
            if let Some(worker) = state.worker.take() {
                // Stopping the analyzer can take a moment.
                std::thread::spawn(move || drop(worker));
            }
        }
    }

    fn di_state(&mut self, root: &Path) -> &mut DiRoot {
        let i = match self.di_roots.iter().position(|r| same_path(&r.root, root)) {
            Some(i) => i,
            None => {
                self.di_roots.push(DiRoot { root: root.to_path_buf(), generation: 0, providers: Vec::new(), worker: None, write: false });
                self.di_roots.len() - 1
            }
        };
        &mut self.di_roots[i]
    }

    /// Schedules a live analysis of `path`'s project after `DI_DEBOUNCE`; results of runs started before are dropped.
    fn di_schedule(&mut self, path: &Path, root: Option<&Path>, text: Option<&str>) {
        let Some(root) = self.di_root_of(path, root, text) else { return };
        self.di_state(&root).generation += 1;
        if !self.di_due.iter().any(|r| same_path(r, &root)) {
            self.di_due.push(root);
        }
        self.di_deadline = Some(Instant::now() + DI_DEBOUNCE);
    }

    /// Requests a DI analysis of `root`; while one runs, the root is queued once. `write` writes the generated providers.
    fn di_request(&mut self, root: PathBuf, write: bool) {
        if write {
            // This run also covers a pending live one.
            self.di_due.retain(|r| !same_path(r, &root));
            if self.di_due.is_empty() {
                self.di_deadline = None;
            }
        }
        let state = self.di_state(&root);
        state.generation += 1;
        state.write |= write;
        if !self.di_running {
            self.di_start(root);
        } else if !self.di_queue.iter().any(|r| same_path(r, &root)) {
            self.di_queue.push(root);
        }
    }

    /// Runs the DI analysis on a worker thread, with the open documents of `root` as overlays.
    fn di_start(&mut self, root: PathBuf) {
        let mut overlays = Vec::new();
        let mut open = Vec::new();
        let mut skip = Vec::new();
        for d in self.docs.values().filter(|d| d.root.as_deref().is_some_and(|r| same_path(r, &root))) {
            if d.ts_file {
                overlays.push((d.path.clone(), d.text.clone()));
                continue;
            }
            // While the text doesn't parse this is the last good compile; one that never compiled is read from disk.
            let Some(c) = &d.compiled else { continue };
            skip.push(d.path.clone());
            open.push(build::Compiled { source: d.path.clone(), out: output_path_in(&root, &d.path), text: c.text.clone(), generated: c.g.clone() });
        }
        let state = self.di_state(&root);
        let generation = state.generation;
        let write = std::mem::take(&mut state.write);
        let mut worker = state.worker.take().unwrap_or_else(|| DiWorker::new(&root));
        self.di_running = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker.run(&root, overlays, open, &skip, write)));
            let (marks, providers, worker) = match run {
                Ok((marks, providers)) => (marks, Some(providers), worker),
                Err(_) => (None, None, DiWorker::new(&root)),
            };
            let _ = tx.send(Event::Di { root, generation, marks, providers, worker });
        });
    }

    /// Publishes a finished analysis's diagnostics to the open documents they target (unless a newer request
    /// superseded it), clears the others, and starts the next queued run.
    fn di_done(
        &mut self,
        root: PathBuf,
        generation: u64,
        marks: Option<Vec<LocatedDiag>>,
        providers: Option<Vec<PathBuf>>,
        worker: Box<DiWorker>,
    ) -> io::Result<()> {
        self.di_running = false;
        let open = self.has_docs(&root);
        let state = self.di_state(&root);
        if let Some(providers) = providers {
            state.providers = providers;
        }
        if open {
            state.worker = Some(worker);
        } else {
            std::thread::spawn(move || drop(worker));
        }
        let current = state.generation == generation;
        if !self.di_queue.is_empty() {
            let next = self.di_queue.remove(0);
            self.di_start(next);
        }
        let Some(marks) = marks.filter(|_| current) else { return Ok(()) };
        self.di_marks.retain(|(r, _, _)| !same_path(r, &root));
        for m in marks {
            let d = Json::obj([
                ("range", Json::obj([("start", lsp_pos(m.start)), ("end", lsp_pos(m.end))])),
                ("severity", 1usize.into()),
                ("source", "xzor".into()),
                ("code", m.code.into()),
                ("message", m.message.into()),
            ]);
            match self.di_marks.iter_mut().find(|(r, p, _)| same_path(r, &root) && same_path(p, &m.source)) {
                Some((_, _, list)) => list.push(d),
                None => self.di_marks.push((root.clone(), m.source, vec![d])),
            }
        }
        let uris: Vec<String> = self.docs.keys().cloned().collect();
        for uri in uris {
            let di = self.di_of(&self.docs[&uri].path);
            let doc = self.docs.get_mut(&uri).expect("key from docs");
            if doc.di != di {
                doc.di = di;
                self.emit(&uri)?;
            }
        }
        Ok(())
    }

    /// The DI diagnostics last published for `path`.
    fn di_of(&self, path: &Path) -> Vec<Json> {
        self.di_marks.iter().filter(|(_, p, _)| same_path(p, path)).flat_map(|(_, _, d)| d.iter().cloned()).collect()
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
                ("source", "xzor".into()),
                ("message", e.message.clone().into()),
            ]));
        }
        // With a syntax error `compiled` is the last good compile, whose offsets may be stale.
        if doc.error.is_none() {
            for w in doc.compiled.iter().flat_map(|c| &c.g.warnings) {
                let name = doc.text.as_bytes().get(w.offset..).map_or(0, |b| b.iter().take_while(|&&c| crate::is_ident_char(c)).count());
                all.push(Json::obj([
                    ("range", range_json(&doc.text, w.offset, w.offset + name.max(1))),
                    ("severity", 2usize.into()),
                    ("source", "xzor".into()),
                    ("message", w.message.clone().into()),
                ]));
            }
        }
        all.extend(doc.di.iter().cloned());
        all.extend(doc.routes.iter().cloned());
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
            (Context::Tag { .. } | Context::Attr { .. } | Context::SlotName { .. } | Context::Route { .. }, _) | (_, None) => {
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
            | Context::SlotName { start, .. }
            | Context::Route { start, .. } => start,
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

    /// Source path, current text and compile for a generated `.xzor/…​.xzor.ts` path.
    fn source_of_generated(&self, gen_path: &Path) -> Option<(PathBuf, String, Compiled)> {
        let xzor_dir = gen_path.ancestors().find(|a| a.file_name().is_some_and(|n| n == ".xzor"))?;
        let rel = gen_path.strip_prefix(xzor_dir).ok()?;
        let rel = rel.to_string_lossy();
        let source = xzor_dir.parent()?.join(rel.strip_suffix(".ts")?);
        if let Some(doc) = self.docs.values().find(|d| same_path(&d.path, &source)) {
            return Some((source, doc.text.clone(), doc.compiled.clone()?));
        }
        let text = std::fs::read_to_string(&source).ok()?;
        let g = crate::compile_mapped(&text, &source).ok()?;
        Some((source, text.clone(), Compiled { text, g }))
    }

    /// A location's `(uri, range)` with generated files mapped to their `.xzor`;
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

    /// Maps a rename's edits to `.xzor` files, dropping edits on generated scaffolding.
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
                let legend = result["capabilities"]["semanticTokensProvider"]["legend"].clone();
                self.legend = (!legend.is_null()).then_some(legend);
                if let Some(client_id) = client_id {
                    self.respond(client_id, capabilities(&self.legend, &self.client_caps))?;
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

    /// xzor keywords offered alongside TypeScript completions right after `@`.
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

impl DiWorker {
    fn new(root: &Path) -> Box<Self> {
        Box::new(DiWorker { analyzer: Analyzer::new(root), providers: HashMap::new(), units: HashMap::new() })
    }

    /// Analyzes `root`: `overlays` are open `.ts` documents, `units` the in-memory compiles of open `.xzor`
    /// documents, `skip` their paths. Other files come from the caches when unchanged. Only a `write` run
    /// writes generated files. Returns the located diagnostics (`None` on failure) and the absolute provider files.
    fn run(
        &mut self,
        root: &Path,
        mut overlays: Vec<(PathBuf, String)>,
        mut units: Vec<build::Compiled>,
        skip: &[PathBuf],
        write: bool,
    ) -> (Option<Vec<LocatedDiag>>, Vec<PathBuf>) {
        let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let compile = |path: &Path| -> Option<build::Compiled> {
            if write {
                return compile_one(path).ok();
            }
            let text = std::fs::read_to_string(path).ok()?;
            let generated = crate::compile_mapped(&text, path).ok()?;
            Some(build::Compiled { source: path.to_path_buf(), out: output_path_in(root, path), text, generated })
        };
        let skip: HashSet<String> = skip.iter().map(|p| path_key(p)).collect();
        let open_ts: HashMap<String, usize> = overlays.iter().enumerate().map(|(i, (p, _))| (path_key(p), i)).collect();
        let mut old_providers = std::mem::take(&mut self.providers);
        let mut old_units = std::mem::take(&mut self.units);
        let mut files = Vec::new();
        let mut disk = Vec::new();
        let mut failed = false;
        for path in project_sources(root) {
            let key = path_key(&path);
            if path.extension().is_some_and(|e| e == "xzor") {
                if skip.contains(&key) {
                    if let Some(entry) = old_units.remove(&path) {
                        self.units.insert(path, entry);
                    }
                    continue;
                }
                let m = mtime(&path);
                let (unit, written) = match old_units.remove(&path) {
                    Some((om, u, written)) if Some(om) == m && (written || !write) => (u, written),
                    _ => match compile(&path) {
                        Some(u) => (u, write),
                        None => {
                            failed = true;
                            continue;
                        }
                    },
                };
                disk.push((m, written));
                units.push(unit);
                continue;
            }
            let declares = match open_ts.get(&key) {
                Some(&i) => declares_provider(&overlays[i].1),
                None => {
                    let m = mtime(&path);
                    let d = match old_providers.remove(&path) {
                        Some((om, d)) if Some(om) == m => d,
                        _ => std::fs::read_to_string(&path).is_ok_and(|t| declares_provider(&t)),
                    };
                    if let Some(m) = m {
                        self.providers.insert(path.clone(), (m, d));
                    }
                    d
                }
            };
            if declares {
                files.push(path.strip_prefix(root).map_or_else(|_| path.clone(), Path::to_path_buf));
            }
        }
        let providers = files.iter().map(|f| root.join(f)).collect();
        let open = units.len() - disk.len();
        let marks = if failed {
            None
        } else {
            // Open documents, and disk compiles whose generated file a live run did not write.
            let unwritten = units[open..].iter().zip(&disk).filter(|(_, (_, w))| !w).map(|(u, _)| u);
            overlays.extend(units[..open].iter().chain(unwritten).map(|u| (u.out.clone(), u.generated.code.clone())));
            match di_run(root, "main.ts", &units, &files, &mut self.analyzer, &overlays, write) {
                // The entry check is irrelevant here: only diagnostics are published.
                Ok(_) => Some(Vec::new()),
                Err(DiFailure::Diags(d)) => Some(located_diags(root, &d, &units, &overlays)),
                Err(DiFailure::Other(_)) => None,
            }
        };
        for (unit, (m, written)) in units.drain(open..).zip(disk) {
            if let Some(m) = m {
                self.units.insert(unit.source.clone(), (m, unit, written));
            }
        }
        (marks, providers)
    }
}

/// Moves DI diagnostics from `old` to `new` (one full-text change): those after the edited span shift,
/// those touching it are dropped until the next analysis.
fn shift_diags(old: &str, new: &str, diags: &[Json]) -> Vec<Json> {
    let (a, b) = (old.as_bytes(), new.as_bytes());
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let room = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(room).take_while(|(x, y)| x == y).count();
    let (old_end, new_end) = (a.len() - suffix, b.len() - suffix);
    diags
        .iter()
        .filter_map(|d| {
            let (s, e) = (offset_of(old, &d["range"]["start"]), offset_of(old, &d["range"]["end"]));
            let (s, e) = if s >= old_end {
                (s - old_end + new_end, e - old_end + new_end)
            } else if e <= prefix {
                (s, e)
            } else {
                return None;
            };
            let mut d = d.clone();
            d.set("range", range_json(new, s, e));
            Some(d)
        })
        .collect()
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

/// Feature providers: `(method, server capability, client capability)`. They are registered for `.xzor`
/// documents only, since a static capability would also apply to the `.ts` documents synced for DI.
const FEATURES: [(&str, &str, &str); 6] = [
    ("textDocument/completion", "completionProvider", "completion"),
    ("textDocument/hover", "hoverProvider", "hover"),
    ("textDocument/definition", "definitionProvider", "definition"),
    ("textDocument/references", "referencesProvider", "references"),
    ("textDocument/rename", "renameProvider", "rename"),
    ("textDocument/semanticTokens", "semanticTokensProvider", "semanticTokens"),
];

fn feature_options(capability: &str, legend: &Option<Json>) -> Option<Json> {
    match capability {
        "completionProvider" => Some(Json::parse(r#"{"triggerCharacters":["<","@",".","\""],"resolveProvider":true}"#).expect("valid options")),
        "semanticTokensProvider" => legend.clone().map(|legend| Json::obj([("legend", legend), ("full", true.into())])),
        _ => Some(Json::obj([])),
    }
}

fn dynamic(client: &Json, capability: &str) -> bool {
    client["textDocument"][capability]["dynamicRegistration"] == Json::Bool(true)
}

/// Static capabilities: the features the client cannot register dynamically.
fn capabilities(legend: &Option<Json>, client: &Json) -> Json {
    let mut caps = Json::parse(r#"{"textDocumentSync":{"openClose":true,"change":1,"save":{"includeText":false}}}"#).expect("valid capabilities");
    for (_, capability, client_capability) in FEATURES {
        if !dynamic(client, client_capability)
            && let Some(options) = feature_options(capability, legend)
        {
            caps.set(capability, options);
        }
    }
    Json::obj([("capabilities", caps), ("serverInfo", Json::obj([("name", "xzor".into())]))])
}

/// `client/registerCapability` registrations for the features the client registers dynamically.
fn registrations(legend: &Option<Json>, client: &Json) -> Vec<Json> {
    FEATURES
        .iter()
        .filter(|(_, _, client_capability)| dynamic(client, client_capability))
        .filter_map(|(method, capability, _)| {
            let mut options = feature_options(capability, legend)?;
            options.set("documentSelector", Json::Arr(vec![Json::obj([("language", "xzor".into())])]));
            Some(Json::obj([("id", (*method).into()), ("method", (*method).into()), ("registerOptions", options)]))
        })
        .collect()
}

/// Keeps TypeScript's semantic tokens that fall inside one mapping, at their `.xzor` position.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn diag(text: &str, needle: &str) -> Json {
        let at = text.find(needle).unwrap();
        Json::obj([("range", range_json(text, at, at + needle.len())), ("code", "ZDI02".into())])
    }

    fn start(d: &Json) -> (usize, usize) {
        (d["range"]["start"]["line"].as_usize().unwrap(), d["range"]["start"]["character"].as_usize().unwrap())
    }

    #[test]
    fn di_ranges_follow_edits_and_drop_when_touched() {
        let old = "class A {\n  constructor(x: X) {}\n}\n";
        let d = [diag(old, "x"), diag(old, "A")];
        let above = old.replace("class A", "// a\nclass A");
        let moved = shift_diags(old, &above, &d[..1]);
        assert_eq!(start(&moved[0]), (2, 14));
        // Indentation shared with the inserted line still shifts the range below it.
        let indented = old.replace("  constructor", "  y = 1;\n  constructor");
        assert_eq!(start(&shift_diags(old, &indented, &d[..1])[0]), (2, 14));
        // Deleting the line drops its range and keeps the one before.
        let gone = old.replace("  constructor(x: X) {}\n", "");
        let left = shift_diags(old, &gone, &d);
        assert_eq!(left.len(), 1);
        assert_eq!(start(&left[0]), (0, 6));
        // Editing inside the range drops it; editing after it keeps it.
        assert!(shift_diags(old, &old.replace("(x:", "(z:"), &d[..1]).is_empty());
        assert_eq!(start(&shift_diags(old, &old.replace("{}", "{ }"), &d[..1])[0]), (1, 14));
    }
}
