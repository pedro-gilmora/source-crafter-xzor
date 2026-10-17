pub mod analyzer;
pub mod ast;
pub mod build;
pub mod codegen;
pub mod di;
pub mod entities;
pub mod highlight;
pub mod inherit;
pub mod json;
pub mod lsp;
pub mod parser;
pub mod routes;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub message: String,
    pub line: usize,
    pub column: usize,
    /// Byte offset in the source.
    pub offset: usize,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.column, self.message)
    }
}

/// Compiles one `.xzor` source into a TypeScript module.
pub fn compile(source: &str, path: &Path) -> Result<String, Diagnostic> {
    compile_mapped(source, path).map(|g| g.code)
}

/// Like [`compile`], plus the source mappings between the `.xzor` and the generated code.
pub fn compile_mapped(source: &str, path: &Path) -> Result<codegen::Generated, Diagnostic> {
    compile_mapped_with(source, path, &|p| std::fs::read_to_string(p).ok())
}

/// Like [`compile_mapped`], reading `@inherits` base sources through `read`.
pub fn compile_mapped_with(source: &str, path: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Result<codegen::Generated, Diagnostic> {
    let (doc, _) = parser::parse(source).map_err(|e| {
        let (line, column) = line_col(source, e.offset);
        Diagnostic { message: e.message, line, column, offset: e.offset }
    })?;
    let file_name = path.file_name().map_or_else(|| "component.xzor".into(), |n| n.to_string_lossy());
    let stem = file_name.strip_suffix(".xzor").unwrap_or(&file_name);
    let (components, imported) = imported_components(&doc, path, read);
    if let Some(offset) = codegen::inject_constructor(&doc) {
        let (line, column) = line_col(source, offset);
        return Err(Diagnostic { message: codegen::ZDI08.into(), line, column, offset });
    }
    if let Some((message, offset)) = codegen::cascade_error(&doc) {
        let (line, column) = line_col(source, offset);
        return Err(Diagnostic { message, line, column, offset });
    }
    let base = inherit::base_members(&doc, path, read);
    let table = routes::table_spec(&build::project_root(path), path);
    let mut generated =
        codegen::generate_with(&doc, &codegen::class_name(stem), &file_name, &components, &base.members, &table)
            .map_err(|message| Diagnostic { message, line: 1, column: 1, offset: 0 })?;
    generated.deps = base.deps;
    generated.deps.extend(imported);
    if let (Some(name), Some(inherits)) = (base.unresolved, &doc.inherits) {
        let (line, column) = line_col(source, inherits.at);
        let message = format!("could not read base class '{name}'; use this.<member> for its members");
        generated.warnings.push(Diagnostic { message, line, column, offset: inherits.at });
    }
    Ok(generated)
}

/// Type parameters and prop kinds of each `.xzor` component imported by `doc`, read through `read`,
/// plus the files they came from.
fn imported_components(doc: &ast::Document, path: &Path, read: &dyn Fn(&Path) -> Option<String>) -> (HashMap<String, codegen::ComponentInfo>, Vec<PathBuf>) {
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut files = Vec::new();
    let mut infos = HashMap::new();
    for import in &doc.imports {
        let Some(name) = import.split_whitespace().next() else { continue };
        let Some(spec) = import.rsplit(['"', '\'']).nth(1) else { continue };
        if !spec.ends_with(".xzor") || !codegen::is_identifier(name) {
            continue;
        }
        let file = if spec.starts_with('.') {
            dir.join(spec)
        } else {
            match tsconfig_path(dir, spec, read) {
                Some(target) => component_source(&target),
                None => continue,
            }
        };
        if let Some(text) = read(&file) {
            let mut info = codegen::component_info(&text);
            resolve_string_aliases(&mut info, &text, &file, read, &mut files);
            infos.insert(name.to_string(), info);
        }
        files.push(file);
    }
    (infos, files)
}

/// Turns expression props typed by imported aliases of string literals (`type Size = "s" | "m"`)
/// into text props. Every module probed is added to `deps`, so editing it refreshes the importer.
fn resolve_string_aliases(info: &mut codegen::ComponentInfo, child: &str, child_path: &Path, read: &dyn Fn(&Path) -> Option<String>, deps: &mut Vec<PathBuf>) {
    if info.named_types.is_empty() {
        return;
    }
    let Ok((doc, _)) = parser::parse(child) else { return };
    let dir = child_path.parent().unwrap_or(Path::new("."));
    let mut modules: HashMap<PathBuf, Option<String>> = HashMap::new();
    let named = std::mem::take(&mut info.named_types);
    for (prop, names) in &named {
        let text = names.iter().all(|local| {
            let Some((original, spec)) = doc.imports.iter().find_map(|i| imported_binding(i, local)) else { return false };
            let Some((module_dir, module)) = resolve_module(dir, spec, read, deps, &mut modules) else { return false };
            alias_is_string(&module, &module_dir, original, 0, read, deps, &mut modules)
        });
        if text {
            info.props.insert(prop.clone(), codegen::PropKind::Text);
        }
    }
    info.named_types = named;
}

/// `("Kind", "./kinds")` when `import` (an `@import` without the keyword) binds `local`.
fn imported_binding<'a>(import: &'a str, local: &str) -> Option<(&'a str, &'a str)> {
    let open = import.find('{')?;
    let close = import[open..].find('}')? + open;
    let spec = import[close..].rsplit(['"', '\'']).nth(1)?;
    import[open + 1..close].split(',').find_map(|binding| {
        let binding = binding.trim().trim_start_matches("type ").trim();
        let (original, alias) = binding.split_once(" as ").map_or((binding, binding), |(o, a)| (o.trim(), a.trim()));
        (alias == local).then_some((original, spec))
    })
}

