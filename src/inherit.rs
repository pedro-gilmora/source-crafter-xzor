//! Instance members inherited through `@inherits`, read from the base classes' sources.

use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use crate::ast::Document;
use crate::codegen::{is_comment, member_decls, skip_braces, skip_literal, word_prev};
use crate::json::Json;
use crate::{is_ident_char, is_ident_start};

/// Bases followed from the component's own; deeper ones contribute nothing.
const MAX_DEPTH: usize = 8;

type Read<'r> = &'r dyn Fn(&Path) -> Option<String>;

/// What a component inherits, plus what it took to find out.
pub struct BaseMembers {
    pub members: HashSet<String>,
    /// Every file probed on the way, found or not.
    pub deps: Vec<PathBuf>,
    /// The first base class that could not be read, if any.
    pub unresolved: Option<String>,
}

/// Members of `doc`'s `@inherits` base chain, read through `read` (the LSP reads open documents first).
pub fn base_members(doc: &Document, path: &Path, read: Read) -> BaseMembers {
    let mut members = HashSet::new();
    let base = doc.inherits.as_deref().map(leading_ident).filter(|b| *b != "ComponentBase");
    let Some(base) = base else { return BaseMembers { members, deps: Vec::new(), unresolved: None } };
    let mut chain = Chain { read, files: Vec::new() };
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut next = chain.imported(dir, doc.imports.iter().filter_map(|i| split_import(i)), base);
    let mut unresolved = next.is_none().then(|| base.to_string());
    let mut seen: Vec<(PathBuf, String)> = Vec::new();
    while let Some((file, text, class)) = next.take() {
        if seen.len() == MAX_DEPTH || seen.iter().any(|(f, c)| *f == file && *c == class) {
            break;
        }
        match chain.members(&file, &text, &class, &mut members) {
            Step::Base(link) => next = Some(link),
            Step::Done => {}
            Step::Missing(name) => unresolved = Some(name),
        }
        seen.push((file, class));
    }
    BaseMembers { members, deps: chain.files.into_iter().map(|(p, _)| p).collect(), unresolved }
}

/// A file's text and, once a script needs them, its tokens.
struct Source {
    text: String,
    toks: OnceCell<Vec<Tok>>,
}

/// A file on the chain, its source and the class name in it (`default` for a default export).
type Link = (PathBuf, Rc<Source>, String);

/// Where a class is declared, after following re-exports.
enum Decl {
    Class { file: PathBuf, src: Rc<Source>, base: Option<String>, body: std::ops::Range<usize> },
    /// A re-exported `.xzor`, whose members come from its document rather than from a class body.
    Component { file: PathBuf, src: Rc<Source> },
}

/// What one link of the chain led to.
enum Step {
    Base(Link),
    /// The chain ended at `ComponentBase` or at a class with no base.
    Done,
    /// This class could not be read.
    Missing(String),
}

struct Chain<'r> {
    read: Read<'r>,
    /// Every file read so far, including misses, so each is read once.
    files: Vec<(PathBuf, Option<Rc<Source>>)>,
}

