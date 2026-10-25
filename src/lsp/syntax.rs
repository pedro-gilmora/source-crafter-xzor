//! Syntax tokens `xzor lsp` adds to TypeScript's semantic tokens, for clients with no xzor grammar of their own (Zed
//! reuses its HTML one): the markup from the parser, and the keywords, literals, comments and operators of the
//! TypeScript regions. TypeScript's tokens (names) are laid over these by the server.

use crate::parser::{TokenKind, parse};

/// The token types painted here, in `paint`'s numbering (1-based): added to the legend when a client asks for them.
pub const TYPES: [&str; 9] = ["keyword", "comment", "string", "number", "operator", "type", "tag", "attribute", "punctuation"];

const KEYWORD: u8 = 1;
const COMMENT: u8 = 2;
const STRING: u8 = 3;
const NUMBER: u8 = 4;
const OPERATOR: u8 = 5;
const TYPE: u8 = 6;
const TAG: u8 = 7;
const ATTRIBUTE: u8 = 8;
const PUNCTUATION: u8 = 9;

const KEYWORDS: &[&str] = &[
    "abstract", "accessor", "as", "async", "await", "break", "case", "catch", "class", "const", "constructor", "continue", "debugger", "declare", "default",
    "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer",
    "instanceof", "interface", "is", "keyof", "let", "namespace", "new", "null", "of", "override", "private", "protected", "public", "readonly", "return",
    "satisfies", "set", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "var", "void", "while", "yield",
];
const BUILTIN_TYPES: &[&str] = &["any", "bigint", "boolean", "never", "number", "object", "string", "symbol", "unknown"];

/// A type per byte of `text` (an index into `TYPES`, plus one; 0 for none). Nothing when the text doesn't parse.
pub fn paint(text: &str) -> Vec<u8> {
    let mut out = vec![0; text.len()];
    let Ok((_, tokens)) = parse(text) else { return out };
    for t in &tokens {
        let kind = match t.kind {
            TokenKind::Transition if text[t.start..].starts_with('@') => KEYWORD,
            TokenKind::Keyword => KEYWORD,
            TokenKind::Comment => COMMENT,
            TokenKind::TagDelim => PUNCTUATION,
            TokenKind::TagName => TAG,
            TokenKind::AttrName => ATTRIBUTE,
            TokenKind::AttrValue => STRING,
            _ => continue,
        };
        out[t.start..t.end].fill(kind);
    }
    // Code last: an expression inside an attribute value is code, not string.
    for t in tokens.iter().filter(|t| t.kind == TokenKind::Code) {
        out[t.start..t.end].fill(0);
        lex(text, t.start, t.end, &mut out);
    }
    out
}

