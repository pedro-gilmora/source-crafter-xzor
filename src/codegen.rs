//! Lowers a parsed `.xzor` document into a TypeScript component class, the
//! way Razor lowers `.razor` into a C# class with a render method.

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
    /// The injects (by name) typed `Remote<...>` because their type is a contract.
    pub remotes: Vec<String>,
    /// `@page` routes, with their params typed from the props.
    pub routes: Vec<RouteInfo>,
    /// The `@Routes` block, if any.
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
#[derive(Default, Clone)]
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
    /// `EventCallback<T>`: the handler runs the passing component's after-handler pass.
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
    generate_in(doc, class_name, source_name, components, inherited, table, &HashSet::new())
}

/// `generate_with`, typing an `@inject` of a name in `contracts` as `Remote<name>`.
pub fn generate_in(
    doc: &Document,
    class_name: &str,
    source_name: &str,
    components: &HashMap<String, ComponentInfo>,
    inherited: &HashSet<String>,
    table: &str,
    contracts: &HashSet<String>,
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
    // A component's own instance getters, cached unless `@Volatile`.
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
            if getter && !volatile && !m.is_static && !m.name.starts_with('#') && !memos.contains(&m.name) {
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
        raw_text: false,
        props_ids: std::cell::Cell::new(0),
        route_types: std::cell::Cell::new(0),
        node_ids: 0,
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
        uses_props: false,
        row_roots: Vec::new(),
        ownerless: false,
        sites: 0,
        in_markup: false,
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
            g.line(&format!("const __lazy_{name} = __lazy<typeof {name}>(() => import({}));", js_string(spec)));
            continue;
        }
        g.emit(M::lit("import ").add(M::src(import, import.at)).lit_then(";"));
    }
    g.line("");
    let sites_at = g.out.len();
    if block.is_some_and(decodes_segments) {
        for line in crate::routes::DECODE.lines() {
            g.line(line);
        }
        g.line("");
    }
    if let Some(parts) = &doc.module {
        g.ownerless = true;
        let block = g.code_block(parts, &[]);
        g.ownerless = false;
        g.emit_block(block?);
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
        None => M::lit("__Component"),
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
    if !doc.type_params.is_empty() {
        g.uses_props = true;
        // Types only: callers infer the type arguments from a props object as a call would, under the constraints written here.
        let decls: Vec<&str> = doc.type_params.iter().map(|t| &**t).collect();
        let names: Vec<&str> = decls.iter().map(|d| d.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).next().unwrap_or_default()).collect();
        g.line(&format!("declare static readonly $fit: <{}>(p: __Props<{class_name}<{}>>) => void;", decls.join(", "), names.join(", ")));
    }
    if !memos.is_empty() {
        let names: Vec<String> = memos.iter().map(|n| js_string(n)).collect();
        g.line(&format!("static {{ __dom.memo(this, [{}]); }}", names.join(", ")));
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
    let remote = |i: &Inject| contracts.contains(i.ty.trim());
    let remotes: Vec<String> = doc.injects.iter().filter(|i| remote(i)).map(|i| i.name.text.clone()).collect();
    if !doc.injects.is_empty() {
        let names: Vec<String> = doc.injects.iter().map(|i| js_string(&i.name)).collect();
        g.line(&format!("static readonly inject = [{}];", names.join(", ")));
        for i in &doc.injects {
            let field = M::lit("readonly ").add(M::src(&i.name, i.name.at)).lit_then(": ");
            g.emit(if remote(i) {
                field.lit_then("Remote<").add(M::src(&i.ty, i.ty.at)).lit_then(">;")
            } else {
                field.add(M::src(&i.ty, i.ty.at)).lit_then(";")
            });
        }
        let params: Vec<String> = doc.injects.iter().map(|i| if remote(i) { format!("{}: Remote<{}>", i.name, i.ty) } else { format!("{}: {}", i.name, i.ty) }).collect();
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
    g.line("protected override render(__p: Node): void {");
    g.depth = 2;
    g.emit_nodes(&doc.nodes, "__p")?;
    g.depth = 1;
    g.line("}");
    g.depth = 0;
    g.line("}");
    if !g.templates.is_empty() {
        g.line("");
        for (i, spec) in std::mem::take(&mut g.templates).iter().enumerate() {
            g.line(&format!("const __t{i} = __dom.template([{spec}]);"));
        }
    }
    // Before the class: a static member's or the module's markup reads its site as it is defined.
    if g.sites > 0 {
        let consts: String = (0..g.sites).map(|i| format!("const __s{i} = {{}};\n")).collect::<String>() + "\n";
        g.out.insert_str(sites_at, &consts);
        for m in g.mappings.iter_mut().filter(|m| m.out >= sites_at) {
            m.out += consts.len();
        }
    }
    // Removal looks for `data-leave` only once a component that sets it is loaded.
    if g.out[head_at..].contains("data-leave") {
        g.line("__Component.$leaves = true;");
    }
    let types = g.route_types.get();
    let mut names = vec!["Component as __Component", "dom as __dom"];
    if uses_lazy {
        names.push("lazy as __lazy");
    }
    if g.uses_el {
        names.push("type El");
    }
    if g.uses_props {
        names.push("type Props as __Props");
    }
    if !remotes.is_empty() {
        names.push("type Remote");
    }
    if !slots.is_empty() {
        names.push("type RenderFragment");
    }
    if types & ROUTE_FRAGMENT != 0 {
        names.push("type Markup as __Markup");
    }
    if types & ROUTE_TYPE != 0 {
        names.push("type Route");
    }
    let mut head = format!("import {{ {} }} from \"@source-crafter/xzor-runtime\";\n", names.join(", "));
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
    Ok(Generated { code: g.out, mappings: g.mappings, injects, remotes, routes, routes_block, deps: Vec::new(), warnings: Vec::new(), css: None })
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

/// What the route table needs to know about a block: the tags its sections claim.
fn block_info(node: &Node) -> Option<crate::routes::RoutesBlockInfo> {
    let Node::Routes { var, sections } = node else { return None };
    let sections = sections
        .iter()
        .filter_map(|s| match &s.kind {
            RouteSectionKind::Tag { tag, .. } => Some((tag.text.clone(), tag.at)),
            _ => None,
        })
        .collect();
    Some(crate::routes::RoutesBlockInfo { at: var.at, sections })
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
    /// Next `__p<N>` name for a hoisted props object; unique across nested fragments.
    props_ids: std::cell::Cell<usize>,
    /// Inside `<script>`/`<style>`: text is raw, so character references are not decoded.
    raw_text: bool,
    /// Which of `Route`, `__AppRoute`, `__RouteParams` and `RenderFragment` the route sections reference (`ROUTE_*` bits).
    route_types: std::cell::Cell<u8>,
    /// Next `_e<N>` node variable of a template.
    node_ids: usize,
    /// Emitting inside a `dom.region`: its bindings close over their values instead of sharing a row's reads.
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
    /// The next `@if`/`@switch` of `emit_flow` is a `branchAt`'s: each branch first returns its index without a parent.
    branching: bool,
    /// Emitting the branches of a show block, where `@pause { }` may go.
    in_show: usize,
    /// The specs of the templates, emitted after the class as `__t<N>`.
    templates: Vec<String>,
    /// The row being emitted, whose bindings go through its list's shared reads.
    reads: Option<Reads>,
    /// A node variable is cast with the runtime's `El` type.
    uses_el: bool,
    /// A child component's props are typed with the runtime's `Props`.
    uses_props: bool,
    /// The rows being emitted whose `@key` keys their loop: the elements that may carry one.
    row_roots: Vec<*const Element>,
    /// Emitting `@module` code, whose markup has no component to own it.
    ownerless: bool,
    /// Markup literals so far: each is a site, `__s<N>`, which the markup value it builds carries.
    sites: usize,
    /// Emitting a markup value's build, which a claim re-runs: an element `@ref` goes through `dom.ref`.
    in_markup: bool,
}

/// A node of a template.
enum Tpl {
    Text(String),
    /// The empty text a `@expr` binds.
    Hole,
    /// A comment marking where a region or list goes.
    Anchor,
    El { tag: String, attrs: Vec<(String, String)>, kids: Vec<Tpl> },
}

/// What binds a node of a template clone.
enum TplPart<'n> {
    Expr(&'n Src),
    /// Attribute bindings, handlers, `@bind`, `@ref`.
    Element(&'n Element),
    Region(&'n Node),
    /// A `@{ }` block and the siblings after it.
    Code(&'n [CodePart], &'n [Node]),
    List(&'n Node),
    /// `@cascade`, between its two anchors.
    Cascade(&'n Node),
    /// `@Routes`, between its two anchors.
    Routes(&'n Node),
    /// `@slot`, between its two anchors.
    Slot(&'n Slot),
    /// A child component, before its one anchor.
    Component(&'n Element),
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

/// A child component tag taken apart; see `Gen::component_parts`.
struct ChildParts {
    name: M,
    /// The explicit type arguments' text.
    type_args: Option<String>,
    /// A generic component whose type arguments come from its props.
    infer: bool,
    type_names: Vec<String>,
    /// Each prop, and whether it is set once (a callback) rather than read.
    props: Vec<(M, bool)>,
    /// `@key` (true) and `@ref` expressions.
    extra: Vec<(bool, M)>,
    fills: Vec<(String, M)>,
}

/// Whether `text` is an arrow or function expression.
fn is_lambda(text: &str) -> bool {
    fn word<'a>(s: &'a str, w: &str) -> Option<&'a str> {
        s.strip_prefix(w).filter(|r| !r.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$'))
    }
    let t = text.trim_start();
    let t = word(t, "async").map_or(t, str::trim_start);
    if word(t, "function").is_some() {
        return true;
    }
    let name = t.len() - t.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_' || c == '$').len();
    let rest = if t.starts_with('(') {
        let mut depth = 0;
        let Some(end) = t.char_indices().find_map(|(i, c)| {
            depth += i32::from(c == '(') - i32::from(c == ')');
            (depth == 0).then_some(i)
        }) else {
            return false;
        };
        let rest = t[end + 1..].trim_start();
        // A return type annotation sits between the parameters and the arrow.
        return rest.starts_with("=>") || (rest.starts_with(':') && rest.contains("=>"));
    } else {
        &t[name..]
    };
    name > 0 && rest.trim_start().starts_with("=>")
}

struct Reads {
    /// The row's item as declared (`w` or `w: Worker`), and its name.
    param: String,
    name: String,
    list: Vec<M>,
}

/// `[tag, attrs | 0, ...children]`, a string, `""` for a hole or `null` for an anchor; see `dom.template`.
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
        Node::For { head, key, body, .. } => (key.is_some() || row_key(body).is_some() || !loop_locals(head).is_empty()) && !has_code(body),
        Node::While { key, body, .. } => (key.is_some() || row_key(body).is_some()) && !has_code(body),
        _ => false,
    }
}

/// The `@key="expr"` of a loop body's only top element or component, which keys the loop's rows.
fn row_key(body: &[Node]) -> Option<(&Element, &Src)> {
    let mut tops = body.iter().filter(|n| !matches!(n, Node::Text(t) if t.trim().is_empty()));
    let (Some(Node::Element(el)), None) = (tops.next(), tops.next()) else { return None };
    match &el.attrs.iter().find(|a| &*a.name.text == "@key")?.value {
        AttrValue::Expr(e) => Some((el, e)),
        _ => None,
    }
}

/// A loop's key: `@key(expr)` after its head or `@key` on its row, not both.
fn loop_key<'n>(key: &'n Option<Src>, body: &'n [Node]) -> Result<(Option<&'n Src>, Option<*const Element>), String> {
    match (key, row_key(body)) {
        (Some(_), Some(_)) => Err("this loop is keyed twice, by `@key(...)` after its head and by `@key` on its row: keep one".into()),
        (Some(k), None) => Ok((Some(k), None)),
        (None, Some((el, k))) => Ok((Some(k), Some(el as *const Element))),
        (None, None) => Ok((None, None)),
    }
}

const STRAY_KEY: &str = "`@key` on an element keys nothing here: put it on the only top element of a `@for`/`@while` body, or key the loop with `@key(expr)` after its head";

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
        Node::Element(el) => !el.is_component() && el.children.iter().any(is_flow),
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

impl<'p> Gen<'p> {
    fn emit(&mut self, m: M) {
        if !m.text.is_empty() {
            for _ in 0..self.depth {
                self.out.push_str("  ");
            }
        }
        let base = self.out.len();
        self.mappings.extend(m.maps.into_iter().map(|x| Mapping { out: x.out + base, ..x }));
        self.out.push_str(&m.text);
        self.out.push('\n');
    }

    /// A `@code` block with its markup values compiled to markup values and its `@Cascade`
    /// decorators (`blanks`) blanked out.
    fn code_block(&mut self, parts: &[CodePart], blanks: &[(usize, usize)]) -> Result<M, String> {
        let mut out = M::default();
        // The member being scanned: a `static` member's markup has no instance to own it.
        let mut member = Member::default();
        let outer = self.ownerless;
        for part in parts {
            out = match part {
                CodePart::Ts(s) => {
                    member.feed(&s.text);
                    out.add(blanked(s, blanks))
                }
                // Markup in `@code` is plain TypeScript scope: no `this.` rewriting.
                CodePart::Markup(el) => {
                    self.ownerless = outer || member.is_static();
                    member.last = '}';
                    let fragment = self.dom_fragment(std::slice::from_ref(&Node::Element(el.clone())), false, &[]);
                    self.ownerless = outer;
                    out.add(fragment?)
                }
                CodePart::Render(_) => return Err("markup statements and `@:` lines belong in `@{ }`, not `@code`".into()),
            };
        }
        Ok(out)
    }

    /// `__Component.fragment((__p) => { ... }, this, __s<N>)` for `nodes`, built by the template emitter. `locals` are extra
    /// names in scope (slot parameters) that must not get `this.`.
    fn dom_fragment(&mut self, nodes: &[Node], rewrite: bool, locals: &[String]) -> Result<M, String> {
        let site = self.sites;
        self.sites += 1;
        let mut sub = self.sub_gen(rewrite, locals);
        sub.in_markup = true;
        sub.depth += 1;
        let done = sub.emit_nodes(nodes, "__p");
        self.absorb(&mut sub);
        done?;
        let close = format!("{}}}, {}, __s{site})", "  ".repeat(self.depth), if self.ownerless { "undefined" } else { "this" });
        Ok(M::lit("__Component.fragment((__p) => {\n").add(M { text: sub.out, maps: sub.mappings }).lit_then(&close))
    }

    /// A generator for markup inside this one's scope; `absorb` takes back its counters.
    fn sub_gen(&mut self, rewrite: bool, locals: &[String]) -> Gen<'p> {
        Gen {
            out: String::new(),
            mappings: Vec::new(),
            members: if rewrite { self.members.clone() } else { HashSet::new() },
            statics: if rewrite { self.statics.clone() } else { HashSet::new() },
            static_prefix: self.static_prefix.clone(),
            locals: self.locals.iter().chain(locals).cloned().collect(),
            depth: self.depth,
            components: self.components,
            raw_text: self.raw_text,
            props_ids: std::cell::Cell::new(self.props_ids.get()),
            route_types: std::cell::Cell::new(self.route_types.get()),
            node_ids: self.node_ids,
            in_region: false,
            in_loop: false,
            owner: None,
            list_keys: if rewrite { self.list_keys.clone() } else { HashMap::new() },
            pass_locals: None,
            once: false,
            branching: false,
            in_show: 0,
            templates: std::mem::take(&mut self.templates),
            reads: None,
            uses_el: false,
            uses_props: false,
            row_roots: Vec::new(),
            ownerless: self.ownerless,
            sites: self.sites,
            in_markup: self.in_markup,
        }
    }

    fn absorb(&mut self, sub: &mut Gen) {
        self.sites = sub.sites;
        self.props_ids.set(sub.props_ids.get());
        self.route_types.set(sub.route_types.get());
        self.node_ids = sub.node_ids;
        self.templates = std::mem::take(&mut sub.templates);
        self.uses_el |= sub.uses_el;
        self.uses_props |= sub.uses_props;
    }

    /// One section of a routes block as its `RouteSection` descriptor. `RouteSection.render` takes a
    /// plain `Route`, so a section that reads `route` casts it to the project's `AppRoute` in a local.
    fn route_section(&mut self, i: usize, var: &Src, section: &RouteSectionNode) -> Result<M, String> {
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
        let body = self.dom_fragment(&section.body, true, &locals)?;
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
            params = params.lit_then(", ").add(M::src(bound, bound.at)).lit_then(if is_catch { ": unknown" } else { ": __Markup" });
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
    fn slot_lambda(&mut self, params: Option<&Src>, body: &[Node]) -> Result<M, String> {
        let head = match params {
            Some(p) => M::lit("(").add(M::src(p, p.at)).lit_then(") => "),
            None => M::lit("() => "),
        };
        let names = params.map(|p| param_names(p)).unwrap_or_default();
        Ok(head.add(self.dom_fragment(body, true, &names)?))
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

    /// Whether `e` is only a member's name (`save`, `this.save`): the same function on every read.
    fn is_member_ref(&self, e: &Src) -> bool {
        let t = e.trim();
        is_identifier(t) && self.is_member(t) || t.strip_prefix("this.").is_some_and(is_identifier)
    }

    /// `this.m.bind(this)` for a bare member name, else the rewritten expression.
    fn handler(&self, e: &Src) -> M {
        if let Some(prefix) = self.member_prefix(e).filter(|_| is_identifier(e)) {
            M::lit(prefix).add(M::src(e, e.at)).lit_then(&format!(".bind({})", prefix.trim_end_matches('.')))
        } else {
            self.expr(e)
        }
    }

    /// Statements that append `nodes` to `parent` (an element, or the fragment a region or row builds).
    /// Outside regions, `nodes` is one template clone: elements and static text are in the template, and each
    /// dynamic part binds the node it has in place (a text hole for `@expr`, comments for the rest).
    /// `@if`/`@while`/`@switch`/`for(;;)` are regions, `@for...of` a keyed list, and a `@{ }` block a region
    /// holding it and the siblings after it, so its locals stay current. Inside a region the same holds, so
    /// nested structure tracks its own reads, except that a plain `@{ }` runs inline in the region. In a plain
    /// loop's body (a region per pass would cost more than the rebuild) structure is plain control flow.
    fn emit_nodes(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        if !self.in_region {
            return self.emit_run(nodes, parent);
        }
        if self.in_loop {
            return self.emit_inline(nodes, parent);
        }
        let mut i = 0;
        while i < nodes.len() {
            if let Node::Code(parts) = &nodes[i]
                && is_plain_code(parts)
            {
                let block = self.emit_code_block(parts)?;
                self.emit_block(block);
                i += 1;
                continue;
            }
            let end = nodes[i..].iter().position(is_plain_code_node).map_or(nodes.len(), |n| i + n);
            self.emit_run(&nodes[i..end], parent)?;
            i = end;
        }
        Ok(())
    }

    /// `nodes` in a plain loop's body: structure as plain control flow, the runs between as templates.
    fn emit_inline(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        let mut i = 0;
        while i < nodes.len() {
            let node = &nodes[i];
            match node {
                Node::Code(parts) if is_plain_code(parts) => {
                    let block = self.emit_code_block(parts)?;
                    self.emit_block(block);
                }
                Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. } => self.emit_flow(node, parent)?,
                Node::Element(el) if is_flow(node) && &*el.name.text == "text" => self.emit_inline(&el.children, parent)?,
                Node::Element(el) if is_flow(node) => self.emit_element(el, parent)?,
                _ => {
                    // A `@{ }` block holds the rest of the run in its region, so the run takes it all.
                    let end = match nodes[i..].iter().position(|n| is_flow(n) || matches!(n, Node::Code(_))) {
                        Some(n) if is_flow(&nodes[i + n]) => i + n,
                        _ => nodes.len(),
                    };
                    self.emit_run(&nodes[i..end], parent)?;
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        Ok(())
    }

    /// An element whose children hold control flow, in a plain loop: created on its own.
    fn emit_element(&mut self, el: &Element, parent: &str) -> Result<(), String> {
        let var = self.node_var();
        self.line(&format!("const {var} = __dom.el({parent}, {});", js_string(&el.name)));
        self.emit_attrs(el, &var, true)?;
        let raw = std::mem::replace(&mut self.raw_text, matches!(&*el.name.to_ascii_lowercase(), "script" | "style"));
        let owner = self.owner.replace(var.clone());
        let r = self.emit_inline(&el.children, &var);
        self.owner = owner;
        self.raw_text = raw;
        r
    }

    /// `nodes` as one template clone appended to `parent`, with the bindings of its dynamic parts.
    fn emit_run(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        let mut kids = Vec::new();
        let mut parts = Vec::new();
        self.tpl_nodes(nodes, &[], self.raw_text, &mut kids, &mut parts)?;
        if kids.is_empty() {
            // Only `@attr:`s: no clone, they bind the owner.
            for (_, part) in &parts {
                let TplPart::ParentAttr(a) = part else { unreachable!("other parts have a node") };
                let owner = self.owner.clone().ok_or_else(|| format!("@attr:{} needs an enclosing element", &*a.name))?;
                self.emit_part(part, &owner)?;
            }
            return Ok(());
        }
        // One control-flow block alone: its anchors go straight in, with no template to clone.
        if parts.len() == 1 && kids.iter().all(|k| matches!(k, Tpl::Anchor)) {
            let part = &parts[0].1;
            if let TplPart::Region(node) = part
                && self.reads_only_pass(node)
            {
                return self.emit_flow(node, parent);
            }
            let var = self.node_var();
            let call = if kids.len() == 2 { "anchors" } else { "anchor" };
            self.line(&format!("const {var} = __dom.{call}({parent});"));
            return self.emit_part(part, &var);
        }
        let t = self.templates.len();
        self.templates.push(kids.iter().map(spec_js).collect::<Vec<_>>().join(", "));
        // A single element is cloned alone; anything else comes in a fragment, so anchors have a parent.
        let root = self.node_var();
        let alone = kids.len() == 1 && matches!(kids[0], Tpl::El { .. });
        let cast = if alone { self.cast(&kids[0]) } else { String::new() };
        self.line(&format!("const {root} = __t{t}(){cast};"));
        let mut vars = vec![(if alone { vec![0] } else { vec![] }, root.clone())];
        // Every node a part binds gets its variable first: regions and lists insert nodes.
        let mut targets = Vec::with_capacity(parts.len());
        for (path, part) in &parts {
            // A part's `@attr:`s set the element holding it: the run's own owner at its top level.
            let owner = |g: &mut Self, vars: &mut Vec<(Vec<usize>, String)>, up: &[usize]| match up {
                [] => g.owner.clone(),
                up => Some(g.node_path(&kids, up, vars)),
            };
            let target = match part {
                TplPart::ParentAttr(a) => match owner(self, &mut vars, path) {
                    Some(var) => (var, None),
                    None => return Err(format!("@attr:{} needs an enclosing element", &*a.name)),
                },
                TplPart::Region(node) if has_parent_attr(std::slice::from_ref(*node)) => {
                    let var = self.node_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                TplPart::Code(_, rest) if has_parent_attr(rest) => {
                    let var = self.node_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                TplPart::List(Node::For { body, otherwise, .. }) if has_parent_attr(body) || otherwise.as_deref().is_some_and(has_parent_attr) => {
                    let var = self.node_path(&kids, path, &mut vars);
                    (var, owner(self, &mut vars, &path[..path.len() - 1]))
                }
                // Its `@attr:`s set the element it is appended to.
                TplPart::Flow(_) => {
                    let var = self.node_path(&kids, path, &mut vars);
                    (var.clone(), Some(var))
                }
                _ => (self.node_path(&kids, path, &mut vars), None),
            };
            targets.push(target);
        }
        for ((_, part), (var, owner)) in parts.iter().zip(&targets) {
            let outer = match owner {
                Some(o) => self.owner.replace(o.clone()),
                None => self.owner.clone(),
            };
            let r = self.emit_part(part, var);
            self.owner = outer;
            r?;
        }
        self.line(&format!("{parent}.appendChild({root});"));
        Ok(())
    }

    /// The template of `nodes` into `kids`, and their dynamic parts with the path of the node each binds.
    fn tpl_nodes<'n>(&self, nodes: &'n [Node], path: &[usize], raw: bool, kids: &mut Vec<Tpl>, parts: &mut Vec<(Vec<usize>, TplPart<'n>)>) -> Result<(), String> {
        let at = |kids: &Vec<Tpl>| [path, &[kids.len()]].concat();
        for (i, node) in nodes.iter().enumerate() {
            match node {
                Node::Code(code) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Code(code, &nodes[i + 1..])));
                    kids.push(Tpl::Anchor);
                    return Ok(());
                }
                Node::Text(t) => kids.push(Tpl::Text(if raw { t.clone() } else { crate::entities::decode(t).into_owned() })),
                Node::Expr(e) => {
                    parts.push((at(kids), TplPart::Expr(e)));
                    kids.push(Tpl::Hole);
                }
                Node::Element(el) if &*el.name.text == "text" => self.tpl_nodes(&el.children, path, raw, kids, parts)?,
                Node::Element(el) if el.is_component() => {
                    parts.push((at(kids), TplPart::Component(el)));
                    kids.push(Tpl::Anchor);
                }
                Node::Element(el) => {
                    let here = at(kids);
                    let mut attrs = Vec::new();
                    let mut dynamic = false;
                    for a in &el.attrs {
                        let name = &*a.name.text;
                        match &a.value {
                            // A row's `@key` keys its loop (`loop_key`); anywhere else it would do nothing.
                            _ if name == "@key" && self.row_roots.contains(&(el as *const Element)) => {}
                            _ if name == "@key" => return Err(STRAY_KEY.into()),
                            _ if name == "@leave" => attrs.push(("data-leave".to_string(), String::new())),
                            _ if name.starts_with('@') || name.starts_with("class:") => dynamic = true,
                            AttrValue::Empty => attrs.push((name.to_string(), String::new())),
                            AttrValue::Static(s) => attrs.push((name.to_string(), crate::entities::decode(s).into_owned())),
                            _ => dynamic = true,
                        }
                    }
                    if dynamic {
                        parts.push((here.clone(), TplPart::Element(el)));
                    }
                    let mut sub = Vec::new();
                    let raw = matches!(&*el.name.to_ascii_lowercase(), "script" | "style");
                    self.tpl_nodes(&el.children, &here, raw, &mut sub, parts)?;
                    kids.push(Tpl::El { tag: el.name.text.to_string(), attrs, kids: sub });
                }
                Node::For { head, .. } if for_of(head).is_some_and(|(b, _)| !b.starts_with(['[', '{'])) => {
                    parts.push((at(kids), TplPart::List(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::If { .. } | Node::Switch { .. } if self.reads_only_pass(node) => {
                    // Built once with its row: as an element's last child it appends to it, else it replaces an anchor.
                    if i + 1 == nodes.len() && !path.is_empty() {
                        parts.push((path.to_vec(), TplPart::Flow(node)));
                    } else {
                        parts.push((at(kids), TplPart::Region(node)));
                        kids.push(Tpl::Anchor);
                    }
                }
                // Destructured items (entries, tuples) are new on every run: keyed passes, not a list.
                // A keyed loop places its rows before its end: one anchor.
                Node::For { .. } | Node::While { .. } if keyable(node) => {
                    parts.push((at(kids), TplPart::Region(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::If { .. } | Node::For { .. } | Node::While { .. } | Node::Switch { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Region(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::Slot(slot) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Slot(slot)));
                    kids.push(Tpl::Anchor);
                }
                Node::Cascade { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Cascade(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::Routes { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Routes(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::SlotFill(_) => return Err("`@slot name { }` fills a slot and must be a direct child of a component tag".into()),
                Node::Await { .. } => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Await(node)));
                    kids.push(Tpl::Anchor);
                }
                Node::Show(inner) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Show(inner)));
                    kids.push(Tpl::Anchor);
                }
                Node::Pause(None) => return Err("bare @pause goes first in a @show branch; use @pause { } for a part of it".into()),
                Node::Pause(Some(_)) if self.in_show == 0 => return Err("@pause belongs in a @show:if or @show:switch branch".into()),
                Node::Pause(Some(body)) => {
                    kids.push(Tpl::Anchor);
                    parts.push((at(kids), TplPart::Pause(body)));
                    kids.push(Tpl::Anchor);
                }
                Node::ParentAttr(a) => parts.push((path.to_vec(), TplPart::ParentAttr(a))),
                Node::Once(body) => match body.as_slice() {
                    [Node::Expr(e)] => {
                        parts.push((at(kids), TplPart::OnceText(e)));
                        kids.push(Tpl::Hole);
                    }
                    _ => {
                        parts.push((at(kids), TplPart::Once(body)));
                        kids.push(Tpl::Anchor);
                    }
                },
            }
        }
        Ok(())
    }

    fn node_var(&mut self) -> String {
        self.node_ids += 1;
        format!("_e{}", self.node_ids - 1)
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
    fn node_path(&mut self, kids: &[Tpl], path: &[usize], vars: &mut Vec<(Vec<usize>, String)>) -> String {
        if let Some((_, v)) = vars.iter().find(|(p, _)| p == path) {
            return v.clone();
        }
        let (&last, up) = path.split_last().expect("the root has a variable");
        let parent = self.node_path(kids, up, vars);
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
        let var = self.node_var();
        let cast = self.cast(node);
        self.line(&format!("const {var} = {expr}{cast};"));
        vars.push((path.to_vec(), var.clone()));
        var
    }

    fn emit_part(&mut self, part: &TplPart, var: &str) -> Result<(), String> {
        match *part {
            TplPart::Expr(e) => {
                let read = self.expr(e);
                self.emit_bound("text", var, read);
            }
            TplPart::Element(el) => self.emit_attrs(el, var, false)?,
            TplPart::Region(node) if self.reads_only_pass(node) => {
                // Its pass's values keep the row only while they are the same: a region would add nothing.
                let f = self.node_var();
                self.line(&format!("const {f} = document.createDocumentFragment();"));
                self.emit_flow(node, &f)?;
                self.line(&format!("{var}.replaceWith({f});"));
            }
            TplPart::Region(node) if keyable(node) => self.emit_keyed(node, var)?,
            TplPart::Region(node) if !self.row_level() && branchable(node) => {
                self.line(&format!("__dom.branchAt({var}, (__p) => {{"));
                let outer = std::mem::replace(&mut self.in_region, true);
                let pass = self.pass_locals.take();
                self.depth += 1;
                self.branching = true;
                let r = self.emit_flow(node, "__p");
                self.depth -= 1;
                self.pass_locals = pass;
                self.in_region = outer;
                r?;
                self.line("});");
            }
            TplPart::Region(node) if branchable(node) => self.emit_region(var, true, |g| {
                g.branching = true;
                g.emit_flow(node, "__p")
            })?,
            TplPart::Region(node) => self.emit_region(var, false, |g| g.emit_flow(node, "__p"))?,
            TplPart::Code(code, rest) => {
                let scope = self.locals.len();
                let r = self.emit_region(var, false, |g| {
                    let block = g.emit_code_block(code)?;
                    g.emit_block(block);
                    g.emit_nodes(rest, "__p")
                });
                self.locals.truncate(scope);
                r?;
            }
            TplPart::List(node) => self.emit_list(node, var)?,
            TplPart::Component(el) => self.emit_component(el, var)?,
            TplPart::Await(node) => self.emit_await(node, var)?,
            TplPart::Show(node) => {
                let node = show_branches(node)?;
                self.line(&format!("__dom.showAt({var}, (__p) => {{"));
                let outer = std::mem::replace(&mut self.in_region, true);
                let pass = self.pass_locals.take();
                self.depth += 1;
                self.in_show += 1;
                self.branching = true;
                let r = self.emit_flow(&node, "__p");
                self.in_show -= 1;
                self.depth -= 1;
                self.pass_locals = pass;
                self.in_region = outer;
                r?;
                self.line("});");
            }
            TplPart::Pause(body) => {
                self.line(&format!("__dom.pauseAt({var}, (__p) => {{"));
                let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
                let pass = self.pass_locals.take();
                let r = self.emit_body(body, "__p");
                self.pass_locals = pass;
                (self.in_region, self.in_loop) = flags;
                r?;
                self.line("});");
            }
            TplPart::Flow(node) => self.emit_flow(node, var)?,
            TplPart::OnceText(e) => {
                let read = self.expr(e);
                self.emit(M::lit(&format!("__dom.textOnce({var}, () => ")).add(read).lit_then(");"));
            }
            TplPart::Once(body) => {
                self.line(&format!("__dom.onceAt({var}, (__p) => {{"));
                // Plain control flow, and values set rather than bound.
                let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, true), std::mem::replace(&mut self.once, true));
                let pass = self.pass_locals.take();
                let r = self.emit_body(body, "__p");
                self.pass_locals = pass;
                (self.in_region, self.in_loop, self.once) = flags;
                r?;
                self.line("});");
            }
            TplPart::ParentAttr(a) => {
                let read = self.value(&a.value);
                self.emit(M::lit(&format!("__dom.attrOf({var}, {}, () => ", js_string(&a.name))).add(read).lit_then(");"));
            }
            TplPart::Cascade(Node::Cascade { name, value, fixed, body }) => {
                let quoted = js_string(name);
                // The mapping stays on the name only while the literal is a straight copy of it.
                let literal = if quoted[1..quoted.len() - 1] == *name.text {
                    M::lit("\"").add(M::src(name, name.at)).lit_then("\"")
                } else {
                    M::lit(&quoted)
                };
                let head = M::lit(&format!("__dom.cascadeAt({var}, ")).add(literal).lit_then(", () => ").add(self.expr(value));
                self.emit(head.lit_then(&format!(", {}, (__p) => {{", fixed)));
                let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
                let pass = self.pass_locals.take();
                let r = self.emit_body(body, "__p");
                self.pass_locals = pass;
                (self.in_region, self.in_loop) = flags;
                r?;
                self.line("});");
            }
            TplPart::Routes(Node::Routes { var: route, sections }) => {
                self.line(&format!("__dom.routesAt({var}, __routes, ["));
                self.depth += 1;
                for (i, section) in sections.iter().enumerate() {
                    let m = self.route_section(i, route, section)?;
                    self.emit(m);
                }
                self.depth -= 1;
                self.line("]);");
            }
            TplPart::Cascade(_) | TplPart::Routes(_) => unreachable!("built from their own nodes"),
            // The slot's fallback is built by a binding that patches it when what it reads changes.
            TplPart::Slot(slot) => {
                let name = match &slot.name {
                    Some(n) => M::src(n, n.at),
                    None => M::lit("default"),
                };
                let mut head = M::lit(&format!("__dom.slotAt({var}, () => this.slots.")).add(name);
                let args = slot.args.as_deref().filter(|a| !a.is_empty());
                if let Some(args) = args {
                    head = head.lit_then(", () => [");
                    for (i, arg) in args.iter().enumerate() {
                        let value = match arg {
                            SlotArg::Expr(e) => self.expr(e),
                            SlotArg::Markup(el) => self.dom_fragment(std::slice::from_ref(&Node::Element(el.clone())), true, &[])?,
                        };
                        head = head.lit_then(if i == 0 { "" } else { ", " }).add(value);
                    }
                    head = head.lit_then("]");
                }
                match &slot.fallback {
                    Some(body) => {
                        self.emit(head.lit_then(if args.is_some() { ", (__p) => {" } else { ", undefined, (__p) => {" }));
                        let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
                        let pass = self.pass_locals.take();
                        let r = self.emit_body(body, "__p");
                        self.pass_locals = pass;
                        (self.in_region, self.in_loop) = flags;
                        r?;
                        self.line("});");
                    }
                    None => self.emit(head.lit_then(");")),
                }
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
    fn emit_bound(&mut self, call: &str, args: &str, read: M) {
        if self.once {
            let call = if call == "text" { "setText" } else { "set" };
            self.emit(M::lit(&format!("__dom.{call}({args}, ")).add(read).lit_then(");"));
        } else if self.row_level() {
            let i = self.push_read("", read);
            self.line(&format!("__dom.{call}Item({args}, {i});"));
        } else {
            let call = if call == "text" { "textAt" } else { call };
            self.emit(M::lit(&format!("__dom.{call}({args}, () => ")).add(read).lit_then(");"));
        }
    }

    /// A handler (or none, for modifiers alone) with `mods` (1 preventDefault, 2 stopPropagation).
    fn emit_on(&mut self, var: &str, event: &str, handler: Option<M>, mods: u8) {
        let tail = if mods == 0 { String::new() } else { format!(", {mods}") };
        match handler {
            Some(handler) if self.row_level() => {
                // The return type types the handler's event, as `dom.on` does.
                let i = self.push_read("): ((e: any) => unknown", handler);
                self.line(&format!("__dom.onItem({var}, {}, {i}{tail});", js_string(event)));
            }
            Some(handler) => self.emit(M::lit(&format!("__dom.on({var}, {}, ", js_string(event))).add(handler).lit_then(&format!("{tail});"))),
            None => self.line(&format!("__dom.on({var}, {}, undefined{tail});", js_string(event))),
        }
    }

    /// The modifiers `@on<event>:name` of `el`: the bits that always apply, and the conditions of the others,
    /// which the handler checks when the event fires.
    fn event_modifiers(&self, el: &Element, event: &str) -> Result<(u8, Vec<(u8, M)>), String> {
        let (mut mods, mut when) = (0, Vec::new());
        for a in &el.attrs {
            let Some((e, modifier)) = a.name.strip_prefix("@on").and_then(|r| r.split_once(':')) else { continue };
            if e != event {
                continue;
            }
            let bit = match modifier {
                "preventDefault" => 1,
                "stopPropagation" => 2,
                _ => return Err(format!("unknown event modifier {}", a.name)),
            };
            match &a.value {
                AttrValue::Empty => mods |= bit,
                AttrValue::Expr(e) if e.trim() == "true" => mods |= bit,
                AttrValue::Expr(e) if e.trim() == "false" => {}
                AttrValue::Expr(e) => when.push((bit, self.expr(e))),
                _ => return Err(format!("{} takes a boolean expression", a.name)),
            }
        }
        Ok((mods, when))
    }

    /// `@on<event>`, with its modifiers, or the modifiers of an event that has no handler.
    fn emit_event(&mut self, el: &Element, var: &str, a: &Attr, event: &str) -> Result<(), String> {
        let modifier = |x: &Attr| x.name.strip_prefix("@on").and_then(|r| r.split_once(':')).is_some_and(|(e, _)| e == event);
        let handler = el.attrs.iter().find(|x| x.name.strip_prefix("@on") == Some(event));
        // The handler's attribute emits them all; without one, the first modifier does.
        if modifier(a) && (handler.is_some() || !std::ptr::eq(a, el.attrs.iter().find(|x| modifier(x)).expect("a is one"))) {
            return Ok(());
        }
        let (mods, when) = self.event_modifiers(el, event)?;
        let mut run = match handler {
            Some(h) => {
                let AttrValue::Expr(e) = &h.value else { return Err(format!("{} requires a handler expression", h.name)) };
                Some(self.handler(e))
            }
            None => None,
        };
        if !when.is_empty() {
            let mut wrapped = M::lit("(__e: any) => { ");
            for (bit, cond) in when {
                let call = if bit == 1 { "preventDefault" } else { "stopPropagation" };
                wrapped = wrapped.lit_then("if (").add(cond).lit_then(&format!(") __e.{call}(); "));
            }
            run = Some(match run {
                Some(h) => wrapped.lit_then("return ((").add(h).lit_then(") as (e: any) => unknown)(__e); }"),
                None => wrapped.lit_then("}"),
            });
        }
        self.emit_on(var, event, run, mods);
        Ok(())
    }

    /// A region before comment `end` (after the comment before it), whose `body` is plain control flow; with
    /// `branch`, an `@if`/`@switch` emitted for `branchAt`/`branchItem`.
    fn emit_region(&mut self, end: &str, branch: bool, body: impl FnOnce(&mut Self) -> Result<(), String>) -> Result<(), String> {
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
            self.line(&format!("__dom.{}({end}, {i});", if branch { "branchItem" } else { "regionItem" }));
        } else {
            self.line(&format!("__dom.{}({end}, (__p) => {{", if branch { "branchAt" } else { "regionAt" }));
            self.splice(code);
            self.line("});");
        }
        Ok(())
    }

    /// `@for (const item of items)` before comment `end`: its rows' bindings share the reads it collects.
    fn emit_list(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let Node::For { head, key, body, otherwise } = node else { unreachable!("a list is a for") };
        let (binding, source) = for_of(head).expect("a list is a for...of");
        let scope = self.locals.len();
        self.locals.extend(loop_locals(head));
        let items = self.expr(&source);
        let name = binding.split(':').next().unwrap_or_default().trim().to_string();
        let (key, root) = loop_key(key, body)?;
        // `@key(expr)` or the row's `@key`, else the `@Key("member")` of the field the items come from.
        let key = match key {
            Some(k) => Some(self.expr(k)),
            None => self.field_key(&source).map(|member| M::lit(&format!("{name}.{member}"))),
        }
        .map(|k| M::lit("(").add(M::src(&binding, binding.at)).lit_then(") => ").add(k));
        let outer = self.reads.replace(Reads { param: binding.text.clone(), name, list: Vec::new() });
        // Rows share the list's reads even when the list sits in a region.
        let in_region = std::mem::replace(&mut self.in_region, false);
        let pass = self.pass_locals.take();
        self.row_roots.extend(root);
        let row = self.capture(|g| g.emit_body(body, "__p"));
        self.row_roots.truncate(self.row_roots.len() - usize::from(root.is_some()));
        self.pass_locals = pass;
        self.in_region = in_region;
        let reads = std::mem::replace(&mut self.reads, outer).expect("set above");
        self.locals.truncate(scope);
        let row = row?;
        // The else builds like a region: its bindings close over their values.
        let empty = match otherwise {
            Some(body) => {
                let in_region = std::mem::replace(&mut self.in_region, true);
                let empty = self.capture(|g| g.emit_body(body, "__p"));
                self.in_region = in_region;
                Some(empty?)
            }
            None => None,
        };
        self.emit(M::lit(&format!("__dom.listAt({end}, () => ")).add(items).lit_then(", ["));
        self.depth += 1;
        for read in reads.list {
            self.emit(read.lit_then(","));
        }
        self.depth -= 1;
        let item = if mentions(&row.text, &reads.name) { M::lit(", ").add(M::src(&binding, binding.at)) } else { M::default() };
        let takes_item = !item.text.is_empty();
        self.emit(M::lit("], (__p").add(item).lit_then(") => {"));
        if takes_item {
            // What closes over the item gets the one that replaces it under the same key: the row is kept.
            self.depth += 1;
            self.line(&format!("__dom.rowItem((__v: typeof {0}) => {{ {0} = __v; }});", reads.name));
            self.depth -= 1;
        }
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
    fn emit_keyed(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let (key, body, otherwise, locals) = match node {
            Node::For { head, key, body, otherwise } => (key, body, otherwise, loop_locals(head)),
            Node::While { key, body, otherwise, .. } => (key, body, otherwise, Vec::new()),
            _ => unreachable!("only loops are keyed"),
        };
        let (key, root) = loop_key(key, body)?;
        self.line(&format!("__dom.keyedAt({end}, (__pass) => {{"));
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
        let key = key.map_or_else(|| M::lit("__i++"), |k| self.expr(k));
        // A kept pass skips its body: `__pass` returns where to build only for a new row.
        self.emit(M::lit("const __p = __pass(").add(key).lit_then(&format!(", [{}]);", locals.join(", "))));
        self.line("if (__p !== undefined) {");
        let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
        let outer_pass = self.pass_locals.replace(locals.clone());
        self.row_roots.extend(root);
        let r = self.emit_body(body, "__p");
        self.row_roots.truncate(self.row_roots.len() - usize::from(root.is_some()));
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
                    self.emit_body(body, "__p")?;
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
    fn emit_await(&mut self, node: &Node, end: &str) -> Result<(), String> {
        let Node::Await { promise, pending, then, catch } = node else { unreachable!("an @await") };
        let head = match call_parts(&promise.text) {
            // Its arguments are a binding of their own: the call runs again only when one of them changes.
            Some((callee, args)) => {
                let part = |(a, b): (usize, usize)| Src::new(&promise.text[a..b], if promise.at == Src::UNMAPPED { Src::UNMAPPED } else { promise.at + a });
                let params = (0..args.len()).map(|i| format!("__a{i}")).collect::<Vec<_>>().join(", ");
                let mut m = M::lit(&format!("__dom.awaitCallAt({end}, () => ["));
                for (i, &range) in args.iter().enumerate() {
                    if i > 0 {
                        m = m.lit_then(", ");
                    }
                    m = m.add(self.expr(&part(range)));
                }
                m.lit_then(&format!("], ({params}) => ")).add(self.expr(&part(callee))).lit_then(&format!("({params}), (__p) => {{"))
            }
            None => M::lit(&format!("__dom.awaitAt({end}, () => ")).add(self.expr(promise)).lit_then(", (__p) => {"),
        };
        self.emit(head);
        let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, false));
        let pass = self.pass_locals.take();
        let r = (|| {
            self.emit_body(pending, "__p")?;
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
                let r = self.emit_body(body, "__p");
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

    /// The statements of a `@{ }` block; its declarations become locals of the enclosing scope. Markup
    /// statements append to the region's `__p` as a plain loop's body does, markup values are fragments.
    fn emit_code_block(&mut self, parts: &[CodePart]) -> Result<M, String> {
        let mut block = M::default();
        for part in parts {
            block = match part {
                CodePart::Ts(s) => {
                    self.locals.extend(declared_names(s));
                    block.add(self.expr(s))
                }
                CodePart::Markup(el) => block.add(self.dom_fragment(std::slice::from_ref(&Node::Element(el.clone())), true, &[])?),
                CodePart::Render(nodes) => {
                    // Lines indented as the statement's own, the first one continuing the code's line.
                    let indent = block.text.rsplit('\n').next().map_or(0, |l| l.len() - l.trim_start().len());
                    let depth = std::mem::replace(&mut self.depth, indent / 2);
                    let flags = (std::mem::replace(&mut self.in_region, true), std::mem::replace(&mut self.in_loop, true));
                    let pass = self.pass_locals.take();
                    let scope = self.locals.len();
                    let r = self.capture(|g| g.emit_nodes(nodes, "__p"));
                    self.locals.truncate(scope);
                    self.pass_locals = pass;
                    (self.in_region, self.in_loop) = flags;
                    self.depth = depth;
                    let code = r?;
                    let lead = code.text.len() - code.text.trim_start().len();
                    let text = code.text[lead..].trim_end().to_string();
                    let maps = code.maps.into_iter().map(|m| Mapping { out: m.out - lead, ..m }).collect();
                    block.add(M { text, maps })
                }
            };
        }
        Ok(block)
    }

    /// A branch of a control-flow statement, with its own scope for locals.
    fn emit_body(&mut self, nodes: &[Node], parent: &str) -> Result<(), String> {
        self.depth += 1;
        let scope = self.locals.len();
        let r = self.emit_nodes(nodes, parent);
        self.locals.truncate(scope);
        self.depth -= 1;
        r
    }

    /// Structure as plain control flow, inside a region.
    fn emit_flow(&mut self, node: &Node, p: &str) -> Result<(), String> {
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
                    self.emit_body(body, p)?;
                }
                if let Some(body) = otherwise {
                    self.line("} else {");
                    pick(self, branches.len());
                    self.emit_body(body, p)?;
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
                let r = self.emit_body(body, p);
                self.in_loop = in_loop;
                self.locals.truncate(scope);
                r?;
                self.line("}");
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.emit_body(body, p)?;
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
                let r = self.emit_body(body, p);
                self.in_loop = in_loop;
                r?;
                self.line("}");
                if let Some(body) = otherwise {
                    self.line("if (__none) {");
                    self.emit_body(body, p)?;
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
                    self.emit_body(&case.body, p)?;
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
    fn emit_attrs(&mut self, el: &Element, var: &str, all: bool) -> Result<(), String> {
        let directive = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n).map(|a| &a.value);
        let bag_at = el.attrs.iter().position(|a| &*a.name.text == "@attributes");
        let plain = |n: &str| !n.starts_with('@') && !n.contains(':');
        for (i, a) in el.attrs.iter().enumerate() {
            let name = &*a.name.text;
            // Given to the bag's binding, which keeps them in order with the bag: `class:` toggles, and dynamic plain
            // attributes written before it.
            if bag_at.is_some_and(|b| name.starts_with("class:") || (!self.once && i < b && plain(name) && matches!(a.value, AttrValue::Expr(_) | AttrValue::Interp(_)))) {
                continue;
            }
            match name {
                name @ ("@bind" | "@bind:input") => self.emit_bind(el, var, a, bind_event(name, directive("@bind:event"))?, directive("@bind:after"))?,
                "@bind:event" | "@bind:after" | "@bind:debounce" => {}
                "@key" if self.row_roots.contains(&(el as *const Element)) => {}
                "@key" => return Err(STRAY_KEY.into()),
                "@leave" if all => self.line(&format!("{var}.setAttribute(\"data-leave\", \"\");")),
                "@leave" => {}
                // In a markup value the target is set through a record, so a claim sets it to the element it keeps.
                "@ref" if self.in_markup => {
                    let line = M::lit(&format!("__dom.ref({var}, (__e) => ")).add(self.directive_expr(a)?).lit_then(" = __e);");
                    self.emit(line);
                }
                "@ref" => {
                    let line = self.directive_expr(a)?.lit_then(&format!(" = {var};"));
                    self.emit(line);
                }
                "@attributes" => {
                    let bag = self.directive_expr(a)?;
                    // Attributes written after the bag win over its keys.
                    let later = el.attrs.iter().skip_while(|x| !std::ptr::eq(*x, a)).skip(1);
                    let names: Vec<String> = later.map(|x| &*x.name.text).filter(|n| !n.starts_with('@') && !n.contains(':')).map(js_string).collect();
                    let skip = if names.is_empty() { String::new() } else { format!(", [{}]", names.join(", ")) };
                    // What the bag restores or sits under: plain attributes before it (not in @once, which sets them in order),
                    // and the `class:` toggles, as `name, value | read` pairs.
                    let mut pre = Vec::new();
                    for (j, x) in el.attrs.iter().enumerate() {
                        let n = &*x.name.text;
                        let toggle = n.starts_with("class:");
                        if !(toggle || (!self.once && j < i && plain(n))) {
                            continue;
                        }
                        let value = match &x.value {
                            AttrValue::Empty if toggle => M::lit("true"),
                            AttrValue::Empty => M::lit("\"\""),
                            v @ (AttrValue::Expr(_) | AttrValue::Interp(_)) if !self.once => M::lit("() => ").add(self.value(v)),
                            v => self.value(v),
                        };
                        pre.push(M::lit(&format!("{}, ", js_string(n))).add(value));
                    }
                    let skip = if pre.is_empty() {
                        skip
                    } else if skip.is_empty() {
                        ", undefined".to_string()
                    } else {
                        skip
                    };
                    let mut tail = M::lit(&skip);
                    if !pre.is_empty() {
                        tail = tail.lit_then(", [");
                        for (k, p) in pre.into_iter().enumerate() {
                            tail = tail.lit_then(if k == 0 { "" } else { ", " }).add(p);
                        }
                        tail = tail.lit_then("]");
                    }
                    if self.once {
                        self.emit(M::lit(&format!("__dom.setAttrs({var}, ")).add(bag).add(tail).lit_then(");"));
                    } else {
                        self.emit(M::lit(&format!("__dom.attrs({var}, () => ")).add(bag).add(tail).lit_then(");"));
                    }
                }
                _ if name.starts_with("@on") => {
                    let event = name[3..].split(':').next().unwrap_or_default();
                    self.emit_event(el, var, a, event)?;
                }
                _ if name.starts_with('@') => return Err(format!("unknown directive attribute {name}")),
                _ if name.starts_with("class:") => {
                    let on = match &a.value {
                        AttrValue::Empty => M::lit("true"),
                        v => self.value(v),
                    };
                    self.emit_bound("attr", &format!("{var}, {}", js_string(name)), on);
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
                        self.emit_bound("attr", &format!("{var}, {}", js_string(name)), read);
                    }
                },
            }
        }
        Ok(())
    }

    /// `@bind`: an attribute binding plus a listener that writes the field back.
    fn emit_bind(&mut self, el: &Element, var: &str, a: &Attr, event: String, after: Option<&AttrValue>) -> Result<(), String> {
        let AttrValue::Expr(target) = &a.value else { return Err("@bind requires an expression".into()) };
        let is_check = el.attrs.iter().any(|x| {
            &*x.name.text == "type" && matches!(&x.value, AttrValue::Static(s) if matches!(&*s.text, "checkbox" | "radio"))
        });
        let prop = if is_check { "checked" } else { "value" };
        let read = self.expr(target);
        self.emit_bound("attr", &format!("{var}, \"{prop}\""), read);
        let handler = self.bind_handler(el, target, after)?;
        self.emit_on(var, &event, Some(handler), 0);
        Ok(())
    }

    /// The handler writing a bound input back: at once, or after a `@bind:debounce` pause.
    fn bind_handler(&self, el: &Element, target: &Src, after: Option<&AttrValue>) -> Result<M, String> {
        let write = self.expr(target).lit_then(" = __Component.bindValue(__e, ").add(self.expr(target)).lit_then(");").add(self.after_call(after)?);
        let debounce = el.attrs.iter().find(|a| &*a.name.text == "@bind:debounce").map(|a| match &a.value {
            AttrValue::Expr(ms) | AttrValue::Static(ms) if !ms.is_empty() && ms.bytes().all(|b| b.is_ascii_digit()) => Ok(ms.text.clone()),
            _ => Err("@bind:debounce requires milliseconds, e.g. @bind:debounce=\"300\"".to_string()),
        });
        Ok(match debounce.transpose()? {
            Some(ms) => M::lit(&format!("(__e) => __Component.debounce(__e, {ms}, () => {{ ")).add(write).lit_then(" })"),
            None => M::lit("(__e) => { ").add(write).lit_then(" }"),
        })
    }

    /// Statement calling a `@bind:after` handler, returned so async work refreshes when it settles.
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

    /// The expression value of a directive attribute like `@key="x"`.
    fn directive_expr(&self, a: &Attr) -> Result<M, String> {
        match &a.value {
            AttrValue::Expr(e) => Ok(self.expr(e)),
            _ => Err(format!("{} requires an expression", a.name)),
        }
    }

    /// A child component's tag as its parts: the type (with type arguments), props (flagged static when they are
    /// callbacks, which are set once), `@key`/`@ref`, and slot fills.
    fn component_parts(&mut self, el: &Element) -> Result<ChildParts, String> {
        let empty = ComponentInfo::default();
        let info = self.components.get(&*el.name.text).unwrap_or(&empty);
        let attr = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n);

        // Generic components take their type arguments as attributes (Blazor's `TItem="..."`).
        let type_names: Vec<String> = info.type_params.clone();
        let mut name = if info.lazy { M::lit("__lazy_").add(M::src(&el.name, el.name.at)) } else { M::src(&el.name, el.name.at) };
        let infer = !type_names.is_empty() && !type_names.iter().all(|t| attr(t).is_some());
        let mut type_args = None;
        if !type_names.is_empty() && !infer {
            name = name.lit_then("<");
            let mut texts = Vec::new();
            for (i, t) in type_names.iter().enumerate() {
                let arg = match &attr(t).expect("checked above").value {
                    AttrValue::Static(s) if s.at != Src::UNMAPPED => M::src(s, s.at),
                    AttrValue::Static(s) => M::lit(s),
                    AttrValue::Expr(e) => M::src(e, e.at),
                    _ => return Err(format!("<{}>: type argument {t} must be a type", el.name)),
                };
                texts.push(arg.text.clone());
                name = name.lit_then(if i == 0 { "" } else { ", " }).add(arg);
            }
            name = name.lit_then(">");
            type_args = Some(texts.join(", "));
        }

        let owner = if self.ownerless { "__dom.callback(undefined, " } else { "__dom.callback(this, " };
        let mut props: Vec<(M, bool)> = Vec::new();
        let mut extra: Vec<(bool, M)> = Vec::new();
        for a in &el.attrs {
            if type_names.iter().any(|t| **t == *a.name.text) {
                continue;
            }
            match &*a.name.text {
                "@key" => {
                    extra.push((true, self.directive_expr(a)?));
                    continue;
                }
                "@ref" => {
                    extra.push((false, self.directive_expr(a)?));
                    continue;
                }
                "@attributes" => {
                    props.push((M::lit("...").add(self.directive_expr(a)?), false));
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
                props.push((M::lit(&format!("{bound}: ")).add(self.expr(target)), false));
                props.push((
                    M::lit(&format!("{bound}Changed: {owner}(__v) => {{ "))
                        .add(self.expr(target))
                        .lit_then(" = __v;")
                        .add(self.after_call(after)?)
                        .lit_then(" })"),
                    true,
                ));
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
            let mut set_once = kind == PropKind::Callback;
            let value = match (kind, code) {
                (PropKind::Callback, Some(e)) => {
                    // Set once only when the expression stays the same function; any other is read on each pass.
                    set_once = is_lambda(&e) || self.is_member_ref(&e);
                    M::lit(owner).add(self.handler(&e)).lit_then(")")
                }
                // Hoisted, a string literal would widen to `string` and fail a literal-typed prop's inference.
                (PropKind::Text, _) | (_, None) if infer && matches!(a.value, AttrValue::Static(_)) => self.value(&a.value).lit_then(" as const"),
                (PropKind::Text, _) | (_, None) => self.value(&a.value),
                // A lambda is new on every read: set once, not diffed.
                (_, Some(e)) => {
                    set_once |= is_lambda(&e);
                    self.expr(&e)
                }
            };
            props.push((key.lit_then(": ").add(value), set_once));
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
        Ok(ChildParts { name, type_args, infer, type_names, props, extra, fills })
    }

    /// Types only: `p` (a props object's type) when `class`'s type parameters can be inferred from it as a call
    /// would infer them (props that disagree on one fail) and, with `keys`, it has only props; else `never`.
    fn fit(class: &str, type_names: &[String], p: &str, keys: bool) -> String {
        let any = vec!["any"; type_names.len()].join(", ");
        let only = if keys { format!(" & {{ [K in Exclude<keyof {p}, keyof __Props<{class}<{any}>>>]: never }}") } else { String::new() };
        format!("typeof {class}.$fit extends (p: {p}) => void ? {p}{only} : never")
    }

    /// `{ a: 1, b: 2 }` from `entries`.
    fn object_of(entries: impl IntoIterator<Item = M>) -> M {
        let mut object = M::lit("{");
        let mut any = false;
        for p in entries {
            object = object.lit_then(if any { ", " } else { " " }).add(p);
            any = true;
        }
        object.lit_then(if any { " }" } else { "}" })
    }

    /// A child component before comment `end`: `__dom.component` with its props as a read, callbacks as statics and
    /// slot fills, or in a list row `__dom.componentItem` with those as the list's shared reads.
    fn emit_component(&mut self, el: &Element, end: &str) -> Result<(), String> {
        let ChildParts { name, type_args, infer, type_names, props, extra, fills } = self.component_parts(el)?;
        self.uses_props = true;
        let row = self.row_level();
        // A spread's keys are unknown, so they are not checked as props.
        let spread = props.iter().any(|(p, _)| p.text.starts_with("..."));
        let (values, statics): (Vec<_>, Vec<_>) = props.into_iter().partition(|(_, once)| !once);
        let values = Self::object_of(values.into_iter().map(|(p, _)| p));
        // The type the checks run against: a row's reads are typed by hand, a hoisted read by its inference.
        let class = &*el.name.text;
        let ty = match (&type_args, infer) {
            (Some(args), _) => format!("{class}<{args}>"),
            (None, true) => format!("{class}<{}>", vec!["any"; type_names.len()].join(", ")),
            (None, false) => class.to_string(),
        };
        let mut head = name;
        let (mut key, mut target) = (None, None);
        for (is_key, x) in extra {
            if is_key { key = Some(x) } else { target = Some(x) }
        }
        let call = if row { "componentItem" } else { "component" };
        let mut args = M::lit(&format!("__dom.{call}({end}, "));
        if infer && !row {
            // Hoisted so each type parameter is inferred from the props, as the read's own result.
            let id = self.props_ids.get();
            self.props_ids.set(id + 1);
            let var = format!("__p{id}");
            self.emit(M::lit(&format!("const {var} = () => (")).add(values).lit_then(");"));
            let infers = type_names.iter().map(|n| format!("infer {n}")).collect::<Vec<_>>().join(", ");
            let types: Vec<String> = type_names
                .iter()
                .map(|t| format!("ReturnType<typeof {var}> extends __Props<{class}<{infers}>> ? {t} : unknown"))
                .collect();
            head = head.lit_then(&format!("<{}>", types.join(", ")));
            let fit = Self::fit(class, &type_names, &format!("ReturnType<typeof {var}>"), !spread);
            args = args.add(head).lit_then(&format!(", {var} satisfies (() => {fit})"));
        } else if row && infer {
            // Inferred as a call would, so props that disagree on `T` fail; hoisted to name its type, no runtime cost.
            let id = self.props_ids.get();
            self.props_ids.set(id + 1);
            let var = format!("__p{id}");
            let fit = Self::fit(class, &type_names, &format!("typeof {var}"), !spread);
            let body = M::lit(&format!("{{ const {var} = ")).add(values).lit_then(&format!("; return {var} satisfies {fit}; }}"));
            let i = self.push_read(&format!("): (__Props<{ty}>"), body);
            args = args.add(head).lit_then(&format!(", {i}"));
        } else if row {
            let i = self.push_read(&format!("): (__Props<{ty}>"), M::lit("(").add(values).lit_then(")"));
            args = args.add(head).lit_then(&format!(", {i}"));
        } else {
            // Typed here: inferred through the call, a literal would widen to `string`.
            args = args.add(head).lit_then(&format!(", (): __Props<{ty}> => (")).add(values).lit_then(")");
        }
        let statics = (!statics.is_empty()).then(|| Self::object_of(statics.into_iter().map(|(p, _)| p)));
        let slots = (!fills.is_empty()).then(|| Self::object_of(fills.into_iter().map(|(_, f)| f)));
        // Trailing arguments left out; a gap is `undefined`.
        let mut rest: Vec<Option<M>> = Vec::new();
        if row {
            let statics = statics.map(|s| self.push_read(&format!("): (__Props<{ty}>"), M::lit("(").add(s).lit_then(")")));
            let slots = slots.map(|s| self.push_read(&format!("): ({ty}[\"slots\"]"), M::lit("(").add(s).lit_then(")")));
            rest.push(statics.map(|i| M::lit(&i.to_string())));
            rest.push(slots.map(|i| M::lit(&i.to_string())));
        } else {
            rest.push(statics);
            rest.push(slots);
        }
        rest.push(target.map(|t| M::lit("(__c) => { ").add(t).lit_then(" = __c; }")));
        rest.push(key);
        while rest.last().is_some_and(Option::is_none) {
            rest.pop();
        }
        for x in rest {
            args = args.lit_then(", ").add(x.unwrap_or_else(|| M::lit("undefined")));
        }
        self.emit(args.lit_then(");"));
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

/// The `@code` member being scanned: its leading modifiers decide whether it is `static`, and that holds
/// through its whole initializer or body, braces and parens included.
#[derive(Default)]
struct Member {
    /// Text before the first `=`, `:`, `(` or `{` at depth 0.
    head: String,
    term: Option<char>,
    depth: usize,
    has_eq: bool,
    /// Last significant character, to tell where a member without `;` ends.
    last: char,
    /// A line break at depth 0 after a complete value: the next identifier starts a new member.
    newline: bool,
}

impl Member {
    fn is_static(&self) -> bool {
        let words: Vec<&str> = self.head.split_whitespace().collect();
        for (i, w) in words.iter().enumerate() {
            match *w {
                "public" | "private" | "protected" | "readonly" | "declare" | "override" | "accessor" => {}
                "static" => return i + 1 < words.len() || matches!(self.term, Some('{' | '[')),
                _ => return false,
            }
        }
        false
    }

    fn feed(&mut self, s: &str) {
        let c: Vec<char> = s.chars().collect();
        let mut i = 0;
        while i < c.len() {
            let ch = c[i];
            i += 1;
            if ch.is_whitespace() {
                if ch == '\n' && self.depth == 0 && self.has_eq && (self.last.is_alphanumeric() || "_$)]}\"'`".contains(self.last)) {
                    self.newline = true;
                }
                if self.term.is_none() {
                    self.head.push(' ');
                }
                continue;
            }
            let next = c.get(i).copied();
            if ch == '/' && matches!(next, Some('/' | '*')) {
                match next {
                    Some('/') => i += c[i..].iter().position(|&x| x == '\n').unwrap_or(c.len() - i),
                    _ => i = c[i + 1..].windows(2).position(|w| w == ['*', '/']).map_or(c.len(), |p| i + 1 + p + 2),
                }
                continue;
            }
            if std::mem::take(&mut self.newline) && (ch.is_alphabetic() || "_$@".contains(ch)) {
                *self = Member::default();
            }
            match ch {
                '"' | '\'' | '`' => {
                    while i < c.len() && c[i] != ch {
                        i += if c[i] == '\\' { 2 } else { 1 };
                    }
                    i += 1;
                }
                '{' | '(' | '[' => {
                    self.term = self.term.or(Some(ch));
                    self.depth += 1;
                }
                '}' | ')' | ']' => {
                    self.depth = self.depth.saturating_sub(1);
                    // A method or static block ends at its closing brace.
                    if ch == '}' && self.depth == 0 && matches!(self.term, Some('(' | '{')) {
                        *self = Member::default();
                        continue;
                    }
                }
                ';' if self.depth == 0 => {
                    *self = Member::default();
                    continue;
                }
                '=' if self.depth == 0 => {
                    if matches!(next, Some('>' | '=')) {
                        i += 1;
                    } else {
                        self.term = self.term.or(Some('='));
                        self.has_eq = true;
                    }
                }
                ':' if self.depth == 0 => self.term = self.term.or(Some(':')),
                _ => {}
            }
            if self.term.is_none() {
                self.head.push(ch);
            }
            self.last = ch;
        }
    }
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
    use crate::parser::parse;

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
        for m in ["__dom.textAt(_e2, () => C.s)", "__dom.textAt(_e3, () => this.n)", "${C.s}", "C.go.bind(C)", "() => C.s++", "__dom.attr(_e1, \"title\", () => C.s)"] {
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
        let expected = "    __dom.branchAt(_e0, (__p) => {
      switch (this.mode) {
        case 1:
        case 2: {
          if (!__p) return 0;
          const _e1 = __t0() as El<\"b\">;
          __p.appendChild(_e1);
          break;
        }
        default: {
          if (!__p) return 1;
          const _e2 = __t1();
          const _e3 = _e2.firstChild! as Text;
          __dom.textAt(_e3, () => this.mode);
          __p.appendChild(_e2);
          break;
        }
      }
      return 2;
    });
";
        assert!(ts.contains(expected), "{ts}");
    }

    #[test]
    fn if_and_for_are_wrapped_in_regions() {
        let (doc, _) = parse("@if (a) {<b/>}\n@for (const x of xs) {@x}").unwrap();
        let ts = generate(&doc, "R", "R.xzor").unwrap().code;
        let expected = "    __dom.branchAt(_e1, (__p) => {
      if (a) {
        if (!__p) return 0;
        const _e3 = __t1() as El<\"b\">;
        __p.appendChild(_e3);
      }
      return 1;
    });
    __dom.listAt(_e2, () => xs, [
      (x) => x,
    ], (__p) => {
      const _e4 = __t2();
      const _e5 = _e4.firstChild! as Text;
      __dom.textItem(_e5, 0);
      __p.appendChild(_e4);
    });
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
        // A markup value is a DOM fragment owned by the component.
        assert!(g.code.contains("  cached = __Component.fragment((__p) => {\n    const _e0 = __dom.anchor(__p);\n    __dom.component(_e0, B, (): __Props<B> => ({}));\n  }, this, __s0);"), "{}", g.code);
        assert!(
            g.code.contains("return t ? __Component.fragment((__p) => {\n    const _e1 = __dom.anchor(__p);\n    __dom.component(_e1, A, (): __Props<A> => ({ state: this.state, n: t }));\n  }, this, __s1) : this.cached;"),
            "{}",
            g.code
        );
        assert!(g.code.contains("__dom.textAt(_e3, () => this.pick(1));"));
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
            "[\"p\", [\"title\", \"a & b\"], \"<b> café éé © \u{a0} &unknown; &amp; 5 &amp 6\"]",
            "__dom.attr(_e1, \"class\", () => \"x <\" + String(this.n) + \">\");",
            "[\"style\", 0, \"a &gt; b\"]",
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
        for m in ["__dom.attr(_e1, \"title\", () => this.#test)", "__dom.textAt(_e2, () => this.#test)", "() => this.#test + 1", "() => this.#go()", "() => C.#all", "() => this.#test++", "() => #test in this"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
        // `this.#test` is left alone, and a bare `test` is not the private field.
        assert!(!g.code.contains("this.this.") && g.code.contains("() => test)"), "{}", g.code);
    }

    #[test]
    fn every_markup_literal_has_its_own_site_declared_before_the_class() {
        let card = [("Card", "@code { header?: RenderFragment; }\n@slot:header")];
        let src = "@import { x } from \"./x\"\n@module {\n  export const tag = (t: string) => <b>@t</b>;\n}\n@code {\n  static icon = <u/>;\n  own = <i/>;\n}\n<Card>\n  @slot header { <em/> }\n</Card>\n<p>@{ var v = <s/>; }</p>";
        let g = gen_with(src, &card).code;
        let at = |s: &str| g.find(s).unwrap_or_else(|| panic!("{s} missing in\n{g}"));
        // One constant per literal, after the user's imports and before anything that reads them.
        for i in 0..5 {
            assert_eq!(g.matches(&format!("const __s{i} = {{}};")).count(), 1, "{g}");
        }
        assert!(!g.contains("const __s5"), "{g}");
        assert!(at("import { x }") < at("const __s0 = {};") && at("const __s4 = {};") < at("export const tag"), "{g}");
        // The module's and a static member's markup have no owner; every literal passes its own site.
        for (owner, i) in [("undefined", 0), ("undefined", 1), ("this", 2), ("this", 3), ("this", 4)] {
            assert!(g.contains(&format!("}}, {owner}, __s{i})")), "{owner} __s{i} missing in\n{g}");
        }
    }

    #[test]
    fn nested_markup_values_get_their_own_sites() {
        let g = gen_with("@code {\n  show(a: number) { return <p>@{ var v = <b>@a</b>; }</p>; }\n}\n<i>@show(1)</i>", &[]).code;
        // The outer literal is numbered first; the inner closes first.
        assert!(g.contains("}, this, __s1);") && g.contains("}, this, __s0)"), "{g}");
        assert!(g.contains("const __s0 = {};\nconst __s1 = {};\n"), "{g}");
        assert!(!g.contains("__s2"), "{g}");
    }

    #[test]
    fn a_ref_in_a_markup_value_goes_through_a_record() {
        let src = "@code {\n  input?: HTMLInputElement;\n  row(n: string) { return <label><input @ref=\"this.input\" /> @n</label>; }\n}\n<input @ref=\"input\" />\n@row(\"a\")";
        let g = gen_with(src, &[]).code;
        // Outside markup values the element is assigned as built; inside, the claim can set it to the element it kept.
        assert!(g.contains("this.input = _e"), "{g}");
        assert!(g.contains("__dom.ref(_e1, (__e) => this.input = __e);"), "{g}");
        assert_eq!(g.matches("__dom.ref(").count(), 1, "{g}");
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
        "@Routes(route)\n{\n",
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
        has("import { Component as __Component, dom as __dom, type El, type Markup as __Markup, type Route } from \"@source-crafter/xzor-runtime\";");
        has("import { routes as __routes, type AppRoute as __AppRoute } from \"./routes\";");
        has("    __dom.routesAt(_e0, __routes, [\n");
        has("      { kind: \"tag\", tag: \"admin\", render: (_route: Route, page: __Markup) => __Component.fragment((__p) => {\n        const _e1 = __t0() as El<\"main\">;\n        const _e2 = _e1.firstChild! as Text;\n        __dom.textAt(_e2, () => page);\n        __p.appendChild(_e1);\n      }, this, __s0) },\n");
        has("      { kind: \"regex\", re: C.__re1, page: true, render: (__route: Route<any, any>) => { const route = __route as __AppRoute & { match: { area: string } }; return __Component.fragment((__p) => {");
        has("__dom.textAt(_e4, () => route.match.area);");
        has("      { kind: \"pattern\", match: C.__m2, page: false, render: (__route: Route<any, any>) => { const route = __route as __AppRoute<{ doc: string }>; return __Component.fragment((__p) => {");
        has("__dom.textAt(_e6, () => route.params.doc);");
        has("      { kind: \"notFound\", render: () => __Component.fragment((__p) => {\n        const _e7 = __t3() as El<\"p\">;\n        __p.appendChild(_e7);\n      }, this, __s3) },\n");
        has("__dom.template([[\"p\", 0, \"Not found\"]]);");
        has("      { kind: \"catch\", render: (_route: Route, e: unknown) => __Component.fragment((__p) => {");
        has("__dom.textAt(_e9, () => e);");
        has("      { kind: \"default\", render: (_route: Route, page: __Markup) => __Component.fragment((__p) => {");
        has("    ]);\n");
        has("  static readonly __re1 = /^\\/admin\\/(?<area>\\w+)/i;\n");
        has("  static __m2(s: string[]): Record<string, string> | null {\n    if (s.length !== 2) return null;\n");
        has(crate::routes::DECODE);
        // The section bodies see the bound names, not `this`.
        assert!(!g.code.contains("this.route") && !g.code.contains("this.page"), "{}", g.code);
    }

    #[test]
    fn route_bindings_are_declared_only_when_the_body_uses_them() {
        let src = "@Routes(route) { @a(page) { <main>@page</main> } @notFound { <p/> } @catch(e) { <p>@e</p> } @\"/x/:id\" { <p/> } @default(page) { <p/> } }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s}\nmissing in\n{}", g.code);
        has("render: (_route: Route, page: __Markup) => __Component.fragment((__p) => {\n        const _e1 = __t0() as El<\"main\">;");
        has("{ kind: \"notFound\", render: () => ");
        has("{ kind: \"catch\", render: (_route: Route, e: unknown) => ");
        has("{ kind: \"default\", render: () => ");
        has("page: false, render: () => ");
        assert!(!g.code.contains("const route") && !g.code.contains("__route:") && !g.code.contains("AppRoute"), "{}", g.code);
        // Imports the bindings no longer use are dropped too.
        assert!(g.code.contains("import { Component as __Component, dom as __dom, type El, type Markup as __Markup, type Route } from \"@source-crafter/xzor-runtime\";"), "{}", g.code);
        assert!(g.code.contains("import { routes as __routes } from \"./routes\";"), "{}", g.code);
        let none = gen_with("@Routes(route) { @notFound { <p/> } }", &[]);
        assert!(none.code.contains("import { Component as __Component, dom as __dom, type El } from \"@source-crafter/xzor-runtime\";"), "{}", none.code);
        // The names inside text are not uses.
        let text = gen_with("@Routes(route) { @a(page) { <p>the page route</p> } @notFound { <p>route not found</p> } }", &[]);
        assert!(!text.code.contains("const route") && !text.code.contains(" page:"), "{}", text.code);
        let paged = gen_with("@Routes(route) { @\"/x/:id\"(page) { <p>@route.match.id @page</p> } }", &[]);
        assert!(paged.code.contains("const route = __route as __AppRoute & { match: { id: string } };"), "{}", paged.code);
        let used = gen_with("@Routes(route) { @a(page) { <p>@route.params.x</p> } }", &[]);
        assert!(used.code.contains("render: (__route: Route<any, any>) => { const route = __route as __AppRoute<__RouteParams[\"a\"]>; return "), "{}", used.code);
        assert!(used.code.contains("import { routes as __routes, type AppRoute as __AppRoute, type RouteParams as __RouteParams } from \"./routes\";"), "{}", used.code);
        let other = gen_with("@Routes(route) { @notFound { <p>@route.path</p> } }", &[]);
        assert!(other.code.contains("render: (__route: Route<any, any>) => { const route = __route as __AppRoute; return "), "{}", other.code);
        assert!(other.code.contains("import { routes as __routes, type AppRoute as __AppRoute } from \"./routes\";"), "{}", other.code);
    }

    #[test]
    fn the_route_variable_is_mapped_where_it_is_declared() {
        let src = "@Routes(route) { @a(page) { <p>@route.x</p> } @notFound { <i>@route.y</i> } }";
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
    fn routes_block_reports_its_tag_sections() {
        let g = gen_with(ROUTES_BLOCK, &[]);
        let block = g.routes_block.unwrap();
        assert_eq!(block.at, ROUTES_BLOCK.find("route)").unwrap());
        assert_eq!(block.sections, [("admin".to_string(), ROUTES_BLOCK.find("admin(page)").unwrap())]);
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
        assert!(g.code.contains("import { Component as __Component, dom as __dom, type El, type Props as __Props, type RenderFragment } from \"@source-crafter/xzor-runtime\";"), "{}", g.code);
        assert!(
            g.code.contains(r#"  declare slots: { header?: () => RenderFragment; item?: (x: this["items"][number], n: this["n"], arg2: string, length: this["title"]["length"], arg4: RenderFragment) => RenderFragment; extra?: (arg0: number) => RenderFragment; default?: () => RenderFragment };"#),
            "{}",
            g.code
        );
        assert!(g.code.contains("__dom.slotAt(_e1, () => this.slots.header, undefined, (__p) => {"), "{}", g.code);
        assert!(g.code.contains("__dom.textAt(_e6, () => this.title);"), "{}", g.code);
        assert!(g.code.contains(r#"__dom.slotAt(_e7, () => this.slots.item, () => [x, this.n, "s", this.title.length, __Component.fragment((__p) => {"#), "{}", g.code);
        assert!(g.code.contains("__dom.slotAt(_e3, () => this.slots.extra, () => [(this.n + 1) as number]);"), "{}", g.code);
        assert!(g.code.contains("__dom.slotAt(_e4, () => this.slots.default);"), "{}", g.code);
    }

    #[test]
    fn inject_of_a_contract_is_typed_remote() {
        let src = "@inject IPosts posts\n@inject IDatabase db\n<p>@db.name</p>";
        let doc = parse(src).unwrap().0;
        let run = |names: &[&str]| {
            let contracts = names.iter().map(|n| n.to_string()).collect();
            generate_in(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes", &contracts).unwrap()
        };
        let g = run(&["IPosts"]);
        assert!(g.code.contains("  readonly posts: Remote<IPosts>;\n"), "{}", g.code);
        assert!(g.code.contains("  readonly db: IDatabase;\n"), "{}", g.code);
        assert!(g.code.contains("constructor(posts: Remote<IPosts>, db: IDatabase)"), "{}", g.code);
        assert!(g.code.contains("import { Component as __Component, dom as __dom, type El, type Remote }"), "{}", g.code);
        assert_eq!(g.remotes, ["posts"]);
        let plain = run(&[]);
        assert!(plain.code.contains("  readonly posts: IPosts;\n") && !plain.code.contains("Remote"), "{}", plain.code);
        assert!(plain.remotes.is_empty());
    }

    #[test]
    fn inject_emits_constructor_and_fields() {
        let src = "@inject IDatabase db\n@inject AuthService auth\n<p>@db.name</p>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("  static readonly inject = [\"db\", \"auth\"];\n"), "{}", g.code);
        assert!(g.code.contains("  readonly db: IDatabase;\n"), "{}", g.code);
        assert!(g.code.contains("  readonly auth: AuthService;\n"), "{}", g.code);
        assert!(g.code.contains("  constructor(db: IDatabase, auth: AuthService) { super(); this.db = db; this.auth = auth; }\n"), "{}", g.code);
        assert!(g.code.contains("__dom.textAt(_e1, () => this.db.name);"), "{}", g.code);
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
        assert!(g.code.contains(r#"__dom.component(_e1, Card, (): __Props<Card> => ({ title: "x" }), undefined, { default: () => __Component.fragment((__p) => {"#), "{}", g.code);
        assert!(g.code.contains("__dom.textAt(_e5, () => this.n);"), "{}", g.code);
        assert!(g.code.contains("__dom.component(_e2, List<string>, (): __Props<List<string>> => ({ items: this.xs }), undefined, { header: () => __Component.fragment((__p) => {"), "{}", g.code);
        assert!(g.code.contains("}, this, __s1), item: (s, i: number = 0) => __Component.fragment((__p) => {"), "{}", g.code);
        assert!(g.code.contains("__dom.textAt(_e8, () => s);") && g.code.contains("__dom.textAt(_e10, () => i);"), "{}", g.code);
        assert!(g.code.contains("__dom.component(_e3, Other, (): __Props<Other> => ({}));"), "{}", g.code);
    }

    #[test]
    fn generic_component_without_type_args_infers_from_props() {
        let list = "@typeparam T\n@typeparam U = string\n@code { items: T[] = []; }\n@slot:item";
        let src = "@code { xs = [\"a\"]; }\n<List items=\"@xs\">\n  @slot item(x) { @x }\n</List>\n<List items=\"@xs\" />";
        let g = gen_with(src, &[("List", list)]);
        let fit = |p: &str| format!("typeof List.$fit extends (p: {p}) => void ? {p} & {{ [K in Exclude<keyof {p}, keyof __Props<List<any, any>>>]: never }} : never");
        let infer = |p: &str| {
            let i = "infer T, infer U";
            let ret = format!("ReturnType<typeof {p}>");
            format!("List<{ret} extends __Props<List<{i}>> ? T : unknown, {ret} extends __Props<List<{i}>> ? U : unknown>, {p} satisfies (() => {})", fit(&ret))
        };
        assert!(g.code.contains("const __p0 = () => ({ items: this.xs });"), "{}", g.code);
        assert!(g.code.contains(&format!("__dom.component(_e1, {}, undefined, {{ item: (x) =>", infer("__p0"))), "{}", g.code);
        assert!(g.code.contains("const __p1 = () => ({ items: this.xs });"), "{}", g.code);
        assert!(g.code.contains(&format!("__dom.component(_e2, {});", infer("__p1"))), "{}", g.code);
    }

    /// In a row the props object is hoisted into the shared read, which checks it as a call would infer it.
    #[test]
    fn generic_component_in_a_row_checks_its_props() {
        let list = "@typeparam T\n@code { items: T[] = []; }";
        let src = "@code { xs = [[\"a\"]]; }\n@for (const x of xs) {\n  <List items=\"@x\" />\n  <List T=\"string\" items=\"@x\" />\n}";
        let g = gen_with(src, &[("List", list)]);
        let fit = "typeof List.$fit extends (p: typeof __p0) => void ? typeof __p0 & { [K in Exclude<keyof typeof __p0, keyof __Props<List<any>>>]: never } : never";
        assert!(g.code.contains(&format!("(x): (__Props<List<any>>) => {{ const __p0 = {{ items: x }}; return __p0 satisfies {fit}; }},")), "{}", g.code);
        assert!(g.code.contains("(x): (__Props<List<string>>) => ({ items: x }),"), "{}", g.code);
        assert!(!g.code.contains("const __p1"), "{}", g.code);
    }

    /// A literal-typed text prop (`depth?: "0" | "1"`) keeps its literal type in the hoisted object, so it
    /// does not widen to `string` and break the inference of every type parameter.
    #[test]
    fn hoisted_static_text_props_stay_literal() {
        let table = "@typeparam T\n@code { items: T[] = []; depth?: \"0\" | \"1\"; caption = \"\"; }";
        let src = "@code { xs = [1]; }\n<Table items=\"@xs\" depth=\"1\" caption=\"Rows of @xs.length\" />";
        let g = gen_with(src, &[("Table", table)]);
        assert!(g.code.contains("const __p0 = () => ({ items: this.xs, depth: \"1\" as const, caption: "), "{}", g.code);
        assert!(!g.code.contains("this.xs.length as const"), "{}", g.code);
    }

    #[test]
    fn explicit_type_args_and_plain_components_are_not_hoisted() {
        let list = "@typeparam T\n@code { items: T[] = []; }";
        let src = "@code { xs = [\"a\"]; }\n<List T=\"string\" items=\"@xs\" />\n<Card title=\"x\" />";
        let g = gen_with(src, &[("List", list), ("Card", "<p/>")]);
        assert!(g.code.contains("__dom.component(_e1, List<string>, (): __Props<List<string>> => ({ items: this.xs }));"), "{}", g.code);
        assert!(g.code.contains("__dom.component(_e2, Card, (): __Props<Card> => ({ title: \"x\" }));"), "{}", g.code);
        assert!(!g.code.contains("const __p0"), "{}", g.code);
    }

    #[test]
    fn ref_assigns_elements_and_components() {
        let src = "@code { input?: HTMLInputElement; child?: Counter; }\n<input @ref=\"input\" />\n<Counter @ref=\"child\" label=\"a\" />\n<my-el @ref=\"input\" />";
        let g = gen_with(src, &[("Counter", "@code { label = \"\"; }")]);
        for m in ["this.input = _e1;", "__dom.component(_e2, Counter, (): __Props<Counter> => ({ label: \"a\" }), undefined, undefined, (__c) => { this.child = __c; });", "this.input = _e3;"] {
            assert!(g.code.contains(m), "{m} missing in\n{}", g.code);
        }
    }

    #[test]
    fn razor_template_syntax() {
        let src = "@inherits Base<number>\n@implements Named, Sized\n@attribute sealed\n@attribute tag(\"x\")\n@code { n = 1; items = [1]; extra = {}; stop = true; }\n@* gone *@\n<p>a@* also gone *@b</p>\n@{\n  const total = items.length + n;\n  const badge = <b>@total</b>;\n  <i>@total</i>\n  @: Count: @total!\n}\n@while (n < 3) { <u/> }\n<text>hi @total</text>\n<p @attributes=\"extra\" class=\"x\" @onsubmit:preventDefault @onclick:stopPropagation=\"stop\"></p>\n<Card @attributes=\"extra\" title=\"t\" />";
        let g = gen_with(src, &[("Card", "@code { title = \"\"; }")]);
        let has = |s: &str| assert!(g.code.contains(s), "missing {s:?} in\n{}", g.code);
        has("@sealed\n@tag(\"x\")\nexport default class C extends Base<number> implements Named, Sized {");
        assert!(!g.code.contains("gone"), "{}", g.code);
        has("__dom.template([[\"p\", 0, \"ab\"], null, null]);");
        has("const total = this.items.length + this.n;");
        has("const badge = __Component.fragment((__p) => {");
        has("__dom.textAt(_e3, () => total);");
        has("__dom.template([[\"i\", 0, \"\"]]);");
        has("__dom.template([\"Count: \", \"\", \"!\"]);");
        has("__dom.regionAt(_e9, (__p) => {\n        while (this.n < 3) {\n          const _e13 = __t5() as El<\"u\">;\n          __p.appendChild(_e13);\n        }\n      });");
        has("\"hi \", \"\"");
        has("__dom.textAt(_e10, () => total);");
        assert!(!g.code.contains("[\"text\""), "{}", g.code);
        has("__dom.attrs(_e11, () => this.extra, [\"class\"]);\n      __dom.on(_e11, \"submit\", undefined, 1);\n      __dom.on(_e11, \"click\", (__e: any) => { if (this.stop) __e.stopPropagation(); });");
        has("__dom.component(_e12, Card, (): __Props<Card> => ({ ...this.extra, title: \"t\" }));");
    }

    #[test]
    fn event_callbacks_and_binding() {
        let counter = "@code { onChange?: EventCallback<number>; onReset?: EventCallback; value = 0; valueChanged?: EventCallback<number>; }";
        let src = "@code { n = 1; name = \"\"; ok = false; save() {} }\n<Counter onChange=\"save\" onReset=\"() => n = 0\" @bind-value=\"n\" />\n<input @bind=\"name\" />\n<input type=\"checkbox\" @bind=\"ok\" @bind:event=\"oninput\" @bind:after=\"save\" />";
        let g = gen_with(src, &[("Counter", counter)]);
        assert!(g.code.contains("__dom.component(_e1, Counter, (): __Props<Counter> => ({ value: this.n }), { onChange: __dom.callback(this, this.save.bind(this)), onReset: __dom.callback(this, () => this.n = 0), valueChanged: __dom.callback(this, (__v) => { this.n = __v; }) });"), "{}", g.code);
        assert!(g.code.contains("__dom.attr(_e2, \"value\", () => this.name);\n    __dom.on(_e2, \"change\", (__e) => { this.name = __Component.bindValue(__e, this.name); });"), "{}", g.code);
        assert!(g.code.contains("__dom.attr(_e3, \"checked\", () => this.ok);\n    __dom.on(_e3, \"input\", (__e) => { this.ok = __Component.bindValue(__e, this.ok); return this.save(); });"), "{}", g.code);
    }

    #[test]
    fn module_code_sits_before_the_class_without_this() {
        let src = "@module {\n  export const sizes = [\"s\", \"m\"];\n  const tag = (t: string) => <b>@t @sizes</b>;\n}\n@code { n = 0; }\n<p>@sizes.length @n @tag(\"x\")</p>";
        let g = gen_with(src, &[]);
        let module = g.code.find("export const sizes").expect(&g.code);
        assert!(module < g.code.find("export default class").unwrap(), "{}", g.code);
        assert!(g.code.contains("const tag = (t: string) => __Component.fragment((__p) => {"), "{}", g.code);
        assert!(!g.code.contains("this.sizes") && !g.code.contains("this.tag"), "{}", g.code);
        assert!(g.code.contains("this.n"), "{}", g.code);
    }

    #[test]
    fn dom_event_syntax_on_a_component_sets_its_callback() {
        let counter = "@code { onChange?: EventCallback<number>; label = \"\"; }";
        let g = gen_with("@code { save() {} }\n<Counter @onchange=\"save\" />", &[("Counter", counter)]);
        assert!(g.code.contains("__dom.component(_e0, Counter, (): __Props<Counter> => ({}), { onChange: __dom.callback(this, this.save.bind(this)) });"), "{}", g.code);
        let doc = parse("<Counter @onlabel=\"x\" />").unwrap().0;
        let infos = HashMap::from([("Counter".to_string(), component_info(counter))]);
        let err = generate_with(&doc, "C", "C.xzor", &infos, &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("has no EventCallback prop for @onlabel"), "{err}");
    }

    #[test]
    fn typeparam_makes_a_generic_class() {
        let (doc, _) = parse("@typeparam T extends object\n@typeparam U\n<p/>").unwrap();
        let g = generate(&doc, "Grid", "Grid.xzor").unwrap();
        assert!(g.code.contains("export default class Grid<T extends object, U> extends __Component {"), "{}", g.code);
        assert!(g.code.contains("declare static readonly $fit: <T extends object, U>(p: __Props<Grid<T, U>>) => void;"), "{}", g.code);
    }

    #[test]
    fn components_build_the_dom_once_with_bindings() {
        let src = "@code {\ncount = 0;\nlabel = \"\";\nok = false;\nteam: Worker[] = [];\nel?: HTMLElement;\ninc() { this.count++; }\n}\n<div class=\"team\" title=\"n @label\">\n<button @onclick=\"inc\" @ref=\"el\">@count</button>\n<input @bind=\"label\" @bind:event=\"oninput\" />\n<input type=\"checkbox\" @bind=\"ok\" />\n@if (count > 1) {\n<p>many</p>\n} else {\n<p>few</p>\n}\n@for (const w of team) {\n<li>@w.name <b>@(w.hours * 2)</b></li>\n}\n@for (let i = 0; i < count; i++) {\n<i>@i</i>\n}\n@for (const [k, v] of Object.entries(team)) {\n@if (v) {\n<u>@k</u>\n}\n}\n@{ const total = count * 2; }\n<span>@total</span>\n</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("import { Component as __Component, dom as __dom, type El } from \"@source-crafter/xzor-runtime\";");
        has("export default class C extends __Component {");
        has("protected override render(__p: Node): void {");
        // Elements and static text are a template, cloned; each dynamic part binds the node it has in place.
        has("const __t0 = __dom.template([[\"div\", [\"class\", \"team\"], [\"button\", 0, \"\"], [\"input\", 0], [\"input\", [\"type\", \"checkbox\"]], null, null, null, null, null, null, null]]);");
        has("const _e0 = __t0() as El<\"div\">;\n    const _e1 = _e0.firstChild! as El<\"button\">;\n    const _e2 = _e1.firstChild! as Text;\n    const _e3 = _e1.nextSibling! as El<\"input\">;");
        has("__dom.attr(_e0, \"title\", () => \"n \" + String(this.label));");
        has("__dom.on(_e1, \"click\", this.inc.bind(this));");
        has("this.el = _e1;");
        has("__dom.textAt(_e2, () => this.count);");
        has("__dom.attr(_e3, \"value\", () => this.label);");
        has("__dom.on(_e3, \"input\", (__e) => { this.label = __Component.bindValue(__e, this.label); });");
        has("__dom.attr(_e4, \"checked\", () => this.ok);");
        has("__dom.on(_e4, \"change\", (__e) => { this.ok = __Component.bindValue(__e, this.ok); });");
        has("__dom.branchAt(_e5, (__p) => {\n      if (this.count > 1) {\n        if (!__p) return 0;\n        const _e10 = __t1() as El<\"p\">;\n        __p.appendChild(_e10);");
        // A row's bindings share the list's reads, which take the item.
        has("__dom.listAt(_e6, () => this.team, [\n      (w) => w.name,\n      (w) => w.hours * 2,\n    ], (__p) => {\n      const _e12 = __t3() as El<\"li\">;");
        has("__dom.textItem(_e13, 0);");
        has("__dom.textItem(_e15, 1);");
        has("const __t3 = __dom.template([[\"li\", 0, \"\", \" \", [\"b\", 0, \"\"]]]);");
        has("for (let i = 0; i < this.count; i++) {");
        has("__dom.textAt(_e17, () => i);");
        // Destructured items (entries, tuples) are new on every run: a keyed list would rebuild every row.
        has("for (const [k, v] of Object.entries(this.team)) {");
        assert!(!g.code.contains("[k, v]) =>"), "{}", g.code);
        // Keyed by a pass counter: a pass that saw the same `k` and `v` keeps its row, and its `@if` is a region.
        has("for (const [k, v] of Object.entries(this.team)) {\n        const __p = __pass(__i++, [k, v]);");
        // A `@{ }` block and the siblings after it are one region: its locals stay in scope and current.
        has("__dom.regionAt(_e9, (__p) => {\n      const total = this.count * 2;");
        has("() => total);");
        has("__p.appendChild(_e0);");
        assert!(!g.code.contains("__b."), "{}", g.code);
    }

    #[test]
    fn async_components_load_on_first_use_and_cached_ones_say_so() {
        let chart = "@async\n@code { label = \"\"; }\n<p>@label</p>";
        let g = gen_with("@import Chart from \"./Chart.xzor\"\n@cached\n<Chart label=\"x\" />", &[("Chart", chart)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("import { Component as __Component, dom as __dom, lazy as __lazy, type Props as __Props } from \"@source-crafter/xzor-runtime\";");
        // The class stays a type for the props; the tree gets its loader.
        has("import type Chart from \"./Chart.xzor\";\nconst __lazy_Chart = __lazy<typeof Chart>(() => import(\"./Chart.xzor\"));");
        has("__dom.component(_e0, __lazy_Chart, (): __Props<Chart> => ({ label: \"x\" }));");
        has("static readonly cached = true;");
    }

    #[test]
    fn getters_are_cached_unless_volatile() {
        let src = "@code {\n  n = 1;\n  get total(): number { return this.n * 2; }\n  @Volatile get now(): number { return Date.now(); }\n  static get shared(): number { return 1; }\n  set total2(v: number) {}\n}\n<p>@total @now</p>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("static { __dom.memo(this, [\"total\"]); }"), "{}", g.code);
        assert!(!g.code.contains("@Volatile"), "{}", g.code);
    }

    #[test]
    fn await_blocks_show_pending_then_and_catch() {
        let src = "@code { q = \"\"; load(q: string): Promise<string[]> { return Promise.resolve([q]); } }\n<ul>@await (load(q)) {<li>…</li>} then (rows) {@for (const r of rows) {<li>@r</li>}} catch (e) {<li>@String(e)</li>}</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.awaitCallAt(_e1, () => [this.q], (__a0) => this.load(__a0), (__p) => {");
        has("}, (__p, rows) => {");
        has("__dom.listAt(");
        has("}, (__p, e) => {");
        has("() => String(e)");
        // Arguments with nested calls, strings and commas; a callee through a member chain.
        let g = gen_with("@code { q = \"\"; api = { find: (a: string, b: number[]) => Promise.resolve(a) }; }\n@await (api.find(q.trim(), [1, 2])) {} then (v) {@v}", &[]);
        assert!(g.code.contains("__dom.awaitCallAt(_e0, () => [this.q.trim(), [1, 2]], (__a0, __a1) => this.api.find(__a0, __a1), "), "{}", g.code);
        // Anything else, or a call without arguments, runs whole on every change.
        for promise in ["load()", "q ? load(q) : load(\"\")", "load(q).then((r) => r)", "load(...qs)", "load(`${q}`)"] {
            let g = gen_with(&format!("@code {{ q = \"\"; qs: string[] = []; load(...a: string[]) {{ return Promise.resolve(a); }} }}\n@await ({promise}) {{}}"), &[]);
            assert!(g.code.contains("__dom.awaitAt(") && !g.code.contains("awaitCallAt"), "{promise}:\n{}", g.code);
        }
        // Inside a component's content (a slot fill) it builds like anywhere else.
        let g = gen_with("@code { p = Promise.resolve(1); }\n<Card>@await (p) { } then { }</Card>", &[("Card", "<p/>")]);
        assert!(g.code.contains("__dom.awaitAt("), "{}", g.code);
    }

    #[test]
    fn leave_marks_the_element() {
        let src = "@code { open = true; }\n@if (open) {<dialog @leave>x</dialog>}";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("[\"dialog\", [\"data-leave\", \"\"], \"x\"]"), "{}", g.code);
        assert!(g.code.contains("__Component.$leaves = true;"), "{}", g.code);
        assert!(!gen_with("@code { open = true; }\n<p>x</p>", &[]).code.contains("$leaves"));
    }

    #[test]
    fn class_toggles() {
        let src = "@code { err = \"\"; }\n<div class=\"field\" class:invalid=\"@err\" class:round>x</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The static class stays in the template; each toggle is its own binding.
        has("[\"div\", [\"class\", \"field\"], \"x\"]");
        has("__dom.attr(_e0, \"class:invalid\", () => this.err);");
        has("__dom.attr(_e0, \"class:round\", () => true);");
    }

    #[test]
    fn bind_debounce_waits_for_a_pause() {
        let src = "@code { q = \"\"; filter() {} }\n<input @bind:input=\"q\" @bind:debounce=\"300\" @bind:after=\"filter\" />";
        let g = gen_with(src, &[]);
        // The value shown stays bound; the write back waits, and its promise re-renders after it.
        assert!(g.code.contains("(__e) => __Component.debounce(__e, 300, () => { this.q = __Component.bindValue(__e, this.q); return this.filter(); })"), "{}", g.code);
        let err = generate_with(&parse("<input @bind=\"q\" @bind:debounce=\"soon\" />").unwrap().0, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("@bind:debounce requires milliseconds"), "{err}");
    }

    #[test]
    fn bind_input_is_bind_on_input() {
        let src = "@code { q = \"\"; }\n<input @bind:input=\"q\" />";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.attr(_e0, \"value\", () => this.q);");
        has("__dom.on(_e0, \"input\", (__e) => { this.q = __Component.bindValue(__e, this.q); });");
    }

    #[test]
    fn once_builds_without_bindings() {
        let src = "@code { n = 0; xs: string[] = []; show = true; }\n<p>at @once(n) now @n</p>\n@if (show) {\n@once {\n<b title=\"@n\">@n</b>\n@for (const x of xs) {<i>@x</i>}\n}\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // A value read once into its hole; the other `@n` stays bound.
        has("__dom.textOnce(_e2, () => this.n);");
        has("__dom.textAt(_e3, () => this.n);");
        // A block built once: plain control flow, values set, no binding inside.
        has("__dom.onceAt(");
        has("__dom.set(_e");
        has("__dom.setText(_e");
        has("for (const x of this.xs) {");
        let block = &g.code[g.code.find("__dom.onceAt(").unwrap()..];
        assert!(!block[..block.find("});\n").unwrap()].contains("__dom.textAt"), "{}", g.code);
        // `@attributes` inside it is set, not bound; what is written after it still wins.
        let g = gen_with("@code { bag = {}; }\n@once { <p @attributes=\"bag\" class=\"x\" /> }", &[]);
        assert!(g.code.contains("__dom.setAttrs(_e") && g.code.contains("this.bag, [\"class\"]);") && !g.code.contains("__dom.attrs("), "{}", g.code);
    }

    #[test]
    fn parent_attributes_set_the_enclosing_element() {
        let src = "@code { n = 0; items: string[] = []; }\n<span>@if (n > 0) { @n } else { @attr:class=\"error-text\" none }</span>\n<ul>@for (const it of items) {<li>@if (it) { @attr:title=\"@it\" }</li>}</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.attrOf(_e1, \"class\", () => \"error-text\");");
        // The value is read like any other binding.
        let g = gen_with("@code { n = 0; }\n<span>@if (n > 0) { @n } else { @attr:class=\"error-text @n\" none }</span>", &[]);
        assert!(g.code.contains("__dom.attrOf(_e0, \"class\", () => \"error-text \" + String(this.n));"), "{}", g.code);
        // In a row, a region naming the row's element builds in the row, not in the list's shared reads.
        has("__dom.branchAt(");
        has("__dom.attrOf(_e");
        has(", \"title\", () => it);");
        let doc = parse("@attr:class=\"x\"").unwrap().0;
        let err = generate_with(&doc, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        assert!(err.contains("@attr:class needs an enclosing element"), "{err}");
    }

    #[test]
    fn loops_render_their_else_when_no_pass_ran() {
        let g = gen_with("@code { xs: number[] = []; n = 0; }\n@for (const x of xs) {<i>@x</i>} else {<p>none</p>}\n@while (n < 0) { <b/> } else { <u/> }", &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.listAt(_e1, () => this.xs, [\n      (x) => x,\n    ], (__p) => {");
        has("    }, (__p) => {\n      const _e5 = __t2() as El<\"p\">;");
        // A plain loop runs in a region and tracks whether a pass ran.
        has("{\n        let __none = true;\n        while (this.n < 0) {\n          __none = false;");
        has("if (__none) {\n          const _e7 = __t4() as El<\"u\">;");
    }

    #[test]
    fn keyed_loops_render_their_else_when_no_pass_ran() {
        let src = "@code { xs: string[] = []; }\n<ul>\n@for (const x of xs) {\n<li>@x</li>\n} else {\n<li>@xs.length</li>\n}\n</ul>\n@for (let i = 0; i < xs.length; i++) {\n<b>@i</b>\n} else {\n<u/>\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The else is the list's empty build: its bindings close over their values, as in a region.
        has("], (__p) => {\n      const _e");
        has("}, (__p) => {\n      const _e");
        has("__dom.textAt(");
        has("for (let i = 0; i < this.xs.length; i++) {\n        const __p = __pass(__i++, [i]);\n        if (__p !== undefined) {");
        has("}, (__p) => {\n      const _e10 = __t4() as El<\"u\">;");
    }

    #[test]
    fn loops_key_their_passes() {
        let src = "@code {\n  @Key(\"sku\") lines: { sku: string; qty: number }[] = [];\n  team: Record<string, number> = {};\n  n = 0;\n}\n<ul>@for (const l of lines.filter((x) => x.qty > 0)) {<li>@l.sku</li>}</ul>\n<ol>@for (const [k, v] of Object.entries(team)) {<li>@k @if (v > 1) {<b>many</b>}</li>} else {<p>none</p>}</ol>\n<p>@for (let i = 0; i < n; i++) @key(i * 2) {<i>@i</i>}</p>\n@for (const r of lines) @key(r.sku + r.qty) {<s>@r.sku</s>}\n@for (const [a, b] of Object.entries(team)) { @{ const c = b; } <u>@a @c</u> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The field's `@Key` keys the loops over it, through array methods that keep its items.
        has("}, undefined, (l) => l.sku);");
        assert!(!g.code.contains("@Key"), "{}", g.code);
        // No key: a pass counter; the row's nested `@if` is a region of its own.
        has("dom.keyedAt(");
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
    fn a_row_elements_key_keys_its_loop() {
        let src = "@code { rows: { id: number }[] = []; n = 0; }\n<ul>@for (const r of rows) {\n  <li @key=\"r.id\">@r.id</li>\n}</ul>\n<p>@for (let i = 0; i < n; i++) {<i @key=\"i * 2\">@i</i>}</p>\n<div>@for (const r of rows) {<Row @key=\"r.id\" />}</div>";
        let g = gen_with(src, &[("Row", "")]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("}, undefined, (r) => r.id);");
        has("const __p = __pass(i * 2, [i]);");
        assert_eq!(g.code.matches("}, undefined, (r) => r.id);").count(), 2, "{}", g.code);
    }

    #[test]
    fn an_element_key_that_keys_no_row_is_an_error() {
        let rows = "@code { rows: { id: number }[] = []; }\n";
        for body in [
            "<p @key=\"1\">x</p>",
            "<ul>@for (const r of rows) {<li><b @key=\"r.id\">x</b></li>}</ul>",
            "<ul>@for (const r of rows) {<li @key=\"r.id\">a</li><li>b</li>}</ul>",
            "<ul>@for (const r of rows) @key(r.id) {<li @key=\"r.id\">a</li>}</ul>",
        ] {
            let err = gen_err(&format!("{rows}{body}"), &[]);
            assert!(err.contains("@key"), "{body}: {err}");
        }
    }

    #[test]
    fn a_lone_control_flow_block_takes_its_place_without_a_template() {
        let src = "@code { items: { done: boolean }[] = []; team: Record<string, number> = {}; sel = \"\"; }\n<ul>@for (const it of items) {@if (it.done) {<li>done</li>}}</ul>\n<ol>@for (const [k, v] of Object.entries(team)) {@if (sel === k) {<li>@k</li>}}</ol>\n<div>@for (const [k, v] of Object.entries(team)) {@if (v > 1) {<b>@k</b>}}</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // No two-comment templates: the anchors go straight in.
        assert!(!g.code.contains("dom.template([null, null])") && !g.code.contains("dom.template([null])"), "{}", g.code);
        has("= __dom.anchors(__p);\n");
        // A keyed loop only needs its end: one anchor in its element's template.
        has("[\"ol\", 0, null]");
        // A row that is only a pass-only `@if` builds it straight into the row.
        has("const __p = __pass(__i++, [k, v]);\n        if (__p !== undefined) {\n          if (v > 1) {");
        // A member of a pass value can change while the value stays: `t.done` and `else if` conditions keep a region.
        let g = gen_with("@code { m: Record<string, { done: boolean }> = {}; }\n<ol>@for (const [k, t] of Object.entries(m)) {@if (k === \"a\") {<b/>} else if (t.done) {<i/>}}</ol>", &[]);
        assert!(g.code.contains("dom.branchAt("), "{}", g.code);
    }

    #[test]
    fn nested_flow_in_a_region_gets_its_own_regions_and_lists() {
        let src = "@code { open = false; items = [\"a\"]; text = \"\"; }\n@if (open) {\n<dialog>\n<input @bind=\"text\" />\n@if (text.length > 2) {\n<p>long</p>\n}\n<ul>\n@for (const it of items) {\n<li>@it</li>\n}\n</ul>\n</dialog>\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // The outer region only reads `open`: the nested `@if` and `@for` bind on their own.
        has("__dom.branchAt(_e0, (__p) => {\n      if (this.open) {\n        if (!__p) return 0;\n        const _e1 = __t0() as El<\"dialog\">;");
        has("__dom.branchAt(_e3, (__p) => {\n          if (this.text.length > 2) {");
        has("__dom.listAt(_e5, () => this.items, [\n          (it) => it,\n        ], (__p) => {");
        assert!(!g.code.contains("for (const it of"), "{}", g.code);
    }

    #[test]
    fn show_blocks_hide_their_branches_and_pause_what_asks() {
        let src = "@code { tab = \"a\"; n = 1; }\n@show:if (tab === \"a\") {\n<p>@n</p>\n} else {\n@pause\n<section>@n</section>\n}\n<div>@show:switch (n) { case 1: <b>one</b> default: <i>@pause { <u>@n</u> }</i> }</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.showAt(_e1, (__p) => {\n      if (this.tab === \"a\") {\n        if (!__p) return 0;\n");
        has("} else {\n        if (!__p) return 1;\n");
        has("      }\n      return 2;\n    });");
        // Bare `@pause` takes the whole branch; `@pause { }` its block, at any depth.
        assert_eq!(g.code.matches("__dom.pauseAt(").count(), 2, "{}", g.code);
        has("case 1: {\n          if (!__p) return 0;\n");
        let err = |src: &str| generate_with(&parse(&format!("@code {{ a = 1; }}\n{src}")).unwrap().0, "C", "C.xzor", &HashMap::new(), &HashSet::new(), "./routes").unwrap_err();
        for top in ["text", "@a", "@if (a) {<b/>}", "<Child />"] {
            assert!(err(&format!("@show:if (a) {{ {top} }}")).contains("wrap it in an element"), "{top}");
        }
        assert!(err("@show:if (a) { <b/> @pause <i/> }").contains("bare @pause goes first in a @show branch"));
        assert!(err("<p>@pause { <b/> }</p>").contains("@pause belongs in a @show:if or @show:switch branch"));
        // In a component's content (a slot fill) it builds like anywhere else.
        let g = gen_with("@code { a = 1; }\n<Card>@show:if (a) { <b/> }</Card>", &[("Card", "<p/>")]);
        assert!(g.code.contains("__dom.showAt("), "{}", g.code);
    }

    #[test]
    fn if_and_switch_rebuild_only_when_their_branch_changes() {
        let src = "@code { count = 3; list: { id: number }[] = []; kind = \"a\"; }\n@if (!count) {\n<p>none</p>\n} else if (count > 9) {\n<b>many</b>\n} else {\n<ul>@for (const n of list) @key(n.id) {<li>@n.id</li>}</ul>\n}\n@switch (kind) { case \"a\": case \"b\": <i>ab</i> default: <u>other</u> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // Called without a parent it only picks the branch: same branch, same DOM.
        has("__dom.branchAt(_e1, (__p) => {\n      if (!this.count) {\n        if (!__p) return 0;\n");
        has("} else if (this.count > 9) {\n        if (!__p) return 1;\n");
        has("} else {\n        if (!__p) return 2;\n");
        has("      }\n      return 3;\n    });");
        has("case \"b\": {\n          if (!__p) return 0;\n");
        has("default: {\n          if (!__p) return 1;\n");
        has("      }\n      return 2;\n    });");
        // Code run while a branch builds would go stale in a kept branch: that one stays a plain region.
        let g = gen_with("@code { n = 1; }\n@if (n > 0) {\n@{ const twice = n * 2; }\n<p>@twice</p>\n}", &[]);
        assert!(g.code.contains("dom.regionAt(") && !g.code.contains("branchAt"), "{}", g.code);
        // A row's `@if` picks its branch from the row's item, so a row that takes a new item keeps it too.
        let g = gen_with("@code { lines: { qty: number }[] = []; }\n<ul>@for (const l of lines) {<li>@if (l.qty > 1) {<b/>} else {<i/>}</li>}</ul>", &[]);
        assert!(g.code.contains("dom.branchItem(") && g.code.contains("(l, __p) => {\n"), "{}", g.code);
        assert!(g.code.contains("if (!__p) return 0;"), "{}", g.code);
        // A row whose nested list or child component closes over the item can be given a new one (#6).
        let g = gen_with("@code { people: { id: number; roles: string[] }[] = []; ROLES = [\"a\"]; }\n<ul>@for (const p of people) @key(p.id) {<li>@for (const r of ROLES) @key(r) {<b>@(p.roles.includes(r) ? r : \"\")</b>}</li>}</ul>", &[]);
        assert!(g.code.contains("], (__p, p) => {\n      __dom.rowItem((__v: typeof p) => { p = __v; });\n"), "{}", g.code);
    }

    #[test]
    fn rows_share_their_reads_and_handlers() {
        let src = "@code { team: Worker[] = []; pick(w: Worker) {} }\n<ul>\n@for (const w of team) {\n<li class=\"@w.kind\" @onclick=\"() => pick(w)\"><input @bind=\"w.name\" />@if (w.late) {\n<b>@w.name</b>\n}\n<i @onclick=\"pick\">@team.length</i></li>\n}\n</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.listAt(_e1, () => this.team, [\n      (w) => w.kind,\n      (w): ((e: any) => unknown) => () => this.pick(w),\n      (w) => w.name,\n      (w): ((e: any) => unknown) => (__e) => { w.name = __Component.bindValue(__e, w.name); },\n      (w, __p) => {\n        if (w.late) {");
        // A read that does not use the item does not name it.
        has("(_): ((e: any) => unknown) => this.pick.bind(this),\n      (_) => this.team.length,\n    ], (__p) => {");
        has("dom.attrItem(_e2, \"class\", 0);");
        has("dom.onItem(_e2, \"click\", 1);");
        has("dom.attrItem(_e3, \"value\", 2);");
        has("dom.onItem(_e3, \"change\", 3);");
        has("dom.branchItem(_e4, 4);");
        // Inside the row's region, bindings close over the item as usual.
        has("dom.textAt(_e8, () => w.name);");
    }

    #[test]
    fn components_slots_cascades_and_attributes_bind_in_place() {
        let card = "@code { title = \"\"; }\n<section>@title</section>";
        let src = "@code { n = 1; show = true; extra = {}; }\n<div>\n<Card title=\"@(n)\"><b>@n</b></Card>\n<p @onclick:preventDefault @onclick=\"() => n++\">x</p>\n<p @attributes=\"extra\" />\n@cascade:theme(n) { <i>@n</i> }\n@slot\n@if (show) {\n<Card />\n}\n</div>";
        let g = gen_with(src, &[("Card", card)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // A lone component needs no template: its anchor goes straight into the region's fragment.
        has("const _e11 = __dom.anchor(__p);\n        __dom.component(_e11, Card, (): __Props<Card> => ({}));");
        has("__dom.component(_e1, Card, (): __Props<Card> => ({ title: this.n }), undefined, { default: () => __Component.fragment((__p) => {");
        has("__dom.on(_e2, \"click\", () => this.n++, 1);");
        has("__dom.attrs(_e3, () => this.extra);");
        has("__dom.cascadeAt(_e4, \"theme\", () => this.n, false, (__p) => {");
        has("__dom.slotAt(_e5, () => this.slots.default);");
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
        assert_eq!(lookup("protected override render", 0), None);
    }

    #[test]
    fn cascade_blocks_open_a_cascade_region() {
        let src = "@code { theme = \"dark\"; }\n@cascade:theme(theme) { <b/> }\n@cascade:cfg(1, fixed) { <i/> }";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "missing {s:?} in\n{}", g.code);
        // The body is a JS block so that siblings can declare the same `@{ const }` names.
        has("    __dom.cascadeAt(_e1, \"theme\", () => this.theme, false, (__p) => {\n      const _e3 = __t1() as El<\"b\">;\n      __p.appendChild(_e3);\n    });");
        has("    __dom.cascadeAt(_e2, \"cfg\", () => 1, true, (__p) => {");
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
        has("__dom.textAt(_e1, () => this.theme);");
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
    fn attributes_bag_skips_only_the_names_written_after_it() {
        let src = "@code { bag = {}; n = 1; }\n<p class=\"a\" @attributes=\"bag\" id=\"b\" data-x=\"@n\" @onclick=\"() => n++\" aria:x=\"y\">t</p>\n<Card title=\"t\" @attributes=\"bag\" size=\"s\" />";
        let g = gen_with(src, &[("Card", "@code { title = \"\"; size = \"\"; }")]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // Only plain names after the bag are skipped: not `class` (before), `@onclick` or the `:` one; what is
        // written before it is given as pairs, so the bag can restore it.
        has("__dom.attrs(_e1, () => this.bag, [\"id\", \"data-x\"], [\"class\", \"a\"]);");
        // On a component the bag spreads in written order, so the later `size` wins.
        has("__dom.component(_e2, Card, (): __Props<Card> => ({ title: \"t\", ...this.bag, size: \"s\" }));");
        let last = gen_with("@code { bag = {}; }\n<p id=\"b\" @attributes=\"bag\"></p>", &[]);
        assert!(last.code.contains("__dom.attrs(_e0, () => this.bag, undefined, [\"id\", \"b\"]);"), "{}", last.code);
        let alone = gen_with("@code { bag = {}; }\n<p @attributes=\"bag\"></p>", &[]);
        assert!(alone.code.contains("__dom.attrs(_e0, () => this.bag);"), "{}", alone.code);
    }

    #[test]
    fn attributes_bag_takes_what_is_written_before_it_and_the_class_toggles() {
        let src = "@code { bag = {}; n = 1; on = true; }\n<p id=\"s\" title=\"@n\" class:x=\"@on\" @attributes=\"bag\" class:y data-z=\"@n\"></p>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // Static and dynamic ones before the bag, and every `class:` toggle wherever written, go through the bag's binding.
        has("__dom.attrs(_e0, () => this.bag, [\"data-z\"], [\"id\", \"s\", \"title\", () => this.n, \"class:x\", () => this.on, \"class:y\", true]);");
        // They have no binding of their own; what follows the bag keeps its own.
        assert!(!g.code.contains("__dom.attr(_e0, \"title\"") && !g.code.contains("__dom.attr(_e0, \"class:"), "{}", g.code);
        has("__dom.attr(_e0, \"data-z\", () => this.n);");
        // In @once only the toggles are given: the rest is set once, in order.
        let once = gen_with("@code { bag = {}; on = true; }\n@once { <p title=\"@(on)\" @attributes=\"bag\" class:x=\"@on\" /> }", &[]);
        assert!(once.code.contains("__dom.setAttrs(_e1, this.bag, undefined, [\"class:x\", this.on]);"), "{}", once.code);
    }

    #[test]
    fn callback_props_are_set_once_only_for_a_lambda_or_a_member_name() {
        let card = [("Card", "@code { onPick?: EventCallback<number>; header?: RenderFragment; }")];
        let one = |tag: &str| gen_with(&format!("@code {{ editing = false; frag = <b/>; save() {{}} cancel() {{}} handlerFor(m: string) {{ return () => {{}}; }} }}\n{tag}"), &card).code;
        // Set once: a lambda, a bare member, `this.member`.
        assert!(one("<Card onPick=\"@(() => editing = true)\" />").contains("({}), { onPick: __dom.callback(this, () => this.editing = true) });"));
        assert!(one("<Card onPick=\"@save\" />").contains("({}), { onPick: __dom.callback(this, this.save.bind(this)) });"));
        assert!(one("<Card @onpick=\"this.save\" />").contains("({}), { onPick: __dom.callback(this, this.save) });"));
        // Read again on each pass, so what it gives is current: a conditional, a factory call.
        let cond = one("<Card onPick=\"@(editing ? save : cancel)\" />");
        assert!(cond.contains("(): __Props<Card> => ({ onPick: __dom.callback(this, this.editing ? this.save : this.cancel) }));"), "{cond}");
        let call = one("<Card onPick=\"@handlerFor('a')\" />");
        assert!(call.contains("(): __Props<Card> => ({ onPick: __dom.callback(this, this.handlerFor('a')) }));"), "{call}");
        // A markup value held in a member is an expression: it is read, not set once.
        let held = one("<Card header=\"@frag\" />");
        assert!(held.contains("(): __Props<Card> => ({ header: this.frag }));"), "{held}");
    }

    #[test]
    fn markup_in_a_static_initializer_has_no_owner() {
        let card = [("Card", "@code { onPick?: EventCallback<number>; }")];
        let g = gen_with("@code {\n  static icon = <b/>;\n  static pick = <Card onPick=\"@(() => 1)\" />;\n  own = <i/>;\n}\n<p/>", &card).code;
        assert!(g.contains("static icon = __Component.fragment((__p) => {\n    const _e0 = __t0() as El<\"b\">;\n    __p.appendChild(_e0);\n  }, undefined, __s0);"), "{g}");
        assert!(g.contains("{ onPick: __dom.callback(undefined, () => 1) }") && !g.contains("callback(this"), "{g}");
        // An instance member keeps its owner.
        assert!(g.contains("own = __Component.fragment((__p) => {\n    const _e2 = __t1() as El<\"i\">;\n    __p.appendChild(_e2);\n  }, this, __s2);"), "{g}");
        // Modifiers before `static`, in any order, and markup nested in the initializer's braces or parens.
        let one = |member: &str| gen_with(&format!("@code {{\n  {member}\n}}\n<p/>"), &[]).code;
        for member in [
            "public static a = <b/>;",
            "private static readonly b = <b/>;",
            "readonly static declare c = <b/>;",
            "static override accessor d = <b/>;",
            "static x = { a: <b/> };",
            "public static readonly y = f(<i/>);",
            "static z: { a: number } = [<b/>];",
            "static w = { a: { b: <b/> } }\n  static v = <i/>;",
        ] {
            let g = one(member);
            assert!(g.contains("fragment((__p) => {") && g.contains(", undefined, __s") && !g.contains(", this, __s"), "{member}\n{g}");
        }
        // Instance members keep `this`, also right after a static one without a semicolon.
        for member in ["public a = <b/>;", "private readonly b = { a: <b/> };", "static x = { a: 1 }\n  own = <b/>;", "static f() {}\n  own = <b/>;", "static;\n  own = <b/>;"] {
            let g = one(member);
            assert!(g.contains("}, this, __s"), "{member}\n{g}");
        }
    }

    #[test]
    fn markup_valued_props_literal_markup_is_not_an_attribute_form() {
        let card = [("Card", "@code { header?: RenderFragment; }")];
        let one = |tag: &str| gen_with(&format!("@code {{ pick(t: number) {{ return t ? <i/> : <u/>; }} }}\n{tag}"), &card).code;
        // An expression yielding markup is read on each pass.
        let read = one("<Card header=\"@pick(1)\" />");
        assert!(read.contains("(): __Props<Card> => ({ header: this.pick(1) }));"), "{read}");
    }

    #[test]
    fn event_modifiers_set_bits_or_check_a_condition_when_the_event_fires() {
        let src = "@code { stop = false; rows = [1]; go() {} }\n<a @onclick:preventDefault>a</a>\n<b @onclick:stopPropagation=\"false\" @onclick=\"go\">b</b>\n<i @onclick:stopPropagation=\"stop\">i</i>\n<u @onclick:preventDefault @onclick:stopPropagation=\"true\" @onclick=\"go\">u</u>\n<s @onkeydown:preventDefault=\"stop\" @onkeydown=\"go\">s</s>\n<ul>@for (const r of rows) {<li @onclick:preventDefault @onclick=\"() => go(r)\">@r</li>}</ul>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // A literal modifier with no handler.
        has("__dom.on(_e1, \"click\", undefined, 1);");
        // `=\"false\"` is no modifier at all.
        has("__dom.on(_e2, \"click\", this.go.bind(this));");
        // A dynamic one with no handler checks its condition in a handler of its own.
        has("__dom.on(_e3, \"click\", (__e: any) => { if (this.stop) __e.stopPropagation(); });");
        // Both bits, one of them written `=\"true\"`, with the handler.
        has("__dom.on(_e4, \"click\", this.go.bind(this), 3);");
        // A dynamic one with a handler wraps it and returns its result.
        has("__dom.on(_e5, \"keydown\", (__e: any) => { if (this.stop) __e.preventDefault(); return ((this.go.bind(this)) as (e: any) => unknown)(__e); });");
        // In a row the handler is one of the list's shared reads, and the bits ride on `onItem`.
        has("(r): ((e: any) => unknown) => () => this.go(r),");
        has("__dom.onItem(_e8, \"click\", 0, 1);");
        assert_eq!(g.code.matches(", undefined, 1);").count(), 1, "{}", g.code);
    }

    #[test]
    fn a_child_component_splits_its_arguments() {
        let card = "@code { title = \"\"; count: number = 0; onSave?: EventCallback<number>; onDone?: EventCallback; }\n@slot:header";
        let src = "@code { n = 1; card?: Card; save() {} }\n<Card title=\"t\" count=\"@n\" onSave=\"save\" @ondone=\"save\" @ref=\"card\" @key=\"n\">\n  @slot header { <b>h</b> }\n</Card>\n<Card title=\"u\" />";
        let g = gen_with(src, &[("Card", card)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        // Values are the typed read; callbacks are statics; then the slots, the `@ref` setter and the key.
        has("__dom.component(_e1, Card, (): __Props<Card> => ({ title: \"t\", count: this.n }), { onSave: __dom.callback(this, this.save.bind(this)), onDone: __dom.callback(this, this.save.bind(this)) }, { header: () => __Component.fragment((__p) => {");
        has("}, this, __s0) }, (__c) => { this.card = __c; }, this.n);");
        // Without any of them, only the read.
        has("__dom.component(_e2, Card, (): __Props<Card> => ({ title: \"u\" }));");
        // In a row each part is one of the list's shared reads, typed against the component.
        let rows = "@code { rows = [1]; save() {} }\n<ul>@for (const r of rows) {<Card title=\"@r\" count=\"@r\" @onsave=\"save\" @key=\"r\" />}</ul>";
        let g = gen_with(rows, &[("Card", card)]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("(r): (__Props<Card>) => ({ title: r, count: r }),");
        has("(_): (__Props<Card>) => ({ onSave: __dom.callback(this, this.save.bind(this)) }),");
        has("__dom.componentItem(_e2, Card, 0, 1, undefined, undefined, r);");
    }

    #[test]
    fn slot_definitions_with_arguments_and_fallbacks() {
        let src = "@code { x = 1; i = 2; }\n<div>\n  @slot:item(x, i) { <b>@x</b> }\n  @slot:plain { <i>none</i> }\n  @slot\n</div>";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("declare slots: { item?: (x: this[\"x\"], i: this[\"i\"]) => RenderFragment; plain?: () => RenderFragment; default?: () => RenderFragment };");
        // Arguments are a read of their own; the fallback follows it.
        has("__dom.slotAt(_e1, () => this.slots.item, () => [this.x, this.i], (__p) => {");
        // No arguments: a gap before the fallback. Bare `@slot` is the default slot with neither.
        has("__dom.slotAt(_e2, () => this.slots.plain, undefined, (__p) => {");
        has("__dom.slotAt(_e3, () => this.slots.default);");
    }

    #[test]
    fn cascades_pass_a_read_and_may_be_fixed() {
        let src = "@code { value = 1; }\n@cascade:theme(value) { <b/> }\n@cascade:theme(value, fixed) { <i/> }";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("__dom.cascadeAt(_e1, \"theme\", () => this.value, false, (__p) => {"), "{}", g.code);
        assert!(g.code.contains("__dom.cascadeAt(_e2, \"theme\", () => this.value, true, (__p) => {"), "{}", g.code);
        // Only `fixed` is accepted as the second argument.
        let err = parse("@cascade:theme(value, true) { <b/> }").err().expect("`true` is not accepted");
        assert!(err.message.contains("must be fixed"), "{}", err.message);
    }

    #[test]
    fn routes_sections_take_the_shape_of_their_kind() {
        let src = "@Routes(route) {\n  @admin(page) { <main>@page</main> }\n  @\"/legal/:doc\" { <i>@route.params.doc</i> }\n  @notFound { <p>none</p> }\n  @catch(e) { <p>@e</p> }\n}";
        let g = gen_with(src, &[]);
        let has = |s: &str| assert!(g.code.contains(s), "{s} missing in\n{}", g.code);
        has("__dom.routesAt(_e0, __routes, [\n");
        has("{ kind: \"tag\", tag: \"admin\", render: (_route: Route, page: __Markup) => __Component.fragment((__p) => {");
        has("{ kind: \"pattern\", match: C.__m1, page: false, render: (__route: Route<any, any>) => { const route = __route as __AppRoute<{ doc: string }>; return __Component.fragment((__p) => {");
        has("__dom.textAt(_e4, () => route.params.doc);");
        has("{ kind: \"notFound\", render: () => __Component.fragment((__p) => {");
        has("{ kind: \"catch\", render: (_route: Route, e: unknown) => __Component.fragment((__p) => {");
        has("\n    ]);\n");
        // The section bodies see the route as a local, never as a member.
        assert!(!g.code.contains("this.route") && !g.code.contains("this.page") && !g.code.contains("this.e)"), "{}", g.code);
    }

    #[test]
    fn helpers() {
        assert_eq!(js_string("a\"b\\\n"), r#""a\"b\\\n""#);
        assert_eq!(class_name("my-counter"), "mycounter");
        assert_eq!(class_name("1x"), "_1x");
    }
}