impl Chain<'_> {
    fn load(&mut self, path: &Path) -> Option<Rc<Source>> {
        if let Some((_, src)) = self.files.iter().find(|(p, _)| p == path) {
            return src.clone();
        }
        // ponytail: each file is read once per compile, so a package barrel is re-read every compile;
        // if that shows up, cache sources by path and mtime across compiles.
        let src = (self.read)(path).map(|text| Rc::new(Source { text, toks: OnceCell::new() }));
        self.files.push((path.to_path_buf(), src.clone()));
        src
    }

    fn module(&mut self, dir: &Path, spec: &str) -> Option<(PathBuf, Rc<Source>)> {
        if !(spec.starts_with("./") || spec.starts_with("../")) {
            return self.package(dir, spec);
        }
        let base = normalize(&dir.join(spec));
        let candidates = if spec.ends_with(".xzor") {
            vec![base]
        } else {
            let mut c = Vec::new();
            // `./a.js` names `a.ts` (nodenext style).
            if let Some(stem) = spec.strip_suffix(".js") {
                let stem = normalize(&dir.join(stem));
                c.extend([with_suffix(&stem, ".ts"), with_suffix(&stem, ".tsx"), with_suffix(&stem, ".d.ts")]);
            }
            c.extend([
                base.clone(),
                with_suffix(&base, ".ts"),
                with_suffix(&base, ".tsx"),
                with_suffix(&base, ".d.ts"),
                base.join("index.ts"),
                base.join("index.d.ts"),
            ]);
            c
        };
        candidates.into_iter().find_map(|p| self.load(&p).map(|t| (p, t)))
    }

    /// A bare specifier's declarations, from the first `node_modules` at or above `dir` that has them.
    fn package(&mut self, dir: &Path, spec: &str) -> Option<(PathBuf, Rc<Source>)> {
        let (pkg, sub) = split_package(spec);
        let types = match pkg.strip_prefix('@') {
            Some(scoped) => format!("@types/{}", scoped.replace('/', "__")),
            None => format!("@types/{pkg}"),
        };
        let mut at = Some(dir);
        while let Some(d) = at {
            let modules = d.join("node_modules");
            for name in [pkg, types.as_str()] {
                if let Some(found) = self.package_entry(&modules.join(name), sub) {
                    return Some(found);
                }
            }
            at = d.parent();
        }
        None
    }

    /// The declaration file package `root` exposes for `sub` (`None` for the package itself).
    /// A directory with no manifest is not a package, so nothing further is probed in it.
    fn package_entry(&mut self, root: &Path, sub: Option<&str>) -> Option<(PathBuf, Rc<Source>)> {
        let manifest = self.load(&root.join("package.json"))?;
        let json = Json::parse(&manifest.text).unwrap_or_default();
        let mut candidates: Vec<String> = Vec::new();
        match sub {
            Some(sub) => {
                candidates.extend(exports_types(&json["exports"], &format!("./{sub}")));
                candidates.extend([format!("{sub}.d.ts"), format!("{sub}/index.d.ts")]);
            }
            None => {
                candidates.extend(["types", "typings"].iter().filter_map(|f| json[*f].as_str().map(|t| declaration(t.to_string()))));
                candidates.extend(exports_types(&json["exports"], "."));
                candidates.push("index.d.ts".into());
            }
        }
        candidates.into_iter().find_map(|c| {
            let path = normalize(&root.join(c));
            self.load(&path).map(|src| (path, src))
        })
    }

    /// The class `name` imports, through `imports` (clause and specifier pairs) relative to `dir`.
    fn imported<'a, C: AsRef<str>>(&mut self, dir: &Path, imports: impl Iterator<Item = (C, &'a str)>, name: &str) -> Option<Link> {
        let (original, spec) = find_import(imports, name)?;
        let (file, text) = self.module(dir, spec)?;
        Some((file, text, original))
    }

    /// The declaration of class `name` in `file`, or in the files `file` re-exports it from.
    fn find(&mut self, file: PathBuf, src: Rc<Source>, name: &str, visited: &mut Vec<(PathBuf, String)>) -> Option<Decl> {
        if file.extension().is_some_and(|e| e == "xzor") {
            return Some(Decl::Component { file, src });
        }
        if visited.iter().any(|(f, n)| *f == file && n == name) {
            return None;
        }
        visited.push((file.clone(), name.to_string()));
        let declared = {
            let text = &src.text;
            let toks = src.toks.get_or_init(|| tokens(text));
            find_class(text, toks, (name != "default").then_some(name)).map(|(b, body)| (b.map(str::to_string), body))
        };
        if let Some((base, body)) = declared {
            return Some(Decl::Class { file, src, base, body });
        }
        // Where else to look: the re-export naming it, then every `export *` target.
        let targets: Vec<(String, String)> = {
            let text = &src.text;
            let toks = src.toks.get_or_init(|| tokens(text));
            let (named, stars) = ts_exports(text, toks);
            let mut t = Vec::new();
            match named.iter().find_map(|(clause, spec)| imported_as(clause, name).map(|o| (o, *spec))) {
                Some((original, Some(spec))) => t.push((original, spec.to_string())),
                // `export { A }` re-exports whatever an `import { A } from "./a"` bound.
                Some((original, None)) => t.extend(find_import(ts_imports(text, toks).into_iter(), &original).map(|(o, s)| (o, s.to_string()))),
                None => {}
            }
            t.extend(stars.iter().map(|s| (name.to_string(), s.to_string())));
            t
        };
        let dir = file.parent().unwrap_or(Path::new("."));
        targets.into_iter().find_map(|(name, spec)| {
            let (file, src) = self.module(dir, &spec)?;
            self.find(file, src, &name, visited)
        })
    }

    /// Adds the members of `class` in `file` to `out` and reports where the chain goes next.
    fn members(&mut self, file: &Path, src: &Rc<Source>, class: &str, out: &mut HashSet<String>) -> Step {
        if file.extension().is_some_and(|e| e == "xzor") {
            return self.component_members(file, src, class, out);
        }
        let (file, src, base, body) = match self.find(file.to_path_buf(), src.clone(), class, &mut Vec::new()) {
            Some(Decl::Class { file, src, base, body }) => (file, src, base, body),
            Some(Decl::Component { file, src }) => return self.component_members(&file, &src, class, out),
            None => return Step::Missing(class.to_string()),
        };
        class_members(&src.text[body], out);
        let Some(base) = base else { return Step::Done };
        if base == "ComponentBase" {
            return Step::Done;
        }
        let from = {
            let text = &src.text;
            let toks = src.toks.get_or_init(|| tokens(text));
            find_import(ts_imports(text, toks).into_iter(), &base).map(|(o, s)| (o, s.to_string()))
        };
        match from {
            Some((original, spec)) => {
                let dir = file.parent().unwrap_or(Path::new("."));
                match self.module(dir, &spec) {
                    Some((file, src)) => Step::Base((file, src, original)),
                    None => Step::Missing(base),
                }
            }
            None => Step::Base((file, src, base)),
        }
    }

    /// Adds the members a `.xzor` component declares to `out` and reports where its `@inherits` goes next.
    fn component_members(&mut self, file: &Path, src: &Rc<Source>, class: &str, out: &mut HashSet<String>) -> Step {
        let dir = file.parent().unwrap_or(Path::new("."));
        let Ok((doc, _)) = crate::parser::parse(&src.text) else { return Step::Missing(class.to_string()) };
        for code in &doc.code {
            class_members(code, out);
        }
        out.extend(doc.injects.iter().map(|i| i.name.text.clone()));
        let Some(inherits) = &doc.inherits else { return Step::Done };
        let base = leading_ident(inherits);
        if base == "ComponentBase" {
            return Step::Done;
        }
        match self.imported(dir, doc.imports.iter().filter_map(|i| split_import(i)), base) {
            Some(link) => Step::Base(link),
            None => Step::Missing(base.to_string()),
        }
    }
}

