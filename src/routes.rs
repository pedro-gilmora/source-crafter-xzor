//! Route patterns (Bun.serve syntax) and the project-wide route table.

use crate::{is_ident_char, is_ident_start};
use std::cmp::Ordering;
use std::fmt::Write;
use std::path::{Component, Path, PathBuf};

/// One `@page` route of a component, with the offsets of its tag (if any) and pattern in the `.tszor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteInfo {
    pub tag: Option<String>,
    pub tag_at: usize,
    pub pattern: String,
    pub pattern_at: usize,
    pub params: Vec<(String, ParamKind)>,
    /// Whether the page declares a `rest` prop; a trailing `*` fills it only then.
    pub rest: bool,
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

pub fn is_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && is_ident_start(b[0]) && b[1..].iter().all(|&c| is_ident_char(c))
}

/// The `.zor/routes.ts` specifier a component imports, relative to its own directory
/// (`rootDirs` maps `<root>/routes` onto the generated table).
pub fn table_spec(root: &Path, source: &Path) -> String {
    let dir = source.parent().unwrap_or(Path::new("."));
    let spec = crate::build::relative_from(dir, &root.join("routes"), "routes");
    if spec.starts_with("..") { spec } else { format!("./{spec}") }
}

/// `__d`, the decode guard the generated matchers share: a malformed escape yields `null` instead
/// of throwing, and a segment without `%` skips the `try` entirely.
pub const DECODE: &str =
    "function __d(v: string): string | null {\n  if (!v.includes(\"%\")) return v;\n  try {\n    return decodeURIComponent(v);\n  } catch {\n    return null;\n  }\n}\n";

