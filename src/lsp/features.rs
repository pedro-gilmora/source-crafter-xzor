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
    /// Route tags of its `@page ... as tag` lines.
    pub tags: Vec<String>,
    /// The specifier to import it by, for a component of a package (`@kit/Button.xzor`); `None`
    /// imports it by relative path.
    pub import: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Prop {
    pub name: String,
    /// The declaration line, e.g. `step: number = 1`.
    pub decl: String,
    /// Byte offset of the name in the component's source.
    pub offset: usize,
    /// Its `/** ... */` comment, without the markers.
    pub doc: String,
    /// The declared type, e.g. `Tone` in `tone?: Tone = "neutral"`.
    pub ty: Option<String>,
    /// The string values the type admits (filled in by the caller, which can read imported modules).
    pub values: Vec<String>,
}

pub fn component_from_source(path: &Path, text: &str) -> Component {
    let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = class_name(file.strip_suffix(".xzor").unwrap_or(&file));
    let mut props = Vec::new();
    let mut slots = Vec::new();
    let mut tags = Vec::new();
    if let Ok((doc, _)) = parser::parse(text) {
        tags.extend(doc.pages.iter().filter_map(|p| p.tag.as_ref().map(|t| t.to_string())));
        for code in &doc.code {
            for m in member_decls(code).into_iter().filter(|m| !m.is_method && m.name != "constructor") {
                let offset = code.at + m.offset;
                let line_start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
                let line_end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
                let decl = text[line_start..line_end].trim().trim_end_matches(';').to_string();
                let ty = decl_type(&decl, &m.name);
                let values = ty.as_deref().map(literals).unwrap_or_default();
                props.push(Prop { doc: doc_comment(&text[..line_start]), ty, values, name: m.name, decl, offset });
            }
        }
        collect_slot_names(&doc.nodes, &mut slots);
    }
    Component { name, path: path.to_path_buf(), props, slots, tags, import: None }
}

