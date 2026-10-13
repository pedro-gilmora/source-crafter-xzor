//! Lowers a parsed `.tszor` document into a TypeScript component class, the
//! way Razor lowers `.razor` into a C# class with `BuildRenderTree`.

use crate::ast::*;
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
    /// `@inject` types and names, with their offsets in the `.tszor`.
    pub injects: Vec<Inject>,
    /// Files probed while resolving the `@inherits` chain, found or not; a change to one invalidates this output.
    pub deps: Vec<std::path::PathBuf>,
    /// Problems that don't stop the build.
    pub warnings: Vec<crate::Diagnostic>,
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
        let maps = if text.is_empty() { Vec::new() } else { vec![Mapping { src: at, out: 0, len: text.len() }] };
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
    generate_with(doc, class_name, source_name, &HashMap::new(), &HashSet::new())
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
}

/// `components` describes the `.tszor` components this document uses, by name; `inherited` names
/// the base class's instance members.
pub fn generate_with(
    doc: &Document,
    class_name: &str,
    source_name: &str,
    components: &HashMap<String, ComponentInfo>,
    inherited: &HashSet<String>,
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
    for (code, decls) in doc.code.iter().zip(&decls) {
        cascade_members(code, decls, &mut cascades, &mut blanks).map_err(|(message, _)| message)?;
        for m in decls {
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
        props_ids: std::cell::Cell::new(0),
    };

    g.line(&format!("// Generated by zor from {source_name}. Do not edit."));
    let slots = slot_declarations(doc, &g.members, &g.statics, class_name)?;
    g.line(if slots.is_empty() {
        "import { ComponentBase, type RenderTreeBuilder } from \"@zor/runtime\";"
    } else {
        "import { ComponentBase, type RenderTreeBuilder, type RenderFragment } from \"@zor/runtime\";"
    });
    for import in &doc.imports {
        g.emit(M::lit("import ").add(M::src(import, import.at)).lit_then(";"));
    }
    g.line("");
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
        None => M::lit("ComponentBase"),
    };
    let mut header = M::lit(&format!("export default class {class_name}")).add(generics).lit_then(" extends ").add(base);
    for (i, interface) in doc.implements.iter().enumerate() {
        header = header.lit_then(if i == 0 { " implements " } else { ", " }).add(M::src(interface, interface.at));
    }
    g.emit(header.lit_then(" {"));
    g.depth = 1;
    if let Some(route) = &doc.page {
        g.line(&format!("static readonly route = {};", js_string(route)));
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
    g.nodes(&doc.nodes)?;
    g.depth = 1;
    g.line("}");
    g.depth = 0;
    g.line("}");
    let injects = doc.injects.clone();
    Ok(Generated { code: g.out, mappings: g.mappings, injects, deps: Vec::new(), warnings: Vec::new() })
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
            props_ids: std::cell::Cell::new(self.props_ids.get()),
        };
        let done = sub.nodes(nodes);
        self.props_ids.set(sub.props_ids.get());
        done?;
        Ok(M { text: sub.out.trim_end().to_string(), maps: sub.mappings })
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
            if end > start {
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
            AttrValue::Static(s) => M::lit(&js_string(s)),
            AttrValue::Expr(e) => self.expr(e),
            AttrValue::Interp(parts) => {
                let mut out = M::default();
                for (i, p) in parts.iter().enumerate() {
                    if i > 0 {
                        out = out.lit_then(" + ");
                    }
                    out = match p {
                        Part::Text(t) => out.lit_then(&js_string(t)),
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
            Node::Text(t) => self.line(&format!("__b.addText({});", js_string(t))),
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
            Node::While { cond, body } => {
                let line = M::lit("while (").add(self.expr(cond)).lit_then(") {");
                self.emit(line);
                self.block(body)?;
                self.line("}");
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
                self.block(body)?;
                self.line("__b.closeRegion();");
            }
            Node::Element(el) if el.is_component() => self.component(el)?,
            Node::Element(el) => {
                self.line(&format!("__b.openElement({});", js_string(&el.name)));
                let directive = |n: &str| el.attrs.iter().find(|a| &*a.name.text == n).map(|a| &a.value);
                for a in &el.attrs {
                    match &*a.name.text {
                        "@bind" => self.bind_element(el, a, directive("@bind:event"), directive("@bind:after"))?,
                        "@bind:event" | "@bind:after" => {}
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
                self.nodes(&el.children)?;
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
            Node::For { head, body } => {
                let scope = self.locals.len();
                self.locals.extend(loop_locals(head));
                let line = M::lit("for (").add(self.expr(head)).lit_then(") {");
                self.emit(line);
                self.block(body)?;
                self.line("}");
                self.locals.truncate(scope);
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

    /// `this.m.bind(this)` for a bare member name, else the rewritten expression.
    fn handler(&self, e: &Src) -> M {
        if let Some(prefix) = self.member_prefix(e).filter(|_| is_identifier(e)) {
            M::lit(prefix).add(M::src(e, e.at)).lit_then(&format!(".bind({})", prefix.trim_end_matches('.')))
        } else {
            self.expr(e)
        }
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
    fn bind_element(&mut self, el: &Element, a: &Attr, event: Option<&AttrValue>, after: Option<&AttrValue>) -> Result<(), String> {
        let AttrValue::Expr(target) = &a.value else { return Err("@bind requires an expression".into()) };
        let is_check = el.attrs.iter().any(|x| {
            &*x.name.text == "type" && matches!(&x.value, AttrValue::Static(s) if matches!(&*s.text, "checkbox" | "radio"))
        });
        let event = match event {
            Some(AttrValue::Expr(e)) => e.trim_start_matches("on").to_string(),
            Some(_) => return Err("@bind:event requires an event name".into()),
            None => "change".into(),
        };
        let prop = if is_check { "checked" } else { "value" };
        self.emit(M::lit(&format!("__b.addAttribute(\"{prop}\", ")).add(self.expr(target)).lit_then(");"));
        let line = M::lit(&format!("__b.addEventHandler({}, (__e) => {{ ", js_string(&event)))
            .add(self.expr(target))
            .lit_then(" = ComponentBase.bindValue(__e, ")
            .add(self.expr(target))
            .lit_then(");")
            .add(self.after_call(after)?)
            .lit_then(" });");
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
        let mut name = M::src(&el.name, el.name.at);
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
            if a.name.starts_with('@') {
                return Err(format!("<{}>: directive attribute {} is not supported on components", el.name, a.name));
            }
            let key = if is_identifier(&a.name) { M::src(&a.name, a.name.at) } else { M::lit(&js_string(&a.name)) };
            let kind = info.props.get(&*a.name.text).copied().unwrap_or(PropKind::Text);
            let code = match &a.value {
                AttrValue::Static(s) if s.trim().is_empty() => None,
                AttrValue::Static(s) if s.at != Src::UNMAPPED => Some(s.clone()),
                AttrValue::Expr(e) => Some(e.clone()),
                _ => None,
            };
            let value = match (kind, code) {
                (PropKind::Callback, Some(e)) => M::lit("__b.callback(").add(self.handler(&e)).lit_then(")"),
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
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if is_ident_start(c) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            let word = &src[start..i];
            let next = b[i..].iter().copied().find(|c| !c.is_ascii_whitespace());
            let is_property = prev == Some(b'.');
            let is_object_key = next == Some(b':') && matches!(prev, Some(b'{' | b','));
            if let Some(p) = prefix(word).filter(|_| !is_property && !is_object_key) {
                inserts.push((base + start, p.len()));
                out.push_str(p);
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
            Node::For { head, body } => {
                let scope = loops.len();
                if let Some(var) = loop_var_type(head, members, loops) {
                    loops.push(var);
                }
                collect_slots(body, members, loops, out)?;
                loops.truncate(scope);
            }
            Node::Switch { cases, .. } => {
                for case in cases {
                    collect_slots(&case.body, members, loops, out)?;
                }
            }
            Node::SlotFill(fill) => collect_slots(&fill.body, members, loops, out)?,
            Node::Cascade { body, .. } => collect_slots(body, members, loops, out)?,
            Node::While { body, .. } => collect_slots(body, members, loops, out)?,
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
            Node::Text(_) | Node::Expr(_) => {}
        }
    }
    Ok(())
}

/// Type of a loop variable, when zor can name it: `const x of <path>`, `const k in ...`, `let i = 0`.
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
    for code in &doc.code {
        for m in member_decls(code).into_iter().filter(|m| !m.is_method) {
            let rest = &code[m.offset..];
            let end = rest.find(['\n', ';']).unwrap_or(rest.len());
            props.insert(m.name, prop_kind(&rest[..end]));
        }
    }
    ComponentInfo { type_params, props }
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

/// Whether a declaration like `step: number = 1` or `title = "x"` has a non-string type.
pub fn takes_expression(decl: &str) -> bool {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let rest = rest.trim_start_matches(['?', '!']).trim_start();
    let is_stringy = |s: &str| s.starts_with(['"', '\'', '`']);
    if let Some(ty) = rest.strip_prefix(':') {
        let b = ty.as_bytes();
        let eq = (0..b.len()).find(|&i| {
            b[i] == b'=' && b.get(i + 1) != Some(&b'>') && !matches!(i.checked_sub(1).map(|j| b[j]), Some(b'=' | b'!' | b'<' | b'>'))
        });
        let ty = ty[..eq.unwrap_or(ty.len())].trim();
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
            _ if depth == 0 && at_decl && is_ident_start(c) => {
                let start = i;
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
    fn own_statics_go_through_the_class() {
        let src = "@code { static s = 2; n = 1; static go() {} }\n<p title=\"@s\">@s @n @(`${s}`)</p>\n<button @onclick=\"go\" @onfocus=\"() => s++\">x</button>";
        let (doc, _) = crate::parser::parse(src).unwrap();
        let g = generate(&doc, "C", "C.tszor").unwrap();
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
        let (doc, _) = crate::parser::parse(
            "@code { mode = 1; }\n@switch (mode) { case 1: case 2: <b>low</b> default: @mode }",
        )
        .unwrap();
        let ts = generate(&doc, "S", "S.tszor").unwrap().code;
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
        let (doc, _) = crate::parser::parse("@if (a) {<b/>}\n@for (const x of xs) {@x}").unwrap();
        let ts = generate(&doc, "R", "R.tszor").unwrap().code;
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
        let mut sources: Vec<String> = ["App.tszor", "Counter.tszor"]
            .iter()
            .map(|f| std::fs::read_to_string(dir.join(f)).unwrap())
            .collect();
        sources.push(extra.into());
        for src in &sources {
            let (doc, _) = crate::parser::parse(src).unwrap();
            let g = generate(&doc, "C", "C.tszor").unwrap();
            assert!(g.mappings.len() > 3);
            for m in &g.mappings {
                assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}\n{}", g.code);
            }
        }
        let (doc, _) = crate::parser::parse("@code { count = 1; }\n<b>@count</b>").unwrap();
        let g = generate(&doc, "C", "C.tszor").unwrap();
        let at = "@code { count = 1; }\n<b>@".len();
        let m = g.mappings.iter().find(|m| m.src == at).expect("maps @count");
        assert_eq!(&g.code[m.out - 5..m.out + m.len], "this.count");
    }

    #[test]
    fn markup_in_code_becomes_fragments() {
        let src = "@code {\n  state = 1;\n  cached = <B />;\n  pick(t: number) {\n    return t ? <A state=\"@this.state\" n=\"@t\" /> : this.cached;\n  }\n}\n<p>@pick(1)</p>";
        let (doc, _) = crate::parser::parse(src).unwrap();
        let g = generate(&doc, "C", "C.tszor").unwrap();
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

    fn gen_with(src: &str, components: &[(&str, &str)]) -> Generated {
        let (doc, _) = crate::parser::parse(src).unwrap();
        let infos = components.iter().map(|(n, s)| (n.to_string(), component_info(s))).collect();
        let g = generate_with(&doc, "C", "C.tszor", &infos, &HashSet::new()).unwrap();
        for m in &g.mappings {
            assert_eq!(&g.code[m.out..m.out + m.len], &src[m.src..m.src + m.len], "{m:?}\n{}", g.code);
        }
        g
    }

    #[test]
    fn slot_definitions_declare_typed_slots_and_render_with_fallbacks() {
        let src = "@typeparam T\n@code { title = \"\"; items: T[] = []; n = 1; }\n<section>\n  @slot:header { <h3>@title</h3> }\n  @for (const x of items) {\n    @slot:item(x, n, \"s\", this.title.length, <b/>)\n  }\n  @slot:extra((n + 1) as number)\n  @slot\n</section>";
        let g = gen_with(src, &[]);
        assert!(g.code.contains("import { ComponentBase, type RenderTreeBuilder, type RenderFragment } from \"@zor/runtime\";"), "{}", g.code);
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
        let (doc, _) = crate::parser::parse(src).unwrap();
        let err = generate(&doc, "C", "C.tszor").unwrap_err();
        assert_eq!(err, ZDI08);
        assert_eq!(inject_constructor(&doc), src.find("constructor"));
    }

    #[test]
    fn slot_errors() {
        let err = |src: &str| generate(&crate::parser::parse(src).unwrap().0, "C", "C.tszor").unwrap_err();
        assert!(err("@slot:a\n@slot:a").contains("slot `a` is defined twice"));
        assert!(err("@slot\n@slot").contains("slot `default` is defined twice"));
        assert!(err("@slot:a(foo())").contains("write `(foo()) as Type`"));
        let err = |src: &str| gen_err(src, &[("Card", "<p/>")]);
        assert!(err("<Card>@slot a { x } @slot a { y }</Card>").contains("slot `a` is filled twice"));
        assert!(err("<Card><p/> @slot { y }</Card>").contains("slot `default` is filled twice"));
    }

    fn gen_err(src: &str, components: &[(&str, &str)]) -> String {
        let (doc, _) = crate::parser::parse(src).unwrap();
        let infos = components.iter().map(|(n, s)| (n.to_string(), component_info(s))).collect();
        generate_with(&doc, "C", "C.tszor", &infos, &HashSet::new()).unwrap_err()
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
    fn typeparam_makes_a_generic_class() {
        let (doc, _) = crate::parser::parse("@typeparam T extends object\n@typeparam U\n<p/>").unwrap();
        let g = generate(&doc, "Grid", "Grid.tszor").unwrap();
        assert!(g.code.contains("export default class Grid<T extends object, U> extends ComponentBase {"), "{}", g.code);
    }

    #[test]
    fn source_map_points_back_to_the_tszor() {
        let src = "@code {\n  n = 1;\n}\n<p>@n</p>";
        let (doc, _) = crate::parser::parse(src).unwrap();
        let g = generate(&doc, "C", "C.tszor").unwrap();
        let map = crate::json::Json::parse(&g.source_map(src, "C.tszor")).unwrap();
        assert_eq!(map["version"].as_usize(), Some(3));
        assert_eq!(map["sources"][0].as_str(), Some("C.tszor"));
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
        has("    __b.openCascade(\"theme\", this.theme);\n      __b.openElement(\"b\");\n      __b.closeElement();\n    __b.closeRegion();");
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
            let (doc, _) = crate::parser::parse(&src).unwrap();
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
        let (doc, _) = crate::parser::parse("@code { @Cascade('route') r?: unknown; }\n<p/>").unwrap();
        assert_eq!(cascade_error(&doc), None);
        assert!(generate(&doc, "C", "C.tszor").unwrap().code.contains("[[\"r\", \"route\"]]"));
    }

    #[test]
    fn helpers() {
        assert_eq!(js_string("a\"b\\\n"), r#""a\"b\\\n""#);
        assert_eq!(class_name("my-counter"), "mycounter");
        assert_eq!(class_name("1x"), "_1x");
    }
}
