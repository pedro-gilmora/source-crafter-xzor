//! Lowers a parsed `.xzor` document into a TypeScript component class, the
//! way Razor lowers `.razor` into a C# class with `BuildRenderTree`.

use crate::ast::*;
use crate::routes::{ParamKind, RouteInfo};
use crate::{is_ident_char, is_ident_start};
use std::collections::{HashMap, HashSet};

/// `code[out..out + len]` is a verbatim copy of `source[src..src + len]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mapping {
    pub src: usize,
    pub out: usize,
    pub len: usize,
}

#[derive(Debug, Clone)]
pub struct Generated {
    pub code: String,
    pub mappings: Vec<Mapping>,
    /// `@inject` types and names, with their offsets in the `.xzor`.
    pub injects: Vec<Inject>,
    /// `@page` routes, with their params typed from the props.
    pub routes: Vec<RouteInfo>,
    /// The `@ClientRoutes`/`@ServerRoutes` block, if any.
    pub routes_block: Option<crate::routes::RoutesBlockInfo>,
    /// Files probed while resolving the `@inherits` chain, found or not; a change to one invalidates this output.
    pub deps: Vec<std::path::PathBuf>,
    /// Problems that don't stop the build.
    pub warnings: Vec<crate::Diagnostic>,
    /// The lowered `<style>` (or `X.css.xzor`), written beside the code as `X.xzor.css` and imported by it.
    pub css: Option<String>,
}

impl Generated {
    /// Source offset for an offset in the generated code, if it was copied from the source.
    pub fn to_src(&self, out: usize) -> Option<usize> {
        self.mappings.iter().find(|m| m.out <= out && out <= m.out + m.len).map(|m| m.src + out - m.out)
    }

    /// Generated offset for a source offset, if that source text was copied.
    pub fn to_out(&self, src: usize) -> Option<usize> {
        self.mappings.iter().find(|m| m.src <= src && src <= m.src + m.len).map(|m| m.out + src - m.src)
    }

    /// Like [`Self::to_src`], falling back to the end of the closest preceding mapping
    /// (for errors reported on generated scaffolding).
    pub fn to_src_nearest(&self, out: usize) -> usize {
        self.to_src(out).unwrap_or_else(|| {
            self.mappings.iter().filter(|m| m.out <= out).max_by_key(|m| m.out).map_or(0, |m| m.src + m.len)
        })
    }

    /// A source map (v3) from the generated code back to `source` (named `source_name`).
    pub fn source_map(&self, source: &str, source_name: &str) -> String {
        let gen_lines = LineIndex::new(&self.code);
        let src_lines = LineIndex::new(source);
        let mut lines: Vec<Vec<(usize, Option<(usize, usize)>)>> = vec![Vec::new(); gen_lines.starts.len()];
        let mut sorted = self.mappings.clone();
        sorted.sort_by_key(|m| m.out);
        for m in &sorted {
            // A mapping may span lines; each generated line gets its own segment.
            let mut offset = 0;
            for piece in self.code[m.out..m.out + m.len].split_inclusive('\n') {
                let (gl, gc) = gen_lines.position(&self.code, m.out + offset);
                let (sl, sc) = src_lines.position(source, m.src + offset);
                lines[gl].push((gc, Some((sl, sc))));
                let end = m.out + offset + piece.trim_end_matches('\n').len();
                let (el, ec) = gen_lines.position(&self.code, end);
                lines[el].push((ec, None));
                offset += piece.len();
            }
        }
        let mut mappings = String::new();
        let (mut prev_src_line, mut prev_src_col) = (0i64, 0i64);
        for (i, segments) in lines.iter_mut().enumerate() {
            if i > 0 {
                mappings.push(';');
            }
            segments.sort_by_key(|s| (s.0, s.1.is_some()));
            let mut prev_col = 0i64;
            for (j, (col, src)) in segments.iter().enumerate() {
                if j > 0 {
                    mappings.push(',');
                }
                vlq(&mut mappings, *col as i64 - prev_col);
                prev_col = *col as i64;
                if let Some((sl, sc)) = src {
                    vlq(&mut mappings, 0);
                    vlq(&mut mappings, *sl as i64 - prev_src_line);
                    vlq(&mut mappings, *sc as i64 - prev_src_col);
                    (prev_src_line, prev_src_col) = (*sl as i64, *sc as i64);
                }
            }
        }
        crate::json::Json::obj([
            ("version", 3usize.into()),
            ("sources", vec![crate::json::Json::from(source_name)].into()),
            ("sourcesContent", vec![crate::json::Json::from(source)].into()),
            ("names", crate::json::Json::Arr(vec![])),
            ("mappings", mappings.into()),
        ])
        .to_string()
    }
}

/// Byte offsets of line starts, for (line, UTF-16 column) lookups.
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        LineIndex { starts }
    }

    fn position(&self, text: &str, offset: usize) -> (usize, usize) {
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        (line, text[self.starts[line]..offset].encode_utf16().count())
    }
}

const BASE64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn vlq(out: &mut String, value: i64) {
    let mut v = if value < 0 { ((-value) << 1) | 1 } else { value << 1 };
    loop {
        let mut digit = (v & 31) as usize;
        v >>= 5;
        if v > 0 {
            digit |= 32;
        }
        out.push(BASE64[digit] as char);
        if v == 0 {
            break;
        }
    }
}

/// Decodes source map `mappings` into (generated line, column, source (line, column)).
#[cfg(test)]
fn decode_mappings(mappings: &str) -> Vec<(usize, usize, Option<(usize, usize)>)> {
    let mut out = Vec::new();
    let (mut src_line, mut src_col) = (0i64, 0i64);
    for (line, text) in mappings.split(';').enumerate() {
        let mut col = 0i64;
        for seg in text.split(',').filter(|s| !s.is_empty()) {
            let mut values = Vec::new();
            let (mut value, mut shift) = (0i64, 0);
            for b in seg.bytes() {
                let digit = BASE64.iter().position(|&c| c == b).unwrap() as i64;
                value |= (digit & 31) << shift;
                shift += 5;
                if digit & 32 == 0 {
                    values.push(if value & 1 == 1 { -(value >> 1) } else { value >> 1 });
                    (value, shift) = (0, 0);
                }
            }
            col += values[0];
            let src = (values.len() >= 4).then(|| {
                src_line += values[2];
                src_col += values[3];
                (src_line as usize, src_col as usize)
            });
            out.push((line, col as usize, src));
        }
    }
    out
}

/// Generated text with mappings relative to its own start.
#[derive(Default)]
struct M {
    text: String,
    maps: Vec<Mapping>,
}

impl M {
    fn lit(s: &str) -> M {
        M { text: s.into(), maps: Vec::new() }
    }

    fn src(text: &str, at: usize) -> M {
        let maps = if text.is_empty() || at == Src::UNMAPPED { Vec::new() } else { vec![Mapping { src: at, out: 0, len: text.len() }] };
        M { text: text.into(), maps }
    }

    fn add(mut self, other: M) -> M {
        let base = self.text.len();
        self.maps.extend(other.maps.into_iter().map(|m| Mapping { out: m.out + base, ..m }));
        self.text.push_str(&other.text);
        self
    }

    fn lit_then(self, s: &str) -> M {
        self.add(M::lit(s))
    }
}

pub const ZDI08: &str = "ZDI08: a component with @inject cannot declare a constructor";

const CASCADE_FIELD_ONLY: &str = "@Cascade applies to instance fields only";
const CASCADE_ONE_NAME: &str = "@Cascade takes one string literal name";
/// Type of `static cascades`, written out so a derived class can widen the base's list.
const CASCADE_LIST: &str = "readonly (readonly [string, string])[]";

/// The source offset of a user `constructor` in a component that also uses `@inject` (ZDI08).
pub fn inject_constructor(doc: &Document) -> Option<usize> {
    if doc.injects.is_empty() {
        return None;
    }
    doc.code.iter().find_map(|c| member_decls(c).into_iter().find(|d| d.is_method && d.name == "constructor").map(|d| c.at + d.offset))
}

pub fn generate(doc: &Document, class_name: &str, source_name: &str) -> Result<Generated, String> {
    generate_with(doc, class_name, source_name, &HashMap::new(), &HashSet::new(), "./routes")
}

/// How a component prop takes its attribute value, from its declared type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropKind {
    /// String-like: attribute text is a string.
    Text,
    /// Other types: attribute text is a TypeScript expression (Blazor's rule).
    Expr,
    /// `EventCallback<T>`: the handler re-renders the component that passed it.
    Callback,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ComponentInfo {
    /// `@typeparam` names, in order.
    pub type_params: Vec<String>,
    pub props: HashMap<String, PropKind>,
    /// Expression props typed as a union of type names (and string literals): the names to look up,
    /// since a name that is an alias of string literals makes the prop text.
    pub named_types: HashMap<String, Vec<String>>,
    /// `@async`: used through a loader, so it loads on first use.
    pub lazy: bool,
}

/// `components` describes the `.xzor` components this document uses, by name; `inherited` names
/// the base class's instance members; `table` is the specifier a routes block imports `.xzor/routes.ts` by.
pub fn generate_with(
    doc: &Document,
    class_name: &str,
    source_name: &str,
    components: &HashMap<String, ComponentInfo>,
    inherited: &HashSet<String>,
    table: &str,
) -> Result<Generated, String> {
    let decls: Vec<Vec<MemberDecl>> = doc.code.iter().map(|c| member_decls(c)).collect();
    let mut members: HashSet<String> =
        doc.injects.iter().map(|i| i.name.text.clone()).chain(inherited.iter().cloned()).collect();
    let mut statics: HashSet<String> = HashSet::new();
    if inject_constructor(doc).is_some() {
        return Err(ZDI08.into());
    }
    let mut cascades: Vec<(String, String)> = Vec::new();
    let mut blanks: Vec<(usize, usize)> = Vec::new();
    let mut list_keys = HashMap::new();
    // A fine component's own instance getters, cached unless `@Volatile`.
    let mut memos: Vec<String> = Vec::new();
    for (code, decls) in doc.code.iter().zip(&decls) {
        cascade_members(code, decls, &mut cascades, &mut blanks).map_err(|(message, _)| message)?;
        for m in decls {
            let mut volatile = false;
            for &(s, e) in &m.decorators {
                if let Some(member) = key_member(&code[s..e]) {
                    list_keys.insert(m.name.clone(), member);
                    blanks.push((code.at + s, code.at + e));
                } else if code[s..e].trim_end() == "@Volatile" {
                    volatile = true;
                    blanks.push((code.at + s, code.at + e));
                }
            }
            let before = code[..m.offset].trim_end();
            let getter = before.ends_with("get") && !before[..before.len() - 3].ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$');
            if doc.fine && getter && !volatile && !m.is_static && !m.name.starts_with('#') && !memos.contains(&m.name) {
                memos.push(m.name.clone());
            }
            if m.is_static {
                statics.insert(m.name.clone());
            }
            members.insert(m.name.clone());
        }
    }
    let mut g = Gen {
        out: String::new(),
        mappings: Vec::new(),
        members,
        statics,
        static_prefix: format!("{class_name}."),
        locals: Vec::new(),
        depth: 0,
        components,
        inline: false,
        raw_text: false,
        props_ids: std::cell::Cell::new(0),
        route_types: std::cell::Cell::new(0),
        fine_ids: 0,
        in_region: false,
        in_loop: false,
        owner: None,
        list_keys,
        pass_locals: None,
        once: false,
        branching: false,
        in_show: 0,
        templates: Vec::new(),
        reads: None,
        uses_el: false,
    };

    g.line(&format!("// Generated by xzor from {source_name}. Do not edit."));
    let slots = slot_declarations(doc, &g.members, &g.statics, class_name)?;
    let block = find_routes(&doc.nodes);
    // The runtime and table imports are inserted at the end, once the sections say which types they use.
    let head_at = g.out.len();
    let mut uses_lazy = false;
    for import in &doc.imports {
        // An `@async` component's class is a type here; the tree gets a loader, so its module ships on first use.
        let name = import.split_whitespace().next().unwrap_or_default();
        let spec = import.rsplit(['"', '\'']).nth(1).filter(|s| s.ends_with(".xzor"));
        if let Some(spec) = spec.filter(|_| components.get(name).is_some_and(|c| c.lazy)) {
            uses_lazy = true;
            g.emit(M::lit("import type ").add(M::src(import, import.at)).lit_then(";"));
            g.line(&format!("const __lazy_{name} = lazy<typeof {name}>(() => import({}));", js_string(spec)));
            continue;
        }
        g.emit(M::lit("import ").add(M::src(import, import.at)).lit_then(";"));
    }
    g.line("");
    if block.is_some_and(decodes_segments) {
        for line in crate::routes::DECODE.lines() {
            g.line(line);
        }
        g.line("");
    }
    if let Some(parts) = &doc.module {
        let block = g.code_block(parts, &[])?;
        g.emit_block(block);
        g.line("");
    }
    let generics = if doc.type_params.is_empty() {
        M::default()
    } else {
        let mut m = M::lit("<");
        for (i, tp) in doc.type_params.iter().enumerate() {
            m = m.lit_then(if i == 0 { "" } else { ", " }).add(M::src(tp, tp.at));
        }
        m.lit_then(">")
    };
    for decorator in &doc.attributes {
        g.emit(M::lit("@").add(M::src(decorator, decorator.at)));
    }
    let base = match &doc.inherits {
        Some(b) => M::src(b, b.at),
        None if doc.fine => M::lit("FineComponent"),
        None => M::lit("ComponentBase"),
    };
    let mut header = M::lit(&format!("export default class {class_name}")).add(generics).lit_then(" extends ").add(base);
    for (i, interface) in doc.implements.iter().enumerate() {
        header = header.lit_then(if i == 0 { " implements " } else { ", " }).add(M::src(interface, interface.at));
    }
    g.emit(header.lit_then(" {"));
    g.depth = 1;
    if let Some(page) = doc.pages.first() {
        g.line(&format!("static readonly route = {};", js_string(&page.pattern)));
    }
    if doc.cached {
        g.line("static readonly cached = true;");
    }
    if !memos.is_empty() {
        let names: Vec<String> = memos.iter().map(|n| js_string(n)).collect();
        g.line(&format!("static {{ fine.memo(this, [{}]); }}", names.join(", ")));
    }
    if let Some(Node::Routes { sections, .. }) = block {
        for (i, section) in sections.iter().enumerate() {
            match &section.kind {
                RouteSectionKind::Regex { re, .. } => {
                    g.emit(M::lit(&format!("static readonly __re{i} = ")).add(M::src(re, re.at)).lit_then(";"));
                }
                RouteSectionKind::Pattern { pattern, .. } => {
                    g.line(&format!("static __m{i}(s: string[]): Record<string, string> | null {{"));
                    for line in crate::routes::section_matcher(pattern).lines() {
                        g.line(&format!("  {}", line.trim_start()));
                    }
                    g.line("}");
                }
                _ => {}
            }
        }
    }
    if !slots.is_empty() {
        let fields: Vec<String> = slots
            .iter()
            .map(|(key, params)| {
                let params: Vec<String> = params.iter().map(|(n, t)| format!("{n}: {t}")).collect();
                format!("{key}?: ({}) => RenderFragment", params.join(", "))
            })
            .collect();
        g.line(&format!("declare slots: {{ {} }};", fields.join("; ")));
    }
    if !doc.injects.is_empty() {
        let names: Vec<String> = doc.injects.iter().map(|i| js_string(&i.name)).collect();
        g.line(&format!("static readonly inject = [{}];", names.join(", ")));
        for i in &doc.injects {
            g.emit(M::lit("readonly ").add(M::src(&i.name, i.name.at)).lit_then(": ").add(M::src(&i.ty, i.ty.at)).lit_then(";"));
        }
        let params: Vec<String> = doc.injects.iter().map(|i| format!("{}: {}", i.name, i.ty)).collect();
        let assigns: String = doc.injects.iter().map(|i| format!(" this.{0} = {0};", i.name)).collect();
        g.line(&format!("constructor({}) {{ super();{assigns} }}", params.join(", ")));
    }
    if !cascades.is_empty() {
        let pairs: Vec<String> = cascades.iter().map(|(prop, name)| format!("[{}, {}]", js_string(prop), js_string(name))).collect();
        let pairs = pairs.join(", ");
        // This static shadows the base's, so a derived component repeats the base's entries.
        let list = match &doc.inherits {
            Some(b) => {
                let base = b.text.split('<').next().unwrap_or(&b.text).trim_end();
                format!("[...(({base} as {{ cascades?: {CASCADE_LIST} }}).cascades ?? []), {pairs}]")
            }
            None => format!("[{pairs}]"),
        };
        g.line(&format!("static readonly cascades: {CASCADE_LIST} = {list} as const;"));
    }
    for parts in &doc.code_parts {
        let block = g.code_block(parts, &blanks)?;
        g.emit_block(block);
        g.line("");
    }
    g.line("protected override buildRenderTree(__b: RenderTreeBuilder): void {");
    g.depth = 2;
    if doc.fine {
        g.line("__b.addFine((__p) => {");
        g.depth = 3;
        g.fine_nodes(&doc.nodes, "__p")?;
        g.depth = 2;
        g.line("});");
    } else {
        g.nodes(&doc.nodes)?;
    }
    g.depth = 1;
    g.line("}");
    g.depth = 0;
    g.line("}");
    if !g.templates.is_empty() {
        g.line("");
        for (i, spec) in std::mem::take(&mut g.templates).iter().enumerate() {
            g.line(&format!("const __t{i} = fine.template([{spec}]);"));
        }
    }
    // Removal looks for `data-leave` only once a component that sets it is loaded.
    if g.out[head_at..].contains("data-leave") {
        g.line("ComponentBase.$leaves = true;");
    }
    let types = g.route_types.get();
    let mut head = String::from("import { ComponentBase, ");
    if uses_lazy {
        head.push_str("lazy, ");
    }
    head.push_str("type RenderTreeBuilder");
    if !slots.is_empty() || types & ROUTE_FRAGMENT != 0 {
        head.push_str(", type RenderFragment");
    }
    if types & ROUTE_TYPE != 0 {
        head.push_str(", type Route");
    }
    head.push_str(" } from \"@source-crafter/xzor-runtime\";\n");
    if doc.fine {
        let base = if doc.inherits.is_some() { "" } else { "FineComponent, " };
        let el = if g.uses_el { ", type El" } else { "" };
        head.push_str(&format!("import {{ {base}fine{el} }} from \"@source-crafter/xzor-runtime/model\";\n"));
    }
    if block.is_some() {
        let params = if types & ROUTE_PARAMS != 0 { ", type RouteParams as __RouteParams" } else { "" };
        let app = if types & ROUTE_APP != 0 { ", type AppRoute as __AppRoute" } else { "" };
        head.push_str(&format!("import {{ routes as __routes{app}{params} }} from {};\n", js_string(table)));
    }
    g.out.insert_str(head_at, &head);
    for m in &mut g.mappings {
        m.out += head.len();
    }
    let injects = doc.injects.clone();
    let routes = page_routes(doc, &decls, inherited);
    let routes_block = block.and_then(block_info);
    Ok(Generated { code: g.out, mappings: g.mappings, injects, routes, routes_block, deps: Vec::new(), warnings: Vec::new(), css: None })
}

/// The document's routes block, wherever in the markup it sits (there is at most one per project).
fn find_routes(nodes: &[Node]) -> Option<&Node> {
    nodes.iter().find_map(|node| match node {
        Node::Routes { .. } => Some(node),
        Node::Element(el) => find_routes(&el.children),
        Node::If { branches, otherwise } => {
            branches.iter().map(|(_, b)| b).chain(otherwise).find_map(|b| find_routes(b))
        }
        Node::For { body, otherwise, .. } | Node::While { body, otherwise, .. } => find_routes(body).or_else(|| otherwise.as_deref().and_then(find_routes)),
        Node::Cascade { body, .. } => find_routes(body),
        Node::Once(body) => find_routes(body),
        Node::Show(inner) => find_routes(std::slice::from_ref(&**inner)),
        Node::Pause(body) => body.as_deref().and_then(find_routes),
        Node::Await { pending, then, catch, .. } => find_routes(pending).or_else(|| then.iter().chain(catch).find_map(|(_, b)| find_routes(b))),
        Node::Switch { cases, .. } => cases.iter().find_map(|c| find_routes(&c.body)),
        Node::SlotFill(fill) => find_routes(&fill.body),
        Node::Slot(slot) => slot.fallback.as_deref().and_then(find_routes),
        Node::Code(parts) => parts.iter().find_map(|part| match part {
            CodePart::Render(nodes) => find_routes(nodes),
            CodePart::Markup(el) => find_routes(&el.children),
            CodePart::Ts(_) => None,
        }),
        Node::Text(_) | Node::Expr(_) | Node::ParentAttr(_) => None,
    })
}

/// What the route table needs to know about a block: its engine and the tags its sections claim.
fn block_info(node: &Node) -> Option<crate::routes::RoutesBlockInfo> {
    let Node::Routes { engine, var, sections } = node else { return None };
    let sections = sections
        .iter()
        .filter_map(|s| match &s.kind {
            RouteSectionKind::Tag { tag, .. } => Some((tag.text.clone(), tag.at)),
            _ => None,
        })
        .collect();
    Some(crate::routes::RoutesBlockInfo { engine: *engine, at: var.at, sections })
}

/// Whether a block's pattern matchers need the `__d` decode guard.
fn decodes_segments(node: &Node) -> bool {
    let Node::Routes { sections, .. } = node else { return false };
    sections.iter().any(|s| match &s.kind {
        RouteSectionKind::Pattern { pattern, .. } => !crate::routes::param_names(pattern).is_empty(),
        _ => false,
    })
}

/// Named capture groups of a regex literal, in order; `(?<=` and `(?<!` are lookbehinds, not groups.
fn named_groups(re: &str) -> Vec<&str> {
    let b = re.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'(' && b[i + 1] == b'?' && b[i + 2] == b'<' && is_ident_start(b[i + 3]) {
            let start = i + 3;
            i = start + b[start..].iter().position(|&c| !is_ident_char(c)).unwrap_or(b.len() - start);
            if b.get(i) == Some(&b'>') {
                out.push(&re[start..i]);
            }
            continue;
        }
        i += 1;
    }
    out
}

/// `a: string; b: string` for the names a routes section binds on `route`.
fn fields(names: &[&str]) -> String {
    names.iter().map(|n| format!("{n}: string")).collect::<Vec<_>>().join("; ")
}

/// The `@page` routes of a document, with params typed from the props.
fn page_routes(doc: &Document, decls: &[Vec<MemberDecl>], inherited: &HashSet<String>) -> Vec<RouteInfo> {
    doc.pages
        .iter()
        .map(|page| {
            let (tag, tag_at) = match &page.tag {
                Some(t) => (Some(t.text.clone()), t.at),
                None => (None, page.pattern.at),
            };
            let params = crate::routes::param_names(&page.pattern)
                .into_iter()
                .map(|p| (p.to_string(), declared_param_kind(doc, decls, p)))
                .collect();
            let rest = declaration_of(doc, decls, "rest").is_some() || inherited.contains("rest");
            RouteInfo { tag, tag_at, pattern: page.pattern.text.clone(), pattern_at: page.pattern.at, params, rest }
        })
        .collect()
}

/// Conversion for a route param, from the member of the same name; anything not declared here
/// (inherited, static or absent, like an undeclared `rest`) stays a string.
fn declared_param_kind(doc: &Document, decls: &[Vec<MemberDecl>], param: &str) -> ParamKind {
    declaration_of(doc, decls, param).map_or(ParamKind::String, |d| crate::routes::param_kind(&d))
}

/// The declaration text of an instance member of this document, if it declares one.
fn declaration_of(doc: &Document, decls: &[Vec<MemberDecl>], name: &str) -> Option<String> {
    doc.code.iter().zip(decls).find_map(|(code, decls)| {
        let m = decls.iter().find(|m| !m.is_method && !m.is_static && m.name == name)?;
        Some(declaration_text(&code[m.offset..]))
    })
}

