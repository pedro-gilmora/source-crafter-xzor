use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn has_bun() -> bool {
    Command::new("bun").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// A project under `target/` so `typescript` resolves from the repo's `node_modules`.
fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.join("target").join("tmp-cli-tests").join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let runtime = manifest.join("runtime").join("index.ts").display().to_string().replace('\\', "/");
    let tsconfig = format!(
        r#"{{"compilerOptions":{{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","lib":["ESNext","DOM"],"strict":true,"noEmit":true,"skipLibCheck":true,"rootDirs":[".",".xzor"],"paths":{{"@source-crafter/xzor-runtime":["{runtime}"]}}}},"include":["**/*.ts",".xzor/**/*.ts"]}}"#
    );
    fs::write(root.join("tsconfig.json"), tsconfig).unwrap();
    for (path, text) in files {
        fs::write(root.join(path), text).unwrap();
    }
    root
}

fn compile(root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xzor")).arg("compile").arg(root).output().unwrap()
}

#[test]
fn compile_fails_on_di_errors() {
    if !has_bun() {
        return;
    }
    let data = "import { ServiceProvider, Singleton } from \"@source-crafter/xzor-runtime\";\nexport class Log {} export class Db { constructor(readonly log: Log) {} }\n@ServiceProvider()\n@Singleton(Db)\nexport class DataServices {}\n";
    let root = project("compile-di-error", &[("data.ts", data)]);
    let out = compile(&root);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{stderr}");
    assert!(stderr.contains("error ZDI02:"), "{stderr}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn compile_ignores_mount_outside_main() {
    if !has_bun() {
        return;
    }
    let app = "import { Mount, ServiceProvider } from \"@source-crafter/xzor-runtime\";\nimport App from \"./App.xzor\";\n@Mount(App, \"app\")\n@ServiceProvider()\nexport class Application {}\n";
    let root = project("compile-mount", &[("app.ts", app), ("App.xzor", "<p/>")]);
    let out = compile(&root);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn build_prints_timings() {
    if !has_bun() {
        return;
    }
    let root = project("build-timings", &[("App.xzor", "<p/>")]);
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).args(["--no-check", "--no-bundle", "--timings"]).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
    let line = stdout.lines().find_map(|l| l.strip_prefix("xzor: timings ")).unwrap_or_else(|| panic!("no timings line in {stdout}"));
    let keys = ["compile", "routes", "di", "check", "bundle", "total"];
    let fields: Vec<&str> = line.split(' ').collect();
    assert_eq!(fields.len(), keys.len(), "{line}");
    for (field, key) in fields.iter().zip(keys) {
        let ms = field.strip_prefix(key).and_then(|f| f.strip_prefix('=')).and_then(|f| f.strip_suffix("ms")).unwrap_or_else(|| panic!("bad field {field}"));
        assert!(!ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()), "{field}");
        if key == "check" || key == "bundle" {
            assert_eq!(ms, "0", "{field}");
        }
    }
    fs::remove_dir_all(&root).unwrap();
}
