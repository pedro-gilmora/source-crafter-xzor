use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};
use xzor::build;

const USAGE: &str = "\
xzor - Blazor-like component compiler for TypeScript

USAGE:
  xzor compile [PATH...]      Generate .xzor/X.xzor.ts (and .map) for each .xzor in a TypeScript project (default: .)
  xzor build [DIR] [OPTIONS]  Compile, type-check and bundle DIR to JavaScript (default: .)
      --entry <FILE>         Entry module relative to DIR (default: main.ts)
      --checker <CMD>        Type checker command; {dir} is replaced with DIR
                             (default: bun x tsc --noEmit -p {dir})
      --no-check             Skip type checking
      --no-bundle            Skip bundling
      --watch                Rebuild when .xzor or .ts files change
      --hot                  With --watch, print `xzor: hot <id>` for each component a .xzor-only change can patch in place
                             (a bare `xzor: hot` when such a change altered no generated code)
      --timings              Print how long each stage took
      --minify               Minify, and split the bundle: each @page (and each @async component) is a chunk
                             of its own under dist/chunks, loaded on first use
  xzor highlight <FILE>       Print a .xzor file with syntax colors
  xzor lsp                    Run the language server on stdio
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
                build::write_routes(&units, &mut HashSet::new(), false)?;
                for unit in &units {
                    build::print_warnings(unit);
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
                return Err("xzor: DI analysis failed".to_string());
            }
        }
        "build" => {
            let mut dir = PathBuf::from(".");
            let mut entry = "main.ts".to_string();
            let mut checker = None;
            let (mut check, mut bundle, mut watch, mut timings, mut hot, mut minify) = (true, true, false, false, false, false);
            let mut it = rest.iter();
            while let Some(arg) = it.next() {
                match arg.as_str() {
                    "--entry" => entry = it.next().ok_or("--entry needs a value")?.clone(),
                    "--checker" => checker = Some(it.next().ok_or("--checker needs a value")?.clone()),
                    "--no-check" => check = false,
                    "--no-bundle" => bundle = false,
                    "--watch" => watch = true,
                    "--hot" => hot = true,
                    "--timings" => timings = true,
                    "--minify" => minify = true,
                    a if a.starts_with("--") => return Err(format!("unknown option {a}\n\n{USAGE}")),
                    a => dir = PathBuf::from(a),
                }
            }
            if hot && !watch {
                return Err("--hot needs --watch".to_string());
            }
            let opts = Options { dir, entry, checker, check, bundle, timings, hot, watch, minify };
            if watch {
                return watch_loop(&opts);
            }
            let mut t = Timings::default();
            let start = Instant::now();
            let units = build::compile_all(&opts.dir)?;
            t.compile = start.elapsed();
            let start = Instant::now();
            build::write_routes(&units, &mut HashSet::new(), opts.minify)?;
            t.routes = start.elapsed();
            units.iter().for_each(build::print_warnings);
            println!("xzor: compiled {} component(s)", units.len());
            let start = Instant::now();
            let di_entry = build::di(&opts.dir, &opts.entry, &units, &mut build::Analyzer::new(&opts.dir))?;
            t.di = start.elapsed();
            finish(&opts, &units, di_entry.as_deref(), &mut None, &mut t)?;
            t.print(&opts);
        }
        "highlight" => {
            let file = rest.first().ok_or("highlight needs a file")?;
            let src = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
            let out = xzor::highlight::highlight_ansi(&src).map_err(|e| {
                let (line, col) = xzor::line_col(&src, e.offset);
                format!("{file}:{line}:{col}: {}", e.message)
            })?;
            print!("{out}");
        }
        "lsp" => xzor::lsp::server::run().map_err(|e| format!("lsp: {e}"))?,
        "-h" | "--help" | "help" => print!("{USAGE}"),
        "-V" | "--version" => println!("xzor {}", env!("CARGO_PKG_VERSION")),
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
    timings: bool,
    hot: bool,
    watch: bool,
    minify: bool,
}