/// The text of a module and its directory: relative (`./sizes`, `./sizes.js`, `./sizes.ts`, `./dir`
/// with an index), or a package specifier mapped by the tsconfig `paths`.
fn resolve_module(dir: &Path, spec: &str, read: &dyn Fn(&Path) -> Option<String>, deps: &mut Vec<PathBuf>, cache: &mut HashMap<PathBuf, Option<String>>) -> Option<(PathBuf, String)> {
    let base = if spec.starts_with('.') { dir.join(spec.strip_suffix(".js").unwrap_or(spec)) } else { tsconfig_path(dir, spec, read)? };
    let base_str = base.to_string_lossy().into_owned();
    let candidates: Vec<PathBuf> = if base_str.ends_with(".ts") {
        vec![base]
    } else {
        vec![PathBuf::from(format!("{base_str}.ts")), PathBuf::from(format!("{base_str}.d.ts")), base.join("index.ts")]
    };
    for file in candidates {
        if !deps.contains(&file) {
            deps.push(file.clone());
        }
        let text = cache.entry(file.clone()).or_insert_with(|| read(&file)).clone();
        if let Some(text) = text {
            return Some((file.parent().unwrap_or(Path::new(".")).to_path_buf(), text));
        }
    }
    None
}

/// Where a package `spec` points through the `compilerOptions.paths` of the nearest tsconfig above
/// `dir`: the first target of the matching pattern with the longest prefix, as TypeScript picks.
fn tsconfig_path(dir: &Path, spec: &str, read: &dyn Fn(&Path) -> Option<String>) -> Option<PathBuf> {
    let (root, text) = dir.ancestors().find_map(|d| read(&d.join("tsconfig.json")).map(|t| (d, t)))?;
    let config = json::Json::parse(&text).ok()?;
    let options = config.get("compilerOptions")?;
    let base = options.get("baseUrl").and_then(json::Json::as_str).map_or_else(|| root.to_path_buf(), |b| root.join(b));
    let json::Json::Obj(paths) = options.get("paths")? else { return None };
    let mut best: Option<(usize, String)> = None;
    for (pattern, targets) in paths {
        let Some(target) = targets.as_array().and_then(|t| t.first()).and_then(json::Json::as_str) else { continue };
        let hit = match pattern.split_once('*') {
            None => (pattern == spec).then(|| (usize::MAX, target.to_string())),
            Some((pre, post)) => spec
                .strip_prefix(pre)
                .and_then(|rest| rest.strip_suffix(post))
                .map(|star| (pre.len(), target.replacen('*', star, 1))),
        };
        if let Some(hit) = hit.filter(|h| best.as_ref().is_none_or(|b| h.0 > b.0)) {
            best = Some(hit);
        }
    }
    Some(normalize(&base.join(best?.1)))
}

/// `a/b/../c` as `a/c`, without touching the file system.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir if matches!(out.components().next_back(), Some(std::path::Component::Normal(_))) => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            _ => out.push(part),
        }
    }
    out
}

