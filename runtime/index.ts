// xzor runtime: a component builds its DOM once (`render`, through the `dom` primitives of `dom.ts`), and
// bindings keep it current. This module holds the component lifecycle, routing state and the mount entry.

import { dom, markup, refreshPass, releaseDom, renderInto, type Markup } from "./dom";
import { changed, same as equal } from "./track";

/** @internal What generated code calls to build a component's DOM. */
export { dom, type El, type Markup } from "./dom";

/** One `@cascade:name(value)` provider; created on the region's first render and carried across the next ones. */
export type CascadeRecord = {
  name: string;
  value: unknown;
  fixed: boolean;
  consumers: Set<Component> | undefined;
  parent: CascadeRecord | undefined;
  /** Consumers hold the new value but are not told yet (`$cascade` with `hold`; `$release` tells them). */
  held: boolean;
};

const FIELDS = Symbol("xzor.fields");
type Watcher = { slot: number };

export const SVG = "http://www.w3.org/2000/svg";
/** Whether children of `parent` belong to the SVG namespace (`<foreignObject>` holds HTML). */
export const $inSvg = (parent: Node): boolean => (parent as Element).namespaceURI === SVG && parent.nodeName !== "foreignObject";

/** One entry of the generated `.xzor/routes.ts` table; `match` converts the path segments or rejects them. */
export type RouteEntry = {
  tag: string | undefined;
  pattern: string;
  /** The page's shortest pattern this one extends: routes of one family share the page instance. */
  family?: string;
  component: unknown;
  match: (s: string[]) => Record<string, unknown> | null;
};

/** The project's routes, in precedence order. */
export type RouteTable = readonly RouteEntry[];

/**
 * The state of the current navigation, published to the routes block and as the cascading value `route`.
 * `Tags` maps each route tag to its params; the generated table fixes it (`AppRoute`) so `is` checks tags.
 */
export class Route<P = Record<string, unknown>, Tags extends object = Record<string, Record<string, unknown>>> {
  readonly #nav: Navigation;

  constructor(
    readonly path: string,
    readonly tag: (keyof Tags & string) | undefined,
    readonly params: P,
    readonly query: URLSearchParams,
    readonly match: Record<string, string>,
    nav: Navigation,
  ) {
    this.#nav = nav;
  }

  /** Narrows `params` to the routes carrying `tag`. */
  is<K extends keyof Tags & string>(tag: K): this is Route<Tags[K], Tags> & { readonly tag: K } {
    return this.tag === tag;
  }

  /** Navigates through the browser's history. */
  navigate(url: string, opts?: { replace?: boolean }): void {
    this.#nav.navigate(url, opts?.replace === true);
  }
}

/** The `route` a kept `dom.routesAt` section reads: always its block's current one. */
class CurrentRoute {
  readonly #router: Router;
  constructor(router: Router) {
    this.#router = router;
  }
  get path(): string {
    return this.#router.route!.path;
  }
  get tag(): string | undefined {
    return this.#router.route!.tag;
  }
  get params(): Record<string, unknown> {
    return this.#router.route!.params;
  }
  get query(): URLSearchParams {
    return this.#router.route!.query;
  }
  get match(): Record<string, string> {
    return this.#router.route!.match;
  }
  navigate(url: string, opts?: { replace?: boolean }): void {
    this.#router.route!.navigate(url, opts);
  }
}
// `is` and `instanceof Route` come from Route.
Object.setPrototypeOf(CurrentRoute.prototype, Route.prototype);

/** @internal The route object a `dom.routesAt` block gives its sections. */
export const $currentRoute = (router: Router): Route => new CurrentRoute(router) as unknown as Route;

/** One section of a `@Routes` block, rendering `F`; xzor emits these in source order. */
type Section<F> =
  | { kind: "tag"; tag: string; render: (route: Route, page: F) => F }
  | { kind: "regex"; re: RegExp; page: boolean; render: (route: Route, page: F) => F }
  | {
      kind: "pattern";
      match: (segments: string[]) => Record<string, string> | null;
      page: boolean;
      render: (route: Route, page: F) => F;
    }
  | { kind: "notFound"; render: (route: Route) => F }
  | { kind: "catch"; render: (route: Route, error: unknown) => F }
  | { kind: "default"; render: (route: Route, page: F) => F };

/** A section of a `@Routes` block, rendered by `dom.routesAt`. */
export type RouteSection = Section<Markup>;

/** How navigation reaches the browser's history; `setNavigationForTests` swaps it. */
export type Navigation = {
  current(): URL;
  navigate(url: string, replace: boolean): void;
  subscribe(fn: () => void): () => void;
  /** Like `subscribe`, without taking over link clicks (a `NavLink` only watches). Defaults to `subscribe`. */
  observe?(fn: () => void): () => void;
};

// One set for the whole page: the listeners below exist only while a routes block is mounted.
const navigated = new Set<() => void>();
// NavLinks: notified like routes blocks, but they never intercept clicks.
const observers = new Set<() => void>();
const EXTERNAL = /(^|\s)external(\s|$)/;
let transitions = false;

/** Commits each navigation inside `document.startViewTransition` where the browser has it. */
export function viewTransitions(on: boolean): void {
  transitions = on;
}

let transitionCap = 1500;

/** @internal The longest a view transition waits for a page's data, in ms; `undefined` restores 1500. */
export function setTransitionCapForTests(ms: number | undefined): void {
  transitionCap = ms ?? 1500;
}

