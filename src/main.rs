use std::path::PathBuf;
use std::process::ExitCode;
use zor::build;

const USAGE: &str = "\
zor - Blazor-like component compiler for TypeScript

USAGE:
  zor compile [PATH...]      Generate .zor/X.tszor.ts (and .map) for each .tszor in a TypeScript project (default: .)
  zor build [DIR] [OPTIONS]  Compile, type-check and bundle DIR to JavaScript (default: .)
      --entry <FILE>         Entry module relative to DIR (default: main.ts)
      --checker <CMD>        Type checker command; {dir} is replaced with DIR
                             (default: bun x tsc --noEmit -p {dir})
      --no-check             Skip type checking
      --no-bundle            Skip bundling
      --watch                Rebuild when .tszor or .ts files change
  zor highlight <FILE>       Print a .tszor file with syntax colors
  zor lsp                    Run the language server on stdio
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        print!("{USAGE}");
        return Ok(());
    };
    match command.as_str() {
        "compile" => {
            let paths = if rest.is_empty() { vec![".".to_string()] } else { rest.to_vec() };
            let mut failed = false;
            for p in paths {
                let path = PathBuf::from(p);
                let units = build::compile_all(&path)?;
                for unit in &units {
                    println!("{}", unit.out.display());
                }
                // `compile` has no entry option, so a @Mount outside main.ts is not an error here.
                if let Err(e) = build::di(&path, "main.ts", &units, &mut build::Analyzer::new(&path)) {
                    let kept: Vec<&str> = e.lines().filter(|l| !l.contains("error ZDI07: @Mount must be declared in the entry module")).collect();
                    if !kept.is_empty() {
                        eprintln!("{}", kept.join("\n"));
                        failed = true;
                    }
                }
            }
            if failed {
                return Err("zor: DI analysis failed".to_string());
            }
        }
        "build" => {
            let mut dir = PathBuf::from(".");
            let mut entry = "main.ts".to_string();
            let mut checker = None;
            let (mut check, mut bundle, mut watch) = (true, true, false);
            let mut it = rest.iter();
            while let Some(arg) = it.next() {
                match arg.as_str() {
                    "--entry" => entry = it.next().ok_or("--entry needs a value")?.clone(),
                    "--checker" => checker = Some(it.next().ok_or("--checker needs a value")?.clone()),
                    "--no-check" => check = false,
                    "--no-bundle" => bundle = false,
                    "--watch" => watch = true,
                    a if a.starts_with("--") => return Err(format!("unknown option {a}\n\n{USAGE}")),
                    a => dir = PathBuf::from(a),
                }
            }
            // `--watch` keeps the analyzer (and its TypeScript project) alive between builds.
            let mut analyzer = build::Analyzer::new(&dir);
            let mut build_once = || -> Result<(), String> {
                let units = build::compile_all(&dir)?;
                println!("zor: compiled {} component(s)", units.len());
                let di_entry = build::di(&dir, &entry, &units, &mut analyzer)?;
                if check {
                    build::check(&dir, checker.as_deref(), &units)?;
                    println!("zor: type check passed");
                }
                if bundle {
                    match di_entry.as_deref().and_then(|p| p.strip_prefix(&dir).ok()) {
                        Some(generated) => build::bundle(&dir, &generated.to_string_lossy())?,
                        None => build::bundle(&dir, &entry)?,
                    }
                }
                Ok(())
            };
            if !watch {
                return build_once();
            }
            let mut seen = build::snapshot(&dir);
            if let Err(e) = build_once() {
                eprintln!("{e}");
            }
            println!("zor: watching {} for changes (Ctrl+C to stop)", dir.display());
            loop {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let now = build::snapshot(&dir);
                let changed = build::changed(&seen, &now);
                if changed.is_empty() && now.len() == seen.len() {
                    continue;
                }
                seen = now;
                for path in &changed {
                    println!("zor: changed {}", path.display());
                }
                if let Err(e) = build_once() {
                    eprintln!("{e}");
                }
            }
        }
        "highlight" => {
            let file = rest.first().ok_or("highlight needs a file")?;
            let src = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
            let out = zor::highlight::highlight_ansi(&src).map_err(|e| {
                let (line, col) = zor::line_col(&src, e.offset);
                format!("{file}:{line}:{col}: {}", e.message)
            })?;
            print!("{out}");
        }
        "lsp" => zor::lsp::server::run().map_err(|e| format!("lsp: {e}"))?,
        "-h" | "--help" | "help" => print!("{USAGE}"),
        "-V" | "--version" => println!("zor {}", env!("CARGO_PKG_VERSION")),
        other => return Err(format!("unknown command {other}\n\n{USAGE}")),
    }
    Ok(())
}
