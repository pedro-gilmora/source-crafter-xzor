//! Route patterns (Bun.serve syntax) and the project-wide route table.

use crate::{is_ident_char, is_ident_start};
use std::cmp::Ordering;
use std::fmt::Write;
use std::path::{Path, PathBuf};

/// One `@page` route of a component, with the offsets of its tag (if any) and pattern in the `.tszor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteInfo {
    pub tag: Option<String>,
    pub tag_at: usize,
    pub pattern: String,
    pub pattern_at: usize,
    pub params: Vec<(String, ParamKind)>,
}

/// How a matched path segment is converted before it fills the page's prop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamKind {
    String,
    Number,
    Boolean,
    Union(Vec<String>),
}

/// Checks a route pattern: a leading `/`, then literal or `:param` segments and an optional final `*`.
/// The error is the reason, as used in `invalid route pattern "<p>": <reason>`.
pub fn validate_pattern(p: &str) -> Result<(), String> {
    let Some(rest) = p.strip_prefix('/') else {
        return Err("must start with '/'".into());
    };
    if rest.is_empty() {
        return Ok(());
    }
    let mut segments = rest.split('/').peekable();
    let mut seen: Vec<&str> = Vec::new();
    while let Some(segment) = segments.next() {
        if segment.is_empty() {
            return Err("empty segment".into());
        }
        let name = if segment == "*" {
            if segments.peek().is_some() {
                return Err("'*' must be the last segment".into());
            }
            "rest"
        } else if let Some(name) = segment.strip_prefix(':') {
            if !is_ident(name) {
                return Err(format!("invalid parameter name {name:?}"));
            }
            name
        } else if segment.contains([':', '*']) {
            return Err(format!("invalid segment {segment:?}"));
        } else {
            continue;
        };
        if seen.contains(&name) {
            return Err(format!("duplicate param {name:?}"));
        }
        seen.push(name);
    }
    Ok(())
}

/// Param names of a pattern in order; a trailing `*` contributes `rest`.
pub fn param_names(p: &str) -> Vec<&str> {
    p.split('/')
        .filter_map(|segment| match segment {
            "*" => Some("rest"),
            _ => segment.strip_prefix(':'),
        })
        .collect()
}

/// Conversion for a param, read from its prop declaration text (`id: number`, `tab = "a"`, …).
pub fn param_kind(decl: &str) -> ParamKind {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let rest = rest.trim_start_matches(['?', '!']).trim_start();
    if let Some(ty) = rest.strip_prefix(':') {
        let ty = &ty[..initializer_pos(ty).unwrap_or(ty.len())];
        return from_type(ty.trim());
    }
    match rest.strip_prefix('=') {
        Some(init) => from_initializer(init.trim()),
        None => ParamKind::String,
    }
}

fn from_type(ty: &str) -> ParamKind {
    match ty {
        "number" => ParamKind::Number,
        "boolean" => ParamKind::Boolean,
        _ => {
            // `null`/`undefined` only make the prop optional; they don't change the conversion.
            let parts: Vec<&str> =
                ty.split('|').map(str::trim).filter(|p| !matches!(*p, "" | "undefined" | "null")).collect();
            match parts.as_slice() {
                ["number"] => return ParamKind::Number,
                ["boolean"] => return ParamKind::Boolean,
                _ => {}
            }
            let literals: Option<Vec<String>> = parts.iter().map(|p| string_literal(p)).collect();
            match literals {
                Some(values) if !values.is_empty() => ParamKind::Union(values),
                _ => ParamKind::String,
            }
        }
    }
}

fn from_initializer(init: &str) -> ParamKind {
    match init {
        "true" | "false" => ParamKind::Boolean,
        _ if init.trim_end_matches(';').trim().parse::<f64>().is_ok() => ParamKind::Number,
        _ => ParamKind::String,
    }
}

/// The text of a `"…"` or `'…'` literal, if `s` is one (escapes are left as written).
fn string_literal(s: &str) -> Option<String> {
    let quote = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = s.strip_prefix(quote)?.strip_suffix(quote)?;
    (!inner.contains(quote)).then(|| inner.to_string())
}