/// A bare specifier's package name and subpath: `@scope/x/y` → `("@scope/x", Some("y"))`.
fn split_package(spec: &str) -> (&str, Option<&str>) {
    match spec.match_indices('/').nth(usize::from(spec.starts_with('@'))) {
        Some((i, _)) => (&spec[..i], Some(&spec[i + 1..])),
        None => (spec, None),
    }
}

/// The declaration file `exports` gives for subpath `key`.
fn exports_types(exports: &Json, key: &str) -> Option<String> {
    // A map with no subpath keys is a condition map for "." rather than a list of subpaths.
    let sugar = key == "." && matches!(exports, Json::Obj(o) if !o.iter().any(|(k, _)| k.starts_with('.')));
    let target = match exports {
        Json::Str(s) if key == "." => Some(s.clone()),
        _ if sugar => condition_types(exports),
        _ => match exports.get(key) {
            Some(entry) => condition_types(entry),
            None => pattern_types(exports, key),
        },
    }?;
    Some(declaration(target))
}

/// The target of the single-`*` subpath pattern matching `key` with the longest prefix (as Node picks),
/// with the matched text spliced in.
fn pattern_types(exports: &Json, key: &str) -> Option<String> {
    let Json::Obj(entries) = exports else { return None };
    let (_, matched, v) = entries
        .iter()
        .filter_map(|(k, v)| {
            let (prefix, suffix) = k.split_once('*')?;
            if !prefix.starts_with("./") || suffix.contains('*') {
                return None;
            }
            Some((prefix, key.strip_prefix(prefix)?.strip_suffix(suffix)?, v))
        })
        .max_by_key(|(prefix, _, _)| prefix.len())?;
    let target = condition_types(v)?;
    Some(match target.split_once('*') {
        Some((head, tail)) => format!("{head}{matched}{tail}"),
        None => target,
    })
}

/// A `./x.js` target names the sibling `./x.d.ts`; a declaration target is kept as it is.
fn declaration(target: String) -> String {
    for (js, dts) in [(".js", ".d.ts"), (".mjs", ".d.mts"), (".cjs", ".d.cts")] {
        if let Some(stem) = target.strip_suffix(js) {
            return format!("{stem}{dts}");
        }
    }
    target
}

/// The `"types"` target of an exports entry, searched through nested condition objects.
fn condition_types(entry: &Json) -> Option<String> {
    match entry {
        Json::Str(s) => Some(s.clone()),
        Json::Obj(conditions) => entry["types"].as_str().map(str::to_string).or_else(|| {
            conditions.iter().filter(|(_, v)| matches!(v, Json::Obj(_))).find_map(|(_, v)| condition_types(v))
        }),
        _ => None,
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    s.into()
}

fn leading_ident(s: &str) -> &str {
    let s = s.trim_start();
    &s[..s.bytes().position(|c| !is_ident_char(c)).unwrap_or(s.len())]
}

/// Clause and specifier of an `@import` value like `{ A } from "./a"`.
fn split_import(s: &str) -> Option<(&str, &str)> {
    let end = s.rfind(['"', '\''])?;
    let open = s[..end].rfind(['"', '\''])?;
    Some((s[..open].trim_end().strip_suffix("from")?, &s[open + 1..end]))
}

/// The imported name bound to `name` (`default` for a default import) and its specifier.
fn find_import<'a, C: AsRef<str>>(imports: impl Iterator<Item = (C, &'a str)>, name: &str) -> Option<(String, &'a str)> {
    imports.into_iter().find_map(|(clause, spec)| imported_as(clause.as_ref(), name).map(|o| (o, spec)))
}

/// What `clause` (`D, { A, B as C, type E }`, `type { F }`) imports as `name`.
fn imported_as(clause: &str, name: &str) -> Option<String> {
    let clause = clause.trim();
    let clause = clause.strip_prefix("type").filter(|r| r.starts_with(char::is_whitespace)).map_or(clause, str::trim_start);
    let (default, named) = match clause.find('{') {
        Some(open) => (clause[..open].trim().trim_end_matches(',').trim(), &clause[open + 1..]),
        None => (clause, ""),
    };
    if default == name {
        return Some("default".into());
    }
    for item in named.split('}').next()?.split(',') {
        let words: Vec<&str> = item.split_whitespace().collect();
        let words = if words.len() > 1 && words[0] == "type" { &words[1..] } else { &words[..] };
        match words {
            [w] if *w == name => return Some(w.to_string()),
            [original, "as", local] if *local == name => return Some(original.to_string()),
            _ => {}
        }
    }
    None
}

/// Instance members of a class body: no statics, plus constructor parameter properties.
fn class_members(body: &str, out: &mut HashSet<String>) {
    for d in member_decls(body) {
        if d.is_static {
            continue;
        }
        if d.name == "constructor" && d.is_method {
            parameter_properties(&body[d.offset..], out);
        } else {
            out.insert(d.name);
        }
    }
}