/// The member declaration at the start of `s` without comments: up to a top-level `;` or newline,
/// except that a line ending in `:`, `|` or `=`, or followed by a line starting with `|`, continues.
fn declaration_text(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let (mut i, mut depth) = (0, 0i32);
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'' | b'`') => {
                let start = i;
                i += 1;
                while i < b.len() && b[i] != q {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i = (i + 1).min(b.len());
                out.push_str(&s[start..i]);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = s[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
                out.push(' ');
                continue;
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b';' if depth <= 0 => break,
            b'\n' if depth <= 0 => {
                let next = s[i..].trim_start().bytes().next();
                if !(out.trim_end().ends_with([':', '|', '=']) || next == Some(b'|')) {
                    break;
                }
            }
            _ => {}
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

struct Gen<'p> {
    out: String,
    mappings: Vec<Mapping>,
    members: HashSet<String>,
    /// The component's own `static` members, which are reached through the class (`this` is the instance).
    statics: HashSet<String>,
    /// `ClassName.`, the prefix of those.
    static_prefix: String,
    locals: Vec<String>,
    depth: usize,
    components: &'p HashMap<String, ComponentInfo>,
    /// Emit statements on one line (for fragments spliced into `@code`).
    inline: bool,
    /// Next `__p<N>` name for a hoisted props object; unique across nested fragments.
    props_ids: std::cell::Cell<usize>,
    /// Inside `<script>`/`<style>`: text is raw, so character references are not decoded.
    raw_text: bool,
    /// Which of `Route`, `__AppRoute`, `__RouteParams` and `RenderFragment` the route sections reference (`ROUTE_*` bits).
    route_types: std::cell::Cell<u8>,
    /// Next `_e<N>` node variable of a `@fine` template.
    fine_ids: usize,
    /// Emitting inside a `fine.region`: its bindings close over their values instead of sharing a row's reads.
    in_region: bool,
    /// Emitting a plain loop's body in a region: nested structure stays inline, the region rebuilds it whole.
    in_loop: bool,
    /// The node variable of the element `@attr:` sets, when the nodes being emitted are its children.
    owner: Option<String>,
    /// `@Key("member")` fields: loops over them match rows by that member of each item.
    list_keys: HashMap<String, String>,
    /// Emitting a keyed pass's row: its loop variables, which keep the row only while they are the same.
    pass_locals: Option<Vec<String>>,
    /// Emitting an `@once` block: values are set, not bound.
    once: bool,
    /// The next `@if`/`@switch` of `fine_flow` is a `branchAt`'s: each branch first returns its index without a parent.
    branching: bool,
    /// Emitting the branches of a show block, where `@pause { }` may go.
    in_show: usize,
    /// The specs of the `@fine` templates, emitted after the class as `__t<N>`.
    templates: Vec<String>,
    /// The row being emitted, whose bindings go through its list's shared reads.
    reads: Option<Reads>,
    /// A node variable is cast with the runtime's `El` type.
    uses_el: bool,
}

/// A node of a `@fine` template.
enum Tpl {
    Text(String),
    /// The empty text a `@expr` binds.
    Hole,
    /// A comment marking where a region, list or island goes.
    Anchor,
    El { tag: String, attrs: Vec<(String, String)>, kids: Vec<Tpl> },
}

/// What binds a node of a template clone.
enum FinePart<'n> {
    Expr(&'n Src),
    /// Attribute bindings, handlers, `@bind`, `@ref`.
    Element(&'n Element),
    Region(&'n Node),
    /// A `@{ }` block and the siblings after it.
    Code(&'n [CodePart], &'n [Node]),
    List(&'n Node),
    Island(&'n [Node]),
    /// `@attr:`, bound to the element that holds it.
    ParentAttr(&'n Attr),
    /// An `@if`/`@switch` of a keyed pass's row that reads only the pass's values, appended to its element.
    Flow(&'n Node),
    /// `@once(expr)`: its text hole, set once.
    OnceText(&'n Src),
    /// `@once { }`: built once before its anchor.
    /// `@await`, between its two anchors.
    Await(&'n Node),
    Once(&'n [Node]),
    /// `@show:if`/`@show:switch` (the `If` or `Switch`), between its two anchors.
    Show(&'n Node),
    /// `@pause { }`, between its two anchors.
    Pause(&'n [Node]),
}

struct Reads {
    /// The row's item as declared (`w` or `w: Worker`), and its name.
    param: String,
    name: String,
    list: Vec<M>,
}

/// `[tag, attrs | 0, ...children]`, a string, `""` for a hole or `null` for an anchor; see `fine.template`.
fn spec_js(t: &Tpl) -> String {
    match t {
        Tpl::Text(s) => js_string(s),
        Tpl::Hole => "\"\"".into(),
        Tpl::Anchor => "null".into(),
        Tpl::El { tag, attrs, kids } => {
            let attrs = match attrs.is_empty() {
                true => "0".to_string(),
                false => format!("[{}]", attrs.iter().flat_map(|(n, v)| [js_string(n), js_string(v)]).collect::<Vec<_>>().join(", ")),
            };
            let kids: String = kids.iter().map(|k| format!(", {}", spec_js(k))).collect();
            format!("[{}, {attrs}{kids}]", js_string(tag))
        }
    }
}

fn is_plain_code(parts: &[CodePart]) -> bool {
    parts.iter().all(|p| matches!(p, CodePart::Ts(_)))
}

/// An element `@fine` leaves to the virtual DOM: a component, or `@attributes` and event modifiers.
fn is_island(el: &Element) -> bool {
    el.is_component() || el.attrs.iter().any(|a| &*a.name.text == "@attributes" || (a.name.starts_with("@on") && a.name.contains(':')))
}

fn is_plain_code_node(node: &Node) -> bool {
    matches!(node, Node::Code(parts) if is_plain_code(parts))
}

/// A show block's `If`/`Switch` with each branch checked, and a leading bare `@pause` holding the rest of its branch.
fn show_branches(node: &Node) -> Result<Node, String> {
    fn branch(body: &[Node]) -> Result<Vec<Node>, String> {
        let blank = |n: &Node| matches!(n, Node::Text(t) if t.trim().is_empty());
        let first = body.iter().position(|n| !blank(n));
        let body = match first.map(|i| (i, &body[i])) {
            Some((i, Node::Pause(None))) => vec![Node::Pause(Some(body[i + 1..].to_vec()))],
            _ => body.to_vec(),
        };
        top_level(&body)?;
        Ok(body)
    }
    // What shows up later at a branch's top level could not be hidden: elements only.
    fn top_level(nodes: &[Node]) -> Result<(), String> {
        for n in nodes {
            match n {
                Node::Text(t) if t.trim().is_empty() => {}
                Node::Element(el) if &*el.name.text != "text" && !el.is_component() => {}
                Node::Pause(Some(body)) => top_level(body)?,
                Node::Pause(None) => return Err("bare @pause goes first in a @show branch; use @pause { } for a part of it".into()),
                _ => return Err("a @show branch holds elements at its top level, which it hides: wrap it in an element".into()),
            }
        }
        Ok(())
    }
    match node {
        Node::If { branches, otherwise } => Ok(Node::If {
            branches: branches.iter().map(|(c, b)| Ok((c.clone(), branch(b)?))).collect::<Result<_, String>>()?,
            otherwise: otherwise.as_deref().map(branch).transpose()?,
        }),
        Node::Switch { subject, cases } => Ok(Node::Switch {
            subject: subject.clone(),
            cases: cases.iter().map(|c| Ok(Case { labels: c.labels.clone(), body: branch(&c.body)? })).collect::<Result<_, String>>()?,
        }),
        _ => unreachable!("a show block holds an if or a switch"),
    }
}

/// `f(a, b)` or `x.y.f(a, b)`, the whole of `text`: the callee's range and each argument's. `None` for anything
/// else, a call without arguments, a spread argument or a template literal.
fn call_parts(text: &str) -> Option<((usize, usize), Vec<(usize, usize)>)> {
    if text.contains('`') {
        return None;
    }
    let lead = text.len() - text.trim_start().len();
    let last = text.trim_end().len();
    let open = text.find('(')?;
    let ident = |s: &str| s.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$') && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$');
    let callee_end = lead + text[lead..open].trim_end().len();
    if !text[lead..callee_end].split('.').all(ident) {
        return None;
    }
    let bytes = text.as_bytes();
    let (mut depth, mut quote, mut start, mut i) = (0, None, open + 1, open);
    let mut args = Vec::new();
    loop {
        let b = *bytes.get(i)?;
        if let Some(q) = quote {
            if b == b'\\' {
                i += 1;
            } else if b == q {
                quote = None;
            }
        } else {
            match b {
                b'\'' | b'"' => quote = Some(b),
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        if i + 1 != last {
                            return None;
                        }
                        args.push((start, i));
                        break;
                    }
                }
                b',' if depth == 1 => {
                    args.push((start, i));
                    start = i + 1;
                }
                _ => {}
            }
        }
        i += 1;
    }
    let trim = |(a, b): (usize, usize)| (a + text[a..b].len() - text[a..b].trim_start().len(), a + text[a..b].trim_end().len());
    let mut args: Vec<_> = args.into_iter().map(trim).collect();
    if args.last().is_some_and(|&(a, b)| a >= b) {
        args.pop();
    }
    if args.is_empty() || args.iter().any(|&(a, b)| a >= b || text[a..b].starts_with("...")) {
        return None;
    }
    Some(((lead, callee_end), args))
}

/// An `@if`/`@switch` whose kept branch stays current: its branches run no `@{ }` code while building.
fn branchable(node: &Node) -> bool {
    let plain = |body: &[Node]| !body.iter().any(is_plain_code_node);
    match node {
        Node::If { branches, otherwise } => branches.iter().all(|(_, b)| plain(b)) && otherwise.as_deref().is_none_or(plain),
        Node::Switch { cases, .. } => cases.iter().all(|c| plain(&c.body)),
        _ => false,
    }
}

/// Whether a pass of loop `node` can be skipped when its row is kept: it has values to compare (a key or loop
/// variables) and runs no `@{ }` code, whose effects a skipped pass would lose.
fn keyable(node: &Node) -> bool {
    fn has_code(nodes: &[Node]) -> bool {
        nodes.iter().any(|n| match n {
            Node::Code(_) => true,
            Node::Element(el) => has_code(&el.children),
            Node::If { branches, otherwise } => branches.iter().any(|(_, b)| has_code(b)) || otherwise.as_deref().is_some_and(has_code),
            Node::For { body, otherwise, .. } | Node::While { body, otherwise, .. } => has_code(body) || otherwise.as_deref().is_some_and(has_code),
            Node::Switch { cases, .. } => cases.iter().any(|c| has_code(&c.body)),
            _ => false,
        })
    }
    match node {
        Node::For { head, key, body, .. } => (key.is_some() || !loop_locals(head).is_empty()) && !has_code(body),
        Node::While { key, body, .. } => key.is_some() && !has_code(body),
        _ => false,
    }
}

/// Whether `nodes` hold an `@attr:` for their enclosing element (one inside a child element is that child's).
fn has_parent_attr(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::ParentAttr(_) => true,
        Node::If { branches, otherwise } => branches.iter().any(|(_, b)| has_parent_attr(b)) || otherwise.as_deref().is_some_and(has_parent_attr),
        Node::For { body, otherwise, .. } | Node::While { body, otherwise, .. } => has_parent_attr(body) || otherwise.as_deref().is_some_and(has_parent_attr),
        Node::Switch { cases, .. } => cases.iter().any(|c| has_parent_attr(&c.body)),
        Node::Element(el) if &*el.name.text == "text" => has_parent_attr(&el.children),
        _ => false,
    })
}

/// Control flow inside a plain loop: structure, a plain `@{ }`, or an element holding one.
fn is_flow(node: &Node) -> bool {
    match node {
        Node::Code(parts) => is_plain_code(parts),
        Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. } => true,
        Node::Element(el) => !is_island(el) && el.children.iter().any(is_flow),
        _ => false,
    }
}

const ROUTE_TYPE: u8 = 1;
const ROUTE_PARAMS: u8 = 2;
const ROUTE_FRAGMENT: u8 = 4;
const ROUTE_APP: u8 = 8;

/// Whether `word` is used as a free identifier in generated code `text` (not in strings or as a property).
fn mentions(text: &str, word: &str) -> bool {
    let found = std::cell::Cell::new(false);
    rewrite(text, &|w| {
        found.set(found.get() || w == word);
        false
    });
    found.get()
}

impl Gen<'_> {
    fn emit(&mut self, m: M) {
        if !self.inline && !m.text.is_empty() {
            for _ in 0..self.depth {
                self.out.push_str("  ");
            }
        }
        let base = self.out.len();
        self.mappings.extend(m.maps.into_iter().map(|x| Mapping { out: x.out + base, ..x }));
        self.out.push_str(&m.text);
        self.out.push(if self.inline { ' ' } else { '\n' });
    }

    /// A `@code` block with its markup values compiled to `RenderFragment`s and its `@Cascade`
    /// decorators (`blanks`) blanked out.
    fn code_block(&self, parts: &[CodePart], blanks: &[(usize, usize)]) -> Result<M, String> {
        let mut out = M::default();
        for part in parts {
            out = match part {
                CodePart::Ts(s) => out.add(blanked(s, blanks)),
                CodePart::Markup(el) => out.add(self.fragment(el)?),
                CodePart::Render(_) => return Err("markup statements and `@:` lines belong in `@{ }`, not `@code`".into()),
            };
        }
        Ok(out)
    }

    /// Markup in `@code` is plain TypeScript scope: no `this.` rewriting.
    fn fragment(&self, el: &Element) -> Result<M, String> {
        self.fragment_of(std::slice::from_ref(&Node::Element(el.clone())), false, &[])
    }

    /// `ComponentBase.fragment((__b) => { ... })` for `nodes`, emitted on one line.
    /// `locals` are extra names in scope (slot parameters) that must not get `this.`.
    fn fragment_of(&self, nodes: &[Node], rewrite: bool, locals: &[String]) -> Result<M, String> {
        let body = self.inline_nodes(nodes, rewrite, locals)?;
        Ok(M::lit("ComponentBase.fragment((__b) => { ").add(body).lit_then(" })"))
    }

    /// Builder calls for `nodes` on one line.
    fn inline_nodes(&self, nodes: &[Node], rewrite: bool, locals: &[String]) -> Result<M, String> {
        let mut sub = Gen {
            out: String::new(),
            mappings: Vec::new(),
            members: if rewrite { self.members.clone() } else { HashSet::new() },
            statics: if rewrite { self.statics.clone() } else { HashSet::new() },
            static_prefix: self.static_prefix.clone(),
            locals: self.locals.iter().chain(locals).cloned().collect(),
            depth: 0,
            components: self.components,
            inline: true,
            raw_text: self.raw_text,
            props_ids: std::cell::Cell::new(self.props_ids.get()),
            route_types: std::cell::Cell::new(self.route_types.get()),
            fine_ids: 0,
            in_region: false,
            in_loop: false,
            owner: None,
            list_keys: HashMap::new(),
            pass_locals: None,
            once: false,
            branching: false,
            in_show: 0,
            templates: Vec::new(),
            reads: None,
            uses_el: false,
        };
        let done = sub.nodes(nodes);
        self.props_ids.set(sub.props_ids.get());
        self.route_types.set(sub.route_types.get());
        done?;
        Ok(M { text: sub.out.trim_end().to_string(), maps: sub.mappings })
    }

    /// One section of a routes block as its `RouteSection` descriptor. `RouteSection.render` takes a
    /// plain `Route`, so a section that reads `route` casts it to the project's `AppRoute` in a local.
    fn route_section(&self, i: usize, var: &Src, section: &RouteSectionNode) -> Result<M, String> {
        let app = "__AppRoute".to_string();
        let (head, narrowed) = match &section.kind {
            RouteSectionKind::Tag { tag, .. } => (
                M::lit("{ kind: \"tag\", tag: ").add(M::lit("\"").add(M::src(tag, tag.at)).lit_then("\"")).lit_then(", render: "),
                format!("__AppRoute<__RouteParams[{}]>", js_string(tag)),
            ),
            RouteSectionKind::Regex { re, page } => {
                let groups = named_groups(re);
                let narrowed = if groups.is_empty() { app } else { format!("{app} & {{ match: {{ {} }} }}", fields(&groups)) };
                let head = format!("{{ kind: \"regex\", re: {}__re{i}, page: {}, render: ", self.static_prefix, page.is_some());
                (M::lit(&head), narrowed)
            }
            RouteSectionKind::Pattern { pattern, page } => {
                let params = crate::routes::param_names(pattern);
                // With a page, `params` are the page's; the section's own captures are on `match`.
                let narrowed = match (params.is_empty(), page) {
                    (true, _) => app,
                    (false, Some(_)) => format!("{app} & {{ match: {{ {} }} }}", fields(&params)),
                    (false, None) => format!("__AppRoute<{{ {} }}>", fields(&params)),
                };
                let head = format!("{{ kind: \"pattern\", match: {}__m{i}, page: {}, render: ", self.static_prefix, page.is_some());
                (M::lit(&head), narrowed)
            }
            RouteSectionKind::NotFound => (M::lit("{ kind: \"notFound\", render: "), app),
            RouteSectionKind::Catch { .. } => (M::lit("{ kind: \"catch\", render: "), app),
            RouteSectionKind::Default { .. } => (M::lit("{ kind: \"default\", render: "), app),
        };
        let mut locals = vec![var.text.clone()];
        let bound = section.kind.binding();
        if let Some(bound) = bound {
            locals.push(bound.text.clone());
        }
        let body = self.fragment_of(&section.body, true, &locals)?;
        // Only what the body reads is declared, so `noUnusedLocals`/`noUnusedParameters` stay quiet.
        let uses_var = mentions(&body.text, &var.text);
        let uses_bound = bound.is_some_and(|b| mentions(&body.text, &b.text));
        let is_catch = matches!(section.kind, RouteSectionKind::Catch { .. });
        let mut types = 0;
        let mut params = M::lit("(");
        if uses_var || uses_bound {
            types |= ROUTE_TYPE;
            // `any` lets the cast below reach the project's route type; `Route` alone does not overlap with it.
            params = match uses_var {
                true => params.lit_then("__route: Route<any, any>"),
                false => params.lit_then("_route: Route"),
            };
        }
        if let Some(bound) = bound.filter(|_| uses_bound) {
            types |= if is_catch { 0 } else { ROUTE_FRAGMENT };
            params = params.lit_then(", ").add(M::src(bound, bound.at)).lit_then(if is_catch { ": unknown" } else { ": RenderFragment" });
        }
        if uses_var {
            types |= ROUTE_APP;
            if matches!(section.kind, RouteSectionKind::Tag { .. }) {
                types |= ROUTE_PARAMS;
            }
        }
        self.route_types.set(self.route_types.get() | types);
        let render = if uses_var {
            params
                .lit_then(") => { const ")
                .add(M::src(var, var.at))
                .lit_then(&format!(" = __route as {narrowed}; return "))
                .add(body)
                .lit_then("; }")
        } else {
            params.lit_then(") => ").add(body)
        };
        Ok(head.add(render).lit_then(" },"))
    }

    /// `(params) => fragment` passed to a child for one of its slots.
    fn slot_lambda(&self, params: Option<&Src>, body: &[Node]) -> Result<M, String> {
        let head = match params {
            Some(p) => M::lit("(").add(M::src(p, p.at)).lit_then(") => "),
            None => M::lit("() => "),
        };
        let names = params.map(|p| param_names(p)).unwrap_or_default();
        Ok(head.add(self.fragment_of(body, true, &names)?))
    }

    /// Emits multi-line mapped text with its common indentation removed.
    fn emit_block(&mut self, m: M) {
        let text = &m.text;
        let mut lines = Vec::new();
        let mut start = 0;
        for (i, c) in text.bytes().enumerate() {
            if c == b'\n' {
                lines.push((start, i));
                start = i + 1;
            }
        }
        lines.push((start, text.len()));
        let lines: Vec<(usize, usize)> =
            lines.into_iter().map(|(s, e)| (s, if e > s && text.as_bytes()[e - 1] == b'\r' { e - 1 } else { e })).collect();
        let blank = |&(s, e): &(usize, usize)| text[s..e].trim().is_empty();
        let first = lines.iter().position(|l| !blank(l)).unwrap_or(lines.len());
        let last = lines.iter().rposition(|l| !blank(l)).map_or(first, |i| i + 1);
        let lines = &lines[first..last];
        let indent = |&(s, e): &(usize, usize)| text[s..e].len() - text[s..e].trim_start_matches([' ', '\t']).len();
        let min = lines.iter().filter(|l| !blank(l)).map(indent).min().unwrap_or(0);
        for line in lines {
            if blank(line) {
                self.out.push('\n');
                continue;
            }
            let (s, e) = (line.0 + min, line.1);
            let mut lm = M::lit(&text[s..e]);
            for mp in &m.maps {
                let (a, b) = (mp.out.max(s), (mp.out + mp.len).min(e));
                if a < b {
                    lm.maps.push(Mapping { src: mp.src + (a - mp.out), out: a - s, len: b - a });
                }
            }
            self.emit(lm);
        }
    }

    fn line(&mut self, s: &str) {
        self.emit(M::lit(s));
    }

    fn is_member(&self, word: &str) -> bool {
        self.members.contains(word) && !self.locals.iter().any(|l| l == word)
    }

    /// `this.` or `ClassName.` for a member name that isn't shadowed.
    fn member_prefix(&self, word: &str) -> Option<&str> {
        self.is_member(word).then(|| if self.statics.contains(word) { self.static_prefix.as_str() } else { "this." })
    }

    /// Rewritten expression, mapped piecewise around each inserted prefix.
    fn expr(&self, e: &Src) -> M {
        let mut inserts = Vec::new();
        let text = rewrite_tracked(e, &|w| self.member_prefix(w), &mut inserts, 0);
        let mut maps = Vec::new();
        let (mut start, mut added) = (0, 0);
        for (end, len) in inserts.iter().copied().chain([(e.len(), 0)]) {
            if end > start && e.at != Src::UNMAPPED {
                maps.push(Mapping { src: e.at + start, out: start + added, len: end - start });
            }
            start = end;
            added += len;
        }
        M { text, maps }
    }

    fn value(&self, v: &AttrValue) -> M {
        match v {
            AttrValue::Empty => M::lit("true"),
            AttrValue::Static(s) => M::lit(&js_string(&crate::entities::decode(s))),
            AttrValue::Expr(e) => self.expr(e),
            AttrValue::Interp(parts) => {
                let mut out = M::default();
                for (i, p) in parts.iter().enumerate() {
                    if i > 0 {
                        out = out.lit_then(" + ");
                    }
                    out = match p {
                        Part::Text(t) => out.lit_then(&js_string(&crate::entities::decode(t))),
                        Part::Expr(e) => out.lit_then("String(").add(self.expr(e)).lit_then(")"),
                    };
                }
                out
            }
        }
    }

    fn nodes(&mut self, nodes: &[Node]) -> Result<(), String> {
        nodes.iter().try_for_each(|n| self.node(n))
    }

    fn block(&mut self, nodes: &[Node]) -> Result<(), String> {
        self.depth += 1;
        let scope = self.locals.len();
        let r = self.nodes(nodes);
        self.locals.truncate(scope);
        self.depth -= 1;
        r
    }

    fn node(&mut self, node: &Node) -> Result<(), String> {
        // A region keeps a block's variable output from shifting its static siblings in the diff.
        let region = matches!(node, Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. });
        if region {
            self.line("__b.openRegion();");
        }
        match node {
            Node::Text(t) if self.raw_text => self.line(&format!("__b.addText({});", js_string(t))),
            Node::Text(t) => self.line(&format!("__b.addText({});", js_string(&crate::entities::decode(t)))),
            Node::Expr(e) => {
                let line = M::lit("__b.addContent(").add(self.expr(e)).lit_then(");");
                self.emit(line);
            }
            Node::Code(parts) => {
                for part in parts {
                    if let CodePart::Ts(s) = part {
                        self.locals.extend(declared_names(s));
                    }
                }
                let mut block = M::default();
                for part in parts {
                    block = match part {
                        CodePart::Ts(s) => block.add(self.expr(s)),
                        CodePart::Markup(el) => block.add(self.fragment_of(std::slice::from_ref(&Node::Element(el.clone())), true, &[])?),
                        CodePart::Render(nodes) => block.add(self.inline_nodes(nodes, true, &[])?),
                    };
                }
                if self.inline {
                    self.emit(block);
                } else {
                    self.emit_block(block);
                }
            }
            Node::While { cond, body, otherwise, .. } => {
                if otherwise.is_some() {
                    self.open_none();
                }
                let line = M::lit("while (").add(self.expr(cond)).lit_then(") {");
                self.emit(line);
                if otherwise.is_some() {
                    self.mark_pass();
                }
                self.block(body)?;
                self.line("}");
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.block(body)?;
                    self.close_none();
                }
            }
            Node::Element(el) if &*el.name.text == "text" => self.nodes(&el.children)?,
            Node::Slot(slot) => {
                let name = match &slot.name {
                    Some(n) => M::src(n, n.at),
                    None => M::lit("default"),
                };
                let mut line = M::lit("__b.addContent(this.slots.").add(name).lit_then("?.(");
                for (i, arg) in slot.args.iter().flatten().enumerate() {
                    let value = match arg {
                        SlotArg::Expr(e) => self.expr(e),
                        SlotArg::Markup(el) => self.fragment_of(std::slice::from_ref(&Node::Element(el.clone())), true, &[])?,
                    };
                    line = line.lit_then(if i == 0 { "" } else { ", " }).add(value);
                }
                let fallback = match &slot.fallback {
                    Some(body) => self.fragment_of(body, true, &[])?,
                    None => M::lit("null"),
                };
                self.emit(line.lit_then(") ?? ").add(fallback).lit_then(");"));
            }
            Node::SlotFill(_) => return Err("`@slot name { }` fills a slot and must be a direct child of a component tag".into()),
            Node::ParentAttr(a) => {
                let line = M::lit(&format!("__b.addParentAttribute({}, ", js_string(&a.name))).add(self.value(&a.value)).lit_then(");");
                self.emit(line);
            }
            // A render pass has no "once": it renders as usual.
            Node::Once(body) => self.nodes(body)?,
            Node::Await { .. } => return Err("@await can't go inside a component's content, a routes block, @cascade or markup in @{ }: put it around them, or inside the child component".into()),
            Node::Show(_) | Node::Pause(_) => return Err("@show:if, @show:switch and @pause can't go inside a component's content, a routes block, @cascade or markup in @{ }: put them around them, or inside the child component".into()),
            Node::Cascade { name, value, fixed, body } => {
                let quoted = js_string(name);
                // The mapping stays on the name only while the literal is a straight copy of it.
                let literal = if quoted[1..quoted.len() - 1] == *name.text {
                    M::lit("\"").add(M::src(name, name.at)).lit_then("\"")
                } else {
                    M::lit(&quoted)
                };
                let open = M::lit("__b.openCascade(").add(literal).lit_then(", ").add(self.expr(value));
                self.emit(open.lit_then(if *fixed { ", true);" } else { ");" }));
                // The body is a block so that sibling providers can declare the same `@{ const }` names.
                self.line("{");
                self.block(body)?;
                self.line("}");
                self.line("__b.closeRegion();");
            }
            Node::Routes { engine, var, sections } => {
                let engine = match engine {
                    crate::routes::Engine::Client => "client",
                    crate::routes::Engine::Server => "server",
                };
                self.line(&format!("__b.addRoutes({}, __routes, [", js_string(engine)));
                self.depth += 1;
                for (i, section) in sections.iter().enumerate() {
                    let m = self.route_section(i, var, section)?;
                    self.emit(m);
                }
                self.depth -= 1;
                self.line("]);");
            }
            Node::Element(el) if el.is_component() => self.component(el)?,
            Node::Element(el) => {
                self.line(&format!("__b.openElement({});", js_string(&el.name)));
                let directive = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n).map(|a| &a.value);
                for a in &el.attrs {
                    match &*a.name.text {
                        name @ ("@bind" | "@bind:input") => self.bind_element(el, a, bind_event(name, directive("@bind:event"))?, directive("@bind:after"))?,
                        "@bind:event" | "@bind:after" | "@bind:debounce" => {}
                        n if n.starts_with("class:") => {}
                        "@leave" => self.line("__b.addAttribute(\"data-leave\", \"\");"),
                        "@key" => {
                            let line = M::lit("__b.setKey(").add(self.directive_expr(a)?).lit_then(");");
                            self.emit(line);
                        }
                        "@ref" => {
                            let target = self.directive_expr(a)?;
                            let line = M::lit(&format!("__b.setRef({}, (__e) => {{ ", js_string(&el.name)))
                                .add(target)
                                .lit_then(" = __e; });");
                            self.emit(line);
                        }
                        _ => self.attribute(a)?,
                    }
                }
                // After the element's own class, whatever the order they were written in.
                for a in el.attrs.iter().filter(|a| a.name.starts_with("class:")) {
                    let on = match &a.value {
                        AttrValue::Empty => M::lit("true"),
                        v => self.value(v),
                    };
                    self.emit(M::lit(&format!("__b.toggleClass({}, ", js_string(&a.name[6..]))).add(on).lit_then(");"));
                }
                let raw = std::mem::replace(&mut self.raw_text, matches!(&*el.name.to_ascii_lowercase(), "script" | "style"));
                self.nodes(&el.children)?;
                self.raw_text = raw;
                self.line("__b.closeElement();");
            }
            Node::If {
                branches,
                otherwise,
            } => {
                for (i, (cond, body)) in branches.iter().enumerate() {
                    let kw = if i == 0 { "if (" } else { "} else if (" };
                    let line = M::lit(kw).add(self.expr(cond)).lit_then(") {");
                    self.emit(line);
                    self.block(body)?;
                }
                if let Some(body) = otherwise {
                    self.line("} else {");
                    self.block(body)?;
                }
                self.line("}");
            }
            Node::For { head, body, otherwise, .. } => {
                if otherwise.is_some() {
                    self.open_none();
                }
                let scope = self.locals.len();
                self.locals.extend(loop_locals(head));
                let line = M::lit("for (").add(self.expr(head)).lit_then(") {");
                self.emit(line);
                if otherwise.is_some() {
                    self.mark_pass();
                }
                self.block(body)?;
                self.line("}");
                self.locals.truncate(scope);
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.block(body)?;
                    self.close_none();
                }
            }
            Node::Switch { subject, cases } => {
                let line = M::lit("switch (").add(self.expr(subject)).lit_then(") {");
                self.emit(line);
                self.depth += 1;
                for case in cases {
                    let count = case.labels.len();
                    for (i, label) in case.labels.iter().enumerate() {
                        let label = match label {
                            Some(e) => M::lit("case ").add(self.expr(e)),
                            None => M::lit("default"),
                        };
                        self.emit(label.lit_then(if i + 1 == count { ": {" } else { ":" }));
                    }
                    self.block(&case.body)?;
                    self.depth += 1;
                    self.line("break;");
                    self.depth -= 1;
                    self.line("}");
                }
                self.depth -= 1;
                self.line("}");
            }
        }
        if region {
            self.line("__b.closeRegion();");
        }
        Ok(())
    }

    /// A loop with an `else` is in a block whose `__none` stays true unless a pass runs.
    fn open_none(&mut self) {
        self.line("{");
        self.depth += 1;
        self.line("let __none = true;");
    }

    fn mark_pass(&mut self) {
        self.depth += 1;
        self.line("__none = false;");
        self.depth -= 1;
    }

    /// Ends the `if (__none) {` of the else and the loop's block.
    fn close_none(&mut self) {
        self.line("}");
        self.depth -= 1;
        self.line("}");
    }

    /// `this.m.bind(this)` for a bare member name, else the rewritten expression.
    fn handler(&self, e: &Src) -> M {
        if let Some(prefix) = self.member_prefix(e).filter(|_| is_identifier(e)) {
            M::lit(prefix).add(M::src(e, e.at)).lit_then(&format!(".bind({})", prefix.trim_end_matches('.')))
        } else {
            self.expr(e)
        }
    }

    /// `@fine`: statements that append `nodes` to `parent` (an element, or the fragment a region or row builds).
    /// Outside regions, `nodes` is one template clone: elements and static text are in the template, and each
    /// dynamic part binds the node it has in place (a text hole for `@expr`, comments for the rest).
    /// `@if`/`@while`/`@switch`/`for(;;)` are regions, `@for...of` a keyed list, and a `@{ }` block a region
    /// holding it and the siblings after it, so its locals stay current. Inside a region the same holds, so
    /// nested structure tracks its own reads, except that a plain `@{ }` runs inline in the region. In a plain
    /// loop's body (a region per pass would cost more than the rebuild) structure is plain control flow.
    fn fine_nodes(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        if !self.in_region {
            return self.fine_run(nodes, parent);
        }
        if self.in_loop {
            return self.fine_inline(nodes, parent);
        }
        let mut i = 0;
        while i < nodes.len() {
            if let Node::Code(parts) = &nodes[i]
                && is_plain_code(parts)
            {
                let block = self.fine_code_block(parts)?;
                self.emit_block(block);
                i += 1;
                continue;
            }
            let end = nodes[i..].iter().position(is_plain_code_node).map_or(nodes.len(), |n| i + n);
            self.fine_run(&nodes[i..end], parent)?;
            i = end;
        }
        Ok(())
    }

    /// `nodes` in a plain loop's body: structure as plain control flow, the runs between as templates.
    fn fine_inline(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        let mut i = 0;
        while i < nodes.len() {
            let node = &nodes[i];
            match node {
                Node::Code(parts) if is_plain_code(parts) => {
                    let block = self.fine_code_block(parts)?;
                    self.emit_block(block);
                }
                Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. } => self.fine_flow(node, parent)?,
                Node::Element(el) if is_flow(node) && &*el.name.text == "text" => self.fine_inline(&el.children, parent)?,
                Node::Element(el) if is_flow(node) => self.fine_element(el, parent)?,
                _ => {
                    // Markup inside `@{ }` is an island holding the rest, so the run takes it all.
                    let end = match nodes[i..].iter().position(|n| is_flow(n) || matches!(n, Node::Code(_))) {
                        Some(n) if is_flow(&nodes[i + n]) => i + n,
                        _ => nodes.len(),
                    };
                    self.fine_run(&nodes[i..end], parent)?;
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        Ok(())
    }

    /// An element whose children hold control flow, in a plain loop: created on its own.
    fn fine_element(&mut self, el: &Element, parent: &str) -> Result<(), String> {
        let var = self.fine_var();
        self.line(&format!("const {var} = fine.el({parent}, {});", js_string(&el.name)));
        self.fine_attrs(el, &var, true)?;
        let raw = std::mem::replace(&mut self.raw_text, matches!(&*el.name.to_ascii_lowercase(), "script" | "style"));
        let owner = self.owner.replace(var.clone());
        let r = self.fine_inline(&el.children, &var);
        self.owner = owner;
        self.raw_text = raw;
        r
    }

    /// `nodes` as one template clone appended to `parent`, with the bindings of its dynamic parts.
    fn fine_run(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        let mut kids = Vec::new();
        let mut parts = Vec::new();
        self.tpl_nodes(nodes, &[], self.raw_text, &mut kids, &mut parts)?;
        if kids.is_empty() {
            // Only `@attr:`s: no clone, they bind the owner.
            for (_, part) in &parts {
                let FinePart::ParentAttr(a) = part else { unreachable!("other parts have a node") };
                let owner = self.owner.clone().ok_or_else(|| format!("@attr:{} needs an enclosing element", &*a.name))?;
                self.fine_part(part, &owner)?;
            }
            return Ok(());
        }
        // One control-flow block alone: its anchors go straight in, with no template to clone.
        if parts.len() == 1 && kids.iter().all(|k| matches!(k, Tpl::Anchor)) {
            let part = &parts[0].1;
            if let FinePart::Region(node) = part
                && self.reads_only_pass(node)
            {
                return self.fine_flow(node, parent);
            }
            let var = self.fine_var();
            let call = if kids.len() == 2 { "anchors" } else { "anchor" };
            self.line(&format!("const {var} = fine.{call}({parent});"));
            return self.fine_part(part, &var);
        }
        let t = self.templates.len();
        self.templates.push(kids.iter().map(spec_js).collect::<Vec<_>>().join(", "));
        // A single element is cloned alone; anything else comes in a fragment, so anchors have a parent.
        let root = self.fine_var();
        let alone = kids.len() == 1 && matches!(kids[0], Tpl::El { .. });
        let cast = if alone { self.cast(&kids[0]) } else { String::new() };
        self.line(&format!("const {root} = __t{t}(){cast};"));
        let mut vars = vec![(if alone { vec![0] } else { vec![] }, root.clone())];
        // Every node a part binds gets its variable first: regions, lists and islands insert nodes.
        let mut targets = Vec::with_capacity(parts.len());
        for (path, part) in &parts {
            // A part's `@attr:`s set the element holding it: the run's own owner at its top level.
            let owner = |g: &mut Self, vars: &mut Vec<(Vec<usize>, String)>, up: &[usize]| match up {
                [] => g.owner.clone(),
                up => Some(g.fine_path(&kids, up, vars)),
            };
            let target = match part {
                FinePart::ParentAttr(a) => match owner(self, &mut vars, path) {
                    Some(var) => (var, None),
                    None => return Err(format!("@attr:{} needs an enclosing element", &*a.name)),
                },
                FinePart::Region(node) if has_parent_attr(std::slice::from_ref(*node)) => {
                    let var = self.fine_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                FinePart::Code(_, rest) if has_parent_attr(rest) => {
                    let var = self.fine_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                FinePart::List(Node::For { body, otherwise, .. }) if has_parent_attr(body) || otherwise.as_deref().is_some_and(has_parent_attr) => {
                    let var = self.fine_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                // Its `@attr:`s set the element it is appended to.
                FinePart::Flow(_) => {
                    let var = self.fine_path(&kids, path, &mut vars);
                    (var.clone(), Some(var))
                }
                _ => (self.fine_path(&kids, path, &mut vars), None),
            };
            targets.push(target);
        }
        for ((_, part), (var, owner)) in parts.iter().zip(&targets) {
            let outer = match owner {
                Some(o) => self.owner.replace(o.clone()),
                None => self.owner.clone(),
            };
            let r = self.fine_part(part, var);
            self.owner = outer;
            r?;
        }
        self.line(&format!("{parent}.appendChild({root});"));
        Ok(())
    }

    /// The template of `nodes` into `kids`, and their dynamic parts with the path of the node each binds.
    fn tpl_nodes<'n>(&self, nodes: &'n [Node], path: &[usize], raw: bool, kids: &mut Vec<Tpl>, parts: &mut Vec<(Vec<usize>, FinePart<'n>)>) -> Result<(), String> {
        let at = |kids: &Vec<Tpl>| [path, &[kids.len()]].concat();
        for (i, node) in nodes.iter().enumerate() {
            match node {
                Node::Code(code) if !is_plain_code(code) => {
                    parts.push((at(kids), FinePart::Island(&nodes[i..])));
                    kids.push(Tpl::Anchor);
                    return Ok(());
                }
                Node::Code(code) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), FinePart::Code(code, &nodes[i + 1..])));
                    kids.push(Tpl::Anchor);
                    return Ok(());
                }
                Node::Text(t) => kids.push(Tpl::Text(if raw { t.clone() } else { crate::entities::decode(t).into_owned() })),
                Node::Expr(e) => {
                    parts.push((at(kids), FinePart::Expr(e)));
                    kids.push(Tpl::Hole);
                }
                Node::Element(el) if &*el.name.text == "text" => self.tpl_nodes(&el.children, path, raw, kids, parts)?,
                Node::Element(el) if is_island(el) => {
                    parts.push((at(kids), FinePart::Island(std::slice::from_ref(node))));
                    kids.push(Tpl::Anchor);
                }
                Node::Element(el) => {
                    let here = at(kids);
                    let mut attrs = Vec::new();
                    let mut dynamic = false;
                    for a in &el.attrs {
                        let name = &*a.name.text;
                        match &a.value {
                            // Rows are keyed by their item; an element `@key` adds nothing.
                            _ if name == "@key" => {}
                            _ if name == "@leave" => attrs.push(("data-leave".to_string(), String::new())),
                            _ if name.starts_with('@') || name.starts_with("class:") => dynamic = true,
                            AttrValue::Empty => attrs.push((name.to_string(), String::new())),
                            AttrValue::Static(s) => attrs.push((name.to_string(), crate::entities::decode(s).into_owned())),
                            _ => dynamic = true,
                        }
                    }
                    if dynamic {
                        parts.push((here.clone(), FinePart::Element(el)));
                    }
                    let mut sub = Vec::new();
                    let raw = matches!(&*el.name.to_ascii_lowercase(), "script" | "style");
                    self.tpl_nodes(&el.children, &here, raw, &mut sub, parts)?;
                    kids.push(Tpl::El { tag: el.name.text.to_string(), attrs, kids: sub });
                }
                Node::For { head, .. } if for_of(head).is_some_and(|(b, _)| !b.starts_with(['[', '{'])) => {
                    parts.push((at(kids), FinePart::List(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::If { .. } | Node::Switch { .. } if self.reads_only_pass(node) => {
                    // Built once with its row: as an element's last child it appends to it, else it replaces an anchor.
                    if i + 1 == nodes.len() && !path.is_empty() {
                        parts.push((path.to_vec(), FinePart::Flow(node)));
                    } else {
                        parts.push((at(kids), FinePart::Region(node)));
                        kids.push(Tpl::Anchor);
                    }
                }
                // Destructured items (entries, tuples) are new on every run: keyed passes, not a list.
                // A keyed loop places its rows before its end: one anchor.
                Node::For { .. } | Node::While { .. } if keyable(node) => {
                    parts.push((at(kids), FinePart::Region(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), FinePart::Region(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::Slot(_) | Node::Cascade { .. } | Node::Routes { .. } => {
                    parts.push((at(kids), FinePart::Island(std::slice::from_ref(node))));
                    kids.push(Tpl::Anchor);
                }
                Node::SlotFill(_) => return Err("`@slot name { }` fills a slot and must be a direct child of a component tag".into()),
                Node::Await { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), FinePart::Await(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::Show(inner) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), FinePart::Show(inner)));
                    kids.push(Tpl::Anchor);
                }
                Node::Pause(None) => return Err("bare @pause goes first in a @show branch; use @pause { } for a part of it".into()),
                Node::Pause(Some(_)) if self.in_show == 0 => return Err("@pause belongs in a @show:if or @show:switch branch".into()),
                Node::Pause(Some(body)) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), FinePart::Pause(body)));
                    kids.push(Tpl::Anchor);
                }
                Node::ParentAttr(a) => parts.push((path.to_vec(), FinePart::ParentAttr(a))),
                Node::Once(body) => match body.as_slice() {
                    [Node::Expr(e)] => {
                        parts.push((at(kids), FinePart::OnceText(e)));
                        kids.push(Tpl::Hole);
                    }
                    _ => {
                        parts.push((at(kids), FinePart::Once(body)));
                        kids.push(Tpl::Anchor);
                    }
                },
            }
        }
        Ok(())
    }

    fn fine_var(&mut self) -> String {
        self.fine_ids += 1;
        format!("_e{}", self.fine_ids - 1)
    }

    fn cast(&mut self, node: &Tpl) -> String {
        match node {
            Tpl::El { tag, .. } => {
                self.uses_el = true;
                format!(" as El<{}>", js_string(tag))
            }
            Tpl::Hole => " as Text".into(),
            Tpl::Anchor => " as Comment".into(),
            Tpl::Text(_) => String::new(),
        }
    }

    /// The variable of the node at `path` of a clone, declared (with its ancestors) on first use: reached from
    /// the nearest declared sibling before it, else from its parent's first child.
    fn fine_path(&mut self, kids: &[Tpl], path: &[usize], vars: &mut Vec<(Vec<usize>, String)>) -> String {
        if let Some((_, v)) = vars.iter().find(|(p, _)| p == path) {
            return v.clone();
        }
        let (&last, up) = path.split_last().expect("the root has a variable");
        let parent = self.fine_path(kids, up, vars);
        let before = vars.iter().filter(|(p, _)| p.len() == path.len() && p[..up.len()] == *up && p[up.len()] < last).max_by_key(|(p, _)| p[up.len()]);
        let expr = match before {
            Some((p, v)) => format!("{v}{}", ".nextSibling!".repeat(last - p[up.len()])),
            None => format!("{parent}.firstChild!{}", ".nextSibling!".repeat(last)),
        };
        let mut node = &kids[path[0]];
        for &i in &path[1..] {
            let Tpl::El { kids, .. } = node else { unreachable!("only elements have children") };
            node = &kids[i];
        }
        let var = self.fine_var();
        let cast = self.cast(node);
        self.line(&format!("const {var} = {expr}{cast};"));
        vars.push((path.to_vec(), var.clone()));
        var
    }

    fn fine_part(&mut self, part: &FinePart, var: &str) -> Result<(), String> {
        match *part {
            FinePart::Expr(e) => {
                let read = self.expr(e);
                self.fine_bound("text", var, read);
            }
            FinePart::Element(el) => self.fine_attrs(el, var, false)?,
            FinePart::Region(node) if self.reads_only_pass(node) => {
                // Its pass's values keep the row only while they are the same: a region would add nothing.
                let f = self.fine_var();
                self.line(&format!("const {f} = document.createDocumentFragment();"));
                self.fine_flow(node, &f)?;
                self.line(&format!("{var}.replaceWith({f});"));
            }
            FinePart::Region(node) if keyable(node) => self.fine_keyed(node, var)?,
            FinePart::Region(node) if !self.row_level() && branchable(node) => {
                self.line(&format!("fine.branchAt({var}, (__p) => {{"));
                let outer = std::mem::replace(&mut self.in_region, true);
                let pass = self.pass_locals.take();
                self.depth += 1;
                self.branching = true;
                let r = self.fine_flow(node, "__p");
                self.depth -= 1;
                self.pass_locals = pass;
                self.in_region = outer;
                r?;
                self.line("});");
            }
            FinePart::Region(node) if branchable(node) => self.fine_region(var, true, |g| {
                g.branching = true;
                g.fine_flow(node, "__p")
            })?,
            FinePart::Region(node) => self.fine_region(var, false, |g| g.fine_flow(node, "__p"))?,
            FinePart::Code(code, rest) => {
                let scope = self.locals.len();
                let r = self.fine_region(var, false, |g| {
                    let block = g.fine_code_block(code)?;
                    g.emit_block(block);
                    g.fine_nodes(rest, "__p")
                });
                self.locals.truncate(scope);
                r?;
            }
            FinePart::List(node) => self.fine_list(node, var)?,
            FinePart::Await(node) => self.fine_await(node, var)?,
            FinePart::Show(node) => {
                let node = show_branches(node)?;
                self.line(&format!("fine.showAt({var}, (__p) => {{"));
                let outer = std::mem::replace(&mut self.in_region, true);
                let pass = self.pass_locals.take();
                self.depth += 1;
                self.in_show += 1;
                self.branching = true;
                let r = self.fine_flow(&node, "__p");
                self.in_show -= 1;
                self.depth -= 1;
                self.pass_locals = pass;
                self.in_region = outer;
                r?;
                self.line("});");
            }
            FinePart::Pause(body) => {
                self.line(&format!("fine.pauseAt({var}, (__p) => {{"));
                let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
                let pass = self.pass_locals.take();
                let r = self.fine_block(body, "__p");
                self.pass_locals = pass;
                (self.in_region, self.in_loop) = flags;
                r?;
                self.line("});");
            }
            FinePart::Flow(node) => self.fine_flow(node, var)?,
            FinePart::OnceText(e) => {
                let read = self.expr(e);
                self.emit(M::lit(&format!("fine.textOnce({var}, () => ")).add(read).lit_then(");"));
            }
            FinePart::Once(body) => {
                self.line(&format!("fine.onceAt({var}, (__p) => {{"));
                // Plain control flow, and values set rather than bound.
                let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, true), std::mem::replace(&mut self.once, true));
                let pass = self.pass_locals.take();
                let r = self.fine_block(body, "__p");
                self.pass_locals = pass;
                (self.in_region, self.in_loop, self.once) = flags;
                r?;
                self.line("});");
            }
            FinePart::ParentAttr(a) => {
                let read = self.value(&a.value);
                self.emit(M::lit(&format!("fine.attrOf({var}, {}, () => ", js_string(&a.name))).add(read).lit_then(");"));
            }
            // Virtual-DOM builder calls, in a binding that patches them when what they read changes.
            FinePart::Island(nodes) => {
                let body = self.inline_nodes(nodes, true, &[])?;
                self.emit(M::lit(&format!("fine.islandAt({var}, (__b) => {{ ")).add(body).lit_then(" });"));
            }
        }
        Ok(())
    }

    /// Whether bindings go through the shared reads of the list whose row is being emitted.
    fn row_level(&self) -> bool {
        !self.in_region && self.reads.is_some()
    }

    /// Adds `(item) => body` to the row's shared reads; `rest` follows the item (more parameters, or a
    /// return type). Its index.
    fn push_read(&mut self, rest: &str, body: M) -> usize {
        let reads = self.reads.as_mut().expect("in a row");
        let param = if mentions(&body.text, &reads.name) { reads.param.clone() } else { "_".into() };
        reads.list.push(M::lit(&format!("({param}{rest}) => ")).add(body));
        reads.list.len() - 1
    }

    /// A text (`call` "text") or attribute ("attr", `args` naming it too) binding to `read`.
    fn fine_bound(&mut self, call: &str, args: &str, read: M) {
        if self.once {
            let call = if call == "text" { "setText" } else { "set" };
            self.emit(M::lit(&format!("fine.{call}({args}, ")).add(read).lit_then(");"));
        } else if self.row_level() {
            let i = self.push_read("", read);
            self.line(&format!("fine.{call}Item({args}, {i});"));
        } else {
            let call = if call == "text" { "textAt" } else { call };
            self.emit(M::lit(&format!("fine.{call}({args}, () => ")).add(read).lit_then(");"));
        }
    }

    fn fine_on(&mut self, var: &str, event: &str, handler: M) {
        if self.row_level() {
            // The return type types the handler's event, as `fine.on` does.
            let i = self.push_read("): ((e: any) => unknown", handler);
            self.line(&format!("fine.onItem({var}, {}, {i});", js_string(event)));
        } else {
            self.emit(M::lit(&format!("fine.on({var}, {}, ", js_string(event))).add(handler).lit_then(");"));
        }
    }

    /// A region before comment `end` (after the comment before it), whose `body` is plain control flow; with
    /// `branch`, an `@if`/`@switch` emitted for `branchAt`/`branchItem`.
    fn fine_region(&mut self, end: &str, branch: bool, body: impl FnOnce(&mut Self) -> Result<(), String>) -> Result<(), String> {
        let row = self.row_level();
        let outer = std::mem::replace(&mut self.in_region, true);
        // A region is its own binding: its conditions are tracked, whatever they read.
        let pass = self.pass_locals.take();
        self.depth += 1;
        let code = self.capture(body);
        self.depth -= 1;
        self.pass_locals = pass;
        self.in_region = outer;
        let code = code?;
        // A region setting the row's element by `@attr:` closes over it: it builds in the row.
        let row = row && !self.owner.as_ref().is_some_and(|o| mentions(&code.text, o));
        if row {
            let close = format!("{}}}", "  ".repeat(self.depth));
            let i = self.push_read(", __p", M::lit("{\n").add(code).lit_then(&close));
            self.line(&format!("fine.{}({end}, {i});", if branch { "branchItem" } else { "regionItem" }));
        } else {
            self.line(&format!("fine.{}({end}, (__p) => {{", if branch { "branchAt" } else { "regionAt" }));
            self.splice(code);
            self.line("});");
        }
        Ok(())
    }

    /// `@for (const item of items)` before comment `end`: its rows' bindings share the reads it collects.
    fn fine_list(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let Node::For { head, key, body, otherwise } = node else { unreachable!("a list is a for") };
        let (binding, source) = for_of(head).expect("a list is a for...of");
        let scope = self.locals.len();
        self.locals.extend(loop_locals(head));
        let items = self.expr(&source);
        let name = binding.split(':').next().unwrap_or_default().trim().to_string();
        // `@key(expr)`, else the `@Key("member")` of the field the items come from.
        let key = match key {
            Some(k) => Some(self.expr(k)),
            None => self.field_key(&source).map(|member| M::lit(&format!("{name}.{member}"))),
        }
        .map(|k| M::lit("(").add(M::src(&binding, binding.at)).lit_then(") => ").add(k));
        let outer = self.reads.replace(Reads { param: binding.text.clone(), name, list: Vec::new() });
        // Rows share the list's reads even when the list sits in a region.
        let in_region = std::mem::replace(&mut self.in_region, false);
        let pass = self.pass_locals.take();
        let row = self.capture(|g| g.fine_block(body, "__p"));
        self.pass_locals = pass;
        self.in_region = in_region;
        let reads = std::mem::replace(&mut self.reads, outer).expect("set above");
        self.locals.truncate(scope);
        let row = row?;
        // The else builds like a region: its bindings close over their values.
        let empty = match otherwise {
            Some(body) => {
                let in_region = std::mem::replace(&mut self.in_region, true);
                let empty = self.capture(|g| g.fine_block(body, "__p"));
                self.in_region = in_region;
                Some(empty?)
            }
            None => None,
        };
        self.emit(M::lit(&format!("fine.listAt({end}, () => ")).add(items).lit_then(", ["));
        self.depth += 1;
        for read in reads.list {
            self.emit(read.lit_then(","));
        }
        self.depth -= 1;
        let item = if mentions(&row.text, &reads.name) { M::lit(", ").add(M::src(&binding, binding.at)) } else { M::default() };
        self.emit(M::lit("], (__p").add(item).lit_then(") => {"));
        self.splice(row);
        let has_empty = empty.is_some();
        if let Some(empty) = empty {
            self.line("}, (__p) => {");
            self.splice(empty);
        }
        match key {
            Some(key) => self.emit(M::lit(if has_empty { "}, " } else { "}, undefined, " }).add(key).lit_then(");")),
            None => self.line("});"),
        }
        Ok(())
    }

    /// The `@Key("member")` of the field `items` iterates, directly or through array methods that keep its items.
    fn field_key(&self, items: &str) -> Option<String> {
        const KEEPING: &[&str] = &["filter(", "slice(", "sort(", "toSorted(", "toReversed(", "reverse("];
        let items = items.strip_prefix("this.").unwrap_or(items);
        let root = items.find(|c: char| !c.is_ascii() || !is_ident_char(c as u8)).map_or(items, |i| &items[..i]);
        let rest = &items[root.len()..];
        if self.locals.iter().any(|l| l == root) || !(rest.is_empty() || rest.strip_prefix('.').is_some_and(|r| KEEPING.iter().any(|m| r.starts_with(m)))) {
            return None;
        }
        self.list_keys.get(root).cloned()
    }

    /// Whether `node` is an `@if`/`@switch` of a keyed pass's row whose conditions read only the pass's values.
    fn reads_only_pass(&self, node: &Node) -> bool {
        let Some(locals) = &self.pass_locals else { return false };
        let only = |e: &Src| {
            let ok = std::cell::Cell::new(true);
            rewrite(e, &|w| {
                ok.set(ok.get() && (locals.iter().any(|l| l == w) || matches!(w, "true" | "false" | "null" | "undefined")));
                false
            });
            // Members, indexes and calls can read what changes while the pass's values stay the same.
            ok.get() && !e.contains("this") && !e.contains(['.', '[', '('])
        };
        match node {
            Node::If { branches, .. } => branches.iter().all(|(c, _)| only(c)),
            Node::Switch { subject, cases } => only(subject) && cases.iter().flat_map(|c| &c.labels).flatten().all(only),
            _ => false,
        }
    }

    /// A `@for`/`@while` that is not a plain list, run in place: each pass keeps its row by key (`@key`, else a
    /// pass counter) while it sees the same loop variables. Its body is a region per pass.
    fn fine_keyed(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let (key, body, otherwise, locals) = match node {
            Node::For { head, key, body, otherwise } => (key, body, otherwise, loop_locals(head)),
            Node::While { key, body, otherwise, .. } => (key, body, otherwise, Vec::new()),
            _ => unreachable!("only loops are keyed"),
        };
        self.line(&format!("fine.keyedAt({end}, (__pass) => {{"));
        self.depth += 1;
        if key.is_none() {
            self.line("let __i = 0;");
        }
        let scope = self.locals.len();
        self.locals.extend(locals.iter().cloned());
        let lead = match node {
            Node::For { head, .. } => M::lit("for (").add(self.expr(head)),
            Node::While { cond, .. } => M::lit("while (").add(self.expr(cond)),
            _ => unreachable!("only loops are keyed"),
        };
        self.emit(lead.lit_then(") {"));
        self.depth += 1;
        let key = key.as_ref().map_or_else(|| M::lit("__i++"), |k| self.expr(k));
        // A kept pass skips its body: `__pass` returns where to build only for a new row.
        self.emit(M::lit("const __p = __pass(").add(key).lit_then(&format!(", [{}]);", locals.join(", "))));
        self.line("if (__p !== undefined) {");
        let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
        let outer_pass = self.pass_locals.replace(locals.clone());
        let r = self.fine_block(body, "__p");
        self.pass_locals = outer_pass;
        self.locals.truncate(scope);
        let r = r.and_then(|()| {
            self.line("}");
            self.depth -= 1;
            self.line("}");
            self.depth -= 1;
            match otherwise {
                Some(body) => {
                    self.line("}, (__p) => {");
                    self.fine_block(body, "__p")?;
                    self.line("});");
                }
                None => self.line("});"),
            }
            Ok(())
        });
        (self.in_region, self.in_loop) = flags;
        r
    }

    /// `@await` before comment `end`: the promise as a read, and each arm a region body taking its value.
    fn fine_await(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let Node::Await { promise, pending, then, catch } = node else { unreachable!("an @await") };
        let head = match call_parts(&promise.text) {
            // Its arguments are a binding of their own: the call runs again only when one of them changes.
            Some((callee, args)) => {
                let part = |(a, b): (usize, usize)| Src::new(&promise.text[a..b], if promise.at == Src::UNMAPPED { Src::UNMAPPED } else { promise.at + a });
                let params = (0..args.len()).map(|i| format!("__a{i}")).collect::<Vec<_>>().join(", ");
                let mut m = M::lit(&format!("fine.awaitCallAt({end}, () => ["));
                for (i, &range) in args.iter().enumerate() {
                    if i > 0 {
                        m = m.lit_then(", ");
                    }
                    m = m.add(self.expr(&part(range)));
                }
                m.lit_then(&format!("], ({params}) => ")).add(self.expr(&part(callee))).lit_then(&format!("({params}), (__p) => {{"))
            }
            None => M::lit(&format!("fine.awaitAt({end}, () => ")).add(self.expr(promise)).lit_then(", (__p) => {"),
        };
        self.emit(head);
        let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
        let pass = self.pass_locals.take();
        let r = (|| {
            self.fine_block(pending, "__p")?;
            // Whether an arm's function body is open, to be closed by what comes next.
            let mut open = true;
            for arm in [then, catch] {
                let close = if open { "}, " } else { ", " };
                let Some((name, body)) = arm else {
                    self.line(&format!("{close}undefined"));
                    open = false;
                    continue;
                };
                let scope = self.locals.len();
                let head = match name {
                    Some(n) => {
                        self.locals.push(n.text.clone());
                        M::lit(&format!("{close}(__p, ")).add(M::src(n, n.at)).lit_then(") => {")
                    }
                    None => M::lit(&format!("{close}(__p) => {{")),
                };
                self.emit(head);
                let r = self.fine_block(body, "__p");
                self.locals.truncate(scope);
                r?;
                open = true;
            }
            self.line(if open { "});" } else { ");" });
            Ok(())
        })();
        self.pass_locals = pass;
        (self.in_region, self.in_loop) = flags;
        r
    }

    /// 
    /// What `body` emits, taken out of the output.
    fn capture(&mut self, body: impl FnOnce(&mut Self) -> Result<(), String>) -> Result<M, String> {
        let out = std::mem::take(&mut self.out);
        let maps = std::mem::take(&mut self.mappings);
        let r = body(self);
        let text = std::mem::replace(&mut self.out, out);
        let maps = std::mem::replace(&mut self.mappings, maps);
        r.map(|()| M { text, maps })
    }

    /// Puts back captured lines as they are.
    fn splice(&mut self, m: M) {
        let base = self.out.len();
        self.mappings.extend(m.maps.into_iter().map(|x| Mapping { out: x.out + base, ..x }));
        self.out.push_str(&m.text);
    }

    /// The statements of a `@{ }` block; its declarations become locals of the enclosing scope.
    fn fine_code_block(&mut self, parts: &[CodePart]) -> Result<M, String> {
        let mut block = M::default();
        for part in parts {
            match part {
                CodePart::Ts(s) => {
                    self.locals.extend(declared_names(s));
                    block = block.add(self.expr(s));
                }
                _ => return Err("@fine components cannot hold markup inside @{ } yet".into()),
            }
        }
        Ok(block)
    }

    /// A branch of a control-flow statement, with its own scope for locals.
    fn fine_block(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        self.depth += 1;
        let scope = self.locals.len();
        let r = self.fine_nodes(nodes, parent);
        self.locals.truncate(scope);
        self.depth -= 1;
        r
    }

    /// Structure as plain control flow, inside a region.
    fn fine_flow(&mut self, node: &Node, p: &str) -> Result<(), String> {
        let branching = std::mem::take(&mut self.branching);
        let pick = |g: &mut Self, i: usize| {
            if branching {
                g.depth += 1;
                g.line(&format!("if (!{p}) return {i};"));
                g.depth -= 1;
            }
        };
        match node {
            Node::If { branches, otherwise } => {
                for (i, (cond, body)) in branches.iter().enumerate() {
                    let kw = if i == 0 { "if (" } else { "} else if (" };
                    let line = M::lit(kw).add(self.expr(cond)).lit_then(") {");
                    self.emit(line);
                    pick(self, i);
                    self.fine_block(body, p)?;
                }
                if let Some(body) = otherwise {
                    self.line("} else {");
                    pick(self, branches.len());
                    self.fine_block(body, p)?;
                }
                self.line("}");
                if branching {
                    self.line(&format!("return {};", branches.len() + usize::from(otherwise.is_some())));
                }
            }
            Node::For { head, body, otherwise, .. } => {
                if otherwise.is_some() {
                    self.open_none();
                }
                let scope = self.locals.len();
                self.locals.extend(loop_locals(head));
                let line = M::lit("for (").add(self.expr(head)).lit_then(") {");
                self.emit(line);
                if otherwise.is_some() {
                    self.mark_pass();
                }
                let in_loop = std::mem::replace(&mut self.in_loop, true);
                let r = self.fine_block(body, p);
                self.in_loop = in_loop;
                self.locals.truncate(scope);
                r?;
                self.line("}");
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.fine_block(body, p)?;
                    self.close_none();
                }
            }
            Node::While { cond, body, otherwise, .. } => {
                if otherwise.is_some() {
                    self.open_none();
                }
                let line = M::lit("while (").add(self.expr(cond)).lit_then(") {");
                self.emit(line);
                if otherwise.is_some() {
                    self.mark_pass();
                }
                let in_loop = std::mem::replace(&mut self.in_loop, true);
                let r = self.fine_block(body, p);
                self.in_loop = in_loop;
                r?;
                self.line("}");
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.fine_block(body, p)?;
                    self.close_none();
                }
            }
            Node::Switch { subject, cases } => {
                let line = M::lit("switch (").add(self.expr(subject)).lit_then(") {");
                self.emit(line);
                self.depth += 1;
                for (n, case) in cases.iter().enumerate() {
                    let count = case.labels.len();
                    for (i, label) in case.labels.iter().enumerate() {
                        let label = match label {
                            Some(e) => M::lit("case ").add(self.expr(e)),
                            None => M::lit("default"),
                        };
                        self.emit(label.lit_then(if i + 1 == count { ": {" } else { ":" }));
                    }
                    pick(self, n);
                    self.fine_block(&case.body, p)?;
                    self.depth += 1;
                    self.line("break;");
                    self.depth -= 1;
                    self.line("}");
                }
                self.depth -= 1;
                self.line("}");
                if branching {
                    self.line(&format!("return {};", cases.len()));
                }
            }
            _ => unreachable!("only structure is control flow"),
        }
        Ok(())
    }

    /// The attributes of `el` (in `var`) that need code: bindings, handlers, `@ref`; the static ones with `all`.
    fn fine_attrs(&mut self, el: &Element, var: &str, all: bool) -> Result<(), String> {
        let directive = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n).map(|a| &a.value);
        for a in &el.attrs {
            let name = &*a.name.text;
            match name {
                name @ ("@bind" | "@bind:input") => self.fine_bind(el, var, a, bind_event(name, directive("@bind:event"))?, directive("@bind:after"))?,
                "@bind:event" | "@bind:after" | "@bind:debounce" | "@key" => {}
                "@leave" if all => self.line(&format!("{var}.setAttribute(\"data-leave\", \"\");")),
                "@leave" => {}
                "@ref" => {
                    let line = self.directive_expr(a)?.lit_then(&format!(" = {var};"));
                    self.emit(line);
                }
                _ if name.starts_with("@on") => {
                    let AttrValue::Expr(e) = &a.value else { return Err(format!("{name} requires a handler expression")) };
                    let handler = self.handler(e);
                    self.fine_on(var, &name[3..], handler);
                }
                _ if name.starts_with('@') => return Err(format!("unknown directive attribute {name}")),
                _ if name.starts_with("class:") => {
                    let on = match &a.value {
                        AttrValue::Empty => M::lit("true"),
                        v => self.value(v),
                    };
                    self.fine_bound("attr", &format!("{var}, {}", js_string(name)), on);
                }
                _ => match &a.value {
                    AttrValue::Empty if all => self.line(&format!("{var}.setAttribute({}, \"\");", js_string(name))),
                    AttrValue::Static(s) if all => {
                        let value = js_string(&crate::entities::decode(s));
                        self.line(&format!("{var}.setAttribute({}, {value});", js_string(name)));
                    }
                    AttrValue::Empty | AttrValue::Static(_) => {}
                    v => {
                        let read = self.value(v);
                        self.fine_bound("attr", &format!("{var}, {}", js_string(name)), read);
                    }
                },
            }
        }
        Ok(())
    }

    /// `@bind`: an attribute binding plus a listener that writes the field back.
    fn fine_bind(&mut self, el: &Element, var: &str, a: &Attr, event: String, after: Option<&AttrValue>) -> Result<(), String> {
        let AttrValue::Expr(target) = &a.value else { return Err("@bind requires an expression".into()) };
        let is_check = el.attrs.iter().any(|x| {
            &*x.name.text == "type" && matches!(&x.value, AttrValue::Static(s) if matches!(&*s.text, "checkbox" | "radio"))
        });
        let prop = if is_check { "checked" } else { "value" };
        let read = self.expr(target);
        self.fine_bound("attr", &format!("{var}, \"{prop}\""), read);
        let handler = self.bind_handler(el, target, after)?;
        self.fine_on(var, &event, handler);
        Ok(())
    }

    /// The handler writing a bound input back: at once, or after a `@bind:debounce` pause.
    fn bind_handler(&self, el: &Element, target: &Src, after: Option<&AttrValue>) -> Result<M, String> {
        let write = self.expr(target).lit_then(" = ComponentBase.bindValue(__e, ").add(self.expr(target)).lit_then(");").add(self.after_call(after)?);
        let debounce = el.attrs.iter().find(|a| &*a.name.text == "@bind:debounce").map(|a| match &a.value {
            AttrValue::Expr(ms) | AttrValue::Static(ms) if !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) => Ok(ms.text.clone()),
            _ => Err("@bind:debounce requires milliseconds, e.g. @bind:debounce=\"300\"".to_string()),
        });
        Ok(match debounce.transpose()? {
            Some(ms) => M::lit(&format!("(__e) => ComponentBase.debounce(__e, {ms}, () => {{ ")).add(write).lit_then(" })"),
            None => M::lit("(__e) => { ").add(write).lit_then(" }"),
        })
    }

    /// Statement calling a `@bind:after` handler, returned so async work re-renders.
    fn after_call(&self, after: Option<&AttrValue>) -> Result<M, String> {
        match after {
            None => Ok(M::default()),
            Some(AttrValue::Expr(e)) if is_identifier(e) && self.is_member(e) => {
                Ok(M::lit(" return ").lit_then(self.member_prefix(e).unwrap_or("this.")).add(M::src(e, e.at)).lit_then("();"))
            }
            Some(AttrValue::Expr(e)) => Ok(M::lit(" return (").add(self.expr(e)).lit_then(")();")),
            Some(_) => Err("@bind:after requires a handler".into()),
        }
    }

    /// `@bind="x"` on an element: a value (or checked) attribute plus a change handler.
    fn bind_element(&mut self, el: &Element, a: &Attr, event: String, after: Option<&AttrValue>) -> Result<(), String> {
        let AttrValue::Expr(target) = &a.value else { return Err("@bind requires an expression".into()) };
        let is_check = el.attrs.iter().any(|x| {
            &*x.name.text == "type" && matches!(&x.value, AttrValue::Static(s) if matches!(&*s.text, "checkbox" | "radio"))
        });
        let prop = if is_check { "checked" } else { "value" };
        self.emit(M::lit(&format!("__b.addAttribute(\"{prop}\", ")).add(self.expr(target)).lit_then(");"));
        let line = M::lit(&format!("__b.addEventHandler({}, ", js_string(&event))).add(self.bind_handler(el, target, after)?).lit_then(");");
        self.emit(line);
        Ok(())
    }

    /// The expression value of a directive attribute like `@key="x"`.
    fn directive_expr(&self, a: &Attr) -> Result<M, String> {
        match &a.value {
            AttrValue::Expr(e) => Ok(self.expr(e)),
            _ => Err(format!("{} requires an expression", a.name)),
        }
    }

    fn attribute(&mut self, a: &Attr) -> Result<(), String> {
        if &*a.name.text == "@attributes" {
            let line = M::lit("__b.addAttributes(").add(self.directive_expr(a)?).lit_then(");");
            self.emit(line);
            return Ok(());
        }
        if let Some((event, modifier)) = a.name.strip_prefix("@on").and_then(|r| r.split_once(':')) {
            if !matches!(modifier, "preventDefault" | "stopPropagation") {
                return Err(format!("unknown event modifier {}", a.name));
            }
            let enabled = match &a.value {
                AttrValue::Empty => M::lit("true"),
                AttrValue::Expr(e) => self.expr(e),
                _ => return Err(format!("{} takes a boolean expression", a.name)),
            };
            let line = M::lit(&format!("__b.addEventModifier({}, {}, ", js_string(event), js_string(modifier)))
                .add(enabled)
                .lit_then(");");
            self.emit(line);
            return Ok(());
        }
        if let Some(event) = a.name.strip_prefix("@on") {
            let AttrValue::Expr(e) = &a.value else {
                return Err(format!("{} requires a handler expression", a.name));
            };
            let handler = self.handler(e);
            let line = M::lit(&format!("__b.addEventHandler({}, ", js_string(event))).add(handler).lit_then(");");
            self.emit(line);
        } else if a.name.starts_with('@') {
            return Err(format!("unknown directive attribute {}", a.name));
        } else {
            let line = M::lit(&format!("__b.addAttribute({}, ", js_string(&a.name))).add(self.value(&a.value)).lit_then(");");
            self.emit(line);
        }
        Ok(())
    }

    fn component(&mut self, el: &Element) -> Result<(), String> {
        let empty = ComponentInfo::default();
        let info = self.components.get(&*el.name.text).unwrap_or(&empty);
        let attr = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n);

        // Generic components take their type arguments as attributes (Blazor's `TItem="..."`).
        let type_names: Vec<&str> = info.type_params.iter().map(String::as_str).collect();
        let mut name = if info.lazy { M::lit("__lazy_").add(M::src(&el.name, el.name.at)) } else { M::src(&el.name, el.name.at) };
        let infer = !type_names.is_empty() && !type_names.iter().all(|t| attr(t).is_some());
        if !type_names.is_empty() && !infer {
            name = name.lit_then("<");
            for (i, t) in type_names.iter().enumerate() {
                let arg = match &attr(t).expect("checked above").value {
                    AttrValue::Static(s) if s.at != Src::UNMAPPED => M::src(s, s.at),
                    AttrValue::Static(s) => M::lit(s),
                    AttrValue::Expr(e) => M::src(e, e.at),
                    _ => return Err(format!("<{}>: type argument {t} must be a type", el.name)),
                };
                name = name.lit_then(if i == 0 { "" } else { ", " }).add(arg);
            }
            name = name.lit_then(">");
        }

        let mut props: Vec<M> = Vec::new();
        let mut extra: Vec<M> = Vec::new();
        for a in &el.attrs {
            if type_names.contains(&&*a.name.text) {
                continue;
            }
            match &*a.name.text {
                "@key" => {
                    extra.push(M::lit("key: ").add(self.directive_expr(a)?));
                    continue;
                }
                "@ref" => {
                    extra.push(M::lit("ref: (__c) => { ").add(self.directive_expr(a)?).lit_then(" = __c; }"));
                    continue;
                }
                "@attributes" => {
                    props.push(M::lit("...").add(self.directive_expr(a)?));
                    continue;
                }
                _ => {}
            }
            if let Some(bound) = a.name.strip_prefix("@bind-") {
                if bound.contains(':') {
                    continue;
                }
                let AttrValue::Expr(target) = &a.value else { return Err(format!("{} requires an expression", a.name)) };
                let after = attr(&format!("{}:after", a.name)).map(|x| &x.value);
                props.push(M::lit(&format!("{bound}: ")).add(self.expr(target)));
                props.push(
                    M::lit(&format!("{bound}Changed: __b.callback((__v) => {{ "))
                        .add(self.expr(target))
                        .lit_then(" = __v;")
                        .add(self.after_call(after)?)
                        .lit_then(" })"),
                );
                continue;
            }
            // `@onclick` on a component sets its `onClick` EventCallback, like on an element.
            let event_prop = match a.name.strip_prefix('@').filter(|n| n.starts_with("on") && !n.contains(':')) {
                Some(event) => Some(
                    info.props
                        .iter()
                        .find(|(p, k)| **k == PropKind::Callback && p.eq_ignore_ascii_case(event))
                        .map(|(p, _)| p.as_str())
                        .ok_or_else(|| format!("<{}> has no EventCallback prop for {}", el.name, a.name))?,
                ),
                None => None,
            };
            if a.name.starts_with('@') && event_prop.is_none() {
                return Err(format!("<{}>: directive attribute {} is not supported on components", el.name, a.name));
            }
            let key = match event_prop {
                Some(p) => M::lit(p),
                None if is_identifier(&a.name) => M::src(&a.name, a.name.at),
                None => M::lit(&js_string(&a.name)),
            };
            let kind = info.props.get(event_prop.unwrap_or(&a.name)).copied().unwrap_or(PropKind::Text);
            let code = match &a.value {
                AttrValue::Static(s) if s.trim().is_empty() => None,
                AttrValue::Static(s) if s.at != Src::UNMAPPED => Some(s.clone()),
                AttrValue::Expr(e) => Some(e.clone()),
                _ => None,
            };
            let value = match (kind, code) {
                (PropKind::Callback, Some(e)) => M::lit("__b.callback(").add(self.handler(&e)).lit_then(")"),
                // Hoisted, a string literal would widen to `string` and fail a literal-typed prop's inference.
                (PropKind::Text, _) | (_, None) if infer && matches!(a.value, AttrValue::Static(_)) => self.value(&a.value).lit_then(" as const"),
                (PropKind::Text, _) | (_, None) => self.value(&a.value),
                (_, Some(e)) => self.expr(&e),
            };
            props.push(key.lit_then(": ").add(value));
        }

        // Explicit `@slot` fills, plus any other content as the default slot.
        let mut fills: Vec<(String, M)> = Vec::new();
        let mut loose: Vec<Node> = Vec::new();
        for child in &el.children {
            match child {
                Node::SlotFill(f) => {
                    let key = f.name.as_ref().map_or("default", |n| &**n).to_string();
                    if fills.iter().any(|(k, _)| *k == key) {
                        return Err(format!("<{}>: slot `{key}` is filled twice", el.name));
                    }
                    let name = f.name.as_ref().map_or_else(|| M::lit("default"), |n| M::src(n, n.at));
                    fills.push((key, name.lit_then(": ").add(self.slot_lambda(f.params.as_ref(), &f.body)?)));
                }
                Node::Text(t) if t.trim().is_empty() => {}
                other => loose.push(other.clone()),
            }
        }
        if !loose.is_empty() {
            if fills.iter().any(|(k, _)| k == "default") {
                return Err(format!("<{}>: slot `default` is filled twice (by `@slot {{ }}` and by content outside any @slot)", el.name));
            }
            fills.push(("default".into(), M::lit("default: ").add(self.slot_lambda(None, &loose)?)));
        }

        let empty_props = props.is_empty();
        let mut object = M::lit("{");
        for (i, p) in props.into_iter().enumerate() {
            object = object.lit_then(if i == 0 { " " } else { ", " }).add(p);
        }
        let object = object.lit_then(if empty_props { "}" } else { " }" });
        let mut line = M::lit("__b.addComponent(");
        if infer {
            // Hoisted so each type parameter is inferred from the props (`addComponent` alone infers the base class).
            let id = self.props_ids.get();
            self.props_ids.set(id + 1);
            let var = format!("__p{id}");
            self.emit(M::lit(&format!("const {var} = ")).add(object).lit_then(";"));
            let infers = type_names.iter().map(|n| format!("infer {n}")).collect::<Vec<_>>().join(", ");
            let args: Vec<String> = type_names
                .iter()
                .map(|t| format!("typeof {var} extends Partial<{}<{infers}>> ? {t} : unknown", &*el.name.text))
                .collect();
            line = line.add(name).lit_then(&format!("<{}>, {var}", args.join(", ")));
        } else {
            line = line.add(name).lit_then(", ").add(object);
        }
        if !fills.is_empty() {
            line = line.lit_then(", {");
            for (i, (_, fill)) in fills.into_iter().enumerate() {
                line = line.lit_then(if i == 0 { " " } else { ", " }).add(fill);
            }
            line = line.lit_then(" }");
        } else if !extra.is_empty() {
            line = line.lit_then(", undefined");
        }
        if !extra.is_empty() {
            line = line.lit_then(", {");
            for (i, x) in extra.into_iter().enumerate() {
                line = line.lit_then(if i == 0 { " " } else { ", " }).add(x);
            }
            line = line.lit_then(" }");
        }
        self.emit(line.lit_then(");"));
        Ok(())
    }
}