/// Offset of the `=` that starts an initializer in a type annotation, skipping `=>`, `==`, `<=`, …
fn initializer_pos(ty: &str) -> Option<usize> {
    let b = ty.as_bytes();
    (0..b.len()).find(|&i| {
        b[i] == b'=' && b.get(i + 1) != Some(&b'>') && !matches!(i.checked_sub(1).map(|j| b[j]), Some(b'=' | b'!' | b'<' | b'>'))
    })
}

fn is_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && is_ident_start(b[0]) && b[1..].iter().all(|&c| is_ident_char(c))
}

/// Which router a `@ClientRoutes`/`@ServerRoutes` block selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Client,
    Server,
}

/// The routes block of a component, as the route table sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutesBlockInfo {
    pub engine: Engine,
    /// Offset of the block in the `.tszor`.
    pub at: usize,
    /// Tag sections: the tag and its offset in the `.tszor`.
    pub sections: Vec<(String, usize)>,
}

/// One compiled component as the project-wide route table sees it.
pub struct Unit<'a> {
    pub source: &'a Path,
    pub out: &'a Path,
    pub text: &'a str,
    pub class: &'a str,
    pub routes: &'a [RouteInfo],
    pub block: Option<&'a RoutesBlockInfo>,
}

/// The project's `.zor/routes.ts` and the project-wide route errors, keyed by `.tszor`.
pub fn table(root: &Path, units: &[Unit]) -> (String, Vec<(PathBuf, crate::Diagnostic)>) {
    let mut diags = Vec::new();
    let mut shadowed = vec![false; units.len()];
    let mut classes: Vec<usize> = Vec::new();
    for (i, u) in units.iter().enumerate() {
        if u.routes.is_empty() {
            continue;
        }
        match classes.iter().find(|&&j| units[j].class == u.class) {
            Some(&j) => {
                let other = rel_display(root, units[j].source);
                diags.push(diag(u, u.routes[0].pattern_at, format!("duplicate page component {:?} (also in {other})", u.class)));
                shadowed[i] = true;
            }
            None => classes.push(i),
        }
    }

    let mut entries: Vec<(usize, usize)> = Vec::new();
    for (i, u) in units.iter().enumerate() {
        for (k, r) in u.routes.iter().enumerate() {
            if let Some(tag) = r.tag.as_deref()
                && matches!(tag, "default" | "notFound" | "catch")
            {
                diags.push(diag(u, r.tag_at, format!("{tag:?} is reserved in routes")));
            }
            let same = entries.iter().find(|&&(j, l)| shape_order(&units[j].routes[l].pattern, &r.pattern) == Ordering::Equal);
            match same {
                Some(&(j, _)) => {
                    let other = rel_display(root, units[j].source);
                    diags.push(diag(u, r.pattern_at, format!("duplicate route pattern {:?} (also in {other})", r.pattern)));
                }
                None if !shadowed[i] => entries.push((i, k)),
                None => {}
            }
        }
    }

    let mut first_block: Option<usize> = None;
    for (i, u) in units.iter().enumerate() {
        let Some(block) = u.block else { continue };
        match first_block {
            Some(j) => {
                let other = rel_display(root, units[j].source);
                diags.push(diag(u, block.at, format!("only one routes block per project (also in {other})")));
            }
            None => first_block = Some(i),
        }
        for (tag, at) in &block.sections {
            if !units.iter().any(|v| v.routes.iter().any(|r| r.tag.as_deref() == Some(tag.as_str()))) {
                diags.push(diag(u, *at, format!("no route tagged {tag:?}")));
            }
        }
    }

    entries.sort_by(|&(ia, ka), &(ib, kb)| shape_order(&units[ia].routes[ka].pattern, &units[ib].routes[kb].pattern));
    (emit(root, units, &entries), diags)
}

fn diag(unit: &Unit, offset: usize, message: String) -> (PathBuf, crate::Diagnostic) {
    let (line, column) = crate::line_col(unit.text, offset);
    (unit.source.to_path_buf(), crate::Diagnostic { message, line, column, offset })
}