/// The matcher body of a `@"pattern"` routes section, generated like the table's. A section has no
/// props to read types from, so every param is a string and a trailing `*` always fills `rest`.
pub fn section_matcher(pattern: &str) -> String {
    let params = param_names(pattern).into_iter().map(|n| (n.to_string(), ParamKind::String)).collect();
    matcher_body(&RouteInfo { tag: None, tag_at: 0, pattern: pattern.to_string(), pattern_at: 0, params, rest: true })
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
            if shadowed[i] {
                continue;
            }
            let same = entries.iter().find(|&&(j, l)| shape_order(&units[j].routes[l].pattern, &r.pattern) == Ordering::Equal);
            match same {
                Some(&(j, _)) => {
                    let other = rel_display(root, units[j].source);
                    diags.push(diag(u, r.pattern_at, format!("duplicate route pattern {:?} (also in {other})", r.pattern)));
                }
                None => entries.push((i, k)),
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
    // Prefixed local names: a page class called `RouteTable`, `href` or `__P` would clash otherwise.
    let local = |i: usize| format!("__p{}", pages.iter().position(|&p| p == i).expect("page of an entry"));
    for &i in &pages {
        let _ = writeln!(out, "import {} from {:?};", local(i), import_spec(root, units[i].out));
    }
    out.push('\n');
    if entries.is_empty() {
        out.push_str("export const routes: RouteTable = [];\nexport const href = {};\n");
        out.push_str("export type RouteTag = never;\nexport type RouteParams = {};\n");
        return out;
    }
    out.push_str(&helpers(units, entries));
    out.push_str("export type __P<C, K extends string> = K extends keyof C ? C[K] : string;\n\nexport const routes: RouteTable = [\n");
    for &(i, k) in entries {
        let r = &units[i].routes[k];
        let tag = r.tag.as_ref().map_or_else(|| "undefined".to_string(), |t| format!("{t:?}"));
        let _ = writeln!(out, "  {{\n    tag: {tag},\n    pattern: {:?},", r.pattern);
        // A getter, so a page holding the routes block itself is not read while its module initializes.
        let _ = writeln!(out, "    get component() {{\n      return {};\n    }},", local(i));
        out.push_str("    match: (s) => {\n");
        out.push_str(&matcher_body(r));
        out.push_str("    },\n  },\n");
    }
    out.push_str("];\n\n");
    for &i in &pages {
        emit_href(&mut out, &units[i], entries, i, &local(i));
    }
    let names = pages.iter().map(|&i| format!("{0}: __href_{0}", units[i].class)).collect::<Vec<_>>().join(", ");
    let _ = writeln!(out, "export const href = {{ {names} }};\n");
    emit_tag_types(&mut out, units, entries, &local);
    out
}

/// `./<path under .zor>` for a generated component module, as the other generated modules write it.
fn import_spec(root: &Path, out: &Path) -> String {
    let module = out.to_string_lossy();
    let module = Path::new(module.strip_suffix(".ts").unwrap_or(&module));
    let spec = crate::build::relative_from(&root.join(".zor"), module, "");
    let spec = match spec.is_empty() {
        // Unrelated paths (no shared component at all): keep the output relative rather than absolute.
        true => module.components().filter_map(normal_part).collect::<Vec<_>>().join("/"),
        false => spec,
    };
    if spec.starts_with("..") { spec } else { format!("./{spec}") }
}

fn normal_part(c: Component) -> Option<String> {
    match c {
        Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// The param names a route fills: the pattern's params, minus a `rest` the page does not declare.
fn route_params(r: &RouteInfo) -> Vec<&str> {
    param_names(&r.pattern).into_iter().filter(|n| r.rest || *n != "rest").collect()
}

/// The conversion helpers the matchers need. `__d` turns a malformed escape into `null` instead of
/// throwing, and skips the `try` entirely for the common segment without a `%`.
fn helpers(units: &[Unit], entries: &[(usize, usize)]) -> String {
    let (mut decode, mut num, mut boolean) = (false, false, false);
    for &(i, k) in entries {
        let r = &units[i].routes[k];
        for name in route_params(r) {
            match r.params.iter().find(|(n, _)| n == name).map(|(_, kind)| kind) {
                Some(ParamKind::Number) => num = true,
                Some(ParamKind::Boolean) => boolean = true,
                _ => decode = true,
            }
        }
    }
    if !(decode || num || boolean) {
        return String::new();
    }
    let mut out = String::from(DECODE);
    if num {
        out.push_str("const __decimal = /^-?\\d+(?:\\.\\d+)?$/;\n");
        out.push_str("function __num(v: string): number {\n  const d = __d(v);\n  return d !== null && __decimal.test(d) ? Number(d) : NaN;\n}\n");
    }
    if boolean {
        out.push_str(
            "function __bool(v: string): boolean | null {\n  const d = __d(v);\n  return d === \"true\" ? true : d === \"false\" ? false : null;\n}\n",
        );
    }
    out.push('\n');
    out
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
            if r.rest {
                let _ = writeln!(
                    out,
                    "      const _rest = __d(s.slice({i}).join(\"/\"));\n      if (_rest === null) return null;"
                );
            }
        } else if let Some(name) = segment.strip_prefix(':') {
            let kind = r.params.iter().find(|(n, _)| n == name).map_or(&ParamKind::String, |(_, k)| k);
            // `!`: the length check above guarantees the index, and `noUncheckedIndexedAccess` does not know it.
            let _ = match kind {
                ParamKind::Number => {
                    writeln!(out, "      const _{name} = __num(s[{i}]!);\n      if (Number.isNaN(_{name})) return null;")
                }
                ParamKind::Boolean => {
                    writeln!(out, "      const _{name} = __bool(s[{i}]!);\n      if (_{name} === null) return null;")
                }
                ParamKind::Union(values) => {
                    let tests = values.iter().map(|v| format!("_{name} !== {v:?}")).collect::<Vec<_>>().join(" && ");
                    writeln!(out, "      const _{name} = __d(s[{i}]!);\n      if ({tests}) return null;")
                }
                ParamKind::String => {
                    writeln!(out, "      const _{name} = __d(s[{i}]!);\n      if (_{name} === null) return null;")
                }
            };
        } else {
            let _ = writeln!(out, "      if (s[{i}] !== {:?}) return null;", encode_literal(segment));
        }
    }
    let fields = route_params(r).iter().map(|n| format!("{n}: _{n}")).collect::<Vec<_>>().join(", ");
    let _ = match fields.is_empty() {
        true => writeln!(out, "      return {{}};"),
        false => writeln!(out, "      return {{ {fields} }};"),
    };
    out
}

/// A literal segment as a url path carries it: the bytes a `URL` escapes in `pathname` become `%XX`,
/// everything else is left alone. Both the matchers and `href` use this, so `/café` and `/a b` match
/// the `/caf%C3%A9` and `/a%20b` the browser reports, at no runtime cost.
fn encode_literal(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        match b {
            b' ' | b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}' | 0..=0x1F | 0x7F..=0xFF => {
                let _ = write!(out, "%{b:02X}");
            }
            _ => out.push(b as char),
        }
    }
    out
}