/// Names of `constructor(public x, readonly y = 1)`-style parameters in the list starting at the first `(`.
fn parameter_properties(ctor: &str, out: &mut HashSet<String>) {
    const MODIFIERS: &[&str] = &["public", "private", "protected", "readonly", "override"];
    let b = ctor.as_bytes();
    let Some(open) = ctor.find('(') else { return };
    let mut depth = 0i32;
    let mut start = open + 1;
    let mut prev = None;
    let mut i = open;
    while i < b.len() {
        if let Some(end) = skip_literal(b, i, prev) {
            prev = Some(b'"');
            i = end;
            continue;
        }
        if is_ident_start(b[i]) && (i == 0 || !is_ident_char(b[i - 1])) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            prev = Some(word_prev(&ctor[start..i], prev));
            continue;
        }
        match b[i] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b'>' if prev == Some(b'=') => {}
            b')' | b']' | b'}' | b'>' => depth -= 1,
            _ => {}
        }
        if (b[i] == b',' && depth == 1) || depth == 0 {
            let mut rest = ctor[start..i].trim_start();
            let mut modified = false;
            loop {
                let w = leading_ident(rest);
                if !MODIFIERS.contains(&w) || !rest[w.len()..].starts_with(char::is_whitespace) {
                    break;
                }
                modified = true;
                rest = rest[w.len()..].trim_start();
            }
            let name = leading_ident(rest);
            if modified && !name.is_empty() {
                out.insert(name.to_string());
            }
            if depth == 0 {
                return;
            }
            start = i + 1;
        }
        if !b[i].is_ascii_whitespace() {
            prev = Some(b[i]);
        }
        i += 1;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ident,
    Str,
    Punct,
}

#[derive(Clone, Copy)]
struct Tok {
    kind: Kind,
    start: usize,
    end: usize,
}

/// Identifiers, quoted strings and punctuation of TypeScript source; comments, template literals and
/// regex literals are skipped.
fn tokens(text: &str) -> Vec<Tok> {
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 4);
    let mut prev = None;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if let Some(end) = skip_literal(b, i, prev) {
            if !is_comment(b, i) {
                prev = Some(b'"');
                if matches!(c, b'"' | b'\'') {
                    out.push(Tok { kind: Kind::Str, start: i, end });
                }
            }
            i = end;
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            out.push(Tok { kind: Kind::Ident, start, end: i });
            prev = Some(word_prev(&text[start..i], prev));
            continue;
        }
        if !c.is_ascii_whitespace() {
            out.push(Tok { kind: Kind::Punct, start: i, end: i + 1 });
            prev = Some(c);
        }
        i += 1;
    }
    out
}

/// The contents of a quoted string token; an unterminated literal has no closing quote to strip.
fn str_text<'t>(text: &'t str, t: &Tok) -> Option<&'t str> {
    (t.kind == Kind::Str && t.end > t.start + 1).then(|| &text[t.start + 1..t.end - 1])
}