/// A source path as shown in route errors: relative to the project root, with forward slashes.
fn rel_display(root: &Path, source: &Path) -> String {
    source.strip_prefix(root).unwrap_or(source).to_string_lossy().replace('\\', "/")
}

/// Pattern segments, without the leading `/`.
fn segments(pattern: &str) -> impl Iterator<Item = &str> {
    pattern.strip_prefix('/').unwrap_or(pattern).split('/').filter(|s| !s.is_empty())
}

fn rank(segment: &str) -> u8 {
    match segment {
        "*" => 2,
        s if s.starts_with(':') => 1,
        _ => 0,
    }
}

/// Bun's precedence, segment by segment: literal before `:param` before `*`. `Equal` means the
/// two patterns have the same shape and so can never be told apart.
fn shape_order(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (segments(a), segments(b));
    loop {
        match (a.next(), b.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match rank(x).cmp(&rank(y)) {
                Ordering::Equal if rank(x) == 0 && x != y => return x.cmp(y),
                Ordering::Equal => {}
                other => return other,
            },
        }
    }
}

fn emit(root: &Path, units: &[Unit], entries: &[(usize, usize)]) -> String {
    let mut out = String::from("// Generated by zor. Do not edit.\nimport type { RouteTable } from \"@zor/runtime\";\n");
    let mut pages: Vec<usize> = Vec::new();
    for &(i, _) in entries {
        if !pages.contains(&i) {
            pages.push(i);
        }
    }
    pages.sort_unstable();
    for &i in &pages {
        let _ = writeln!(out, "import {} from {:?};", units[i].class, import_spec(root, units[i].out));
    }
    out.push('\n');
    if entries.is_empty() {
        out.push_str("export const routes: RouteTable = [];\nexport const href = {};\n");
        out.push_str("export type RouteTag = never;\nexport type RouteParams = {};\n");
        return out;
    }
    out.push_str("type __P<C, K extends string> = K extends keyof C ? C[K] : string;\n\nexport const routes: RouteTable = [\n");
    for &(i, k) in entries {
        let r = &units[i].routes[k];
        let tag = r.tag.as_ref().map_or_else(|| "undefined".to_string(), |t| format!("{t:?}"));
        let _ = writeln!(out, "  {{\n    tag: {tag},\n    pattern: {:?},\n    component: {},", r.pattern, units[i].class);
        out.push_str("    match: (s) => {\n");
        out.push_str(&matcher_body(r));
        out.push_str("    },\n  },\n");
    }
    out.push_str("];\n\n");
    for &i in &pages {
        emit_href(&mut out, &units[i], entries, i);
    }
    let names = pages.iter().map(|&i| format!("{0}: __href_{0}", units[i].class)).collect::<Vec<_>>().join(", ");
    let _ = writeln!(out, "export const href = {{ {names} }};\n");
    emit_tag_types(&mut out, units, entries);
    out
}

/// `./<path under .zor>` for a generated component module, as the other generated modules write it.
fn import_spec(root: &Path, out: &Path) -> String {
    let module = out.to_string_lossy();
    let module = module.strip_suffix(".ts").unwrap_or(&module);
    let spec = crate::build::relative_from(&root.join(".zor"), Path::new(module), module);
    if spec.starts_with("..") { spec } else { format!("./{spec}") }
}