function notifyNavigated(): void {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<unknown> } };
  // `ready` rejects when the browser skips the animation (a hidden tab, a newer navigation): the update still ran.
  if (transitions && doc.startViewTransition) doc.startViewTransition(commitTransition).ready.catch(noop);
  else notifyAll();
}

// Set only while a transition's update runs: the pending async hooks of the pages it commits.
let awaiting: Promise<void>[] | undefined;

/** The browser captures the new view when this resolves: wait (up to the cap) for the new page's data. */
function commitTransition(): Promise<unknown> | undefined {
  const list = (awaiting = []);
  try {
    notifyAll();
  } finally {
    awaiting = undefined;
  }
  if (!list.length) return undefined;
  let timer: ReturnType<typeof setTimeout>;
  const cap = new Promise((done) => (timer = setTimeout(done, transitionCap)));
  return Promise.race([Promise.allSettled(list), cap]).finally(() => clearTimeout(timer));
}

function notifyAll(): void {
  for (const fn of [...navigated]) fn();
  for (const fn of [...observers]) fn();
}

const onPopState = (): void => notifyNavigated();

function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const anchor = (e.target as Element | null)?.closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || href == null || href.startsWith("#")) return;
  const frame = anchor.getAttribute("target");
  if ((frame !== null && frame !== "_self") || anchor.hasAttribute("download")) return;
  const rel = anchor.getAttribute("rel");
  if (rel !== null && EXTERNAL.test(rel)) return;
  // `<base href>` is what the browser resolves a relative link against, so the router has to agree.
  const url = new URL(href, document.baseURI);
  if (url.origin !== location.origin) return;
  // Moving inside the page the user is already on is the browser's job, not a navigation.
  if (url.hash !== "" && url.pathname === location.pathname && url.search === location.search) return;
  e.preventDefault();
  browserNavigation.navigate(url.href, false);
}

// Renders read the current URL every time; it is only parsed again once the address changed.
let currentUrl: URL | undefined;

const browserNavigation: Navigation = {
  current: () => (currentUrl?.href === location.href ? currentUrl : (currentUrl = new URL(location.href))),
  navigate(url, replace) {
    const href = new URL(url, document.baseURI).href;
    if (replace) history.replaceState(null, "", href);
    else history.pushState(null, "", href);
    notifyNavigated();
  },
  subscribe(fn) {
    navigated.add(fn);
    if (navigated.size === 1) {
      if (observers.size === 0) window.addEventListener("popstate", onPopState);
      document.addEventListener("click", onLinkClick);
    }
    return () => {
      navigated.delete(fn);
      if (navigated.size === 0) {
        if (observers.size === 0) window.removeEventListener("popstate", onPopState);
        document.removeEventListener("click", onLinkClick);
      }
    };
  },
  observe(fn) {
    observers.add(fn);
    if (observers.size === 1 && navigated.size === 0) window.addEventListener("popstate", onPopState);
    return () => {
      observers.delete(fn);
      if (observers.size === 0 && navigated.size === 0) window.removeEventListener("popstate", onPopState);
    };
  },
};

let testNavigation: Navigation | undefined;

/** @internal Swaps in a memory navigation; set it before mounting the routes block. */
export function setNavigationForTests(nav: Navigation | undefined): void {
  testNavigation = nav;
}

const navigationOf = (): Navigation => testNavigation ?? browserNavigation;

/** @internal What one mounted routes block keeps between renders. */
export type Router = {
  // Also what `route.navigate` uses.
  nav: Navigation;
  off: (() => void) | undefined;
  onError: ((err: unknown, nav: number) => void) | undefined;
  caught: Extract<Section<any>, { kind: "catch" }> | undefined;
  // Renders the block again: after a navigation, or once the page failed.
  refresh: () => void;
  href: string;
  // Counts the navigations this block has resolved; a failure stamped with an older one is stale.
  id: number;
  route: Route | undefined;
  // Index into the sections of the current render, or -1.
  section: number;
  page: RouteEntry | undefined;
  params: Record<string, unknown>;
  error: unknown;
  failed: boolean;
};

function segmentsOf(pathname: string): string[] {
  const rest = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return rest === "" ? [] : rest.split("/");
}

let baseFor: string | undefined;
let base = "";

/** The path of `<base href>` without its last segment: "" without one, "/docs" under `<base href="/docs/">`. */
export function basePath(): string {
  const uri = document.baseURI;
  if (uri !== baseFor) {
    baseFor = uri;
    const path = document.querySelector("base[href]") ? new URL(uri).pathname : "/";
    base = path.slice(0, path.lastIndexOf("/"));
  }
  return base;
}

/** The pathname routes match: relative to `basePath()`, starting with `/`. */
function routePath(pathname: string): string {
  const b = basePath();
  return b !== "" && (pathname === b || pathname.startsWith(`${b}/`)) ? pathname.slice(b.length) || "/" : pathname;
}

/** The section's named groups, or null; `lastIndex` is reset in case the regex carries `g` or `y`. */
function groupsOf(re: RegExp, pathname: string): Record<string, string> | null {
  re.lastIndex = 0;
  const m = re.exec(pathname);
  return m ? (m.groups ?? {}) : null;
}

