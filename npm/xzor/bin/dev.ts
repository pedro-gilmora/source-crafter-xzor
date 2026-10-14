// `xzor dev`, run by the launcher under Bun: `xzor build --watch` plus a static server with the SPA fallback.
// argv: <xzor binary> [build options...]
import { resolve, sep } from "node:path";

const [exe, ...args] = process.argv.slice(2);
const root = process.cwd();
const watch = Bun.spawn([exe!, "build", "--watch", ...args], { stdio: ["inherit", "inherit", "inherit"] });

// Never cached, so a reload always gets the latest build.
const headers = { "Cache-Control": "no-store" };
const fetch = async (req: Request) => {
  const path = resolve(root, "." + decodeURIComponent(new URL(req.url).pathname));
  if (path.startsWith(root + sep)) {
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file, { headers });
  }
  // Unknown paths are client routes: the app routes them itself.
  return new Response(Bun.file(resolve(root, "index.html")), { headers });
};
const listen = (port: number) => Bun.serve({ port, fetch });
let server;
try {
  server = listen(Number(process.env.PORT) || 3000);
} catch {
  server = listen(0);
}
console.log(`xzor: serving http://localhost:${server.port}/ (Ctrl+C to stop)`);

const stop = () => {
  watch.kill();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await watch.exited;
server.stop(true);
process.exit(watch.exitCode ?? 0);