/// The body of an entry's `match`: segment comparisons, conversions, then the props object.
fn matcher_body(r: &RouteInfo) -> String {
    let segments: Vec<&str> = segments(&r.pattern).collect();
    let star = segments.last() == Some(&"*");
    let fixed = segments.len() - usize::from(star);
    let mut out = String::new();
    let _ = match star {
        true => writeln!(out, "      if (s.length < {fixed}) return null;"),
        false => writeln!(out, "      if (s.length !== {fixed}) return null;"),
    };
    for (i, segment) in segments.iter().enumerate() {
        if *segment == "*" {
            let _ = writeln!(out, "      const _rest = decodeURIComponent(s.slice({i}).join(\"/\"));");
        } else if let Some(name) = segment.strip_prefix(':') {
            let kind = r.params.iter().find(|(n, _)| n == name).map_or(&ParamKind::String, |(_, k)| k);
            let _ = match kind {
                ParamKind::Number => writeln!(
                    out,
                    "      const _{name} = Number(decodeURIComponent(s[{i}]));\n      if (s[{i}] === \"\" || Number.isNaN(_{name})) return null;"
                ),
                ParamKind::Boolean => writeln!(
                    out,
                    "      if (s[{i}] !== \"true\" && s[{i}] !== \"false\") return null;\n      const _{name} = s[{i}] === \"true\";"
                ),
                ParamKind::Union(values) => {
                    let tests = values.iter().map(|v| format!("_{name} !== {v:?}")).collect::<Vec<_>>().join(" && ");
                    writeln!(out, "      const _{name} = decodeURIComponent(s[{i}]);\n      if ({tests}) return null;")
                }
                ParamKind::String => writeln!(out, "      const _{name} = decodeURIComponent(s[{i}]);"),
            };
        } else {
            let _ = writeln!(out, "      if (s[{i}] !== {segment:?}) return null;");
        }
    }
    let fields = param_names(&r.pattern).iter().map(|n| format!("{n}: _{n}")).collect::<Vec<_>>().join(", ");
    let _ = match fields.is_empty() {
        true => writeln!(out, "      return {{}};"),
        false => writeln!(out, "      return {{ {fields} }};"),
    };
    out
}

/// One overload per distinct parameter set of a page component, plus the implementation.
fn emit_href(out: &mut String, unit: &Unit, entries: &[(usize, usize)], index: usize) {
    let class = unit.class;
    let mut sigs: Vec<(Vec<&str>, &str)> = Vec::new();
    for (k, r) in unit.routes.iter().enumerate() {
        let names = param_names(&r.pattern);
        if entries.contains(&(index, k)) && !sigs.iter().any(|(n, _)| *n == names) {
            sigs.push((names, &r.pattern));
        }
    }
    for (names, _) in &sigs {
        let _ = writeln!(out, "function __href_{class}(p: {}): string;", params_type(class, names));
    }
    let _ = writeln!(out, "function __href_{class}(p: Record<string, unknown>): string {{");
    let _ = writeln!(out, "  const n = Object.keys(p).length;");
    for (names, pattern) in &sigs {
        let mut test = format!("n === {}", names.len());
        for name in names {
            let _ = write!(test, " && {name:?} in p");
        }
        let _ = writeln!(out, "  if ({test}) return {};", href_expr(pattern));
    }
    let _ = writeln!(out, "  throw new Error(\"no route of {class} matches these parameters\");\n}}\n");
}

/// `{ id: __P<UserPage, "id"> }` for the parameters of one route.
fn params_type(class: &str, names: &[&str]) -> String {
    match names.is_empty() {
        true => "Record<string, never>".to_string(),
        false => format!("{{ {} }}", names.iter().map(|n| format!("{n}: __P<{class}, {n:?}>")).collect::<Vec<_>>().join("; ")),
    }
}

/// The url expression of a route: literal pieces plus the encoded parameters.
fn href_expr(pattern: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut literal = String::new();
    for segment in segments(pattern) {
        literal.push('/');
        if segment == "*" {
            parts.push(format!("{literal:?}"));
            literal.clear();
            parts.push("String(p.rest).split(\"/\").map(encodeURIComponent).join(\"/\")".into());
        } else if let Some(name) = segment.strip_prefix(':') {
            parts.push(format!("{literal:?}"));
            literal.clear();
            parts.push(format!("encodeURIComponent(String(p.{name}))"));
        } else {
            literal.push_str(segment);
        }
    }
    if !literal.is_empty() {
        parts.push(format!("{literal:?}"));
    }
    match parts.is_empty() {
        true => "\"/\"".to_string(),
        false => parts.join(" + "),
    }
}

