#!/usr/bin/env node
// Runs the xzor binary from the platform package npm installed (`@source-crafter/xzor-cli-<platform>-<arch>`).
"use strict";
const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

const target = `${process.platform}-${process.arch}`;
const exe = process.platform === "win32" ? "xzor.exe" : "xzor";

function binary() {
  try {
    return join(dirname(require.resolve(`@source-crafter/xzor-cli-${target}/package.json`)), exe);
  } catch {
    console.error(`xzor: no binary for ${target}. Supported: win32-x64, linux-x64, darwin-arm64.`);
    process.exit(1);
  }
}

const [command, ...rest] = process.argv.slice(2);
const run =
  command === "init"
    ? spawnSync("bun", [join(__dirname, "init.ts"), ...rest], { stdio: "inherit" })
    : command === "dev"
      ? spawnSync("bun", [join(__dirname, "dev.ts"), binary(), ...rest], { stdio: "inherit" })
      : command === "serve"
        ? spawnSync("bun", [join(__dirname, "serve.ts"), binary(), ...rest], { stdio: "inherit" })
        : spawnSync(binary(), process.argv.slice(2), { stdio: "inherit" });
if (run.error) {
  console.error(`xzor: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