/// One overload per distinct parameter set of a page component, plus the implementation. `local` is
/// the name the table imports the page class under.
fn emit_href(out: &mut String, unit: &Unit, entries: &[(usize, usize)], index: usize, local: &str) {
    let class = unit.class;
    let mut sigs: Vec<(Vec<&str>, &RouteInfo)> = Vec::new();
    for (k, r) in unit.routes.iter().enumerate() {
        let names = route_params(r);
        if entries.contains(&(index, k)) && !sigs.iter().any(|(n, _)| *n == names) {
            sigs.push((names, r));
        }
    }
    for (names, _) in &sigs {
        let _ = writeln!(out, "function __href_{class}(p: {}): string;", params_type(local, names));
    }
    let _ = writeln!(out, "function __href_{class}(p: Record<string, unknown>): string {{");
    let _ = writeln!(out, "  let n = 0;\n  for (const k in p) if (p[k] !== undefined) n++;");
    for (names, r) in &sigs {
        let mut test = format!("n === {}", names.len());
        for name in names {
            let _ = write!(test, " && p[{name:?}] !== undefined");
        }
        let _ = writeln!(out, "  if ({test}) return {};", href_expr(r));
    }
    let _ = writeln!(out, "  throw new Error(\"no route of {class} matches these parameters\");\n}}\n");
}

/// `{ id: __P<__p0, "id"> }` for the parameters of one route.
fn params_type(local: &str, names: &[&str]) -> String {
    match names.is_empty() {
        true => "Record<string, never>".to_string(),
        false => format!("{{ {} }}", names.iter().map(|n| format!("{n}: __P<{local}, {n:?}>")).collect::<Vec<_>>().join("; ")),
    }
}