struct Timings {
    started: Instant,
    compile: Duration,
    routes: Duration,
    di: Duration,
    check: Duration,
    bundle: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings { started: Instant::now(), compile: Duration::ZERO, routes: Duration::ZERO, di: Duration::ZERO, check: Duration::ZERO, bundle: Duration::ZERO }
    }
}

impl Timings {
    fn print(&self, o: &Options) {
        if o.timings {
            let ms = |d: Duration| d.as_millis();
            // Check and bundle overlap, so the total is wall time, not the sum.
            let total = self.started.elapsed();
            println!(
                "xzor: timings compile={}ms routes={}ms di={}ms check={}ms bundle={}ms total={}ms",
                ms(self.compile), ms(self.routes), ms(self.di), ms(self.check), ms(self.bundle), ms(total)
            );
        }
    }
}

/// Type check and bundle (from the DI-generated entry when there is one), running together.
/// Bundle paths print only after a passing check: `xzor dev` reloads on them. `hot` holds the ids
/// patchable since the last success (None: not patchable); a success prints and clears it.
fn finish(o: &Options, units: &[build::Compiled], di_entry: Option<&Path>, hot: &mut Option<BTreeSet<String>>, t: &mut Timings) -> Result<(), String> {
    let entry = match di_entry.and_then(|p| p.strip_prefix(&o.dir).ok()) {
        Some(generated) => generated.to_string_lossy().into_owned(),
        None => o.entry.clone(),
    };
    let timed_check = || {
        let start = Instant::now();
        let (ok, text) = build::check_output(&o.dir, o.checker.as_deref(), units);
        (ok, text, start.elapsed())
    };
    let timed_bundle = || {
        let start = Instant::now();
        (build::bundle(&o.dir, &entry, o.hot, o.watch, o.minify), start.elapsed())
    };
    let (checked, bundled) = match (o.check, o.bundle) {
        (true, true) => {
            let (checked, bundled) = std::thread::scope(|s| {
                let check = s.spawn(timed_check);
                let bundled = timed_bundle();
                (check.join().expect("type check thread panicked"), bundled)
            });
            (Some(checked), Some(bundled))
        }
        (true, false) => (Some(timed_check()), None),
        (false, true) => (None, Some(timed_bundle())),
        (false, false) => (None, None),
    };
    if let Some((ok, text, elapsed)) = checked {
        t.check = elapsed;
        print!("{text}");
        if !ok {
            return Err("type check failed".to_string());
        }
        println!("xzor: type check passed");
    }
    let bundle_out = match bundled {
        Some((result, elapsed)) => {
            t.bundle = elapsed;
            Some(result?)
        }
        None => None,
    };
    if o.hot {
        // `Some` and empty: patchable, but no generated code changed; a bare `xzor: hot` tells `xzor dev` to send nothing.
        match hot.replace(BTreeSet::new()) {
            Some(ids) if ids.is_empty() => println!("xzor: hot"),
            Some(ids) => ids.iter().for_each(|id| println!("xzor: hot {id}")),
            None => {}
        }
    }
    print!("{}", bundle_out.unwrap_or_default());
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
    let mut plan = build::WatchPlan { recompile: sources.into_iter().filter(|s| build::in_project(s)).collect(), di: true, rebuild: true, ..Default::default() };
    let (mut di_due, mut di_entry) = (false, None);
    // The build root is seeded so an empty project still loses a stale table.
    let (mut routes_due, mut routes_written) = (true, HashSet::from([dir.clone()]));
    let mut batch: Vec<String> = Vec::new();
    // Ids patchable since the last successful build; None once anything unpatchable happened.
    let mut hot: Option<BTreeSet<String>> = None;
    loop {
        if plan.config {
            println!("xzor: project configuration changed, rebuilding everything");
            // The analyzer's TypeScript session holds the old compiler options and file set.
            analyzer = build::Analyzer::new(dir);
            let sources: Vec<PathBuf> = build::find_sources(dir).map_err(|e| format!("{}: {e}", dir.display()))?.into_iter().filter(|s| build::in_project(s)).collect();
            plan.remove = units.iter().map(|u| u.source.clone()).filter(|s| !sources.contains(s)).collect();
            units.clear();
            known.clear();
            errors.clear();
            providers = build::provider_files(dir).into_iter().map(|p| dir.join(p)).collect();
            plan.recompile = sources;
        }
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
        // Components importing a changed one read its type parameters and prop kinds, and
        // inheriting ones read their base's members.
        let compile_start = Instant::now();
        let mut recompile = plan.recompile;
        let scripts = build::changed_scripts(&batch, dir);
        // The last condition is a rebuild caused by no `.xzor` file, e.g. a removed folder of scripts.
        if plan.config || plan.di || !plan.remove.is_empty() || !scripts.is_empty() || (plan.rebuild && recompile.is_empty()) {
            hot = None;
        }
        let changed: Vec<&Path> = recompile.iter().chain(&plan.remove).chain(&scripts).map(PathBuf::as_path).collect();
        let dependents = build::dependents(&units, &changed);
        recompile.extend(dependents);
        routes_due |= plan.config || !recompile.is_empty() || !plan.remove.is_empty();
        let results = build::compile_many(&recompile);
        for (src, result) in recompile.iter().zip(results) {
            match result {
                Ok(unit) => {
                    build::print_warnings(&unit);
                    errors.remove(src);
                    known.insert(src.clone(), build::inject_signature(&unit.generated.injects));
                    match units.iter_mut().find(|u| u.source == unit.source) {
                        Some(slot) => {
                            // A style change swaps the page's style sheet: reload instead of patching.
                            if slot.generated.css != unit.generated.css {
                                hot = None;
                            }
                            if slot.generated.code != unit.generated.code {
                                if let Some(ids) = hot.as_mut() {
                                    ids.insert(hot_id(&unit.source, &unit.out));
                                }
                            }
                            *slot = unit;
                        }
                        None => {
                            hot = None;
                            units.push(unit);
                        }
                    }
                }
                Err(e) => {
                    // Tracked, so deleting a never-compiled file takes the remove path and clears its error.
                    known.entry(src.clone()).or_default();
                    errors.insert(src.clone(), e);
                }
            }
        }
        let timings = Timings { started: compile_start, compile: compile_start.elapsed(), ..Default::default() };
        if plan.rebuild {
            if errors.is_empty() {
                println!("xzor: compiled {} component(s)", recompile.len());
            } else {
                println!("xzor: compiled {} component(s), {} with errors", recompile.len(), errors.len());
            }
            let routes = (&mut routes_due, &mut routes_written);
            if let Err(e) = rebuild(o, &units, &errors, &providers, &mut analyzer, &mut di_due, &mut di_entry, routes, &mut hot, timings) {
                eprintln!("{e}");
            }
            println!("xzor: watching {} for changes (Ctrl+C to stop)", dir.display());
        }
        batch.clear();
        batch.push(events.recv().map_err(|_| "xzor: the file watcher exited".to_string())?);
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
    (routes_due, routes_written): (&mut bool, &mut HashSet<PathBuf>),
    hot: &mut Option<BTreeSet<String>>,
    mut t: Timings,
) -> Result<(), String> {
    if !errors.is_empty() {
        return Err(errors.values().cloned().collect::<Vec<_>>().join("\n"));
    }
    // A failed run stays due, so the next change retries it.
    if *routes_due {
        let start = Instant::now();
        if build::write_routes(units, routes_written, o.minify)? {
            *hot = None;
        }
        t.routes = start.elapsed();
        *routes_due = false;
    }
    if *di_due {
        *hot = None;
        let mut files: Vec<PathBuf> = providers.iter().map(|p| p.strip_prefix(&o.dir).unwrap_or(p).to_path_buf()).collect();
        files.sort_unstable();
        // A failed run stays due, so the next change retries it.
        let start = Instant::now();
        *di_entry = build::di_with(&o.dir, &o.entry, units, &files, analyzer)?;
        t.di = start.elapsed();
        *di_due = false;
    }
    finish(o, units, di_entry.as_deref(), hot, &mut t)?;
    t.print(o);
    Ok(())
}

/// The generated file's path relative to its project root (nearest `tsconfig.json`), `/`-separated.
fn hot_id(source: &Path, out: &Path) -> String {
    let rel = out.strip_prefix(build::project_root(source)).unwrap_or(out);
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}
