//! Terminal syntax coloring for `.xzor`, driven by the parser's token spans.

use crate::parser::{ParseError, TokenKind, parse};

const RESET: &str = "\x1b[0m";

fn color(kind: TokenKind) -> &'static str {
    match kind {
        TokenKind::Transition => "\x1b[1;35m",
        TokenKind::Keyword => "\x1b[35m",
        TokenKind::Code => "\x1b[36m",
        TokenKind::TagDelim => "\x1b[90m",
        TokenKind::TagName => "\x1b[34m",
        TokenKind::ComponentName => "\x1b[1;32m",
        TokenKind::AttrName => "\x1b[33m",
        TokenKind::AttrValue => "\x1b[32m",
        TokenKind::Comment => "\x1b[2;37m",
    }
}

pub fn highlight_ansi(src: &str) -> Result<String, ParseError> {
    let (_, mut tokens) = parse(src)?;
    tokens.sort_by_key(|t| t.start);
    let mut out = String::with_capacity(src.len() * 2);
    let mut cursor = 0;
    for t in tokens {
        if t.start < cursor {
            continue;
        }
        out.push_str(&src[cursor..t.start]);
        out.push_str(color(t.kind));
        out.push_str(&src[t.start..t.end]);
        out.push_str(RESET);
        cursor = t.end;
    }
    out.push_str(&src[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_without_losing_text() {
        let src = "<p class=\"a @b\">Hi @name!</p>\n@code { name = \"x\"; }";
        let out = highlight_ansi(src).unwrap();
        let plain = out
            .split('\x1b')
            .enumerate()
            .map(|(i, s)| if i == 0 { s } else { &s[s.find('m').unwrap() + 1..] })
            .collect::<String>();
        assert_eq!(plain, src);
        assert!(out.contains("\x1b[34mp\x1b[0m"));
        assert!(out.contains("\x1b[36mname\x1b[0m"));
    }
}
