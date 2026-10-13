//! Instance members inherited through `@inherits`, read from the base classes' sources.

use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;

use crate::ast::Document;
use crate::codegen::{is_comment, member_decls, skip_braces, skip_literal, word_prev};
use crate::{is_ident_char, is_ident_start};

/// Bases followed from the component's own; deeper ones contribute nothing.
const MAX_DEPTH: usize = 8;

type Read<'r> = &'r dyn Fn(&Path) -> Option<String>;

/// Members of `doc`'s `@inherits` base chain, and every file probed on the way, found or not.
/// `read` returns a file's text (the LSP reads open documents first).
pub fn base_members(doc: &Document, path: &Path, read: Read) -> (HashSet<String>, Vec<PathBuf>) {
    let mut out = HashSet::new();
    let Some(inherits) = &doc.inherits else { return (out, Vec::new()) };
    let mut chain = Chain { read, files: Vec::new() };
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut next = chain.imported(dir, doc.imports.iter().filter_map(|i| split_import(i)), leading_ident(inherits));
    let mut seen: Vec<(PathBuf, String)> = Vec::new();
    while let Some((file, text, class)) = next.take() {
        if seen.len() == MAX_DEPTH || seen.iter().any(|(f, c)| *f == file && *c == class) {
            break;
        }
        next = chain.members(&file, &text, &class, &mut out);
        seen.push((file, class));
    }
    (out, chain.files.into_iter().map(|(p, _)| p).collect())
}

/// A file's text and, once a script needs them, its tokens.
struct Source {
    text: String,
    toks: OnceCell<Vec<Tok>>,
}

/// A file on the chain, its source and the class name in it (`default` for a default export).
type Link = (PathBuf, Rc<Source>, String);

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
        let src = (self.read)(path).map(|text| Rc::new(Source { text, toks: OnceCell::new() }));
        self.files.push((path.to_path_buf(), src.clone()));
        src
    }

    fn module(&mut self, dir: &Path, spec: &str) -> Option<(PathBuf, Rc<Source>)> {
        if !(spec.starts_with("./") || spec.starts_with("../")) {
            return None;
        }
        let base = normalize(&dir.join(spec));
        let candidates = if spec.ends_with(".tszor") {
            vec![base]
        } else {
            let mut c = Vec::new();
            // `./a.js` names `a.ts` (nodenext style).
            if let Some(stem) = spec.strip_suffix(".js") {
                let stem = normalize(&dir.join(stem));
                c.extend([with_suffix(&stem, ".ts"), with_suffix(&stem, ".tsx")]);
            }
            c.extend([base.clone(), with_suffix(&base, ".ts"), with_suffix(&base, ".tsx"), base.join("index.ts")]);
            c
        };
        candidates.into_iter().find_map(|p| self.load(&p).map(|t| (p, t)))
    }

    /// The class `name` imports, through `imports` (clause and specifier pairs) relative to `dir`.
    fn imported<'a, C: AsRef<str>>(&mut self, dir: &Path, imports: impl Iterator<Item = (C, &'a str)>, name: &str) -> Option<Link> {
        let (original, spec) = find_import(imports, name)?;
        let (file, text) = self.module(dir, spec)?;
        Some((file, text, original))
    }

    /// Adds the members of `class` in `file` to `out` and returns its base.
    fn members(&mut self, file: &Path, src: &Rc<Source>, class: &str, out: &mut HashSet<String>) -> Option<Link> {
        let dir = file.parent().unwrap_or(Path::new("."));
        let text = &src.text;
        if file.extension().is_some_and(|e| e == "tszor") {
            let (doc, _) = crate::parser::parse(text).ok()?;
            for code in &doc.code {
                class_members(code, out);
            }
            out.extend(doc.injects.iter().map(|i| i.name.text.clone()));
            let base = leading_ident(doc.inherits.as_ref()?);
            if base == "ComponentBase" {
                return None;
            }
            return self.imported(dir, doc.imports.iter().filter_map(|i| split_import(i)), base);
        }
        let toks = src.toks.get_or_init(|| tokens(text));
        let (base, body) = find_class(text, toks, (class != "default").then_some(class))?;
        class_members(&text[body], out);
        let base = base?;
        if base == "ComponentBase" {
            return None;
        }
        match find_import(ts_imports(text, toks).into_iter(), base) {
            Some((original, spec)) => self.module(dir, spec).map(|(file, src)| (file, src, original)),
            None => Some((file.to_path_buf(), src.clone(), base.to_string())),
        }
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
            prev = Some(word_prev(&ctor[start..i]));
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
            prev = Some(word_prev(&text[start..i]));
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
                if spec.kind == Kind::Str && at > 0 && s(&toks[from]) == "from" {
                    let clause: Vec<&str> = toks[i + 1..from].iter().map(s).collect();
                    out.push((clause.join(" "), &text[spec.start + 1..spec.end - 1]));
                }
            }
            _ => {}
        }
    }
    out
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
        let code = crate::compile_mapped_with(main, &root.join("C.tszor"), &read).unwrap().code;
        (code, reads.into_inner())
    }

    fn compile(files: &[(&str, &str)], main: &str) -> String {
        compile_in(files, main).0
    }

    const TITLED: &str = r#"import { ComponentBase } from "@zor/runtime";
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
        let a = "import { ComponentBase } from \"@zor/runtime\";\nexport class A extends ComponentBase { a = 1; }\n";
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
        let g = crate::compile_mapped_with(main, &root.join("C.tszor"), &|p| map.get(p).cloned()).unwrap();
        for f in ["a.ts", "b", "b.ts"] {
            assert!(g.deps.contains(&root.join(f)), "{f} missing in {:?}", g.deps);
        }
        let main = "@import { Gone } from \"./gone\"\n@inherits Gone\n<p/>\n";
        let g = crate::compile_mapped_with(main, &root.join("C.tszor"), &|_| None).unwrap();
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
    fn tszor_base_contributes_its_code_members_and_chain() {
        let a = "export class A { a = 1; }\n";
        let base = "@import { A } from \"./a\"\n@inherits A\n@inject Db db\n@code { shared = 1; static s = 2; }\n<p/>\n";
        let code = compile(&[("a.ts", a), ("Base.tszor", base)], "@import Base from \"./Base.tszor\"\n@inherits Base\n<p>@shared @db @a @s</p>\n");
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
}
