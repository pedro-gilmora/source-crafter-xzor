use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};
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
            let opts = Options { dir, entry, checker, check, bundle };
            if watch {
                return watch_loop(&opts);
            }
            let units = build::compile_all(&opts.dir)?;
            println!("zor: compiled {} component(s)", units.len());
            let di_entry = build::di(&opts.dir, &opts.entry, &units, &mut build::Analyzer::new(&opts.dir))?;
            finish(&opts, &units, di_entry.as_deref())?;
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

struct Options {
    dir: PathBuf,
    entry: String,
    checker: Option<String>,
    check: bool,
    bundle: bool,
}

/// Type check and bundle (from the DI-generated entry when there is one).
fn finish(o: &Options, units: &[build::Compiled], di_entry: Option<&Path>) -> Result<(), String> {
    if o.check {
        build::check(&o.dir, o.checker.as_deref(), units)?;
        println!("zor: type check passed");
    }
    if o.bundle {
        match di_entry.and_then(|p| p.strip_prefix(&o.dir).ok()) {
            Some(generated) => build::bundle(&o.dir, &generated.to_string_lossy())?,
            None => build::bundle(&o.dir, &o.entry)?,
        }
    }
    Ok(())
}

/// `build --watch`: one full build, then per batch of file events only the changed components
/// recompile, DI reruns only when its inputs changed, then the check and bundle run.
fn watch_loop(o: &Options) -> Result<(), String> {
    let dir = &o.dir;
    let (_watcher, events) = build::watch(dir)?;
    let mut analyzer = build::Analyzer::new(dir);
    let mut units: Vec<build::Compiled> = Vec::new();
    let mut known: HashMap<PathBuf, Vec<String>> = HashMap::new();
    let mut errors: BTreeMap<PathBuf, String> = BTreeMap::new();
    let mut providers: HashSet<PathBuf> = build::provider_files(dir).into_iter().map(|p| dir.join(p)).collect();
    let sources = build::find_sources(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut plan = build::WatchPlan { recompile: sources.into_iter().filter(|s| build::in_project(s)).collect(), remove: vec![], di: true, rebuild: true };
    let (mut di_due, mut di_entry) = (false, None);
    let mut batch: Vec<String> = Vec::new();
    loop {
        if plan.di && !batch.is_empty() {
            build::update_providers(&mut providers, &batch, &known, dir);
        }
        di_due |= plan.di;
        for src in &plan.remove {
            units.retain(|u| &u.source != src);
            known.remove(src);
            errors.remove(src);
            build::remove_outputs(src);
        }
        // Components importing a changed one read its type parameters and prop kinds.
        let mut recompile = plan.recompile;
        let changed: Vec<&Path> = recompile.iter().chain(&plan.remove).map(PathBuf::as_path).collect();
        let dependents = build::dependents(&units, &changed);
        recompile.extend(dependents);
        for src in &recompile {
            match build::compile_one(src) {
                Ok(unit) => {
                    errors.remove(src);
                    known.insert(src.clone(), build::inject_signature(&unit.generated.injects));
                    match units.iter_mut().find(|u| u.source == unit.source) {
                        Some(slot) => *slot = unit,
                        None => units.push(unit),
                    }
                }
                Err(e) => {
                    // Tracked, so deleting a never-compiled file takes the remove path and clears its error.
                    known.entry(src.clone()).or_default();
                    errors.insert(src.clone(), e);
                }
            }
        }
        if plan.rebuild {
            if errors.is_empty() {
                println!("zor: compiled {} component(s)", recompile.len());
            } else {
                println!("zor: compiled {} component(s), {} with errors", recompile.len(), errors.len());
            }
            if let Err(e) = rebuild(o, &units, &errors, &providers, &mut analyzer, &mut di_due, &mut di_entry) {
                eprintln!("{e}");
            }
            println!("zor: watching {} for changes (Ctrl+C to stop)", dir.display());
        }
        batch.clear();
        batch.push(events.recv().map_err(|_| "zor: the file watcher exited".to_string())?);
        let deadline = Instant::now() + Duration::from_millis(50);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match events.recv_timeout(left) {
                Ok(path) => batch.push(path),
                Err(_) => break,
            }
        }
        batch.sort_unstable();
        batch.dedup();
        plan = build::watch_plan(&batch, &known, &providers, dir);
    }
}

fn rebuild(
    o: &Options,
    units: &[build::Compiled],
    errors: &BTreeMap<PathBuf, String>,
    providers: &HashSet<PathBuf>,
    analyzer: &mut build::Analyzer,
    di_due: &mut bool,
    di_entry: &mut Option<PathBuf>,
) -> Result<(), String> {
    if !errors.is_empty() {
        return Err(errors.values().cloned().collect::<Vec<_>>().join("\n"));
    }
    if *di_due {
        let mut files: Vec<PathBuf> = providers.iter().map(|p| p.strip_prefix(&o.dir).unwrap_or(p).to_path_buf()).collect();
        files.sort_unstable();
        // A failed run stays due, so the next change retries it.
        *di_entry = build::di_with(&o.dir, &o.entry, units, &files, analyzer)?;
        *di_due = false;
    }
    finish(o, units, di_entry.as_deref())
}
