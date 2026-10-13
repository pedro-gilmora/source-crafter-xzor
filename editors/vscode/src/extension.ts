import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, workspace } from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function findServer(): string {
  const configured = workspace.getConfiguration("tszor").get<string>("serverPath");
  if (configured) return configured;
  const exe = process.platform === "win32" ? "zor.exe" : "zor";
  for (const folder of workspace.workspaceFolders ?? []) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(folder.uri.fsPath, "target", profile, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "zor";
}

// Run a copy so a running server doesn't lock target/ and block `cargo build` on Windows.
function stableCopy(context: ExtensionContext, server: string): string {
  if (!/[\\/]target[\\/](debug|release)[\\/]/.test(server)) return server;
  const dir = context.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `zor-${statSync(server).mtimeMs.toFixed(0)}${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(copy)) copyFileSync(server, copy);
  return copy;
}

export async function activate(context: ExtensionContext): Promise<void> {
  const command = stableCopy(context, findServer());
  // Provider `.ts` changes rerun the DI analysis; the server ignores `.zor/` and `node_modules/`.
  const watcher = workspace.createFileSystemWatcher("**/{*.ts,*.tszor}");
  context.subscriptions.push(watcher);
  client = new LanguageClient(
    "tszor",
    "TSZor",
    { command, args: ["lsp"] },
    { documentSelector: [{ scheme: "file", language: "tszor" }], synchronize: { fileEvents: watcher } },
  );
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