pub fn rewrite(src: &str, is_member: &dyn Fn(&str) -> bool) -> String {
    rewrite_tracked(src, &|w| is_member(w).then_some("this."), &mut Vec::new(), 0)
}

/// Prefixes free identifiers that name `@code` members with what `prefix` returns (`this.`), so templates
/// can write `@count` instead of `@this.count` (Razor gets this for free from C# scoping).
/// Records the source offset (plus `base`) and prefix length of every insertion in `inserts`.
fn rewrite_tracked<'a>(src: &str, prefix: &dyn Fn(&str) -> Option<&'a str>, inserts: &mut Vec<(usize, usize)>, base: usize) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len() + 16);
    let mut prev: Option<u8> = None;
    // Open brackets, to tell `{ a, b }` (shorthand properties) from `[a, b]` and `f(a, b)`.
    let mut open: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // `#name` alone can only be one of our private members; `x.#name` and `#name in x` stay as written.
        if c == b'#' && b.get(i + 1).is_some_and(|&n| is_ident_start(n)) {
            let start = i;
            i += 1;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            let word = &src[start..i];
            let rest = src[i..].trim_start();
            let brand_check = rest.starts_with("in") && !rest.as_bytes().get(2).is_some_and(|&n| is_ident_char(n));
            if let Some(p) = prefix(word).filter(|_| prev != Some(b'.') && !brand_check) {
                inserts.push((base + start, p.len()));
                out.push_str(p);
            }
            out.push_str(word);
            prev = Some(b'a');
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            let word = &src[start..i];
            let next = b[i..].iter().copied().find(|c| !c.is_ascii_whitespace());
            let is_property = prev == Some(b'.') && !src[..start].trim_end().ends_with("...");
            let in_object = open.last() == Some(&b'{') && matches!(prev, Some(b'{' | b','));
            let is_object_key = next == Some(b':') && in_object;
            let is_shorthand = in_object && matches!(next, Some(b',' | b'}'));
            if let Some(p) = prefix(word).filter(|_| !is_property && !is_object_key) {
                let p = if is_shorthand { format!("{word}: {p}") } else { p.to_string() };
                inserts.push((base + start, p.len()));
                out.push_str(&p);
            }
            out.push_str(word);
            prev = Some(word_prev(word, prev));
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'.' || b[i] == b'_') {
                i += 1;
            }
            out.push_str(&src[start..i]);
            prev = Some(b'0');
            continue;
        }
        let end = match c {
            b'"' | b'\'' | b'/' => skip_literal(b, i, prev),
            b'`' => {
                i = rewrite_template(src, i, &mut out, prefix, inserts, base);
                prev = Some(c);
                continue;
            }
            _ => None,
        };
        let Some(end) = end else {
            match c {
                b'{' | b'(' | b'[' => open.push(c),
                b'}' | b')' | b']' => {
                    open.pop();
                }
                _ => {}
            }
            let ch = src[i..].chars().next().expect("char boundary");
            out.push(ch);
            i += ch.len_utf8();
            if !ch.is_whitespace() {
                prev = Some(c);
            }
            continue;
        };
        out.push_str(&src[i..end]);
        if !is_comment(b, i) {
            prev = Some(c);
        }
        i = end;
    }
    out
}

