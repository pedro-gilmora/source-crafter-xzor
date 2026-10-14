//! Hand-written recursive-descent parser for `.xzor` (Razor-style) templates.
//!
//! Besides the AST it records classified token spans, which drive the highlighter
//! (and later LSP semantic tokens).

use crate::ast::*;
use crate::codegen::{is_comment, skip_literal, word_prev};
use crate::{is_ident_char, is_ident_start};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Transition,
    Keyword,
    Code,
    TagDelim,
    TagName,
    ComponentName,
    AttrName,
    AttrValue,
    Comment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub offset: usize,
}

type PResult<T> = Result<T, ParseError>;

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

pub fn parse(src: &str) -> PResult<(Document, Vec<Token>)> {
    let mut p = Parser {
        src,
        b: src.as_bytes(),
        pos: 0,
        tokens: Vec::new(),
        doc: Document::default(),
        case_break: false,
        in_component: false,
        bound: Vec::new(),
        routes_seen: false,
    };
    p.doc.nodes = p.nodes(Until::Eof)?;
    Ok((p.doc, p.tokens))
}

#[derive(Clone, Copy)]
enum Until<'n> {
    Eof,
    Brace,
    /// Body of a `@switch` case: ends before `case`, `default` or the switch's `}`.
    Case,
    /// A `@:` line: ends before the newline.
    Line,
    EndTag(&'n str),
}

enum Transition {
    Node(Node),
    Text(&'static str),
    Nothing,
}

struct Parser<'a> {
    src: &'a str,
    b: &'a [u8],
    pos: usize,
    tokens: Vec<Token>,
    doc: Document,
    case_break: bool,
    /// Parsing the direct children of a component tag, where `@slot name { }` fills a slot.
    in_component: bool,
    /// Names a routes block binds (`route`, `page`, the `@catch` error); they shadow directives.
    bound: Vec<String>,
    /// A routes block was already opened in this document.
    routes_seen: bool,
}

/// Words that follow `@` as directives; `@cascade`, `@ClientRoutes` and `@ServerRoutes` are
/// directives only in certain shapes, so they are matched separately.
const DIRECTIVES: &[&str] =
    &["code", "page", "import", "if", "for", "while", "switch", "typeparam", "slot", "inherits", "implements", "attribute", "inject"];

impl<'a> Parser<'a> {
    fn at_word(&self, w: &str) -> bool {
        self.starts_with(w)
            && !self.prev_is_alnum()
            && !matches!(self.b.get(self.pos + w.len()), Some(&c) if is_ident_char(c))
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }

    fn peek_at(&self, n: usize) -> Option<u8> {
        self.b.get(self.pos + n).copied()
    }

    fn starts_with(&self, s: &str) -> bool {
        self.b[self.pos..].starts_with(s.as_bytes())
    }

    /// The next byte that is not a space or tab, without moving.
    fn next_non_blank(&self) -> Option<u8> {
        self.b[self.pos..].iter().copied().find(|c| !matches!(c, b' ' | b'\t'))
    }

    fn prev_is_alnum(&self) -> bool {
        self.pos > 0 && self.b[self.pos - 1].is_ascii_alphanumeric()
    }

    fn err<T>(&self, message: impl Into<String>) -> PResult<T> {
        Err(ParseError {
            message: message.into(),
            offset: self.pos,
        })
    }

    /// Trimmed source slice with the offset of its first kept character.
    fn span(&self, start: usize, end: usize) -> Src {
        let raw = &self.src[start..end];
        let lead = raw.len() - raw.trim_start().len();
        Src::new(raw.trim(), start + lead)
    }