/** @internal A routes block's state, subscribed to navigation; `refresh` renders the block again. */
export function $router(sections: readonly Section<any>[], refresh: () => void): Router {
  const nav = navigationOf();
  const router: Router = {
    nav,
    off: undefined,
    onError: undefined,
    caught: sections.find((s) => s.kind === "catch") as Router["caught"],
    refresh,
    href: "",
    id: 0,
    route: undefined,
    section: -1,
    page: undefined,
    params: {},
    error: undefined,
    failed: false,
  };
  if (router.caught) {
    // The page's own failures reach this one handler; one raised by a page we left is dropped.
    router.onError = (err, id) => {
      if (id !== router.id) return;
      router.error = err;
      router.failed = true;
      queueMicrotask(refresh);
    };
  }
  // A navigation raised while something renders (a page redirecting itself) waits for that render to end.
  router.off = nav.subscribe(() => (depth === 0 ? refresh() : queueMicrotask(refresh)));
  return router;
}

/** @internal Resolves the route again when the URL moved (clearing the last page's error); whether it did. */
export function $resolve(router: Router, table: RouteTable, sections: readonly Section<any>[]): boolean {
  const url = router.nav.current();
  if (url.href === router.href && router.route) return false;
  router.failed = false;
  router.error = undefined;
  resolveRoute(router, table, sections, url);
  return true;
}

/** Spec order: a page route picks among the `(page)` sections, otherwise the page-less ones decide. */
function resolveRoute(router: Router, table: RouteTable, sections: readonly Section<any>[], url: URL): void {
  const path = routePath(url.pathname);
  const segments = segmentsOf(path);
  let page: RouteEntry | undefined;
  let params: Record<string, unknown> | null = null;
  for (const entry of table) {
    params = entry.match(segments);
    if (params) {
      page = entry;
      break;
    }
  }
  let section = -1;
  let match: Record<string, string> = {};
  for (let i = 0; i < sections.length && section < 0; i++) {
    const s = sections[i]!;
    if (page) {
      if (s.kind === "tag") {
        if (s.tag === page.tag) section = i;
      } else if (s.kind === "regex" && s.page) {
        const groups = groupsOf(s.re, path);
        if (groups) {
          section = i;
          match = groups;
        }
      } else if (s.kind === "pattern" && s.page) {
        const own = s.match(segments);
        if (own) {
          section = i;
          // The page keeps the table's converted params; the pattern only decides that this section applies.
          match = own;
        }
      }
    } else if (s.kind === "regex" && !s.page) {
      const groups = groupsOf(s.re, path);
      if (groups) {
        section = i;
        match = groups;
      }
    } else if (s.kind === "pattern" && !s.page) {
      const own = s.match(segments);
      if (own) {
        section = i;
        params = own;
      }
    }
  }
  if (section < 0) section = sections.findIndex((s) => s.kind === (page ? "default" : "notFound"));
  router.href = url.href;
  router.id++;
  router.page = page;
  router.params = params ?? {};
  router.section = section;
  router.route = new Route(path, page?.tag, router.params, url.searchParams, match, router.nav);
}

type Ctor<C extends Component> = new (...args: any[]) => C;

/** Builds components that need injected services; generated by xzor from `@Run` and `@ServiceProvider`. */
export interface IApplication {
  onStarted?(): void | Promise<void>;
  /** Consulted only for component classes with a non-empty `static inject`; returns the component, a promise for it, or `undefined` (the runtime then throws). */
  createComponent?(type: Function): Component | Promise<Component> | undefined;
}

/** A contract as browser code sees it: every method's result `R` becomes `Promise<Awaited<R>>`, other members `never`. */
export type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** Thrown from an endpoint to answer with `status`; a generated client throws it for a non-2xx answer. */
export class HttpError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message);
  }
}

/** One request of a generated contract client: 404 and an empty body resolve `undefined`, other non-2xx statuses reject with `HttpError`. */
export async function call(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown): Promise<unknown> {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const key in query) {
      const value = query[key];
      if (value !== undefined) params.append(key, String(value));
    }
    const search = params.toString();
    if (search) url += "?" + search;
  }
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 404 || res.status === 204) return undefined;
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

/** A path parameter of a generated client, encoded; `""`, `.` and `..` throw `HttpError(400)` before any request (URL normalization would turn them into another route). */
export function segment(value: string | number | boolean): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") throw new HttpError(400, `invalid path parameter ${JSON.stringify(text)}`);
  return encodeURIComponent(text);
}

