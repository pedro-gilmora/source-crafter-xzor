//! Component-level language features. Text-based so they keep working while the
//! document is mid-edit and does not parse.

use crate::ast::Node;
use crate::codegen::{class_name, member_decls};
use crate::{is_ident_char, parser};
use std::path::{Component as PathPart, Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Component {
    pub name: String,
    pub path: PathBuf,
    pub props: Vec<Prop>,
    /// Named slots it defines (`@slot:name`), with the byte offset of each name.
    pub slots: Vec<(String, usize)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Prop {
    pub name: String,
    /// The declaration line, e.g. `step: number = 1`.
    pub decl: String,
    /// Byte offset of the name in the component's source.
    pub offset: usize,
}

pub fn component_from_source(path: &Path, text: &str) -> Component {
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = class_name(file.strip_suffix(".tszor").unwrap_or(&file));
    let mut props = Vec::new();
    let mut slots = Vec::new();
    if let Ok((doc, _)) = parser::parse(text) {
        for code in &doc.code {
            for m in member_decls(code).into_iter().filter(|m| !m.is_method && m.name != "constructor") {
                let offset = code.at + m.offset;
                let line_start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
                let line_end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
                let decl = text[line_start..line_end].trim().trim_end_matches(';').to_string();
                props.push(Prop { name: m.name, decl, offset });
            }
        }
        collect_slot_names(&doc.nodes, &mut slots);
    }
    Component { name, path: path.to_path_buf(), props, slots }
}

fn collect_slot_names(nodes: &[Node], out: &mut Vec<(String, usize)>) {
    for node in nodes {
        match node {
            Node::Slot(s) => {
                if let Some(n) = &s.name {
                    out.push((n.to_string(), n.at));
                }
            }
            Node::Element(e) => collect_slot_names(&e.children, out),
            Node::If { branches, otherwise } => {
                for (_, body) in branches {
                    collect_slot_names(body, out);
                }
                if let Some(body) = otherwise {
                    collect_slot_names(body, out);
                }
            }
            Node::For { body, .. } => collect_slot_names(body, out),
            Node::Switch { cases, .. } => cases.iter().for_each(|c| collect_slot_names(&c.body, out)),
            Node::SlotFill(f) => collect_slot_names(&f.body, out),
            Node::Text(_) | Node::Expr(_) => {}
        }
    }
}

/// The component tag whose direct content contains `offset`, found by matching open and close tags.
fn enclosing_component(text: &str, offset: usize) -> Option<String> {
    let b = text.as_bytes();
    let mut stack: Vec<String> = Vec::new();
    let mut i = 0;
    while i < offset {
        if b[i] == b'<' && i + 1 < offset {
            let closing = b[i + 1] == b'/';
            let start = i + 1 + closing as usize;
            let name: String = text[start..offset].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
            if !name.is_empty() && name.starts_with(|c: char| c.is_ascii_alphabetic()) {
                let end = text[start..offset].find('>').map(|e| start + e);
                if closing {
                    if let Some(at) = stack.iter().rposition(|n| *n == name) {
                        stack.truncate(at);
                    }
                } else if let Some(end) = end {
                    let self_closing = b[end - 1] == b'/';
                    let void = matches!(name.to_ascii_lowercase().as_str(), "br" | "hr" | "img" | "input" | "meta" | "link");
                    if !self_closing && !void {
                        stack.push(name);
                    }
                }
                i = end.unwrap_or(offset);
                continue;
            }
        }
        i += 1;
    }
    stack.pop().filter(|n| n.starts_with(|c: char| c.is_ascii_uppercase()))
}

/// `@slot name` inside a component tag: the component and where the name starts.
fn slot_fill_at(text: &str, start: usize) -> Option<String> {
    let before = text[..start].trim_end_matches([' ', '\t']);
    if before.len() == start || !before.ends_with("@slot") {
        return None;
    }
    enclosing_component(text, start)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Context {
    /// After `<`: a tag or component name.
    Tag { prefix: String, start: usize },
    /// An attribute name inside the open tag `tag`.
    Attr { tag: String, prefix: String, start: usize },
    /// After `@` in markup.
    Directive { prefix: String, start: usize },
    /// After `@slot ` inside a component tag: one of its slot names.
    SlotName { component: String, prefix: String, start: usize },
    Other,
}

fn word_start(text: &str, offset: usize) -> usize {
    let b = text.as_bytes();
    let mut s = offset;
    while s > 0 && (is_ident_char(b[s - 1]) || b[s - 1] == b'-') {
        s -= 1;
    }
    s
}

fn word_end(text: &str, offset: usize) -> usize {
    let b = text.as_bytes();
    let mut e = offset;
    while e < b.len() && (is_ident_char(b[e]) || b[e] == b'-') {
        e += 1;
    }
    e
}

/// The open tag containing `offset` (name, start of `<`), if the cursor is inside one outside quotes.
fn open_tag(text: &str, offset: usize) -> Option<(String, usize)> {
    let before = &text[..offset];
    let lt = before.rfind('<')?;
    if before[lt..].contains('>') {
        return None;
    }
    let name: String = before[lt + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ':').collect();
    if name.is_empty() {
        return None;
    }
    let quotes = before[lt..].bytes().filter(|&c| c == b'"').count();
    (quotes % 2 == 0).then_some((name, lt))
}

pub fn context(text: &str, offset: usize) -> Context {
    let start = word_start(text, offset);
    let prefix = text[start..offset].to_string();
    let prev = text[..start].bytes().last();
    if let Some(component) = slot_fill_at(text, start) {
        return Context::SlotName { component, prefix, start };
    }
    if prev == Some(b'<') {
        return Context::Tag { prefix, start };
    }
    if let Some((tag, lt)) = open_tag(text, offset) {
        let tag_name_end = lt + 1 + tag.len();
        if start > tag_name_end {
            let (prefix, start) = if prev == Some(b'@') { (format!("@{prefix}"), start - 1) } else { (prefix, start) };
            let before = text[..start].bytes().last();
            if matches!(before, Some(c) if c.is_ascii_whitespace()) {
                return Context::Attr { tag, prefix, start };
            }
        }
        return Context::Other;
    }
    if prev == Some(b'@') && !text[..start - 1].bytes().last().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return Context::Directive { prefix, start };
    }
    Context::Other
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Symbol {
    Component(String),
    Prop { component: String, name: String },
    Slot { component: String, name: String },
}

/// The component or component prop named at `offset`, if any.
pub fn symbol_at(text: &str, offset: usize) -> Option<(Symbol, usize, usize)> {
    let start = word_start(text, offset);
    let end = word_end(text, offset);
    if start == end {
        return None;
    }
    let word = &text[start..end];
    if let Some(component) = slot_fill_at(text, start) {
        return Some((Symbol::Slot { component, name: word.to_string() }, start, end));
    }
    let is_component = |w: &str| w.starts_with(|c: char| c.is_ascii_uppercase());
    let before = &text[..start];
    if (before.ends_with('<') || before.ends_with("</")) && is_component(word) {
        return Some((Symbol::Component(word.to_string()), start, end));
    }
    let (tag, lt) = open_tag(text, start)?;
    if is_component(&tag) && start > lt + 1 + tag.len() && before.ends_with(|c: char| c.is_ascii_whitespace()) {
        return Some((Symbol::Prop { component: tag, name: word.to_string() }, start, end));
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub label: String,
    /// LSP `CompletionItemKind`.
    pub kind: u32,
    pub detail: String,
    pub insert: String,
    pub snippet: bool,
    /// Byte offset and text of an extra edit (an `@import` line).
    pub extra_edit: Option<(usize, String)>,
}

const KIND_PROPERTY: u32 = 10;
const KIND_CLASS: u32 = 7;
const KIND_KEYWORD: u32 = 14;
const KIND_EVENT: u32 = 23;

const DOM_EVENTS: &[&str] = &[
    "click", "dblclick", "input", "change", "submit", "keydown", "keyup", "focus", "blur", "mouseenter",
    "mouseleave", "mouseover", "mouseout", "mousedown", "mouseup", "pointerdown", "pointerup", "pointermove",
    "wheel", "scroll", "contextmenu", "dragstart", "drop",
];

const DIRECTIVES: &[(&str, &str, &str)] = &[
    ("code", "code {\n\t$0\n}", "Component members"),
    ("if", "if ($1) {\n\t$0\n}", "Conditional markup"),
    ("for", "for (const $1 of $2) {\n\t$0\n}", "Repeated markup"),
    ("switch", "switch ($1) {\n\tcase $2:\n\t\t$0\n}", "Switch on a value"),
    ("page", "page \"$1\"", "Route for this component"),
    ("import", "import $1 from \"$2\"", "Import a module or component"),
    ("typeparam", "typeparam $1", "Generic type parameter of this component"),
];

const BIND_ATTRS: &[(&str, &str)] = &[
    ("@bind", "Two-way binding (value or checked)"),
    ("@bind:event", "Event that updates the binding, e.g. oninput"),
    ("@bind:after", "Handler to run after the bound value changes"),
];

fn matches_prefix(label: &str, prefix: &str) -> bool {
    label.to_lowercase().starts_with(&prefix.to_lowercase())
}

/// Where a new `@import` line goes: after the last leading `@page`/`@import` line.
pub fn import_insert_offset(text: &str) -> usize {
    let mut at = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("@page") || t.starts_with("@import") {
            at = offset + line.len();
        }
        offset += line.len();
    }
    at
}

/// `./rel/path` from `from_dir` to `to`, with forward slashes.
pub fn relative_import(from_dir: &Path, to: &Path) -> String {
    let norm = |p: &Path| -> Vec<String> {
        p.components()
            .filter(|c| !matches!(c, PathPart::CurDir))
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let (from, target) = (norm(from_dir), norm(to));
    let common = from.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let originals: Vec<String> = to.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let skip = originals.len() - (target.len() - common);
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(originals[skip..].iter().cloned());
    let joined = parts.join("/");
    if joined.starts_with("..") { joined } else { format!("./{joined}") }
}

pub fn completions(text: &str, offset: usize, doc_path: &Path, components: &[Component]) -> Vec<Completion> {
    match context(text, offset) {
        Context::SlotName { component, prefix, .. } => components
            .iter()
            .filter(|c| c.name == component)
            .flat_map(|c| c.slots.iter())
            .filter(|(n, _)| matches_prefix(n, &prefix))
            .map(|(n, _)| Completion {
                label: n.clone(),
                kind: KIND_PROPERTY,
                detail: format!("slot of {component}"),
                insert: n.clone(),
                snippet: false,
                extra_edit: None,
            })
            .collect(),
        Context::Tag { prefix, .. } => components
            .iter()
            .filter(|c| matches_prefix(&c.name, &prefix))
            .map(|c| {
                let imported = text.lines().any(|l| {
                    let l = l.trim_start();
                    l.starts_with("@import") && l.split_whitespace().nth(1) == Some(c.name.as_str())
                });
                let is_self = doc_path.file_name() == c.path.file_name() && doc_path.parent() == c.path.parent();
                let dir = doc_path.parent().unwrap_or(Path::new("."));
                let import = format!("@import {} from \"{}\"\n", c.name, relative_import(dir, &c.path));
                Completion {
                    label: c.name.clone(),
                    kind: KIND_CLASS,
                    detail: format!("component {}", c.path.file_name().unwrap_or_default().to_string_lossy()),
                    insert: c.name.clone(),
                    snippet: false,
                    extra_edit: (!imported && !is_self).then(|| (import_insert_offset(text), import)),
                }
            })
            .collect(),
        Context::Attr { tag, prefix, .. } => {
            if let Some(c) = components.iter().find(|c| c.name == tag) {
                return c
                    .props
                    .iter()
                    .filter(|p| matches_prefix(&p.name, &prefix))
                    .map(|p| Completion {
                        label: p.name.clone(),
                        kind: KIND_PROPERTY,
                        detail: p.decl.clone(),
                        insert: format!("{}=\"$1\"", p.name),
                        snippet: true,
                        extra_edit: None,
                    })
                    .collect();
            }
            DOM_EVENTS
                .iter()
                .map(|e| (format!("@on{e}"), "DOM event handler"))
                .chain(BIND_ATTRS.iter().map(|(a, d)| (a.to_string(), *d)))
                .filter(|(label, _)| prefix.starts_with('@') && matches_prefix(label, &prefix))
                .map(|(label, detail)| Completion {
                    insert: format!("{label}=\"$1\""),
                    label,
                    kind: KIND_EVENT,
                    detail: detail.into(),
                    snippet: true,
                    extra_edit: None,
                })
                .collect()
        }
        Context::Directive { prefix, .. } => DIRECTIVES
            .iter()
            .filter(|(k, _, _)| matches_prefix(k, &prefix))
            .map(|(k, snippet, detail)| Completion {
                label: (*k).into(),
                kind: KIND_KEYWORD,
                detail: (*detail).into(),
                insert: (*snippet).into(),
                snippet: true,
                extra_edit: None,
            })
            .collect(),
        Context::Other => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counter() -> Component {
        let src = "@code {\n  label: string = \"Count\";\n  step = 1;\n  increment() {}\n}\n<p>@label</p>";
        component_from_source(Path::new("/app/Counter.tszor"), src)
    }

    #[test]
    fn component_props_from_code_block() {
        let c = counter();
        assert_eq!(c.name, "Counter");
        let names: Vec<_> = c.props.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["label", "step"]);
        assert_eq!(c.props[0].decl, "label: string = \"Count\"");
        assert_eq!(c.props[1].offset, "@code {\n  label: string = \"Count\";\n  ".len());
    }

    #[test]
    fn slot_names_inside_component_tags() {
        let card = component_from_source(Path::new("/app/Card.tszor"), "<section>@slot:header @slot:footer(1) @slot</section>");
        assert_eq!(card.slots.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["header", "footer"]);

        let doc = "<Card title=\"x\">\n  <p/>\n  @slot he";
        let items = completions(doc, doc.len(), Path::new("/app/A.tszor"), &[card.clone()]);
        assert_eq!(items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["header"]);

        let doc = "<Card>\n  <div>@slot he";
        assert_eq!(context(doc, doc.len()), Context::Other);

        let doc = "<Card>@slot footer { x }</Card>";
        assert_eq!(symbol_at(doc, 14).map(|s| s.0), Some(Symbol::Slot { component: "Card".into(), name: "footer".into() }));
    }

    #[test]
    fn contexts() {
        let t = "<main>\n  <Cou";
        assert_eq!(context(t, t.len()), Context::Tag { prefix: "Cou".into(), start: t.len() - 3 });
        let t = "<Counter label=\"x\" st";
        assert_eq!(context(t, t.len()), Context::Attr { tag: "Counter".into(), prefix: "st".into(), start: t.len() - 2 });
        let t = "<button @onc";
        assert_eq!(context(t, t.len()), Context::Attr { tag: "button".into(), prefix: "@onc".into(), start: t.len() - 4 });
        let t = "<p title=\"a b";
        assert_eq!(context(t, t.len()), Context::Other);
        let t = "<p>x</p>\n@sw";
        assert_eq!(context(t, t.len()), Context::Directive { prefix: "sw".into(), start: t.len() - 2 });
        let t = "mail a@b";
        assert_eq!(context(t, t.len()), Context::Other);
    }

    #[test]
    fn component_completion_adds_import() {
        let doc = "@page \"/\"\n<main>\n  <Co";
        let items = completions(doc, doc.len(), Path::new("/app/pages/Home.tszor"), &[counter()]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "Counter");
        assert_eq!(items[0].extra_edit, Some(("@page \"/\"\n".len(), "@import Counter from \"../Counter.tszor\"\n".into())));

        let doc = "@import Counter from \"./Counter.tszor\"\n<Co";
        let items = completions(doc, doc.len(), Path::new("/app/Home.tszor"), &[counter()]);
        assert_eq!(items[0].extra_edit, None);
    }

    #[test]
    fn prop_event_and_directive_completion() {
        let doc = "<Counter s";
        let items = completions(doc, doc.len(), Path::new("/app/A.tszor"), &[counter()]);
        assert_eq!(items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["step"]);
        assert_eq!(items[0].insert, "step=\"$1\"");

        let doc = "<button @onc";
        let items = completions(doc, doc.len(), Path::new("/app/A.tszor"), &[]);
        assert_eq!(items[0].label, "@onclick");

        let doc = "<input @bi";
        let labels: Vec<_> = completions(doc, doc.len(), Path::new("/app/A.tszor"), &[]).into_iter().map(|i| i.label).collect();
        assert_eq!(labels, ["@bind", "@bind:event", "@bind:after"]);

        let doc = "\n@i";
        let labels: Vec<_> = completions(doc, doc.len(), Path::new("/app/A.tszor"), &[]).into_iter().map(|i| i.label).collect();
        assert_eq!(labels, ["if", "import"]);
    }

    #[test]
    fn symbols() {
        let t = "<main><Counter step=\"@(2)\" /></Counter>";
        assert_eq!(symbol_at(t, 9).map(|s| s.0), Some(Symbol::Component("Counter".into())));
        assert_eq!(symbol_at(t, 16).map(|s| s.0), Some(Symbol::Prop { component: "Counter".into(), name: "step".into() }));
        assert_eq!(symbol_at(t, t.len() - 3).map(|s| s.0), Some(Symbol::Component("Counter".into())));
        assert_eq!(symbol_at(t, 2), None);
    }

    #[test]
    fn relative_imports() {
        assert_eq!(relative_import(Path::new("/a/b"), Path::new("/a/b/C.tszor")), "./C.tszor");
        assert_eq!(relative_import(Path::new("/a/b"), Path::new("/a/c/D.tszor")), "../c/D.tszor");
    }
}
