//! Hand-written recursive-descent parser for `.tszor` (Razor-style) templates.
//!
//! Besides the AST it records classified token spans, which drive the highlighter
//! (and later LSP semantic tokens).

use crate::ast::*;
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
}

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
                    Until::Eof => {
                        flush_text(&mut nodes, &mut text);
                        Ok(nodes)
                    }
                    Until::Brace | Until::Case => self.err("unclosed '{' block"),
                    Until::EndTag(name) => self.err(format!("missing closing tag </{name}>")),
                };
            };
            match c {
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
                b'@' if !self.prev_is_alnum() => match self.transition()? {
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
        let is_keyword = matches!(word, "code" | "page" | "import" | "if" | "for" | "switch");
        self.mark(TokenKind::Transition, at, at + 1);
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
                let parts = self.code_block()?;
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
                self.doc.page = Some(self.src[s + 1..self.pos - 1].to_string());
                Ok(Transition::Nothing)
            }
            "import" => {
                let s = self.pos;
                self.skip_line();
                self.mark(TokenKind::Code, s, self.pos);
                let mut stmt = self.span(s, self.pos);
                stmt.text = stmt.text.trim_end_matches(';').trim_end().to_string();
                self.doc.imports.push(stmt);
                Ok(Transition::Nothing)
            }
            "if" => self.if_block().map(Transition::Node),
            "for" => {
                let head = self.condition()?;
                let body = self.block()?;
                Ok(Transition::Node(Node::For { head, body }))
            }
            "switch" => self.switch_block().map(Transition::Node),
            _ => {
                loop {
                    match (self.peek(), self.peek_at(1)) {
                        (Some(b'.'), Some(c)) if is_ident_start(c) => {
                            self.pos += 1;
                            self.ident();
                        }
                        (Some(b'?'), Some(b'.'))
                            if matches!(self.peek_at(2), Some(c) if is_ident_start(c)) =>
                        {
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
        }
    }

    /// Scans a `@code { ... }` body (pos at `{`), splitting out markup used as a value:
    /// `@<Tag ...>` anywhere, or `<Tag ...>` where an expression can start. Markup that
    /// fails to parse is left as TypeScript (generics, type assertions).
    fn code_block(&mut self) -> PResult<Vec<CodePart>> {
        let open = self.pos;
        self.pos += 1;
        let mut parts = Vec::new();
        let mut seg = self.pos;
        let mut depth = 1usize;
        // Whether the previous significant token lets an expression start here.
        let mut expr_start = false;
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
        self.nodes(Until::Brace)
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
        let children = self.nodes(Until::EndTag(&element.name))?;
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
        let value = if name.starts_with("@on") {
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

fn tag_kind(name: &str) -> TokenKind {
    if name.starts_with(|c: char| c.is_ascii_uppercase()) {
        TokenKind::ComponentName
    } else {
        TokenKind::TagName
    }
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
        let src = "@page \"/x\"\n@import A from \"./A.tszor\";\n@code {\n  n = \"}\";\n}\n";
        let doc = parse(src).unwrap().0;
        assert_eq!(doc.page.as_deref(), Some("/x"));
        assert_eq!(doc.imports, vec!["A from \"./A.tszor\""]);
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
        let src = "@import A from \"./A.tszor\"\n@code {\n  n = 1;\n}\n<A x=\"@( n + 1 )\" @onclick=\" go \">@user.name @if ( n > 1 ) {}</A>";
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
        assert_eq!(&*doc.imports[0], "A from \"./A.tszor\"");
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
    fn errors_report_offsets() {
        let e = parse("<div><p></div>").unwrap_err();
        assert_eq!(e.message, "unexpected closing tag </div>");
        assert_eq!(e.offset, 8);
        assert!(parse("@if (x) { <p>").is_err());
    }
}