const noop = () => {};
const SELECTOR = /[#.[]/;

// Errors from fire-and-forget promises must not vanish; throwing from a microtask reports them.
const rethrow = (err: unknown): void =>
  queueMicrotask(() => {
    throw err;
  });

function surface(result: unknown): void {
  if (result instanceof Promise) result.catch(rethrow);
}
// Projects on the ES2022 lib have no `Symbol.dispose` typing.
type DisposeSymbols = { dispose: symbol; asyncDispose: symbol };
const wellKnown = Symbol as unknown as DisposeSymbols;

/** @internal Engines without explicit resource management get the registry symbols that TypeScript's downlevel helpers use. */
export function polyfillDisposeSymbols(target: Partial<DisposeSymbols>): void {
  target.dispose ??= Symbol.for("Symbol.dispose");
  target.asyncDispose ??= Symbol.for("Symbol.asyncDispose");
}
// Runs before any generated provider's class body evaluates `[Symbol.dispose]`, since providers import this module.
polyfillDisposeSymbols(wellKnown);
type ServiceDecorator = {
  <T>(impl: new (...a: any[]) => T): ClassDecorator;
  <T>(key: string, factory: (...a: any[]) => T | Promise<T>): ClassDecorator;
};

export const ServiceProvider = (): ClassDecorator => noop;
type RunDecorator = {
  /** Browser app: mounts `component` on `target`. */
  (component: Function, target: string): ClassDecorator;
  /** Server app with a page shell. */
  (component: Function): ClassDecorator;
  /** Server app, API only. */
  (): ClassDecorator;
};
export const Run: RunDecorator = () => noop;
export const Import = (..._providers: Function[]): ClassDecorator => noop;
export const Singleton: ServiceDecorator = () => noop;
export const Scoped: ServiceDecorator = () => noop;
export const Transient: ServiceDecorator = () => noop;
export const SharedInstance: unique symbol = Symbol("xzor.sharedInstance");

/** Markup held as a value (Blazor's RenderFragment); render it with `@member`. */
export type RenderFragment = Markup;
export type Renderer = RenderFragment;

/** A component event; invoking it re-renders the component that passed it in. */
export type EventCallback<T = void> = (arg: T) => unknown;

/** The DOM element type for a tag name, as `document.createElement` would return it. */
export type ElementOf<T extends string> = T extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[T]
  : T extends keyof SVGElementTagNameMap
    ? SVGElementTagNameMap[T]
    : HTMLElement;

/** A pending `@bind:debounce` write, on the input it came from. */
type Debounced = { timer: ReturnType<typeof setTimeout>; settle: (value: unknown) => void };
const DEBOUNCED = Symbol("xzor.debounced");
const NO_SLOTS: {} = Object.freeze({});

/**
 * Base of every component. A `.xzor` component's fields are tracked like a model's (the bundle rewrites them), so a
 * handler that writes one updates what reads it; `stateHasChanged()` re-runs every binding.
 */
export abstract class Component {
  #subs: Watcher[] | undefined;
  /** @internal Set by components that use `@leave`: until then, removal skips the `data-leave` check. */
  static $leaves = false;

  /** @internal What tracked getters report to, set by the bindings (and the model tracker) while they run; the bundle emits `Component.$reader?.(this, i)`. */
  static $reader: ((source: object, index: number) => void) | undefined = undefined;

  /** Values a tracked field considers the same: dates by time, arrays and plain objects deeply, models by identity. */
  static readonly same: (a: unknown, b: unknown) => boolean = equal;

  /** @internal Records a class's tracked fields after its base's; where they start is the class's `$at`. */
  static $define(cls: Function, names: string[]): number {
    const counts = cls as unknown as Record<symbol, number | undefined>;
    const at = counts[FIELDS] ?? 0;
    counts[FIELDS] = at + names.length;
    Object.defineProperty(cls, "$at", { value: at });
    return at;
  }

  /** @internal */
  $watch(dep: object): void {
    const subs = (this.#subs ??= []);
    (dep as Watcher).slot = subs.length;
    subs.push(dep as Watcher);
  }

  /** @internal */
  $unwatch(dep: object): void {
    const subs = this.#subs;
    if (subs === undefined || subs.length === 0) return;
    const last = subs.pop()!;
    if (last !== dep) {
      subs[(dep as Watcher).slot] = last;
      last.slot = (dep as Watcher).slot;
    }
  }

  /** @internal What a tracked setter reports once it stored a different value. */
  protected $changed(index: number, _previous: unknown): void {
    const subs = this.#subs;
    if (subs !== undefined) for (let i = 0; i < subs.length; i++) changed(subs[i]!, index);
  }

  /** Markup as a value (a `RenderFragment`); xzor emits this for markup used as one. Its handlers run in `owner`'s context (else the component building now). */
  static fragment(build: (parent: Node) => void, owner?: Component): Markup {
    return markup(build, owner);
  }

  /** Reads a bound input's new value, converted to the bound field's current type. */
  static bindValue<T>(e: Event, current: T): T {
    const input = e.target as HTMLInputElement;
    if (typeof current === "boolean") return input.checked as T;
    if (typeof current === "number") return Number(input.value) as T;
    return input.value as T;
  }

  /**
   * `@bind:debounce`: runs `run` once input on `e`'s target pauses for `ms`. Each call's promise settles: the
   * last with what `run` returns, the ones it replaced with `undefined`.
   */
  static debounce<T>(e: Event, ms: number, run: () => T): Promise<Awaited<T> | undefined> {
    const target = e.target as unknown as Record<symbol, Debounced | undefined>;
    const prev = target[DEBOUNCED];
    if (prev !== undefined) {
      clearTimeout(prev.timer);
      prev.settle(undefined);
    }
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        target[DEBOUNCED] = undefined;
        settle(run() as Awaited<T>);
      }, ms);
      target[DEBOUNCED] = { timer, settle: settle as (v: unknown) => void };
    });
  }

  /** Content the parent passed for each `@slot`; xzor declares the exact type per component. */
  slots: {} = NO_SLOTS;
  // A mounted component is its own binding holder and context; one fixed set of fields, so one shape.
  /** @internal Its root bindings. */
  $bindings: unknown = undefined;
  /** @internal Itself: the context its bindings and handlers run in. */
  $ctx: Component = this;
  /** @internal Its first node (a comment) when mounted as a root or `@cached`. */
  $start: Comment | undefined = undefined;
  /** @internal The comment its DOM ends before, while mounted. */
  $end: Comment | undefined = undefined;
  /** @internal */
  $app: IApplication | undefined = undefined;
  /** @internal The cascade scope it was mounted in. */
  $scope: unknown = undefined;
  /** @internal Its bindings that read nothing tracked, created on first use. */
  $loose: unknown[] | undefined = undefined;
  /** @internal */
  $sweep = false;
  /** @internal Its cached getters, by `dom.memo` index. */
  $memos: unknown[] | undefined = undefined;
  /** @internal The render pass that last refreshed its parameters. */
  $pass = 0;

  /** Builds this component's DOM into `parent`; xzor generates it from the template. */
  protected abstract render(parent: Node): void;

  // Lifecycle, in Blazor's order. `...Async` results re-render the component when they settle.
  protected onInitialized(): void {}
  protected onInitializedAsync(): Promise<void> | void {}
  protected onParametersSet(): void {}
  protected onParametersSetAsync(): Promise<void> | void {}
  protected onAfterRender(_firstRender: boolean): void {}
  protected onAfterRenderAsync(_firstRender: boolean): Promise<void> | void {}
  protected shouldRender(): boolean {
    return true;
  }
  /** Called when the component leaves the tree. */
  protected dispose(): void {}

  /** Re-renders this component. Event handlers it owns do this automatically. */
  stateHasChanged(): void {
    update(this);
  }
}

