//! Project driver: `.tszor` -> `.zor/*.tszor.ts` (zor) -> type check -> `.js` bundle (bun).

use crate::codegen::Generated;
use crate::lsp::{offset_at, position_at, same_path};
use std::collections::HashMap;
use std::fmt::Write;
use std::fs;
use std::io;
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

// `.zor/**/*.ts` is in the project's `include`; the analyzer itself is not part of the app.
const DI_SCRIPT: &str = concat!("// @ts-nocheck\n", include_str!("di.ts"));

/// Compile-time DI: analyzes the project's providers, writes the generated providers into `.zor/`, and returns
/// `.zor/<entry>` when `entry` declares `@Mount` (that generated module is then the entry to bundle).
pub fn di(root: &Path, entry: &str, compiled: &[Compiled]) -> Result<Option<PathBuf>, String> {
    let files = provider_files(root);
    if files.is_empty() {
        return Ok(None);
    }
    let zor = root.join(".zor");
    let script = zor.join("zor-di.ts");
    write_if_changed(&script, DI_SCRIPT)?;
    let mut cmd = Command::new("bun");
    cmd.arg(&script).arg(root).args(&files).arg("--");
    for unit in compiled.iter().filter(|u| !u.generated.injects.is_empty()) {
        if let Ok(rel) = unit.out.strip_prefix(root) {
            cmd.arg(rel);
        }
    }
    let output = cmd.output().map_err(|e| format!("DI analysis: failed to run bun: {e}"))?;
    if !output.status.success() {
        return Err(format!("DI analysis failed ({})\n{}", output.status, String::from_utf8_lossy(&output.stderr)));
    }
    let facts = crate::di::model::Facts::from_json(&String::from_utf8_lossy(&output.stdout)).map_err(|e| format!("DI analysis: {e}"))?;
    let cwd = std::env::current_dir().unwrap_or_default();
    let resolved = crate::di::graph::resolve(&facts).map_err(|d| format_diags(root, &d, compiled, &cwd))?;

    let entry = entry.replace('\\', "/");
    let entry = entry.strip_prefix("./").unwrap_or(&entry);
    let mount = resolved.iter().find_map(|r| Some((&r.provider.file, r.provider.mount.as_ref()?)));
    if let Some((file, m)) = mount.filter(|(file, _)| *file != entry) {
        let message = format!("@Mount must be declared in the entry module {entry}");
        let d = crate::di::graph::Diag { file: file.clone(), at: m.at, code: "ZDI07", message, inject: None };
        return Err(format_diags(root, &[d], compiled, &cwd));
    }
    let mut done: Vec<&str> = Vec::with_capacity(resolved.len());
    for r in &resolved {
        let file = r.provider.file.as_str();
        if done.contains(&file) {
            continue;
        }
        done.push(file);
        let is_entry = mount.is_some() && file == entry;
        let out = zor.join(crate::di::emit::output_name(file, is_entry));
        write_if_changed(&out, &crate::di::emit::emit_file(file, &resolved, is_entry))?;
    }
    Ok(mount.map(|_| zor.join(entry)))
}

/// Project `.ts` files (relative to `root`) that declare `@ServiceProvider` or `@Mount`.
fn provider_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if root.is_dir() {
        let _ = walk(root, &|n| n.ends_with(".ts") && !n.ends_with(".d.ts"), &mut files);
    }
    files.retain(|p| fs::read_to_string(p).is_ok_and(|t| t.contains("@ServiceProvider") || t.contains("@Mount")));
    files.iter_mut().for_each(|p| *p = p.strip_prefix(root).map_or_else(|_| p.clone(), Path::to_path_buf));
    files
}

/// `file(line,col): error ZDInn: message` lines; positions are 1-based in the `.ts` or `.tszor` source.
fn format_diags(root: &Path, diags: &[crate::di::graph::Diag], compiled: &[Compiled], cwd: &Path) -> String {
    let mut out = String::new();
    for d in diags {
        let path = normalize(&root.join(&d.file));
        let unit = compiled.iter().find(|u| same_path(&normalize(&u.source), &path));
        let (line, col) = match (&d.inject, unit) {
            (Some(name), Some(u)) => position_at(&u.text, u.generated.injects.iter().find(|i| i.text == *name).map_or(0, |i| i.at)),
            (Some(_), None) => (0, 0),
            (None, _) => {
                let text = fs::read_to_string(&path).unwrap_or_default();
                position_at(&text, utf16_to_byte(&text, d.at))
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
    fn di_errors_are_mapped() {
        if !has_bun() {
            return;
        }
        let data = "import { ServiceProvider, Singleton } from \"@zor/runtime\";\nexport class Log {} export class Db { constructor(readonly log: Log) {} }\n@ServiceProvider() // ünï 🙂\n@Singleton(Db)\nexport class DataServices {}\n";
        let root = di_project("errors", &[("services/data.ts", data)]);
        let err = di(&root, "main.ts", &[]).unwrap_err();
        let expected = "services/data.ts(4,1): error ZDI02: Log (needed by Db in provider DataServices) is not registered or imported";
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