/// The url expression of a route: literal pieces plus the encoded parameters.
fn href_expr(r: &RouteInfo) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut literal = String::new();
    for segment in segments(&r.pattern) {
        literal.push('/');
        if segment == "*" {
            parts.push(format!("{literal:?}"));
            literal.clear();
            if r.rest {
                parts.push("String(p[\"rest\"]).split(\"/\").map(encodeURIComponent).join(\"/\")".into());
            }
        } else if let Some(name) = segment.strip_prefix(':') {
            parts.push(format!("{literal:?}"));
            literal.clear();
            parts.push(format!("encodeURIComponent(String(p[{name:?}]))"));
        } else {
            literal.push_str(&encode_literal(segment));
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

fn emit_tag_types(out: &mut String, units: &[Unit], entries: &[(usize, usize)], local: &dyn Fn(usize) -> String) {
    let mut tags: Vec<(&str, Vec<String>)> = Vec::new();
    for (i, unit) in units.iter().enumerate() {
        for (k, r) in unit.routes.iter().enumerate() {
            let Some(tag) = r.tag.as_deref().filter(|_| entries.contains(&(i, k))) else { continue };
            let params = params_type(&local(i), &route_params(r));
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

    #[test]
    fn table_specifier_is_relative_to_the_source_directory() {
        assert_eq!(table_spec(Path::new("/p"), Path::new("/p/src/app/App.tszor")), "../../routes");
        assert_eq!(table_spec(Path::new("/p"), Path::new("/p/App.tszor")), "./routes");
        assert_eq!(table_spec(Path::new("/p"), Path::new("/p/src/App.tszor")), "../routes");
        assert_eq!(table_spec(Path::new(""), Path::new("App.tszor")), "./routes");
    }

    #[test]
    fn section_matchers_bind_every_pattern_param_as_a_string() {
        let body = section_matcher("/legal/:doc");
        assert!(body.contains("if (s.length !== 2) return null;"), "{body}");
        assert!(body.contains("if (s[0] !== \"legal\") return null;"), "{body}");
        assert!(body.contains("const _doc = __d(s[1]!);"), "{body}");
        assert!(body.contains("return { doc: _doc };"), "{body}");
        assert!(section_matcher("/files/*").contains("return { rest: _rest };"), "{body}");
    }

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

    /// A route whose page declares exactly the props listed in `params`.
    fn route(tag: Option<&str>, pattern: &str, params: &[(&str, ParamKind)]) -> RouteInfo {
        RouteInfo {
            tag: tag.map(str::to_string),
            tag_at: 0,
            pattern: pattern.into(),
            pattern_at: 0,
            params: params.iter().map(|(n, k)| ((*n).to_string(), k.clone())).collect(),
            rest: params.iter().any(|(n, _)| *n == "rest"),
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
        assert!(ts.contains("import __p0 from \"./U.tszor\";"), "{ts}");
    }

    /// A page that holds the routes block imports the table that imports it back; a getter keeps the
    /// class out of the table's own initialization.
    #[test]
    fn entries_read_their_component_lazily() {
        let pages = [page("A.tszor", "A", vec![route(None, "/a", &[])])];
        let (ts, _) = generate(&pages);
        assert!(ts.contains("get component() {\n      return __p0;\n    },"), "{ts}");
    }

    #[test]
    fn pages_are_imported_relative_to_the_zor_directory() {
        let pages = [page("src/pages/Home.tszor", "Home", vec![route(None, "/", &[])])];
        let (ts, _) = generate(&pages);
        assert!(ts.contains("import __p0 from \"./src/pages/Home.tszor\";"), "{ts}");
    }

    #[test]
    fn imports_never_become_absolute() {
        let pages = [page_in(Path::new("/elsewhere"), "X.tszor", "X", vec![route(None, "/x", &[])])];
        let (ts, _) = table(Path::new("rel"), &units(&pages));
        assert!(ts.contains("import __p0 from \"./elsewhere/.zor/X.tszor\";"), "{ts}");
    }

    #[test]
    fn segments_are_decoded_through_the_guarded_helper() {
        let pages = [page(
            "A.tszor",
            "A",
            vec![route(None, "/a/:id/:slug/*", &[("id", ParamKind::Number), ("slug", ParamKind::String), ("rest", ParamKind::String)])],
        )];
        let (ts, _) = generate(&pages);
        assert!(!ts.contains("decodeURIComponent(s"), "{ts}");
        assert!(ts.contains("function __d("), "{ts}");
    }

    #[test]
    fn rest_fills_the_prop_only_when_the_page_declares_it() {
        let pages = [page("A.tszor", "A", vec![route(None, "/a/*", &[])])];
        let (ts, diags) = generate(&pages);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(!ts.contains("_rest"), "{ts}");
        assert!(ts.contains("function __href_A(p: Record<string, never>): string;"), "{ts}");
        assert!(ts.contains("return \"/a/\";"), "{ts}");
    }

    #[test]
    fn tables_without_parameters_declare_no_helpers() {
        let pages = [page("A.tszor", "A", vec![route(None, "/a/b", &[])])];
        let (ts, _) = generate(&pages);
        assert!(!ts.contains("function __d("), "{ts}");
    }

    /// `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` are on by default in a
    /// `bun init` tsconfig, and the table is code the user cannot edit.
    #[test]
    fn generated_code_survives_the_index_access_checks() {
        let pages = [page(
            "A.tszor",
            "A",
            vec![route(None, "/a/:id/*", &[("id", ParamKind::Number), ("rest", ParamKind::String)])],
        )];
        let (ts, _) = generate(&pages);
        assert!(ts.contains("const _id = __num(s[1]!);"), "{ts}");
        assert!(ts.contains("p[\"id\"] !== undefined"), "{ts}");
        assert!(ts.contains("encodeURIComponent(String(p[\"id\"]))"), "{ts}");
        assert!(ts.contains("String(p[\"rest\"]).split"), "{ts}");
        assert!(!ts.contains("p.id"), "{ts}");
        assert!(!ts.contains("p.rest"), "{ts}");
    }

    /// `location.pathname` is percent-encoded, so the literal a matcher compares has to be too.
    #[test]
    fn literal_segments_are_compared_and_built_encoded() {
        let pages = [page(
            "Cafe.tszor",
            "Cafe",
            vec![route(None, "/café/:q", &[("q", ParamKind::String)]), route(None, "/a b", &[])],
        )];
        let (ts, diags) = generate(&pages);
        assert!(diags.is_empty(), "{diags:?}");
        assert!(ts.contains("if (s[0] !== \"caf%C3%A9\") return null;"), "{ts}");
        assert!(ts.contains("if (s[0] !== \"a%20b\") return null;"), "{ts}");
        assert!(ts.contains("return \"/caf%C3%A9/\" + encodeURIComponent(String(p[\"q\"]));"), "{ts}");
        assert!(ts.contains("return \"/a%20b\";"), "{ts}");
        // `@`, `:` and the other sub-delimiters stay in a pathname, so they stay in the literal.
        assert!(section_matcher("/a@b,c").contains("if (s[0] !== \"a@b,c\") return null;"));
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
        assert_eq!(messages, ["duplicate page component \"A\" (also in a/A.tszor)"]);
        assert_eq!(diags[0].0, PathBuf::from("/proj").join("b/A.tszor"));
        assert_eq!((diags[0].1.line, diags[0].1.column), (2, 8));

        let mut c = page("a/A.tszor", "A", vec![route(None, "/x/:id", &[("id", ParamKind::String)])]);
        c.text = "@page \"/x/:id\"\n".into();
        c.routes[0].pattern_at = 7;
        let mut d = page("b/B.tszor", "B", vec![route(None, "/x/:other", &[("other", ParamKind::String)])]);
        d.text = "\n@page \"/x/:other\"\n".into();
        d.routes[0].pattern_at = 8;
        let (_, diags) = generate(&[c, d]);
        let messages: Vec<&str> = diags.iter().map(|(_, d)| d.message.as_str()).collect();
        assert_eq!(messages, ["duplicate route pattern \"/x/:other\" (also in a/A.tszor)"]);
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
            ts.contains("export type RouteParams = { admin: { id: __P<__p0, \"id\"> } | { slug: __P<__p1, \"slug\"> } };"),
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
                    route(None, "/s/:slug", &[("slug", ParamKind::String)]),
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
            page_in(&dir, "Root.tszor", "Root", vec![route(None, "/", &[]), route(None, "/*", &[])]),
            page_in(&dir, "Docs.tszor", "Docs", vec![route(None, "/docs/*", &[])]),
            page_in(
                &dir,
                "Cafe.tszor",
                "Cafe",
                vec![route(None, "/café/:q", &[("q", ParamKind::String)]), route(None, "/a b", &[])],
            ),
        ];
        let (ts, diags) = table(&dir, &units(&pages));
        assert!(diags.is_empty(), "{diags:?}");
        std::fs::create_dir_all(dir.join("pages")).unwrap();
        std::fs::write(dir.join("routes.ts"), &ts).unwrap();
        std::fs::write(dir.join("UserPage.tszor.ts"), "export default class UserPage {\n  id = 0;\n  rest = \"\";\n}\n").unwrap();
        std::fs::write(dir.join("P.tszor.ts"), "export default class P {\n  id = 0;\n  rest = \"\";\n  slug = \"\";\n}\n").unwrap();
        std::fs::write(
            dir.join("pages").join("Flags.tszor.ts"),
            "export default class Flags {\n  on = false;\n  tab: \"a\" | \"b\" = \"a\";\n}\n",
        )
        .unwrap();
        std::fs::write(dir.join("Root.tszor.ts"), "export default class Root {}\n").unwrap();
        std::fs::write(dir.join("Docs.tszor.ts"), "export default class Docs {}\n").unwrap();
        std::fs::write(dir.join("Cafe.tszor.ts"), "export default class Cafe {\n  q = \"\";\n}\n").unwrap();
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