/// The `.xzor` source behind a path: `<root>/.xzor/<rel>.xzor.ts` (the generated file) is `<root>/<rel>.xzor`.
fn component_source(path: &Path) -> PathBuf {
    let Some(generated) = path.to_str().and_then(|p| p.strip_suffix(".ts")) else { return path.to_path_buf() };
    let generated = Path::new(generated);
    let parts: Vec<_> = generated.components().collect();
    match parts.iter().rposition(|c| c.as_os_str() == ".xzor") {
        Some(at) => parts[..at].iter().chain(&parts[at + 1..]).collect(),
        None => generated.to_path_buf(),
    }
}

/// Whether `type <name> = ...` in `module` is a union of string literals, `string` and other such
/// aliases of the same module; a name the module re-exports (`export { type Name } from "./x"`) is followed.
fn alias_is_string(
    module: &str,
    dir: &Path,
    name: &str,
    depth: usize,
    read: &dyn Fn(&Path) -> Option<String>,
    deps: &mut Vec<PathBuf>,
    cache: &mut HashMap<PathBuf, Option<String>>,
) -> bool {
    if depth >= 8 {
        return false;
    }
    let Some(body) = alias_body(module, name) else {
        let Some((original, spec)) = module.match_indices("export").find_map(|(at, _)| imported_binding(reexport_clause(&module[at..]), name)) else {
            return false;
        };
        let Some((next_dir, next)) = resolve_module(dir, spec, read, deps, cache) else { return false };
        return alias_is_string(&next, &next_dir, original, depth + 1, read, deps, cache);
    };
    body.split('|').map(str::trim).filter(|t| !t.is_empty()).all(|t| {
        t == "string"
            || (t.len() >= 2 && (t.starts_with('"') && t.ends_with('"') || t.starts_with('\'') && t.ends_with('\'')))
            || (t.len() >= 2 && t.starts_with('`') && t.ends_with('`') && !t.contains("${"))
            || (codegen::is_identifier(t) && alias_is_string(module, dir, t, depth + 1, read, deps, cache))
    })
}

/// `export { ... } from "x"` (or `export type { ... }`) at the start of `text`, up to its `;` or line end;
/// empty when `text` starts another export.
fn reexport_clause(text: &str) -> &str {
    let rest = text["export".len()..].trim_start();
    let rest = rest.strip_prefix("type").map_or(rest, str::trim_start);
    let Some(close) = text.find('}').filter(|_| rest.starts_with('{')) else { return "" };
    let end = text[close..].find([';', '\n']).map_or(text.len(), |n| close + n);
    &text[..end]
}

/// The right-hand side of `[export] type <name> = ...`, up to its `;` or the next statement.
fn alias_body<'a>(module: &'a str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(i) = module[from..].find("type ") {
        let at = from + i;
        from = at + 5;
        let line_start = module[..at].rfind('\n').map_or(0, |n| n + 1);
        if !matches!(module[line_start..at].trim(), "" | "export" | "declare" | "export declare") {
            continue;
        }
        let rest = module[at + 5..].trim_start();
        let Some(after) = rest.strip_prefix(name) else { continue };
        let Some(body) = after.trim_start().strip_prefix('=') else { continue };
        // Ends at `;`, or at a line that starts something other than a `|` continuation.
        let (mut end, mut pos) = (body.len(), 0);
        for (i, line) in body.split_inclusive('\n').enumerate() {
            if let Some(semi) = line.find(';') {
                end = pos + semi;
                break;
            }
            let trimmed = line.trim_start();
            if i > 0 && !trimmed.is_empty() && !trimmed.starts_with('|') {
                end = pos;
                break;
            }
            pos += line.len();
        }
        return Some(&body[..end]);
    }
    None
}

/// 1-based line and column (in bytes) of a byte offset.
pub fn line_col(src: &str, offset: usize) -> (usize, usize) {
    let before = &src.as_bytes()[..offset.min(src.len())];
    let line_start = before.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
    (line, offset - line_start + 1)
}

pub(crate) fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}