/// Top-level `import ... from "spec"` statements as clause and specifier pairs; a clause is its
/// tokens joined by spaces, so comments in it are gone.
fn ts_imports<'t>(text: &'t str, toks: &[Tok]) -> Vec<(String, &'t str)> {
    let s = |t: &Tok| &text[t.start..t.end];
    let mut out = Vec::new();
    let mut depth = 0i32;
    for (i, t) in toks.iter().enumerate() {
        match (t.kind, s(t)) {
            (Kind::Punct, "{") => depth += 1,
            (Kind::Punct, "}") => depth -= 1,
            (Kind::Ident, "import") if depth == 0 && toks.get(i + 1).is_some_and(|n| !matches!(s(n), "(" | ".")) => {
                let Some(at) = toks[i + 1..].iter().position(|n| n.kind == Kind::Str || s(n) == ";") else { continue };
                let (from, spec) = (i + at, toks[i + 1 + at]);
                if at > 0 && s(&toks[from]) == "from" {
                    if let Some(target) = str_text(text, &spec) {
                        let clause: Vec<&str> = toks[i + 1..from].iter().map(s).collect();
                        out.push((clause.join(" "), target));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Top-level `export { ... }` clauses with their specifier, and `export * from "spec"` targets.
fn ts_exports<'t>(text: &'t str, toks: &[Tok]) -> (Vec<(String, Option<&'t str>)>, Vec<&'t str>) {
    let s = |i: usize| toks.get(i).map_or("", |t: &Tok| &text[t.start..t.end]);
    let spec_at = |i: usize| toks.get(i).and_then(|t| str_text(text, t));
    let (mut named, mut stars) = (Vec::new(), Vec::new());
    let mut depth = 0i32;
    let mut i = 0;
    while i < toks.len() {
        match s(i) {
            "{" => depth += 1,
            "}" => depth -= 1,
            _ => {}
        }
        if depth != 0 || s(i) != "export" {
            i += 1;
            continue;
        }
        let j = if s(i + 1) == "type" && matches!(s(i + 2), "{" | "*") { i + 2 } else { i + 1 };
        if s(j) == "*" {
            // `export * as ns from "m"` binds a namespace object, not a class.
            if s(j + 1) == "from" {
                stars.extend(spec_at(j + 2));
            }
            i = j + 3;
            continue;
        }
        if s(j) != "{" {
            i += 1;
            continue;
        }
        let Some(close) = (j + 1..toks.len()).find(|&k| s(k) == "}") else { break };
        let clause: Vec<&str> = toks[j..=close].iter().map(|t| &text[t.start..t.end]).collect();
        named.push((clause.join(" "), (s(close + 1) == "from").then(|| spec_at(close + 2)).flatten()));
        i = close + 1;
    }
    (named, stars)
}

/// The `extends` name and body range of class `name`, or of the default-exported class for `None`.
fn find_class<'t>(text: &'t str, toks: &[Tok], name: Option<&str>) -> Option<(Option<&'t str>, std::ops::Range<usize>)> {
    let s = |i: usize| toks.get(i).map_or("", |t: &Tok| &text[t.start..t.end]);
    let at = match name {
        Some(name) => (0..toks.len()).find(|&i| s(i) == "class" && s(i + 1) == name)? + 2,
        None => {
            let i = (0..toks.len()).find(|&i| s(i) == "export" && s(i + 1) == "default")? + 2;
            let i = if s(i) == "abstract" { i + 1 } else { i };
            if s(i) != "class" {
                return find_class(text, toks, Some(s(i)).filter(|n| !n.is_empty() && toks[i].kind == Kind::Ident));
            }
            if toks.get(i + 1).is_some_and(|t| t.kind == Kind::Ident) && !matches!(s(i + 1), "extends" | "implements") { i + 2 } else { i + 1 }
        }
    };
    let mut base = None;
    let mut angle = 0i32;
    for i in at..toks.len() {
        match s(i) {
            "<" => angle += 1,
            ">" if s(i - 1) != "=" => angle -= 1,
            "extends" if angle == 0 && base.is_none() => base = Some(s(i + 1)).filter(|b| !b.is_empty()),
            "{" if angle == 0 => {
                let open = toks[i].start;
                let close = skip_braces(text.as_bytes(), open);
                return Some((base, open + 1..close.saturating_sub(1).max(open + 1)));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn compile_in(files: &[(&str, &str)], main: &str) -> (String, HashMap<PathBuf, usize>) {
        let root = Path::new("/p");
        let map: HashMap<PathBuf, String> = files.iter().map(|(n, t)| (root.join(n), t.to_string())).collect();
        let reads = RefCell::new(HashMap::new());
        let read = |p: &Path| {
            *reads.borrow_mut().entry(p.to_path_buf()).or_insert(0) += 1;
            map.get(p).cloned()
        };
        let code = crate::compile_mapped_with(main, &root.join("C.xzor"), &read).unwrap().code;
        (code, reads.into_inner())
    }

    fn compile(files: &[(&str, &str)], main: &str) -> String {
        compile_at(files, main, "C.xzor")
    }

    /// Compiles `main` as if it sat at `at` under `/p`.
    fn compile_at(files: &[(&str, &str)], main: &str, at: &str) -> String {
        let root = Path::new("/p");
        let map: HashMap<PathBuf, String> = files.iter().map(|(n, t)| (root.join(n), t.to_string())).collect();
        crate::compile_mapped_with(main, &root.join(at), &|p| map.get(p).cloned()).unwrap().code
    }

    fn unresolved_in(files: &[(&str, &str)], main: &str) -> Option<String> {
        let root = Path::new("/p");
        let map: HashMap<PathBuf, String> = files.iter().map(|(n, t)| (root.join(n), t.to_string())).collect();
        let (doc, _) = crate::parser::parse(main).unwrap();
        base_members(&doc, &root.join("C.xzor"), &|p| map.get(p).cloned()).unresolved
    }

    const TITLED: &str = r#"import { ComponentBase } from "@xzor/runtime";
// } a stray brace in a comment
export abstract class Titled extends ComponentBase {
  title = "}";
  static create() { return 1; }
  private re = /\}/;
  tpl = `${ "}" } }`;
  constructor(public x: number, readonly y = 2, z: string) { super(); }
  abstract describe(): string;
  get upper() { return this.title.toUpperCase(); }
}
export class After { late = 1; }
"#;

    #[test]
    fn ts_base_members_are_rewritten() {
        let main = "@import { Titled } from \"./base\"\n@inherits Titled\n<p>@title @describe() @x @y @upper @tpl @create() @z @late</p>\n";
        let (code, reads) = compile_in(&[("base.ts", TITLED)], main);
        for m in ["this.title", "this.describe()", "this.x", "this.y", "this.upper", "this.tpl"] {
            assert!(code.contains(m), "{m} missing in\n{code}");
        }
        for m in ["this.create", "this.z", "this.late", "this.constructor"] {
            assert!(!code.contains(m), "{m} in\n{code}");
        }
        assert_eq!(reads.get(&Path::new("/p").join("base.ts")), Some(&1));
    }

    #[test]
    fn follows_a_chain_across_files() {
        let a = "import { ComponentBase } from \"@xzor/runtime\";\nexport class A extends ComponentBase { a = 1; }\n";
        let b = "import {\n  A,\n} from './a';\nexport class B extends A { b = 2; }\nclass Local extends B { l = 3; }\nexport { Local };\n";
        let code = compile(&[("a.ts", a), ("lib/b.ts", b.replace("'./a'", "'../a'").as_str())], "@import { B } from \"./lib/b\"\n@inherits B\n<p>@a @b</p>\n");
        assert!(code.contains("this.a") && code.contains("this.b"), "{code}");
        // A base in the same file.
        let code = compile(&[("a.ts", a), ("b.ts", b)], "@import { Local } from \"./b\"\n@inherits Local\n<p>@a @b @l</p>\n");
        assert!(code.contains("this.a") && code.contains("this.b") && code.contains("this.l"), "{code}");
    }

    #[test]
    fn deps_list_every_probed_file_hits_and_misses() {
        let root = Path::new("/p");
        let a = "export class A { a = 1; }\n";
        let b = "import { A } from \"./a\";\nexport class B extends A { b = 1; }\n";
        let map: std::collections::HashMap<PathBuf, String> = [("a.ts", a), ("b.ts", b)].iter().map(|(n, t)| (root.join(n), t.to_string())).collect();
        let main = "@import { B } from \"./b\"\n@inherits B\n<p>@a</p>\n";
        let g = crate::compile_mapped_with(main, &root.join("C.xzor"), &|p| map.get(p).cloned()).unwrap();
        for f in ["a.ts", "b", "b.ts"] {
            assert!(g.deps.contains(&root.join(f)), "{f} missing in {:?}", g.deps);
        }
        let main = "@import { Gone } from \"./gone\"\n@inherits Gone\n<p/>\n";
        let g = crate::compile_mapped_with(main, &root.join("C.xzor"), &|_| None).unwrap();
        assert!(g.deps.contains(&root.join("gone.ts")) && g.deps.contains(&root.join("gone").join("index.ts")), "{:?}", g.deps);
    }

    #[test]
    fn comments_inside_an_import_clause_are_ignored() {
        let a = "export class A { a = 1; }\n";
        for imp in ["import { /* c */ A as AA } from './a';", "import {\n  // x\n  A as AA,\n} from './a';", "import /* d */ { A as AA /* e */ } from \"./a\" // f"] {
            let b = format!("{imp}\nexport class B extends AA {{ b = 2; }}\n");
            let code = compile(&[("a.ts", a), ("b.ts", &b)], "@import { B } from \"./b\"\n@inherits B\n<p>@a @b</p>\n");
            assert!(code.contains("this.a") && code.contains("this.b"), "{imp}\n{code}");
        }
    }

    #[test]
    fn a_regex_after_a_keyword_does_not_end_the_class_early() {
        let base = "export class R {\n  m() { return /}/.test(\"x\") }\n  n() { throw /}/ }\n  b7 = 2;\n}\n";
        let code = compile(&[("r.ts", base)], "@import { R } from \"./r\"\n@inherits R\n<p>@b7</p>\n");
        assert!(code.contains("this.b7"), "{code}");
    }

    #[test]
    fn constructor_regex_with_paren_keeps_later_properties() {
        let base = "export class K {\n  constructor(public check = (s: string) => { return /[)]/.test(s); }, public n = 0) { super(); }\n}\n";
        let code = compile(&[("k.ts", base)], "@import { K } from \"./k\"\n@inherits K\n<p>@check @n</p>\n");
        assert!(code.contains("this.check") && code.contains("this.n"), "{code}");
    }

    #[test]
    fn a_js_specifier_names_the_ts_file() {
        let a = "export class A { a = 1; }\n";
        let code = compile(&[("a.ts", a)], "@import { A } from \"./a.js\"\n@inherits A\n<p>@a</p>\n");
        assert!(code.contains("this.a"), "{code}");
        let code = compile(&[("lib/a.tsx", a)], "@import { A } from \"./lib/a.js\"\n@inherits A\n<p>@a</p>\n");
        assert!(code.contains("this.a"), "{code}");
    }

    #[test]
    fn xzor_base_contributes_its_code_members_and_chain() {
        let a = "export class A { a = 1; }\n";
        let base = "@import { A } from \"./a\"\n@inherits A\n@inject Db db\n@code { shared = 1; static s = 2; }\n<p/>\n";
        let code = compile(&[("a.ts", a), ("Base.xzor", base)], "@import Base from \"./Base.xzor\"\n@inherits Base\n<p>@shared @db @a @s</p>\n");
        for m in ["this.shared", "this.db", "this.a"] {
            assert!(code.contains(m), "{m} missing in\n{code}");
        }
        assert!(!code.contains("this.s)"), "{code}");
    }

    #[test]
    fn renamed_default_and_type_imports_resolve() {
        let code = compile(&[("base.ts", TITLED)], "@import { type After, Titled as T } from \"./base\"\n@inherits T<string>\n<p>@title</p>\n");
        assert!(code.contains("this.title"), "{code}");
        let code = compile(&[("base.ts", TITLED)], "@import type { Titled } from \"./base\"\n@inherits Titled\n<p>@title</p>\n");
        assert!(code.contains("this.title"), "{code}");
        let def = "export default abstract class extends Object { d = 1; }\n";
        let code = compile(&[("def/index.ts", def)], "@import D, { x } from \"./def\"\n@inherits D\n<p>@d</p>\n");
        assert!(code.contains("this.d"), "{code}");
        let named = "class N { n = 1; }\nexport default N;\n";
        let code = compile(&[("n.tsx", named)], "@import N from \"./n\"\n@inherits N\n<p>@n</p>\n");
        assert!(code.contains("this.n"), "{code}");
    }

    #[test]
    fn unresolvable_base_leaves_names_bare() {
        let code = compile(&[], "@import { Pkg } from \"some-pkg\"\n@inherits Pkg\n<p>@title</p>\n");
        assert!(code.contains("addContent(title)"), "{code}");
        let code = compile(&[], "@import { Gone } from \"./gone\"\n@inherits Gone\n<p>@title</p>\n");
        assert!(code.contains("addContent(title)"), "{code}");
    }

    #[test]
    fn locals_shadow_inherited_members() {
        let main = "@import { Titled } from \"./base\"\n@inherits Titled\n<p>@title</p>\n@for (const title of [\"a\"]) { <i>@title</i> }\n";
        let code = compile(&[("base.ts", TITLED)], main);
        assert!(code.contains("addContent(this.title)") && code.contains("addContent(title)"), "{code}");
    }

    #[test]
    fn cyclic_and_deep_chains_terminate() {
        let a = "import { B } from \"./b\";\nexport class A extends B { a = 1; }\n";
        let b = "import { A } from \"./a\";\nexport class B extends A { b = 1; }\nexport class S extends S { s = 1; }\n";
        let (code, reads) = compile_in(&[("a.ts", a), ("b.ts", b)], "@import { A } from \"./a\"\n@inherits A\n<p>@a @b</p>\n");
        assert!(code.contains("this.a") && code.contains("this.b"), "{code}");
        assert!(reads.values().all(|&n| n == 1), "{reads:?}");
        compile(&[("b.ts", b)], "@import { S } from \"./b\"\n@inherits S\n<p>@s</p>\n");
        // Ten levels, each in the same file: only the first 8 count.
        let deep: String = (0..10).map(|i| format!("class C{i} extends C{} {{ m{i} = 1; }}\n", i + 1)).collect();
        let code = compile(&[("d.ts", &deep)], "@import { C0 } from \"./d\"\n@inherits C0\n<p>@m0 @m7 @m8</p>\n");
        assert!(code.contains("this.m0") && code.contains("this.m7") && !code.contains("this.m8"), "{code}");
    }

    #[test]
    fn reads_declaration_files() {
        let d = "export declare class Titled extends ComponentBase { title: string; describe(): string; static make(): Titled; }\n";
        let code = compile(&[("base.d.ts", d)], "@import { Titled } from \"./base\"\n@inherits Titled\n<p>@title @describe() @make()</p>\n");
        assert!(code.contains("this.title") && code.contains("this.describe()"), "{code}");
        assert!(!code.contains("this.make"), "{code}");
    }

    #[test]
    fn follows_reexports() {
        let index = "export { Titled as Named } from \"./base\";\nexport * from \"./more\";\nexport { default as D } from \"./def\";\nimport { A } from \"./a\";\nexport { A };\n";
        let files = [
            ("base.ts", TITLED),
            ("more.ts", "export class Other { o = 1 }\n"),
            ("def.ts", "export default class { d = 1 }\n"),
            ("a.ts", "export class A { a = 1 }\n"),
            ("index.ts", index),
        ];
        for (name, member) in [("Named", "title"), ("Other", "o"), ("D", "d"), ("A", "a")] {
            let main = format!("@import {{ {name} }} from \"./index\"\n@inherits {name}\n<p>@{member}</p>\n");
            let code = compile(&files, &main);
            assert!(code.contains(&format!("this.{member}")), "{name}\n{code}");
        }
    }

    #[test]
    fn a_barrel_reexporting_a_component_is_read_as_a_component() {
        let files = [
            ("lib/Card.xzor", "@code { card = 1; }\n<p/>\n"),
            ("lib/index.ts", "export { default as Card } from \"./Card.xzor\";\n"),
        ];
        let main = "@import { Card } from \"./lib/index\"\n@inherits Card\n<p>@card</p>\n";
        let code = compile(&files, main);
        assert!(code.contains("this.card"), "{code}");
        assert_eq!(unresolved_in(&files, main), None);
    }

    #[test]
    fn star_export_cycles_terminate() {
        let files = [("a.ts", "export * from \"./b\";\n"), ("b.ts", "export * from \"./a\";\n")];
        let main = "@import { X } from \"./a\"\n@inherits X\n<p>@title</p>\n";
        assert!(compile(&files, main).contains("addContent(title)"));
        assert_eq!(unresolved_in(&files, main), Some("X".to_string()));
    }

    #[test]
    fn resolves_packages() {
        let files = [
            ("node_modules/ui/package.json", r#"{"exports":{".":{"import":{"types":"./dist/index.d.ts"}},"./forms":{"types":"./dist/forms.d.ts"}}}"#),
            ("node_modules/ui/dist/index.d.ts", "export declare class Panel { panel: number; }\n"),
            ("node_modules/ui/dist/forms.d.ts", "export declare class Form { form: number; }\n"),
            ("node_modules/@scope/kit/package.json", r#"{"types":"./k.d.ts"}"#),
            ("node_modules/@scope/kit/k.d.ts", "export declare class Kit { kit: number; }\n"),
            ("node_modules/@types/legacy/package.json", "{}"),
            ("node_modules/@types/legacy/index.d.ts", "export declare class Legacy { legacy: number; }\n"),
        ];
        for (name, spec, member) in [("Panel", "ui", "panel"), ("Form", "ui/forms", "form"), ("Kit", "@scope/kit", "kit"), ("Legacy", "legacy", "legacy")] {
            let main = format!("@import {{ {name} }} from \"{spec}\"\n@inherits {name}\n<p>@{member}</p>\n");
            let code = compile_at(&files, &main, "src/C.xzor");
            assert!(code.contains(&format!("this.{member}")), "{spec}\n{code}");
        }
    }

    #[test]
    fn a_bare_condition_map_is_the_root_export() {
        let files = [
            ("node_modules/sugar/package.json", r#"{"exports":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}"#),
            ("node_modules/sugar/dist/index.d.ts", "export declare class Sugar { sugar: number; }\n"),
            // Subpath keys make this a subpath map, not a condition map for ".".
            ("node_modules/subs/package.json", r#"{"exports":{"./forms":{"types":"./dist/forms.d.ts"}}}"#),
            ("node_modules/subs/dist/forms.d.ts", "export declare class Wrong { wrong: number; }\n"),
            ("node_modules/subs/index.d.ts", "export declare class Root { root: number; }\n"),
        ];
        for (name, spec, member) in [("Sugar", "sugar", "sugar"), ("Root", "subs", "root")] {
            let main = format!("@import {{ {name} }} from \"{spec}\"\n@inherits {name}\n<p>@{member}</p>\n");
            let code = compile_at(&files, &main, "src/C.xzor");
            assert!(code.contains(&format!("this.{member}")), "{spec}\n{code}");
        }
    }

    #[test]
    fn a_javascript_target_names_its_declaration_sibling() {
        let files = [
            ("node_modules/cjs/package.json", r#"{"exports":"./index.js"}"#),
            ("node_modules/cjs/index.d.ts", "export declare class Js { js: number; }\n"),
            ("node_modules/esm/package.json", r#"{"exports":"./index.mjs"}"#),
            ("node_modules/esm/index.d.mts", "export declare class Mjs { mjs: number; }\n"),
            ("node_modules/node/package.json", r#"{"exports":{"./sub":"./sub.cjs"}}"#),
            ("node_modules/node/sub.d.cts", "export declare class Cjs { cjs: number; }\n"),
            // The sibling declaration is missing, so the `index.d.ts` fallback still applies.
            ("node_modules/fall/package.json", r#"{"exports":"./lib/main.js"}"#),
            ("node_modules/fall/index.d.ts", "export declare class Fall { fall: number; }\n"),
        ];
        for (name, spec, member) in [("Js", "cjs", "js"), ("Mjs", "esm", "mjs"), ("Cjs", "node/sub", "cjs"), ("Fall", "fall", "fall")] {
            let main = format!("@import {{ {name} }} from \"{spec}\"\n@inherits {name}\n<p>@{member}</p>\n");
            let code = compile_at(&files, &main, "src/C.xzor");
            assert!(code.contains(&format!("this.{member}")), "{spec}\n{code}");
        }
    }

    #[test]
    fn exact_subpaths_win_over_patterns() {
        let files = [
            ("node_modules/pat/package.json", r#"{"exports":{"./forms":{"types":"./dist/real.d.ts"},"./*":{"types":"./dist/*.d.ts"}}}"#),
            ("node_modules/pat/dist/real.d.ts", "export declare class Form { form: number; }\n"),
            ("node_modules/pat/dist/forms.d.ts", "export declare class Form { wrong: number; }\n"),
            ("node_modules/pat/dist/grid.d.ts", "export declare class Grid { grid: number; }\n"),
        ];
        let main = "@import { Grid } from \"pat/grid\"\n@inherits Grid\n<p>@grid</p>\n";
        assert!(compile_at(&files, main, "src/C.xzor").contains("this.grid"));
        let main = "@import { Form } from \"pat/forms\"\n@inherits Form\n<p>@form @wrong</p>\n";
        let code = compile_at(&files, main, "src/C.xzor");
        assert!(code.contains("this.form") && !code.contains("this.wrong"), "{code}");
    }

    #[test]
    fn the_longest_pattern_prefix_wins() {
        let files = [
            ("node_modules/pat/package.json", r#"{"exports":{"./*":{"types":"./dist/*.d.ts"},"./ui/*":{"types":"./ui/*.d.ts"}}}"#),
            ("node_modules/pat/dist/ui/grid.d.ts", "export declare class Grid { wrong: number; }\n"),
            ("node_modules/pat/ui/grid.d.ts", "export declare class Grid { grid: number; }\n"),
        ];
        let main = "@import { Grid } from \"pat/ui/grid\"\n@inherits Grid\n<p>@grid @wrong</p>\n";
        let code = compile_at(&files, main, "src/C.xzor");
        assert!(code.contains("this.grid") && !code.contains("this.wrong"), "{code}");
    }

    #[test]
    fn a_package_directory_without_a_manifest_is_not_probed() {
        let root = Path::new("/p");
        let main = "@import { Pkg } from \"ui/forms\"\n@inherits Pkg\n<p/>\n";
        let g = crate::compile_mapped_with(main, &root.join("src/C.xzor"), &|_| None).unwrap();
        assert!(g.deps.iter().all(|d| d.file_name().is_some_and(|n| n == "package.json")), "{:?}", g.deps);
    }

    #[test]
    fn an_unterminated_string_literal_does_not_panic() {
        let star = [("q.ts", "export * from \"")];
        let main = "@import { X } from \"./q\"\n@inherits X\n<p>@title</p>\n";
        assert!(compile(&star, main).contains("addContent(title)"));
        let clause = [("q.ts", "export { A };\nimport { A } from \"")];
        let main = "@import { A } from \"./q\"\n@inherits A\n<p>@title</p>\n";
        assert!(compile(&clause, main).contains("addContent(title)"));
    }

    #[test]
    fn without_inherits_nothing_is_read() {
        let (_, reads) = compile_in(&[("base.ts", TITLED)], "<p>@title</p>\n");
        assert!(reads.is_empty(), "{reads:?}");
        let main = "@import { ComponentBase } from \"@xzor/runtime\"\n@inherits ComponentBase\n<p>@title</p>\n";
        let (_, reads) = compile_in(&[("base.ts", TITLED)], main);
        assert!(reads.is_empty(), "{reads:?}");
    }

    #[test]
    fn unresolved_reports_the_first_missing_class() {
        assert_eq!(unresolved_in(&[], "@import { Gone } from \"./gone\"\n@inherits Gone\n<p/>\n"), Some("Gone".to_string()));
        let m = "export class M extends mixin(A) { m = 1; }\n";
        assert_eq!(unresolved_in(&[("m.ts", m)], "@import { M } from \"./m\"\n@inherits M\n<p/>\n"), Some("mixin".to_string()));
        assert_eq!(unresolved_in(&[("base.ts", TITLED)], "@import { Titled } from \"./base\"\n@inherits Titled\n<p/>\n"), None);
        assert_eq!(unresolved_in(&[("a.ts", "export class A { a = 1 }\n")], "@import { A } from \"./a\"\n@inherits A\n<p/>\n"), None);
    }
}
