// `xzor serve`, run by the launcher under Bun: builds the app in its production form (`xzor build --minify`) and serves it.
// A server app runs its `dist/server.js`; a browser-only app is served from `dist/` (page shells, files, `index.html` as the 404).
// argv: <xzor binary> [dir] [--port N] [--host H]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseHost } from "./dev";

const [exe, ...argv] = process.argv.slice(2);
const { hostname, rest } = parseHost(argv);
let port = Number(process.env.PORT ?? 3000);
let dir = ".";
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a === "--port") port = Number(rest[++i]);
  else if (a.startsWith("--port=")) port = Number(a.slice(7));
  else dir = a;
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error("xzor: --port takes a number from 0 to 65535");
  process.exit(1);
}

const root = resolve(dir);
const built = Bun.spawnSync([exe!, "build", root, "--minify"], { stdio: ["inherit", "inherit", "inherit"] });
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);

const entry = join(root, "dist", "server.js");
if (existsSync(entry)) {
  const child = Bun.spawn(["bun", entry], { cwd: root, env: { ...process.env, PORT: String(port), HOST: hostname }, stdio: ["inherit", "inherit", "inherit"] });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exit(await child.exited);
}

// The app's own runtime (its tsconfig `paths` or node_modules), so the files are served by the version the app builds against.
const { serveDist } = (await import(Bun.resolveSync("@source-crafter/xzor-runtime/server", join(root, "serve.ts")))) as typeof import("../../../runtime/server");
const { routes, fallback } = serveDist(root);
const server = Bun.serve({ hostname, port, routes, fetch: fallback });
console.log(`xzor: serving ${server.url}`);
