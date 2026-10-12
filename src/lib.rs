pub mod ast;
pub mod build;
pub mod codegen;
pub mod highlight;
pub mod json;
pub mod lsp;
pub mod parser;

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

/// Compiles one `.tszor` source into a TypeScript module.
pub fn compile(source: &str, path: &Path) -> Result<String, Diagnostic> {
    compile_mapped(source, path).map(|g| g.code)
}

/// Like [`compile`], plus the source mappings between the `.tszor` and the generated code.
pub fn compile_mapped(source: &str, path: &Path) -> Result<codegen::Generated, Diagnostic> {
    let (doc, _) = parser::parse(source).map_err(|e| {
        let (line, column) = line_col(source, e.offset);
        Diagnostic { message: e.message, line, column, offset: e.offset }
    })?;
    let file_name = path.file_name().map_or_else(|| "component.tszor".into(), |n| n.to_string_lossy());
    let stem = file_name.strip_suffix(".tszor").unwrap_or(&file_name);
    let components = imported_components(&doc, path);
    codegen::generate_with(&doc, &codegen::class_name(stem), &file_name, &components)
        .map_err(|message| Diagnostic { message, line: 1, column: 1, offset: 0 })
}

/// Type parameters and prop kinds of each `.tszor` component imported by `doc`, read from disk.
fn imported_components(doc: &ast::Document, path: &Path) -> HashMap<String, codegen::ComponentInfo> {
    let dir = path.parent().unwrap_or(Path::new("."));
    doc.imports
        .iter()
        .filter_map(|import| {
            let name = import.split_whitespace().next()?;
            let spec = import.rsplit(['"', '\'']).nth(1)?;
            if !spec.ends_with(".tszor") || !codegen::is_identifier(name) {
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
