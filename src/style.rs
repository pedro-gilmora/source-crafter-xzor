//! Component styles: a `<style>` block (or a sibling `X.css.xzor`) lowered to one static style sheet plus
//! attributes for the component's root elements.
//!
//! - Scoped by default: the rules are wrapped in `@scope ([data-xz="<id>"]) to (:scope [data-xz] > *)`, so they
//!   reach the component's own markup and the roots of its child components, not their insides.
//! - A declaration whose value holds `@expr` or `@(expr)` reads `var(--<id>-<n>)`; the roots get the attribute
//!   `--<id>-<n>` with the value's text, which the runtime writes as a custom property. One property per
//!   declaration, so a change touches one property.
//! - `@if (c) { ... } else if (d) { ... } else { ... }` gives each condition a boolean root attribute
//!   `data-<id>-<n>`, and its rules are nested under a guard on the scope root.
//! - `@@` is a literal `@`; CSS at-rules (`@media`, `@keyframes`, ...) are left alone.

use crate::ast::{Attr, AttrValue, Part, Src};

#[derive(Debug)]
pub struct Lowered {
    pub css: String,
    /// `--<id>-<n>` and `data-<id>-<n>` attributes, in source order.
    pub attrs: Vec<Attr>,
}

/// The scope id of a component: `x` plus a hash of its project-relative path (stable across style edits).
pub fn style_id(key: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in key.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    let mut s = String::from("x");
    for _ in 0..6 {
        let d = (h % 36) as u8;
        s.push(if d < 10 { (b'0' + d) as char } else { (b'a' + d - 10) as char });
        h /= 36;
    }
    s
}

/// Lowers a style body (`at` is its offset in the `.xzor` source). Errors carry an offset.
pub fn lower(body: &str, at: usize, id: &str, global: bool) -> Result<Lowered, (String, usize)> {
    let root = if global { format!("[data-xz=\"{id}\"]") } else { ":scope".to_string() };
    let mut l = Lowerer { s: body, b: body.as_bytes(), at, pos: 0, id, root, global, out: String::new(), attrs: Vec::new(), vars: 0, conds: 0 };
    l.block(false, Ctx::Root)?;
    let css = if global {
        l.out
    } else {
        format!("@scope ([data-xz=\"{id}\"]) to (:scope [data-xz] > *) {{\n{}\n}}\n", l.out.trim_matches('\n'))
    };
    Ok(Lowered { css, attrs: l.attrs })
}

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// Top level: `&` would not mean the root, so guards name it.
    Root,
    /// Directly in an `@if` branch: `&` is the guarded root.
    Guard,
    /// Inside a style rule: `&` is that rule's elements.
    Rule,
    /// Inside `@keyframes`, `@font-face` and the like: selectors are not element selectors.
    Raw,
}

enum Piece {
    Text(String),
    Expr(Src),
}

struct Lowerer<'a> {
    s: &'a str,
    b: &'a [u8],
    at: usize,
    pos: usize,
    id: &'a str,
    root: String,
    global: bool,
    out: String,
    attrs: Vec<Attr>,
    vars: usize,
    conds: usize,
}