fn emit_tag_types(out: &mut String, units: &[Unit], entries: &[(usize, usize)]) {
    let mut tags: Vec<(&str, Vec<String>)> = Vec::new();
    for (i, unit) in units.iter().enumerate() {
        for (k, r) in unit.routes.iter().enumerate() {
            let Some(tag) = r.tag.as_deref().filter(|_| entries.contains(&(i, k))) else { continue };
            let params = params_type(unit.class, &param_names(&r.pattern));
            match tags.iter_mut().find(|(t, _)| *t == tag) {
                Some((_, variants)) if variants.contains(&params) => {}
                Some((_, variants)) => variants.push(params),
                None => tags.push((tag, vec![params])),
            }
        }
    }
    if tags.is_empty() {
        out.push_str("export type RouteTag = never;\nexport type RouteParams = {};\n");
        return;
    }
    let union = tags.iter().map(|(t, _)| format!("{t:?}")).collect::<Vec<_>>().join(" | ");
    let _ = writeln!(out, "export type RouteTag = {union};");
    let fields = tags.iter().map(|(t, v)| format!("{t}: {}", v.join(" | "))).collect::<Vec<_>>().join("; ");
    let _ = writeln!(out, "export type RouteParams = {{ {fields} }};");
}

#[cfg(test)]
mod table_tests {
    use super::*;
    use std::path::PathBuf;

    const ROOT: &str = "/proj";

    struct Page {
        source: PathBuf,
        out: PathBuf,
        text: String,
        class: String,
        routes: Vec<RouteInfo>,
        block: Option<RoutesBlockInfo>,
    }

    fn page_in(root: &Path, rel: &str, class: &str, routes: Vec<RouteInfo>) -> Page {
        let mut out = root.join(".zor").join(rel).into_os_string();
        out.push(".ts");
        Page { source: root.join(rel), out: out.into(), text: String::new(), class: class.into(), routes, block: None }
    }

    fn page(rel: &str, class: &str, routes: Vec<RouteInfo>) -> Page {
        page_in(Path::new(ROOT), rel, class, routes)
    }

    fn route(tag: Option<&str>, pattern: &str, params: &[(&str, ParamKind)]) -> RouteInfo {
        RouteInfo {
            tag: tag.map(str::to_string),
            tag_at: 0,
            pattern: pattern.into(),
            pattern_at: 0,
            params: params.iter().map(|(n, k)| ((*n).to_string(), k.clone())).collect(),
        }
    }