fn rewrite_template<'a>(
    src: &str,
    start: usize,
    out: &mut String,
    prefix: &dyn Fn(&str) -> Option<&'a str>,
    inserts: &mut Vec<(usize, usize)>,
    base: usize,
) -> usize {
    let b = src.as_bytes();
    out.push('`');
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'`' => {
                out.push('`');
                return i + 1;
            }
            b'$' if b.get(i + 1) == Some(&b'{') => {
                let inner = i + 2;
                let close = skip_braces(b, i + 1);
                let j = if close > inner && b[close - 1] == b'}' { close - 1 } else { b.len() };
                out.push_str("${");
                out.push_str(&rewrite_tracked(&src[inner..j], prefix, inserts, base + inner));
                if j < b.len() {
                    out.push('}');
                }
                i = close;
            }
            c => {
                let len = if c == b'\\' { 1 } else { 0 };
                let ch_start = i + len;
                let ch = src[ch_start..].chars().next().map_or(0, char::len_utf8);
                out.push_str(&src[i..ch_start + ch]);
                i = ch_start + ch;
            }
        }
    }
    i
}

fn skip_string(b: &[u8], start: usize) -> usize {
    let quote = b[start];
    let mut i = start + 1;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == quote {
            return i + 1;
        }
        i += 1;
    }
    b.len()
}

