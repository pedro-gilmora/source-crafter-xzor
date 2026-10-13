//! The persistent DI analyzer: one `bun di.ts --serve <root>` child per project root, spawned on first use.

use crate::di::model::Facts;
use crate::json::Json;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

const DI_SCRIPT: &str = include_str!("di.ts");

/// tsgo leaks memory per request, so the child is replaced after this many.
const RECYCLE_AFTER: u32 = 500;

/// A child that answers nothing for this long is killed and the request retried once on a new one.
const TIMEOUT: Duration = Duration::from_secs(10);

/// The first request after a spawn also waits for tsgo to start and load the program.
const COLD_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Analyzer {
    root: PathBuf,
    proc: Option<Proc>,
    served: u32,
    limit: u32,
    timeout: Duration,
    cold_timeout: Duration,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    /// Response lines, read on a thread so a wedged child cannot block `analyze`.
    lines: Receiver<String>,
}

impl Analyzer {
    pub fn new(root: &Path) -> Self {
        Self::with_limit(root, RECYCLE_AFTER)
    }

    pub(crate) fn with_limit(root: &Path, limit: u32) -> Self {
        Analyzer { root: root.to_path_buf(), proc: None, served: 0, limit, timeout: TIMEOUT, cold_timeout: COLD_TIMEOUT }
    }

    /// Facts for provider `files` and generated `components` (paths relative to the root or absolute);
    /// `overlays` are `(path, text)` pairs read instead of the disk. A dead or wedged analyzer is restarted once.
    pub fn analyze(&mut self, files: &[String], components: &[String], overlays: &[(PathBuf, String)]) -> Result<Facts, String> {
        // Recycled here rather than after the answer, so that answer is not delayed by the shutdown.
        if self.served >= self.limit {
            self.stop();
        }
        let strings = |list: &[String]| Json::Arr(list.iter().map(|s| Json::from(s.as_str())).collect());
        let overlays = Json::Obj(overlays.iter().map(|(p, t)| (p.to_string_lossy().into_owned(), Json::from(t.as_str()))).collect());
        let mut request = Json::obj([("files", strings(files)), ("components", strings(components)), ("overlays", overlays)]).to_string();
        request.push('\n');
        let mut restarted = false;
        loop {
            if self.proc.is_none() {
                self.proc = Some(self.spawn()?);
            }
            let wait = if self.served == 0 { self.cold_timeout } else { self.timeout };
            let proc = self.proc.as_mut().expect("spawned above");
            let answer = if proc.stdin.write_all(request.as_bytes()).and_then(|_| proc.stdin.flush()).is_ok() {
                proc.lines.recv_timeout(wait)
            } else {
                Err(RecvTimeoutError::Disconnected)
            };
            let error = match answer {
                Ok(line) => {
                    self.served += 1;
                    return facts(&line);
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill_now();
                    format!("DI analysis failed: the analyzer did not answer within {}s", wait.as_secs_f32())
                }
                Err(RecvTimeoutError::Disconnected) => format!("DI analysis failed: the analyzer exited ({})", self.stop()),
            };
            if restarted {
                return Err(error);
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
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in stdout.lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Proc { child, stdin, lines })
    }

    /// Kills a child that stopped answering.
    fn kill_now(&mut self) {
        if let Some(mut p) = self.proc.take() {
            self.served = 0;
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }

    /// Ends the child: closing stdin lets it shut TypeScript down; it is killed if it lingers.
    fn stop(&mut self) -> String {
        let Some(Proc { mut child, stdin, lines }) = self.proc.take() else { return String::new() };
        self.served = 0;
        drop(stdin);
        drop(lines);
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
    pub(crate) fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
        self.cold_timeout = timeout;
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
