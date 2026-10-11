// Runs the grammar tests, embedding the TypeScript grammar bundled with the local VS Code.
// Set TS_GRAMMAR to a TypeScript.tmLanguage.json path to override discovery.
import { Glob } from "bun";
import { join } from "node:path";

const pattern = "Programs/Microsoft VS Code/*/resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json";
const tsGrammar =
  process.env.TS_GRAMMAR ??
  [...new Glob(pattern).scanSync({ cwd: process.env.LOCALAPPDATA ?? "", absolute: true })][0];
if (!tsGrammar) throw new Error("TypeScript grammar not found; set TS_GRAMMAR");

const root = join(import.meta.dir, "..");
const proc = Bun.spawnSync(
  ["bun", "x", "vscode-tmgrammar-test", "-g", join(root, "syntaxes/tszor.tmLanguage.json"), "-g", tsGrammar, join(root, "test/*.test.tszor")],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(proc.exitCode ?? 1);
