//! Project driver: `.tszor` -> `.zor/*.tszor.ts` (zor) -> type check -> `.js` bundle (bun).

pub use crate::analyzer::Analyzer;
use crate::codegen::Generated;
use crate::lsp::{offset_at, position_at, same_path};
use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::fs;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;

pub fn find_sources(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    if root.is_file() {
        out.push(root.to_path_buf());
        return Ok(out);
    }
    walk(root, &|n| n.ends_with(".tszor"), &mut out)?;
    out.sort();
    Ok(out)
}

/// Files under `dir` whose name passes `keep`, skipping dot-dirs, `node_modules`, `dist` and `target`.
fn walk(dir: &Path, keep: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if path.is_dir() {
            if !name.starts_with('.') && !matches!(&*name, "node_modules" | "dist" | "target") {
                walk(&path, keep, out)?;
            }
        } else if keep(&name) {
            out.push(path);
        }
    }
    Ok(())
}

/// Nearest ancestor directory holding a `tsconfig.json`, else the file's own directory.
pub fn project_root(source: &Path) -> PathBuf {
    let dir = source.parent().unwrap_or(Path::new("."));
    dir.ancestors()
        .find(|d| d.join("tsconfig.json").is_file())
        .unwrap_or(dir)
        .to_path_buf()
}

/// Whether a `.tszor` belongs to a TypeScript project (a `tsconfig.json` above it).
pub fn in_project(source: &Path) -> bool {
    source.parent().is_some_and(|d| d.ancestors().any(|a| a.join("tsconfig.json").is_file()))
}

/// `<root>/.zor/<relative source path>.ts`, the generated TypeScript (like Blazor's `obj/`).
pub fn output_path(source: &Path) -> PathBuf {
    let root = project_root(source);
    let rel = source.strip_prefix(&root).unwrap_or(source);
    let mut p = root.join(".zor").join(rel).into_os_string();
    p.push(".ts");
    p.into()
}

/// One compiled component: its source, generated file and mappings.
pub struct Compiled {
    pub source: PathBuf,
    pub out: PathBuf,
    pub text: String,
    pub generated: Generated,
}

