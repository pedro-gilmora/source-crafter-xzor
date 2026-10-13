//! Route patterns (Bun.serve syntax) and the facts codegen hands to the route table.

use crate::{is_ident_char, is_ident_start};

/// One `@page` route of a component, with the offsets of its tag (if any) and pattern in the `.tszor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteInfo {
    pub tag: Option<String>,
    pub tag_at: usize,
    pub pattern: String,
    pub pattern_at: usize,
    pub params: Vec<(String, ParamKind)>,
}

/// How a matched path segment is converted before it fills the page's prop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamKind {
    String,
    Number,
    Boolean,
    Union(Vec<String>),
}

/// Checks a route pattern: a leading `/`, then literal or `:param` segments and an optional final `*`.
/// The error is the reason, as used in `invalid route pattern "<p>": <reason>`.
pub fn validate_pattern(p: &str) -> Result<(), String> {
    let Some(rest) = p.strip_prefix('/') else {
        return Err("must start with '/'".into());
    };
    if rest.is_empty() {
        return Ok(());
    }
    let mut segments = rest.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segment.is_empty() {
            return Err("empty segment".into());
        }
        if segment == "*" {
            if segments.peek().is_some() {
                return Err("'*' must be the last segment".into());
            }
        } else if let Some(name) = segment.strip_prefix(':') {
            if !is_ident(name) {
                return Err(format!("invalid parameter name {name:?}"));
            }
        } else if segment.contains([':', '*']) {
            return Err(format!("invalid segment {segment:?}"));
        }
    }
    Ok(())
}

/// Param names of a pattern in order; a trailing `*` contributes `rest`.
pub fn param_names(p: &str) -> Vec<&str> {
    p.split('/')
        .filter_map(|segment| match segment {
            "*" => Some("rest"),
            _ => segment.strip_prefix(':'),
        })
        .collect()
}

/// Conversion for a param, read from its prop declaration text (`id: number`, `tab = "a"`, …).
pub fn param_kind(decl: &str) -> ParamKind {
    let rest = decl.trim_start_matches(|c: char| c.is_ascii() && is_ident_char(c as u8)).trim_start();
    let rest = rest.trim_start_matches(['?', '!']).trim_start();
    if let Some(ty) = rest.strip_prefix(':') {
        let ty = &ty[..initializer_pos(ty).unwrap_or(ty.len())];
        return from_type(ty.trim());
    }
    match rest.strip_prefix('=') {
        Some(init) => from_initializer(init.trim()),
        None => ParamKind::String,
    }
}

fn from_type(ty: &str) -> ParamKind {
    match ty {
        "number" => ParamKind::Number,
        "boolean" => ParamKind::Boolean,
        _ => {
            let parts: Vec<&str> = ty.split('|').map(str::trim).collect();
            let literals: Option<Vec<String>> = parts.iter().map(|p| string_literal(p)).collect();
            match literals {
                Some(values) if !values.is_empty() => ParamKind::Union(values),
                _ => ParamKind::String,
            }
        }
    }
}

fn from_initializer(init: &str) -> ParamKind {
    match init {
        "true" | "false" => ParamKind::Boolean,
        _ if init.trim_end_matches(';').trim().parse::<f64>().is_ok() => ParamKind::Number,
        _ => ParamKind::String,
    }
}

/// The text of a `"…"` or `'…'` literal, if `s` is one (escapes are left as written).
fn string_literal(s: &str) -> Option<String> {
    let quote = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = s.strip_prefix(quote)?.strip_suffix(quote)?;
    (!inner.contains(quote)).then(|| inner.to_string())
}

/// Offset of the `=` that starts an initializer in a type annotation, skipping `=>`, `==`, `<=`, …
fn initializer_pos(ty: &str) -> Option<usize> {
    let b = ty.as_bytes();
    (0..b.len()).find(|&i| {
        b[i] == b'=' && b.get(i + 1) != Some(&b'>') && !matches!(i.checked_sub(1).map(|j| b[j]), Some(b'=' | b'!' | b'<' | b'>'))
    })
}

fn is_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && is_ident_start(b[0]) && b[1..].iter().all(|&c| is_ident_char(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_patterns() {
        assert_eq!(validate_pattern("/"), Ok(()));
        assert_eq!(validate_pattern("/users/:id"), Ok(()));
        assert_eq!(validate_pattern("/a/*"), Ok(()));
        assert_eq!(validate_pattern("users"), Err("must start with '/'".into()));
        assert_eq!(validate_pattern("/a/*/b"), Err("'*' must be the last segment".into()));
        assert_eq!(validate_pattern("/:1x"), Err("invalid parameter name \"1x\"".into()));
        assert_eq!(validate_pattern("/a//b"), Err("empty segment".into()));
        assert_eq!(validate_pattern("/a*"), Err("invalid segment \"a*\"".into()));
    }

    #[test]
    fn lists_param_names_with_rest_for_the_star() {
        assert_eq!(param_names("/users/:id/t/:tab/*"), ["id", "tab", "rest"]);
        assert!(param_names("/a/b").is_empty());
    }

    #[test]
    fn reads_param_kinds_from_declarations() {
        assert_eq!(param_kind("id = 0"), ParamKind::Number);
        assert_eq!(param_kind("id: number"), ParamKind::Number);
        assert_eq!(param_kind("on: boolean = false"), ParamKind::Boolean);
        assert_eq!(param_kind("on = true"), ParamKind::Boolean);
        assert_eq!(param_kind("tab: \"a\" | \"b\" = \"a\""), ParamKind::Union(vec!["a".into(), "b".into()]));
        assert_eq!(param_kind("slug = \"\""), ParamKind::String);
        assert_eq!(param_kind("slug?: string"), ParamKind::String);
        assert_eq!(param_kind("id!: Id"), ParamKind::String);
    }
}
