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

const APP_MAIN: &str = "import App from \"./App.xzor\";\nconsole.log(App);\n";

#[test]
fn component_styles_are_bundled_once_per_module_and_type_checked() {
    if !has_bun() {
        return;
    }
    let app = "@import Card from \"./Card.xzor\"\n<Card /><Card />\n<style>\n.app { color: red }\n</style>\n";
    let card = "@code { w = 50; }\n<div class=\"card\">x</div>\n";
    let sheet = ".card { width: @w%; }\n";
    let root = project("styles", &[("App.xzor", app), ("Card.xzor", card), ("Card.css.xzor", sheet), ("main.ts", APP_MAIN)]);
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).output().unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(root.join(".xzor/Card.xzor.css").is_file() && !root.join(".xzor/Card.css.xzor.ts").exists());
    let css = fs::read_to_string(root.join("dist/main.css")).unwrap();
    assert_eq!(css.matches(".card {").count(), 1, "{css}");
    assert!(css.contains("@scope") && css.contains(".app"), "{css}");
    // A wrong expression in the sheet is a type error.
    fs::write(root.join("Card.css.xzor"), ".card { width: @nope%; }\n").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).arg("--no-bundle").output().unwrap();
    assert!(!out.status.success());
    fs::remove_file(root.join("Card.css.xzor")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).arg("--no-bundle").output().unwrap();
    assert!(out.status.success() && !root.join(".xzor/Card.xzor.css").exists());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn module_exports_are_imported_by_other_components_and_type_checked() {
    if !has_bun() {
        return;
    }
    let button = "@module {\n  export type Kind = \"a\" | \"b\";\n  export const kinds: Kind[] = [\"a\", \"b\"];\n  export const badge = (t: string) => <b>@t</b>;\n}\n@code { kind: Kind = \"a\"; }\n<button>@kind @kinds.length</button>\n";
    let app = "@import Button, { kinds, badge, type Kind } from \"./Button.xzor\"\n@code { k: Kind = kinds[1]!; }\n<Button kind=\"@k\" />\n@badge(\"new\")\n";
    let root = project("module-exports", &[("Button.xzor", button), ("App.xzor", app), ("main.ts", APP_MAIN)]);
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).arg("--no-bundle").output().unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    fs::write(root.join("App.xzor"), app.replace("kinds[1]!", "\"c\"")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).arg("--no-bundle").output().unwrap();
    assert!(!out.status.success(), "a wrong literal for an exported type must fail the check");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn check_runs_while_bundling() {
    if !has_bun() {
        return;
    }
    let wait = "import { existsSync } from \"node:fs\";\nconst bundle = `${process.argv[2]}/dist/main.js`;\nfor (let i = 0; i < 250 && !existsSync(bundle); i++) await Bun.sleep(20);\nconsole.log(existsSync(bundle) ? \"saw bundle\" : \"no bundle\");\n";
    let root = project("check-while-bundling", &[("App.xzor", "<p/>"), ("main.ts", APP_MAIN), ("wait.ts", wait)]);
    let checker = format!("bun {}/wait.ts {{dir}}", root.display().to_string().replace('\\', "/"));
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).args(["--checker", &checker]).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}{}", String::from_utf8_lossy(&out.stderr));
    let saw = stdout.find("saw bundle").unwrap_or_else(|| panic!("check did not overlap the bundle: {stdout}"));
    assert!(saw < stdout.find("main.js").unwrap(), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn failed_check_hides_bundle_paths() {
    if !has_bun() {
        return;
    }
    let root = project("failed-check", &[("App.xzor", "<p/>"), ("main.ts", APP_MAIN)]);
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).arg("build").arg(&root).args(["--checker", "bun -e process.exit(1)"]).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!out.status.success(), "{stdout}");
    assert!(!stdout.lines().any(|l| l.trim_end().ends_with("main.js")), "{stdout}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn hot_needs_watch() {
    let out = Command::new(env!("CARGO_BIN_EXE_xzor")).args(["build", "--hot"]).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--hot needs --watch"));
}