/// Names of class members declared at the top level of an `@code` block.
pub fn collect_members(code: &str) -> Vec<String> {
    member_decls(code).into_iter().map(|m| m.name).collect()
}

/// The event a `@bind` writes back on: `input` for `@bind:input`, else `@bind:event`'s, else `change`.
fn bind_event(name: &str, event: Option<&AttrValue>) -> Result<String, String> {
    match event {
        _ if name == "@bind:input" => Ok("input".into()),
        Some(AttrValue::Expr(e)) => Ok(e.trim_start_matches("on").to_string()),
        Some(_) => Err("@bind:event requires an event name".into()),
        None => Ok("change".into()),
    }
}

/// `sku` for `@Key("sku")` on an array field: the member its items are matched by.
fn key_member(decorator: &str) -> Option<String> {
    let arg = decorator.strip_prefix("@Key")?.trim_start().strip_prefix('(')?.strip_suffix(')')?.trim();
    let inner = arg.strip_prefix(['"', '\''])?.strip_suffix(['"', '\''])?;
    is_identifier(inner).then(|| inner.to_string())
}

/// The cascade name of a `@Cascade` or `@Cascade("name")` decorator on `prop`; `None` for others.
fn cascade_name(decorator: &str, prop: &str) -> Result<Option<String>, String> {
    let Some(rest) = decorator.strip_prefix("@Cascade").map(str::trim_start) else { return Ok(None) };
    if rest.is_empty() {
        return Ok(Some(prop.to_string()));
    }
    let Some(arg) = rest.strip_prefix('(').and_then(|a| a.strip_suffix(')')).map(str::trim) else { return Ok(None) };
    let b = arg.as_bytes();
    match b.first().copied() {
        Some(q @ (b'"' | b'\'')) if b.len() >= 2 && b[b.len() - 1] == q && !b[1..b.len() - 1].contains(&q) => {
            Ok(Some(arg[1..arg.len() - 1].to_string()))
        }
        _ => Err(CASCADE_ONE_NAME.into()),
    }
}

/// The `@Cascade` members of one `@code` block, appended to `cascades` as `(property, cascade name)`
/// pairs, with the decorator spans to blank out appended to `blanks`.
/// `Err` is the message and the offset of the offending decorator.
fn cascade_members(
    code: &Src,
    decls: &[MemberDecl],
    cascades: &mut Vec<(String, String)>,
    blanks: &mut Vec<(usize, usize)>,
) -> Result<(), (String, usize)> {
    for m in decls {
        for &(s, e) in &m.decorators {
            let at = code.at + s;
            let Some(name) = cascade_name(&code[s..e], &m.name).map_err(|message| (message, at))? else { continue };
            if m.is_method || m.is_static {
                return Err((CASCADE_FIELD_ONLY.into(), at));
            }
            cascades.push((m.name.clone(), name));
            blanks.push((at, code.at + e));
        }
    }
    Ok(())
}

/// The first `@Cascade` error in `doc`, with its source offset.
pub fn cascade_error(doc: &Document) -> Option<(String, usize)> {
    doc.code.iter().find_map(|code| cascade_members(code, &member_decls(code), &mut Vec::new(), &mut Vec::new()).err())
}

/// Source text with the spans in `blanks` replaced by spaces, mapped around them.
fn blanked(s: &Src, blanks: &[(usize, usize)]) -> M {
    let (start, end) = (s.at, s.at + s.len());
    let mut out = M::default();
    let mut at = start;
    for &(bs, be) in blanks.iter().filter(|&&(bs, be)| bs >= start && be <= end) {
        out = out.add(M::src(&s[at - start..bs - start], at)).lit_then(&s[bs - start..be - start].replace(|c: char| c != '\n', " "));
        at = be;
    }
    out.add(M::src(&s[at - start..], at))
}

/// Each slot the template defines, in order, with its parameters' names and inferred types.
type SlotDecl = (String, Vec<(String, String)>);

fn slot_declarations(doc: &Document, members: &HashSet<String>, statics: &HashSet<String>, class_name: &str) -> Result<Vec<SlotDecl>, String> {
    let mut out = Vec::new();
    // Own statics resolve like loop variables, typed through the class.
    let mut loops: Vec<(String, String)> = statics.iter().map(|s| (s.clone(), format!("(typeof {class_name})[{}]", js_string(s)))).collect();
    collect_slots(&doc.nodes, members, &mut loops, &mut out)?;
    for parts in &doc.code_parts {
        for part in parts {
            if let CodePart::Markup(el) = part {
                collect_slots(&el.children, members, &mut loops, &mut out)?;
            }
        }
    }
    Ok(out)
}

fn collect_slots(nodes: &[Node], members: &HashSet<String>, loops: &mut Vec<(String, String)>, out: &mut Vec<SlotDecl>) -> Result<(), String> {
    for node in nodes {
        match node {
            Node::Element(el) => collect_slots(&el.children, members, loops, out)?,
            Node::If { branches, otherwise } => {
                for (_, body) in branches {
                    collect_slots(body, members, loops, out)?;
                }
                if let Some(body) = otherwise {
                    collect_slots(body, members, loops, out)?;
                }
            }
            Node::For { head, body, otherwise, .. } => {
                let scope = loops.len();
                if let Some(var) = loop_var_type(head, members, loops) {
                    loops.push(var);
                }
                collect_slots(body, members, loops, out)?;
                loops.truncate(scope);
                if let Some(body) = otherwise {
                    collect_slots(body, members, loops, out)?;
                }
            }
            Node::Switch { cases, .. } => {
                for case in cases {
                    collect_slots(&case.body, members, loops, out)?;
                }
            }
            Node::SlotFill(fill) => collect_slots(&fill.body, members, loops, out)?,
            Node::Cascade { body, .. } => collect_slots(body, members, loops, out)?,
            Node::Once(body) => collect_slots(body, members, loops, out)?,
            Node::Show(inner) => collect_slots(std::slice::from_ref(&**inner), members, loops, out)?,
            Node::Pause(body) => collect_slots(body.as_deref().unwrap_or_default(), members, loops, out)?,
            Node::Await { pending, then, catch, .. } => {
                collect_slots(pending, members, loops, out)?;
                for (_, body) in then.iter().chain(catch) {
                    collect_slots(body, members, loops, out)?;
                }
            }
            Node::Routes { sections, .. } => {
                for section in sections {
                    collect_slots(&section.body, members, loops, out)?;
                }
            }
            Node::While { body, otherwise, .. } => {
                collect_slots(body, members, loops, out)?;
                if let Some(body) = otherwise {
                    collect_slots(body, members, loops, out)?;
                }
            }
            Node::Code(parts) => {
                for part in parts {
                    match part {
                        CodePart::Render(nodes) => collect_slots(nodes, members, loops, out)?,
                        CodePart::Markup(el) => collect_slots(&el.children, members, loops, out)?,
                        CodePart::Ts(_) => {}
                    }
                }
            }
            Node::Slot(slot) => {
                let key = slot.name.as_ref().map_or("default", |n| &**n).to_string();
                if out.iter().any(|(k, _)| *k == key) {
                    return Err(format!("slot `{key}` is defined twice"));
                }
                let params = slot
                    .args
                    .iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, arg)| slot_arg_type(arg, i, members, loops))
                    .collect::<Result<_, _>>()?;
                out.push((key, params));
            }
            Node::Text(_) | Node::Expr(_) | Node::ParentAttr(_) => {}
        }
    }
    Ok(())
}

/// Type of a loop variable, when xzor can name it: `const x of <path>`, `const k in ...`, `let i = 0`.
fn loop_var_type(head: &str, members: &HashSet<String>, loops: &[(String, String)]) -> Option<(String, String)> {
    let rest = ["const ", "let ", "var "].iter().find_map(|k| head.trim_start().strip_prefix(k))?;
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
    if name.is_empty() {
        return None;
    }
    let after = rest[name.len()..].trim_start();
    if let Some(expr) = after.strip_prefix("of ") {
        return path_type(expr.trim(), members, loops).map(|t| (name, format!("{t}[number]")));
    }
    if after.starts_with("in ") {
        return Some((name, "string".into()));
    }
    let init = after.strip_prefix('=')?.trim_start();
    init.starts_with(|c: char| c.is_ascii_digit()).then(|| (name, "number".into()))
}

/// `this["a"]["b"]` for a member path `a.b` or `this.a.b`, or a loop variable's path.
fn path_type(expr: &str, members: &HashSet<String>, loops: &[(String, String)]) -> Option<String> {
    let parts: Vec<&str> = expr.split('.').map(str::trim).collect();
    if !parts.iter().all(|p| is_identifier(p)) {
        return None;
    }
    let (mut ty, rest) = match parts[0] {
        "this" if parts.len() > 1 => (format!("this[{}]", js_string(parts[1])), &parts[2..]),
        root => match loops.iter().rev().find(|(n, _)| n == root) {
            Some((_, t)) => (t.clone(), &parts[1..]),
            None if members.contains(root) => (format!("this[{}]", js_string(root)), &parts[1..]),
            None => return None,
        },
    };
    for p in rest {
        ty.push_str(&format!("[{}]", js_string(p)));
    }
    Some(ty)
}

/// Name and type of a slot argument. Types must be known at compile time so the
/// parent's slot parameters are statically typed.
fn slot_arg_type(arg: &SlotArg, i: usize, members: &HashSet<String>, loops: &[(String, String)]) -> Result<(String, String), String> {
    let fallback_name = format!("arg{i}");
    let e = match arg {
        SlotArg::Markup(_) => return Ok((fallback_name, "RenderFragment".into())),
        SlotArg::Expr(e) => e.trim(),
    };
    let name_of = |expr: &str| {
        let is_path = expr.split('.').all(|p| is_identifier(p.trim()));
        let last = expr.rsplit('.').next().unwrap_or("").trim();
        if is_path { last.to_string() } else { fallback_name.clone() }
    };
    if let Some(at) = e.rfind(" as ") {
        return Ok((name_of(e[..at].trim()), e[at + 4..].trim().to_string()));
    }
    if e.starts_with(|c: char| c.is_ascii_digit()) {
        return Ok((fallback_name, "number".into()));
    }
    if e.starts_with(['"', '\'', '`']) {
        return Ok((fallback_name, "string".into()));
    }
    if e == "true" || e == "false" {
        return Ok((fallback_name, "boolean".into()));
    }
    match path_type(e, members, loops) {
        Some(ty) => Ok((name_of(e), ty)),
        None => Err(format!("can't infer the type of slot argument `{e}`; write `({e}) as Type`")),
    }
}

/// Names declared with `const`/`let`/`var` in a `@{ }` block, which shadow members.
fn declared_names(code: &str) -> Vec<String> {
    let b = code.as_bytes();
    let mut names = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if is_ident_start(b[i]) && (i == 0 || !is_ident_char(b[i - 1])) {
            let s = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            if matches!(&code[s..i], "const" | "let" | "var") {
                let rest = code[i..].trim_start();
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
                if !name.is_empty() {
                    names.push(name);
                }
            }
            continue;
        }
        i += 1;
    }
    names
}

/// Names declared by a parameter list like `item: T = x, i`.
fn param_names(params: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut depth = 0i32;
    let mut start = true;
    let b = params.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b')' | b']' | b'}' | b'>' => depth -= 1,
            b',' if depth == 0 => start = true,
            c if start && depth == 0 && is_ident_start(c) => {
                let s = i;
                while i < b.len() && is_ident_char(b[i]) {
                    i += 1;
                }
                names.push(params[s..i].to_string());
                start = false;
                continue;
            }
            c if !c.is_ascii_whitespace() && c != b'.' => start = false,
            _ => {}
        }
        i += 1;
    }
    names
}

/// Type parameters and prop kinds of a component source.
pub fn component_info(source: &str) -> ComponentInfo {
    let Ok((doc, _)) = crate::parser::parse(source) else { return ComponentInfo::default() };
    let type_params = doc
        .type_params
        .iter()
        .filter_map(|t| t.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).next())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    let mut props = HashMap::new();
    let mut named_types = HashMap::new();
    for code in &doc.code {
        for m in member_decls(code).into_iter().filter(|m| !m.is_method && !m.name.starts_with('#')) {
            let rest = &code[m.offset..];
            let end = rest.find(['\n', ';']).unwrap_or(rest.len());
            let kind = prop_kind(&rest[..end]);
            if kind == PropKind::Expr
                && let Some(names) = type_names(&rest[..end])
            {
                named_types.insert(m.name.clone(), names);
            }
            props.insert(m.name, kind);
        }
    }
    ComponentInfo { type_params, props, named_types, lazy: doc.lazy }
}

/// The type annotation of a declaration like `size?: Size = "s"`, without its initializer.
fn annotation(decl: &str) -> Option<&str> {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let ty = rest.trim_start_matches(['?', '!']).trim_start().strip_prefix(':')?;
    let b = ty.as_bytes();
    let eq = (0..b.len()).find(|&i| {
        b[i] == b'=' && b.get(i + 1) != Some(&b'>') && !matches!(i.checked_sub(1).map(|j| b[j]), Some(b'=' | b'!' | b'<' | b'>'))
    });
    Some(ty[..eq.unwrap_or(ty.len())].trim())
}

/// `["Size"]` for `size?: Size | "auto"`: the type names of an annotation that is a union of names,
/// `string` and string literals; `None` for anything else (`number`, `T[]`, `keyof X`, ...).
pub fn type_names(decl: &str) -> Option<Vec<String>> {
    const NOT_NAMES: &[&str] = &["number", "boolean", "bigint", "symbol", "object", "any", "unknown", "never", "void", "null", "undefined", "true", "false"];
    let mut names = Vec::new();
    for t in annotation(decl)?.split('|').map(str::trim).filter(|t| !t.is_empty()) {
        if t == "string" || t.starts_with(['"', '\'', '`']) {
            continue;
        }
        if !is_identifier(t) || NOT_NAMES.contains(&t) {
            return None;
        }
        names.push(t.to_string());
    }
    (!names.is_empty()).then_some(names)
}

/// Kind of a declaration like `step: number = 1`, `item?: RenderFragment<T>` or `title = "x"`.
pub fn prop_kind(decl: &str) -> PropKind {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let rest = rest.trim_start_matches(['?', '!']).trim_start();
    if let Some(ty) = rest.strip_prefix(':') {
        if ty.trim_start().starts_with("EventCallback") {
            return PropKind::Callback;
        }
    }
    if takes_expression(decl) { PropKind::Expr } else { PropKind::Text }
}

/// Whether a declaration like `step: number = 1` or `title = "x"` has a non-string type. A string
/// default makes any annotation text (`name: SnippetName = "hero"`).
pub fn takes_expression(decl: &str) -> bool {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let rest = rest.trim_start_matches(['?', '!']).trim_start();
    let is_stringy = |s: &str| s.starts_with(['"', '\'', '`']);
    if let Some(ty) = annotation(decl) {
        let init = rest.strip_prefix(':').map(|t| t.trim_start()[ty.len()..].trim_start()).and_then(|t| t.strip_prefix('='));
        if init.is_some_and(|i| is_stringy(i.trim_start())) {
            return false;
        }
        return !ty.split('|').map(str::trim).filter(|t| !t.is_empty()).all(|t| t == "string" || is_stringy(t));
    }
    match rest.strip_prefix('=') {
        Some(init) => !is_stringy(init.trim_start()),
        None => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberDecl {
    pub name: String,
    /// Byte offset of the name within the code block.
    pub offset: usize,
    pub is_method: bool,
    pub is_static: bool,
    /// Spans of the decorators written before the member, in order.
    pub decorators: Vec<(usize, usize)>,
}

pub fn member_decls(code: &str) -> Vec<MemberDecl> {
    const MODIFIERS: &[&str] = &[
        "public", "private", "protected", "readonly", "static", "async", "get", "set", "override",
        "declare", "abstract", "accessor",
    ];
    let b = code.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut at_decl = true;
    let mut is_static = false;
    let mut decorators: Vec<(usize, usize)> = Vec::new();
    let mut prev = None;
    let mut i = 0;
    while i < b.len() {
        if let Some(end) = skip_literal(b, i, prev) {
            if !is_comment(b, i) {
                prev = Some(b'"');
            }
            i = end;
            continue;
        }
        let c = b[i];
        match c {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => {
                depth -= 1;
                if depth == 0 && c == b'}' {
                    at_decl = true;
                    is_static = false;
                    decorators.clear();
                }
            }
            b';' if depth == 0 => {
                at_decl = true;
                is_static = false;
                decorators.clear();
            }
            b'\n' if depth == 0 => at_decl = true,
            // A decorator (`@name` or `@name(args)`) belongs to the member declared after it.
            b'@' if depth == 0 && at_decl && b.get(i + 1).is_some_and(|&c| is_ident_start(c)) => {
                let start = i;
                i += 1;
                while i < b.len() && is_ident_char(b[i]) {
                    i += 1;
                }
                let mut args = i;
                while args < b.len() && b[args].is_ascii_whitespace() {
                    args += 1;
                }
                if b.get(args) == Some(&b'(') {
                    i = skip_pair(b, args, b'(', b')');
                }
                decorators.push((start, i));
                prev = Some(b')');
                continue;
            }
            _ if depth == 0 && at_decl && (is_ident_start(c) || (c == b'#' && b.get(i + 1).is_some_and(|&n| is_ident_start(n)))) => {
                let start = i;
                // A `#private` member keeps its `#`: the bare name is a different identifier.
                if c == b'#' {
                    i += 1;
                }
                while i < b.len() && is_ident_char(b[i]) {
                    i += 1;
                }
                let word = &code[start..i];
                let next = b[i..].iter().copied().find(|c| !c.is_ascii_whitespace());
                let used_as_name = matches!(next, Some(b'(' | b':' | b'=' | b';' | b'?' | b'!' | b'<'));
                if !MODIFIERS.contains(&word) || used_as_name {
                    out.push(MemberDecl {
                        name: word.to_string(),
                        offset: start,
                        is_method: matches!(next, Some(b'(' | b'<')),
                        is_static,
                        decorators: std::mem::take(&mut decorators),
                    });
                    at_decl = false;
                    is_static = false;
                } else if word == "static" {
                    is_static = true;
                }
                prev = Some(word_prev(word, prev));
                continue;
            }
            _ if is_ident_start(c) && (i == 0 || !is_ident_char(b[i - 1])) => {
                let start = i;
                while i < b.len() && is_ident_char(b[i]) {
                    i += 1;
                }
                prev = Some(word_prev(&code[start..i], prev));
                continue;
            }
            _ => {}
        }
        if !c.is_ascii_whitespace() {
            prev = Some(c);
        }
        i += 1;
    }
    out
}

/// The `prev` to record after `word`, which `prev` precedes: keywords that can precede an expression
/// allow a regex, but a property named after one (`bond.yield / x /`) does not.
pub(crate) fn word_prev(word: &str, prev: Option<u8>) -> u8 {
    const KEYWORDS: &[&str] = &["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"];
    if prev != Some(b'.') && KEYWORDS.contains(&word) { b';' } else { b'a' }
}

/// End of the string, template literal, comment or regex literal starting at `i`, if any.
/// `prev` is the last significant byte before `i`; it tells a regex from a division.
pub(crate) fn skip_literal(b: &[u8], i: usize, prev: Option<u8>) -> Option<usize> {
    match b[i] {
        b'"' | b'\'' => Some(skip_string(b, i)),
        b'`' => Some(skip_template(b, i)),
        b'/' => match b.get(i + 1) {
            Some(b'/') => Some(b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p)),
            Some(b'*') => Some(b[i + 2..].windows(2).position(|w| w == b"*/").map_or(b.len(), |p| i + 2 + p + 2)),
            _ if prev.is_none_or(|p| b"(,=:[!&|?{};+-*%~^>".contains(&p)) && !after_postfix(b, i, prev) => skip_regex(b, i),
            _ => None,
        },
        _ => None,
    }
}

/// Whether the `+`/`-` before `i` (the last significant byte) is the second of a postfix `++`/`--`.
fn after_postfix(b: &[u8], i: usize, prev: Option<u8>) -> bool {
    let Some(p @ (b'+' | b'-')) = prev else { return false };
    let mut j = i;
    while j > 0 && b[j - 1].is_ascii_whitespace() {
        j -= 1;
    }
    j >= 2 && b[j - 1] == p && b[j - 2] == p
}

pub(crate) fn is_comment(b: &[u8], i: usize) -> bool {
    b[i] == b'/' && matches!(b.get(i + 1), Some(b'/' | b'*'))
}

fn skip_template(b: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'`' => return i + 1,
            b'$' if b.get(i + 1) == Some(&b'{') => i = skip_braces(b, i + 1),
            _ => i += 1,
        }
    }
    b.len()
}

