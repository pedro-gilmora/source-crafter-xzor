//! Language server for `.tszor`: component features handled here, TypeScript regions
//! proxied to TypeScript 7's native server (`tsc --lsp --stdio`).

pub mod features;
pub mod server;

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

/// Reads one `Content-Length` framed message; `None` at end of stream.
pub fn read_message(r: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut len = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse::<usize>().ok();
        }
    }
    let len = len.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    let mut buf = vec![0; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn write_message(w: &mut impl Write, body: &str) -> io::Result<()> {
    write!(w, "Content-Length: {}\r\n\r\n{body}", body.len())?;
    w.flush()
}

/// Byte offset of an LSP position (UTF-16 code units), clamped to the line.
pub fn offset_at(text: &str, line: usize, character: usize) -> usize {
    let mut start = 0;
    for _ in 0..line {
        match text[start..].find('\n') {
            Some(i) => start += i + 1,
            None => return text.len(),
        }
    }
    let end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    let mut units = 0;
    for (i, c) in text[start..end].char_indices() {
        if units >= character {
            return start + i;
        }
        units += c.len_utf16();
    }
    end
}

/// LSP position (line, UTF-16 character) of a byte offset.
pub fn position_at(text: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(text.len());
    let before = &text[..text.floor_char_boundary(offset)];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = before.matches('\n').count();
    (line, before[line_start..].encode_utf16().count())
}

pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(b) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                bytes.push(b);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let decoded = String::from_utf8(bytes).ok()?;
    let is_drive = |s: &str| s.len() >= 3 && s.as_bytes()[0] == b'/' && s.as_bytes()[2] == b':';
    if is_drive(&decoded) {
        Some(PathBuf::from(decoded[1..].replace('/', "\\")))
    } else {
        Some(PathBuf::from(decoded))
    }
}

/// `file://` URI in the form VS Code uses (lowercase drive, `:` encoded).
pub fn path_to_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    let mut out = String::from("file://");
    if s.as_bytes().get(1) == Some(&b':') {
        out.push('/');
        out.push(s.as_bytes()[0].to_ascii_lowercase() as char);
        out.push_str("%3A");
        encode_into(&mut out, &s[2..]);
    } else {
        encode_into(&mut out, s);
    }
    out
}

fn encode_into(out: &mut String, s: &str) {
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
}

/// Paths compare case-insensitively on Windows.
pub fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        path_key(a) == path_key(b)
    } else {
        a == b
    }
}

/// A path as a hash key that matches like `same_path`.
pub fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) { s.to_lowercase() } else { s.into_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_round_trip() {
        let mut buf = Vec::new();
        write_message(&mut buf, r#"{"a":"é"}"#).unwrap();
        write_message(&mut buf, "{}").unwrap();
        let mut r = io::BufReader::new(&buf[..]);
        assert_eq!(read_message(&mut r).unwrap().as_deref(), Some(r#"{"a":"é"}"#));
        assert_eq!(read_message(&mut r).unwrap().as_deref(), Some("{}"));
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    #[test]
    fn utf16_positions() {
        let text = "ab\n😀x\r\nlast";
        assert_eq!(offset_at(text, 0, 1), 1);
        assert_eq!(offset_at(text, 1, 2), 3 + 4);
        assert_eq!(position_at(text, 3 + 4), (1, 2));
        assert_eq!(offset_at(text, 2, 99), text.len());
        assert_eq!(position_at(text, text.len()), (2, 4));
        assert_eq!(offset_at(text, 9, 0), text.len());
    }

    #[test]
    fn uris() {
        if cfg!(windows) {
            let p = uri_to_path("file:///d%3A/Code/my%20app/A.tszor").unwrap();
            assert_eq!(p, PathBuf::from(r"d:\Code\my app\A.tszor"));
            assert_eq!(path_to_uri(&p), "file:///d%3A/Code/my%20app/A.tszor");
            assert_eq!(path_to_uri(Path::new(r"D:\x\y.ts")), "file:///d%3A/x/y.ts");
            assert!(same_path(Path::new(r"D:\X"), Path::new(r"d:\x")));
        } else {
            let p = uri_to_path("file:///home/a%20b/A.tszor").unwrap();
            assert_eq!(p, PathBuf::from("/home/a b/A.tszor"));
            assert_eq!(path_to_uri(&p), "file:///home/a%20b/A.tszor");
        }
    }
}
