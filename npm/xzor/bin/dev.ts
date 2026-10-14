// `xzor dev`, run by the launcher under Bun: `xzor build --watch`, a static server with the SPA fallback,
// and live reload: open pages reload after each successful build.
// argv: <xzor binary> [build options...]
import { resolve, sep } from "node:path";

const [exe, ...args] = process.argv.slice(2);
const root = process.cwd();
const watch = Bun.spawn([exe!, "build", "--watch", ...args], { stdio: ["inherit", "pipe", "inherit"] });

// Pages listening for rebuilds (Server-Sent Events).
const clients = new Set<ReadableStreamDefaultController<string>>();
let pending: ReturnType<typeof setTimeout> | undefined;
const reload = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    for (const c of clients) c.enqueue("data: reload\n\n");
  }, 50);
};

// The build output passes through; a written bundle (`.../dist/x.js`) means a successful build.
void (async () => {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of watch.stdout) {
    process.stdout.write(chunk);
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop()!;
    if (lines.some((l) => /[\\/]dist[\\/][^\\/]+\.js\s*$/.test(l))) reload();
  }
})();

const client = `<script>new EventSource("/__xzor/reload").onmessage = () => location.reload();</script>`;
// Never cached, so a reload always gets the latest build.
const headers = { "Cache-Control": "no-store" };
const html = async (file: string) =>
  new Response((await Bun.file(file).text()).replace(/<\/body>/i, `${client}</body>`), { headers: { ...headers, "Content-Type": "text/html;charset=utf-8" } });

const fetch = async (req: Request) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/__xzor/reload") {
    let self: ReadableStreamDefaultController<string>;
    const stream = new ReadableStream<string>({
      start(c) {
        self = c;
        clients.add(c);
        c.enqueue(": connected\n\n");
      },
      cancel() {
        clients.delete(self);
      },
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
  }
  const path = resolve(root, "." + decodeURIComponent(pathname));
  if (path.startsWith(root + sep)) {
    const file = Bun.file(path);
    if (await file.exists()) return path.endsWith(".html") ? html(path) : new Response(file, { headers });
  }
  // Unknown paths are client routes: the app routes them itself.
  return html(resolve(root, "index.html"));
};
// No idle timeout: the reload stream stays open for as long as the page does.
const listen = (port: number) => Bun.serve({ port, fetch, idleTimeout: 0 });
let server;
try {
  server = listen(Number(process.env.PORT) || 3000);
} catch {
  server = listen(0);
}
console.log(`xzor: serving http://localhost:${server.port}/ with live reload (Ctrl+C to stop)`);

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
