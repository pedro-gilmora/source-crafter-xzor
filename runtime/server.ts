// Server-side helpers for xzor apps. Needs Bun's types (`@types/bun`).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./index";

/** A server app: `Bun.serve` options as members, all optional. (`Bun.Serve.Options` is a union, which an interface can't extend.) */
export interface IServerApplication extends Partial<Bun.Serve.HostnamePortServeOptions<undefined>> {
  fetch?: Bun.Serve.Handler<Request, Bun.Server<undefined>, Response>;
  routes?: Bun.Serve.Routes<undefined, string>;
}

type MethodDecorator = {
  (value: Function, context: ClassMethodDecoratorContext): void;
  (path?: string): (value: Function, context: ClassMethodDecoratorContext) => void;
};

const noop = () => {};
// Bare (`@Get`) is called with the method, called (`@Get(":slug")`) with the path; neither does anything at runtime.
const method: MethodDecorator = ((path?: unknown) => (typeof path === "function" ? undefined : noop)) as MethodDecorator;

/** Marks a class whose `@Get`/`@Post`/... methods become routes under `prefix`. */
export const Endpoints = (_prefix: string): ClassDecorator => noop;
export const Get: MethodDecorator = method;
export const Post: MethodDecorator = method;
export const Put: MethodDecorator = method;
export const Patch: MethodDecorator = method;
export const Delete: MethodDecorator = method;
export const Query: MethodDecorator = method;

export { HttpError };

/** `undefined`/`null` is 404, a `Response` passes through, anything else is JSON. */
export function reply(value: unknown): Response {
  if (value === undefined || value === null) return new Response(null, { status: 404 });
  if (value instanceof Response) return value;
  return Response.json(value);
}

/** `reply` of the resolved value; an `HttpError` becomes its status, other errors reject. */
export function replyAsync(value: Promise<unknown>): Promise<Response> {
  return value.then(reply, (e) => {
    if (e instanceof HttpError) return new Response(e.message, { status: e.status });
    throw e;
  });
}

interface Variant {
  etag: string;
  response: Response;
  notModified: Response;
}

const BIG = 1024 * 1024;
const IMMUTABLE = "public, max-age=31536000, immutable";

function variant(path: string, encoding: string | null, suffix: string, mime: string, cache: string, hash: string, bytes: Uint8Array | null): Variant {
  const etag = `"${hash}${suffix}"`;
  const headers: Record<string, string> = { "content-type": mime, "cache-control": cache, vary: "accept-encoding", etag };
  if (encoding) headers["content-encoding"] = encoding;
  const { "content-type": _type, ...revalidated } = headers;
  return {
    etag,
    response: new Response((bytes ?? Bun.file(path)) as BodyInit, { headers }),
    notModified: new Response(null, { status: 304, headers: revalidated }),
  };
}

/** Routes for files under `root` (paths relative to it, keyed by URL path), with precompressed `.br`/`.gz` siblings used when present. */
export function staticFiles(root: string, files: string[]): Record<string, (req: Request) => Response> {
  const routes: Record<string, (req: Request) => Response> = {};
  for (const file of files) {
    const url = "/" + file.replace(/\\/g, "/");
    const path = join(root, file);
    const mime = Bun.file(path).type;
    const cache = url.startsWith("/dist/chunks/") || url.endsWith(".woff2") || url.endsWith(".woff") ? IMMUTABLE : "no-cache";
    const raw = readFileSync(path);
    const hash = Bun.hash(raw).toString(16);
    const load = (sibling: string, encoding: string, suffix: string): Variant | undefined => {
      if (!existsSync(sibling)) return undefined;
      const bytes = readFileSync(sibling);
      return variant(sibling, encoding, suffix, mime, cache, hash, bytes.length > BIG ? null : bytes);
    };
    const plain = variant(path, null, "", mime, cache, hash, raw.length > BIG ? null : raw);
    const br = load(path + ".br", "br", "-br");
    const gz = load(path + ".gz", "gzip", "-gz");
    routes[url] = (req) => {
      const accepted = req.headers.get("accept-encoding");
      const chosen = accepted === null ? plain : (br && accepted.includes("br") && br) || (gz && accepted.includes("gzip") && gz) || plain;
      return (req.headers.get("if-none-match") === chosen.etag ? chosen.notModified : chosen.response).clone();
    };
  }
  return routes;
}
