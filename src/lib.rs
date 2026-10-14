pub mod analyzer;
pub mod ast;
pub mod build;
pub mod codegen;
pub mod di;
pub mod highlight;
pub mod inherit;
pub mod json;
pub mod lsp;
pub mod parser;
pub mod routes;

use std::collections::HashMap;
use std::fmt;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub message: String,
    pub line: usize,
    pub column: usize,
    /// Byte offset in the source.
    pub offset: usize,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.column, self.message)
    }
}

/// Compiles one `.xzor` source into a TypeScript module.
pub fn compile(source: &str, path: &Path) -> Result<String, Diagnostic> {
    compile_mapped(source, path).map(|g| g.code)
}

/// Like [`compile`], plus the source mappings between the `.xzor` and the generated code.
pub fn compile_mapped(source: &str, path: &Path) -> Result<codegen::Generated, Diagnostic> {
    compile_mapped_with(source, path, &|p| std::fs::read_to_string(p).ok())
}

/// Like [`compile_mapped`], reading `@inherits` base sources through `read`.
pub fn compile_mapped_with(source: &str, path: &Path, read: &dyn Fn(&Path) -> Option<String>) -> Result<codegen::Generated, Diagnostic> {
    let (doc, _) = parser::parse(source).map_err(|e| {
        let (line, column) = line_col(source, e.offset);
        Diagnostic { message: e.message, line, column, offset: e.offset }
    })?;
    let file_name = path.file_name().map_or_else(|| "component.xzor".into(), |n| n.to_string_lossy());
    let stem = file_name.strip_suffix(".xzor").unwrap_or(&file_name);
    let components = imported_components(&doc, path);
    if let Some(offset) = codegen::inject_constructor(&doc) {
        let (line, column) = line_col(source, offset);
        return Err(Diagnostic { message: codegen::ZDI08.into(), line, column, offset });
    }
    if let Some((message, offset)) = codegen::cascade_error(&doc) {
        let (line, column) = line_col(source, offset);
        return Err(Diagnostic { message, line, column, offset });
    }
    let base = inherit::base_members(&doc, path, read);
    let table = routes::table_spec(&build::project_root(path), path);
    let mut generated =
        codegen::generate_with(&doc, &codegen::class_name(stem), &file_name, &components, &base.members, &table)
            .map_err(|message| Diagnostic { message, line: 1, column: 1, offset: 0 })?;
    generated.deps = base.deps;
    if let (Some(name), Some(inherits)) = (base.unresolved, &doc.inherits) {
        let (line, column) = line_col(source, inherits.at);
        let message = format!("could not read base class '{name}'; use this.<member> for its members");
        generated.warnings.push(Diagnostic { message, line, column, offset: inherits.at });
    }
    Ok(generated)
}

/// Type parameters and prop kinds of each `.xzor` component imported by `doc`, read from disk.
fn imported_components(doc: &ast::Document, path: &Path) -> HashMap<String, codegen::ComponentInfo> {
    let dir = path.parent().unwrap_or(Path::new("."));
    doc.imports
        .iter()
        .filter_map(|import| {
            let name = import.split_whitespace().next()?;
            let spec = import.rsplit(['"', '\'']).nth(1)?;
            if !spec.ends_with(".xzor") || !codegen::is_identifier(name) {
                return None;
            }
            let text = std::fs::read_to_string(dir.join(spec)).ok()?;
            Some((name.to_string(), codegen::component_info(&text)))
        })
        .collect()
}

/// 1-based line and column (in bytes) of a byte offset.
pub fn line_col(src: &str, offset: usize) -> (usize, usize) {
    let before = &src.as_bytes()[..offset.min(src.len())];
    let line_start = before.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
    (line, offset - line_start + 1)
}

pub(crate) fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || c == b'$'
}

pub(crate) fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warnings(src: &str) -> Vec<Diagnostic> {
        compile_mapped(src, Path::new("App.xzor")).unwrap().warnings
    }

    #[test]
    fn warns_when_the_base_cannot_be_read() {
        let src = "@import { Base } from \"pkg-missing\"\n@inherits Base\n<p/>\n";
        let w = warnings(src);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].message, "could not read base class 'Base'; use this.<member> for its members");
        assert_eq!((w[0].line, w[0].column), (2, 11));
        assert_eq!(w[0].offset, src.find("Base\n<p/>").unwrap());
    }

    #[test]
    fn no_warning_without_a_readable_chain() {
        assert!(warnings("<p/>\n").is_empty());
        assert!(warnings("@import { ComponentBase } from \"@source-crafter/xzor-runtime\"\n@inherits ComponentBase\n<p/>\n").is_empty());
    }
}