/// Index just past the `}` that closes the `{` at `open`.
pub(crate) fn skip_braces(b: &[u8], open: usize) -> usize {
    skip_pair(b, open, b'{', b'}')
}

/// Index just past the `close` matching the `open` delimiter at `at`.
pub(crate) fn skip_pair(b: &[u8], at: usize, open: u8, close: u8) -> usize {
    let mut depth = 0usize;
    let mut prev = None;
    let mut i = at;
    while i < b.len() {
        if let Some(end) = skip_literal(b, i, prev) {
            if !is_comment(b, i) {
                prev = Some(b'"');
            }
            i = end;
            continue;
        }
        if is_ident_start(b[i]) && (i == at || !is_ident_char(b[i - 1])) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            prev = Some(word_prev(std::str::from_utf8(&b[start..i]).unwrap_or(""), prev));
            continue;
        }
        if b[i] == open {
            depth += 1;
        } else if b[i] == close {
            depth -= 1;
            if depth == 0 {
                return i + 1;
            }
        }
        if !b[i].is_ascii_whitespace() {
            prev = Some(b[i]);
        }
        i += 1;
    }
    b.len()
}

/// End of a regex literal at `i`, or `None` when the line ends first (it was a division).
fn skip_regex(b: &[u8], i: usize) -> Option<usize> {
    let mut class = false;
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 1,
            b'\n' => return None,
            b'[' => class = true,
            b']' => class = false,
            b'/' if !class => {
                j += 1;
                while j < b.len() && is_ident_char(b[j]) {
                    j += 1;
                }
                return Some(j);
            }
            _ => {}
        }
        j += 1;
    }
    None
}

/// Variables declared by a `for (...)` head, which shadow members inside the loop body.
fn loop_locals(head: &str) -> Vec<String> {
    let head = head.trim_start();
    let Some(rest) = ["const ", "let ", "var "].iter().find_map(|k| head.strip_prefix(k)) else {
        return Vec::new();
    };
    let end = [" of ", " in ", "=", ";"].iter().filter_map(|p| rest.find(p)).min().unwrap_or(rest.len());
    rest[..end]
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .filter(|w| w.bytes().next().is_some_and(is_ident_start))
        .map(str::to_string)
        .collect()
}