/// Compiles every `.tszor` under `root` that belongs to a TypeScript project into that
/// project's `.zor/` directory, with a source map next to each generated file.
pub fn compile_all(root: &Path) -> Result<Vec<Compiled>, String> {
    let sources = find_sources(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut errors = Vec::new();
    let mut compiled = Vec::new();
    for src in sources.into_iter().filter(|s| in_project(s)) {
        match compile_one(&src) {
            Ok(unit) => compiled.push(unit),
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() { Ok(compiled) } else { Err(errors.join("\n")) }
}

/// Compiles one `.tszor` into its project's `.zor/`, with its source map.
pub fn compile_one(src: &Path) -> Result<Compiled, String> {
    let text = fs::read_to_string(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let generated = crate::compile_mapped(&text, src).map_err(|d| format!("{}:{d}", src.display()))?;
    let out = output_path(src);
    let name = src.file_name().unwrap_or_default().to_string_lossy();
    let map = generated.source_map(&text, &relative_from(out.parent().unwrap_or(Path::new(".")), src, &name));
    write_if_changed(&out, &generated.code)?;
    write_if_changed(&map_path(&out), &map)?;
    Ok(Compiled { source: src.to_path_buf(), out, text, generated })
}

fn map_path(out: &Path) -> PathBuf {
    let mut p = out.as_os_str().to_owned();
    p.push(".map");
    p.into()
}

/// Deletes the generated `.zor/*.tszor.ts` and `.map` of a removed `.tszor`.
pub fn remove_outputs(src: &Path) {
    let out = output_path(src);
    let _ = fs::remove_file(map_path(&out));
    let _ = fs::remove_file(out);
}

/// `"<type> <name>"` per `@inject`, to tell whether a component's DI inputs changed.
pub fn inject_signature(injects: &[crate::ast::Inject]) -> Vec<String> {
    injects.iter().map(|i| format!("{} {}", i.ty.text, i.name.text)).collect()
}

/// What one batch of watched changes requires.
#[derive(Debug, Default, PartialEq)]
pub struct WatchPlan {
    pub recompile: Vec<PathBuf>,
    pub remove: Vec<PathBuf>,
    pub di: bool,
    pub rebuild: bool,
}

fn is_source(name: &str) -> bool {
    name.ends_with(".tszor") || name.ends_with(".ts")
}

/// Whether a watched path (relative, `/`-separated) is outside the sources: our outputs, dependencies, dot-dirs.
fn watch_ignored(rel: &str) -> bool {
    rel.is_empty() || rel.split('/').any(|s| s.starts_with('.') || matches!(s, "dist" | "node_modules" | "target"))
}

/// The sources behind a batch of watched `paths` (relative to `root`): files, files under added
/// directories, and known files under removed ones. The flag is set when a directory-like path was
/// removed (its untracked `.ts` files may have gone too).
fn watch_files(paths: &[String], known_injects: &HashMap<PathBuf, Vec<String>>, provider_ts: &HashSet<PathBuf>, root: &Path) -> (Vec<PathBuf>, bool) {
    let mut files = Vec::new();
    let mut removed_dir = false;
    for rel in paths.iter().map(|p| p.replace('\\', "/")).filter(|p| !watch_ignored(p)) {
        let path = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if path.is_dir() {
            // A directory with known files reports their changes itself; only a new one needs walking.
            if !known_injects.keys().chain(provider_ts).any(|k| k.starts_with(&path)) {
                let _ = walk(&path, &is_source, &mut files);
            }
        } else if is_source(&rel) {
            files.push(path);
        } else if !path.exists() {
            files.extend(known_injects.keys().chain(provider_ts).filter(|k| k.starts_with(&path)).cloned());
            removed_dir |= !rel.rsplit('/').next().is_some_and(|s| s.contains('.'));
        }
    }
    files.sort();
    files.dedup();
    (files, removed_dir)
}

/// Components whose text mentions a changed `.tszor` file name: codegen reads imported components'
/// type parameters and prop kinds. Excludes the changed ones themselves.
pub fn dependents(units: &[Compiled], changed: &[&Path]) -> Vec<PathBuf> {
    let names: Vec<_> = changed.iter().map(|c| c.file_name().unwrap_or_default().to_string_lossy()).collect();
    units.iter().filter(|u| !changed.contains(&u.source.as_path()) && names.iter().any(|n| u.text.contains(&**n))).map(|u| u.source.clone()).collect()
}

/// Decides what a batch of watched `paths` (relative to `root`) requires. `known_injects` holds the
/// compiled `.tszor` files (by source path) with their `inject_signature`; `provider_ts` the provider `.ts` files.
pub fn watch_plan(paths: &[String], known_injects: &HashMap<PathBuf, Vec<String>>, provider_ts: &HashSet<PathBuf>, root: &Path) -> WatchPlan {
    let mut plan = WatchPlan::default();
    let (files, removed_dir) = watch_files(paths, known_injects, provider_ts, root);
    plan.rebuild = removed_dir;
    for path in files {
        let name = path.to_string_lossy();
        if !name.ends_with(".tszor") {
            plan.rebuild = true;
            // Providers import other `.ts` files, so any of them may change the generated providers.
            plan.di |= provider_ts.contains(&path)
                || (!name.ends_with(".d.ts") && (!provider_ts.is_empty() || fs::read_to_string(&path).is_ok_and(|t| declares_provider(&t))));
            continue;
        }
        let known = known_injects.get(&path);
        match fs::read_to_string(&path) {
            Ok(text) => {
                if known.is_none() && !in_project(&path) {
                    continue;
                }
                plan.di |= match known {
                    None => true,
                    Some(k) => crate::parser::parse(&text).is_ok_and(|(doc, _)| *k != inject_signature(&doc.injects)),
                };
                plan.recompile.push(path);
            }
            Err(_) if known.is_some() => {
                plan.di = true;
                plan.remove.push(path);
            }
            Err(_) => continue,
        }
        plan.rebuild = true;
    }
    plan
}

/// Brings `provider_ts` up to date with a batch of watched `paths`.
pub fn update_providers(provider_ts: &mut HashSet<PathBuf>, paths: &[String], known_injects: &HashMap<PathBuf, Vec<String>>, root: &Path) {
    for path in watch_files(paths, known_injects, provider_ts, root).0 {
        let name = path.to_string_lossy();
        if name.ends_with(".ts") && !name.ends_with(".d.ts") && fs::read_to_string(&path).is_ok_and(|t| declares_provider(&t)) {
            provider_ts.insert(path);
        } else {
            provider_ts.remove(&path);
        }
    }
}

const WATCH_SCRIPT: &str = include_str!("watch.ts");

/// The `bun watch.ts` child; killed on drop.
pub struct Watcher(Child);

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts watching `root`: the receiver yields each changed path, relative to `root` with `/` separators.
/// Returns once the watch is active.
pub fn watch(root: &Path) -> Result<(Watcher, mpsc::Receiver<String>), String> {
    let script = root.join("node_modules").join(".cache").join("zor").join("watch.ts");
    write_if_changed(&script, WATCH_SCRIPT)?;
    // stdin stays open: the watcher exits when it closes, even if zor is killed.
    let mut child = Command::new("bun")
        .arg(&script)
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("watch: failed to run bun: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let watcher = Watcher(child);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    // The first line is the empty "ready" line.
    rx.recv().map_err(|_| "watch: the file watcher exited".to_string())?;
    Ok((watcher, rx))
}

pub(crate) fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}

/// `to` relative to directory `from`, with forward slashes (`fallback` when unrelated).
fn relative_from(from: &Path, to: &Path, fallback: &str) -> String {
    let from: Vec<_> = from.components().collect();
    let target: Vec<_> = to.components().collect();
    let common = from.iter().zip(&target).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return fallback.to_string();
    }
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(target[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// Rewrites `file(line,col): message` lines that point into generated `.zor` files so they
/// point at the `.tszor` source instead. Paths are shown relative to `cwd` when possible.
pub fn map_tsc_output(output: &str, compiled: &[Compiled], cwd: &Path) -> String {
    let mut out = String::with_capacity(output.len());
    for line in output.split_inclusive('\n') {
        out.push_str(&map_tsc_line(line, compiled, cwd).unwrap_or_else(|| line.to_string()));
    }
    out
}

fn map_tsc_line(line: &str, compiled: &[Compiled], cwd: &Path) -> Option<String> {
    let open = line.find("(")?;
    let close = open + line[open..].find("): ")?;
    let (l, c) = line[open + 1..close].split_once(',')?;
    let (l, c): (usize, usize) = (l.trim().parse().ok()?, c.trim().parse().ok()?);
    let path = Path::new(line[..open].trim());
    let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    let unit = compiled.iter().find(|u| same_path(&normalize(&u.out), &normalize(&path)))?;
    let src = unit.generated.to_src_nearest(offset_at(&unit.generated.code, l - 1, c - 1));
    let (sl, sc) = position_at(&unit.text, src);
    let shown = unit.source.strip_prefix(cwd).map_or_else(|_| unit.source.display().to_string(), |p| p.display().to_string());
    Some(format!("{}({},{}){}", shown.replace('\\', "/"), sl + 1, sc + 1, &line[close + 1..]))
}

/// Removes `.` components so relative and absolute spellings compare equal.
fn normalize(p: &Path) -> PathBuf {
    p.components().filter(|c| !matches!(c, std::path::Component::CurDir)).collect()
}

/// Runs the type checker and prints its output with positions mapped back to `.tszor`
/// files. `checker` may contain `{dir}`. The default is TypeScript 7's
/// `tsc --noEmit -p <dir>`, launched through `bun x` when Bun is installed, else `npx`.
pub fn check(dir: &Path, checker: Option<&str>, compiled: &[Compiled]) -> Result<(), String> {
    let mut cmd = match checker {
        Some(c) => {
            let dir = dir.display().to_string();
            let parts: Vec<String> = c.split_whitespace().map(|p| p.replace("{dir}", &dir)).collect();
            let (program, args) = parts.split_first().ok_or("empty --checker command")?;
            let mut cmd = Command::new(program);
            cmd.args(args);
            cmd
        }
        None => {
            let has_bun = Command::new("bun").arg("--version").output().is_ok_and(|o| o.status.success());
            let mut cmd = if has_bun {
                let mut c = Command::new("bun");
                c.arg("x");
                c
            } else {
                Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" })
            };
            cmd.args(["tsc", "--noEmit", "--pretty", "false", "-p"]).arg(dir);
            cmd
        }
    };
    let output = cmd
        .output()
        .map_err(|e| format!("type check: failed to run {:?}: {e}", cmd.get_program()))?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    print!("{}", map_tsc_output(&text, compiled, &cwd));
    if output.status.success() { Ok(()) } else { Err(format!("type check failed ({})", output.status)) }
}

/// Compile-time DI: analyzes the project's providers, writes the generated providers into `.zor/`, and returns
/// `.zor/<entry>` when `entry` declares `@Mount` (that generated module is then the entry to bundle).
/// `analyzer` belongs to `root` and may be reused across runs.
pub fn di(root: &Path, entry: &str, compiled: &[Compiled], analyzer: &mut Analyzer) -> Result<Option<PathBuf>, String> {
    di_with(root, entry, compiled, &provider_files(root), analyzer)
}

/// `di` with the provider `files` (relative to `root`) already known.
pub fn di_with(root: &Path, entry: &str, compiled: &[Compiled], files: &[PathBuf], analyzer: &mut Analyzer) -> Result<Option<PathBuf>, String> {
    di_checked(root, entry, compiled, files, analyzer).map_err(|f| match f {
        DiFailure::Diags(d) => format_diags(root, &d, compiled, &std::env::current_dir().unwrap_or_default()),
        DiFailure::Other(e) => e,
    })
}

/// Why `di_checked` failed: analyzable diagnostics, or an infrastructure error.
pub enum DiFailure {
    Diags(Vec<crate::di::graph::Diag>),
    Other(String),
}

impl From<String> for DiFailure {
    fn from(e: String) -> Self {
        DiFailure::Other(e)
    }
}

/// `di` with its diagnostics left structured; `files` are `provider_files(root)`.
pub fn di_checked(root: &Path, entry: &str, compiled: &[Compiled], files: &[PathBuf], analyzer: &mut Analyzer) -> Result<Option<PathBuf>, DiFailure> {
    let zor = root.join(".zor");
    if files.is_empty() {
        let diags = unmounted_injects(root, compiled);
        if !diags.is_empty() {
            return Err(DiFailure::Diags(diags));
        }
        prune(&zor, &[])?;
        return Ok(None);
    }
    let mut components = Vec::new();
    for unit in compiled.iter().filter(|u| !u.generated.injects.is_empty()) {
        let rel = unit.out.strip_prefix(root).map_err(|_| format!("{}: error: generated file is outside {}, cannot analyze its @inject", unit.source.display(), root.display()))?;
        components.push(rel.to_string_lossy().into_owned());
    }
    let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
    let facts = analyzer.analyze(&files, &components, &[])?;
    let resolved = crate::di::graph::resolve(&facts).map_err(DiFailure::Diags)?;

    let entry = entry.replace('\\', "/");
    let entry = entry.strip_prefix("./").unwrap_or(&entry);
    let mount = resolved.iter().find_map(|r| Some((&r.provider.file, r.provider.mount.as_ref()?)));
    if let Some((file, m)) = mount.filter(|(file, _)| *file != entry) {
        let message = format!("@Mount must be declared in the entry module {entry}");
        let d = crate::di::graph::Diag { file: file.clone(), at: m.at, code: "ZDI07", message, inject: None, param_at: None };
        return Err(DiFailure::Diags(vec![d]));
    }
    let mut done: Vec<&str> = Vec::with_capacity(resolved.len());
    let mut written = Vec::with_capacity(resolved.len());
    for r in &resolved {
        let file = r.provider.file.as_str();
        if done.contains(&file) {
            continue;
        }
        done.push(file);
        let is_entry = mount.is_some() && file == entry;
        let out = zor.join(crate::di::emit::output_name(file, is_entry));
        let text = format!("{}\n{}", crate::di::emit::HEADER, crate::di::emit::emit_file(file, &resolved, is_entry));
        write_if_changed(&out, &text)?;
        written.push(out);
    }
    prune(&zor, &written)?;
    Ok(mount.map(|_| zor.join(entry)))
}

/// ZDI04 for every `@inject` when no `.ts` declares an application (same message as `di::graph` without `@Mount`).
fn unmounted_injects(root: &Path, compiled: &[Compiled]) -> Vec<crate::di::graph::Diag> {
    let mut out = Vec::new();
    for unit in compiled {
        let file = unit.source.strip_prefix(root).unwrap_or(&unit.source).display().to_string().replace('\\', "/");
        let name = unit.source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let class = crate::codegen::class_name(name.strip_suffix(".tszor").unwrap_or(&name));
        for i in &unit.generated.injects {
            let message = format!("{} (injected as {} in {class}) is not provided: no @Mount application", i.ty.text, i.name.text);
            out.push(crate::di::graph::Diag { file: file.clone(), at: 0, code: "ZDI04", message, inject: Some(i.name.text.clone()), param_at: None });
        }
    }
    out
}

/// Deletes DI-generated files (carrying the DI header) under `zor` that were not written in this run,
/// then the empty directories below `zor`.
fn prune(zor: &Path, written: &[PathBuf]) -> Result<(), String> {
    if !zor.is_dir() {
        return Ok(());
    }
    let mut files = Vec::new();
    walk(zor, &|n| n.ends_with(".ts") && !n.ends_with(".tszor.ts"), &mut files).map_err(|e| format!("{}: {e}", zor.display()))?;
    for file in files.iter().filter(|f| !written.contains(f)) {
        let mut first = String::new();
        let generated = fs::File::open(file).is_ok_and(|f| io::BufReader::new(f).read_line(&mut first).is_ok())
            && first.trim_end_matches(['\r', '\n']) == crate::di::emit::HEADER;
        if generated {
            fs::remove_file(file).map_err(|e| format!("{}: {e}", file.display()))?;
        }
    }
    remove_empty_dirs(zor).map(|_| ())
}

/// Removes the empty directories below `dir`, bottom-up (never `dir`); returns whether `dir` is left empty.
fn remove_empty_dirs(dir: &Path) -> Result<bool, String> {
    let err = |e: io::Error| format!("{}: {e}", dir.display());
    let mut empty = true;
    for entry in fs::read_dir(dir).map_err(err)? {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        if entry.file_type().map_err(err)?.is_dir() && remove_empty_dirs(&path)? {
            fs::remove_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        } else {
            empty = false;
        }
    }
    Ok(empty)
}

/// Whether a `.ts` source declares `@ServiceProvider` or `@Mount`.
pub fn declares_provider(text: &str) -> bool {
    text.lines().map(str::trim_start).any(|l| l.starts_with("@ServiceProvider(") || l.starts_with("@Mount("))
}

/// Project `.ts` files (relative to `root`) that declare `@ServiceProvider` or `@Mount`.
pub fn provider_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if root.is_dir() {
        let _ = walk(root, &|n| n.ends_with(".ts") && !n.ends_with(".d.ts"), &mut files);
    }
    files.retain(|p| fs::read_to_string(p).is_ok_and(|t| declares_provider(&t)));
    files.iter_mut().for_each(|p| *p = p.strip_prefix(root).map_or_else(|_| p.clone(), Path::to_path_buf));
    files
}

/// A DI diagnostic on a component's `@inject` type: LSP positions (0-based line, UTF-16 column).
pub struct InjectDiag {
    pub source: PathBuf,
    pub start: (usize, usize),
    pub end: (usize, usize),
    pub code: &'static str,
    pub message: String,
}

/// The component diagnostics among `diags` (ZDI04/ZDI05), located at the `@inject` type.
pub fn inject_diags(root: &Path, diags: &[crate::di::graph::Diag], compiled: &[Compiled]) -> Vec<InjectDiag> {
    let mut out = Vec::new();
    for d in diags {
        let Some(name) = &d.inject else { continue };
        let path = normalize(&root.join(&d.file));
        let Some(unit) = compiled.iter().find(|u| same_path(&normalize(&u.source), &path)) else { continue };
        let Some(i) = unit.generated.injects.iter().find(|i| i.name.text == *name).filter(|i| i.ty.at != crate::ast::Src::UNMAPPED) else { continue };
        let (start, end) = (position_at(&unit.text, i.ty.at), position_at(&unit.text, i.ty.at + i.ty.text.len()));
        out.push(InjectDiag { source: unit.source.clone(), start, end, code: d.code, message: d.message.clone() });
    }
    out
}

/// `file(line,col): error ZDInn: message` lines; positions are 1-based in the `.ts` or `.tszor` source.
fn format_diags(root: &Path, diags: &[crate::di::graph::Diag], compiled: &[Compiled], cwd: &Path) -> String {
    let mut out = String::new();
    for d in diags {
        let (file, at) = d.param_at.as_ref().map_or((&d.file, d.at), |(f, a)| (f, *a));
        let path = normalize(&root.join(file));
        let unit = compiled.iter().find(|u| same_path(&normalize(&u.source), &path));
        let (line, col) = match (&d.param_at, &d.inject, unit) {
            (None, Some(name), Some(u)) => position_at(&u.text, u.generated.injects.iter().find(|i| i.name.text == *name).map_or(0, |i| i.name.at)),
            (None, Some(_), None) => (0, 0),
            _ => {
                let text = fs::read_to_string(&path).unwrap_or_default();
                position_at(&text, utf16_to_byte(&text, at))
            }
        };
        let shown = path.strip_prefix(cwd).unwrap_or(&path).display().to_string().replace('\\', "/");
        if !out.is_empty() {
            out.push('\n');
        }
        let _ = write!(out, "{shown}({},{}): error {}: {}", line + 1, col + 1, d.code, d.message);
    }
    out
}

fn utf16_to_byte(text: &str, at: usize) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= at {
            return i;
        }
        units += c.len_utf16();
    }
    text.len()
}

const BUNDLE_SCRIPT: &str = include_str!("bundle.ts");

pub fn bundle(dir: &Path, entry: &str) -> Result<(), String> {
    let script = std::env::temp_dir().join(format!("zor-bundle-{}.ts", env!("CARGO_PKG_VERSION")));
    if fs::read_to_string(&script).ok().as_deref() != Some(BUNDLE_SCRIPT) {
        fs::write(&script, BUNDLE_SCRIPT).map_err(|e| format!("{}: {e}", script.display()))?;
    }
    let mut cmd = Command::new("bun");
    cmd.arg(&script).arg(dir.join(entry)).arg(dir.join("dist"));
    run(&mut cmd, "bundle")
}

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    let status = cmd
        .status()
        .map_err(|e| format!("{what}: failed to run {:?}: {e}", cmd.get_program()))?;
    if status.success() { Ok(()) } else { Err(format!("{what} failed ({status})")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_files_go_to_dot_zor_under_the_tsconfig_root() {
        let root = std::env::temp_dir().join(format!("zor-build-test-{}", std::process::id()));
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let src = root.join("pages").join("Home.tszor");

        assert_eq!(project_root(&src), root);
        assert_eq!(output_path(&src), root.join(".zor").join("pages").join("Home.tszor.ts"));
        fs::remove_dir_all(&root).unwrap();
    }

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("zor-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn only_files_in_a_typescript_project_compile() {
        let root = temp("projects");
        fs::create_dir_all(root.join("loose")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("loose").join("X.tszor"), "<p>@* not a project *@</p>").unwrap();
        fs::write(root.join("app").join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("app").join("A.tszor"), "<p/>").unwrap();

        let compiled = compile_all(&root).unwrap();
        assert_eq!(compiled.len(), 1);
        assert!(compiled[0].source.ends_with("A.tszor"));
        assert!(root.join("app/.zor/A.tszor.ts").is_file());
        assert!(root.join("app/.zor/A.tszor.ts.map").is_file());
        assert!(!root.join("loose/.zor").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tsc_errors_point_at_the_tszor_source() {
        let root = temp("tscmap");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("App.tszor"), "@code { n: number = 1; }\n<p>@n.foo</p>\n").unwrap();
        let compiled = compile_all(&root).unwrap();
        let c = &compiled[0];
        let at = c.generated.code.find(".foo").unwrap() + 1;
        let (line, col) = crate::lsp::position_at(&c.generated.code, at);
        let message = "error TS2339: Property 'foo' does not exist on type 'number'.";
        let absolute = format!("{}({},{}): {message}", c.out.display(), line + 1, col + 1);
        let relative = format!(".zor/App.tszor.ts({},{}): {message}", line + 1, col + 1);
        let output = format!("{absolute}\n{relative}\nFound 2 errors.\n");
        let expected = format!("App.tszor(2,7): {message}\nApp.tszor(2,7): {message}\nFound 2 errors.\n");
        assert_eq!(map_tsc_output(&output, &compiled, &root), expected);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn watch_batch_plan() {
        let root = temp("watchplan");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(root.join("services")).unwrap();
        fs::write(root.join("services/data.ts"), "@ServiceProvider()\nexport class S {}\n").unwrap();
        fs::write(root.join("util.ts"), "export const x = 1;\n").unwrap();
        fs::write(root.join("Counter.tszor"), "@inject IDatabase db\n<p>a</p>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let known: HashMap<PathBuf, Vec<String>> = units.iter().map(|u| (u.source.clone(), inject_signature(&u.generated.injects))).collect();
        let providers: HashSet<PathBuf> = provider_files(&root).into_iter().map(|p| root.join(p)).collect();
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &providers, &root);
        let counter = root.join("Counter.tszor");

        fs::write(&counter, "@inject IDatabase db\n<p>b</p>\n").unwrap();
        assert_eq!(plan(&["Counter.tszor"]), WatchPlan { recompile: vec![counter.clone()], remove: vec![], di: false, rebuild: true });
        fs::write(&counter, "@inject IDatabase other\n<p>b</p>\n").unwrap();
        assert_eq!(plan(&["Counter.tszor"]), WatchPlan { recompile: vec![counter.clone()], remove: vec![], di: true, rebuild: true });

        assert_eq!(plan(&["services/data.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        fs::write(root.join("util.ts"), "@Mount(App, \"app\")\nexport class M {}\n").unwrap();
        assert_eq!(plan(&["util.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        fs::write(root.join("util.ts"), "export const x = 2;\n").unwrap();
        // Providers import other `.ts` files, so with providers any `.ts` change reruns DI; without, only the rebuild.
        assert_eq!(plan(&["util.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        let no_providers = HashSet::new();
        let plan_without = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &no_providers, &root);
        assert_eq!(plan_without(&["util.ts"]), WatchPlan { rebuild: true, ..Default::default() });

        // Windows separators, as `fs.watch` reports them, behave like `/`.
        assert_eq!(plan(&["services\\data.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        assert_eq!(plan(&[".zor\\Counter.tszor.ts", "node_modules\\x\\index.ts", "dist\\a.ts", "target\\a.ts"]), WatchPlan::default());

        fs::write(root.join("New.tszor"), "<p/>\n").unwrap();
        assert_eq!(plan(&["New.tszor"]), WatchPlan { recompile: vec![root.join("New.tszor")], remove: vec![], di: true, rebuild: true });
        fs::remove_file(&counter).unwrap();
        assert_eq!(plan(&["Counter.tszor"]), WatchPlan { recompile: vec![], remove: vec![counter.clone()], di: true, rebuild: true });

        // Our own outputs (and tooling folders) never trigger a rebuild, so `--watch` cannot loop.
        fs::create_dir_all(root.join(".zor")).unwrap();
        fs::write(root.join(".zor/Counter.tszor.ts"), "").unwrap();
        let ignored = [".zor/Counter.tszor.ts", ".zor/X.tszor", "dist/main.js", "dist/a.ts", "target/debug/a.ts", "node_modules/x/index.ts", ".git/HEAD", ".git/a.ts", ""];
        assert_eq!(plan(&ignored), WatchPlan::default());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn watch_directory_events() {
        let root = temp("watchdirs");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(root.join("services")).unwrap();
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(root.join("services/data.ts"), "@ServiceProvider()\nexport class S {}\n").unwrap();
        fs::write(root.join("lib/Card.tszor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let known: HashMap<PathBuf, Vec<String>> = units.iter().map(|u| (u.source.clone(), inject_signature(&u.generated.injects))).collect();
        let providers: HashSet<PathBuf> = provider_files(&root).into_iter().map(|p| root.join(p)).collect();
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &providers, &root);

        // Directories holding known files report their children themselves.
        assert_eq!(plan(&["lib", "services"]), WatchPlan::default());

        // A newly added directory is walked.
        fs::create_dir_all(root.join("fresh/deep")).unwrap();
        fs::write(root.join("fresh/deep/New.tszor"), "<p/>\n").unwrap();
        let new = root.join("fresh/deep/New.tszor");
        assert_eq!(plan(&["fresh"]), WatchPlan { recompile: vec![new], remove: vec![], di: true, rebuild: true });

        // A removed directory maps to the known files under it; one with only untracked `.ts` files still rebuilds.
        fs::remove_dir_all(root.join("lib")).unwrap();
        assert_eq!(plan(&["lib"]), WatchPlan { recompile: vec![], remove: vec![root.join("lib/Card.tszor")], di: true, rebuild: true });
        let nothing_known = HashMap::new();
        let none = HashSet::new();
        let gone = vec!["scratch".to_string()];
        assert_eq!(watch_plan(&gone, &nothing_known, &none, &root), WatchPlan { rebuild: true, ..Default::default() });
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn watch_deleting_a_never_compiled_component_clears_it() {
        let root = temp("watchstale");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let bad = root.join("Bad.tszor");
        fs::write(&bad, "<p>\n").unwrap();
        assert!(compile_one(&bad).is_err());
        // watch_loop records `known.entry(src).or_default()` on failure.
        let known: HashMap<PathBuf, Vec<String>> = HashMap::from([(bad.clone(), Vec::new())]);
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &HashSet::new(), &root);
        fs::remove_file(&bad).unwrap();
        assert_eq!(plan(&["Bad.tszor"]), WatchPlan { recompile: vec![], remove: vec![bad], di: true, rebuild: true });
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dependents_mention_a_changed_component() {
        let root = temp("dependents");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("Card.tszor"), "<p/>\n").unwrap();
        fs::write(root.join("App.tszor"), "@import Card from \"./Card.tszor\"\n<Card/>\n").unwrap();
        fs::write(root.join("Other.tszor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let (card, other) = (root.join("Card.tszor"), root.join("Other.tszor"));
        assert_eq!(dependents(&units, &[card.as_path()]), vec![root.join("App.tszor")]);
        // Two changes mentioned by the same unit list it once; changed units are excluded.
        assert_eq!(dependents(&units, &[card.as_path(), other.as_path()]), vec![root.join("App.tszor")]);
        assert!(dependents(&units, &[other.as_path()]).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn compile_one_writes_only_its_outputs() {
        let root = temp("compileone");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.tszor"), "<p/>").unwrap();
        fs::write(root.join("B.tszor"), "<p/>").unwrap();
        let unit = compile_one(&root.join("A.tszor")).unwrap();
        assert_eq!(unit.out, root.join(".zor").join("A.tszor.ts"));
        assert!(root.join(".zor/A.tszor.ts").is_file() && root.join(".zor/A.tszor.ts.map").is_file());
        assert!(!root.join(".zor/B.tszor.ts").exists() && !root.join(".zor/B.tszor.ts.map").exists());
        remove_outputs(&root.join("A.tszor"));
        assert!(!root.join(".zor/A.tszor.ts").exists() && !root.join(".zor/A.tszor.ts.map").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    fn has_bun() -> bool {
        let ok = Command::new("bun").arg("--version").output().is_ok_and(|o| o.status.success());
        if !ok {
            println!("note: bun not found; skipping DI build test");
        }
        ok
    }

    /// A project under `target/` so `typescript` resolves from the repo's `node_modules`.
    fn di_project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.join("target").join("tmp-di-tests").join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("services")).unwrap();
        let runtime = manifest.join("runtime").join("index.ts").display().to_string().replace('\\', "/");
        let tsconfig = format!(
            r#"{{"compilerOptions":{{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","lib":["ESNext","DOM"],"strict":true,"noEmit":true,"skipLibCheck":true,"rootDirs":[".",".zor"],"paths":{{"@zor/runtime":["{runtime}"]}}}},"include":["**/*.ts",".zor/**/*.ts"]}}"#
        );
        fs::write(root.join("tsconfig.json"), tsconfig).unwrap();
        for (path, text) in files {
            fs::write(root.join(path), text).unwrap();
        }
        root
    }

    fn fixture(path: &str) -> String {
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/di").join(path)).unwrap()
    }

    /// `build::di` with an analyzer of its own, stopped before returning (so `root` can be deleted).
    fn di(root: &Path, entry: &str, compiled: &[Compiled]) -> Result<Option<PathBuf>, String> {
        super::di(root, entry, compiled, &mut Analyzer::new(root))
    }

    const COUNTER: &str = "@import { type IDatabase } from \"./services/data\"\n@inject IDatabase db\n<p>@db.name</p>\n";

    #[test]
    fn no_mount_keeps_entry() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("nomount", &[("main.ts", "console.log(1);\n"), ("services/data.ts", &data)]);
        let units = compile_all(&root).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(None));
        assert!(!root.join(".zor/main.ts").exists());
        assert!(root.join(".zor/services/data.provider.ts").is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_providers_runs_nothing() {
        let root = temp("noproviders");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        assert_eq!(di(&root, "main.ts", &[]), Ok(None));
        assert!(!root.join(".zor").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mount_writes_entry_and_providers() {
        if !has_bun() {
            return;
        }
        let (main, data) = (fixture("main.ts"), fixture("services/data.ts"));
        let app = "@import Counter from \"./Counter.tszor\"\n<div><Counter /></div>\n";
        let files = [("main.ts", &*main), ("services/data.ts", &*data), ("App.tszor", app), ("Counter.tszor", COUNTER)];
        let root = di_project("mount", &files);
        let units = compile_all(&root).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(Some(root.join(".zor").join("main.ts"))));
        assert!(root.join(".zor/services/data.provider.ts").is_file());
        let entry = fs::read_to_string(root.join(".zor/main.ts")).unwrap();
        assert!(entry.contains("Counter"), "{entry}");
        check(&root, None, &units).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_without_mount_is_an_error() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let files = [("main.ts", "console.log(1);\n"), ("services/data.ts", &*data), ("Counter.tszor", COUNTER)];
        let root = di_project("injectnomount", &files);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Counter.tszor(2,19): error ZDI04: IDatabase (injected as db in Counter) is not provided: no @Mount application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_without_any_application_is_an_error() {
        let root = temp("injectnoapp");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        fs::write(root.join("Page.tszor"), "@inject Clock clock\n<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Page.tszor(1,15): error ZDI04: Clock (injected as clock in Page) is not provided: no @Mount application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn zdi02_points_at_the_constructor_parameter() {
        if !has_bun() {
            return;
        }
        let db = "export class Log {}\nexport class Db {\n  /* ünï 🙂 */ constructor(readonly log: Log) {}\n}\n";
        let data = "import { ServiceProvider, Singleton } from \"@zor/runtime\";\nimport { Db } from \"./db\";\n@ServiceProvider()\n@Singleton(Db)\nexport class DataServices {}\n";
        let root = di_project("errors", &[("services/db.ts", db), ("services/data.ts", data)]);
        let err = di(&root, "main.ts", &[]).unwrap_err();
        let expected = "services/db.ts(3,37): error ZDI02: Log (needed by Db in provider DataServices) is not registered or imported";
        assert!(err.lines().any(|l| l.ends_with(expected) && !l.contains('\\')), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_errors_point_at_the_tszor() {
        if !has_bun() {
            return;
        }
        let main = "import { Mount, ServiceProvider } from \"@zor/runtime\";\nimport App from \"./App.tszor\";\n@Mount(App, \"app\")\n@ServiceProvider()\nexport class Application {}\n";
        let data = "export interface IDatabase { readonly name: string }\n";
        let files = [("main.ts", main), ("services/data.ts", data), ("App.tszor", "<p/>"), ("Counter.tszor", COUNTER)];
        let root = di_project("injecterr", &files);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Counter.tszor(2,19): error ZDI04: IDatabase (injected as db in Counter) is not provided by Application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mount_outside_the_entry_is_an_error() {
        if !has_bun() {
            return;
        }
        let main = "import { Mount, ServiceProvider } from \"@zor/runtime\";\nimport App from \"./App.tszor\";\n@Mount(App, \"app\")\n@ServiceProvider()\nexport class Application {}\n";
        let root = di_project("mountentry", &[("app.ts", main), ("App.tszor", "<p/>")]);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("app.ts(3,1): error ZDI07: @Mount must be declared in the entry module main.ts")), "{err}");
        assert!(!root.join(".zor/app.ts").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    const OTHER: &str = "import { ServiceProvider, Singleton } from \"@zor/runtime\";\nexport class Clock {}\n@ServiceProvider()\n@Singleton(Clock)\nexport class OtherServices {}\n";

    #[test]
    fn removed_provider_output_is_pruned() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("prune", &[("main.ts", "console.log(1);\n"), ("services/data.ts", &data), ("services/other.ts", OTHER)]);
        let units = compile_all(&root).unwrap();
        fs::create_dir_all(root.join(".zor")).unwrap();
        fs::write(root.join(".zor/keep.ts"), "export {};\n").unwrap();
        // One analyzer across the runs, as `--watch` and the LSP use it.
        let mut analyzer = Analyzer::new(&root);
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        let (data_out, other_out) = (root.join(".zor/services/data.provider.ts"), root.join(".zor/services/other.provider.ts"));
        assert!(data_out.is_file() && other_out.is_file());
        assert!(fs::read_to_string(&other_out).unwrap().starts_with(crate::di::emit::HEADER));

        fs::remove_file(root.join("services/other.ts")).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(data_out.is_file() && !other_out.exists());

        // The early-return path (no providers left) prunes too; foreign files stay.
        fs::remove_file(root.join("services/data.ts")).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(!data_out.exists());
        assert!(!root.join(".zor/services").exists());
        assert!(root.join(".zor/keep.ts").is_file());
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn removed_mount_prunes_the_entry() {
        if !has_bun() {
            return;
        }
        let (main, data) = (fixture("main.ts"), fixture("services/data.ts"));
        let app = "@import Counter from \"./Counter.tszor\"\n<div><Counter /></div>\n";
        let files = [("main.ts", &*main), ("services/data.ts", &*data), ("App.tszor", app), ("Counter.tszor", COUNTER)];
        let root = di_project("unmount", &files);
        let units = compile_all(&root).unwrap();
        let mut analyzer = Analyzer::new(&root);
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(Some(root.join(".zor").join("main.ts"))));
        assert!(root.join(".zor/main.ts").is_file());

        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        // Without @Mount, @inject would be ZDI04.
        fs::write(root.join("Counter.tszor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(!root.join(".zor/main.ts").exists());
        assert!(root.join(".zor/services/data.provider.ts").is_file());
        assert!(root.join(".zor/App.tszor.ts").is_file());
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn decorators_match_only_as_usage() {
        let root = temp("declares");
        fs::write(root.join("a.ts"), "// @ServiceProvider() in a comment\nconst s = \"@Mount(x)\";\n").unwrap();
        fs::write(root.join("b.ts"), "export class B {}\n  @ServiceProvider()\nexport class P {}\n").unwrap();
        fs::write(root.join("c.ts"), "@Mount(App, \"app\")\nexport class M {}\n").unwrap();
        assert_eq!(provider_files(&root), [PathBuf::from("b.ts"), PathBuf::from("c.ts")]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn analyzer_restarts_after_kill() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("restart", &[("services/data.ts", &data)]);
        let mut analyzer = Analyzer::new(&root);
        let files = ["services/data.ts".to_string()];
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        let first = analyzer.pid().unwrap();
        analyzer.kill();
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert_ne!(analyzer.pid(), Some(first));
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn analyzer_is_recycled_after_the_limit() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("recycle", &[("services/data.ts", &data)]);
        let mut analyzer = Analyzer::with_limit(&root, 2);
        let files = ["services/data.ts".to_string()];
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert!(analyzer.pid().is_some());
        let first = analyzer.pid();
        // The second answer reaches the limit, so the child is stopped.
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert_eq!(analyzer.pid(), None);
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert!(analyzer.pid().is_some() && analyzer.pid() != first);
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_removes_empty_dirs() {
        let root = temp("prunedirs");
        let zor = root.join(".zor");
        fs::create_dir_all(zor.join("a/b")).unwrap();
        fs::create_dir_all(zor.join("c")).unwrap();
        fs::create_dir_all(zor.join("d")).unwrap();
        fs::write(zor.join("c/x.provider.ts"), format!("{}\nexport {{}};\n", crate::di::emit::HEADER)).unwrap();
        fs::write(zor.join("d/keep.ts"), "export {};\n").unwrap();
        prune(&zor, &[]).unwrap();
        assert!(!zor.join("a").exists() && !zor.join("c").exists());
        assert!(zor.join("d/keep.ts").is_file());
        fs::remove_dir_all(zor.join("d")).unwrap();
        prune(&zor, &[]).unwrap();
        assert!(zor.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn component_without_a_unit_falls_back_to_the_start() {
        let root = temp("fallback");
        let diag = |inject: Option<&str>| crate::di::graph::Diag { file: "Missing.tszor".into(), at: 0, code: "ZDI04", message: "nope".into(), inject: inject.map(String::from), param_at: None };
        let out = format_diags(&root, &[diag(Some("db"))], &[], &root);
        assert_eq!(out, "Missing.tszor(1,1): error ZDI04: nope");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn component_outside_the_root_is_an_error() {
        let root = temp("outside");
        let other = temp("outside-other");
        fs::write(other.join("tsconfig.json"), "{}").unwrap();
        fs::write(other.join("C.tszor"), "@inject Thing t\n<p/>\n").unwrap();
        fs::write(root.join("p.ts"), "@ServiceProvider()\nexport class P {}\n").unwrap();
        let units = compile_all(&other).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.contains("C.tszor") && err.contains("outside"), "{err}");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&other).unwrap();
    }
}
