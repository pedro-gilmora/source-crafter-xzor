//! Project driver: `.tszor` -> `.zor/*.tszor.ts` (zor) -> type check -> `.js` bundle (bun).

use crate::codegen::Generated;
use crate::lsp::{offset_at, position_at, same_path};
use std::collections::HashMap;
use std::fmt::Write;
use std::fs;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

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
        let text = fs::read_to_string(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        match crate::compile_mapped(&text, &src) {
            Ok(generated) => {
                let out = output_path(&src);
                let name = src.file_name().unwrap_or_default().to_string_lossy();
                let map = generated.source_map(&text, &relative_from(out.parent().unwrap_or(Path::new(".")), &src, &name));
                write_if_changed(&out, &generated.code)?;
                write_if_changed(&PathBuf::from(format!("{}.map", out.display())), &map)?;
                compiled.push(Compiled { source: src, out, text, generated });
            }
            Err(d) => errors.push(format!("{}:{d}", src.display())),
        }
    }
    if errors.is_empty() { Ok(compiled) } else { Err(errors.join("\n")) }
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
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

/// Modification times of every `.tszor` and `.ts` source under `root` (`.ts` covers providers and the entry).
pub fn snapshot(root: &Path) -> HashMap<PathBuf, SystemTime> {
    let mut files = Vec::new();
    if root.is_dir() {
        let _ = walk(root, &|n| n.ends_with(".tszor") || (n.ends_with(".ts") && !n.ends_with(".d.ts")), &mut files);
    } else {
        files.push(root.to_path_buf());
    }
    files
        .into_iter()
        .filter_map(|p| Some((p.clone(), fs::metadata(&p).ok()?.modified().ok()?)))
        .collect()
}

/// Sources that are new or modified since `before`.
pub fn changed(before: &HashMap<PathBuf, SystemTime>, now: &HashMap<PathBuf, SystemTime>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = now.iter().filter(|(p, t)| before.get(*p) != Some(t)).map(|(p, _)| p.clone()).collect();
    out.sort();
    out
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

const DI_SCRIPT: &str = include_str!("di.ts");

/// Compile-time DI: analyzes the project's providers, writes the generated providers into `.zor/`, and returns
/// `.zor/<entry>` when `entry` declares `@Mount` (that generated module is then the entry to bundle).
pub fn di(root: &Path, entry: &str, compiled: &[Compiled]) -> Result<Option<PathBuf>, String> {
    di_checked(root, entry, compiled, &provider_files(root)).map_err(|f| match f {
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
pub fn di_checked(root: &Path, entry: &str, compiled: &[Compiled], files: &[PathBuf]) -> Result<Option<PathBuf>, DiFailure> {
    let zor = root.join(".zor");
    if files.is_empty() {
        let diags = unmounted_injects(root, compiled);
        if !diags.is_empty() {
            return Err(DiFailure::Diags(diags));
        }
        prune(&zor, &[])?;
        return Ok(None);
    }
    // Under node_modules, `typescript` resolves from the project and the script stays out of tsconfig's `include`.
    let script = root.join("node_modules").join(".cache").join("zor").join("di.ts");
    write_if_changed(&script, DI_SCRIPT)?;
    let mut cmd = Command::new("bun");
    cmd.arg(&script).arg(root).args(files).arg("--");
    for unit in compiled.iter().filter(|u| !u.generated.injects.is_empty()) {
        let rel = unit.out.strip_prefix(root).map_err(|_| format!("{}: error: generated file is outside {}, cannot analyze its @inject", unit.source.display(), root.display()))?;
        cmd.arg(rel);
    }
    let output = cmd.output().map_err(|e| format!("DI analysis: failed to run bun: {e}"))?;
    let facts = analyzer_facts(output.status.success(), &output.status.to_string(), &output.stdout, &output.stderr)?;
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

/// The analyzer's facts, or a clear error when it failed or printed something unparseable.
fn analyzer_facts(ok: bool, status: &str, stdout: &[u8], stderr: &[u8]) -> Result<crate::di::model::Facts, String> {
    if !ok {
        return Err(format!("DI analysis failed ({status})\n{}", String::from_utf8_lossy(stderr)));
    }
    crate::di::model::Facts::from_json(&String::from_utf8_lossy(stdout)).map_err(|e| format!("DI analysis: {e}"))
}

/// Deletes DI-generated files (carrying the DI header) under `zor` that were not written in this run.
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
    Ok(())
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
    fn watch_snapshots_detect_changed_sources() {
        let root = temp("watch");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        let file = root.join("A.tszor");
        fs::write(&file, "<p/>").unwrap();
        let before = snapshot(&root);
        assert!(changed(&before, &snapshot(&root)).is_empty());
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        assert_eq!(changed(&before, &snapshot(&root)), [file.clone()]);
        fs::write(root.join("B.tszor"), "<p/>").unwrap();
        assert_eq!(changed(&before, &snapshot(&root)).len(), 2);
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
        assert_eq!(di(&root, "main.ts", &units), Ok(None));
        let (data_out, other_out) = (root.join(".zor/services/data.provider.ts"), root.join(".zor/services/other.provider.ts"));
        assert!(data_out.is_file() && other_out.is_file());
        assert!(fs::read_to_string(&other_out).unwrap().starts_with(crate::di::emit::HEADER));

        fs::remove_file(root.join("services/other.ts")).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(None));
        assert!(data_out.is_file() && !other_out.exists());

        // The early-return path (no providers left) prunes too; foreign files stay.
        fs::remove_file(root.join("services/data.ts")).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(None));
        assert!(!data_out.exists());
        assert!(root.join(".zor/keep.ts").is_file());
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
        assert_eq!(di(&root, "main.ts", &units), Ok(Some(root.join(".zor").join("main.ts"))));
        assert!(root.join(".zor/main.ts").is_file());

        fs::write(root.join("main.ts"), "console.log(1);\n").unwrap();
        // Without @Mount, @inject would be ZDI04.
        fs::write(root.join("Counter.tszor"), "<p/>\n").unwrap();
        let units = compile_all(&root).unwrap();
        assert_eq!(di(&root, "main.ts", &units), Ok(None));
        assert!(!root.join(".zor/main.ts").exists());
        assert!(root.join(".zor/services/data.provider.ts").is_file());
        assert!(root.join(".zor/App.tszor.ts").is_file());
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
    fn analyzer_failures_are_clear_errors() {
        let failed = analyzer_facts(false, "exit code: 1", b"", b"boom").unwrap_err();
        assert_eq!(failed, "DI analysis failed (exit code: 1)\nboom");
        let garbled = analyzer_facts(true, "exit code: 0", b"not json", b"").unwrap_err();
        assert!(garbled.starts_with("DI analysis: "), "{garbled}");
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

    #[test]
    fn watch_sees_provider_ts() {
        let root = temp("watchdi");
        fs::write(root.join("tsconfig.json"), "{}").unwrap();
        fs::create_dir_all(root.join("services")).unwrap();
        let file = root.join("services").join("data.ts");
        fs::write(&file, "@ServiceProvider()\nexport class S {}\n").unwrap();
        let before = snapshot(&root);
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        assert_eq!(changed(&before, &snapshot(&root)), [file.clone()]);
        fs::remove_dir_all(&root).unwrap();
    }
}