    fn units(pages: &[Page]) -> Vec<Unit<'_>> {
        pages
            .iter()
            .map(|p| Unit {
                source: &p.source,
                out: &p.out,
                text: &p.text,
                class: &p.class,
                routes: &p.routes,
                block: p.block.as_ref(),
            })
            .collect()
    }

    fn generate(pages: &[Page]) -> (String, Vec<(PathBuf, crate::Diagnostic)>) {
        table(Path::new(ROOT), &units(pages))
    }

    #[test]
    fn table_sorts_by_precedence() {
        let pages = [page(
            "U.tszor",
            "U",
            vec![
                route(None, "/users/*", &[("rest", ParamKind::String)]),
                route(None, "/users/:id", &[("id", ParamKind::Number)]),
                route(None, "/users/new", &[]),
            ],
        )];
        let (ts, diags) = generate(&pages);
        assert!(diags.is_empty(), "{diags:?}");
        let at = |p: &str| ts.find(&format!("pattern: {p:?}")).unwrap_or_else(|| panic!("missing {p} in\n{ts}"));
        assert!(at("/users/new") < at("/users/:id"), "{ts}");
        assert!(at("/users/:id") < at("/users/*"), "{ts}");
        assert!(ts.contains("import U from \"./U.tszor\";"), "{ts}");
    }

    #[test]
    fn pages_are_imported_relative_to_the_zor_directory() {
        let pages = [page("src/pages/Home.tszor", "Home", vec![route(None, "/", &[])])];
        let (ts, _) = generate(&pages);
        assert!(ts.contains("import Home from \"./src/pages/Home.tszor\";"), "{ts}");
    }

    #[test]
    fn an_empty_project_gets_an_empty_table() {
        let (ts, diags) = generate(&[page("A.tszor", "A", Vec::new())]);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(ts.contains("export const routes: RouteTable = [];"), "{ts}");
        assert!(ts.contains("export const href = {};"), "{ts}");
        assert!(ts.contains("export type RouteTag = never;"), "{ts}");
        assert!(ts.contains("export type RouteParams = {};"), "{ts}");
    }

    #[test]
    fn duplicate_patterns_and_components_are_reported() {
        let mut a = page("a/A.tszor", "A", vec![route(None, "/x/:id", &[("id", ParamKind::String)])]);
        a.text = "@page \"/x/:id\"\n".into();
        a.routes[0].pattern_at = 7;
        let mut b = page("b/A.tszor", "A", vec![route(None, "/x/:other", &[("other", ParamKind::String)])]);
        b.text = "\n@page \"/x/:other\"\n".into();
        b.routes[0].pattern_at = 8;
        let (_, diags) = generate(&[a, b]);
        let messages: Vec<&str> = diags.iter().map(|(_, d)| d.message.as_str()).collect();
        assert_eq!(
            messages,
            [
                "duplicate page component \"A\" (also in a/A.tszor)",
                "duplicate route pattern \"/x/:other\" (also in a/A.tszor)",
            ]
        );
        assert_eq!(diags[1].0, PathBuf::from("/proj").join("b/A.tszor"));
        assert_eq!((diags[1].1.line, diags[1].1.column), (2, 8));
    }

    #[test]
    fn shared_tags_are_allowed() {
        let pages = [
            page("A.tszor", "A", vec![route(Some("admin"), "/a/:id", &[("id", ParamKind::Number)])]),
            page("B.tszor", "B", vec![route(Some("admin"), "/b/:slug", &[("slug", ParamKind::String)])]),
        ];
        let (ts, diags) = generate(&pages);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(ts.contains("export type RouteTag = \"admin\";"), "{ts}");
        assert!(
            ts.contains("export type RouteParams = { admin: { id: __P<A, \"id\"> } | { slug: __P<B, \"slug\"> } };"),
            "{ts}"
        );
    }

    #[test]
    fn reserved_tags() {
        for name in ["default", "notFound", "catch"] {
            let mut p = page("A.tszor", "A", vec![route(Some(name), "/a", &[])]);
            p.text = format!("@page \"/a\" as {name}\n");
            p.routes[0].tag_at = 14;
            let (_, diags) = generate(&[p]);
            assert_eq!(diags.len(), 1, "{diags:?}");
            assert_eq!(diags[0].1.message, format!("{name:?} is reserved in routes"));
            assert_eq!((diags[0].1.line, diags[0].1.column), (1, 15));
        }
    }

    #[test]
    fn unknown_section_tags() {
        let mut p = page("A.tszor", "A", vec![route(Some("admin"), "/a", &[])]);
        p.text = "\n\n@x(page) {\n".into();
        p.block = Some(RoutesBlockInfo {
            engine: Engine::Client,
            at: 2,
            sections: vec![("admin".into(), 3), ("x".into(), 3)],
        });
        let (_, diags) = generate(&[p]);
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert_eq!(diags[0].1.message, "no route tagged \"x\"");
        assert_eq!((diags[0].1.line, diags[0].1.column), (3, 2));
    }

    #[test]
    fn one_routes_block_per_project() {
        let mut a = page("A.tszor", "A", Vec::new());
        a.block = Some(RoutesBlockInfo { engine: Engine::Client, at: 0, sections: Vec::new() });
        let mut b = page("sub/B.tszor", "B", Vec::new());
        b.text = "@ClientRoutes(route) {\n".into();
        b.block = Some(RoutesBlockInfo { engine: Engine::Server, at: 0, sections: Vec::new() });
        let (_, diags) = generate(&[a, b]);
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert_eq!(diags[0].1.message, "only one routes block per project (also in A.tszor)");
        assert_eq!(diags[0].0, PathBuf::from("/proj").join("sub/B.tszor"));
    }

    /// Writes `target/tmp-routes/` for `tests/routes-table.test.ts`, which runs the matchers.
    #[test]
    fn writes_table_fixture() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("tmp-routes");
        let pages = [
            page_in(
                &dir,
                "UserPage.tszor",
                "UserPage",
                vec![
                    route(None, "/users/*", &[("rest", ParamKind::String)]),
                    route(Some("admin"), "/users/:id", &[("id", ParamKind::Number)]),
                    route(None, "/users/new", &[]),
                ],
            ),
            page_in(
                &dir,
                "P.tszor",
                "P",
                vec![
                    route(None, "/p/:id", &[("id", ParamKind::Number)]),
                    route(None, "/p/:id/*", &[("id", ParamKind::Number), ("rest", ParamKind::String)]),
                ],
            ),
            page_in(
                &dir,
                "pages/Flags.tszor",
                "Flags",
                vec![route(
                    None,
                    "/f/:on/:tab",
                    &[("on", ParamKind::Boolean), ("tab", ParamKind::Union(vec!["a".into(), "b".into()]))],
                )],
            ),
        ];
        let (ts, diags) = table(&dir, &units(&pages));
        assert!(diags.is_empty(), "{diags:?}");
        std::fs::create_dir_all(dir.join("pages")).unwrap();
        std::fs::write(dir.join("routes.ts"), &ts).unwrap();
        std::fs::write(dir.join("UserPage.tszor.ts"), "export default class UserPage {\n  id = 0;\n  rest = \"\";\n}\n").unwrap();
        std::fs::write(dir.join("P.tszor.ts"), "export default class P {\n  id = 0;\n  rest = \"\";\n}\n").unwrap();
        std::fs::write(
            dir.join("pages").join("Flags.tszor.ts"),
            "export default class Flags {\n  on = false;\n  tab: \"a\" | \"b\" = \"a\";\n}\n",
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_patterns() {
        assert_eq!(validate_pattern("/"), Ok(()));
        assert_eq!(validate_pattern("/users/:id"), Ok(()));
        assert_eq!(validate_pattern("/a/*"), Ok(()));
        assert_eq!(validate_pattern("users"), Err("must start with '/'".into()));
        assert_eq!(validate_pattern("/a/*/b"), Err("'*' must be the last segment".into()));
        assert_eq!(validate_pattern("/:1x"), Err("invalid parameter name \"1x\"".into()));
        assert_eq!(validate_pattern("/a//b"), Err("empty segment".into()));
        assert_eq!(validate_pattern("/a*"), Err("invalid segment \"a*\"".into()));
        assert_eq!(validate_pattern("/:a/:a"), Err("duplicate param \"a\"".into()));
        assert_eq!(validate_pattern("/:rest/*"), Err("duplicate param \"rest\"".into()));
    }

    #[test]
    fn reads_nullable_and_multiline_types() {
        let u = || ParamKind::Union(vec!["a".into(), "b".into()]);
        assert_eq!(param_kind("id: number | undefined"), ParamKind::Number);
        assert_eq!(param_kind("id: null | number"), ParamKind::Number);
        assert_eq!(param_kind("id?: number"), ParamKind::Number);
        assert_eq!(param_kind("on: boolean | null"), ParamKind::Boolean);
        assert_eq!(param_kind("tab: | \"a\" | \"b\""), u());
        assert_eq!(param_kind("tab:\n | \"a\"\n | \"b\""), u());
        assert_eq!(param_kind("id: number | string"), ParamKind::String);
    }

    #[test]
    fn lists_param_names_with_rest_for_the_star() {
        assert_eq!(param_names("/users/:id/t/:tab/*"), ["id", "tab", "rest"]);
        assert!(param_names("/a/b").is_empty());
    }

    #[test]
    fn reads_param_kinds_from_declarations() {
        assert_eq!(param_kind("id = 0"), ParamKind::Number);
        assert_eq!(param_kind("id: number"), ParamKind::Number);
        assert_eq!(param_kind("on: boolean = false"), ParamKind::Boolean);
        assert_eq!(param_kind("on = true"), ParamKind::Boolean);
        assert_eq!(param_kind("tab: \"a\" | \"b\" = \"a\""), ParamKind::Union(vec!["a".into(), "b".into()]));
        assert_eq!(param_kind("slug = \"\""), ParamKind::String);
        assert_eq!(param_kind("slug?: string"), ParamKind::String);
        assert_eq!(param_kind("id!: Id"), ParamKind::String);
    }
}
