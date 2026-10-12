//! Project driver: `.tszor` -> `.zor/*.tszor.ts` (zor) -> type check -> `.js` bundle (bun).

use crate::codegen::Generated;
use crate::lsp::{offset_at, position_at, same_path};
use std::collections::HashMap;
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
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if path.is_dir() {
            if !name.starts_with('.') && !matches!(&*name, "node_modules" | "dist" | "target") {
                out.extend(find_sources(&path)?);
            }
        } else if name.ends_with(".tszor") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
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

/// Modification times of every project `.tszor` under `root`.
pub fn snapshot(root: &Path) -> HashMap<PathBuf, SystemTime> {
    find_sources(root)
        .unwrap_or_default()
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
}