impl Lowerer<'_> {
    fn err<T>(&self, message: &str, pos: usize) -> Result<T, (String, usize)> {
        Err((message.to_string(), self.off(pos)))
    }

    /// Source offset of `pos`; a sibling `X.css.xzor` has none in the `.xzor`.
    fn off(&self, pos: usize) -> usize {
        if self.at == Src::UNMAPPED { Src::UNMAPPED } else { self.at + pos }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }

    /// Statements until the `}` closing this block (consumed when `nested`) or the end.
    fn block(&mut self, nested: bool, ctx: Ctx) -> Result<(), (String, usize)> {
        loop {
            let ws = self.pos;
            while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                self.pos += 1;
            }
            self.out.push_str(&self.s[ws..self.pos]);
            match self.peek() {
                None if nested => return self.err("unclosed '{' in <style>", self.pos),
                None => return Ok(()),
                Some(b'}') if nested => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(b'}') => return self.err("unexpected '}' in <style>", self.pos),
                Some(b'/') if self.b.get(self.pos + 1) == Some(&b'*') => {
                    let start = self.pos;
                    self.skip_comment()?;
                    self.out.push_str(&self.s[start..self.pos]);
                }
                Some(b'@') if self.at_if() => self.if_chain(ctx)?,
                _ => self.statement(ctx)?,
            }
        }
    }

    fn at_if(&self) -> bool {
        self.s[self.pos..].starts_with("@if") && matches!(self.b.get(self.pos + 3), Some(b'(' | b' ' | b'\t' | b'\r' | b'\n'))
    }

    fn skip_comment(&mut self) -> Result<(), (String, usize)> {
        match self.s[self.pos + 2..].find("*/") {
            Some(n) => {
                self.pos += 2 + n + 2;
                Ok(())
            }
            None => self.err("unterminated comment in <style>", self.pos),
        }
    }

    fn skip_string(&mut self) -> Result<(), (String, usize)> {
        let start = self.pos;
        let q = self.b[self.pos];
        self.pos += 1;
        while let Some(c) = self.peek() {
            self.pos += if c == b'\\' { 2 } else { 1 };
            if c == q {
                return Ok(());
            }
        }
        self.err("unterminated string in <style>", start)
    }

    /// Moves past a balanced `(...)`/`[...]` starting at `pos`, skipping strings.
    fn balanced(&mut self) -> Result<(), (String, usize)> {
        let start = self.pos;
        let mut depth = 0usize;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' | b'`' => {
                    self.skip_string()?;
                    continue;
                }
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        self.pos += 1;
                        return Ok(());
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        self.err("unbalanced brackets in <style>", start)
    }

    /// `@(expr)` or `@name.chain(args)[i]`; `pos` is at the `@`.
    fn expr(&mut self) -> Result<Src, (String, usize)> {
        self.pos += 1;
        if self.peek() == Some(b'(') {
            let open = self.pos;
            self.balanced()?;
            let raw = &self.s[open + 1..self.pos - 1];
            let lead = raw.len() - raw.trim_start().len();
            return Ok(Src::new(raw.trim(), self.off(open + 1 + lead)));
        }
        let start = self.pos;
        let ident = |b: &[u8], mut i: usize| {
            while b.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$')) {
                i += 1;
            }
            i
        };
        self.pos = ident(self.b, self.pos);
        loop {
            match (self.peek(), self.b.get(self.pos + 1).copied()) {
                (Some(b'.'), Some(c)) if c.is_ascii_alphabetic() || matches!(c, b'_' | b'$') => self.pos = ident(self.b, self.pos + 1),
                (Some(b'?'), Some(b'.')) => self.pos = ident(self.b, self.pos + 2),
                (Some(b'(' | b'['), _) => self.balanced()?,
                _ => break,
            }
        }
        Ok(Src::new(&self.s[start..self.pos], self.off(start)))
    }

    /// One statement: a rule or at-rule with a block, or a declaration or at-rule ending in `;` or `}`.
    fn statement(&mut self, ctx: Ctx) -> Result<(), (String, usize)> {
        let start = self.pos;
        let mut pieces: Vec<Piece> = Vec::new();
        let mut text = String::new();
        let mut in_value = false;
        let mut depth = 0usize;
        let end = loop {
            let Some(c) = self.peek() else { break None };
            match c {
                b'{' | b';' if depth == 0 => break Some(c),
                b'}' if depth == 0 => break Some(c),
                b'"' | b'\'' => {
                    let s = self.pos;
                    self.skip_string()?;
                    text.push_str(&self.s[s..self.pos]);
                }
                b'/' if self.b.get(self.pos + 1) == Some(&b'*') => {
                    let s = self.pos;
                    self.skip_comment()?;
                    text.push_str(&self.s[s..self.pos]);
                }
                b'@' if self.b.get(self.pos + 1) == Some(&b'@') => {
                    text.push('@');
                    self.pos += 2;
                }
                b'@' if self.b.get(self.pos + 1) == Some(&b'(') || (in_value && self.b.get(self.pos + 1).is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, b'_' | b'$'))) => {
                    if !text.is_empty() {
                        pieces.push(Piece::Text(std::mem::take(&mut text)));
                    }
                    pieces.push(Piece::Expr(self.expr()?));
                }
                _ => {
                    match c {
                        b':' if depth == 0 => in_value = true,
                        b'(' | b'[' => depth += 1,
                        b')' | b']' => depth = depth.saturating_sub(1),
                        _ => {}
                    }
                    let ch = self.s[self.pos..].chars().next().unwrap_or(' ');
                    text.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        };
        if !text.is_empty() {
            pieces.push(Piece::Text(text));
        }
        let has_expr = pieces.iter().any(|p| matches!(p, Piece::Expr(_)));
        match end {
            Some(b'{') => {
                if has_expr {
                    return self.err("@ expressions go in property values, not in selectors or at-rule preludes", start);
                }
                self.pos += 1;
                let prelude = flat(&pieces);
                let trimmed = prelude.trim();
                let raw_rule = ["@keyframes", "@-webkit-keyframes", "@font-face", "@page", "@property", "@counter-style", "@font-feature-values"];
                let inner = if raw_rule.iter().any(|r| trimmed.starts_with(r)) {
                    Ctx::Raw
                } else if trimmed.starts_with('@') {
                    ctx
                } else {
                    Ctx::Rule
                };
                // A selector in `@scope` matches below the root only; `:where(root, root *):is(S)` keeps S's
                // specificity and also matches the root (the component's top element, or a slot fill's).
                let anchor = match ctx {
                    Ctx::Root if !self.global => Some(":scope"),
                    Ctx::Guard => Some("&"),
                    _ => None,
                };
                match anchor {
                    Some(a) if !trimmed.starts_with('@') => {
                        self.out.push_str(&anchored(trimmed, a));
                        self.out.push(' ');
                    }
                    _ => self.out.push_str(&prelude),
                }
                self.out.push('{');
                self.block(true, inner)?;
                self.out.push('}');
            }
            _ => {
                if !has_expr {
                    self.out.push_str(&flat(&pieces));
                } else {
                    self.declaration(pieces, start)?;
                }
                if end == Some(b';') {
                    self.pos += 1;
                    self.out.push(';');
                }
            }
        }
        Ok(())
    }

    /// `prop: value with @expr` becomes `prop: var(--<id>-<n>)` plus the root attribute holding the value.
    fn declaration(&mut self, mut pieces: Vec<Piece>, start: usize) -> Result<(), (String, usize)> {
        let Some(Piece::Text(head)) = pieces.first_mut() else { return self.err("expected a property name before an @ expression", start) };
        let Some(colon) = head.find(':') else { return self.err("expected a property name before an @ expression", start) };
        let prop = head[..=colon].to_string();
        let rest = head[colon + 1..].trim_start().to_string();
        *head = rest;
        let mut important = "";
        if let Some(Piece::Text(tail)) = pieces.last_mut() {
            let t = tail.trim_end();
            if let Some(cut) = t.strip_suffix("!important") {
                *tail = cut.trim_end().to_string();
                important = " !important";
            } else {
                let len = t.len();
                tail.truncate(len);
            }
        }
        let parts: Vec<Part> = pieces
            .into_iter()
            .filter(|p| !matches!(p, Piece::Text(t) if t.is_empty()))
            .map(|p| match p {
                Piece::Text(t) => Part::Text(t),
                Piece::Expr(e) => Part::Expr(e),
            })
            .collect();
        let name = format!("--{}-{}", self.id, self.vars);
        self.vars += 1;
        let value = match parts.as_slice() {
            [Part::Expr(e)] => AttrValue::Expr(e.clone()),
            _ => AttrValue::Interp(parts),
        };
        self.out.push_str(&format!("{prop} var({name}){important}"));
        self.attrs.push(Attr { name: Src::new(name, Src::UNMAPPED), value });
        Ok(())
    }

    /// `@if (c) { ... } else if (d) { ... } else { ... }`.
    fn if_chain(&mut self, ctx: Ctx) -> Result<(), (String, usize)> {
        self.pos += 3;
        let mut names: Vec<String> = Vec::new();
        loop {
            while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                self.pos += 1;
            }
            let cond = if self.peek() == Some(b'(') {
                let open = self.pos;
                self.balanced()?;
                let raw = &self.s[open + 1..self.pos - 1];
                let lead = raw.len() - raw.trim_start().len();
                Some(Src::new(raw.trim(), self.off(open + 1 + lead)))
            } else {
                None
            };
            while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                self.pos += 1;
            }
            if self.peek() != Some(b'{') {
                return self.err("expected '{' after an @if condition in <style>", self.pos);
            }
            self.pos += 1;
            let mut guard: String = names.iter().map(|n| format!(":not([{n}])")).collect();
            if let Some(cond) = cond {
                let name = format!("data-{}-{}", self.id, self.conds);
                self.conds += 1;
                guard.push_str(&format!("[{name}]"));
                self.attrs.push(Attr { name: Src::new(name.clone(), Src::UNMAPPED), value: AttrValue::Expr(cond) });
                names.push(name);
            }
            let r = &self.root;
            let head = match ctx {
                Ctx::Root => format!("{r}{guard} {{"),
                Ctx::Guard => format!("&{guard} {{"),
                Ctx::Rule | Ctx::Raw => format!("&:where({r}{guard}, {r}{guard} *) {{"),
            };
            self.out.push_str(&head);
            self.block(true, Ctx::Guard)?;
            self.out.push('}');
            let save = self.pos;
            while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                self.pos += 1;
            }
            if !self.s[self.pos..].starts_with("else") || self.b.get(self.pos + 4).is_some_and(|c| c.is_ascii_alphanumeric()) {
                self.pos = save;
                return Ok(());
            }
            self.pos += 4;
            while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
                self.pos += 1;
            }
            if self.s[self.pos..].starts_with("if") && !self.b.get(self.pos + 2).is_some_and(|c| c.is_ascii_alphanumeric()) {
                self.pos += 2;
            } else if self.peek() != Some(b'{') {
                return self.err("expected 'if' or '{' after else in <style>", self.pos);
            }
            self.out.push('\n');
        }
    }
}

/// Puts `data-xz="<id>"` and the dynamic `attrs` on the component's root elements and on the top-level
/// elements of the content it passes to child components (slot fills render inside the child's DOM, where
/// the parent's custom properties and guards would not reach). Markup values in `@code` get the id only.
// ponytail: R roots x V dynamic declarations give R*V bindings running the same read; one binding writing
// every root would save ~165 B and ~1.5 µs per extra root and update, worth it once multi-root styled components are common.
pub fn inject(doc: &mut crate::ast::Document, id: &str, attrs: &[Attr]) {
    let scope = Attr { name: Src::new("data-xz", Src::UNMAPPED), value: AttrValue::Static(Src::new(id, Src::UNMAPPED)) };
    let mut all = vec![scope.clone()];
    all.extend(attrs.iter().cloned());
    for node in &mut doc.nodes {
        visit(node, &all, true);
    }
    let only_scope = [scope];
    for parts in &mut doc.code_parts {
        for part in parts {
            if let CodePart::Markup(el) = part {
                el.attrs.extend(only_scope.iter().cloned());
            }
        }
    }
}

use crate::ast::{CodePart, Node};

fn visit(node: &mut Node, attrs: &[Attr], root: bool) {
    let all = |nodes: &mut Vec<Node>, root: bool| nodes.iter_mut().for_each(|n| visit(n, attrs, root));
    match node {
        Node::Element(el) => visit_element(el, attrs, root),
        Node::SlotFill(f) => all(&mut f.body, true),
        Node::If { branches, otherwise } => {
            branches.iter_mut().for_each(|(_, b)| all(b, root));
            if let Some(b) = otherwise {
                all(b, root);
            }
        }
        Node::For { body, .. } | Node::While { body, .. } | Node::Cascade { body, .. } => all(body, root),
        Node::Switch { cases, .. } => cases.iter_mut().for_each(|c| all(&mut c.body, root)),
        Node::Routes { sections, .. } => sections.iter_mut().for_each(|s| all(&mut s.body, root)),
        Node::Slot(s) => {
            if let Some(b) = &mut s.fallback {
                all(b, root);
            }
        }
        Node::Code(parts) => {
            for part in parts {
                match part {
                    CodePart::Render(nodes) => all(nodes, root),
                    CodePart::Markup(el) => visit_element(el, attrs, root),
                    CodePart::Ts(_) => {}
                }
            }
        }
        Node::Text(_) | Node::Expr(_) => {}
    }
}

fn visit_element(el: &mut crate::ast::Element, attrs: &[Attr], root: bool) {
    // Content written between a component's tags renders in the child: its top level is a root of ours.
    let (mine, kids_root) = if el.is_component() {
        (false, true)
    } else if &*el.name == "text" {
        // `<text>` renders its content only.
        (false, root)
    } else {
        (root, false)
    };
    if mine {
        el.attrs.extend(attrs.iter().cloned());
    }
    el.children.iter_mut().for_each(|n| visit(n, attrs, kids_root));
}

/// Each selector of a list as `:where(a, a *):is(S)`, with a trailing pseudo-element kept outside `:is()`;
/// a selector already naming the root (`:scope`, `&`) is kept.
fn anchored(list: &str, a: &str) -> String {
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    let b = list.as_bytes();
    let mut parts = Vec::new();
    for (i, &c) in b.iter().enumerate() {
        match c {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&list[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&list[start..]);
    for sel in parts.iter().map(|s| s.trim()) {
        if sel.starts_with(":scope") || sel.starts_with('&') {
            out.push(if a == "&" { sel.replacen(":scope", "&", 1) } else { sel.to_string() });
            continue;
        }
        let (main, pseudo) = match sel.rfind("::") {
            Some(i) if !sel[i..].contains([' ', '>', '+', '~']) => (&sel[..i], &sel[i..]),
            _ => (sel, ""),
        };
        out.push(format!(":where({a}, {a} *):is({main}){pseudo}"));
    }
    out.join(", ")
}

fn flat(pieces: &[Piece]) -> String {
    pieces
        .iter()
        .map(|p| match p {
            Piece::Text(t) => t.as_str(),
            Piece::Expr(e) => e.text.as_str(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn low(css: &str) -> Lowered {
        lower(css, 0, "x1", false).unwrap_or_else(|e| panic!("{e:?}"))
    }

    #[test]
    fn plain_rules_are_wrapped_in_a_scope_that_stops_inside_child_components() {
        let l = low(".a { color: red; }\n@media (width > 1px) { .b { margin: 0 } }");
        assert!(l.css.starts_with("@scope ([data-xz=\"x1\"]) to (:scope [data-xz] > *) {\n"), "{}", l.css);
        assert!(l.css.contains(":where(:scope, :scope *):is(.a) { color: red; }") && l.css.contains("@media (width > 1px) { :where(:scope, :scope *):is(.b) { margin: 0 } }"), "{}", l.css);
        assert!(l.attrs.is_empty());
        let g = lower(".a { color: red; }", 0, "x1", true).unwrap();
        assert_eq!(g.css, ".a { color: red; }");
    }

    #[test]
    fn a_dynamic_value_becomes_one_custom_property_per_declaration() {
        let src = ".bar { width: @progress%; border: 1px solid @(ok ? 'green' : 'red') !important; color: blue }";
        let l = low(src);
        assert!(l.css.contains(":is(.bar) { width: var(--x1-0); border: var(--x1-1) !important; color: blue }"), "{}", l.css);
        assert_eq!(l.attrs[0].name, "--x1-0");
        assert_eq!(l.attrs[0].value, AttrValue::Interp(vec![Part::Expr("progress".into()), Part::Text("%".into())]));
        let AttrValue::Interp(parts) = &l.attrs[1].value else { panic!("{:?}", l.attrs[1].value) };
        assert_eq!(parts, &vec![Part::Text("1px solid ".into()), Part::Expr("ok ? 'green' : 'red'".into())]);
        let AttrValue::Interp(parts) = &l.attrs[0].value else { unreachable!() };
        let Part::Expr(e) = &parts[0] else { unreachable!() };
        assert_eq!(&src[e.at..e.at + e.len()], "progress");
        let l = low(".x { opacity: @level }");
        assert_eq!(l.attrs[0].value, AttrValue::Expr("level".into()));
    }

    #[test]
    fn if_chains_guard_the_root_with_one_attribute_per_condition() {
        let l = low("@if (big) { .t { font-size: 2rem } :scope { gap: 0 } } else if (small) { .t { font-size: 1rem } } else { .t { color: gray } }\n.t { @if (on) { color: red } }");
        assert!(l.css.contains(":scope[data-x1-0] { :where(&, & *):is(.t) { font-size: 2rem } & { gap: 0 } }"), "{}", l.css);
        assert!(l.css.contains(":scope:not([data-x1-0])[data-x1-1] { :where(&, & *):is(.t) { font-size: 1rem } }"), "{}", l.css);
        assert!(l.css.contains(":scope:not([data-x1-0]):not([data-x1-1]) { :where(&, & *):is(.t) { color: gray } }"), "{}", l.css);
        assert!(l.css.contains(":is(.t) { &:where(:scope[data-x1-2], :scope[data-x1-2] *) { color: red } }"), "{}", l.css);
        let names: Vec<&str> = l.attrs.iter().map(|a| a.name.text.as_str()).collect();
        assert_eq!(names, ["data-x1-0", "data-x1-1", "data-x1-2"]);
        assert_eq!(l.attrs[1].value, AttrValue::Expr("small".into()));
    }

    #[test]
    fn at_rules_escapes_comments_and_errors() {
        let l = low("/* @x */ @keyframes k { from { opacity: 0 } }\n.a::after { content: \"@b\"; } .m { margin: @@x }");
        assert!(l.css.contains("/* @x */ @keyframes k { from { opacity: 0 } }") && l.css.contains("content: \"@b\";") && l.css.contains("margin: @x"), "{}", l.css);
        assert!(l.attrs.is_empty());
        assert!(lower(".a@(x) { color: red }", 0, "x1", false).unwrap_err().0.contains("property values"));
        assert!(lower(".a { color: red", 0, "x1", false).unwrap_err().0.contains("unclosed"));
    }

    #[test]
    fn root_matching_keeps_pseudo_elements_and_raw_at_rules() {
        assert_eq!(anchored(".a::after, ul > li:hover, :scope .x", ":scope"), ":where(:scope, :scope *):is(.a)::after, :where(:scope, :scope *):is(ul > li:hover), :scope .x");
        let l = low("@keyframes k { from { opacity: 0 } }");
        assert!(l.css.contains("@keyframes k { from { opacity: 0 } }"), "{}", l.css);
    }

    #[test]
    fn ids_are_stable_and_short() {
        assert_eq!(style_id("pages/Home.xzor"), style_id("pages/Home.xzor"));
        assert_ne!(style_id("pages/Home.xzor"), style_id("Home.xzor"));
        assert_eq!(style_id("a").len(), 7);
    }
}