/// The type of `name` in a field declaration: `tone?: Tone = "x"` gives `Tone`.
fn decl_type(decl: &str, name: &str) -> Option<String> {
    let rest = decl.split_once(name)?.1.trim_start().trim_start_matches(['?', '!']).trim_start();
    let rest = rest.strip_prefix(':')?;
    let mut depth = 0i32;
    let mut end = rest.len();
    for (i, c) in rest.char_indices() {
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => depth -= 1,
            '=' if depth == 0 && !rest[i..].starts_with("=>") => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    Some(rest[..end].trim().to_string()).filter(|t| !t.is_empty())
}

/// The string literals of an inline union (`"a" | "b"`); empty for anything else.
fn literals(ty: &str) -> Vec<String> {
    let parts: Vec<&str> = ty.split('|').map(str::trim).filter(|t| !t.is_empty()).collect();
    let quoted = |t: &str| t.len() >= 2 && (t.starts_with('"') && t.ends_with('"') || t.starts_with('\'') && t.ends_with('\''));
    if parts.iter().all(|t| quoted(t)) { parts.iter().map(|t| t[1..t.len() - 1].to_string()).collect() } else { Vec::new() }
}

/// The `/** ... */` comment that ends right before `before` (the text up to a declaration line).
fn doc_comment(before: &str) -> String {
    let trimmed = before.trim_end();
    if !trimmed.ends_with("*/") {
        return String::new();
    }
    let Some(open) = trimmed.rfind("/**") else { return String::new() };
    trimmed[open + 3..trimmed.len() - 2]
        .lines()
        .map(|l| l.trim().trim_start_matches('*').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The tag name span of the element an `@attr:name` at `offset` sets.
pub fn attr_owner(text: &str, offset: usize) -> Option<(usize, usize)> {
    fn walk<'a>(nodes: &'a [Node], owner: Option<&'a crate::ast::Src>, off: usize) -> Option<&'a crate::ast::Src> {
        let in_body = |b: &'a Vec<Node>| walk(b, owner, off);
        nodes.iter().find_map(|n| match n {
            Node::ParentAttr(a) if (a.name.at.saturating_sub("@attr:".len())..=a.name.at + a.name.len()).contains(&off) => owner,
            Node::Element(el) if &*el.name.text == "text" => walk(&el.children, owner, off),
            Node::Element(el) => walk(&el.children, Some(&el.name), off),
            Node::If { branches, otherwise } => branches.iter().map(|(_, b)| b).chain(otherwise).find_map(in_body),
            Node::For { body, otherwise, .. } | Node::While { body, otherwise, .. } => in_body(body).or_else(|| otherwise.as_ref().and_then(in_body)),
            Node::Switch { cases, .. } => cases.iter().find_map(|c| in_body(&c.body)),
            Node::Cascade { body, .. } => in_body(body),
            Node::Show(inner) => walk(std::slice::from_ref(&**inner), owner, off),
            Node::Pause(Some(body)) | Node::Once(body) => in_body(body),
            Node::Slot(s) => s.fallback.as_ref().and_then(in_body),
            Node::Routes { sections, .. } => sections.iter().find_map(|s| in_body(&s.body)),
            Node::Code(parts) => parts.iter().find_map(|p| match p {
                crate::ast::CodePart::Render(nodes) => walk(nodes, owner, off),
                crate::ast::CodePart::Markup(el) => walk(&el.children, Some(&el.name), off),
                crate::ast::CodePart::Ts(_) => None,
            }),
            _ => None,
        })
    }
    let (doc, _) = parser::parse(text).ok()?;
    walk(&doc.nodes, None, offset).map(|name| (name.at, name.at + name.len()))
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
            Node::For { body, otherwise, .. } | Node::While { body, otherwise, .. } => {
                collect_slot_names(body, out);
                if let Some(body) = otherwise {
                    collect_slot_names(body, out);
                }
            }
            Node::Code(parts) => {
                for part in parts {
                    match part {
                        crate::ast::CodePart::Render(nodes) => collect_slot_names(nodes, out),
                        crate::ast::CodePart::Markup(el) => collect_slot_names(&el.children, out),
                        crate::ast::CodePart::Ts(_) => {}
                    }
                }
            }
            Node::Switch { cases, .. } => cases.iter().for_each(|c| collect_slot_names(&c.body, out)),
            Node::SlotFill(f) => collect_slot_names(&f.body, out),
            Node::Cascade { body, .. } => collect_slot_names(body, out),
            Node::Once(body) => collect_slot_names(body, out),
            Node::Show(inner) => collect_slot_names(std::slice::from_ref(&**inner), out),
            Node::Pause(body) => collect_slot_names(body.as_deref().unwrap_or_default(), out),
            Node::Await { pending, then, catch, .. } => {
                collect_slot_names(pending, out);
                then.iter().chain(catch).for_each(|(_, b)| collect_slot_names(b, out));
            }
            Node::Routes { sections, .. } => sections.iter().for_each(|s| collect_slot_names(&s.body, out)),
            Node::Text(_) | Node::Expr(_) | Node::ParentAttr(_) => {}
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
    /// After `@` directly inside a routes block: a section keyword or route tag.
    Route { prefix: String, start: usize },
    /// Inside the quotes of attribute `attr` on `tag`, before any `@`: a static value.
    AttrValue { tag: String, attr: String, prefix: String, start: usize },
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
    if let Some(ctx) = attr_value(text, offset) {
        return ctx;
    }
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
        if directly_in_routes_block(&text[..start - 1]) {
            return Context::Route { prefix, start };
        }
        return Context::Directive { prefix, start };
    }
    Context::Other
}

/// Inside a quoted attribute value of an open tag; the prefix is the current word for `class`, the
/// whole value otherwise. `None` once the value holds an `@` expression (TypeScript completes those).
fn attr_value(text: &str, offset: usize) -> Option<Context> {
    let before = &text[..offset];
    let lt = before.rfind('<')?;
    if before[lt..].contains('>') || before[lt..].bytes().filter(|&c| c == b'"').count() % 2 == 0 {
        return None;
    }
    let tag: String = before[lt + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let quote = before.rfind('"')?;
    let value = &before[quote + 1..];
    let name_end = before[..quote].trim_end().strip_suffix('=')?.trim_end();
    let attr: String = name_end.chars().rev().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '@')).collect::<Vec<_>>().into_iter().rev().collect();
    if tag.is_empty() || attr.is_empty() || attr.starts_with('@') || value.contains('@') {
        return None;
    }
    let word = if attr == "class" { value.rfind(char::is_whitespace).map_or(0, |i| i + 1) } else { 0 };
    Some(Context::AttrValue { tag, attr, prefix: value[word..].to_string(), start: quote + 1 + word })
}

/// Values of native attributes the kit leans on (invokers, dialogs).
const NATIVE_VALUES: &[(&str, &[&str])] = &[
    ("command", &["show-modal", "close", "request-close", "toggle-popover", "show-popover", "hide-popover"]),
    ("popovertargetaction", &["toggle", "show", "hide"]),
    ("closedby", &["any", "closerequest", "none"]),
    ("popover", &["auto", "manual", "hint"]),
    ("role", &["switch", "status", "tablist", "tab", "radiogroup", "dialog", "img", "list", "listitem"]),
];

/// Attributes and props whose value is the `id` of another element on the page.
fn takes_id(attr: &str, doc: &str) -> bool {
    matches!(attr, "commandfor" | "popovertarget" | "for" | "aria-controls" | "aria-labelledby" | "aria-describedby") || doc.starts_with("Id of")
}

/// The `id="..."` values written in `text`.
fn ids(text: &str) -> Vec<String> {
    let mut out: Vec<String> = text
        .match_indices(" id=\"")
        .filter_map(|(at, m)| {
            let rest = &text[at + m.len()..];
            let id = &rest[..rest.find('"')?];
            (!id.is_empty() && !id.contains('@')).then(|| id.to_string())
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Class names a style sheet declares: `.name` not preceded by a word character (skips `x.woff2`, `0.5`).
pub fn css_classes(css: &str) -> Vec<String> {
    let b = css.as_bytes();
    css.match_indices('.')
        .filter(|(at, _)| *at == 0 || !(b[at - 1].is_ascii_alphanumeric() || matches!(b[at - 1], b'-' | b'_' | b'/')))
        .filter_map(|(at, _)| {
            let name: String = css[at + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).collect();
            name.starts_with(|c: char| c.is_ascii_alphabetic()).then_some(name)
        })
        .collect()
}

/// Whether `before` ends directly inside the braces of an open `@Routes(..) {` block.
fn directly_in_routes_block(before: &str) -> bool {
    let Some(at) = before.rfind("@Routes") else { return false };
    let mut depth = 0i32;
    let mut opened = false;
    for c in before[at..].chars() {
        match c {
            '{' => {
                depth += 1;
                opened = true;
            }
            '}' => depth -= 1,
            _ => {}
        }
    }
    opened && depth == 1
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
const KIND_VALUE: u32 = 12;
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
    ("module", "module {\n\t$0\n}", "Module code outside the class: constants, types, helpers, exports"),
    ("if", "if ($1) {\n\t$0\n}", "Conditional markup"),
    ("for", "for (const $1 of $2) {\n\t$0\n}", "Repeated markup"),
    ("switch", "switch ($1) {\n\tcase $2:\n\t\t$0\n}", "Switch on a value"),
    ("page", "page \"$1\"", "Route for this component"),
    ("import", "import $1 from \"$2\"", "Import a module or component"),
    ("typeparam", "typeparam $1", "Generic type parameter of this component"),
    ("while", "while ($1) {\n\t$0\n}", "Repeated markup while a condition holds"),
    ("inherits", "inherits $1", "Base class instead of ComponentBase"),
    ("fine", "fine", "No render pass: the DOM is built once and bindings keep it current (every component is; the line changes nothing)"),
    ("async", "async", "Load this component on first use: a chunk of its own in a --minify build"),
    ("cached", "cached", "Keep the instance and its DOM when it leaves the tree, for when it comes back"),
    ("implements", "implements $1", "Interfaces this component implements"),
    ("inject", "inject $1 $2", "Inject a service from the application"),
    ("attribute", "attribute $1", "Decorator on the component class"),
    ("slot", "slot", "Where slot content renders"),
    ("cascade", "cascade:$1($2) {\n\t$0\n}", "Cascading value for the components inside"),
    ("once", "once { $0 }", "Read once, nothing bound: @once(expr) or @once { markup }"),
    ("await", "await ($1) {\n\t$2\n} then (${3:value}) {\n\t$0\n} catch (${4:error}) {\n}", "Pending markup, then the value, or the error"),
    ("attr", "attr:$1=\"$2\"", "An attribute of the enclosing element while this branch shows"),
    ("key", "key($1)", "After a @for/@while head: what keeps each pass's DOM"),
    ("else", "else {\n\t$0\n}", "After @if, @for or @while: rendered when no branch or pass ran"),
    ("show:if", "show:if ($1) {\n\t$0\n}", "Like @if, but a branch it leaves is hidden and kept, not removed"),
    ("show:switch", "show:switch ($1) {\n\tcase $2:\n\t\t$0\n}", "Like @switch, but a case it leaves is hidden and kept, not removed"),
    ("pause", "pause", "In a @show branch: stops it (bare, first) or a block of it (@pause { }) while hidden"),
    ("Routes", "Routes(${1:route}) {\n\t$0\n}", "Routes block"),
];

const ROUTE_SECTIONS: &[(&str, &str, &str)] = &[
    ("notFound", "notFound {\n\t$0\n}", "Renders when no route matches"),
    ("catch", "catch(${1:e}) {\n\t$0\n}", "Renders when the page fails"),
    ("default", "default(${1:page}) {\n\t$0\n}", "Wraps pages no other section matched (last section)"),
];

const BIND_ATTRS: &[(&str, &str)] = &[
    ("@bind", "Two-way binding (value or checked)"),
    ("@bind:input", "Two-way binding written back on each input"),
    ("@bind:event", "Event that updates the binding, e.g. oninput"),
    ("@bind:after", "Handler to run after the bound value changes"),
    ("@bind:debounce", "Write the bound value back once input pauses this many milliseconds"),
    ("@key", "Match this item by key when the list changes"),
    ("@ref", "Assign the DOM element to a field"),
];

const COMPONENT_DIRECTIVES: &[(&str, &str)] = &[
    ("@key", "Match this component by key when the list changes"),
    ("@ref", "Assign the component instance to a field"),
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
    completions_with(text, offset, doc_path, components, &[])
}

fn value_item(label: &str, detail: String) -> Completion {
    Completion { label: label.to_string(), kind: KIND_VALUE, detail, insert: label.to_string(), snippet: false, extra_edit: None }
}

/// [`completions`], with the CSS class names of the project and its packages for `class="..."`.
pub fn completions_with(text: &str, offset: usize, doc_path: &Path, components: &[Component], classes: &[String]) -> Vec<Completion> {
    match context(text, offset) {
        Context::AttrValue { tag, attr, prefix, .. } => {
            let component = components.iter().find(|c| c.name == tag);
            let prop = component.and_then(|c| c.props.iter().find(|p| p.name == attr));
            let mut values: Vec<(String, String)> = match prop {
                Some(p) if takes_id(&p.name, &p.doc) => ids(text).into_iter().map(|id| (id, "id on this page".to_string())).collect(),
                Some(p) => p.values.iter().map(|v| (v.clone(), format!("{tag}.{}: {}", p.name, p.ty.as_deref().unwrap_or("string")))).collect(),
                None if component.is_some() => Vec::new(),
                None if attr == "class" => classes.iter().map(|c| (c.clone(), "CSS class".to_string())).collect(),
                None if takes_id(&attr, "") => ids(text).into_iter().map(|id| (id, "id on this page".to_string())).collect(),
                None => NATIVE_VALUES
                    .iter()
                    .filter(|(a, _)| *a == attr)
                    .flat_map(|(_, vs)| vs.iter().map(|v| (v.to_string(), format!("{attr} value"))))
                    .collect(),
            };
            values.retain(|(v, _)| matches_prefix(v, &prefix));
            values.into_iter().map(|(v, d)| value_item(&v, d)).collect()
        }
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
                let from = c.import.clone().unwrap_or_else(|| relative_import(dir, &c.path));
                let import = format!("@import {} from \"{from}\"\n", c.name);
                Completion {
                    label: c.name.clone(),
                    kind: KIND_CLASS,
                    detail: match &c.import {
                        Some(spec) => format!("component from {spec}"),
                        None => format!("component {}", c.path.file_name().unwrap_or_default().to_string_lossy()),
                    },
                    insert: c.name.clone(),
                    snippet: false,
                    extra_edit: (!imported && !is_self).then(|| (import_insert_offset(text), import)),
                }
            })
            .collect(),
        Context::Attr { tag, prefix, .. } => {
            if let Some(c) = components.iter().find(|c| c.name == tag) {
                let directives = COMPONENT_DIRECTIVES
                    .iter()
                    .map(|(label, detail)| (label.to_string(), detail.to_string()))
                    .chain(c.props.iter().filter(|p| p.ty.as_deref().is_some_and(|t| t.starts_with("EventCallback"))).map(|p| (format!("@{}", p.name.to_ascii_lowercase()), p.decl.clone())))
                    .filter(|(label, _)| prefix.starts_with('@') && matches_prefix(label, &prefix))
                    .map(|(label, detail)| Completion {
                        insert: format!("{label}=\"$1\""),
                        label,
                        kind: KIND_KEYWORD,
                        detail,
                        snippet: true,
                        extra_edit: None,
                    });
                return c
                    .props
                    .iter()
                    .filter(|p| matches_prefix(&p.name, &prefix))
                    .map(|p| Completion {
                        label: p.name.clone(),
                        kind: KIND_PROPERTY,
                        detail: if p.doc.is_empty() { p.decl.clone() } else { format!("{} // {}", p.decl, p.doc) },
                        insert: format!("{}=\"$1\"", p.name),
                        snippet: true,
                        extra_edit: None,
                    })
                    .chain(directives)
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
        Context::Route { prefix, .. } => {
            let mut tags: Vec<&str> = components.iter().flat_map(|c| &c.tags).map(String::as_str).collect();
            tags.sort_unstable();
            tags.dedup();
            tags.into_iter()
                .map(|t| (t, format!("{t}(${{1:page}}) {{\n\t$0\n}}"), "Section for the pages tagged with it"))
                .chain(ROUTE_SECTIONS.iter().map(|(k, snippet, detail)| (*k, snippet.to_string(), *detail)))
                .filter(|(label, _, _)| matches_prefix(label, &prefix))
                .map(|(label, insert, detail)| Completion {
                    label: label.into(),
                    kind: KIND_KEYWORD,
                    detail: detail.into(),
                    insert,
                    snippet: true,
                    extra_edit: None,
                })
                .collect()
        }
        Context::Other => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counter() -> Component {
        let src = "@code {\n  label: string = \"Count\";\n  step = 1;\n  increment() {}\n}\n<p>@label</p>";
        component_from_source(Path::new("/app/Counter.xzor"), src)
    }

    #[test]
    fn attr_goes_to_its_owning_element() {
        let doc = "<span class=\"x\">\n@if (a) { <b/> } else {\n  @attr:class=\"error\" none\n}\n</span>";
        let at = doc.find("attr:").unwrap();
        assert_eq!(attr_owner(doc, at), Some((1, 5)));
        assert_eq!(attr_owner(doc, at + "attr:cl".len()), Some((1, 5)));
        assert_eq!(attr_owner(doc, doc.find("none").unwrap()), None);
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
        let card = component_from_source(Path::new("/app/Card.xzor"), "<section>@slot:header @slot:footer(1) @slot</section>");
        assert_eq!(card.slots.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["header", "footer"]);

        let doc = "<Card title=\"x\">\n  <p/>\n  @slot he";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[card.clone()]);
        assert_eq!(items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["header"]);

        let doc = "<Card>\n  <div>@slot he";
        assert_eq!(context(doc, doc.len()), Context::Other);

        let doc = "<Card>@slot footer { x }</Card>";
        assert_eq!(symbol_at(doc, 14).map(|s| s.0), Some(Symbol::Slot { component: "Card".into(), name: "footer".into() }));
    }

    #[test]
    fn key_and_ref_directives_complete() {
        let labels = |doc: &str, comps: &[Component]| -> Vec<String> {
            completions(doc, doc.len(), Path::new("/app/A.xzor"), comps).into_iter().map(|c| c.label).collect()
        };
        assert_eq!(labels("<li @k", &[]), ["@key"]);
        assert_eq!(labels("<input @r", &[]), ["@ref"]);
        assert_eq!(labels("<Counter @", &[counter()]), ["@key", "@ref"]);
        let button = component_from_source(Path::new("/app/Button.xzor"), "@code { onClick?: EventCallback<MouseEvent>; }\n<b/>");
        assert_eq!(labels("<Button @on", &[button]), ["@onclick"]);
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
        assert_eq!(context(t, t.len()), Context::AttrValue { tag: "p".into(), attr: "title".into(), prefix: "a b".into(), start: 10 });
        let t = "<p class=\"xz-a xz-b";
        assert_eq!(context(t, t.len()), Context::AttrValue { tag: "p".into(), attr: "class".into(), prefix: "xz-b".into(), start: t.len() - 4 });
        let t = "<p title=\"@x";
        assert!(!matches!(context(t, t.len()), Context::AttrValue { .. }));
        let t = "<p>x</p>\n@sw";
        assert_eq!(context(t, t.len()), Context::Directive { prefix: "sw".into(), start: t.len() - 2 });
        let t = "mail a@b";
        assert_eq!(context(t, t.len()), Context::Other);
    }

    #[test]
    fn attribute_value_completion() {
        let src = "@code {\n  /** Visual weight. */\n  tone?: \"neutral\" | \"accent\" = \"neutral\";\n  /** Id of the dialog to open. */\n  opens = \"\";\n}\n<i/>";
        let button = component_from_source(Path::new("/kit/Button.xzor"), src);
        assert_eq!(button.props[0].doc, "Visual weight.");
        assert_eq!(button.props[0].ty.as_deref(), Some("\"neutral\" | \"accent\""));
        assert_eq!(button.props[0].values, ["neutral", "accent"]);
        assert_eq!(button.props[1].ty, None);

        let labels = |doc: &str, classes: &[String]| -> Vec<String> {
            completions_with(doc, doc.len(), Path::new("/app/A.xzor"), std::slice::from_ref(&button), classes).into_iter().map(|c| c.label).collect()
        };
        assert_eq!(labels("<Button tone=\"a", &[]), ["accent"]);
        assert_eq!(labels("<dialog id=\"edit\"></dialog><dialog id=\"new\"/><Button opens=\"", &[]), ["edit", "new"]);
        assert_eq!(labels("<dialog id=\"edit\"/><button commandfor=\"e", &[]), ["edit"]);
        assert_eq!(labels("<button command=\"show", &[]), ["show-modal", "show-popover"]);
        assert_eq!(labels("<div class=\"xz-card xz-s", &css_classes(".xz-stack{} .xz-card > .xz-sheet{} url(a.woff2) 0.5rem")), ["xz-stack", "xz-sheet"]);
        assert!(labels("<Button tone=\"@x", &[]).is_empty());

        let doc = "<Button to";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), std::slice::from_ref(&button));
        assert_eq!(items[0].detail, "tone?: \"neutral\" | \"accent\" = \"neutral\" // Visual weight.");

        let mut kit = button.clone();
        kit.import = Some("@kit/Button.xzor".into());
        let doc = "<Bu";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[kit]);
        assert_eq!(items[0].extra_edit, Some((0, "@import Button from \"@kit/Button.xzor\"\n".into())));
    }

    #[test]
    fn component_completion_adds_import() {
        let doc = "@page \"/\"\n<main>\n  <Co";
        let items = completions(doc, doc.len(), Path::new("/app/pages/Home.xzor"), &[counter()]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "Counter");
        assert_eq!(items[0].extra_edit, Some(("@page \"/\"\n".len(), "@import Counter from \"../Counter.xzor\"\n".into())));

        let doc = "@import Counter from \"./Counter.xzor\"\n<Co";
        let items = completions(doc, doc.len(), Path::new("/app/Home.xzor"), &[counter()]);
        assert_eq!(items[0].extra_edit, None);
    }

    #[test]
    fn prop_event_and_directive_completion() {
        let doc = "<Counter s";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[counter()]);
        assert_eq!(items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["step"]);
        assert_eq!(items[0].insert, "step=\"$1\"");

        let doc = "<button @onc";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]);
        assert_eq!(items[0].label, "@onclick");

        let doc = "<input @bi";
        let labels: Vec<_> = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]).into_iter().map(|i| i.label).collect();
        assert_eq!(labels, ["@bind", "@bind:input", "@bind:event", "@bind:after", "@bind:debounce"]);

        let doc = "\n@i";
        let labels: Vec<_> = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]).into_iter().map(|i| i.label).collect();
        assert_eq!(labels, ["if", "import", "inherits", "implements", "inject"]);
    }

    #[test]
    fn directive_completions_include_inject() {
        let doc = "\n@inj";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "inject");
        assert_eq!(items[0].insert, "inject $1 $2");
    }

    #[test]
    fn directive_completions_include_the_new_syntax() {
        let labels = |doc: &str| completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]).into_iter().map(|i| (i.label, i.insert)).collect::<Vec<_>>();
        assert_eq!(labels("\n@onc"), [("once".to_string(), "once { $0 }".to_string())]);
        assert!(labels("<p>@att").contains(&("attr".to_string(), "attr:$1=\"$2\"".to_string())));
        assert_eq!(labels("\n@ke"), [("key".to_string(), "key($1)".to_string())]);
        assert_eq!(labels("\n@el"), [("else".to_string(), "else {\n\t$0\n}".to_string())]);
        let show: Vec<_> = labels("\n@sho").into_iter().map(|(l, _)| l).collect();
        assert_eq!(show, ["show:if", "show:switch"]);
        assert_eq!(labels("\n@pau"), [("pause".to_string(), "pause".to_string())]);
    }

    #[test]
    fn directive_completions_include_cascade() {
        let doc = "\n@cas";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "cascade");
        assert_eq!(items[0].insert, "cascade:$1($2) {\n\t$0\n}");
        assert_eq!(items[0].detail, "Cascading value for the components inside");
    }

    #[test]
    fn routes_block_directives_complete() {
        let doc = "\n@Rout";
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "Routes");
        assert_eq!(items[0].insert, "Routes(${1:route}) {\n\t$0\n}");
        assert_eq!(items[0].detail, "Routes block");
    }

    #[test]
    fn route_sections_and_tags_complete_inside_the_block() {
        let admin = component_from_source(Path::new("/app/Users.xzor"), "@page \"/a\" as admin\n@page \"/b\" as admin\n@page \"/c\" as user\n@page \"/d\"");
        assert_eq!(admin.tags, ["admin", "admin", "user"]);
        let labels = |doc: &str| -> Vec<String> {
            completions(doc, doc.len(), Path::new("/app/A.xzor"), std::slice::from_ref(&admin)).into_iter().map(|c| c.label).collect()
        };
        assert_eq!(labels("@Routes(route) {\n  @"), ["admin", "user", "notFound", "catch", "default"]);
        assert_eq!(labels("@Routes(route)\n{\n  @a"), ["admin"]);
        assert_eq!(labels("@Routes(route) {\n  @d"), ["default"]);
        assert_eq!(labels("@Routes(route) {\n  @n"), ["notFound"]);
        // Inside a section body and after the block they are ordinary directives.
        assert_eq!(labels("@Routes(route) {\n  @notFound {\n    @cas"), ["cascade"]);
        assert_eq!(labels("@Routes(route) {\n}\n@cas"), ["cascade"]);

        let doc = "@Routes(route) {\n  @catch(e) { <b/> }\n  @de";
        assert_eq!(context(doc, doc.len()), Context::Route { prefix: "de".into(), start: doc.len() - 2 });
        let items = completions(doc, doc.len(), Path::new("/app/A.xzor"), &[]);
        assert_eq!(items[0].insert, "default(${1:page}) {\n\t$0\n}");
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
        assert_eq!(relative_import(Path::new("/a/b"), Path::new("/a/b/C.xzor")), "./C.xzor");
        assert_eq!(relative_import(Path::new("/a/b"), Path::new("/a/c/D.xzor")), "../c/D.xzor");
    }
}