/// `const x of items` (or `let`/`var`, a destructuring pattern too): the binding and the items, as spans of `head`.
fn for_of(head: &Src) -> Option<(Src, Src)> {
    let lead = head.len() - head.trim_start().len();
    let text = &head[lead..];
    let keyword = ["const ", "let ", "var "].iter().find(|k| text.starts_with(**k))?;
    let mut depth = 0i32;
    let b = text.as_bytes();
    let mut i = keyword.len();
    while i < b.len() {
        match b[i] {
            b'[' | b'{' | b'(' => depth += 1,
            b']' | b'}' | b')' => depth -= 1,
            b' ' if depth == 0 && text[i..].starts_with(" of ") => {
                let pattern = text[keyword.len()..i].trim();
                let start = lead + keyword.len() + (text[keyword.len()..i].len() - text[keyword.len()..i].trim_start().len());
                let items_raw = &text[i + 4..];
                let items_at = lead + i + 4 + (items_raw.len() - items_raw.trim_start().len());
                let items = items_raw.trim();
                if pattern.is_empty() || items.is_empty() {
                    return None;
                }
                return Some((Src::new(pattern, head.at + start), Src::new(items, head.at + items_at)));
            }
            b'=' | b';' if depth == 0 => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

pub fn is_identifier(s: &str) -> bool {
    let mut b = s.bytes();
    b.next().is_some_and(is_ident_start) && b.all(is_ident_char)
}

pub fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Turns a file stem into a valid TypeScript class name.
pub fn class_name(stem: &str) -> String {
    let mut name: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
    if !name.bytes().next().is_some_and(is_ident_start) {
        name.insert(0, '_');
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests cover the virtual-DOM emitter (what islands use) unless the source asks for `@fine`; a leading
    /// `@render` (removed from the language) is blanked out for them.
    fn parse(src: &str) -> Result<(Document, Vec<crate::parser::Token>), crate::parser::ParseError> {
        let fine = src.contains("@fine");
        let src = src.strip_prefix("@render\n").map(|s| format!("{}{s}", " ".repeat("@render\n".len()))).unwrap_or_else(|| src.to_string());
        crate::parser::parse(&src).map(|(mut doc, tokens)| {
            doc.fine = fine;
            (doc, tokens)
        })
    }

    fn rw(src: &str, members: &[&str]) -> String {
        rewrite(src, &|w| members.contains(&w))
    }

    #[test]
    fn rewrites_free_member_identifiers_only() {
        let m = ["count", "items", "name"];
        assert_eq!(rw("count + 1", &m), "this.count + 1");
        assert_eq!(rw("user.count", &m), "user.count");
        assert_eq!(rw("this.count", &m), "this.count");
        assert_eq!(rw("() => count++", &m), "() => this.count++");
        assert_eq!(rw("items?.length ?? 0", &m), "this.items?.length ?? 0");
        assert_eq!(rw("{ count: count }", &m), "{ count: this.count }");
        assert_eq!(rw("ok ? count : name", &m), "ok ? this.count : this.name");
        assert_eq!(rw("\"count\" + 'name'", &m), "\"count\" + 'name'");
        assert_eq!(rw("`n=${count} ${'x'}`", &m), "`n=${this.count} ${'x'}`");
        assert_eq!(rw("count /* name */", &m), "this.count /* name */");
    }

    #[test]
    fn shorthand_properties_keep_their_key() {
        let m = ["count", "items", "name"];
        assert_eq!(rw("f({ count })", &m), "f({ count: this.count })");
        assert_eq!(rw("({ count, x: 1, name })", &m), "({ count: this.count, x: 1, name: this.name })");
        assert_eq!(rw("{ a: { count } }", &m), "{ a: { count: this.count } }");
        // Array elements and arguments between commas are not properties.
        assert_eq!(rw("[1, count, name]", &m), "[1, this.count, this.name]");
        assert_eq!(rw("f(count, name)", &m), "f(this.count, this.name)");
        assert_eq!(rw("{ ...items }", &m), "{ ...this.items }");
        // The mappings still copy the source exactly around the inserted key.
        let g = gen_with("@code { id = 1; f(o: { id: number }) { return o.id; } }\n<p>@f({ id })</p>", &[]);
        assert!(g.code.contains("this.f({ id: this.id })"), "{}", g.code);
    }

    #[test]
    fn own_statics_go_through_the_class() {
        let src = "@code { static s = 2; n = 1; static go() {} }\n<p title=\"@s\">@s @n @(`${s}`)</p>\n<button @onclick=\"go\" @onfocus=\"() => s++\">x</button>";
        let (doc, _) = parse(src).unwrap();
        let g = generate(&doc, "C", "C.xzor").unwrap();
        for m in ["addContent(C.s)", "addContent(this.n)", "${C.s}", "C.go.bind(C)", "() => C.s++", "addAttribute(\"title\", C.s)"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
        assert!(!g.code.contains("this.s") && !g.code.contains("this.go"), "{}", g.code);
        for m in &g.mappings {
            assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}");
        }
    }

    #[test]
    fn rewrite_skips_regex_literals() {
        let is = |w: &str| ["title", "name", "ok"].contains(&w);
        assert_eq!(rewrite("ok = /title/i.test(name) && f(x / title / 2)", &is), "this.ok = /title/i.test(this.name) && f(x / this.title / 2)");
        assert_eq!(rewrite("() => { return /name/.test(s) }", &is), "() => { return /name/.test(s) }");
    }

    #[test]
    fn division_after_postfix_increment() {
        let is = |w: &str| ["i", "b", "c"].contains(&w);
        assert_eq!(rewrite("i++ / b / c", &is), "this.i++ / this.b / this.c");
        assert_eq!(rewrite("i-- / b / c", &is), "this.i-- / this.b / this.c");
        assert_eq!(rewrite("i ++ / b / c", &is), "this.i ++ / this.b / this.c");
    }

    #[test]
    fn division_after_a_keyword_named_property() {
        let is = |w: &str| ["bond", "price", "years"].contains(&w);
        assert_eq!(rewrite("bond.yield / price / years", &is), "this.bond.yield / this.price / this.years");
        assert_eq!(rewrite("bond.return / price / years", &is), "this.bond.return / this.price / this.years");
    }

    #[test]
    fn regex_after_arrow_typeof_and_in() {
        let is = |w: &str| ["title", "name"].contains(&w);
        assert_eq!(rewrite("() => /title/.test(name)", &is), "() => /title/.test(this.name)");
        assert_eq!(rewrite("typeof /title/ + name", &is), "typeof /title/ + this.name");
        assert_eq!(rewrite("x in /title/ ? name : 1", &is), "x in /title/ ? this.name : 1");
    }

    #[test]
    fn unterminated_interpolation_does_not_panic() {
        let is = |w: &str| w == "name";
        assert_eq!(rewrite("`${ name", &is), "`${ this.name");
    }

    #[test]
    fn template_interpolation_closes_at_the_real_brace() {
        let is = |w: &str| ["name", "ok"].contains(&w);
        let src = "`${ok ? `}` : name}` + `${s.replace(/}/g, name)}` + `${/* } */ name}`";
        assert_eq!(rewrite(src, &is), "`${this.ok ? `}` : this.name}` + `${s.replace(/}/g, this.name)}` + `${/* } */ this.name}`");
        assert_eq!(rewrite("`${s.replace(/}/g, name)}`", &is), "`${s.replace(/}/g, this.name)}`");
        assert_eq!(rewrite("`${/* } */ name} name`", &is), "`${/* } */ this.name} name`");
    }

    #[test]
    fn own_static_slot_args_type_through_the_class() {
        let g = gen_with("@code { static max = 10; n = 1; }\n@slot:item(max, n)", &[]);
        assert!(g.code.contains(r#"item?: (max: (typeof C)["max"], n: this["n"]) => RenderFragment"#), "{}", g.code);
    }

    #[test]
    fn regex_after_a_keyword_does_not_hide_members() {
        let code = "m() { return /}/.test(\"x\") } b7 = 2;\n n() { if (a) {} else /[}]/.exec(s); typeof /}/; } b8 = 3;";
        assert_eq!(collect_members(code), ["m", "b7", "n", "b8"]);
    }

    #[test]
    fn collects_top_level_members() {
        let code = r#"
  count: number = 0;
  private readonly items: string[] = ["a; b"];
  label = "x"
  get total(): number { return this.count + local; }
  async load() {
    const inner = 1;
  }
  reset = () => { this.count = 0; };
"#;
        assert_eq!(collect_members(code), ["count", "items", "label", "total", "load", "reset"]);
    }

    #[test]
    fn loop_locals_from_heads() {
        assert_eq!(loop_locals("const item of items"), ["item"]);
        assert_eq!(loop_locals("const [k, v] of Object.entries(m)"), ["k", "v"]);
        assert_eq!(loop_locals("let i = 0; i < n; i++"), ["i"]);
        assert!(loop_locals(";;").is_empty());
    }

    #[test]
    fn switch_emits_scoped_cases_with_break() {
        let (doc, _) = parse(
            "@code { mode = 1; }\n@switch (mode) { case 1: case 2: <b>low</b> default: @mode }",
        )
        .unwrap();
        let ts = generate(&doc, "S", "S.xzor").unwrap().code;
        let expected = "    __b.openRegion();
    switch (this.mode) {
      case 1:
      case 2: {
        __b.openElement(\"b\");
        __b.addText(\"low\");
        __b.closeElement();
        break;
      }
      default: {
        __b.addContent(this.mode);
        break;
      }
    }
    __b.closeRegion();
";
        assert!(ts.contains(expected), "{ts}");
    }

    #[test]
    fn if_and_for_are_wrapped_in_regions() {
        let (doc, _) = parse("@if (a) {<b/>}\n@for (const x of xs) {@x}").unwrap();
        let ts = generate(&doc, "R", "R.xzor").unwrap().code;
        let expected = "    __b.openRegion();
    if (a) {
      __b.openElement(\"b\");
      __b.closeElement();
    }
    __b.closeRegion();
    __b.openRegion();
    for (const x of xs) {
      __b.addContent(x);
    }
    __b.closeRegion();
";
        assert!(ts.contains(expected), "{ts}");
    }

    #[test]
    fn mappings_copy_source_text_exactly() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/counter");
        let extra = "@code {\n    x = 1;\n  go(e: Event) {}\n}\n<p title=\"a @x b\" @onclick=\"go\">@(`${x}`) @x</p>\n@switch (x) { case 1: @x }\n@for (const x of [1]) { @x }";
        let mut sources: Vec<String> = ["Routes.xzor", "layouts/Shell.xzor", "pages/Home.xzor", "pages/UserPage.xzor", "Counter.xzor"]
            .iter()
            .map(|f| std::fs::read_to_string(dir.join(f)).unwrap())
            .collect();
        sources.push(extra.into());
        for src in &sources {
            let (doc, _) = parse(src).unwrap();
            let g = generate(&doc, "C", "C.xzor").unwrap();
            assert!(g.mappings.len() > 3);
            for m in &g.mappings {
                assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}\n{}", g.code);
            }
        }
        let (doc, _) = parse("@code { count = 1; }\n<b>@count</b>").unwrap();
        let g = generate(&doc, "C", "C.xzor").unwrap();
        let at = "@code { count = 1; }\n<b>@".len();
        let m = g.mappings.iter().find(|m| m.src == at).expect("maps @count");
        assert_eq!(&g.code[m.out - 5..m.out + m.len], "this.count");
    }

    #[test]
    fn markup_in_code_becomes_fragments() {
        let src = "@code {\n  state = 1;\n  cached = <B />;\n  pick(t: number) {\n    return t ? <A state=\"@this.state\" n=\"@t\" /> : this.cached;\n  }\n}\n<p>@pick(1)</p>";
        let (doc, _) = parse(src).unwrap();
        let g = generate(&doc, "C", "C.xzor").unwrap();
        assert!(g.code.contains("  cached = ComponentBase.fragment((__b) => { __b.addComponent(B, {}); });"), "{}", g.code);
        assert!(
            g.code.contains("return t ? ComponentBase.fragment((__b) => { __b.addComponent(A, { state: this.state, n: t }); }) : this.cached;"),
            "{}",
            g.code
        );
        assert!(g.code.contains("__b.addContent(this.pick(1));"));
        for m in &g.mappings {
            assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}");
        }
    }

    #[test]
    fn html_entities_in_text_and_attributes_are_decoded() {
        let child = "@code {\n  label: string = \"\";\n  n = 0;\n}\n<p/>";
        let src = "@code { n = 1; }\n<p title=\"a &amp; b\" class=\"x &lt;@n&gt;\">&lt;b&gt; caf&eacute; &#233;&#xE9; &copy; &nbsp; &unknown; &amp;amp; 5 &amp 6</p>\n<div><style>a &gt; b</style></div>\n<Child label=\"Tom &amp; Jerry\" n=\"n\" />";
        let g = gen_with(src, &[("Child", child)]);
        for m in [
            "__b.addAttribute(\"title\", \"a & b\");",
            "__b.addAttribute(\"class\", \"x <\" + String(this.n) + \">\");",
            "__b.addText(\"<b> café éé © \u{a0} &unknown; &amp; 5 &amp 6\");",
            "__b.addText(\"a &gt; b\");",
            "label: \"Tom & Jerry\"",
            "n: this.n",
        ] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
    }

    #[test]
    fn prop_kinds_from_component_source() {
        let src = "@typeparam T extends object\n@code {\n  title: string = \"\";\n  n = 1;\n  frag?: RenderFragment;\n  onChange?: EventCallback<number>;\n  go() {}\n}\n<p/>";
        let info = component_info(src);
        assert_eq!(info.type_params, ["T"]);
        let kind = |n: &str| info.props.get(n).cloned();
        assert_eq!(kind("title"), Some(PropKind::Text));
        assert_eq!(kind("n"), Some(PropKind::Expr));
        assert_eq!(kind("frag"), Some(PropKind::Expr));
        assert_eq!(kind("onChange"), Some(PropKind::Callback));
        assert_eq!(kind("go"), None);
    }

    #[test]
    fn a_named_string_type_with_a_string_default_takes_text() {
        let src = "@code {\n  name: SnippetName = \"hero\";\n  size?: Size;\n  mixed: Size | \"auto\" = \"auto\";\n  count: Count = 1;\n  pick: keyof typeof table = \"a\";\n  list: string[] = [];\n}\n<p/>";
        let info = component_info(src);
        let kind = |n: &str| info.props.get(n).copied();
        assert_eq!(kind("name"), Some(PropKind::Text));
        assert_eq!(kind("mixed"), Some(PropKind::Text));
        // Without a string default the name has to be resolved from its module (see lib.rs).
        assert_eq!(kind("size"), Some(PropKind::Expr));
        assert_eq!(info.named_types.get("size").map(Vec::as_slice), Some(&["Size".to_string()][..]));
        assert_eq!(kind("count"), Some(PropKind::Expr));
        assert_eq!(kind("pick"), Some(PropKind::Text));
        assert_eq!(kind("list"), Some(PropKind::Expr));
        assert!(!info.named_types.contains_key("list"), "{:?}", info.named_types);
    }

    #[test]
    fn private_members_are_template_names_but_not_props() {
        let src = "@code {\n  #test = 3;\n  static #all = 1;\n  #go() { return 1; }\n  test2 = 0;\n}\n<p title=\"@#test\">@#test @(#test + 1) @#go() @#all @this.#test @test</p>\n<button @onclick=\"() => #test++\">x</button>\n<i>@(#test in this)</i>";
        let info = component_info(src);
        assert!(!info.props.contains_key("#test") && !info.props.contains_key("test"), "{:?}", info.props);
        let g = gen_with(src, &[]);
        for m in ["addAttribute(\"title\", this.#test)", "addContent(this.#test)", "addContent(this.#test + 1)", "addContent(this.#go())", "addContent(C.#all)", "() => this.#test++", "addContent(#test in this)"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
        // `this.#test` is left alone, and a bare `test` is not the private field.
        assert!(!g.code.contains("this.this.") && g.code.contains("addContent(test)"), "{}", g.code);
    }

    fn gen_with(src: &str, components: &[(&str, &str)]) -> Generated {
        let (doc, _) = parse(src).unwrap();
        let infos = components.iter().map(|(n, s)| (n.to_string(), component_info(s))).collect();
        let g = generate_with(&doc, "C", "C.xzor", &infos, &HashSet::new(), "./routes").unwrap();
        for m in &g.mappings {
            assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}\n{}", g.code);
        }
        g
    }

    #[test]
    fn routes_are_recorded_with_param_kinds() {
        use crate::routes::ParamKind;
        let src = "@page \"/p/:id/:on/:tab/:slug/*\" as p\n@page \"/u/:id\"\n@code {\n  id = 0;\n  on: boolean = false;\n  tab: \"a\" | \"b\" = \"a\";\n  slug = \"\";\n}\n<p/>";
        let (doc, _) = parse(src).unwrap();
        let g = generate_with(&doc, "UserProfile", "UserProfile.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap();
        assert!(g.code.contains("static readonly route = \"/p/:id/:on/:tab/:slug/*\";"), "{}", g.code);
        let tags: Vec<Option<&str>> = g.routes.iter().map(|r| r.tag.as_deref()).collect();
        assert_eq!(tags, [Some("p"), None]);
        assert_eq!((g.routes[0].pattern_at, g.routes[0].tag_at), (7, 35));
        assert_eq!(
            g.routes[0].params,
            [
                ("id".to_string(), ParamKind::Number),
                ("on".to_string(), ParamKind::Boolean),
                ("tab".to_string(), ParamKind::Union(vec!["a".into(), "b".into()])),
                ("slug".to_string(), ParamKind::String),
                ("rest".to_string(), ParamKind::String),
            ]
        );
        assert_eq!(g.routes[1].pattern_at, 44);
        assert_eq!(g.routes[1].params, [("id".to_string(), ParamKind::Number)]);
    }

    #[test]
    fn rest_is_recorded_only_when_the_page_declares_it() {
        let declared = "@page \"/a/*\"\n@code { rest = \"\"; }\n<p/>";
        let (doc, _) = parse(declared).unwrap();
        let g = generate_with(&doc, "A", "A.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap();
        assert!(g.routes[0].rest);
        let (doc, _) = parse("@page \"/a/*\"\n<p/>").unwrap();
        let g = generate_with(&doc, "A", "A.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap();
        assert!(!g.routes[0].rest);
        let inherited = HashSet::from(["rest".to_string()]);
        let g = generate_with(&doc, "A", "A.xzor", &HashMap::new(), &inherited, "./routes").unwrap();
        assert!(g.routes[0].rest);
    }

    #[test]
    fn route_param_kinds_ignore_comments_statics_and_span_lines() {
        use crate::routes::ParamKind::*;
        let src = "@page \"/:a/:b/:c/:d/:e/:f\"\n@code {\n  a = 0 // c\n  b: number /* c */ = 0\n  c: boolean // c\n  d: number | undefined\n  e:\n    | \"x\"\n    | \"y\"\n  static f = 1;\n}\n<p/>";
        let (doc, _) = parse(src).unwrap();
        let g = generate_with(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap();
        let kinds: Vec<_> = g.routes[0].params.iter().map(|p| p.1.clone()).collect();
        assert_eq!(kinds, [Number, Number, Boolean, Number, Union(vec!["x".into(), "y".into()]), String]);
    }

    /// The routes block of the design spec, §4, with plain elements for the layouts.
    const ROUTES_BLOCK: &str = concat!(
        "@ClientRoutes(route)\n{\n",
        "  @admin(page) { <main>@page</main> }\n",
        "  @/^\\/admin\\/(?<area>\\w+)/i(page) { <b>@route.match.area</b> }\n",
        "  @\"/legal/:doc\" { <i>@route.params.doc</i> }\n",
        "  @notFound { <p>Not found</p> }\n",
        "  @catch(e) { <p>@e</p> }\n",
        "  @default(page) { <aside>@page</aside> }\n",
        "}\n",
    );

    #[test]
    fn routes_block_emits_sections_for_the_runtime() {
        let g = gen_with(ROUTES_BLOCK, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s}\nmissing in\n{}", g.code);
        has("import { ComponentBase, type RenderTreeBuilder, type RenderFragment, type Route } from \"@source-crafter/xzor-runtime\";");
        has("import { routes as __routes, type AppRoute as __AppRoute } from \"./routes\";");
        has("  __b.addRoutes(\"client\", __routes, [\n");
        has("    { kind: \"tag\", tag: \"admin\", render: (_route: Route, page: RenderFragment) => ComponentBase.fragment((__b) => { __b.openElement(\"main\"); __b.addContent(page); __b.closeElement(); }) },\n");
        has("    { kind: \"regex\", re: C.__re1, page: true, render: (__route: Route<any, any>) => { const route = __route as __AppRoute & { match: { area: string } }; return ComponentBase.fragment((__b) => {");
        has("    { kind: \"pattern\", match: C.__m2, page: false, render: (__route: Route<any, any>) => { const route = __route as __AppRoute<{ doc: string }>; return ComponentBase.fragment((__b) => {");
        has("    { kind: \"notFound\", render: () => ComponentBase.fragment((__b) => { __b.openElement(\"p\"); __b.addText(\"Not found\"); __b.closeElement(); }) },\n");
        has("    { kind: \"catch\", render: (_route: Route, e: unknown) => ComponentBase.fragment((__b) => { __b.openElement(\"p\"); __b.addContent(e); __b.closeElement(); }) },\n");
        has("    { kind: \"default\", render: (_route: Route, page: RenderFragment) => ComponentBase.fragment((__b) => { __b.openElement(\"aside\"); __b.addContent(page); __b.closeElement(); }) },\n");
        has("  ]);\n");
        has("  static readonly __re1 = /^\\/admin\\/(?<area>\\w+)/i;\n");
        has("  static __m2(s: string[]): Record<string, string> | null {\n    if (s.length !== 2) return null;\n");
        has(crate::routes::DECODE);
        // The section bodies see the bound names, not `this`.
        assert!(!g.code.contains("this.route") && !g.code.contains("this.page"), "{}", g.code);
    }

    #[test]
    fn route_bindings_are_declared_only_when_the_body_uses_them() {
        let src = "@ClientRoutes(route) { @a(page) { <main>@page</main> } @notFound { <p/> } @catch(e) { <p>@e</p> } @\"/x/:id\" { <p/> } @default(page) { <p/> } }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s}\nmissing in\n{}", g.code);
        has("render: (_route: Route, page: RenderFragment) => ComponentBase.fragment((__b) => { __b.openElement(\"main\")");
        has("{ kind: \"notFound\", render: () => ");
        has("{ kind: \"catch\", render: (_route: Route, e: unknown) => ");
        has("{ kind: \"default\", render: () => ");
        has("page: false, render: () => ");
        assert!(!g.code.contains("const route") && !g.code.contains("__route:") && !g.code.contains("AppRoute"), "{}", g.code);
        // Imports the bindings no longer use are dropped too.
        assert!(g.code.contains("import { ComponentBase, type RenderTreeBuilder, type RenderFragment, type Route } from \"@source-crafter/xzor-runtime\";"), "{}", g.code);
        assert!(g.code.contains("import { routes as __routes } from \"./routes\";"), "{}", g.code);
        let none = gen_with("@ClientRoutes(route) { @notFound { <p/> } }", &[]);
        assert!(none.code.contains("import { ComponentBase, type RenderTreeBuilder } from \"@source-crafter/xzor-runtime\";"), "{}", none.code);
        // The names inside text are not uses.
        let text = gen_with("@ClientRoutes(route) { @a(page) { <p>the page route</p> } @notFound { <p>route not found</p> } }", &[]);
        assert!(!text.code.contains("const route") && !text.code.contains(" page:"), "{}", text.code);
        let paged = gen_with("@ClientRoutes(route) { @\"/x/:id\"(page) { <p>@route.match.id @page</p> } }", &[]);
        assert!(paged.code.contains("const route = __route as __AppRoute & { match: { id: string } };"), "{}", paged.code);
        let used = gen_with("@ClientRoutes(route) { @a(page) { <p>@route.params.x</p> } }", &[]);
        assert!(used.code.contains("render: (__route: Route<any, any>) => { const route = __route as __AppRoute<__RouteParams[\"a\"]>; return "), "{}", used.code);
        assert!(used.code.contains("import { routes as __routes, type AppRoute as __AppRoute, type RouteParams as __RouteParams } from \"./routes\";"), "{}", used.code);
        let other = gen_with("@ClientRoutes(route) { @notFound { <p>@route.path</p> } }", &[]);
        assert!(other.code.contains("render: (__route: Route<any, any>) => { const route = __route as __AppRoute; return "), "{}", other.code);
        assert!(other.code.contains("import { routes as __routes, type AppRoute as __AppRoute } from \"./routes\";"), "{}", other.code);
    }

    #[test]
    fn the_route_variable_is_mapped_where_it_is_declared() {
        let src = "@ClientRoutes(route) { @a(page) { <p>@route.x</p> } @notFound { <i>@route.y</i> } }";
        let g = gen_with(src, &[]);
        let at = src.find("route)").unwrap();
        let decls: Vec<_> = g.mappings.iter().filter(|m| m.src == at && m.len == 5).collect();
        assert_eq!(decls.len(), 2, "{:?}\n{}", g.mappings, g.code);
        assert!(decls.iter().all(|m| g.code[..m.out].ends_with("const ")), "{}", g.code);
    }

    #[test]
    fn named_groups_skip_lookbehinds_and_escapes() {
        assert_eq!(named_groups("/^\\/(?<a>x)(?<b2>y)/i"), ["a", "b2"]);
        assert_eq!(named_groups("/(?<=x)(?<!y)(?<c>z)/"), ["c"]);
        assert_eq!(named_groups("/\\(?<a>x)/"), Vec::<&str>::new());
        assert_eq!(named_groups("/(?:x)(y)/"), Vec::<&str>::new());
        assert_eq!(named_groups("/(?<a/"), Vec::<&str>::new());
    }

    #[test]
    fn routes_block_reports_its_engine_and_tag_sections() {
        let g = gen_with(ROUTES_BLOCK, &[]);
        let block = g.routes_block.unwrap();
        assert_eq!(block.engine, crate::routes::Engine::Client);
        assert_eq!(block.at, ROUTES_BLOCK.find("route)").unwrap());
        assert_eq!(block.sections, [("admin".to_string(), ROUTES_BLOCK.find("admin(page)").unwrap())]);
        let server = gen_with("@ServerRoutes(r) { @notFound { <p/> } }", &[]);
        assert_eq!(server.routes_block.unwrap().engine, crate::routes::Engine::Server);
        assert!(server.code.contains("__b.addRoutes(\"server\", __routes, ["), "{}", server.code);
    }

    #[test]
    fn a_component_without_a_routes_block_imports_no_table() {
        let g = gen_with("<p>hi</p>", &[]);
        assert!(g.routes_block.is_none());
        assert!(!g.code.contains("__routes"), "{}", g.code);
        assert!(!g.code.contains(crate::routes::DECODE), "{}", g.code);
    }

    #[test]
    fn slot_definitions_declare_typed_slots_and_render_with_fallbacks() {
        let src = "@typeparam T\n@code { title = \"\"; items: T[] = []; n = 1; }\n<section>\n  @slot:header { <h3>@title</h3> }\n  @for (const x of items) {\n    @slot:item(x, n, \"s\", this.title.length, <b/>)\n  }\n  @slot:extra((n + 1) as number)\n  @slot\n</section>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("import { ComponentBase, type RenderTreeBuilder, type RenderFragment } from \"@source-crafter/xzor-runtime\";"), "{}", g.code);
        assert!(
            g.code.contains(r#"  declare slots: { header?: () => RenderFragment; item?: (x: this["items"][number], n: this["n"], arg2: string, length: this["title"]["length"], arg4: RenderFragment) => RenderFragment; extra?: (arg0: number) => RenderFragment; default?: () => RenderFragment };"#),
            "{}",
            g.code
        );
        assert!(g.code.contains(r#"__b.addContent(this.slots.header?.() ?? ComponentBase.fragment((__b) => { __b.openElement("h3"); __b.addContent(this.title); __b.closeElement(); }));"#), "{}", g.code);
        assert!(g.code.contains(r#"__b.addContent(this.slots.item?.(x, this.n, "s", this.title.length, ComponentBase.fragment((__b) => { __b.openElement("b"); __b.closeElement(); })) ?? null);"#), "{}", g.code);
        assert!(g.code.contains("__b.addContent(this.slots.default?.() ?? null);"), "{}", g.code);
    }

    #[test]
    fn inject_emits_constructor_and_fields() {
        let src = "@inject IDatabase db\n@inject AuthService auth\n<p>@db.name</p>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("  static readonly inject = [\"db\", \"auth\"];\n"), "{}", g.code);
        assert!(g.code.contains("  readonly db: IDatabase;\n"), "{}", g.code);
        assert!(g.code.contains("  readonly auth: AuthService;\n"), "{}", g.code);
        assert!(g.code.contains("  constructor(db: IDatabase, auth: AuthService) { super(); this.db = db; this.auth = auth; }\n"), "{}", g.code);
        assert!(g.code.contains("__b.addContent(this.db.name);"), "{}", g.code);
        assert_eq!(g.to_src(g.code.find("IDatabase").unwrap()), Some(8));
        let plain = gen_with("<p/>", &[]);
        assert!(!plain.code.contains("constructor") && !plain.code.contains("inject"), "{}", plain.code);
    }

    #[test]
    fn inject_with_user_constructor_fails() {
        let src = "@inject A a\n@code { constructor() { super(); } }";
        let (doc, _) = parse(src).unwrap();
        let err = generate(&doc, "C", "C.xzor").unwrap_err();
        assert_eq!(err, ZDI08);
        assert_eq!(inject_constructor(&doc), src.find("constructor"));
    }

    #[test]
    fn slot_errors() {
        let err = |src: &str| generate(&parse(src).unwrap().0, "C", "C.xzor").unwrap_err();
        assert!(err("@slot:a\n@slot:a").contains("slot `a` is defined twice"));
        assert!(err("@slot\n@slot").contains("slot `default` is defined twice"));
        assert!(err("@slot:a(foo())").contains("write `(foo()) as Type`"));
        let err = |src: &str| gen_err(src, &[("Card", "<p/>")]);
        assert!(err("<Card>@slot a { x } @slot a { y }</Card>").contains("slot `a` is filled twice"));
        assert!(err("<Card><p/> @slot { y }</Card>").contains("slot `default` is filled twice"));
    }

    fn gen_err(src: &str, components: &[(&str, &str)]) -> String {
        let (doc, _) = parse(src).unwrap();
        let infos = components.iter().map(|(n, s)| (n.to_string(), component_info(s))).collect();
        generate_with(&doc, "C", "C.xzor", &infos, &HashSet::new(), "./routes").unwrap_err()
    }

    #[test]
    fn slot_usage_passes_lambdas() {
        let list = "@typeparam T\n@code { items: T[] = []; }\n@slot:item";
        let src = "@code { n = 1; xs = [\"a\"]; }\n<Card title=\"x\">\n  <p>@n</p>\n</Card>\n<List T=\"string\" items=\"@xs\">\n  @slot header { <b>h</b> }\n  @slot item(s, i: number = 0) { @s @n @i }\n</List>\n<Other />";
        let g = gen_with(src, &[("Card", "<p/>"), ("List", list)]);
        assert!(g.code.contains(r#"__b.addComponent(Card, { title: "x" }, { default: () => ComponentBase.fragment((__b) => { __b.openElement("p"); __b.addContent(this.n); __b.closeElement(); }) });"#), "{}", g.code);
        assert!(g.code.contains(r#"__b.addComponent(List<string>, { items: this.xs }, { header: () => ComponentBase.fragment((__b) => { __b.openElement("b"); __b.addText("h"); __b.closeElement(); }), item: (s, i: number = 0) => ComponentBase.fragment((__b) => { __b.addContent(s); __b.addText(" "); __b.addContent(this.n); __b.addText(" "); __b.addContent(i); }) });"#), "{}", g.code);
        assert!(g.code.contains("__b.addComponent(Other, {});"), "{}", g.code);
    }

    #[test]
    fn generic_component_without_type_args_infers_from_props() {
        let list = "@typeparam T\n@typeparam U = string\n@code { items: T[] = []; }\n@slot:item";
        let src = "@code { xs = [\"a\"]; }\n<List items=\"@xs\">\n  @slot item(x) { @x }\n</List>\n<List items=\"@xs\" />";
        let g = gen_with(src, &[("List", list)]);
        let infer = |p: &str| {
            let i = "infer T, infer U";
            format!("List<typeof {p} extends Partial<List<{i}>> ? T : unknown, typeof {p} extends Partial<List<{i}>> ? U : unknown>, {p}")
        };
        assert!(g.code.contains("const __p0 = { items: this.xs };"), "{}", g.code);
        assert!(g.code.contains(&format!("__b.addComponent({}, {{ item: (x) =>", infer("__p0"))), "{}", g.code);
        assert!(g.code.contains("const __p1 = { items: this.xs };"), "{}", g.code);
        assert!(g.code.contains(&format!("__b.addComponent({});", infer("__p1"))), "{}", g.code);
    }

    /// A literal-typed text prop (`depth?: "0" | "1"`) keeps its literal type in the hoisted object, so it
    /// does not widen to `string` and break the inference of every type parameter.
    #[test]
    fn hoisted_static_text_props_stay_literal() {
        let table = "@typeparam T\n@code { items: T[] = []; depth?: \"0\" | \"1\"; caption = \"\"; }";
        let src = "@code { xs = [1]; }\n<Table items=\"@xs\" depth=\"1\" caption=\"Rows of @xs.length\" />";
        let g = gen_with(src, &[("Table", table)]);
        assert!(g.code.contains("const __p0 = { items: this.xs, depth: \"1\" as const, caption: "), "{}", g.code);
        assert!(!g.code.contains("this.xs.length as const"), "{}", g.code);
    }

    #[test]
    fn explicit_type_args_and_plain_components_are_not_hoisted() {
        let list = "@typeparam T\n@code { items: T[] = []; }";
        let src = "@code { xs = [\"a\"]; }\n<List T=\"string\" items=\"@xs\" />\n<Card title=\"x\" />";
        let g = gen_with(src, &[("List", list), ("Card", "<p/>")]);
        assert!(g.code.contains("__b.addComponent(List<string>, { items: this.xs });"), "{}", g.code);
        assert!(g.code.contains("__b.addComponent(Card, { title: \"x\" });"), "{}", g.code);
        assert!(!g.code.contains("__p"), "{}", g.code);
    }

    #[test]
    fn key_and_ref() {
        let src = "@code { rows = [{ id: 1 }]; input?: HTMLInputElement; child?: Counter; }\n@for (const row of rows) {\n  <li @key=\"row.id\">x</li>\n  <Counter @key=\"row.id\" />\n}\n<input @ref=\"input\" />\n<Counter @ref=\"child\" label=\"a\" />\n<my-el @ref=\"input\" />";
        let g = gen_with(src, &[("Counter", "@code { label = \"\"; }")]);
        assert!(g.code.contains("__b.openElement(\"li\");\n      __b.setKey(row.id);"), "{}", g.code);
        assert!(g.code.contains("__b.addComponent(Counter, {}, undefined, { key: row.id });"), "{}", g.code);
        assert!(g.code.contains("__b.openElement(\"input\");\n    __b.setRef(\"input\", (__e) => { this.input = __e; });"), "{}", g.code);
        assert!(g.code.contains("__b.addComponent(Counter, { label: \"a\" }, undefined, { ref: (__c) => { this.child = __c; } });"), "{}", g.code);
        assert!(g.code.contains("__b.setRef(\"my-el\", (__e) => { this.input = __e; });"), "{}", g.code);
    }

    #[test]
    fn razor_template_syntax() {
        let src = "@inherits Base<number>\n@implements Named, Sized\n@attribute sealed\n@attribute tag(\"x\")\n@code { n = 1; items = [1]; extra = {}; stop = true; }\n@* gone *@\n<p>a@* also gone *@b</p>\n@{\n  const total = items.length + n;\n  const badge = <b>@total</b>;\n  <i>@total</i>\n  @: Count: @total!\n}\n@while (n < 3) { <u/> }\n<text>hi @total</text>\n<p @attributes=\"extra\" class=\"x\" @onsubmit:preventDefault @onclick:stopPropagation=\"stop\"></p>\n<Card @attributes=\"extra\" title=\"t\" />";
        let g = gen_with(src, &[("Card", "@code { title = \"\"; }")]);
        let has = |s: &str| assert!(g.code.contains(s), "missing {s:?} in\n{}", g.code);
        has("@sealed\n@tag(\"x\")\nexport default class C extends Base<number> implements Named, Sized {");
        assert!(!g.code.contains("gone"), "{}", g.code);
        has("__b.addText(\"ab\");");
        has("    const total = this.items.length + this.n;\n    const badge = ComponentBase.fragment((__b) => { __b.openElement(\"b\"); __b.addContent(total); __b.closeElement(); });\n    __b.openElement(\"i\"); __b.addContent(total); __b.closeElement();\n    __b.addText(\"Count: \"); __b.addContent(total); __b.addText(\"!\");");
        has("    __b.openRegion();\n    while (this.n < 3) {\n      __b.openElement(\"u\");\n      __b.closeElement();\n    }\n    __b.closeRegion();");
        has("__b.addText(\"hi \");\n    __b.addContent(total);");
        assert!(!g.code.contains("openElement(\"text\")"), "{}", g.code);
        has("__b.addAttributes(this.extra);\n    __b.addAttribute(\"class\", \"x\");\n    __b.addEventModifier(\"submit\", \"preventDefault\", true);\n    __b.addEventModifier(\"click\", \"stopPropagation\", this.stop);");
        has("__b.addComponent(Card, { ...this.extra, title: \"t\" });");
    }

    #[test]
    fn event_callbacks_and_binding() {
        let counter = "@code { onChange?: EventCallback<number>; onReset?: EventCallback; value = 0; valueChanged?: EventCallback<number>; }";
        let src = "@code { n = 1; name = \"\"; ok = false; save() {} }\n<Counter onChange=\"save\" onReset=\"() => n = 0\" @bind-value=\"n\" />\n<input @bind=\"name\" />\n<input type=\"checkbox\" @bind=\"ok\" @bind:event=\"oninput\" @bind:after=\"save\" />";
        let g = gen_with(src, &[("Counter", counter)]);
        assert!(g.code.contains("__b.addComponent(Counter, { onChange: __b.callback(this.save.bind(this)), onReset: __b.callback(() => this.n = 0), value: this.n, valueChanged: __b.callback((__v) => { this.n = __v; }) });"), "{}", g.code);
        assert!(g.code.contains("__b.addAttribute(\"value\", this.name);\n    __b.addEventHandler(\"change\", (__e) => { this.name = ComponentBase.bindValue(__e, this.name); });"), "{}", g.code);
        assert!(g.code.contains("__b.addAttribute(\"checked\", this.ok);\n    __b.addEventHandler(\"input\", (__e) => { this.ok = ComponentBase.bindValue(__e, this.ok); return this.save(); });"), "{}", g.code);
    }

    #[test]
    fn module_code_sits_before_the_class_without_this() {
        let src = "@module {\n  export const sizes = [\"s\", \"m\"];\n  const tag = (t: string) => <b>@t @sizes</b>;\n}\n@code { n = 0; }\n<p>@sizes.length @n @tag(\"x\")</p>";
        let g = gen_with(src, &[]);
        let module = g.code.find("export const sizes").expect(&g.code);
        assert!(module < g.code.find("export default class").unwrap(), "{}", g.code);
        assert!(g.code.contains("const tag = (t: string) => ComponentBase.fragment((__b) => {"), "{}", g.code);
        assert!(!g.code.contains("this.sizes") && !g.code.contains("this.tag"), "{}", g.code);
        assert!(g.code.contains("this.n"), "{}", g.code);
    }

    #[test]
    fn dom_event_syntax_on_a_component_sets_its_callback() {
        let counter = "@code { onChange?: EventCallback<number>; label = \"\"; }";
        let g = gen_with("@code { save() {} }\n<Counter @onchange=\"save\" />", &[("Counter", counter)]);
        assert!(g.code.contains("__b.addComponent(Counter, { onChange: __b.callback(this.save.bind(this)) });"), "{}", g.code);
        let doc = parse("<Counter @onlabel=\"x\" />").unwrap().0;
        let infos = HashMap::from([("Counter".to_string(), component_info(counter))]);
        let err = generate_with(&doc, "C", "C.xzor", &infos, &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("has no EventCallback prop for @onlabel"), "{err}");
    }

    #[test]
    fn typeparam_makes_a_generic_class() {
        let (doc, _) = parse("@typeparam T extends object\n@typeparam U\n<p/>").unwrap();
        let g = generate(&doc, "Grid", "Grid.xzor").unwrap();
        assert!(g.code.contains("export default class Grid<T extends object, U> extends ComponentBase {"), "{}", g.code);
    }

    #[test]
    fn fine_components_build_the_dom_once_with_bindings() {
        let src = "@fine\n@code {\ncount = 0;\nlabel = \"\";\nok = false;\nteam: Worker[] = [];\nel?: HTMLElement;\ninc() { this.count++; }\n}\n<div class=\"team\" title=\"n @label\">\n<button @onclick=\"inc\" @ref=\"el\">@count</button>\n<input @bind=\"label\" @bind:event=\"oninput\" />\n<input type=\"checkbox\" @bind=\"ok\" />\n@if (count > 1) {\n<p>many</p>\n} else {\n<p>few</p>\n}\n@for (const w of team) {\n<li>@w.name <b>@(w.hours * 2)</b></li>\n}\n@for (let i = 0; i < count; i++) {\n<i>@i</i>\n}\n@for (const [k, v] of Object.entries(team)) {\n@if (v) {\n<u>@k</u>\n}\n}\n@{ const total = count * 2; }\n<span>@total</span>\n</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("import { FineComponent, fine, type El } from \"@source-crafter/xzor-runtime/model\";");
        has("export default class C extends FineComponent {");
        has("__b.addFine((__p) => {");
        // Elements and static text are a template, cloned; each dynamic part binds the node it has in place.
        has("const __t0 = fine.template([[\"div\", [\"class\", \"team\"], [\"button\", 0, \"\"], [\"input\", 0], [\"input\", [\"type\", \"checkbox\"]], null, null, null, null, null, null, null]]);");
        has("const _e0 = __t0() as El<\"div\">;\n      const _e1 = _e0.firstChild! as El<\"button\">;\n      const _e2 = _e1.firstChild! as Text;\n      const _e3 = _e1.nextSibling! as El<\"input\">;");
        has("fine.attr(_e0, \"title\", () => \"n \" + String(this.label));");
        has("fine.on(_e1, \"click\", this.inc.bind(this));");
        has("this.el = _e1;");
        has("fine.textAt(_e2, () => this.count);");
        has("fine.attr(_e3, \"value\", () => this.label);");
        has("fine.on(_e3, \"input\", (__e) => { this.label = ComponentBase.bindValue(__e, this.label); });");
        has("fine.attr(_e4, \"checked\", () => this.ok);");
        has("fine.on(_e4, \"change\", (__e) => { this.ok = ComponentBase.bindValue(__e, this.ok); });");
        has("fine.branchAt(_e5, (__p) => {\n        if (this.count > 1) {\n          if (!__p) return 0;\n          const _e10 = __t1() as El<\"p\">;\n          __p.appendChild(_e10);");
        // A row's bindings share the list's reads, which take the item.
        has("fine.listAt(_e6, () => this.team, [\n        (w) => w.name,\n        (w) => w.hours * 2,\n      ], (__p) => {\n        const _e12 = __t3() as El<\"li\">;");
        has("fine.textItem(_e13, 0);");
        has("fine.textItem(_e15, 1);");
        has("const __t3 = fine.template([[\"li\", 0, \"\", \" \", [\"b\", 0, \"\"]]]);");
        has("for (let i = 0; i < this.count; i++) {");
        has("fine.textAt(_e17, () => i);");
        // Destructured items (entries, tuples) are new on every run: a keyed list would rebuild every row.
        has("for (const [k, v] of Object.entries(this.team)) {");
        assert!(!g.code.contains("[k, v]) =>"), "{}", g.code);
        // Keyed by a pass counter: a pass that saw the same `k` and `v` keeps its row, and its `@if` is a region.
        has("for (const [k, v] of Object.entries(this.team)) {\n          const __p = __pass(__i++, [k, v]);");
        // A `@{ }` block and the siblings after it are one region: its locals stay in scope and current.
        has("fine.regionAt(_e9, (__p) => {\n        const total = this.count * 2;");
        has("() => total);");
        has("__p.appendChild(_e0);");
        assert!(!g.code.contains("__b.openElement"), "{}", g.code);
    }

    #[test]
    fn async_components_load_on_first_use_and_cached_ones_say_so() {
        let chart = "@async\n@code { label = \"\"; }\n<p>@label</p>";
        let g = gen_with("@render\n@import Chart from \"./Chart.xzor\"\n@cached\n<Chart label=\"x\" />", &[("Chart", chart)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("import { ComponentBase, lazy, type RenderTreeBuilder } from \"@source-crafter/xzor-runtime\";");
        // The class stays a type for the props; the tree gets its loader.
        has("import type Chart from \"./Chart.xzor\";\nconst __lazy_Chart = lazy<typeof Chart>(() => import(\"./Chart.xzor\"));");
        has("__b.addComponent(__lazy_Chart, { label: \"x\" });");
        has("static readonly cached = true;");
    }

    #[test]
    fn fine_getters_are_cached_unless_volatile() {
        let src = "@fine\n@code {\n  n = 1;\n  get total(): number { return this.n * 2; }\n  @Volatile get now(): number { return Date.now(); }\n  static get shared(): number { return 1; }\n  set total2(v: number) {}\n}\n<p>@total @now</p>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("static { fine.memo(this, [\"total\"]); }"), "{}", g.code);
        assert!(!g.code.contains("@Volatile"), "{}", g.code);
        let g = gen_with("@render\n@code { get total(): number { return 1; } }\n<p/>", &[]);
        assert!(!g.code.contains("fine.memo"), "{}", g.code);
    }

    #[test]
    fn await_blocks_show_pending_then_and_catch() {
        let src = "@fine\n@code { q = \"\"; load(q: string): Promise<string[]> { return Promise.resolve([q]); } }\n<ul>@await (load(q)) {<li>…</li>} then (rows) {@for (const r of rows) {<li>@r</li>}} catch (e) {<li>@String(e)</li>}</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("fine.awaitCallAt(_e1, () => [this.q], (__a0) => this.load(__a0), (__p) => {");
        has("}, (__p, rows) => {");
        has("fine.listAt(");
        has("}, (__p, e) => {");
        has("() => String(e)");
        // Arguments with nested calls, strings and commas; a callee through a member chain.
        let g = gen_with("@fine\n@code { q = \"\"; api = { find: (a: string, b: number[]) => Promise.resolve(a) }; }\n@await (api.find(q.trim(), [1, 2])) {} then (v) {@v}", &[]);
        assert!(g.code.contains("fine.awaitCallAt(_e0, () => [this.q.trim(), [1, 2]], (__a0, __a1) => this.api.find(__a0, __a1), "), "{}", g.code);
        // Anything else, or a call without arguments, runs whole on every change.
        for promise in ["load()", "q ? load(q) : load(\"\")", "load(q).then((r) => r)", "load(...qs)", "load(`${q}`)"] {
            let g = gen_with(&format!("@fine\n@code {{ q = \"\"; qs: string[] = []; load(...a: string[]) {{ return Promise.resolve(a); }} }}\n@await ({promise}) {{}}"), &[]);
            assert!(g.code.contains("fine.awaitAt(") && !g.code.contains("awaitCallAt"), "{promise}:\n{}", g.code);
        }
        let doc = parse("@render\n@await (p) { } then { }").unwrap().0;
        let err = generate_with(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("@await can't go inside a component's content"), "{err}");
    }

    #[test]
    fn leave_marks_the_element() {
        let src = "@code { open = true; }\n@if (open) {<dialog @leave>x</dialog>}";
        let g = gen_with(&format!("@fine\n{src}"), &[]);
        assert!(g.code.contains("[\"dialog\", [\"data-leave\", \"\"], \"x\"]"), "{}", g.code);
        assert!(g.code.contains("ComponentBase.$leaves = true;"), "{}", g.code);
        let g = gen_with(&format!("@render\n{src}"), &[]);
        assert!(g.code.contains("__b.addAttribute(\"data-leave\", \"\");"), "{}", g.code);
        assert!(g.code.contains("ComponentBase.$leaves = true;"), "{}", g.code);
        assert!(!gen_with("@code { open = true; }\n<p>x</p>", &[]).code.contains("$leaves"));
    }

    #[test]
    fn class_toggles() {
        let src = "@code { err = \"\"; }\n<div class=\"field\" class:invalid=\"@err\" class:round>x</div>";
        let g = gen_with(&format!("@fine\n{src}"), &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The static class stays in the template; each toggle is its own binding.
        has("[\"div\", [\"class\", \"field\"], \"x\"]");
        has("fine.attr(_e0, \"class:invalid\", () => this.err);");
        has("fine.attr(_e0, \"class:round\", () => true);");
        let g = gen_with(&format!("@render\n{src}"), &[]);
        // After the element's own class, whatever the order they were written in.
        assert!(g.code.contains("__b.addAttribute(\"class\", \"field\");\n    __b.toggleClass(\"invalid\", this.err);\n    __b.toggleClass(\"round\", true);"), "{}", g.code);
    }

    #[test]
    fn bind_debounce_waits_for_a_pause() {
        let src = "@code { q = \"\"; filter() {} }\n<input @bind:input=\"q\" @bind:debounce=\"300\" @bind:after=\"filter\" />";
        for mode in ["@render\n", "@fine\n"] {
            let g = gen_with(&format!("{mode}{src}"), &[]);
            // The value shown stays bound; the write back waits, and its promise re-renders after it.
            assert!(g.code.contains("(__e) => ComponentBase.debounce(__e, 300, () => { this.q = ComponentBase.bindValue(__e, this.q); return this.filter(); })"), "{}", g.code);
        }
        let err = generate_with(&parse("<input @bind=\"q\" @bind:debounce=\"soon\" />").unwrap().0, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("@bind:debounce requires milliseconds"), "{err}");
    }

    #[test]
    fn bind_input_is_bind_on_input() {
        let src = "@code { q = \"\"; }\n<input @bind:input=\"q\" />";
        for (mode, attr, on) in [("@render\n", "__b.addAttribute(\"value\", this.q);", "__b.addEventHandler(\"input\", "), ("@fine\n", "fine.attr(", "fine.on(_e0, \"input\", ")] {
            let g = gen_with(&format!("{mode}{src}"), &[]);
            let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
            has(attr);
            has(&format!("{on}(__e) => {{ this.q = ComponentBase.bindValue(__e, this.q); }}"));
        }
    }

    #[test]
    fn once_builds_without_bindings() {
        let src = "@fine\n@code { n = 0; xs: string[] = []; show = true; }\n<p>at @once(n) now @n</p>\n@if (show) {\n@once {\n<b title=\"@n\">@n</b>\n@for (const x of xs) {<i>@x</i>}\n}\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // A value read once into its hole; the other `@n` stays bound.
        has("fine.textOnce(_e2, () => this.n);");
        has("fine.textAt(_e3, () => this.n);");
        // A block built once: plain control flow, values set, no binding inside.
        has("fine.onceAt(");
        has("fine.set(_e");
        has("fine.setText(_e");
        has("for (const x of this.xs) {");
        let block = &g.code[g.code.find("fine.onceAt(").unwrap()..];
        assert!(!block[..block.find("});\n").unwrap()].contains("fine.textAt"), "{}", g.code);
        // A render pass has no \"once\": the block renders as usual.
        let g = gen_with("@render\n@code { n = 0; }\n<p>@once(n)</p>", &[]);
        assert!(g.code.contains("__b.addContent(this.n);"), "{}", g.code);
    }

    #[test]
    fn parent_attributes_set_the_enclosing_element() {
        let g = gen_with("@render\n@code { n = 0; }\n<span>@if (n > 0) { @n } else { @attr:class=\"error-text @n\" none }</span>", &[]);
        assert!(g.code.contains("__b.addParentAttribute(\"class\", \"error-text \" + String(this.n));"), "{}", g.code);
        let src = "@fine\n@code { n = 0; items: string[] = []; }\n<span>@if (n > 0) { @n } else { @attr:class=\"error-text\" none }</span>\n<ul>@for (const it of items) {<li>@if (it) { @attr:title=\"@it\" }</li>}</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("fine.attrOf(_e1, \"class\", () => \"error-text\");");
        // In a row, a region naming the row's element builds in the row, not in the list's shared reads.
        has("fine.branchAt(");
        has("fine.attrOf(_e");
        has(", \"title\", () => it);");
        let doc = parse("@fine\n@attr:class=\"x\"").unwrap().0;
        let err = generate_with(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("@attr:class needs an enclosing element"), "{err}");
    }

    #[test]
    fn loops_render_their_else_when_no_pass_ran() {
        let g = gen_with("@code { xs: number[] = []; n = 0; }\n@for (const x of xs) {<i>@x</i>} else {<p>none</p>}\n@while (n < 0) { <b/> } else { <u/> }", &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("{\n      let __none = true;\n      for (const x of this.xs) {\n        __none = false;");
        has("if (__none) {\n        __b.openElement(\"p\");");
        has("while (this.n < 0) {\n        __none = false;");
    }

    #[test]
    fn fine_loops_render_their_else_when_no_pass_ran() {
        let src = "@fine\n@code { xs: string[] = []; }\n<ul>\n@for (const x of xs) {\n<li>@x</li>\n} else {\n<li>@xs.length</li>\n}\n</ul>\n@for (let i = 0; i < xs.length; i++) {\n<b>@i</b>\n} else {\n<u/>\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The else is the list's empty build: its bindings close over their values, as in a region.
        has("], (__p) => {\n        const _e");
        has("}, (__p) => {\n        const _e");
        has("fine.textAt(");
        has("for (let i = 0; i < this.xs.length; i++) {\n          const __p = __pass(__i++, [i]);\n          if (__p !== undefined) {");
        has("}, (__p) => {\n        const _e10 = __t4() as El<\"u\">;");
    }

    #[test]
    fn fine_loops_key_their_passes() {
        let src = "@fine\n@code {\n  @Key(\"sku\") lines: { sku: string; qty: number }[] = [];\n  team: Record<string, number> = {};\n  n = 0;\n}\n<ul>@for (const l of lines.filter((x) => x.qty > 0)) {<li>@l.sku</li>}</ul>\n<ol>@for (const [k, v] of Object.entries(team)) {<li>@k @if (v > 1) {<b>many</b>}</li>} else {<p>none</p>}</ol>\n<p>@for (let i = 0; i < n; i++) @key(i * 2) {<i>@i</i>}</p>\n@for (const r of lines) @key(r.sku + r.qty) {<s>@r.sku</s>}\n@for (const [a, b] of Object.entries(team)) { @{ const c = b; } <u>@a @c</u> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The field's `@Key` keys the loops over it, through array methods that keep its items.
        has("}, undefined, (l) => l.sku);");
        assert!(!g.code.contains("@Key"), "{}", g.code);
        // No key: a pass counter; the row's nested `@if` is a region of its own.
        has("fine.keyedAt(");
        has("let __i = 0;");
        has("for (const [k, v] of Object.entries(this.team)) {");
        has("const __p = __pass(__i++, [k, v]);\n");
        has("}, (__p) => {");
        has("if (v > 1) {");
        // That `@if` reads only the pass's values, which the row is kept by: built with the row, appended to its `<li>`.
        let at = g.code.find("if (v > 1) {").unwrap();
        assert!(!g.code[at - 80..at].contains("regionAt"), "{}", g.code);
        assert!(!g.code.contains(".replaceWith("), "{}", g.code);
        // `@key(expr)` on the loop.
        has("const __p = __pass(i * 2, [i]);");
        has("}, undefined, (r) => r.sku + r.qty);");
        // A pass running `@{ }` code is not skipped: that loop rebuilds whole.
        has("for (const [a, b] of Object.entries(this.team)) {\n");
        assert!(!g.code.contains("__pass(__i++, [a, b])"), "{}", g.code);
    }

    #[test]
    fn a_lone_control_flow_block_takes_its_place_without_a_template() {
        let src = "@fine\n@code { items: { done: boolean }[] = []; team: Record<string, number> = {}; sel = \"\"; }\n<ul>@for (const it of items) {@if (it.done) {<li>done</li>}}</ul>\n<ol>@for (const [k, v] of Object.entries(team)) {@if (sel === k) {<li>@k</li>}}</ol>\n<div>@for (const [k, v] of Object.entries(team)) {@if (v > 1) {<b>@k</b>}}</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // No two-comment templates: the anchors go straight in.
        assert!(!g.code.contains("fine.template([null, null])") && !g.code.contains("fine.template([null])"), "{}", g.code);
        has("= fine.anchors(__p);\n");
        // A keyed loop only needs its end: one anchor in its element's template.
        has("[\"ol\", 0, null]");
        // A row that is only a pass-only `@if` builds it straight into the row.
        has("const __p = __pass(__i++, [k, v]);\n          if (__p !== undefined) {\n            if (v > 1) {");
        // A member of a pass value can change while the value stays: `t.done` and `else if` conditions keep a region.
        let g = gen_with("@fine\n@code { m: Record<string, { done: boolean }> = {}; }\n<ol>@for (const [k, t] of Object.entries(m)) {@if (k === \"a\") {<b/>} else if (t.done) {<i/>}}</ol>", &[]);
        assert!(g.code.contains("fine.branchAt("), "{}", g.code);
    }

    #[test]
    fn fine_nested_flow_in_a_region_gets_its_own_regions_and_lists() {
        let src = "@fine\n@code { open = false; items = [\"a\"]; text = \"\"; }\n@if (open) {\n<dialog>\n<input @bind=\"text\" />\n@if (text.length > 2) {\n<p>long</p>\n}\n<ul>\n@for (const it of items) {\n<li>@it</li>\n}\n</ul>\n</dialog>\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The outer region only reads `open`: the nested `@if` and `@for` bind on their own.
        has("fine.branchAt(_e0, (__p) => {\n        if (this.open) {\n          if (!__p) return 0;\n          const _e1 = __t0() as El<\"dialog\">;");
        has("fine.branchAt(_e3, (__p) => {\n            if (this.text.length > 2) {");
        has("fine.listAt(_e5, () => this.items, [\n            (it) => it,\n          ], (__p) => {");
        assert!(!g.code.contains("for (const it of"), "{}", g.code);
    }

    #[test]
    fn show_blocks_hide_their_branches_and_pause_what_asks() {
        let src = "@fine\n@code { tab = \"a\"; n = 1; }\n@show:if (tab === \"a\") {\n<p>@n</p>\n} else {\n@pause\n<section>@n</section>\n}\n<div>@show:switch (n) { case 1: <b>one</b> default: <i>@pause { <u>@n</u> }</i> }</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("fine.showAt(_e1, (__p) => {\n        if (this.tab === \"a\") {\n          if (!__p) return 0;\n");
        has("} else {\n          if (!__p) return 1;\n");
        has("        }\n        return 2;\n      });");
        // Bare `@pause` takes the whole branch; `@pause { }` its block, at any depth.
        assert_eq!(g.code.matches("fine.pauseAt(").count(), 2, "{}", g.code);
        has("case 1: {\n            if (!__p) return 0;\n");
        let err = |src: &str| generate_with(&parse(&format!("@fine\n@code {{ a = 1; }}\n{src}")).unwrap().0, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        for top in ["text", "@a", "@if (a) {<b/>}", "<Child />"] {
            assert!(err(&format!("@show:if (a) {{ {top} }}")).contains("wrap it in an element"), "{top}");
        }
        assert!(err("@show:if (a) { <b/> @pause <i/> }").contains("bare @pause goes first in a @show branch"));
        assert!(err("<p>@pause { <b/> }</p>").contains("@pause belongs in a @show:if or @show:switch branch"));
        let doc = parse("@render\n@code { a = 1; }\n@show:if (a) { <b/> }").unwrap().0;
        let e = generate_with(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(e.contains("can't go inside a component's content"), "{e}");
    }

    #[test]
    fn fine_if_and_switch_rebuild_only_when_their_branch_changes() {
        let src = "@fine\n@code { count = 3; list: { id: number }[] = []; kind = \"a\"; }\n@if (!count) {\n<p>none</p>\n} else if (count > 9) {\n<b>many</b>\n} else {\n<ul>@for (const n of list) @key(n.id) {<li>@n.id</li>}</ul>\n}\n@switch (kind) { case \"a\": case \"b\": <i>ab</i> default: <u>other</u> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // Called without a parent it only picks the branch: same branch, same DOM.
        has("fine.branchAt(_e1, (__p) => {\n        if (!this.count) {\n          if (!__p) return 0;\n");
        has("} else if (this.count > 9) {\n          if (!__p) return 1;\n");
        has("} else {\n          if (!__p) return 2;\n");
        has("        }\n        return 3;\n      });");
        has("case \"b\": {\n            if (!__p) return 0;\n");
        has("default: {\n            if (!__p) return 1;\n");
        has("        }\n        return 2;\n      });");
        // Code run while a branch builds would go stale in a kept branch: that one stays a plain region.
        let g = gen_with("@fine\n@code { n = 1; }\n@if (n > 0) {\n@{ const twice = n * 2; }\n<p>@twice</p>\n}", &[]);
        assert!(g.code.contains("fine.regionAt(") && !g.code.contains("branchAt"), "{}", g.code);
        // A row's `@if` picks its branch from the row's item, so a row that takes a new item keeps it too.
        let g = gen_with("@fine\n@code { lines: { qty: number }[] = []; }\n<ul>@for (const l of lines) {<li>@if (l.qty > 1) {<b/>} else {<i/>}</li>}</ul>", &[]);
        assert!(g.code.contains("fine.branchItem(") && g.code.contains("(l, __p) => {\n"), "{}", g.code);
        assert!(g.code.contains("if (!__p) return 0;"), "{}", g.code);
    }

    #[test]
    fn fine_rows_share_their_reads_and_handlers() {
        let src = "@fine\n@code { team: Worker[] = []; pick(w: Worker) {} }\n<ul>\n@for (const w of team) {\n<li class=\"@w.kind\" @onclick=\"() => pick(w)\"><input @bind=\"w.name\" />@if (w.late) {\n<b>@w.name</b>\n}\n<i @onclick=\"pick\">@team.length</i></li>\n}\n</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("fine.listAt(_e1, () => this.team, [\n        (w) => w.kind,\n        (w): ((e: any) => unknown) => () => this.pick(w),\n        (w) => w.name,\n        (w): ((e: any) => unknown) => (__e) => { w.name = ComponentBase.bindValue(__e, w.name); },\n        (w, __p) => {\n          if (w.late) {");
        // A read that does not use the item does not name it.
        has("(_): ((e: any) => unknown) => this.pick.bind(this),\n        (_) => this.team.length,\n      ], (__p) => {");
        has("fine.attrItem(_e2, \"class\", 0);");
        has("fine.onItem(_e2, \"click\", 1);");
        has("fine.attrItem(_e3, \"value\", 2);");
        has("fine.onItem(_e3, \"change\", 3);");
        has("fine.branchItem(_e4, 4);");
        // Inside the row's region, bindings close over the item as usual.
        has("fine.textAt(_e8, () => w.name);");
    }

    #[test]
    fn fine_components_put_the_rest_in_islands() {
        let card = "@code { title = \"\"; }\n<section>@title</section>";
        let src = "@fine\n@code { n = 1; show = true; extra = {}; }\n<div>\n<Card title=\"@(n)\"><b>@n</b></Card>\n<p @onclick:preventDefault @onclick=\"() => n++\">x</p>\n<p @attributes=\"extra\" />\n@cascade:theme(n) { <i>@n</i> }\n@slot\n@if (show) {\n<Card />\n}\n</div>";
        let g = gen_with(src, &[("Card", card)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // A lone island needs no template: its anchor goes straight into the region's fragment.
        has("const _e7 = fine.anchor(__p);\n          fine.islandAt(_e7, (__b) => { __b.addComponent(Card, {}); });");
        has("fine.islandAt(_e1, (__b) => { __b.addComponent(Card, { title: this.n }, { default: () => ComponentBase.fragment((__b) => { __b.openElement(\"b\"); __b.addContent(this.n); __b.closeElement(); }) }); });");
        has("fine.islandAt(_e2, (__b) => { __b.openElement(\"p\"); __b.addEventModifier(\"click\", \"preventDefault\", true);");
        has("fine.islandAt(_e3, (__b) => { __b.openElement(\"p\"); __b.addAttributes(this.extra);");
        has("fine.islandAt(_e4, (__b) => { __b.openCascade(\"theme\", this.n);");
        has("fine.islandAt(_e5, (__b) => { __b.addContent(this.slots.default?.() ?? null); });");
    }

    #[test]
    fn source_map_points_back_to_the_xzor() {
        let src = "@code {\n  n = 1;\n}\n<p>@n</p>";
        let (doc, _) = parse(src).unwrap();
        let g = generate(&doc, "C", "C.xzor").unwrap();
        let map = crate::json::Json::parse(&g.source_map(src, "C.xzor")).unwrap();
        assert_eq!(map["version"].as_usize(), Some(3));
        assert_eq!(map["sources"][0].as_str(), Some("C.xzor"));
        assert_eq!(map["sourcesContent"][0].as_str(), Some(src));
        let segments = decode_mappings(map["mappings"].as_str().unwrap());
        let lookup = |needle: &str, delta: usize| {
            let (line, col) = crate::lsp::position_at(&g.code, g.code.find(needle).unwrap() + delta);
            segments.iter().rev().find(|s| s.0 == line && s.1 <= col).and_then(|s| s.2).map(|(l, c)| (l, c + (col - segments.iter().rev().find(|s| s.0 == line && s.1 <= col).unwrap().1)))
        };
        assert_eq!(lookup("n = 1;", 0), Some((1, 2)));
        assert_eq!(lookup("this.n);", 5), Some((3, 4)));
        assert_eq!(lookup("__b.openElement", 0), None);
    }

    #[test]
    fn cascade_blocks_open_a_cascade_region() {
        let src = "@code { theme = \"dark\"; }\n@cascade:theme(theme) { <b/> }\n@cascade:cfg(1, fixed) { <i/> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "missing {s:?} in\n{}", g.code);
        // The body is a JS block so that siblings can declare the same `@{ const }` names.
        has("    __b.openCascade(\"theme\", this.theme);\n    {\n      __b.openElement(\"b\");\n      __b.closeElement();\n    }\n    __b.closeRegion();");
        has("    __b.openCascade(\"cfg\", 1, true);");
        let at = src.find("(theme)").unwrap() + 1;
        assert!(g.mappings.iter().any(|m| m.src == at && m.len == "theme".len()), "the value is mapped\n{:?}", g.mappings);
        let at = src.find("@cascade:theme").unwrap() + "@cascade:".len();
        assert!(g.mappings.iter().any(|m| m.src == at && m.len == "theme".len()), "the name is mapped\n{:?}", g.mappings);
    }

    #[test]
    fn cascade_decorators_become_a_static_list() {
        let src = "@code {\n  @Cascade theme!: string;\n  @Cascade(\"route\") r?: unknown;\n  note = \"@Cascade x\";\n  // @Cascade y\n  /* @Cascade z */\n}\n<p>@theme</p>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "missing {s:?} in\n{}", g.code);
        has("  static readonly cascades: readonly (readonly [string, string])[] = [[\"theme\", \"theme\"], [\"r\", \"route\"]] as const;\n");
        has(" theme!: string;\n");
        has(" r?: unknown;\n");
        has("  note = \"@Cascade x\";\n");
        has("  // @Cascade y\n");
        has("  /* @Cascade z */\n");
        has("__b.addContent(this.theme);");
        assert_eq!(g.code.matches("@Cascade").count(), 3, "{}", g.code);
        assert_eq!(collect_members("@Cascade theme!: string;\n@Cascade(\"route\") r?: unknown;"), ["theme", "r"]);
    }

    #[test]
    fn inherited_cascades_extend_the_base_list() {
        let g = gen_with("@inherits Base<T>\n@code { @Cascade role!: string; }\n<p/>", &[]);
        assert!(
            g.code.contains(
                "  static readonly cascades: readonly (readonly [string, string])[] = [...((Base as { cascades?: readonly (readonly [string, string])[] }).cascades ?? []), [\"role\", \"role\"]] as const;\n"
            ),
            "{}",
            g.code
        );
        let plain = gen_with("@inherits Base\n@code { n = 1; }\n<p/>", &[]);
        assert!(!plain.code.contains("cascades"), "{}", plain.code);
    }

    #[test]
    fn cascade_decorator_errors_point_at_the_decorator() {
        let err = |member: &str| {
            let src = format!("@code {{\n  {member}\n}}\n<p/>");
            let (doc, _) = parse(&src).unwrap();
            let (message, offset) = cascade_error(&doc).unwrap_or_else(|| panic!("no error for {member}"));
            assert_eq!(offset, src.find("@Cascade").unwrap(), "{member}");
            assert_eq!(gen_err(&src, &[]), message, "{member}");
            message
        };
        let field_only = "@Cascade applies to instance fields only";
        assert_eq!(err("@Cascade get theme(): string { return \"\"; }"), field_only);
        assert_eq!(err("@Cascade set theme(v: string) {}"), field_only);
        assert_eq!(err("@Cascade theme(): string { return \"\"; }"), field_only);
        assert_eq!(err("@Cascade static route = \"r\";"), field_only);
        let one_name = "@Cascade takes one string literal name";
        assert_eq!(err("@Cascade(\"a\", \"b\") r?: unknown;"), one_name);
        assert_eq!(err("@Cascade(\"a\" + \"b\") r?: unknown;"), one_name);
        assert_eq!(err("@Cascade(name) r?: unknown;"), one_name);
        assert_eq!(err("@Cascade() r?: unknown;"), one_name);
        let (doc, _) = parse("@code { @Cascade('route') r?: unknown; }\n<p/>").unwrap();
        assert_eq!(cascade_error(&doc), None);
        assert!(generate(&doc, "C", "C.xzor").unwrap().code.contains("[[\"r\", \"route\"]]"));
    }

    #[test]
    fn helpers() {
        assert_eq!(js_string("a\"b\\\n"), r#""a\"b\\\n""#);
        assert_eq!(class_name("my-counter"), "mycounter");
        assert_eq!(class_name("1x"), "_1x");
    }
}
