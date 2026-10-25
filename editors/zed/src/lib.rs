use zed_extension_api::{self as zed, serde_json::json, settings::LspSettings, Architecture, LanguageServerId, Os, Result, Worktree};

struct Xzor;

impl Xzor {
    /// `lsp.xzor.binary` in the settings (Zed itself runs a `path` set there, with its `arguments`), else the
    /// project's npm platform package, else `xzor` on the PATH.
    fn server(&self, worktree: &Worktree) -> Result<(String, Vec<String>)> {
        let binary = LspSettings::for_worktree("xzor", worktree).ok().and_then(|s| s.binary);
        let args = binary.as_ref().and_then(|b| b.arguments.clone()).unwrap_or_else(|| vec!["lsp".into()]);
        if let Some(path) = binary.and_then(|b| b.path) {
            return Ok((path, args));
        }
        let (os, arch) = zed::current_platform();
        let os = match os {
            Os::Windows => "win32",
            Os::Mac => "darwin",
            Os::Linux => "linux",
        };
        let arch = match arch {
            Architecture::Aarch64 => "arm64",
            _ => "x64",
        };
        let exe = if os == "win32" { "xzor.exe" } else { "xzor" };
        // An extension can't stat files: the package's manifest says it is there.
        let package = format!("node_modules/@source-crafter/xzor-cli-{os}-{arch}");
        if worktree.read_text_file(&format!("{package}/package.json")).is_ok() {
            return Ok((format!("{}/{package}/{exe}", worktree.root_path()), args));
        }
        worktree
            .which("xzor")
            .map(|path| (path, args))
            .ok_or_else(|| "xzor not found: add @source-crafter/xzor to the project, or set lsp.xzor.binary.path".into())
    }
}

impl zed::Extension for Xzor {
    fn new() -> Self {
        Xzor
    }

    fn language_server_command(&mut self, _id: &LanguageServerId, worktree: &Worktree) -> Result<zed::Command> {
        let (command, args) = self.server(worktree)?;
        Ok(zed::Command { command, args, env: Default::default() })
    }

    // Zed reuses its HTML grammar for `.xzor`, which doesn't know `@`: the server colors the rest.
    fn language_server_initialization_options(&mut self, _id: &LanguageServerId, _worktree: &Worktree) -> Result<Option<zed::serde_json::Value>> {
        Ok(Some(json!({ "syntaxTokens": true })))
    }
}

zed::register_extension!(Xzor);