pub(crate) fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warnings(src: &str) -> Vec<Diagnostic> {
        compile_mapped(src, Path::new("App.xzor")).unwrap().warnings
    }

    #[test]
    fn warns_when_the_base_cannot_be_read() {
        let src = "@import { Base } from \"pkg-missing\"\n@inherits Base\n<p/>\n";
        let w = warnings(src);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].message, "could not read base class 'Base'; use this.<member> for its members");
        assert_eq!((w[0].line, w[0].column), (2, 11));
        assert_eq!(w[0].offset, src.find("Base\n<p/>").unwrap());
    }

    #[test]
    fn no_warning_without_a_readable_chain() {
        assert!(warnings("<p/>\n").is_empty());
        assert!(warnings("@import { ComponentBase } from \"@source-crafter/xzor-runtime\"\n@inherits ComponentBase\n<p/>\n").is_empty());
    }

    /// The editor's text of an imported component decides its prop kinds, and a change to it refreshes the importer.
    #[test]
    fn imported_components_are_read_through_the_reader_and_listed_in_deps() {
        let root = Path::new("/p");
        let child = root.join("Code.xzor");
        let read = |text: &'static str| {
            let child = child.clone();
            move |p: &Path| (p == child).then(|| text.to_string())
        };
        let main = "@import Code from \"./Code.xzor\"\n<Code name=\"hero\" />\n";
        let g = compile_mapped_with(main, &root.join("Page.xzor"), &read("@code { name = \"x\" as Name; }\n")).unwrap();
        assert!(g.code.contains("name: \"hero\""), "{}", g.code);
        assert!(g.deps.contains(&child), "{:?}", g.deps);
        let g = compile_mapped_with(main, &root.join("Page.xzor"), &read("@code { name: number = 1; }\n")).unwrap();
        assert!(g.code.contains("name: hero"), "{}", g.code);
    }

    /// `size?: Size` with `export type Size = "s" | "m"` in the imported module takes text, like `string`.
    #[test]
    fn props_typed_by_an_imported_string_alias_take_text() {
        let root = Path::new("/p");
        let files: HashMap<PathBuf, &str> = [
            (root.join("Child.xzor"), "@import { type Size, type Count } from \"./sizes\"\n@import type { Kind as K } from \"./kinds.js\"\n@code { size?: Size; count?: Count; kind?: K; other?: Other; }\n<p/>"),
            (root.join("sizes.ts"), "export type Size = \"s\" | \"m\" | Extra;\ntype Extra =\n  | 'xl'\n  | string;\nexport type Count = 1 | 2;\n"),
            (root.join("kinds.ts"), "export type Kind = `a` | \"b\";\n"),
        ]
        .into_iter()
        .collect();
        let read = |p: &Path| files.get(p).map(|t| t.to_string());
        let main = "@import Child from \"./Child.xzor\"\n<Child size=\"m\" count=\"n\" kind=\"a\" other=\"o\" />\n";
        let g = compile_mapped_with(main, &root.join("Page.xzor"), &read).unwrap();
        for m in ["size: \"m\"", "count: n", "kind: \"a\"", "other: o"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
        // An edit to the alias module refreshes the importer.
        assert!(g.deps.contains(&root.join("sizes.ts")) && g.deps.contains(&root.join("kinds.ts")), "{:?}", g.deps);
    }

    /// A kit outside the project: `@kit/Button.xzor` maps through the tsconfig `paths` to the generated
    /// file, whose source gives the prop kinds; aliases are followed through `paths` and re-exports.
    #[test]
    fn components_imported_through_tsconfig_paths_take_their_prop_kinds() {
        let root = Path::new("/p");
        let files: HashMap<PathBuf, &str> = [
            (root.join("app").join("tsconfig.json"), r#"{"compilerOptions":{"paths":{"@kit":["../kit/index.ts"],"@kit/*":["../kit/.xzor/*.ts"]}}}"#),
            (root.join("kit").join("tsconfig.json"), r#"{"compilerOptions":{"paths":{"@kit":["./index.ts"]}}}"#),
            (root.join("kit").join("Button.xzor"), "@import { type Tone } from \"@kit\"\n@code { tone?: Tone; count = 0; }\n<p/>"),
            (root.join("kit").join("index.ts"), "export const x = 1;\nexport { icons, type Tone as Tone } from \"./tones\";\n"),
            (root.join("kit").join("tones.ts"), "export type Tone = \"neutral\" | \"accent\";\n"),
        ]
        .into_iter()
        .collect();
        let read = |p: &Path| files.get(p).map(|t| t.to_string());
        let main = "@import Button from \"@kit/Button.xzor\"\n<Button tone=\"accent\" count=\"n + 1\" />\n";
        let g = compile_mapped_with(main, &root.join("app").join("Page.xzor"), &read).unwrap();
        for m in ["tone: \"accent\"", "count: n + 1"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
        assert!(g.deps.contains(&root.join("kit").join("Button.xzor")) && g.deps.contains(&root.join("kit").join("tones.ts")), "{:?}", g.deps);
    }
}
