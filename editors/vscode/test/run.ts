// Runs the grammar tests, embedding the TypeScript and CSS grammars bundled with the local VS Code.
// Set TS_GRAMMAR and CSS_GRAMMAR to their .tmLanguage.json paths to override discovery.
import { Glob } from "bun";
import { join } from "node:path";

const find = (env: string, rel: string): string => {
  const found = process.env[env] ?? [...new Glob(`Programs/Microsoft VS Code/*/resources/app/extensions/${rel}`).scanSync({ cwd: process.env.LOCALAPPDATA ?? "", absolute: true })][0];
  if (!found) throw new Error(`${rel} not found; set ${env}`);
  return found;
};
const tsGrammar = find("TS_GRAMMAR", "typescript-basics/syntaxes/TypeScript.tmLanguage.json");
const cssGrammar = find("CSS_GRAMMAR", "css/syntaxes/css.tmLanguage.json");

const root = join(import.meta.dir, "..");
const proc = Bun.spawnSync(
  ["bun", "x", "vscode-tmgrammar-test", "-g", join(root, "syntaxes/xzor.tmLanguage.json"), "-g", tsGrammar, "-g", cssGrammar, join(root, "test/*.test.xzor")],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(proc.exitCode ?? 1);
