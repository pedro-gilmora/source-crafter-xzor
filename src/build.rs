//! Project driver: `.xzor` -> `.xzor/*.xzor.ts` (xzor) -> type check -> `.js` bundle (bun).

pub use crate::analyzer::Analyzer;
use crate::codegen::Generated;
use crate::lsp::{offset_at, position_at, same_path};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;
use std::fs;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

pub fn find_sources(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    if root.is_file() {
        out.push(root.to_path_buf());
        return Ok(out);
    }
    walk(root, &|n| n.ends_with(".xzor") && !n.ends_with(".css.xzor"), &mut out)?;
    out.sort();
    Ok(out)
}

/// Files under `dir` whose name passes `keep`, skipping dot-dirs, `node_modules`, `dist` and `target`.
fn walk(dir: &Path, keep: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if entry.file_type()?.is_dir() {
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

/// Whether a `.xzor` belongs to a TypeScript project (a `tsconfig.json` above it).
pub fn in_project(source: &Path) -> bool {
    source.parent().is_some_and(|d| d.ancestors().any(|a| a.join("tsconfig.json").is_file()))
}

/// The nearest ancestor directory holding a `tsconfig.json`, if any.
pub fn tsconfig_root(source: &Path) -> Option<PathBuf> {
    source.parent()?.ancestors().find(|d| d.join("tsconfig.json").is_file()).map(Path::to_path_buf)
}

/// `<root>/.xzor/<relative source path>.ts`, the generated TypeScript (like Blazor's `obj/`).
pub fn output_path(source: &Path) -> PathBuf {
    output_path_in(&project_root(source), source)
}

/// `output_path` for a `source` whose project root is known.
pub fn output_path_in(root: &Path, source: &Path) -> PathBuf {
    let rel = source.strip_prefix(root).unwrap_or(source);
    let mut p = root.join(".xzor").join(rel).into_os_string();
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

/// Compiles every `.xzor` under `root` that belongs to a TypeScript project into that
/// project's `.xzor/` directory, with a source map next to each generated file.
pub fn compile_all(root: &Path) -> Result<Vec<Compiled>, String> {
    let sources = find_sources(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let sources: Vec<PathBuf> = sources.into_iter().filter(|s| in_project(s)).collect();
    let mut errors = Vec::new();
    let mut compiled = Vec::new();
    for result in compile_many(&sources) {
        match result {
            Ok(unit) => compiled.push(unit),
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() { Ok(compiled) } else { Err(errors.join("\n")) }
}

/// `compile_one` over `sources` on all cores; one result per source, in the same order.
pub fn compile_many(sources: &[PathBuf]) -> Vec<Result<Compiled, String>> {
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(8).min(sources.len());
    if workers <= 1 {
        return sources.iter().map(|s| compile_one(s)).collect();
    }
    let next = AtomicUsize::new(0);
    let mut slots: Vec<Option<Result<Compiled, String>>> = sources.iter().map(|_| None).collect();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(src) = sources.get(i) else { break };
                        done.push((i, compile_one(src)));
                    }
                    done
                })
            })
            .collect();
        for handle in handles {
            for (i, result) in handle.join().unwrap_or_else(|e| std::panic::resume_unwind(e)) {
                slots[i] = Some(result);
            }
        }
    });
    slots.into_iter().flatten().collect()
}

/// Prints a unit's compile warnings to stderr (the CLI's; the LSP publishes them instead).
pub fn print_warnings(unit: &Compiled) {
    for w in &unit.generated.warnings {
        eprintln!("warning: {}:{}:{}: {}", unit.source.display(), w.line, w.column, w.message);
    }
}

