//! The persistent DI analyzer: one `bun di.ts --serve <root>` child per project root, spawned on first use.

use crate::di::model::Facts;
use crate::json::Json;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const DI_SCRIPT: &str = include_str!("di.ts");

pub struct Analyzer {
    root: PathBuf,
    proc: Option<Proc>,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Analyzer {
    pub fn new(root: &Path) -> Self {
        Analyzer { root: root.to_path_buf(), proc: None }
    }

    /// Facts for provider `files` and generated `components` (paths relative to the root or absolute);
    /// `overlays` are `(path, text)` pairs read instead of the disk. A dead analyzer is restarted once.
    pub fn analyze(&mut self, files: &[String], components: &[String], overlays: &[(String, String)]) -> Result<Facts, String> {
        let strings = |list: &[String]| Json::Arr(list.iter().map(|s| Json::from(s.as_str())).collect());
        let overlays = Json::Obj(overlays.iter().map(|(p, t)| (p.clone(), Json::from(t.as_str()))).collect());
        let mut request = Json::obj([("files", strings(files)), ("components", strings(components)), ("overlays", overlays)]).to_string();
        request.push('\n');
        let mut line = String::new();
        let mut restarted = false;
        loop {
            if self.proc.is_none() {
                self.proc = Some(self.spawn()?);
            }
            let proc = self.proc.as_mut().expect("spawned above");
            line.clear();
            let answered = proc.stdin.write_all(request.as_bytes()).and_then(|_| proc.stdin.flush()).is_ok()
                && proc.stdout.read_line(&mut line).is_ok_and(|n| n > 0);
            if answered {
                return facts(&line);
            }
            let status = self.stop();
            if restarted {
                return Err(format!("DI analysis failed: the analyzer exited ({status})"));
            }
            restarted = true;
        }
    }

    fn spawn(&self) -> Result<Proc, String> {
        // Under node_modules, `typescript` resolves from the project and the script stays out of tsconfig's `include`.
        let script = self.root.join("node_modules").join(".cache").join("zor").join("di.ts");
        crate::build::write_if_changed(&script, DI_SCRIPT)?;
        let mut child = Command::new("bun")
            .arg(&script)
            .arg("--serve")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("DI analysis: failed to run bun: {e}"))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        Ok(Proc { child, stdin, stdout })
    }

    /// Ends the child: closing stdin lets it shut TypeScript down; it is killed if it lingers.
    fn stop(&mut self) -> String {
        let Some(Proc { mut child, stdin, stdout }) = self.proc.take() else { return String::new() };
        drop(stdin);
        drop(stdout);
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(status)) => return status.to_string(),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(e) => return e.to_string(),
            }
        }
        let _ = child.kill();
        child.wait().map_or_else(|e| e.to_string(), |s| s.to_string())
    }

    #[cfg(test)]
    pub(crate) fn pid(&self) -> Option<u32> {
        self.proc.as_ref().map(|p| p.child.id())
    }

    #[cfg(test)]
    pub(crate) fn kill(&mut self) {
        if let Some(p) = &mut self.proc {
            p.child.kill().unwrap();
            p.child.wait().unwrap();
        }
    }
}

impl Drop for Analyzer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One response line: the facts, or a clear error for `{"fatal": ...}` or unparseable output.
fn facts(line: &str) -> Result<Facts, String> {
    let line = line.trim_end();
    if line.starts_with("{\"fatal\":") {
        let message = Json::parse(line).ok().and_then(|j| j["fatal"].as_str().map(String::from)).unwrap_or_else(|| line.to_string());
        return Err(format!("DI analysis failed\n{message}"));
    }
    Facts::from_json(line).map_err(|e| format!("DI analysis: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzer_failures_are_clear_errors() {
        assert_eq!(facts("{\"fatal\":\"boom\"}\n").unwrap_err(), "DI analysis failed\nboom");
        let garbled = facts("not json\n").unwrap_err();
        assert!(garbled.starts_with("DI analysis: "), "{garbled}");
    }
}