/** @deprecated use `Component`. */
export const ComponentBase = Component;
/** @deprecated use `Component`. */
export type ComponentBase = Component;

type Hooks = {
  onInitialized(): void;
  onInitializedAsync(): Promise<void> | void;
  onParametersSet(): void;
  onParametersSetAsync(): Promise<void> | void;
  onAfterRender(first: boolean): void;
  onAfterRenderAsync(first: boolean): Promise<void> | void;
  shouldRender(): boolean;
  dispose(): void;
};

const hooks = (c: Component) => c as unknown as Hooks;

// After-render hooks wait until the outermost render pass has touched the DOM.
let depth = 0;
let pass = 0;
const afterRender: Component[] = [];
const afterFirst: boolean[] = [];

/** Starts a pass; what `close` takes. */
function open(): number {
  if (depth++ !== 0) return -1;
  pass++;
  return afterRender.length;
}

// The outermost pass runs the hooks queued since it opened; a pass a hook starts runs its own, then truncates back.
function close(mark: number): void {
  if (--depth !== 0) return;
  try {
    for (let i = mark; i < afterRender.length; i++) {
      const c = hooks(afterRender[i]!);
      const first = afterFirst[i]!;
      c.onAfterRender(first);
      void c.onAfterRenderAsync(first);
    }
  } finally {
    afterRender.length = afterFirst.length = mark;
  }
}

function batch(fn: () => void): void {
  const mark = open();
  try {
    fn();
  } finally {
    close(mark);
  }
}

function settle(component: Component, result: Promise<void> | void, node?: Failing): void {
  if (!(result instanceof Promise)) return;
  const outer = awaiting;
  const done = result.then(
    () => (outer ? collect(() => update(component)) : update(component)),
    node?.onError && ((err: unknown) => fail(node, err)),
  );
  // `done` resolves after the update and the hooks it starts, so the transition captures the rendered data; errors are still reported.
  if (outer) outer.push(done.then(noop, rethrow));
  else void done;
}

/** Runs `fn` collecting the async hooks it starts, for a transition still waiting; resolves when they settle. */
function collect(fn: () => void): Promise<unknown> {
  const started: Promise<void>[] = [];
  const prev = awaiting;
  awaiting = started;
  try {
    fn();
  } finally {
    awaiting = prev;
  }
  return Promise.allSettled(started);
}

/** What `@catch` reports a failure through: a routed page's child binding. */
type Failing = { onError?: ((err: unknown, nav: number) => void) | undefined; nav?: number | undefined };

/** `@catch`: the failure is reported with the navigation the page belongs to, so a late one can be dropped. */
function fail(v: Failing, err: unknown): void {
  if (v.onError) v.onError(err, v.nav ?? 0);
  else rethrow(err);
}

function parametersSet(component: Component): void {
  hooks(component).onParametersSet();
  settle(component, hooks(component).onParametersSetAsync());
}

/** `static cascades` on a component class: one `[property, cascade name]` pair per `@Cascade` member. */
type CascadeList = readonly (readonly [prop: string, name: string])[];

const cascadesOf = (type: Function): CascadeList | undefined => (type as { cascades?: CascadeList }).cascades;

const fields = (c: Component) => c as unknown as Record<string, unknown>;

function findCascade(scope: CascadeRecord | undefined, name: string): CascadeRecord | undefined {
  for (let s = scope; s; s = s.parent) if (s.name === name) return s;
  return undefined;
}

/** Gives each `@Cascade` member the nearest provider's value and subscribes to later changes. */
function resolveCascades(instance: Component, scope: CascadeRecord | undefined): void {
  // The instance's class, not the vnode's type: a lazy component's type is its loader.
  const list = cascadesOf(instance.constructor);
  if (!list) return;
  for (const [prop, name] of list) {
    const record = findCascade(scope, name);
    if (!record) continue;
    fields(instance)[prop] = record.value;
    // Several members may share one name; the set keeps one entry per instance, in subscription order.
    if (!record.fixed) (record.consumers ??= new Set()).add(instance);
  }
}

function unsubscribeCascades(instance: Component, scope: CascadeRecord | undefined): void {
  const list = cascadesOf(instance.constructor);
  if (!list) return;
  for (const [, name] of list) findCascade(scope, name)?.consumers?.delete(instance);
}

