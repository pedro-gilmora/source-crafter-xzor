//! Project driver: `.tszor` -> `.tszor.ts` (zor) -> type check -> `.js` bundle (bun).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// `<root>/.zor/<relative source path>.ts`, the generated TypeScript (like Blazor's `obj/`).
pub fn output_path(source: &Path) -> PathBuf {
    let root = project_root(source);
    let rel = source.strip_prefix(&root).unwrap_or(source);
    let mut p = root.join(".zor").join(rel).into_os_string();
    p.push(".ts");
    p.into()
}

/// Compiles every `.tszor` under `root` into its project's `.zor/` directory.
pub fn compile_all(root: &Path) -> Result<Vec<PathBuf>, String> {
    let sources = find_sources(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut errors = Vec::new();
    let mut written = Vec::new();
    for src in sources {
        let text = fs::read_to_string(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        match crate::compile(&text, &src) {
            Ok(ts) => {
                let out = output_path(&src);
                if fs::read_to_string(&out).ok().as_deref() != Some(ts.as_str()) {
                    if let Some(dir) = out.parent() {
                        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
                    }
                    fs::write(&out, ts).map_err(|e| format!("{}: {e}", out.display()))?;
                }
                written.push(out);
            }
            Err(d) => errors.push(format!("{}:{d}", src.display())),
        }
    }
    if errors.is_empty() { Ok(written) } else { Err(errors.join("\n")) }
}

/// Runs the type checker. `checker` may contain `{dir}`. The default is TypeScript 7's
/// `tsc --noEmit -p <dir>`, launched through `bun x` when Bun is installed, else `npx`.
pub fn check(dir: &Path, checker: Option<&str>) -> Result<(), String> {
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
            cmd.args(["tsc", "--noEmit", "-p"]).arg(dir);
            cmd
        }
    };
    run(&mut cmd, "type check")
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
}