/// Paints the TypeScript in `text[start..end]`. Names are left to TypeScript's own tokens.
fn lex(text: &str, start: usize, end: usize, out: &mut [u8]) {
    let b = text.as_bytes();
    let mut i = start;
    while i < end {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == b'/' && next == Some(b'/') {
            let e = text[i..end].find('\n').map_or(end, |n| i + n);
            out[i..e].fill(COMMENT);
            i = e;
        } else if c == b'/' && next == Some(b'*') {
            let e = text[i + 2..end].find("*/").map_or(end, |n| i + 2 + n + 2);
            out[i..e].fill(COMMENT);
            i = e;
        } else if c == b'"' || c == b'\'' {
            let mut j = i + 1;
            while j < end && b[j] != c && b[j] != b'\n' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let e = (j + 1).min(end);
            out[i..e].fill(STRING);
            i = e;
        } else if c == b'`' {
            i = template(text, i, end, out);
        } else if c.is_ascii_digit() || (c == b'.' && next.is_some_and(|n| n.is_ascii_digit())) {
            let mut j = i + 1;
            while j < end && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'.' || ((b[j] == b'+' || b[j] == b'-') && matches!(b[j - 1], b'e' | b'E'))) {
                j += 1;
            }
            out[i..j].fill(NUMBER);
            i = j;
        } else if c.is_ascii_alphabetic() || c == b'_' || c == b'$' {
            let mut j = i + 1;
            while j < end && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'$') {
                j += 1;
            }
            let word = &text[i..j];
            // `a.type` is a property, whatever its name.
            let member = text[start..i].trim_end().ends_with('.') && !text[start..i].trim_end().ends_with("..");
            if !member {
                if KEYWORDS.contains(&word) {
                    out[i..j].fill(KEYWORD);
                } else if BUILTIN_TYPES.contains(&word) {
                    out[i..j].fill(TYPE);
                }
            }
            i = j;
        } else if b"+-*/%=<>!&|^~?:".contains(&c) {
            let mut j = i + 1;
            while j < end && b"+-*/%=<>!&|^~?:".contains(&b[j]) && !(b[j] == b'/' && matches!(b.get(j + 1), Some(b'/' | b'*'))) {
                j += 1;
            }
            out[i..j].fill(OPERATOR);
            i = j;
        } else {
            i += text[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
}

/// A template literal at `start`: its text is a string, each `${ }` is code. Returns where it ends.
fn template(text: &str, start: usize, end: usize, out: &mut [u8]) -> usize {
    let b = text.as_bytes();
    let mut seg = start;
    let mut j = start + 1;
    while j < end {
        match b[j] {
            b'\\' => j += 2,
            b'`' => {
                out[seg..j + 1].fill(STRING);
                return j + 1;
            }
            b'$' if b.get(j + 1) == Some(&b'{') => {
                out[seg..j + 2].fill(STRING);
                let mut depth = 1;
                let mut k = j + 2;
                while k < end && depth > 0 {
                    match b[k] {
                        b'{' => depth += 1,
                        b'}' => depth -= 1,
                        _ => {}
                    }
                    k += 1;
                }
                let close = k.saturating_sub(1).max(j + 2);
                lex(text, j + 2, close, out);
                seg = close;
                j = close + 1;
            }
            _ => j += 1,
        }
    }
    out[seg..end.min(text.len())].fill(STRING);
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(text: &str, paint: &[u8], needle: &str) -> &'static str {
        let at = text.find(needle).unwrap_or_else(|| panic!("{needle} not in {text}"));
        let k = paint[at];
        assert!(paint[at..at + needle.len()].iter().all(|&x| x == k), "{needle} is not one token");
        if k == 0 { "none" } else { TYPES[k as usize - 1] }
    }

    #[test]
    fn paints_markup_directives_and_typescript() {
        let text = "@page \"/x\"\n@* note *@\n@code {\n  // hi\n  count: number = 0x1f; label = `n ${count + 1}!`;\n  get total() { return this.a.type < 2 ? 'a' : \"b\"; }\n}\n<p class=\"a @count\">@if (count > 1) { <b>x</b> }</p>\n";
        let p = paint(text);
        let k = |n: &str| kind_of(text, &p, n);
        assert_eq!(k("@page"), "keyword");
        assert_eq!(k("@* note *@"), "comment");
        assert_eq!(k("// hi"), "comment");
        assert_eq!(k("number"), "type");
        assert_eq!(k("0x1f"), "number");
        assert_eq!(k("`n ${"), "string");
        assert_eq!(k("!`"), "string");
        assert_eq!(k("+"), "operator");
        assert_eq!(k("get"), "keyword");
        assert_eq!(k("return"), "keyword");
        assert_eq!(k("this"), "keyword");
        // A member named like a keyword is a property, left to TypeScript.
        let member = text.find("type <").unwrap();
        assert!(p[member..member + 4].iter().all(|&x| x == 0));
        assert_eq!(p[member + 5], OPERATOR);
        assert_eq!(k("'a'"), "string");
        assert_eq!(k("\"b\""), "string");
        let tag = text.find("<p class").unwrap() + 1;
        assert_eq!(p[tag], TAG);
        assert_eq!(p[tag - 1], PUNCTUATION);
        assert_eq!(k("class"), "attribute");
        assert_eq!(k("if"), "keyword");
        assert_eq!(p[text.find("> 1").unwrap()], OPERATOR);
        let b = text.find("<b>").unwrap() + 1;
        assert_eq!(p[b], TAG);
        // The expression inside an attribute value is code: its name is left to TypeScript.
        let at = text.find("@count\"").unwrap();
        assert_eq!(p[at + 1], 0);
        assert!(text.find("count:").is_some_and(|i| p[i] == 0));
    }

    #[test]
    fn nothing_when_the_text_does_not_parse() {
        assert!(paint("<p>@if (").iter().all(|&k| k == 0));
    }
}