// Assigning before the region's children are patched lets a consumer whose props also changed
// render once with both; the leftovers are told afterwards.
function assignCascade(record: CascadeRecord, consumers: readonly Component[]): void {
  for (const consumer of consumers) {
    for (const [prop, name] of cascadesOf(consumer.constructor)!) {
      if (name === record.name) fields(consumer)[prop] = record.value;
    }
  }
}

// A changed cascade takes the same path as a changed prop: onParametersSet, then re-render.
function notifyCascade(consumers: readonly Component[]): void {
  for (const consumer of consumers) {
    if (consumer.$pass === pass) continue;
    consumer.$pass = pass;
    try {
      parametersSet(consumer);
      update(consumer);
    } catch (err) {
      // One consumer's failure must not keep the rest from seeing the new value.
      rethrow(err);
    }
  }
}

/**
 * @internal A `dom.cascadeAt` value ran: a change reaches the consumers as it does through a patch. With `hold`
 * (a whole pass is about to re-run the region) they are only assigned: `$release` tells those the pass gave none.
 */
export function $cascade(record: CascadeRecord, value: unknown, hold = false): void {
  if (Object.is(record.value, value)) return;
  record.value = value;
  if (!record.consumers?.size) return;
  assignCascade(record, [...record.consumers]);
  if (hold) record.held = true;
  else $release(record);
}

/** @internal The pass re-ran the region `$cascade` held: the consumers it gave no pass are told. */
export function $release(record: CascadeRecord): void {
  record.held = false;
  if (record.consumers?.size) batch(() => notifyCascade([...record.consumers!]));
}

/**
 * @internal One pass that gives `record` a new value around `run` (which rebuilds part of the cascade): the
 * consumers are assigned first, and those `run` gave no pass are told afterwards, as a patch does.
 */
export function $recascade(record: CascadeRecord, value: unknown, run: () => void): void {
  batch(() => {
    const consumers = !Object.is(record.value, value) && record.consumers?.size ? [...record.consumers] : undefined;
    record.value = value;
    if (consumers !== undefined) assignCascade(record, consumers);
    run();
    if (consumers !== undefined) notifyCascade(consumers);
  });
}

function queueAfterRender(component: Component, first: boolean): void {
  afterRender.push(component);
  afterFirst.push(first);
}

function update(component: Component): void {
  const end = component.$end;
  // Not mounted, or kept detached (`@cached`): nothing to show it in.
  if (end === undefined || end.parentNode === null || !hooks(component).shouldRender()) return;
  const mark = open();
  try {
    refreshPass(component);
    queueAfterRender(component, false);
  } finally {
    close(mark);
  }
}

const LAZY = Symbol("xzor.lazy");
type Lazy = { [LAZY]: () => Promise<Ctor<Component>>; loaded: Ctor<Component> | undefined };

/**
 * A component loaded on first use (a chunk of its own in a split bundle). It stands for the class in the
 * tree: an anchor holds its place until the module arrives, and later uses construct it at once.
 */
export function lazy<C>(load: () => Promise<{ default: C }>): C {
  let pending: Promise<Ctor<Component>> | undefined;
  const stub: Lazy = {
    [LAZY]: () => (pending ??= load().then((m) => (stub.loaded = m.default as Ctor<Component>))),
    loaded: undefined,
  };
  return stub as unknown as C;
}

function construct(type: Ctor<Component>, app: IApplication | undefined): Component | Promise<Component> {
  const load = (type as Partial<Lazy>)[LAZY];
  if (load !== undefined) {
    const loaded = (type as unknown as Lazy).loaded;
    return loaded !== undefined ? construct(loaded, app) : load().then((c) => construct(c, app));
  }
  const inject = (type as { inject?: readonly string[] }).inject;
  if (!inject?.length) return new type();
  const made = app?.createComponent?.(type);
  if (made) return made;
  if (app) throw new Error(`xzor: ${type.name} is not registered with the application`);
  throw new Error(`xzor: ${type.name} needs injected services (${inject.join(", ")}) but has no application`);
}

function disposeInstance(c: Component): void {
  hooks(c).dispose();
  const d = c as unknown as Record<symbol, (() => unknown) | undefined>;
  d[wellKnown.dispose]?.();
  surface(d[wellKnown.asyncDispose]?.());
}

/** @internal A child component binding's state (`dom.component`). */
export type Child = {
  type: Ctor<Component>;
  end: Comment;
  /** The parent: its application. */
  ctx: Component;
  /** The cascade scope where it is. */
  scope: CascadeRecord | undefined;
  props: Record<string, unknown> | undefined;
  /** A row's (`dom.componentItem`) are given by its item. */
  statics: Record<string, unknown> | ((item: any) => Record<string, unknown>) | undefined;
  slots: object | ((item: any) => object) | undefined;
  ref: ((c: Component) => void) | undefined;
  key: unknown;
  onError: ((err: unknown, nav: number) => void) | undefined;
  nav: number | undefined;
  instance: Component | undefined;
  phase: number;
  /** A list row's item (`dom.componentItem`). */
  item: unknown;
};

const NEW = 0;
const WAITING = 1;
const LIVE = 2;
const FAILED = 3;
const GONE = 4;

/**
 * A constructed component's lifecycle up to its first build: its DOM, in a fragment. `end` is the comment it ends
 * before (a child binding's anchor); a root (`null`) gets its own comments.
 */