    fn mark(&mut self, kind: TokenKind, start: usize, end: usize) {
        if end > start {
            self.tokens.push(Token { kind, start, end });
        }
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_ascii_whitespace()) {
            self.pos += 1;
        }
    }

    fn skip_line(&mut self) {
        while !matches!(self.peek(), None | Some(b'\n')) {
            self.pos += 1;
        }
    }

    /// Scans a directive value up to a `//` or `@*` outside strings, then consumes the trailing
    /// comment. Returns the end of the value (trailing whitespace excluded).
    fn directive_value(&mut self) -> PResult<usize> {
        let b = self.b;
        let mut i = self.pos;
        let mut quote = 0u8;
        while let Some(&c) = b.get(i) {
            if c == b'\n' {
                break;
            }
            if quote != 0 {
                if c == b'\\' && b.get(i + 1).is_some_and(|&n| n != b'\n') {
                    i += 1;
                } else if c == quote {
                    quote = 0;
                }
            } else if matches!(c, b'\'' | b'"' | b'`') {
                quote = c;
            } else if (c == b'/' && b.get(i + 1) == Some(&b'/')) || (c == b'@' && b.get(i + 1) == Some(&b'*')) {
                break;
            }
            i += 1;
        }
        let i = i.min(b.len());
        let mut end = i;
        while end > self.pos && b[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        self.pos = i;
        self.trailing_comment()?;
        Ok(end)
    }

    /// Consumes an optional `// …` or `@* … *@` after a directive and marks it as a comment.
    fn trailing_comment(&mut self) -> PResult<()> {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        let start = self.pos;
        if self.starts_with("//") {
            self.skip_line();
            let mut end = self.pos;
            if end > start && self.b[end - 1] == b'\r' {
                end -= 1;
            }
            self.mark(TokenKind::Comment, start, end);
        } else if self.starts_with("@*") {
            let Some(len) = self.src[start + 2..].find("*@") else {
                return Err(ParseError { message: "unterminated @* comment".into(), offset: start });
            };
            self.pos = start + 2 + len + 2;
            self.mark(TokenKind::Comment, start, self.pos);
        }
        Ok(())
    }

    /// Consumes an optional `as <tag>` after a `@page` pattern.
    fn route_tag(&mut self) -> PResult<Option<Src>> {
        let before = self.pos;
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        let kw = self.pos;
        if kw == before || !self.starts_with("as") || matches!(self.peek_at(2), Some(c) if is_ident_char(c)) {
            self.pos = before;
            return Ok(None);
        }
        self.pos += 2;
        self.mark(TokenKind::Keyword, kw, self.pos);
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        let start = self.pos;
        if self.ident().is_empty() {
            return self.err("expected a route tag after \"as\"");
        }
        self.mark(TokenKind::Code, start, self.pos);
        Ok(Some(self.span(start, self.pos)))
    }

    fn ident(&mut self) -> &'a str {
        let src = self.src;
        let start = self.pos;
        if matches!(self.peek(), Some(c) if is_ident_start(c)) {
            self.pos += 1;
            while matches!(self.peek(), Some(c) if is_ident_char(c)) {
                self.pos += 1;
            }
        }
        &src[start..self.pos]
    }

    fn keyword(&mut self, kw: &str) -> bool {
        let after = self.b.get(self.pos + kw.len()).copied();
        if self.starts_with(kw) && !matches!(after, Some(c) if is_ident_char(c)) {
            self.mark(TokenKind::Keyword, self.pos, self.pos + kw.len());
            self.pos += kw.len();
            true
        } else {
            false
        }
    }

    fn next_char(&mut self) -> char {
        let ch = self.src[self.pos..].chars().next().expect("not at eof");
        self.pos += ch.len_utf8();
        ch
    }

    fn nodes(&mut self, until: Until) -> PResult<Vec<Node>> {
        let mut nodes = Vec::new();
        let mut text = String::new();
        loop {
            if matches!(until, Until::Case) && text.trim().is_empty() {
                if self.at_word("case") || self.at_word("default") || self.peek() == Some(b'}') {
                    return Ok(nodes);
                }
                if self.at_word("break") {
                    let start = self.pos;
                    self.pos += "break".len();
                    self.skip_ws();
                    if self.peek() != Some(b';') {
                        return self.err("expected ';' after break");
                    }
                    self.pos += 1;
                    self.mark(TokenKind::Keyword, start, self.pos);
                    self.case_break = true;
                    text.clear();
                    continue;
                }
            }
            if matches!(until, Until::Case) && text.trim().is_empty() && matches!(self.peek(), Some(b'<' | b'@')) {
                text.clear();
            }
            let Some(c) = self.peek() else {
                return match until {
                    Until::Eof | Until::Line => {
                        flush_text(&mut nodes, &mut text);
                        Ok(nodes)
                    }
                    Until::Brace | Until::Case => self.err("unclosed '{' block"),
                    Until::EndTag(name) => self.err(format!("missing closing tag </{name}>")),
                };
            };
            match c {
                b'\n' | b'\r' if matches!(until, Until::Line) => {
                    flush_text(&mut nodes, &mut text);
                    return Ok(nodes);
                }
                b'}' if matches!(until, Until::Brace) => {
                    self.mark(TokenKind::Transition, self.pos, self.pos + 1);
                    self.pos += 1;
                    flush_text(&mut nodes, &mut text);
                    return Ok(nodes);
                }
                b'}' if matches!(until, Until::Case) => {
                    flush_text(&mut nodes, &mut text);
                    return Ok(nodes);
                }
                b'<' if self.starts_with("<!--") => {
                    flush_text(&mut nodes, &mut text);
                    self.html_comment()?;
                }
                b'<' if self.peek_at(1) == Some(b'/') => {
                    flush_text(&mut nodes, &mut text);
                    let start = self.pos;
                    self.pos += 2;
                    let name = self.tag_name();
                    self.skip_ws();
                    if self.peek() != Some(b'>') {
                        return self.err("expected '>'");
                    }
                    self.pos += 1;
                    return match until {
                        Until::EndTag(open) if open == name => {
                            self.mark(TokenKind::TagDelim, start, start + 2);
                            self.mark(tag_kind(name), start + 2, start + 2 + name.len());
                            self.mark(TokenKind::TagDelim, self.pos - 1, self.pos);
                            Ok(nodes)
                        }
                        _ => Err(ParseError {
                            message: format!("unexpected closing tag </{name}>"),
                            offset: start,
                        }),
                    };
                }
                b'<' if matches!(self.peek_at(1), Some(c) if c.is_ascii_alphabetic()) => {
                    flush_text(&mut nodes, &mut text);
                    let el = self.element()?;
                    nodes.push(Node::Element(el));
                }
                b'@' if !self.prev_is_alnum() || self.peek_at(1) == Some(b'*') => match self.transition()? {
                    Transition::Node(n) => {
                        flush_text(&mut nodes, &mut text);
                        nodes.push(n);
                    }
                    Transition::Text(t) => text.push_str(t),
                    Transition::Nothing => {}
                },
                _ => {
                    let ch = self.next_char();
                    text.push(ch);
                }
            }
        }
    }

    /// Parses everything that starts with `@`. On entry `pos` is at the `@`.
    fn transition(&mut self) -> PResult<Transition> {
        let at = self.pos;
        self.pos += 1;
        match self.peek() {
            Some(b'@') => {
                self.pos += 1;
                return Ok(Transition::Text("@"));
            }
            Some(b'*') => {
                let Some(len) = self.src[self.pos..].find("*@") else {
                    return Err(ParseError { message: "unterminated @* comment".into(), offset: at });
                };
                self.pos += len + 2;
                self.mark(TokenKind::Comment, at, self.pos);
                return Ok(Transition::Nothing);
            }
            Some(b'{') => {
                self.mark(TokenKind::Transition, at, at + 1);
                let parts = self.code_block(true)?;
                return Ok(Transition::Node(Node::Code(parts)));
            }
            Some(b'(') => {
                let (s, e) = self.balanced(b'(', b')')?;
                self.mark(TokenKind::Transition, at, at + 1);
                self.mark(TokenKind::Code, s, e);
                return Ok(Transition::Node(Node::Expr(self.span(s + 1, e - 1))));
            }
            Some(c) if is_ident_start(c) => {}
            _ => return Ok(Transition::Text("@")),
        }

        let word_start = self.pos;
        let word = self.ident();
        // `@cascade` is only a block when `:` and a name follow; otherwise it is a member reference.
        let cascade = word == "cascade" && self.peek() == Some(b':') && matches!(self.peek_at(1), Some(c) if is_ident_start(c));
        // Likewise `@ClientRoutes`/`@ServerRoutes` only open a routes block when `(` follows on the same line.
        let routes = matches!(word, "ClientRoutes" | "ServerRoutes") && self.next_non_blank() == Some(b'(');
        self.mark(TokenKind::Transition, at, at + 1);
        if self.bound.iter().any(|b| b == word) {
            return self.implicit_expression(word_start);
        }
        let is_keyword = cascade || routes || DIRECTIVES.contains(&word);
        if is_keyword {
            self.mark(TokenKind::Keyword, word_start, self.pos);
        }
        match word {
            "code" => {
                self.skip_ws();
                if self.peek() != Some(b'{') {
                    return self.err("expected '{' after @code");
                }
                let open = self.pos;
                let parts = self.code_block(false)?;
                self.doc.code.push(Src::new(&self.src[open + 1..self.pos - 1], open + 1));
                self.doc.code_parts.push(parts);
                Ok(Transition::Nothing)
            }
            "page" => {
                while matches!(self.peek(), Some(b' ' | b'\t')) {
                    self.pos += 1;
                }
                let s = self.pos;
                if self.peek() != Some(b'"') {
                    return self.err("expected a quoted route after @page");
                }
                self.string_lit()?;
                self.mark(TokenKind::AttrValue, s, self.pos);
                let pattern = self.span(s + 1, self.pos - 1);
                if let Err(reason) = crate::routes::validate_pattern(&pattern) {
                    return Err(ParseError {
                        message: format!("invalid route pattern {:?}: {reason}", &*pattern),
                        offset: pattern.at,
                    });
                }
                let tag = self.route_tag()?;
                self.doc.pages.push(PageRoute { pattern, tag });
                while matches!(self.peek(), Some(b' ' | b'\t')) {
                    self.pos += 1;
                }
                if !matches!(self.peek(), None | Some(b'\n' | b'\r')) && !self.starts_with("//") && !self.starts_with("@*") {
                    return self.err("expected \"as <tag>\" or end of line after the @page route");
                }
                self.trailing_comment()?;
                Ok(Transition::Nothing)
            }
            "import" => {
                let s = self.pos;
                let end = self.directive_value()?;
                self.mark(TokenKind::Code, s, end);
                let mut stmt = self.span(s, end);
                stmt.text = stmt.text.trim_end_matches(';').trim_end().to_string();
                self.doc.imports.push(stmt);
                Ok(Transition::Nothing)
            }
            "typeparam" | "inherits" | "implements" | "attribute" => {
                let s = self.pos;
                let end = self.directive_value()?;
                self.mark(TokenKind::Code, s, end);
                let value = self.span(s, end);
                if value.is_empty() {
                    return self.err(format!("expected a value after @{word}"));
                }
                match word {
                    "typeparam" => self.doc.type_params.push(value),
                    "inherits" => self.doc.inherits = Some(value),
                    "implements" => self.doc.implements.push(value),
                    _ => self.doc.attributes.push(value),
                }
                Ok(Transition::Nothing)
            }
            "inject" => {
                let s = self.pos;
                let end = self.directive_value()?;
                self.mark(TokenKind::Code, s, end);
                let value = self.span(s, end);
                let split = value.rfind(|c: char| c.is_ascii_whitespace());
                let name = split.map(|i| &value[i + 1..]).filter(|n| n.bytes().next().is_some_and(is_ident_start) && n.bytes().all(is_ident_char));
                let (Some(split), Some(name)) = (split, name) else {
                    return self.err("expected a type and a name after @inject");
                };
                let ty = self.span(value.at, value.at + split);
                let name = Src::new(name, value.at + split + 1);
                self.doc.injects.push(Inject { ty, name });
                Ok(Transition::Nothing)
            }
            "while" => {
                let cond = self.condition()?;
                let body = self.block()?;
                Ok(Transition::Node(Node::While { cond, body }))
            }
            "if" => self.if_block().map(Transition::Node),
            "for" => {
                let head = self.condition()?;
                let body = self.block()?;
                Ok(Transition::Node(Node::For { head, body }))
            }
            "switch" => self.switch_block().map(Transition::Node),
            "slot" => self.slot().map(Transition::Node),
            "cascade" if cascade => self.cascade_block().map(Transition::Node),
            "ClientRoutes" if routes => self.routes_block(crate::routes::Engine::Client, word).map(Transition::Node),
            "ServerRoutes" if routes => self.routes_block(crate::routes::Engine::Server, word).map(Transition::Node),
            _ => self.implicit_expression(word_start),
        }
    }

    /// `@member`, `@member.path`, `@call(args)`: the implicit expression a non-keyword word starts.
    fn implicit_expression(&mut self, word_start: usize) -> PResult<Transition> {
        loop {
            match (self.peek(), self.peek_at(1)) {
                (Some(b'.'), Some(c)) if is_ident_start(c) => {
                    self.pos += 1;
                    self.ident();
                }
                (Some(b'?'), Some(b'.')) if matches!(self.peek_at(2), Some(c) if is_ident_start(c)) => {
                    self.pos += 2;
                    self.ident();
                }
                (Some(b'('), _) => {
                    self.balanced(b'(', b')')?;
                }
                (Some(b'['), _) => {
                    self.balanced(b'[', b']')?;
                }
                _ => break,
            }
        }
        self.mark(TokenKind::Code, word_start, self.pos);
        Ok(Transition::Node(Node::Expr(self.span(word_start, self.pos))))
    }

    /// Scans a `@code { ... }` or `@{ ... }` body (pos at `{`), splitting out markup used as a
    /// value: `@<Tag ...>` anywhere, or `<Tag ...>` where an expression can start. With `render`
    /// (`@{ }`), markup at statement start and `@:` lines are rendered in place. Markup that
    /// fails to parse is left as TypeScript (generics, type assertions).
    fn code_block(&mut self, render: bool) -> PResult<Vec<CodePart>> {
        let open = self.pos;
        self.pos += 1;
        let mut parts = Vec::new();
        let mut seg = self.pos;
        let mut depth = 1usize;
        // Whether the previous significant token lets an expression start here.
        let mut expr_start = false;
        let mut stmt_start = true;
        let flush = |p: &mut Self, parts: &mut Vec<CodePart>, seg: usize, end: usize| {
            if end > seg {
                p.mark(TokenKind::Code, seg, end);
                parts.push(CodePart::Ts(Src::new(&p.src[seg..end], seg)));
            }
        };
        loop {
            let Some(c) = self.peek() else {
                return Err(ParseError { message: "unclosed '{'".into(), offset: open });
            };
            if !matches!(c, b'<' | b'@') && !c.is_ascii_whitespace() && !(c == b'/' && matches!(self.peek_at(1), Some(b'/' | b'*'))) {
                stmt_start = matches!(c, b';' | b'{' | b'}');
            }
            match c {
                b'"' | b'\'' => {
                    self.string_lit()?;
                    expr_start = false;
                }
                b'`' => {
                    self.template_lit()?;
                    expr_start = false;
                }
                b'/' if self.peek_at(1) == Some(b'/') => self.skip_line(),
                b'/' if self.peek_at(1) == Some(b'*') => self.block_comment()?,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        flush(self, &mut parts, seg, self.pos);
                        self.pos += 1;
                        return Ok(parts);
                    }
                    self.pos += 1;
                    expr_start = false;
                }
                b'@' if render && stmt_start && self.peek_at(1) == Some(b':') => {
                    flush(self, &mut parts, seg, self.pos);
                    self.mark(TokenKind::Transition, self.pos, self.pos + 2);
                    self.pos += 2;
                    while matches!(self.peek(), Some(b' ' | b'\t')) {
                        self.pos += 1;
                    }
                    let saved = std::mem::replace(&mut self.in_component, false);
                    let line = self.nodes(Until::Line);
                    self.in_component = saved;
                    parts.push(CodePart::Render(trim_edges(line?)));
                    seg = self.pos;
                }
                b'<' if render && stmt_start && matches!(self.peek_at(1), Some(c) if c.is_ascii_alphabetic()) => {
                    let (save, tokens) = (self.pos, self.tokens.len());
                    match self.element() {
                        Ok(el) => {
                            let end = self.pos;
                            self.pos = save;
                            flush(self, &mut parts, seg, save);
                            self.pos = end;
                            parts.push(CodePart::Render(vec![Node::Element(el)]));
                            seg = self.pos;
                        }
                        Err(_) => {
                            self.pos = save + 1;
                            self.tokens.truncate(tokens);
                            stmt_start = false;
                            expr_start = true;
                        }
                    }
                }
                b'@' if self.peek_at(1) == Some(b'<') => {
                    flush(self, &mut parts, seg, self.pos);
                    self.mark(TokenKind::Transition, self.pos, self.pos + 1);
                    self.pos += 1;
                    parts.push(CodePart::Markup(self.element()?));
                    seg = self.pos;
                    expr_start = false;
                }
                b'<' if expr_start && matches!(self.peek_at(1), Some(c) if c.is_ascii_alphabetic()) => {
                    let (save, tokens) = (self.pos, self.tokens.len());
                    match self.element() {
                        Ok(el) => {
                            let end = self.pos;
                            self.pos = save;
                            flush(self, &mut parts, seg, save);
                            self.pos = end;
                            parts.push(CodePart::Markup(el));
                            seg = self.pos;
                            expr_start = false;
                        }
                        Err(_) => {
                            self.pos = save + 1;
                            self.tokens.truncate(tokens);
                            expr_start = true;
                        }
                    }
                }
                c if is_ident_start(c) => {
                    let word = self.ident();
                    expr_start = matches!(word, "return" | "yield" | "await");
                }
                c if c.is_ascii_digit() => {
                    while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == b'.' || c == b'_') {
                        self.pos += 1;
                    }
                    expr_start = false;
                }
                c if c.is_ascii_whitespace() => self.pos += 1,
                c => {
                    if c == b'{' {
                        depth += 1;
                    }
                    let arrow = c == b'>' && self.pos > 0 && self.b[self.pos - 1] == b'=';
                    expr_start = arrow || matches!(c, b'(' | b',' | b'=' | b'?' | b':' | b'[' | b'{' | b'!' | b'&' | b'|');
                    self.pos += 1;
                }
            }
        }
    }

    fn if_block(&mut self) -> PResult<Node> {
        let cond = self.condition()?;
        let body = self.block()?;
        let mut branches = vec![(cond, body)];
        let mut otherwise = None;
        loop {
            let save = self.pos;
            let tokens = self.tokens.len();
            self.skip_ws();
            if !self.keyword("else") {
                self.pos = save;
                self.tokens.truncate(tokens);
                break;
            }
            self.skip_ws();
            if self.keyword("if") {
                let cond = self.condition()?;
                let body = self.block()?;
                branches.push((cond, body));
            } else {
                otherwise = Some(self.block()?);
                break;
            }
        }
        Ok(Node::If {
            branches,
            otherwise,
        })
    }

    fn switch_block(&mut self) -> PResult<Node> {
        let subject = self.condition()?;
        self.skip_ws();
        if self.peek() != Some(b'{') {
            return self.err("expected '{'");
        }
        self.mark(TokenKind::Transition, self.pos, self.pos + 1);
        self.pos += 1;
        let saved = std::mem::replace(&mut self.in_component, false);
        let result = self.switch_cases(subject);
        self.in_component = saved;
        result
    }

    fn switch_cases(&mut self, subject: Src) -> PResult<Node> {
        let mut cases: Vec<Case> = Vec::new();
        // Labels with an empty body and no `break;` share the next label's body.
        let mut open = false;
        loop {
            self.skip_ws();
            let label = if self.keyword("case") {
                let start = self.pos;
                self.case_label()?;
                self.mark(TokenKind::Code, start, self.pos);
                let label = self.span(start, self.pos);
                self.pos += 1;
                Some(label)
            } else if self.keyword("default") {
                self.skip_ws();
                if self.peek() != Some(b':') {
                    return self.err("expected ':' after default");
                }
                self.pos += 1;
                None
            } else if self.peek() == Some(b'}') {
                self.mark(TokenKind::Transition, self.pos, self.pos + 1);
                self.pos += 1;
                return Ok(Node::Switch { subject, cases });
            } else {
                return self.err("expected 'case', 'default' or '}' in @switch");
            };
            self.case_break = false;
            let body = self.nodes(Until::Case)?;
            match cases.last_mut() {
                Some(last) if open => {
                    last.labels.push(label);
                    last.body = body;
                }
                _ => cases.push(Case { labels: vec![label], body }),
            }
            open = cases.last().is_some_and(|c| c.body.is_empty()) && !self.case_break;
        }
    }

    /// Advances to the `:` that ends a `case` label.
    fn case_label(&mut self) -> PResult<()> {
        let start = self.pos;
        let mut depth = 0i32;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' => self.string_lit()?,
                b'`' => self.template_lit()?,
                b':' if depth == 0 => return Ok(()),
                _ => {
                    match c {
                        b'(' | b'[' | b'{' => depth += 1,
                        b')' | b']' | b'}' => depth -= 1,
                        _ => {}
                    }
                    self.pos += 1;
                }
            }
        }
        Err(ParseError {
            message: "expected ':' after case".into(),
            offset: start,
        })
    }

    fn condition(&mut self) -> PResult<Src> {
        self.skip_ws();
        if self.peek() != Some(b'(') {
            return self.err("expected '('");
        }
        let (s, e) = self.balanced(b'(', b')')?;
        self.mark(TokenKind::Code, s, e);
        Ok(self.span(s + 1, e - 1))
    }

    fn block(&mut self) -> PResult<Vec<Node>> {
        self.skip_ws();
        if self.peek() != Some(b'{') {
            return self.err("expected '{'");
        }
        self.mark(TokenKind::Transition, self.pos, self.pos + 1);
        self.pos += 1;
        let saved = std::mem::replace(&mut self.in_component, false);
        let nodes = self.nodes(Until::Brace);
        self.in_component = saved;
        nodes.map(trim_edges)
    }

    /// `@cascade:name(value) { body }`, with an optional second argument `fixed`.
    /// Called with the parser on the `:`, which a name is known to follow.
    fn cascade_block(&mut self) -> PResult<Node> {
        self.pos += 1;
        let start = self.pos;
        let name = self.ident();
        self.mark(TokenKind::Code, start, self.pos);
        let name = Src::new(name, start);
        self.skip_ws();
        if self.peek() != Some(b'(') {
            return self.err(format!("expected ( after @cascade:{name}"));
        }
        let (s, e) = self.balanced(b'(', b')')?;
        self.mark(TokenKind::Code, s, e);
        let args = self.span(s + 1, e - 1);
        let (value, fixed) = match top_level_comma(&args) {
            Some(i) => {
                if args[i + 1..].trim() != "fixed" {
                    return Err(ParseError {
                        message: "the second @cascade argument must be fixed".into(),
                        offset: args.at + i + 1,
                    });
                }
                (self.span(args.at, args.at + i), true)
            }
            None => (args, false),
        };
        if value.is_empty() {
            return Err(ParseError { message: format!("expected a value in @cascade:{name}(...)"), offset: s });
        }
        let (save, tokens) = (self.pos, self.tokens.len());
        self.skip_ws();
        if self.peek() != Some(b'{') {
            self.pos = save;
            self.tokens.truncate(tokens);
            return self.err(format!("expected {{ after @cascade:{name}(...)"));
        }
        let body = self.block()?;
        Ok(Node::Cascade { name, value, fixed, body })
    }

    /// `@ClientRoutes(route) { ... }`: only sections may appear inside, which is what keeps their
    /// keywords (`notFound`, `catch`, `default`, route tags) from meaning anything elsewhere.
    fn routes_block(&mut self, engine: crate::routes::Engine, keyword: &str) -> PResult<Node> {
        self.skip_ws();
        if self.peek() != Some(b'(') {
            return self.err(format!("expected ( after @{keyword}"));
        }
        let (s, e) = self.balanced(b'(', b')')?;
        self.mark(TokenKind::Code, s, e);
        let var = self.span(s + 1, e - 1);
        if !crate::routes::is_ident(&var) {
            return Err(ParseError { message: format!("expected a name in @{keyword}(...)"), offset: s + 1 });
        }
        if DIRECTIVES.contains(&&*var.text) || matches!(&*var.text, "cascade" | "ClientRoutes" | "ServerRoutes") {
            return Err(ParseError { message: format!("{:?} can't name the route variable", &*var.text), offset: var.at });
        }
        if self.routes_seen {
            return Err(ParseError { message: "only one routes block per project (also in this file)".into(), offset: var.at });
        }
        self.routes_seen = true;
        self.skip_ws();
        if self.peek() != Some(b'{') {
            return self.err(format!("expected {{ after @{keyword}(...)"));
        }
        self.mark(TokenKind::Transition, self.pos, self.pos + 1);
        self.pos += 1;
        self.bound.push(var.text.clone());
        let mut sections: Vec<RouteSectionNode> = Vec::new();
        loop {
            self.skip_ws();
            match self.peek() {
                None => return self.err("unclosed '{' block"),
                Some(b'}') => {
                    self.mark(TokenKind::Transition, self.pos, self.pos + 1);
                    self.pos += 1;
                    self.bound.pop();
                    return Ok(Node::Routes { engine, var, sections });
                }
                Some(b'@') if self.peek_at(1) == Some(b'*') => {
                    self.transition()?;
                }
                Some(b'@') => {
                    if sections.last().is_some_and(|s| matches!(s.kind, RouteSectionKind::Default { .. })) {
                        return self.err("@default must be the last section");
                    }
                    sections.push(self.route_section(engine, keyword)?);
                }
                Some(_) => return self.err(format!("only route sections are allowed in @{keyword}")),
            }
        }
    }

    /// One `@<tag>(page)`, `@/re/(page?)`, `@"pattern"(page?)`, `@notFound`, `@catch(e)` or
    /// `@default(page)` section with its body. On entry `pos` is at the `@`.
    fn route_section(&mut self, engine: crate::routes::Engine, keyword: &str) -> PResult<RouteSectionNode> {
        let at = self.pos;
        self.pos += 1;
        self.mark(TokenKind::Transition, at, at + 1);
        let kind = match self.peek() {
            Some(b'/') => {
                let start = self.pos;
                self.regex_lit()?;
                self.mark(TokenKind::AttrValue, start, self.pos);
                if engine == crate::routes::Engine::Server {
                    return Err(ParseError { message: "Bun.serve routes don't support regex; use a pattern".into(), offset: start });
                }
                let re = self.span(start, self.pos);
                RouteSectionKind::Regex { re, page: self.optional_binding()? }
            }
            Some(b'"') => {
                let start = self.pos;
                self.string_lit()?;
                self.mark(TokenKind::AttrValue, start, self.pos);
                let pattern = self.span(start + 1, self.pos - 1);
                if let Err(reason) = crate::routes::validate_pattern(&pattern) {
                    return Err(ParseError { message: format!("invalid route pattern {:?}: {reason}", &*pattern), offset: pattern.at });
                }
                RouteSectionKind::Pattern { pattern, page: self.optional_binding()? }
            }
            Some(c) if is_ident_start(c) => {
                let start = self.pos;
                let word = self.ident();
                self.mark(TokenKind::Keyword, start, self.pos);
                match word {
                    "notFound" => {
                        if self.peek() == Some(b'(') {
                            return self.err("@notFound takes no (page)");
                        }
                        RouteSectionKind::NotFound
                    }
                    "catch" => RouteSectionKind::Catch { error: self.required_binding(word, "error")? },
                    "default" => RouteSectionKind::Default { page: self.required_binding(word, "page")? },
                    _ => RouteSectionKind::Tag { page: self.required_binding(word, "page")?, tag: Src::new(word, start) },
                }
            }
            _ => return self.err(format!("only route sections are allowed in @{keyword}")),
        };
        if let Some(name) = kind.binding() {
            self.bound.push(name.text.clone());
        }
        let body = self.block();
        if kind.binding().is_some() {
            self.bound.pop();
        }
        Ok(RouteSectionNode { kind, body: body? })
    }

    /// The `(name)` a section binds; the parser is on the `(`.
    fn binding(&mut self) -> PResult<Src> {
        let (s, e) = self.balanced(b'(', b')')?;
        self.mark(TokenKind::Code, s, e);
        let name = self.span(s + 1, e - 1);
        if !crate::routes::is_ident(&name) {
            return Err(ParseError { message: "expected a name in (...)".into(), offset: s + 1 });
        }
        Ok(name)
    }

    fn optional_binding(&mut self) -> PResult<Option<Src>> {
        match self.peek() {
            Some(b'(') => self.binding().map(Some),
            _ => Ok(None),
        }
    }

    fn required_binding(&mut self, keyword: &str, what: &str) -> PResult<Src> {
        if self.peek() != Some(b'(') {
            return self.err(format!("expected ({what}) after @{keyword}"));
        }
        self.binding()
    }

    /// Consumes a `/…/flags` regex literal; the parser is on the `/`.
    fn regex_lit(&mut self) -> PResult<()> {
        let start = self.pos;
        self.pos += 1;
        let mut class = false;
        loop {
            match self.peek() {
                None | Some(b'\n') => return Err(ParseError { message: "unterminated regex".into(), offset: start }),
                Some(b'\\') => self.pos = (self.pos + 2).min(self.b.len()),
                Some(b'[') => {
                    class = true;
                    self.pos += 1;
                }
                Some(b']') => {
                    class = false;
                    self.pos += 1;
                }
                Some(b'/') if !class => {
                    self.pos += 1;
                    break;
                }
                Some(_) => self.pos += 1,
            }
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.pos += 1;
        }
        Ok(())
    }

    /// After `@slot`: `:name` defines a named slot; inside a component tag, ` name` fills one.
    fn slot(&mut self) -> PResult<Node> {
        if self.peek() == Some(b':') {
            self.pos += 1;
            let start = self.pos;
            let name = self.ident();
            if name.is_empty() {
                return self.err("expected a slot name after @slot:");
            }
            self.mark(TokenKind::Code, start, self.pos);
            return self.slot_definition(Some(Src::new(name, start)));
        }
        if self.in_component {
            return self.slot_fill();
        }
        self.slot_definition(None)
    }

    fn slot_definition(&mut self, name: Option<Src>) -> PResult<Node> {
        let args = if self.peek() == Some(b'(') { Some(self.slot_args()?) } else { None };
        let (save, tokens) = (self.pos, self.tokens.len());
        self.skip_ws();
        let fallback = if self.peek() == Some(b'{') {
            Some(trim_edges(self.block()?))
        } else {
            self.pos = save;
            self.tokens.truncate(tokens);
            None
        };
        Ok(Node::Slot(Slot { name, args, fallback }))
    }

    /// Slot arguments: TypeScript expressions or markup, separated by commas.
    fn slot_args(&mut self) -> PResult<Vec<SlotArg>> {
        let open = self.pos;
        self.pos += 1;
        let mut args = Vec::new();
        let unclosed = || ParseError { message: "unclosed '(' in slot arguments".into(), offset: open };
        loop {
            self.skip_ws();
            match self.peek() {
                None => return Err(unclosed()),
                Some(b')') => {
                    self.pos += 1;
                    return Ok(args);
                }
                Some(b'<') if matches!(self.peek_at(1), Some(c) if c.is_ascii_alphabetic()) => {
                    args.push(SlotArg::Markup(self.element()?));
                }
                _ => {
                    let start = self.pos;
                    let mut depth = 0usize;
                    loop {
                        match self.peek() {
                            None => return Err(unclosed()),
                            Some(b'"' | b'\'') => self.string_lit()?,
                            Some(b'`') => self.template_lit()?,
                            Some(b'(' | b'[' | b'{') => {
                                depth += 1;
                                self.pos += 1;
                            }
                            Some(b')' | b']' | b'}') if depth > 0 => {
                                depth -= 1;
                                self.pos += 1;
                            }
                            Some(b',' | b')') => break,
                            Some(_) => self.pos += 1,
                        }
                    }
                    self.mark(TokenKind::Code, start, self.pos);
                    let arg = self.span(start, self.pos);
                    if arg.is_empty() {
                        return self.err("expected a slot argument");
                    }
                    args.push(SlotArg::Expr(arg));
                }
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b')') => {}
                _ => return self.err("expected ',' or ')' in slot arguments"),
            }
        }
    }

    /// `@slot name(params) { body }` inside a component tag; name and params are optional.
    fn slot_fill(&mut self) -> PResult<Node> {
        let at = self.pos;
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.pos += 1;
        }
        let name = match self.peek() {
            Some(c) if is_ident_start(c) => {
                let start = self.pos;
                let name = self.ident();
                self.mark(TokenKind::Code, start, self.pos);
                Some(Src::new(name, start))
            }
            _ => None,
        };
        let params = if self.peek() == Some(b'(') {
            let (s, e) = self.balanced(b'(', b')')?;
            self.mark(TokenKind::Code, s, e);
            Some(self.span(s + 1, e - 1))
        } else {
            None
        };
        self.skip_ws();
        if self.peek() != Some(b'{') {
            return self.err("expected '{' with the slot content");
        }
        let body = trim_edges(self.block()?);
        if body.is_empty() {
            return Err(ParseError { message: "slot body is empty".into(), offset: at });
        }
        Ok(Node::SlotFill(SlotFill { name, params, body }))
    }

    /// Skips a TypeScript region delimited by `open`/`close`, honouring strings,
    /// template literals and comments. Returns `(start, end)` including delimiters.
    fn balanced(&mut self, open: u8, close: u8) -> PResult<(usize, usize)> {
        let start = self.pos;
        let mut depth = 0usize;
        while let Some(c) = self.peek() {
            match c {
                b'"' | b'\'' => self.string_lit()?,
                b'`' => self.template_lit()?,
                b'/' if self.peek_at(1) == Some(b'/') => self.skip_line(),
                b'/' if self.peek_at(1) == Some(b'*') => self.block_comment()?,
                _ => {
                    self.pos += 1;
                    if c == open {
                        depth += 1;
                    } else if c == close {
                        depth -= 1;
                        if depth == 0 {
                            return Ok((start, self.pos));
                        }
                    }
                }
            }
        }
        Err(ParseError {
            message: format!("unclosed '{}'", open as char),
            offset: start,
        })
    }

    fn string_lit(&mut self) -> PResult<()> {
        let start = self.pos;
        let quote = self.b[self.pos];
        self.pos += 1;
        while let Some(c) = self.peek() {
            self.pos += 1;
            if c == b'\\' {
                self.pos += 1;
            } else if c == quote {
                return Ok(());
            } else if c == b'\n' {
                break;
            }
        }
        Err(ParseError {
            message: "unterminated string literal".into(),
            offset: start,
        })
    }

    fn template_lit(&mut self) -> PResult<()> {
        let start = self.pos;
        self.pos += 1;
        while let Some(c) = self.peek() {
            match c {
                b'\\' => self.pos += 2,
                b'`' => {
                    self.pos += 1;
                    return Ok(());
                }
                b'$' if self.peek_at(1) == Some(b'{') => {
                    self.pos += 1;
                    self.balanced(b'{', b'}')?;
                }
                _ => self.pos += 1,
            }
        }
        Err(ParseError {
            message: "unterminated template literal".into(),
            offset: start,
        })
    }

    fn block_comment(&mut self) -> PResult<()> {
        let start = self.pos;
        match self.src[self.pos + 2..].find("*/") {
            Some(i) => {
                self.pos += 2 + i + 2;
                Ok(())
            }
            None => Err(ParseError {
                message: "unterminated comment".into(),
                offset: start,
            }),
        }
    }

    fn html_comment(&mut self) -> PResult<()> {
        let start = self.pos;
        match self.src[self.pos + 4..].find("-->") {
            Some(i) => {
                self.pos += 4 + i + 3;
                self.mark(TokenKind::Comment, start, self.pos);
                Ok(())
            }
            None => self.err("unterminated <!-- comment"),
        }
    }

    fn tag_name(&mut self) -> &'a str {
        let src = self.src;
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == b'-' || c == b':')
        {
            self.pos += 1;
        }
        &src[start..self.pos]
    }

    fn element(&mut self) -> PResult<Element> {
        let start = self.pos;
        self.pos += 1;
        let name = Src::new(self.tag_name(), start + 1);
        self.mark(TokenKind::TagDelim, start, start + 1);
        self.mark(tag_kind(&name), start + 1, self.pos);

        let mut attrs = Vec::new();
        let self_closing = loop {
            self.skip_ws();
            match self.peek() {
                None => {
                    return Err(ParseError {
                        message: format!("unclosed tag <{name}>"),
                        offset: start,
                    });
                }
                Some(b'>') => {
                    self.mark(TokenKind::TagDelim, self.pos, self.pos + 1);
                    self.pos += 1;
                    break false;
                }
                Some(b'/') if self.peek_at(1) == Some(b'>') => {
                    self.mark(TokenKind::TagDelim, self.pos, self.pos + 2);
                    self.pos += 2;
                    break true;
                }
                _ => attrs.push(self.attribute()?),
            }
        };

        let element = Element {
            name,
            attrs,
            children: Vec::new(),
        };
        let is_void = !element.is_component()
            && VOID_ELEMENTS.contains(&element.name.to_ascii_lowercase().as_str());
        if self_closing || is_void {
            return Ok(element);
        }
        let children = {
            let saved = std::mem::replace(&mut self.in_component, element.is_component());
            let children = self.nodes(Until::EndTag(&element.name));
            self.in_component = saved;
            children?
        };
        Ok(Element {
            children,
            ..element
        })
    }

    fn attribute(&mut self) -> PResult<Attr> {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if !c.is_ascii_whitespace() && !matches!(c, b'=' | b'>' | b'/' | b'"' | b'\''))
        {
            self.pos += 1;
        }
        if self.pos == start {
            return self.err("expected attribute name");
        }
        let name = Src::new(&self.src[start..self.pos], start);
        self.mark(TokenKind::AttrName, start, self.pos);

        let save = self.pos;
        self.skip_ws();
        if self.peek() != Some(b'=') {
            self.pos = save;
            return Ok(Attr {
                name,
                value: AttrValue::Empty,
            });
        }
        self.pos += 1;
        self.skip_ws();
        let value = if name.starts_with('@') {
            self.expr_value()?
        } else {
            self.attr_value()?
        };
        Ok(Attr { name, value })
    }

    /// Attribute whose whole value is TypeScript, e.g. `@onclick="() => count++"`.
    fn expr_value(&mut self) -> PResult<AttrValue> {
        match self.peek() {
            Some(q @ (b'"' | b'\'')) => {
                let start = self.pos;
                let Some(len) = self.src[start + 1..].find(q as char) else {
                    return self.err("unterminated attribute value");
                };
                self.pos = start + 1 + len + 1;
                self.mark(TokenKind::Code, start, self.pos);
                Ok(AttrValue::Expr(self.span(start + 1, self.pos - 1)))
            }
            _ => {
                let start = self.pos;
                while matches!(self.peek(), Some(c) if !c.is_ascii_whitespace() && c != b'>') {
                    self.pos += 1;
                }
                self.mark(TokenKind::Code, start, self.pos);
                Ok(AttrValue::Expr(self.span(start, self.pos)))
            }
        }
    }

    /// Attribute value that may interpolate `@expr`, e.g. `class="btn @kind"`.
    fn attr_value(&mut self) -> PResult<AttrValue> {
        let quote = match self.peek() {
            Some(q @ (b'"' | b'\'')) => q,
            Some(b'@') => {
                return match self.transition()? {
                    Transition::Node(Node::Expr(e)) => Ok(AttrValue::Expr(e)),
                    _ => self.err("expected an expression after '@'"),
                };
            }
            _ => {
                let start = self.pos;
                while matches!(self.peek(), Some(c) if !c.is_ascii_whitespace() && c != b'>') {
                    self.pos += 1;
                }
                self.mark(TokenKind::AttrValue, start, self.pos);
                return Ok(AttrValue::Static(Src::new(&self.src[start..self.pos], start)));
            }
        };

        let open = self.pos;
        self.pos += 1;
        let mut parts = Vec::new();
        let mut text = String::new();
        let mut text_start = open;
        loop {
            match self.peek() {
                None => {
                    return Err(ParseError {
                        message: "unterminated attribute value".into(),
                        offset: open,
                    });
                }
                Some(c) if c == quote => {
                    self.pos += 1;
                    self.mark(TokenKind::AttrValue, text_start, self.pos);
                    break;
                }
                Some(b'@') if !self.prev_is_alnum() => {
                    self.mark(TokenKind::AttrValue, text_start, self.pos);
                    match self.transition()? {
                        Transition::Node(Node::Expr(e)) => {
                            if !text.is_empty() {
                                parts.push(Part::Text(std::mem::take(&mut text)));
                            }
                            parts.push(Part::Expr(e));
                        }
                        Transition::Text(t) => text.push_str(t),
                        _ => return self.err("only expressions are allowed in attribute values"),
                    }
                    text_start = self.pos;
                }
                Some(_) => {
                    let ch = self.next_char();
                    text.push(ch);
                }
            }
        }
        if !text.is_empty() {
            parts.push(Part::Text(text));
        }
        Ok(match parts.as_slice() {
            [] => AttrValue::Static(Src::new("", open + 1)),
            [Part::Text(t)] => {
                let raw = &self.src[open + 1..self.pos - 1];
                AttrValue::Static(Src::new(t.clone(), if raw == t { open + 1 } else { Src::UNMAPPED }))
            }
            [Part::Expr(e)] => AttrValue::Expr(e.clone()),
            _ => AttrValue::Interp(parts),
        })
    }
}