/// Compiles one `.xzor` into its project's `.xzor/`, with its source map.
pub fn compile_one(src: &Path) -> Result<Compiled, String> {
    let text = fs::read_to_string(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let generated = crate::compile_mapped(&text, src).map_err(|d| format!("{}:{d}", src.display()))?;
    let out = output_path(src);
    let name = src.file_name().unwrap_or_default().to_string_lossy();
    let map = generated.source_map(&text, &relative_from(out.parent().unwrap_or(Path::new(".")), src, &name));
    let code_changed = write_if_changed(&out, &generated.code)?;
    write_if_changed(&map_path(&out), &map)?;
    match &generated.css {
        Some(css) => {
            write_if_changed(&css_path(&out), css)?;
        }
        // A styled component's code carries its scope id, so unchanged code had no sheet before either.
        None if code_changed => {
            let _ = fs::remove_file(css_path(&out));
        }
        None => {}
    }
    Ok(Compiled { source: src.to_path_buf(), out, text, generated })
}

/// Writes `<project root>/.xzor/routes.ts` per project among `units` (deleting it when the project
/// has no pages). `written` holds the roots with a table, so one that loses all its units is cleaned.
/// Route errors of every project fail like compile errors, as `<path>:<line>:<col>: <message>`.
/// Returns whether any table was written or deleted. `lazy` loads pages on demand (see `routes::table`).
pub fn write_routes(units: &[Compiled], written: &mut HashSet<PathBuf>, lazy: bool) -> Result<bool, String> {
    let mut changed = false;
    let mut groups: BTreeMap<PathBuf, Vec<&Compiled>> = BTreeMap::new();
    for u in units {
        groups.entry(project_root(&u.source)).or_default().push(u);
    }
    for root in written.iter() {
        groups.entry(root.clone()).or_default();
    }
    let mut errors = Vec::new();
    for (root, group) in groups {
        let path = root.join(".xzor").join("routes.ts");
        let pages_path = root.join(".xzor").join("pages.json");
        if !group.iter().any(|u| !u.generated.routes.is_empty() || u.generated.routes_block.is_some()) {
            changed |= fs::remove_file(&path).is_ok();
            let _ = fs::remove_file(&pages_path);
            written.remove(&root);
            continue;
        }
        let classes: Vec<String> = group
            .iter()
            .map(|u| {
                let name = u.source.file_name().unwrap_or_default().to_string_lossy();
                crate::codegen::class_name(name.strip_suffix(".xzor").unwrap_or(&name))
            })
            .collect();
        let views: Vec<crate::routes::Unit> = group
            .iter()
            .zip(&classes)
            .map(|(u, class)| crate::routes::Unit {
                source: &u.source,
                out: &u.out,
                text: &u.text,
                class,
                routes: &u.generated.routes,
                block: u.generated.routes_block.as_ref(),
            })
            .collect();
        let (table, diags) = crate::routes::table(&root, &views, lazy);
        if diags.is_empty() {
            changed |= write_if_changed(&path, &table)?;
            // Only a minified build splits pages into chunks that shells can preload.
            if lazy && views.iter().any(|v| !v.routes.is_empty()) {
                write_if_changed(&pages_path, &crate::routes::pages(&root, &views))?;
            } else {
                let _ = fs::remove_file(&pages_path);
            }
            written.insert(root);
        } else {
            errors.extend(diags.iter().map(|(file, d)| format!("{}:{d}", file.display())));
        }
    }
    if errors.is_empty() { Ok(changed) } else { Err(errors.join("\n")) }
}

fn map_path(out: &Path) -> PathBuf {
    let mut p = out.as_os_str().to_owned();
    p.push(".map");
    p.into()
}

/// `X.xzor.css` beside the generated `X.xzor.ts`.
fn css_path(out: &Path) -> PathBuf {
    out.with_extension("css")
}

/// Deletes the generated `.xzor/*.xzor.ts`, `.map` and `.css` of a removed `.xzor`.
pub fn remove_outputs(src: &Path) {
    let out = output_path(src);
    let _ = fs::remove_file(map_path(&out));
    let _ = fs::remove_file(css_path(&out));
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
    /// A `tsconfig.json` or `package.json` changed: recompile everything with a fresh analyzer.
    pub config: bool,
}

fn is_source(name: &str) -> bool {
    name.ends_with(".xzor") || name.ends_with(".ts")
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

/// Components that read something that changed: those whose text mentions a changed `.xzor` file name
/// (codegen reads imported components' type parameters and prop kinds), and those whose `@inherits`
/// chain probed a changed file (`Generated::deps`). Excludes the changed ones themselves.
pub fn dependents(units: &[Compiled], changed: &[&Path]) -> Vec<PathBuf> {
    let names: Vec<_> = changed.iter().filter_map(|c| c.file_name()).map(|n| n.to_string_lossy()).filter(|n| n.ends_with(".xzor")).collect();
    let changed_norm: Vec<PathBuf> = changed.iter().map(|c| normalize(c)).collect();
    units
        .iter()
        .filter(|u| {
            !changed.contains(&u.source.as_path())
                && (names.iter().any(|n| u.text.contains(&**n)) || u.generated.deps.iter().any(|d| changed_norm.iter().any(|c| same_path(c, d))))
        })
        .map(|u| u.source.clone())
        .collect()
}

/// The scripts among watched `paths` (relative to `root`), which `@inherits` bases may live in.
pub fn changed_scripts(paths: &[String], root: &Path) -> Vec<PathBuf> {
    paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .filter(|p| !watch_ignored(p) && (p.ends_with(".ts") || p.ends_with(".tsx")))
        .map(|p| root.join(p.replace('/', std::path::MAIN_SEPARATOR_STR)))
        .collect()
}

/// Decides what a batch of watched `paths` (relative to `root`) requires. `known_injects` holds the
/// compiled `.xzor` files (by source path) with their `inject_signature`; `provider_ts` the provider `.ts` files.
pub fn watch_plan(paths: &[String], known_injects: &HashMap<PathBuf, Vec<String>>, provider_ts: &HashSet<PathBuf>, root: &Path) -> WatchPlan {
    let mut plan = WatchPlan::default();
    if paths.iter().map(|p| p.replace('\\', "/")).any(|p| !watch_ignored(&p) && matches!(p.rsplit('/').next(), Some("tsconfig.json" | "package.json"))) {
        return WatchPlan { config: true, di: true, rebuild: true, ..WatchPlan::default() };
    }
    let (files, removed_dir) = watch_files(paths, known_injects, provider_ts, root);
    plan.rebuild = removed_dir;
    for path in files {
        let name = path.to_string_lossy();
        // A component's sibling style sheet: recompile the component.
        if let Some(stem) = name.strip_suffix(".css.xzor") {
            let component = PathBuf::from(format!("{stem}.xzor"));
            if component.is_file() && !plan.recompile.contains(&component) {
                plan.recompile.push(component);
            }
            plan.rebuild = true;
            continue;
        }
        if !name.ends_with(".xzor") {
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
    let script = root.join("node_modules").join(".cache").join("xzor").join("watch.ts");
    write_if_changed(&script, WATCH_SCRIPT)?;
    // stdin stays open: the watcher exits when it closes, even if xzor is killed.
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

/// Returns whether the file was written.
pub(crate) fn write_if_changed(path: &Path, content: &str) -> Result<bool, String> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// `to` relative to directory `from`, with forward slashes (`fallback` when unrelated).
pub(crate) fn relative_from(from: &Path, to: &Path, fallback: &str) -> String {
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

/// Rewrites `file(line,col): message` lines that point into generated `.xzor` files so they
/// point at the `.xzor` source instead. Paths are shown relative to `cwd` when possible.
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
    let unit = compiled.iter().find(|u| same_path(&normalize(&cwd.join(&u.out)), &normalize(&path)))?;
    let src = unit.generated.to_src_nearest(offset_at(&unit.generated.code, l - 1, c - 1));
    let (sl, sc) = position_at(&unit.text, src);
    let shown = unit.source.strip_prefix(cwd).map_or_else(|_| unit.source.display().to_string(), |p| p.display().to_string());
    Some(format!("{}({},{}){}", shown.replace('\\', "/"), sl + 1, sc + 1, &line[close + 1..]))
}

/// Removes `.` components so relative and absolute spellings compare equal.
fn normalize(p: &Path) -> PathBuf {
    p.components().filter(|c| !matches!(c, std::path::Component::CurDir)).collect()
}

/// Runs the type checker without printing: whether it passed, and its output with positions mapped back to
/// `.xzor` files (or the launch error). `checker` may contain `{dir}`. The default is TypeScript 7's
/// `tsc --noEmit -p <dir>`, launched through `bun x` when Bun is installed, else `npx`.
pub fn check_output(dir: &Path, checker: Option<&str>, compiled: &[Compiled]) -> (bool, String) {
    match run_checker(dir, checker, compiled) {
        Ok(r) => r,
        Err(e) => (false, format!("{e}\n")),
    }
}

fn run_checker(dir: &Path, checker: Option<&str>, compiled: &[Compiled]) -> Result<(bool, String), String> {
    static HAS_BUN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
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
            let has_bun = *HAS_BUN.get_or_init(|| Command::new("bun").arg("--version").output().is_ok_and(|o| o.status.success()));
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
    Ok((output.status.success(), map_tsc_output(&text, compiled, &cwd)))
}

/// Compile-time DI: analyzes the project's providers, writes the generated providers into `.xzor/`, and returns
/// `.xzor/<entry>` when `entry` declares `@Run` (that generated module is then the entry to bundle).
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
    di_run(root, entry, compiled, files, analyzer, &[], true)
}

/// `di_checked` reading `overlays` (path, text) instead of the disk; without `write` nothing is written or pruned.
pub fn di_run(
    root: &Path,
    entry: &str,
    compiled: &[Compiled],
    files: &[PathBuf],
    analyzer: &mut Analyzer,
    overlays: &[(PathBuf, String)],
    write: bool,
) -> Result<Option<PathBuf>, DiFailure> {
    let xzor = root.join(".xzor");
    if files.is_empty() {
        let diags = unmounted_injects(root, compiled);
        if !diags.is_empty() {
            return Err(DiFailure::Diags(diags));
        }
        if write {
            prune(&xzor, &[])?;
        }
        return Ok(None);
    }
    let mut components = Vec::new();
    for unit in compiled.iter().filter(|u| !u.generated.injects.is_empty()) {
        let rel = unit.out.strip_prefix(root).map_err(|_| format!("{}: error: generated file is outside {}, cannot analyze its @inject", unit.source.display(), root.display()))?;
        components.push(rel.to_string_lossy().into_owned());
    }
    let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
    let facts = analyzer.analyze(&files, &components, overlays)?;
    let resolved = crate::di::graph::resolve(&facts).map_err(DiFailure::Diags)?;

    let entry = entry.replace('\\', "/");
    let entry = entry.strip_prefix("./").unwrap_or(&entry);
    let mount = resolved.iter().find_map(|r| Some((&r.provider.file, r.provider.mount.as_ref()?)));
    if let Some((file, m)) = mount.filter(|(file, _)| *file != entry) {
        let message = format!("@Run must be declared in the entry module {entry}");
        let d = crate::di::graph::Diag { file: file.clone(), at: m.at, code: "ZDI07", message, inject: None, param_at: None };
        return Err(DiFailure::Diags(vec![d]));
    }
    if !write {
        return Ok(mount.map(|_| xzor.join(entry)));
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
        let out = xzor.join(crate::di::emit::output_name(file, is_entry));
        let text = format!("{}\n{}", crate::di::emit::HEADER, crate::di::emit::emit_file(file, &resolved, is_entry));
        write_if_changed(&out, &text)?;
        written.push(out);
    }
    prune(&xzor, &written)?;
    Ok(mount.map(|_| xzor.join(entry)))
}

/// ZDI04 for every `@inject` when no `.ts` declares an application (same message as `di::graph` without `@Run`).
fn unmounted_injects(root: &Path, compiled: &[Compiled]) -> Vec<crate::di::graph::Diag> {
    let mut out = Vec::new();
    for unit in compiled {
        let file = unit.source.strip_prefix(root).unwrap_or(&unit.source).display().to_string().replace('\\', "/");
        let name = unit.source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let class = crate::codegen::class_name(name.strip_suffix(".xzor").unwrap_or(&name));
        for i in &unit.generated.injects {
            let message = format!("{} (injected as {} in {class}) is not provided: no @Run application", i.ty.text, i.name.text);
            out.push(crate::di::graph::Diag { file: file.clone(), at: 0, code: "ZDI04", message, inject: Some(i.name.text.clone()), param_at: None });
        }
    }
    out
}

/// Deletes DI-generated files (carrying the DI header) under `xzor` that were not written in this run,
/// then the empty directories below `xzor`.
fn prune(xzor: &Path, written: &[PathBuf]) -> Result<(), String> {
    if !xzor.is_dir() {
        return Ok(());
    }
    let mut files = Vec::new();
    walk(xzor, &|n| n.ends_with(".ts") && !n.ends_with(".xzor.ts"), &mut files).map_err(|e| format!("{}: {e}", xzor.display()))?;
    for file in files.iter().filter(|f| !written.contains(f)) {
        let mut first = String::new();
        let generated = fs::File::open(file).is_ok_and(|f| io::BufReader::new(f).read_line(&mut first).is_ok())
            && first.trim_end_matches(['\r', '\n']) == crate::di::emit::HEADER;
        if generated {
            fs::remove_file(file).map_err(|e| format!("{}: {e}", file.display()))?;
        }
    }
    remove_empty_dirs(xzor).map(|_| ())
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

/// Whether a `.ts` source declares `@ServiceProvider`, `@Run` or the renamed `@Mount` (kept so the analyzer reports the rename).
pub fn declares_provider(text: &str) -> bool {
    text.lines().map(str::trim_start).any(|l| l.starts_with("@ServiceProvider(") || l.starts_with("@Run(") || l.starts_with("@Mount("))
}

/// Project `.ts` files (relative to `root`) that declare `@ServiceProvider` or `@Run`; `@Mount(` still matches so its rename error is reported.
pub fn provider_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if root.is_dir() {
        let _ = walk(root, &|n| n.ends_with(".ts") && !n.ends_with(".d.ts"), &mut files);
    }
    files.retain(|p| fs::read_to_string(p).is_ok_and(|t| declares_provider(&t)));
    files.iter_mut().for_each(|p| *p = p.strip_prefix(root).map_or_else(|_| p.clone(), Path::to_path_buf));
    files
}

/// Project `.ts` (not `.d.ts`) and `.xzor` files under `root`, skipping outputs and dependencies.
pub fn project_sources(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if root.is_dir() {
        let _ = walk(root, &|n| is_source(n) && !n.ends_with(".d.ts") && !n.ends_with(".css.xzor"), &mut files);
    }
    files
}

/// A DI diagnostic located in a source: LSP positions (0-based line, UTF-16 column).
pub struct LocatedDiag {
    pub source: PathBuf,
    pub start: (usize, usize),
    pub end: (usize, usize),
    pub code: &'static str,
    pub message: String,
}

/// Locates `diags`: component diagnostics at the `@inject` type, the rest at their parameter (`param_at`)
/// or registration (`file`/`at`) over the word there. `overlays` (path, text) are read instead of the disk.
pub fn located_diags(root: &Path, diags: &[crate::di::graph::Diag], compiled: &[Compiled], overlays: &[(PathBuf, String)]) -> Vec<LocatedDiag> {
    let mut out = Vec::with_capacity(diags.len());
    let mut read: Vec<(PathBuf, String)> = Vec::new();
    for d in diags {
        if let Some(name) = &d.inject {
            let path = normalize(&root.join(&d.file));
            let Some(unit) = compiled.iter().find(|u| same_path(&normalize(&u.source), &path)) else { continue };
            let Some(i) = unit.generated.injects.iter().find(|i| i.name.text == *name).filter(|i| i.ty.at != crate::ast::Src::UNMAPPED) else { continue };
            let (start, end) = (position_at(&unit.text, i.ty.at), position_at(&unit.text, i.ty.at + i.ty.text.len()));
            out.push(LocatedDiag { source: unit.source.clone(), start, end, code: d.code, message: d.message.clone() });
            continue;
        }
        let (file, at) = d.param_at.as_ref().map_or((&d.file, d.at), |(f, a)| (f, *a));
        let path = normalize(&root.join(file));
        let text = match overlays.iter().find(|(p, _)| same_path(p, &path)) {
            Some((_, t)) => t.as_str(),
            None => {
                let i = match read.iter().position(|(p, _)| *p == path) {
                    Some(i) => i,
                    None => {
                        let Ok(t) = fs::read_to_string(&path) else { continue };
                        read.push((path.clone(), t));
                        read.len() - 1
                    }
                };
                read[i].1.as_str()
            }
        };
        let start = utf16_to_byte(text, at);
        let word = text[start..].char_indices().find(|&(i, c)| !(c.is_alphanumeric() || c == '_' || c == '$' || (i == 0 && c == '@'))).map_or(text.len() - start, |(i, _)| i);
        let end = if word > 0 { start + word } else { text[start..].chars().next().map_or(start, |c| start + c.len_utf8()) };
        out.push(LocatedDiag { source: path, start: position_at(text, start), end: position_at(text, end), code: d.code, message: d.message.clone() });
    }
    out
}

/// `file(line,col): error ZDInn: message` lines; positions are 1-based in the `.ts` or `.xzor` source.
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

/// Bundles `entry` into `<dir>/dist`; returns the script's stdout (one output path per line).
/// `hot` passes `--hot`; `watch` passes `--watch`, which keeps the script from touching `sw.js`;
/// `minify` minifies and splits the bundle into chunks.
pub fn bundle(dir: &Path, entry: &str, hot: bool, watch: bool, minify: bool) -> Result<String, String> {
    let script = std::env::temp_dir().join(format!("xzor-bundle-{}.ts", env!("CARGO_PKG_VERSION")));
    if fs::read_to_string(&script).ok().as_deref() != Some(BUNDLE_SCRIPT) {
        fs::write(&script, BUNDLE_SCRIPT).map_err(|e| format!("{}: {e}", script.display()))?;
    }
    let mut cmd = Command::new("bun");
    cmd.arg(&script).arg(dir.join(entry)).arg(dir.join("dist"));
    if hot {
        cmd.arg("--hot");
    }
    if watch {
        cmd.arg("--watch");
    }
    if minify {
        cmd.arg("--minify");
        let pages = dir.join(".xzor").join("pages.json");
        if pages.is_file() {
            cmd.arg("--pages").arg(std::path::absolute(&pages).unwrap_or(pages));
        }
    }
    cmd.stderr(Stdio::inherit());
    let output = cmd.output().map_err(|e| format!("bundle: failed to run {:?}: {e}", cmd.get_program()))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!("bundle failed ({})", output.status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_files_go_to_dot_xzor_under_the_tsconfig_root() {
        let root = std::env::temp_dir().join(format!("xzor-build-test-{}", std::process::id()));
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let src = root.join("pages").join("Home.xzor");

        assert_eq!(project_root(&src), root);
        assert_eq!(output_path(&src), root.join(".xzor").join("pages").join("Home.xzor.ts"));
        fs::remove_dir_all(&root).unwrap();
    }

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("xzor-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_routes(units: &[Compiled], written: &mut HashSet<PathBuf>) -> Result<bool, String> {
        super::write_routes(units, written, false)
    }

    #[test]
    fn compile_many_matches_sequential() {
        let root = temp("compile-many");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        for i in 0..40 {
            let body = if i == 0 { "<p/>".to_string() } else { format!("@import C{0} from \"./C{0}.xzor\"\n<C{0} />", i - 1) };
            fs::write(root.join(format!("C{i}.xzor")), body).unwrap();
        }
        fs::write(root.join("Bad.xzor"), "<p>").unwrap();
        let sources = find_sources(&root).unwrap();

        let parallel = compile_many(&sources);
        let sequential: Vec<_> = sources.iter().map(|s| compile_one(s)).collect();
        assert_eq!(parallel.len(), sequential.len());
        for (p, s) in parallel.iter().zip(&sequential) {
            match (p, s) {
                (Ok(p), Ok(s)) => {
                    assert_eq!(p.generated.code, s.generated.code);
                    assert_eq!(p.out, s.out);
                }
                (Err(p), Err(s)) => assert_eq!(p, s),
                _ => panic!("results differ"),
            }
        }
        assert_eq!(parallel.iter().filter(|r| r.is_err()).count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_files_in_a_typescript_project_compile() {
        let root = temp("projects");
        fs::create_dir_all(root.join("loose")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("loose").join("X.xzor"), "<p>@* not a project *@</p>").unwrap();
        fs::write(root.join("app").join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("app").join("A.xzor"), "<p/>").unwrap();

        let compiled = compile_all(&root).unwrap();
        assert_eq!(compiled.len(), 1);
        assert!(compiled[0].source.ends_with("A.xzor"));
        assert!(root.join("app/.xzor/A.xzor.ts").is_file());
        assert!(root.join("app/.xzor/A.xzor.ts.map").is_file());
        assert!(!root.join("loose/.xzor").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn tsc_errors_point_at_the_xzor_source() {
        let root = temp("tscmap");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("App.xzor"), "@code { n: number = 1; }\n<p>@n.foo</p>\n").unwrap();
        let compiled = compile_all(&root).unwrap();
        let c = &compiled[0];
        let at = c.generated.code.find(".foo").unwrap() + 1;
        let (line, col) = crate::lsp::position_at(&c.generated.code, at);
        let message = "error TS2339: Property 'foo' does not exist on type 'number'.";
        let absolute = format!("{}({},{}): {message}", c.out.display(), line + 1, col + 1);
        let relative = format!(".xzor/App.xzor.ts({},{}): {message}", line + 1, col + 1);
        let output = format!("{absolute}\n{relative}\nFound 2 errors.\n");
        let expected = format!("App.xzor(2,7): {message}\nApp.xzor(2,7): {message}\nFound 2 errors.\n");
        assert_eq!(map_tsc_output(&output, &compiled, &root), expected);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn maps_tsc_output_for_relative_out() {
        let root = temp("tscrelative");
        let source = root.join("x").join("A.xzor");
        let text = "@code { n: number = 1; }\n<p>@n.foo</p>\n".to_string();
        let generated = crate::compile_mapped(&text, &source).unwrap();
        let at = generated.code.find(".foo").unwrap() + 1;
        let (line, col) = crate::lsp::position_at(&generated.code, at);
        let out = PathBuf::from("x").join(".xzor").join("A.xzor.ts");
        let compiled = vec![Compiled { source, out: out.clone(), text, generated }];
        let tsc = format!("{}({},{}): error TS1: m\n", root.join(&out).display(), line + 1, col + 1);
        assert_eq!(map_tsc_output(&tsc, &compiled, &root), "x/A.xzor(2,7): error TS1: m\n");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn watch_batch_plan() {
        let root = temp("watchplan");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(root.join("services")).unwrap();
        fs::write(root.join("services/data.ts"), "@ServiceProvider()\nexport class S {}\n").unwrap();
        fs::write(root.join("util.ts"), "export const x = 1;\n").unwrap();
        fs::write(root.join("Counter.xzor"), "@inject IDatabase db\n<p>a</p>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let known: HashMap<PathBuf, Vec<String>> = units.iter().map(|u| (u.source.clone(), inject_signature(&u.generated.injects))).collect();
        let providers: HashSet<PathBuf> = provider_files(&root).into_iter().map(|p| root.join(p)).collect();
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &providers, &root);
        let counter = root.join("Counter.xzor");

        fs::write(&counter, "@inject IDatabase db\n<p>b</p>\n").unwrap();
        assert_eq!(plan(&["Counter.xzor"]), WatchPlan { recompile: vec![counter.clone()], remove: vec![], di: false, rebuild: true, config: false });
        fs::write(&counter, "@inject IDatabase other\n<p>b</p>\n").unwrap();
        assert_eq!(plan(&["Counter.xzor"]), WatchPlan { recompile: vec![counter.clone()], remove: vec![], di: true, rebuild: true, config: false });

        assert_eq!(plan(&["services/data.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        fs::write(root.join("util.ts"), "@Run(App, \"app\")\nexport class M {}\n").unwrap();
        assert_eq!(plan(&["util.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        fs::write(root.join("util.ts"), "export const x = 2;\n").unwrap();
        // Providers import other `.ts` files, so with providers any `.ts` change reruns DI; without, only the rebuild.
        assert_eq!(plan(&["util.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        let no_providers = HashSet::new();
        let plan_without = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &no_providers, &root);
        assert_eq!(plan_without(&["util.ts"]), WatchPlan { rebuild: true, ..Default::default() });

        // Windows separators, as `fs.watch` reports them, behave like `/`.
        assert_eq!(plan(&["services\\data.ts"]), WatchPlan { di: true, rebuild: true, ..Default::default() });
        assert_eq!(plan(&[".xzor\\Counter.xzor.ts", "node_modules\\x\\index.ts", "dist\\a.ts", "target\\a.ts"]), WatchPlan::default());

        fs::write(root.join("New.xzor"), "<p/>\n").unwrap();
        assert_eq!(plan(&["New.xzor"]), WatchPlan { recompile: vec![root.join("New.xzor")], remove: vec![], di: true, rebuild: true, config: false });
        fs::remove_file(&counter).unwrap();
        assert_eq!(plan(&["Counter.xzor"]), WatchPlan { recompile: vec![], remove: vec![counter.clone()], di: true, rebuild: true, config: false });

        // Our own outputs (and tooling folders) never trigger a rebuild, so `--watch` cannot loop.
        fs::create_dir_all(root.join(".xzor")).unwrap();
        fs::write(root.join(".xzor/Counter.xzor.ts"), "").unwrap();
        let ignored = [".xzor/Counter.xzor.ts", ".xzor/X.xzor", "dist/main.js", "dist/a.ts", "target/debug/a.ts", "node_modules/x/index.ts", ".git/HEAD", ".git/a.ts", ""];
        assert_eq!(plan(&ignored), WatchPlan::default());

        // Project configuration changes start over: everything recompiles and DI reruns on a fresh analyzer.
        for config in ["tsconfig.json", "package.json", "sub/tsconfig.json"] {
            assert_eq!(plan(&[config]), WatchPlan { config: true, di: true, rebuild: true, ..Default::default() }, "{config}");
        }
        assert_eq!(plan(&["node_modules/x/package.json", "data.json"]), WatchPlan::default());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn watch_directory_events() {
        let root = temp("watchdirs");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(root.join("services")).unwrap();
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(root.join("services/data.ts"), "@ServiceProvider()\nexport class S {}\n").unwrap();
        fs::write(root.join("lib/Card.xzor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let known: HashMap<PathBuf, Vec<String>> = units.iter().map(|u| (u.source.clone(), inject_signature(&u.generated.injects))).collect();
        let providers: HashSet<PathBuf> = provider_files(&root).into_iter().map(|p| root.join(p)).collect();
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &providers, &root);

        // Directories holding known files report their children themselves.
        assert_eq!(plan(&["lib", "services"]), WatchPlan::default());

        // A newly added directory is walked.
        fs::create_dir_all(root.join("fresh/deep")).unwrap();
        fs::write(root.join("fresh/deep/New.xzor"), "<p/>\n").unwrap();
        let new = root.join("fresh/deep/New.xzor");
        assert_eq!(plan(&["fresh"]), WatchPlan { recompile: vec![new], remove: vec![], di: true, rebuild: true, config: false });

        // A removed directory maps to the known files under it; one with only untracked `.ts` files still rebuilds.
        fs::remove_dir_all(root.join("lib")).unwrap();
        assert_eq!(plan(&["lib"]), WatchPlan { recompile: vec![], remove: vec![root.join("lib/Card.xzor")], di: true, rebuild: true, config: false });
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
        let bad = root.join("Bad.xzor");
        fs::write(&bad, "<p>\n").unwrap();
        assert!(compile_one(&bad).is_err());
        // watch_loop records `known.entry(src).or_default()` on failure.
        let known: HashMap<PathBuf, Vec<String>> = HashMap::from([(bad.clone(), Vec::new())]);
        let plan = |paths: &[&str]| watch_plan(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(), &known, &HashSet::new(), &root);
        fs::remove_file(&bad).unwrap();
        assert_eq!(plan(&["Bad.xzor"]), WatchPlan { recompile: vec![], remove: vec![bad], di: true, rebuild: true, config: false });
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dependents_mention_a_changed_component() {
        let root = temp("dependents");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("Card.xzor"), "<p/>\n").unwrap();
        fs::write(root.join("App.xzor"), "@import Card from \"./Card.xzor\"\n<Card/>\n").unwrap();
        fs::write(root.join("Other.xzor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let (card, other) = (root.join("Card.xzor"), root.join("Other.xzor"));
        assert_eq!(dependents(&units, &[card.as_path()]), vec![root.join("App.xzor")]);
        // Two changes mentioned by the same unit list it once; changed units are excluded.
        assert_eq!(dependents(&units, &[card.as_path(), other.as_path()]), vec![root.join("App.xzor")]);
        assert!(dependents(&units, &[other.as_path()]).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn dependents_cover_inherited_ts_bases() {
        let root = temp("dependents-ts");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("App.xzor"), "@import { Titled } from \"./base\"\n@inherits Titled\n<p/>\n").unwrap();
        fs::write(root.join("Dir.xzor"), "@import { Titled } from \"./shared\"\n@inherits Titled\n<p/>\n").unwrap();
        fs::write(root.join("Plain.xzor"), "<p>base</p>\n").unwrap();
        let units = compile_all(&root).unwrap();
        assert_eq!(dependents(&units, &[root.join("base.ts").as_path()]), vec![root.join("App.xzor")]);
        assert_eq!(dependents(&units, &[root.join("shared").join("index.ts").as_path()]), vec![root.join("Dir.xzor")]);
        assert_eq!(dependents(&units, &[root.join("base.d.ts").as_path()]), vec![root.join("App.xzor")]);
        assert!(dependents(&units, &[root.join("base.js").as_path()]).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn changed_scripts_keep_declaration_files() {
        let root = Path::new("/p");
        let paths: Vec<String> = ["base.d.ts", "a.ts", "b.tsx", "C.xzor", "node_modules/x/i.d.ts", ".xzor/C.xzor.ts"].iter().map(|p| p.to_string()).collect();
        assert_eq!(changed_scripts(&paths, root), vec![root.join("base.d.ts"), root.join("a.ts"), root.join("b.tsx")]);
    }

    #[test]
    fn dependents_follow_the_whole_inherits_chain() {
        let root = temp("dependents-chain");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("a.ts"), "export class A { a = 1; }\n").unwrap();
        fs::write(root.join("b.ts"), "import { A } from \"./a\";\nexport class B extends A { b = 1; }\n").unwrap();
        fs::write(root.join("C.xzor"), "@import { B } from \"./b\"\n@inherits B\n<p/>\n").unwrap();
        // Mentions `a` and `@inherits` but never reaches a.ts.
        fs::write(root.join("D.xzor"), "@import { Pkg } from \"pkg\"\n@inherits Pkg\n<p>a</p>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let c = vec![root.join("C.xzor")];
        assert_eq!(dependents(&units, &[root.join("a.ts").as_path()]), c);
        assert_eq!(dependents(&units, &[root.join("b.ts").as_path()]), c);
        assert!(dependents(&units, &[root.join("zzz.ts").as_path()]).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn compile_one_writes_only_its_outputs() {
        let root = temp("compileone");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.xzor"), "<p/>").unwrap();
        fs::write(root.join("B.xzor"), "<p/>").unwrap();
        let unit = compile_one(&root.join("A.xzor")).unwrap();
        assert_eq!(unit.out, root.join(".xzor").join("A.xzor.ts"));
        assert!(root.join(".xzor/A.xzor.ts").is_file() && root.join(".xzor/A.xzor.ts.map").is_file());
        assert!(!root.join(".xzor/B.xzor.ts").exists() && !root.join(".xzor/B.xzor.ts.map").exists());
        remove_outputs(&root.join("A.xzor"));
        assert!(!root.join(".xzor/A.xzor.ts").exists() && !root.join(".xzor/A.xzor.ts.map").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_routes_writes_and_removes() {
        let root = temp("routes-write");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.xzor"), "@page \"/a\"\n<p/>").unwrap();
        fs::write(root.join("B.xzor"), "@page \"/b/:id\"\n<p/>").unwrap();
        let units = compile_all(&root).unwrap();
        write_routes(&units, &mut HashSet::new()).unwrap();
        let table = fs::read_to_string(root.join(".xzor/routes.ts")).unwrap();
        assert!(table.contains("\"/a\"") && table.contains("\"/b/:id\""), "{table}");

        fs::write(root.join("A.xzor"), "<p/>").unwrap();
        fs::write(root.join("B.xzor"), "<p/>").unwrap();
        let units = compile_all(&root).unwrap();
        write_routes(&units, &mut HashSet::new()).unwrap();
        assert!(!root.join(".xzor/routes.ts").exists());
        write_routes(&units, &mut HashSet::new()).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn minified_builds_write_the_page_list_and_others_drop_it() {
        let root = temp("pages-json");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.xzor"), "@page \"/a\"\n<p/>").unwrap();
        let units = compile_all(&root).unwrap();
        super::write_routes(&units, &mut HashSet::new(), true).unwrap();
        let json = fs::read_to_string(root.join(".xzor/pages.json")).unwrap();
        assert_eq!(json, r#"[{"pattern":"/a","file":"A.xzor","name":"A"}]"#);
        super::write_routes(&units, &mut HashSet::new(), false).unwrap();
        assert!(!root.join(".xzor/pages.json").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sibling_projects_each_get_their_own_table() {
        let root = temp("routes-siblings");
        for app in ["app1", "app2"] {
            fs::create_dir_all(root.join(app)).unwrap();
            fs::write(root.join(app).join("tsconfig.json"), "{}").unwrap();
            fs::write(root.join(app).join("Home.xzor"), "@page \"/x\"\n<p/>").unwrap();
        }
        let units = compile_all(&root).unwrap();
        write_routes(&units, &mut HashSet::new()).unwrap();
        for app in ["app1", "app2"] {
            let table = fs::read_to_string(root.join(app).join(".xzor/routes.ts")).unwrap();
            assert!(table.contains("from \"./Home.xzor\""), "{table}");
        }
        assert!(!root.join(".xzor/routes.ts").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn building_a_project_subdirectory_writes_the_table_at_the_project_root() {
        let root = temp("routes-subdir");
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("pages/Home.xzor"), "@page \"/\"\n<p/>").unwrap();
        let units = compile_all(&root.join("pages")).unwrap();
        write_routes(&units, &mut HashSet::new()).unwrap();
        let table = fs::read_to_string(root.join(".xzor/routes.ts")).unwrap();
        assert!(table.contains("from \"./pages/Home.xzor\""), "{table}");
        assert!(!root.join("pages/.xzor").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn compiling_a_single_file_does_not_treat_it_as_a_directory() {
        let root = temp("routes-file");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("Y.xzor"), "@page \"/y\"\n<p/>").unwrap();
        let units = compile_all(&root.join("Y.xzor")).unwrap();
        write_routes(&units, &mut HashSet::new()).unwrap();
        assert!(root.join(".xzor/routes.ts").is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn route_errors_of_every_project_are_reported() {
        let root = temp("routes-errors");
        for app in ["app1", "app2"] {
            fs::create_dir_all(root.join(app)).unwrap();
            fs::write(root.join(app).join("tsconfig.json"), "{}").unwrap();
            fs::write(root.join(app).join("A.xzor"), "@page \"/x\"\n<p/>").unwrap();
            fs::write(root.join(app).join("B.xzor"), "@page \"/x\"\n<p/>").unwrap();
        }
        let units = compile_all(&root).unwrap();
        let e = write_routes(&units, &mut HashSet::new()).unwrap_err();
        assert!(e.contains("app1") && e.contains("app2"), "{e}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_root_that_lost_all_its_units_loses_its_table() {
        let root = temp("routes-stale");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.xzor"), "@page \"/a\"\n<p/>").unwrap();
        let mut written = HashSet::new();
        write_routes(&compile_all(&root).unwrap(), &mut written).unwrap();
        assert!(root.join(".xzor/routes.ts").is_file());
        write_routes(&[], &mut written).unwrap();
        assert!(!root.join(".xzor/routes.ts").exists() && written.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn table_errors_fail_the_build() {
        let root = temp("routes-dup");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("A.xzor"), "@page \"/x\"\n<p/>").unwrap();
        fs::write(root.join("B.xzor"), "@page \"/x\"\n<p/>").unwrap();
        let units = compile_all(&root).unwrap();
        let e = write_routes(&units, &mut HashSet::new()).unwrap_err();
        assert!(e.contains("B.xzor:1:8: duplicate route pattern \"/x\" (also in A.xzor)"), "{e}");
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
        let model = runtime.replace("index.ts", "model.ts");
        let tsconfig = format!(
            r#"{{"compilerOptions":{{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","lib":["ESNext","DOM"],"strict":true,"noEmit":true,"skipLibCheck":true,"rootDirs":[".",".xzor"],"paths":{{"@source-crafter/xzor-runtime":["{runtime}"],"@source-crafter/xzor-runtime/model":["{model}"]}}}},"include":["**/*.ts",".xzor/**/*.ts"]}}"#
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
        assert!(!root.join(".xzor/main.ts").exists());
        assert!(root.join(".xzor/services/data.provider.ts").is_file());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_providers_runs_nothing() {
        let root = temp("noproviders");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        assert_eq!(di(&root, "main.ts", &[]), Ok(None));
        assert!(!root.join(".xzor").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mount_writes_entry_and_providers() {
        if !has_bun() {
            return;
        }
        let (main, data) = (fixture("main.ts"), fixture("services/data.ts"));
        let app = "@import Counter from \"./Counter.xzor\"\n<div><Counter /></div>\n";
        let files = [("main.ts", &*main), ("services/data.ts", &*data), ("App.xzor", app), ("Counter.xzor", COUNTER)];
        let root = di_project("mount", &files);
        let units = compile_all(&root).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(Some(root.join(".xzor").join("main.ts"))));
        assert!(root.join(".xzor/services/data.provider.ts").is_file());
        let entry = fs::read_to_string(root.join(".xzor/main.ts")).unwrap();
        assert!(entry.contains("Counter"), "{entry}");
        let (ok, text) = check_output(&root, None, &units);
        assert!(ok, "{text}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_without_mount_is_an_error() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let files = [("main.ts", "console.log(1);\n"), ("services/data.ts", &*data), ("Counter.xzor", COUNTER)];
        let root = di_project("injectnomount", &files);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Counter.xzor(2,19): error ZDI04: IDatabase (injected as db in Counter) is not provided: no @Run application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_without_any_application_is_an_error() {
        let root = temp("injectnoapp");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        fs::write(root.join("Page.xzor"), "@inject Clock clock\n<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Page.xzor(1,15): error ZDI04: Clock (injected as clock in Page) is not provided: no @Run application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn zdi02_points_at_the_constructor_parameter() {
        if !has_bun() {
            return;
        }
        let db = "export class Log {}\nexport class Db {\n  /* ünï 🙂 */ constructor(readonly log: Log) {}\n}\n";
        let data = "import { ServiceProvider, Singleton } from \"@source-crafter/xzor-runtime\";\nimport { Db } from \"./db\";\n@ServiceProvider()\n@Singleton(Db)\nexport class DataServices {}\n";
        let root = di_project("errors", &[("services/db.ts", db), ("services/data.ts", data)]);
        let err = di(&root, "main.ts", &[]).unwrap_err();
        let expected = "services/db.ts(3,37): error ZDI02: Log (needed by Db in provider DataServices) is not registered or imported";
        assert!(err.lines().any(|l| l.ends_with(expected) && !l.contains('\\')), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inject_errors_point_at_the_xzor() {
        if !has_bun() {
            return;
        }
        let main = "import { Run, ServiceProvider } from \"@source-crafter/xzor-runtime\";\nimport App from \"./App.xzor\";\n@Run(App, \"app\")\n@ServiceProvider()\nexport class Application {}\n";
        let data = "export interface IDatabase { readonly name: string }\n";
        let files = [("main.ts", main), ("services/data.ts", data), ("App.xzor", "<p/>"), ("Counter.xzor", COUNTER)];
        let root = di_project("injecterr", &files);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("Counter.xzor(2,19): error ZDI04: IDatabase (injected as db in Counter) is not provided by Application")), "{err}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mount_outside_the_entry_is_an_error() {
        if !has_bun() {
            return;
        }
        let main = "import { Run, ServiceProvider } from \"@source-crafter/xzor-runtime\";\nimport App from \"./App.xzor\";\n@Run(App, \"app\")\n@ServiceProvider()\nexport class Application {}\n";
        let root = di_project("mountentry", &[("app.ts", main), ("App.xzor", "<p/>")]);
        let units = compile_all(&root).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.lines().any(|l| l.ends_with("app.ts(3,1): error ZDI07: @Run must be declared in the entry module main.ts")), "{err}");
        assert!(!root.join(".xzor/app.ts").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    const OTHER: &str = "import { ServiceProvider, Singleton } from \"@source-crafter/xzor-runtime\";\nexport class Clock {}\n@ServiceProvider()\n@Singleton(Clock)\nexport class OtherServices {}\n";

    #[test]
    fn removed_provider_output_is_pruned() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("prune", &[("main.ts", "console.log(1);\n"), ("services/data.ts", &data), ("services/other.ts", OTHER)]);
        let units = compile_all(&root).unwrap();
        fs::create_dir_all(root.join(".xzor")).unwrap();
        fs::write(root.join(".xzor/keep.ts"), "export {};\n").unwrap();
        // One analyzer across the runs, as `--watch` and the LSP use it.
        let mut analyzer = Analyzer::new(&root);
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        let (data_out, other_out) = (root.join(".xzor/services/data.provider.ts"), root.join(".xzor/services/other.provider.ts"));
        assert!(data_out.is_file() && other_out.is_file());
        assert!(fs::read_to_string(&other_out).unwrap().starts_with(crate::di::emit::HEADER));

        fs::remove_file(root.join("services/other.ts")).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(data_out.is_file() && !other_out.exists());

        // The early-return path (no providers left) prunes too; foreign files stay.
        fs::remove_file(root.join("services/data.ts")).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(!data_out.exists());
        assert!(!root.join(".xzor/services").exists());
        assert!(root.join(".xzor/keep.ts").is_file());
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn removed_mount_prunes_the_entry() {
        if !has_bun() {
            return;
        }
        let (main, data) = (fixture("main.ts"), fixture("services/data.ts"));
        let app = "@import Counter from \"./Counter.xzor\"\n<div><Counter /></div>\n";
        let files = [("main.ts", &*main), ("services/data.ts", &*data), ("App.xzor", app), ("Counter.xzor", COUNTER)];
        let root = di_project("unmount", &files);
        let units = compile_all(&root).unwrap();
        let mut analyzer = Analyzer::new(&root);
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(Some(root.join(".xzor").join("main.ts"))));
        assert!(root.join(".xzor/main.ts").is_file());

        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        // Without @Run, @inject would be ZDI04.
        fs::write(root.join("Counter.xzor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        assert_eq!(super::di(&root, "main.ts", &units, &mut analyzer), Ok(None));
        assert!(!root.join(".xzor/main.ts").exists());
        assert!(root.join(".xzor/services/data.provider.ts").is_file());
        assert!(root.join(".xzor/App.xzor.ts").is_file());
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn decorators_match_only_as_usage() {
        let root = temp("declares");
        fs::write(root.join("a.ts"), "// @ServiceProvider() in a comment\nconst s = \"@Run(x)\";\n").unwrap();
        fs::write(root.join("b.ts"), "export class B {}\n  @ServiceProvider()\nexport class P {}\n").unwrap();
        fs::write(root.join("c.ts"), "@Run(App, \"app\")\nexport class M {}\n").unwrap();
        // Still matched so the analyzer can report the rename.
        fs::write(root.join("d.ts"), "@Mount(App, \"app\")\nexport class M {}\n").unwrap();
        assert_eq!(provider_files(&root), [PathBuf::from("b.ts"), PathBuf::from("c.ts"), PathBuf::from("d.ts")]);
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
    fn analyzer_that_does_not_answer_in_time_is_killed_and_restarted() {
        if !has_bun() {
            return;
        }
        let data = fixture("services/data.ts");
        let root = di_project("timeout", &[("services/data.ts", &data)]);
        let mut analyzer = Analyzer::new(&root);
        let files = ["services/data.ts".to_string()];
        analyzer.set_timeout(std::time::Duration::from_millis(1));
        let err = analyzer.analyze(&files, &[], &[]).unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert_eq!(analyzer.pid(), None);
        analyzer.set_timeout(std::time::Duration::from_secs(30));
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
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
        // The second answer reaches the limit; the child is stopped at the start of the next request.
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert_eq!(analyzer.pid(), first);
        assert_eq!(analyzer.analyze(&files, &[], &[]).unwrap().providers.len(), 1);
        assert!(analyzer.pid().is_some() && analyzer.pid() != first);
        drop(analyzer);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_removes_empty_dirs() {
        let root = temp("prunedirs");
        let xzor = root.join(".xzor");
        fs::create_dir_all(xzor.join("a/b")).unwrap();
        fs::create_dir_all(xzor.join("c")).unwrap();
        fs::create_dir_all(xzor.join("d")).unwrap();
        fs::write(xzor.join("c/x.provider.ts"), format!("{}\nexport {{}};\n", crate::di::emit::HEADER)).unwrap();
        fs::write(xzor.join("d/keep.ts"), "export {};\n").unwrap();
        prune(&xzor, &[]).unwrap();
        assert!(!xzor.join("a").exists() && !xzor.join("c").exists());
        assert!(xzor.join("d/keep.ts").is_file());
        fs::remove_dir_all(xzor.join("d")).unwrap();
        prune(&xzor, &[]).unwrap();
        assert!(xzor.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn component_without_a_unit_falls_back_to_the_start() {
        let root = temp("fallback");
        let diag = |inject: Option<&str>| crate::di::graph::Diag { file: "Missing.xzor".into(), at: 0, code: "ZDI04", message: "nope".into(), inject: inject.map(String::from), param_at: None };
        let out = format_diags(&root, &[diag(Some("db"))], &[], &root);
        assert_eq!(out, "Missing.xzor(1,1): error ZDI04: nope");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn component_outside_the_root_is_an_error() {
        let root = temp("outside");
        let other = temp("outside-other");
        fs::write(other.join("tsconfig.json"), "{}").unwrap();
        fs::write(other.join("C.xzor"), "@inject Thing t\n<p/>\n").unwrap();
        fs::write(root.join("p.ts"), "@ServiceProvider()\nexport class P {}\n").unwrap();
        let units = compile_all(&other).unwrap();
        let err = di(&root, "main.ts", &units).unwrap_err();
        assert!(err.contains("C.xzor") && err.contains("outside"), "{err}");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&other).unwrap();
    }
}