function build(c: Component, app: IApplication | undefined, scope: unknown, end: Comment | null, node?: Failing): DocumentFragment {
  const h = hooks(c);
  h.onInitialized();
  settle(c, h.onInitializedAsync(), node);
  parametersSet(c);
  c.$app = app;
  c.$scope = scope;
  c.$pass = pass;
  const frag = document.createDocumentFragment();
  // Only roots and `@cached` ones get a start comment: keeping needs their range.
  if (end === null || (c.constructor as { cached?: boolean }).cached === true) c.$start = frag.appendChild(document.createComment(""));
  renderInto(c, frag);
  c.$end = end ?? frag.appendChild(document.createComment(""));
  queueAfterRender(c, true);
  return frag;
}

/** @internal A child binding ran: mounts its component the first time, then gives it its props again; `moved`: a routed page's navigation moved on. */
export function $child(s: Child, props: Record<string, unknown>, moved = false): void {
  const c = s.instance;
  if (c === undefined) {
    if (s.phase === WAITING) s.props = props;
    else if (s.phase === NEW) createChild(s, props);
    return;
  }
  // As `patch`: all assigned (a child's own write gives way); an object counts as changed; slots always give a pass.
  let changed = moved || s.slots !== undefined;
  const old = s.props!;
  s.props = props;
  for (const key in props) {
    const value = props[key];
    if (!changed && (!Object.is(old[key], value) || (typeof value === "object" && value !== null))) changed = true;
    fields(c)[key] = value;
  }
  s.ref?.(c);
  if (!changed) return;
  const mark = open();
  try {
    c.$pass = pass;
    parametersSet(c);
    update(c);
  } finally {
    close(mark);
  }
}

/** @internal A child binding went: disposes its component, or keeps a `@cached` one detached. */
export function $dropChild(s: Child): void {
  const c = s.instance;
  s.instance = undefined;
  s.phase = GONE;
  if (c === undefined) return;
  unsubscribeCascades(c, c.$scope as CascadeRecord | undefined);
  if ((c.constructor as { cached?: boolean }).cached === true) return keepChild(s, c);
  releaseDom(c);
  c.$end = undefined;
  disposeInstance(c);
}

function createChild(s: Child, props: Record<string, unknown>): void {
  s.props = props;
  if (reviveChild(s)) return;
  const mark = open();
  try {
    let made: Component | Promise<Component>;
    if (s.onError === undefined) made = construct(s.type, s.ctx.$app);
    else
      try {
        made = construct(s.type, s.ctx.$app);
      } catch (err) {
        s.phase = FAILED;
        return fail(s, err);
      }
    if (made instanceof Promise) return wait(s, made);
    if (s.onError === undefined) return start(s, made);
    try {
      start(s, made);
    } catch (err) {
      abandon(s, made, err);
    }
  } finally {
    close(mark);
  }
}

function assign(s: Child, c: Component): void {
  if (s.statics !== undefined) Object.assign(c, staticsOf(s));
  Object.assign(c, s.props);
  if (s.slots !== undefined) c.slots = slotsOf(s);
}

const staticsOf = (s: Child): Record<string, unknown> | undefined => (typeof s.statics === "function" ? s.statics(s.item) : s.statics);
const slotsOf = (s: Child): object => (typeof s.slots === "function" ? (s.slots as (item: unknown) => object)(s.item) : s.slots!);

/** @internal A row child's item was replaced under the same key: its callbacks and slot fills are given again. */
export function $childItem(s: Child, item: unknown): void {
  s.item = item;
  const c = s.instance;
  if (c === undefined) return;
  if (typeof s.statics === "function") Object.assign(c, s.statics(item));
  if (typeof s.slots === "function") c.slots = (s.slots as (item: unknown) => object)(item);
}

function start(s: Child, c: Component): void {
  const scope = s.scope;
  s.instance = c;
  s.phase = LIVE;
  assign(s, c);
  resolveCascades(c, scope as CascadeRecord | undefined);
  s.ref?.(c);
  const frag = build(c, s.ctx.$app, scope, s.end, s);
  s.end.parentNode!.insertBefore(frag, s.end);
}

// `@catch`: the nodes of the failed build never reached the DOM, so only the anchor stays.
function abandon(s: Child, c: Component, err: unknown): void {
  const mine = s.instance === c;
  if (mine) {
    s.instance = undefined;
    s.phase = FAILED;
    unsubscribeCascades(c, s.scope);
  }
  // The failure first: a dispose error after it must not hide it.
  fail(s, err);
  if (mine) {
    try {
      releaseDom(c);
    } catch (disposeErr) {
      rethrow(disposeErr);
    }
    c.$end = undefined;
  }
}

function wait(s: Child, made: Promise<Component>): void {
  s.phase = WAITING;
  // Inside a transition's update, the chunk and the hooks of the page that arrives with it are awaited too.
  const outer = awaiting;
  const arrived = made.then(
    (c) => (outer ? collect(() => arriveChild(s, c)) : arriveChild(s, c)),
    (err) => {
      if (s.phase === WAITING) {
        s.phase = FAILED;
        fail(s, err);
      } else if (!s.onError) rethrow(err);
    },
  );
  if (outer) outer.push(arrived.then(noop));
}

function arriveChild(s: Child, c: Component): void {
  // Removed before arrival, or its anchor detached without a dispose.
  if (s.phase !== WAITING || s.end.parentNode === null) {
    if (s.phase === WAITING) s.phase = GONE;
    disposeInstance(c);
    return;
  }
  const mark = open();
  try {
    start(s, c);
  } catch (err) {
    abandon(s, c, err);
  }
  // An after-render hook that throws leaves the component mounted; the error is reported, not thrown into the promise.
  try {
    close(mark);
  } catch (err) {
    fail(s, err);
  }
}