/// Offset of the comma separating `@cascade` arguments: outside brackets, strings and comments.
fn top_level_comma(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let (mut i, mut depth, mut prev) = (0usize, 0i32, None);
    while i < b.len() {
        if let Some(end) = skip_literal(b, i, prev) {
            if !is_comment(b, i) {
                prev = Some(b'"');
            }
            i = end;
            continue;
        }
        if is_ident_start(b[i]) && (i == 0 || !is_ident_char(b[i - 1])) {
            let start = i;
            while i < b.len() && is_ident_char(b[i]) {
                i += 1;
            }
            prev = Some(word_prev(&text[start..i], prev));
            continue;
        }
        match b[i] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => return Some(i),
            _ => {}
        }
        if !b[i].is_ascii_whitespace() {
            prev = Some(b[i]);
        }
        i += 1;
    }
    None
}

fn tag_kind(name: &str) -> TokenKind {
    if name.starts_with(|c: char| c.is_ascii_uppercase()) {
        TokenKind::ComponentName
    } else {
        TokenKind::TagName
    }
}

/// Removes whitespace-only text at both ends of a slot body.
fn trim_edges(mut nodes: Vec<Node>) -> Vec<Node> {
    let blank = |n: &Node| matches!(n, Node::Text(t) if t.trim().is_empty());
    while nodes.last().is_some_and(blank) {
        nodes.pop();
    }
    let lead = nodes.iter().take_while(|n| blank(n)).count();
    nodes.drain(..lead);
    nodes
}

