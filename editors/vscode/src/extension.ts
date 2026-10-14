import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, type FileSystemWatcher, commands, window, workspace } from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function findServer(): string {
  const configured = workspace.getConfiguration("xzor").get<string>("serverPath");
  if (configured) return configured;
  const exe = process.platform === "win32" ? "xzor.exe" : "xzor";
  for (const folder of workspace.workspaceFolders ?? []) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(folder.uri.fsPath, "target", profile, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "xzor";
}

// Run a copy so a running server doesn't lock target/ and block `cargo build` on Windows.
function stableCopy(context: ExtensionContext, server: string): string {
  if (!/[\\/]target[\\/](debug|release)[\\/]/.test(server)) return server;
  const dir = context.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `xzor-${statSync(server).mtimeMs.toFixed(0)}${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(copy)) copyFileSync(server, copy);
  return copy;
}

function createClient(context: ExtensionContext, watcher: FileSystemWatcher): LanguageClient {
  // A fresh copy each time, so a rebuilt target/ binary is picked up on restart.
  const command = stableCopy(context, findServer());
  // `.ts` documents get only DI diagnostics from the server; VS Code's TypeScript serves everything else.
  return new LanguageClient(
    "xzor",
    "XZor",
    { command, args: ["lsp"] },
    {
      documentSelector: [
        { scheme: "file", language: "xzor" },
        { scheme: "file", language: "typescript" },
      ],
      synchronize: { fileEvents: watcher },
    },
  );
}

export async function activate(context: ExtensionContext): Promise<void> {
  // Provider `.ts` changes rerun the DI analysis; the server ignores `.xzor/` and `node_modules/`.
  const watcher = workspace.createFileSystemWatcher("**/{*.ts,*.xzor}");
  context.subscriptions.push(watcher);
  context.subscriptions.push(
    commands.registerCommand("xzor.restartServer", async () => {
      await client?.stop();
      client = createClient(context, watcher);
      await client.start();
      window.setStatusBarMessage("XZor: server restarted", 3000);
    }),
  );
  client = createClient(context, watcher);
  await client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