// `@cached` children that left, by type and key, with their nodes (detached).
const keptChildren = new WeakMap<Function, Map<unknown, { instance: Component; nodes: Node[] }>>();
let keptChildCount = 0;

function keepChild(s: Child, c: Component): void {
  const nodes: Node[] = [];
  for (let n: Node | null = c.$start!; n !== null && n !== c.$end; n = n.nextSibling) nodes.push(n);
  let byKey = keptChildren.get(s.type);
  if (byKey === undefined) keptChildren.set(s.type, (byKey = new Map()));
  if (!byKey.has(s.key)) keptChildCount++;
  byKey.set(s.key, { instance: c, nodes });
}

function reviveChild(s: Child): boolean {
  if (keptChildCount === 0) return false;
  const byKey = keptChildren.get(s.type);
  const old = byKey?.get(s.key);
  if (old === undefined) return false;
  byKey!.delete(s.key);
  keptChildCount--;
  const c = old.instance;
  const scope = s.scope;
  c.$app = s.ctx.$app;
  c.$scope = scope;
  s.instance = c;
  s.phase = LIVE;
  assign(s, c);
  resolveCascades(c, scope as CascadeRecord | undefined);
  s.ref?.(c);
  const frag = document.createDocumentFragment();
  for (const node of old.nodes) frag.appendChild(node);
  c.$end = s.end;
  s.end.parentNode!.insertBefore(frag, s.end);
  const mark = open();
  try {
    c.$pass = pass;
    parametersSet(c);
    update(c);
  } finally {
    close(mark);
  }
  return true;
}

/**
 * @internal Removes `node`. A `data-leave` element gets `data-leaving` first and goes when the finite animations
 * that starts (in it and below) finish; with none, or removed again meanwhile, it goes at once.
 */
export function $leave(node: Node): void {
  const el = node as Element;
  if (!Component.$leaves || el.nodeType !== 1 || !el.hasAttribute("data-leave") || el.hasAttribute("data-leaving")) return void node.parentNode?.removeChild(node);
  type Running = { finished: Promise<unknown>; effect?: { getComputedTiming(): { endTime?: number | CSSNumericValue } } | null };
  const running = (): Running[] => (el as Partial<{ getAnimations(o?: object): Running[] }>).getAnimations?.({ subtree: true }) ?? [];
  // Animations already running (a spinner inside) aren't the leave's; an endless one would never let it go.
  const before = new Set(running());
  el.setAttribute("data-leaving", "");
  const animations = running().filter((a) => !before.has(a) && a.effect?.getComputedTiming().endTime !== Infinity);
  if (animations.length === 0) return void el.remove();
  const gone = (): void => el.remove();
  void Promise.all(animations.map((a) => a.finished)).then(gone, gone);
}

function resolveTarget(target: string | Element): Element {
  if (typeof target !== "string") return target;
  const found = SELECTOR.test(target) ? document.querySelector(target) : document.getElementById(target);
  if (!found) throw new Error(`xzor: mount target "${target}" not found`);
  return found;
}

/** `target` is an element, an element id, or a selector (anything containing `#`, `.` or `[`). */
export function mount<C extends Component>(type: Ctor<C>, target: string | Element, app?: IApplication): C {
  const host = resolveTarget(target);
  const root = construct(type, app);
  if (root instanceof Promise) throw new Error(`xzor: root component ${type.name} cannot be asynchronous`);
  const mark = open();
  try {
    host.replaceChildren(build(root, app, undefined, null));
  } finally {
    close(mark);
  }
  surface(app?.onStarted?.());
  return root as C;
}

/** An `<a>` that carries `activeClass` while the current URL is on its `href`; it follows navigation itself. */
export class NavLink extends Component {
  href = "";
  activeClass = "active";
  match: "prefix" | "exact" = "prefix";

  declare slots: { default?: () => RenderFragment };

  #path = "";
  // `href` resolved against the base URL, encoded like `location.pathname`; `null` for another origin.
  #for: string | undefined;
  #target: string | null = null;
  #off: (() => void) | undefined;

  protected override onInitialized(): void {
    const nav = navigationOf();
    this.#path = nav.current().pathname;
    const fn = () => {
      const path = nav.current().pathname;
      if (path === this.#path) return;
      this.#path = path;
      this.stateHasChanged();
    };
    this.#off = nav.observe ? nav.observe(fn) : nav.subscribe(fn);
  }

  protected override dispose(): void {
    this.#off?.();
  }

  #active(): boolean {
    if (this.#for !== this.href) {
      this.#for = this.href;
      const url = new URL(this.href, document.baseURI);
      this.#target = url.origin === location.origin ? url.pathname : null;
    }
    const target = this.#target;
    if (target === null) return false;
    const path = this.#path;
    // The root is every path's prefix, so it only ever matches exactly.
    if (this.match === "exact" || target === `${basePath()}/`) return path === target;
    return path === target || path.startsWith(target.endsWith("/") ? target : `${target}/`);
  }

  protected override render(__p: Node): void {
    const a = dom.el(__p, "a");
    dom.attr(a, "href", () => this.href);
    dom.attr(a, "class", () => (this.#active() ? this.activeClass : null));
    dom.attr(a, "aria-current", () => (this.#active() ? "page" : null));
    dom.slotAt(dom.anchors(a), () => this.slots.default);
  }
}