/// Drops whitespace-only runs that span lines (formatting) and collapses the rest.
fn flush_text(nodes: &mut Vec<Node>, text: &mut String) {
    let keep = !text.trim().is_empty() || (!text.is_empty() && !text.contains('\n'));
    if keep {
        let mut out = String::with_capacity(text.len());
        let mut in_ws = false;
        for ch in text.chars() {
            if ch.is_whitespace() {
                if !in_ws {
                    out.push(' ');
                }
                in_ws = true;
            } else {
                out.push(ch);
                in_ws = false;
            }
        }
        nodes.push(Node::Text(out));
    }
    text.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(src: &str) -> Vec<Node> {
        parse(src).expect("parse").0.nodes
    }

    fn el(name: &str, attrs: Vec<Attr>, children: Vec<Node>) -> Node {
        Node::Element(Element {
            name: name.into(),
            attrs,
            children,
        })
    }

    #[test]
    fn implicit_expression_stops_at_text() {
        assert_eq!(
            nodes("<p>@user.name: @count.</p>"),
            vec![el(
                "p",
                vec![],
                vec![
                    Node::Expr("user.name".into()),
                    Node::Text(": ".into()),
                    Node::Expr("count".into()),
                    Node::Text(".".into()),
                ]
            )]
        );
    }

    #[test]
    fn explicit_expression_and_escapes() {
        assert_eq!(
            nodes("a@b.com @@ @(1 + (2))"),
            vec![
                Node::Text("a@b.com @ ".into()),
                Node::Expr("1 + (2)".into())
            ]
        );
    }

    #[test]
    fn code_page_and_import() {
        let src = "@page \"/x\"\n@import A from \"./A.xzor\";\n@code {\n  n = \"}\";\n}\n";
        let doc = parse(src).unwrap().0;
        assert_eq!(doc.pages[0].pattern, "/x");
        assert_eq!(doc.imports, vec!["A from \"./A.xzor\""]);
        assert_eq!(doc.code, vec!["\n  n = \"}\";\n"]);
        assert!(doc.nodes.is_empty());
    }

    #[test]
    fn if_else_chain_and_for() {
        let src = "@if (a > 1) {<b>x</b>} else if (b) { y } else { z }\n@for (const i of xs) {<i>@i</i>}";
        let n = nodes(src);
        assert_eq!(
            n[0],
            Node::If {
                branches: vec![
                    ("a > 1".into(), vec![el("b", vec![], vec![Node::Text("x".into())])]),
                    ("b".into(), vec![Node::Text(" y ".into())]),
                ],
                otherwise: Some(vec![Node::Text(" z ".into())]),
            }
        );
        assert_eq!(
            n[1],
            Node::For {
                head: "const i of xs".into(),
                body: vec![el("i", vec![], vec![Node::Expr("i".into())])],
            }
        );
    }

    #[test]
    fn switch_cases() {
        let src = r#"@switch (kind) {
  case "a":
  case "b":
    <p>ab</p>
    break;
  case "c": break;
  default:
    in case of @kind
}
after"#;
        assert_eq!(
            nodes(src),
            vec![
                Node::Switch {
                    subject: "kind".into(),
                    cases: vec![
                        Case {
                            labels: vec![Some("\"a\"".into()), Some("\"b\"".into())],
                            body: vec![el("p", vec![], vec![Node::Text("ab".into())])],
                        },
                        Case { labels: vec![Some("\"c\"".into())], body: vec![] },
                        Case {
                            labels: vec![None],
                            body: vec![Node::Text(" in case of ".into()), Node::Expr("kind".into())],
                        },
                    ],
                },
                Node::Text(" after".into()),
            ]
        );
        assert!(parse("@switch (x) { <p>no label</p> }").is_err());
    }

    #[test]
    fn spans_point_at_source_text() {
        let src = "@import A from \"./A.xzor\"\n@code {\n  n = 1;\n}\n<A x=\"@( n + 1 )\" @onclick=\" go \">@user.name @if ( n > 1 ) {}</A>";
        let (doc, _) = parse(src).unwrap();
        let check = |s: &Src| assert_eq!(&src[s.at..s.at + s.len()], &**s, "{s:?}");
        check(&doc.imports[0]);
        check(&doc.code[0]);
        let Node::Element(el) = &doc.nodes[0] else { panic!() };
        check(&el.name);
        for a in &el.attrs {
            check(&a.name);
            if let AttrValue::Expr(e) = &a.value {
                check(e);
            }
        }
        assert_eq!(&*doc.imports[0], "A from \"./A.xzor\"");
        let Node::Expr(e) = &el.children[0] else { panic!() };
        check(e);
        let Node::If { branches, .. } = &el.children[2] else { panic!("{:?}", el.children) };
        check(&branches[0].0);
        assert_eq!(&*branches[0].0, "n > 1");
    }

    #[test]
    fn markup_values_in_code_blocks() {
        let src = "@code {\n  a = <B x=\"@this.y\" />;\n  f(t: number) { return t < 1 ? @<C /> : <D>@t</D>; }\n  g = <T,>(v: T) => v;\n}";
        let (doc, _) = parse(src).unwrap();
        let parts = &doc.code_parts[0];
        let kinds: Vec<String> = parts
            .iter()
            .map(|p| match p {
                CodePart::Ts(s) => {
                    assert_eq!(&src[s.at..s.at + s.len()], &**s);
                    "ts".to_string()
                }
                CodePart::Markup(e) => e.name.to_string(),
                CodePart::Render(_) => "render".to_string(),
            })
            .collect();
        assert_eq!(kinds, ["ts", "B", "ts", "C", "ts", "D", "ts"]);
        let CodePart::Ts(last) = parts.last().unwrap() else { panic!() };
        assert!(last.contains("g = <T,>(v: T) => v;"));
        let CodePart::Ts(mid) = &parts[2] else { panic!() };
        assert!(mid.contains("return t < 1 ? "));
        assert_eq!(&*doc.code[0], &src["@code {".len()..src.len() - 1]);
    }

    #[test]
    fn slot_definitions_and_fills() {
        let src = "@slot\n@slot:head\n@slot:row(item, <b/>) { <i>@item</i> }\n@slot(1) { d }\n<Card>\n  @slot head { <h1/> }\n  @slot row(item: string = \"\", i) { @item }\n  <p/>\n</Card>";
        let (doc, _) = parse(src).unwrap();
        let slots: Vec<&Slot> = doc.nodes.iter().filter_map(|n| match n { Node::Slot(s) => Some(s), _ => None }).collect();
        assert_eq!(slots.len(), 4);
        assert_eq!((slots[0].name.is_none(), slots[0].args.is_none(), slots[0].fallback.is_none()), (true, true, true));
        assert_eq!(slots[1].name.as_deref(), Some("head"));
        let args = slots[2].args.as_ref().unwrap();
        assert!(matches!(&args[0], SlotArg::Expr(e) if &**e == "item" && &src[e.at..e.at + 4] == "item"));
        assert!(matches!(&args[1], SlotArg::Markup(e) if &*e.name == "b"));
        assert_eq!(slots[2].fallback.as_ref().map(Vec::len), Some(1));
        assert!(slots[3].name.is_none() && slots[3].fallback.is_some());

        let Some(Node::Element(card)) = doc.nodes.last() else { panic!() };
        let fills: Vec<&SlotFill> = card.children.iter().filter_map(|n| match n { Node::SlotFill(f) => Some(f), _ => None }).collect();
        assert_eq!(fills.len(), 2);
        assert_eq!(fills[0].name.as_deref(), Some("head"));
        assert!(fills[0].params.is_none());
        let params = fills[1].params.as_ref().unwrap();
        assert_eq!(&**params, "item: string = \"\", i");
        assert_eq!(&src[params.at..params.at + params.len()], &**params);
        assert!(card.children.iter().any(|n| matches!(n, Node::Element(e) if &*e.name == "p")));

        assert!(parse("<Card>@slot a { }</Card>").unwrap_err().message.contains("slot body is empty"));
        assert!(parse("<div>@slot a { x }</div>").is_ok(), "outside a component, `@slot a` is a default slot followed by text");
    }

    #[test]
    fn attributes() {
        let n = nodes(r#"<input disabled value="@v" class="btn @kind" @onclick="() => go('x')" title=plain>"#);
        let Node::Element(e) = &n[0] else { panic!() };
        assert_eq!(
            e.attrs,
            vec![
                Attr { name: "disabled".into(), value: AttrValue::Empty },
                Attr { name: "value".into(), value: AttrValue::Expr("v".into()) },
                Attr {
                    name: "class".into(),
                    value: AttrValue::Interp(vec![Part::Text("btn ".into()), Part::Expr("kind".into())]),
                },
                Attr { name: "@onclick".into(), value: AttrValue::Expr("() => go('x')".into()) },
                Attr { name: "title".into(), value: AttrValue::Static("plain".into()) },
            ]
        );
        assert!(e.children.is_empty());
    }

    #[test]
    fn components_and_self_closing() {
        let n = nodes(r#"<Counter step="@(2)" /><br>"#);
        assert_eq!(
            n,
            vec![
                el("Counter", vec![Attr { name: "step".into(), value: AttrValue::Expr("2".into()) }], vec![]),
                el("br", vec![], vec![]),
            ]
        );
    }

    #[test]
    fn inject_directive() {
        let src = "@inject IDatabase db\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!(doc.injects.len(), 1);
        assert_eq!((&*doc.injects[0].ty, doc.injects[0].ty.at), ("IDatabase", 8));
        assert_eq!((&*doc.injects[0].name, doc.injects[0].name.at), ("db", 18));
        assert!(tokens.contains(&Token { kind: TokenKind::Keyword, start: 1, end: 7 }));
        assert!(tokens.contains(&Token { kind: TokenKind::Code, start: 7, end: 20 }));
    }

    #[test]
    fn inject_generic_type() {
        let (doc, _) = parse("@inject Promise<Map<string, number>> cache").unwrap();
        assert_eq!(&*doc.injects[0].ty, "Promise<Map<string, number>>");
        assert_eq!(&*doc.injects[0].name, "cache");
    }

    #[test]
    fn inject_needs_type_and_name() {
        assert_eq!(parse("@inject db").unwrap_err().message, "expected a type and a name after @inject");
        assert_eq!(parse("@inject").unwrap_err().message, "expected a type and a name after @inject");
    }

    fn comments(tokens: &[Token]) -> Vec<(usize, usize)> {
        tokens.iter().filter(|t| t.kind == TokenKind::Comment).map(|t| (t.start, t.end)).collect()
    }

    #[test]
    fn directive_line_comment() {
        let src = "@inject IDatabase db // the store\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!((&*doc.injects[0].ty, &*doc.injects[0].name), ("IDatabase", "db"));
        assert_eq!(comments(&tokens), vec![(21, 33)]);
        assert!(tokens.contains(&Token { kind: TokenKind::Code, start: 7, end: 20 }));
    }

    #[test]
    fn directive_razor_comment() {
        let src = "@inherits Base<T> @* why *@\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!(&*doc.inherits.unwrap(), "Base<T>");
        assert_eq!(comments(&tokens), vec![(18, 27)]);
    }

    #[test]
    fn directive_razor_comment_multiline() {
        let (doc, tokens) = parse("@typeparam T @* a\nb *@\n<p/>").unwrap();
        assert_eq!(&*doc.type_params[0], "T");
        assert_eq!(comments(&tokens).len(), 1);
        assert_eq!(doc.nodes.len(), 1);
    }

    #[test]
    fn import_comment_ignores_strings() {
        let src = "@import x from \"http://a\" // c\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!(&*doc.imports[0], "x from \"http://a\"");
        assert_eq!(comments(&tokens), vec![(26, 30)]);
    }

    #[test]
    fn page_comment() {
        let src = "@page \"/a\" // home\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!(doc.pages[0].pattern, "/a");
        assert_eq!(comments(&tokens), vec![(11, 18)]);
        let (doc, tokens) = parse("@page \"/a\" @* home *@").unwrap();
        assert_eq!(doc.pages[0].pattern, "/a");
        assert_eq!(comments(&tokens).len(), 1);
    }

    #[test]
    fn parses_several_pages_with_tags() {
        let src = "@page \"/users/:id\" as user\n@page \"/a/*\" // c\n<p/>";
        let (doc, tokens) = parse(src).unwrap();
        assert_eq!(doc.pages.len(), 2);
        assert_eq!(doc.pages[0].pattern, "/users/:id");
        assert_eq!(doc.pages[0].pattern.at, 7);
        assert_eq!(doc.pages[0].tag.as_ref().map(|t| (&*t.text, t.at)), Some(("user", 22)));
        assert_eq!(doc.pages[1].pattern, "/a/*");
        assert_eq!(doc.pages[1].tag, None);
        assert_eq!(comments(&tokens), vec![(40, 44)]);

        let doc = parse("@page \"/a\"\n@page \"/b\"\n<p/>").unwrap().0;
        assert_eq!(doc.pages.len(), 2);
        let e = parse("@page \"users\"\n<p/>").unwrap_err();
        assert_eq!(e.message, "invalid route pattern \"users\": must start with '/'");
        assert_eq!(e.offset, 7);
        let e = parse("@page \"/a/*/b\"\n<p/>").unwrap_err();
        assert_eq!(e.message, "invalid route pattern \"/a/*/b\": '*' must be the last segment");
        let e = parse("@page \"/:1x\"\n<p/>").unwrap_err();
        assert_eq!(e.message, "invalid route pattern \"/:1x\": invalid parameter name \"1x\"");
        let e = parse("@page \"/:a/:a\"\n<p/>").unwrap_err();
        assert_eq!(e.message, "invalid route pattern \"/:a/:a\": duplicate param \"a\"");
    }

    #[test]
    fn page_rejects_junk_after_the_route() {
        for src in ["@page \"/x\" as t as u\n<p/>", "@page \"/x\"as t\n<p/>", "@page \"/x\" junk\n<p/>"] {
            let e = parse(src).unwrap_err();
            assert_eq!(e.message, "expected \"as <tag>\" or end of line after the @page route", "{src}");
        }
        assert!(parse("@page \"/x\" as t // c\n<p/>").is_ok());
        assert!(parse("@page \"/x\"").is_ok());
    }

    #[test]
    fn parses_cascade_blocks() {
        assert_eq!(
            nodes("@cascade:theme(currentTheme) { <A/> }"),
            vec![Node::Cascade {
                name: "theme".into(),
                value: "currentTheme".into(),
                fixed: false,
                body: vec![el("A", vec![], vec![])],
            }]
        );
        assert_eq!(
            nodes("@cascade:cfg(f(a, b), fixed) { <A/> }"),
            vec![Node::Cascade {
                name: "cfg".into(),
                value: "f(a, b)".into(),
                fixed: true,
                body: vec![el("A", vec![], vec![])],
            }]
        );
        let Node::Cascade { value, .. } = &nodes("@cascade:x(a ? b : c) { <A/> }")[0] else { panic!() };
        assert_eq!(value, &Src::from("a ? b : c"));
        let Node::Cascade { value, fixed, .. } = &nodes("@cascade:x(a ? b : c, fixed) { <A/> }")[0] else { panic!() };
        assert_eq!((value, *fixed), (&Src::from("a ? b : c"), true));
        let Node::Cascade { value, fixed, .. } = &nodes("@cascade:x({ a, b }, fixed) { <A/> }")[0] else { panic!() };
        assert_eq!((value, *fixed), (&Src::from("{ a, b }"), true));
        let Node::Cascade { value, fixed, .. } = &nodes("@cascade:x(\"a, b\" + `${f(1, 2)}`) { <A/> }")[0] else { panic!() };
        assert_eq!((value, *fixed), (&Src::from("\"a, b\" + `${f(1, 2)}`"), false));
        let src = "@cascade:x(theme) { <A/> }";
        let Node::Cascade { name, value, .. } = &nodes(src)[0] else { panic!() };
        assert_eq!(&src[name.at..name.at + name.len()], "x");
        assert_eq!(&src[value.at..value.at + value.len()], "theme");

        let Node::Cascade { name, value, .. } = &nodes("@cascade:x (v) { <A/> }")[0] else { panic!() };
        assert_eq!((name, value), (&Src::from("x"), &Src::from("v")));

        let err = |src: &str| parse(src).unwrap_err().message;
        assert_eq!(err("@cascade:x(a, b) {}"), "the second @cascade argument must be fixed");
        assert_eq!(err("@cascade:x(a)"), "expected { after @cascade:x(...)");
    }

    #[test]
    fn cascade_is_a_keyword_only_before_a_colon() {
        assert_eq!(nodes("<p>@cascade</p>"), vec![el("p", vec![], vec![Node::Expr("cascade".into())])]);
        assert_eq!(nodes("<p>@cascade.name</p>"), vec![el("p", vec![], vec![Node::Expr("cascade.name".into())])]);
        assert_eq!(nodes("@cascade(x)"), vec![Node::Expr("cascade(x)".into())]);
        // A colon with no name after it stays a member reference followed by text.
        assert_eq!(
            nodes("<p>@cascade: on</p>"),
            vec![el("p", vec![], vec![Node::Expr("cascade".into()), Node::Text(": on".into())])]
        );
        assert_eq!(nodes("<p>@cascade:</p>"), vec![el("p", vec![], vec![Node::Expr("cascade".into()), Node::Text(":".into())])]);
        let (_, tokens) = parse("<p>@cascade</p>").unwrap();
        assert!(!tokens.iter().any(|t| t.kind == TokenKind::Keyword), "{tokens:?}");
        let (_, tokens) = parse("@cascade:x(v) { <A/> }").unwrap();
        assert!(tokens.iter().any(|t| t.kind == TokenKind::Keyword), "{tokens:?}");
    }

    #[test]
    fn errors_report_offsets() {
        let e = parse("<div><p></div>").unwrap_err();
        assert_eq!(e.message, "unexpected closing tag </div>");
        assert_eq!(e.offset, 8);
        assert!(parse("@if (x) { <p>").is_err());
    }

    /// The routes block of the design spec, §4.
    const ROUTES_BLOCK: &str = concat!(
        "@ClientRoutes(route)\n{\n",
        "  @admin(page) { <AdminLayout>@page</AdminLayout> }\n",
        "  @/^\\/admin\\/(?<area>\\w+)/i(page) { <AdminLayout area=\"@route.match.area\">@page</AdminLayout> }\n",
        "  @\"/legal/:doc\" { <LegalText doc=\"@route.params.doc\" /> }\n",
        "  @notFound { <p>Not found</p> }\n",
        "  @catch(e) { <ErrorPanel error=\"@e\" /> }\n",
        "  @default(page) { <MainLayout>@page</MainLayout> }\n",
        "}\n",
    );

    #[test]
    fn parses_every_routes_section() {
        let n = nodes(ROUTES_BLOCK);
        let [Node::Routes { engine, var, sections }] = n.as_slice() else { panic!("{n:?}") };
        assert_eq!(*engine, crate::routes::Engine::Client);
        assert_eq!(var, &Src::from("route"));
        assert_eq!(&ROUTES_BLOCK[var.at..var.at + var.len()], "route");
        let kinds: Vec<&RouteSectionKind> = sections.iter().map(|s| &s.kind).collect();
        assert!(
            matches!(
                kinds.as_slice(),
                [
                    RouteSectionKind::Tag { .. },
                    RouteSectionKind::Regex { page: Some(_), .. },
                    RouteSectionKind::Pattern { page: None, .. },
                    RouteSectionKind::NotFound,
                    RouteSectionKind::Catch { .. },
                    RouteSectionKind::Default { .. },
                ]
            ),
            "{kinds:?}"
        );
        let RouteSectionKind::Tag { tag, page } = &sections[0].kind else { panic!() };
        assert_eq!((tag, page), (&Src::from("admin"), &Src::from("page")));
        assert_eq!(&ROUTES_BLOCK[tag.at..tag.at + tag.len()], "admin");
        let RouteSectionKind::Regex { re, .. } = &sections[1].kind else { panic!() };
        assert_eq!(re, &Src::from("/^\\/admin\\/(?<area>\\w+)/i"));
        assert_eq!(&ROUTES_BLOCK[re.at..re.at + re.len()], &*re.text);
        let RouteSectionKind::Pattern { pattern, .. } = &sections[2].kind else { panic!() };
        assert_eq!(pattern, &Src::from("/legal/:doc"));
        let RouteSectionKind::Catch { error } = &sections[4].kind else { panic!() };
        assert_eq!(error, &Src::from("e"));
        assert_eq!(sections[3].body, vec![el("p", vec![], vec![Node::Text("Not found".into())])]);
    }

    #[test]
    fn server_routes_block_rejects_regex_sections() {
        let parsed = nodes("@ServerRoutes(r) { @\"/a\" { <p/> } }");
        let [Node::Routes { engine, .. }] = parsed.as_slice() else { panic!("{parsed:?}") };
        assert_eq!(*engine, crate::routes::Engine::Server);
        let e = parse("@ServerRoutes(r) { @/x/(page) { <p/> } }").unwrap_err();
        assert_eq!(e.message, "Bun.serve routes don't support regex; use a pattern");
    }

    #[test]
    fn routes_block_errors() {
        let err = |src: &str| parse(src).unwrap_err().message;
        assert_eq!(err("@ClientRoutes(route) { <p>x</p> }"), "only route sections are allowed in @ClientRoutes");
        assert_eq!(err("@ServerRoutes(route) { hello }"), "only route sections are allowed in @ServerRoutes");
        assert_eq!(err("@ClientRoutes(route) { @default(page) {} @notFound {} }"), "@default must be the last section");
        assert_eq!(err("@ClientRoutes(route) { @admin { <p/> } }"), "expected (page) after @admin");
        assert_eq!(err("@ClientRoutes(route) { @default { <p/> } }"), "expected (page) after @default");
        assert_eq!(err("@ClientRoutes(route) { @catch { <p/> } }"), "expected (error) after @catch");
        assert_eq!(err("@ClientRoutes(route) { @notFound(page) { <p/> } }"), "@notFound takes no (page)");
        assert_eq!(err("@ClientRoutes(route) { @admin(1) { <p/> } }"), "expected a name in (...)");
        assert_eq!(err("@ClientRoutes(route) { @\"a\" { <p/> } }"), "invalid route pattern \"a\": must start with '/'");
        assert_eq!(err("@ClientRoutes() { }"), "expected a name in @ClientRoutes(...)");
        assert_eq!(err("@ClientRoutes(route)"), "expected { after @ClientRoutes(...)");
    }

    #[test]
    fn a_second_routes_block_in_one_document_is_an_error() {
        let src = "@ClientRoutes(r) { @notFound { <p/> } }\n<div>@ServerRoutes(s) { @notFound { <p/> } }</div>";
        let e = parse(src).unwrap_err();
        assert_eq!(e.message, "only one routes block per project (also in this file)");
        assert_eq!(e.offset, src.find("(s)").unwrap() + 1);
    }

    #[test]
    fn comments_are_allowed_between_sections_and_after_default() {
        let src = "@ClientRoutes(route) {\n @* one *@\n @a(page) { <p/> }\n @* two *@\n @default(page) { <p/> }\n @* after *@\n}";
        let (doc, tokens) = parse(src).unwrap();
        let [Node::Routes { sections, .. }] = doc.nodes.as_slice() else { panic!("{:?}", doc.nodes) };
        assert_eq!(sections.len(), 2);
        assert_eq!(tokens.iter().filter(|t| t.kind == TokenKind::Comment).count(), 3, "{tokens:?}");
        let e = parse("@ClientRoutes(route) { @default(page) { <p/> } @* c *@ @a(page) { <p/> } }").unwrap_err();
        assert_eq!(e.message, "@default must be the last section");
    }

    #[test]
    fn the_routes_header_needs_its_paren_on_the_same_line() {
        let n = nodes("@ClientRoutes\n(route) { @notFound { <p/> } }");
        assert_eq!(n[0], Node::Expr("ClientRoutes".into()), "{n:?}");
        assert!(!n.iter().any(|n| matches!(n, Node::Routes { .. })), "{n:?}");
        let n = nodes("@ClientRoutes (route)\n{\n  @notFound { <p/> }\n}");
        assert!(matches!(n.as_slice(), [Node::Routes { .. }]), "{n:?}");
    }

    #[test]
    fn the_route_variable_cannot_be_a_directive_word() {
        for word in ["if", "for", "while", "switch", "code", "slot", "cascade", "page", "ClientRoutes"] {
            let e = parse(&format!("@ClientRoutes({word}) {{ @notFound {{ <p/> }} }}")).unwrap_err();
            assert_eq!(e.message, format!("\"{word}\" can't name the route variable"));
            assert_eq!(e.offset, "@ClientRoutes(".len());
        }
    }

    /// The regex literal of a `@/…/flags(page)` section.
    fn regex_of(re: &str) -> String {
        let n = nodes(&format!("@ClientRoutes(r) {{ @{re}(page) {{ <p/> }} }}"));
        let [Node::Routes { sections, .. }] = n.as_slice() else { panic!("{n:?}") };
        let RouteSectionKind::Regex { re, .. } = &sections[0].kind else { panic!("{sections:?}") };
        re.text.to_string()
    }

    #[test]
    fn regex_literals_scan_classes_escapes_and_flags() {
        assert_eq!(regex_of("/a[/]b/"), "/a[/]b/");
        assert_eq!(regex_of("/a\\/b/"), "/a\\/b/");
        assert_eq!(regex_of("/[^\\]/]+/"), "/[^\\]/]+/");
        assert_eq!(regex_of("/x/gimsuy"), "/x/gimsuy");
        let e = parse("@ClientRoutes(r) { @/a[/b/(page) { <p/> } }").unwrap_err();
        assert_eq!(e.message, "unterminated regex");
        assert!(parse("@ClientRoutes(r) { @/ab").is_err());
    }

    #[test]
    fn section_keywords_are_plain_expressions_outside_a_routes_block() {
        assert_eq!(nodes("<p>@notFound</p>"), vec![el("p", vec![], vec![Node::Expr("notFound".into())])]);
        assert_eq!(nodes("@default(x)"), vec![Node::Expr("default(x)".into())]);
        assert_eq!(nodes("<p>@ClientRoutes</p>"), vec![el("p", vec![], vec![Node::Expr("ClientRoutes".into())])]);
        let (_, tokens) = parse("<p>@notFound @default</p>").unwrap();
        assert!(!tokens.iter().any(|t| t.kind == TokenKind::Keyword), "{tokens:?}");
    }
}
