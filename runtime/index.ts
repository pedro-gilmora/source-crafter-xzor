// xzor runtime: the RenderTreeBuilder that generated components call into, and a DOM
// renderer that re-renders one component at a time and patches only what changed.

type Handler = (e: Event) => unknown;
type Modifier = "preventDefault" | "stopPropagation";
type Modifiers = Partial<Record<Modifier, boolean>>;

export type VText = { kind: "text"; text: string; dom?: Text };

export type VElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  events: Record<string, Handler>;
  modifiers: Record<string, Modifiers>;
  children: VNode[];
  key?: unknown;
  ref?: (el: Element) => void;
  dom?: Element;
};

/** One `@cascade:name(value)` provider; created on the region's first render and carried across the next ones. */
type CascadeRecord = {
  name: string;
  value: unknown;
  fixed: boolean;
  consumers: Set<ComponentBase> | undefined;
  parent: CascadeRecord | undefined;
};

/** Output of one `@if`/`@for`/`@switch`/`@cascade`; its contents are diffed in isolation. */
export type VRegion = {
  kind: "region";
  children: VNode[];
  anchor?: Comment;
  // `@cascade:name(value)` describes its provider with plain fields; `cascade` is the record they create.
  name?: string;
  value?: unknown;
  fixed?: boolean;
  cascade?: CascadeRecord;
};

/** A child component; the diff decides whether it keeps its previous instance. */
export type VComponent = {
  kind: "component";
  type: Ctor<ComponentBase>;
  props: Record<string, unknown>;
  slots?: object;
  key?: unknown;
  ref?: (c: ComponentBase) => void;
  instance?: ComponentBase;
  mounted?: Mounted;
  // `@catch`: set on a routed page, it takes the failures the page itself causes instead of `rethrow`.
  onError?: (err: unknown, nav: number) => void;
  // The navigation that put this page here; a patch refreshes its params whenever it moves on.
  nav?: number;
};

export type VNode = VText | VElement | VRegion | VComponent | VFine;

/** A `@fine` component's DOM: built once by `fine.ts`, between two comments; patches only refresh it. */
export type VFine = { kind: "fine"; build: (parent: Node) => void; root?: FineRoot };

/** @internal What `fine.ts` keeps for one fine vnode. */
export type FineRoot = { bindings: unknown; start: Comment; end: Comment };

type FineHooks = {
  create(build: (parent: Node) => void, owner: ComponentBase, app: IApplication | undefined, scope: unknown): FineRoot;
  refresh(root: FineRoot): void;
  dispose(root: FineRoot): void;
  /** A handler of a fine component ran: it re-runs the bindings that read nothing tracked. */
  handled(owner: ComponentBase, result: unknown): void;
};

let fineHooks: FineHooks | undefined;

/** @internal On a component whose fine root was built (its fine context): its handlers and callbacks write tracked fields, so nothing re-renders it. */
export const FINE: unique symbol = Symbol("xzor.fine");

const isFine = (c: ComponentBase): boolean => (c as unknown as Record<symbol, unknown>)[FINE] !== undefined;

/** @internal Set by `fine.ts` (the model entry), so the renderer pays nothing without it. */
export function setFineHooks(h: FineHooks): void {
  fineHooks = h;
}

type Tracking = { model: { $reader: ((source: any, index: number) => void) | undefined; same(a: unknown, b: unknown): boolean }; notify(dep: object, index: number): void };
let tracking: Tracking | undefined;

/** @internal Set by the model entry: what a component's tracked fields report to. */
export function setTracking(t: Tracking): void {
  tracking = t;
  // Every tracked read goes through `$reader`: read the model directly, not through `tracking`.
  const model = t.model;
  Object.defineProperty(ComponentBase, "$reader", { get: () => model.$reader, configurable: true });
}

const FIELDS = Symbol("xzor.fields");
type Watcher = { slot: number };

/**
 * @internal A virtual-DOM island inside a fine template: renders `build` before `end`, patching `old`.
 * `scope` is the cascade scope the fine component was mounted in.
 */
export function patchIsland(
  owner: ComponentBase,
  app: IApplication | undefined,
  scope: unknown,
  end: Node,
  old: VNode[],
  build: (b: RenderTreeBuilder) => void,
): VNode[] {
  const builder = new RenderTreeBuilder(owner);
  build(builder);
  const next = builder.nodes;
  batch(() => patchList(end.parentNode!, old, next, end, owner, app, scope as CascadeRecord | undefined));
  return next;
}

/** @internal Disposes an island's tree; its DOM goes with the region that holds it. */
export function disposeIsland(tree: VNode[]): void {
  for (const v of tree) dispose(v);
}

/** @internal Whether a value is markup (`RenderFragment`). */
export const $isFragment = (value: unknown): boolean => isFragment(value);

export const SVG = "http://www.w3.org/2000/svg";
/** Whether children of `parent` belong to the SVG namespace (`<foreignObject>` holds HTML). */
export const $inSvg = (parent: Node): boolean => (parent as Element).namespaceURI === SVG && parent.nodeName !== "foreignObject";
const inSvg = $inSvg;

function fineNodes(root: FineRoot): Node[] {
  const nodes: Node[] = [];
  for (let n: Node | null = root.start; n !== null; n = n.nextSibling) {
    nodes.push(n);
    if (n === root.end) break;
  }
  return nodes;
}

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
  readonly #nav: Navigation | undefined;

  constructor(
    readonly path: string,
    readonly tag: (keyof Tags & string) | undefined,
    readonly params: P,
    readonly query: URLSearchParams,
    readonly match: Record<string, string>,
    nav?: Navigation,
  ) {
    this.#nav = nav;
  }

  /** Narrows `params` to the routes carrying `tag`. */
  is<K extends keyof Tags & string>(tag: K): this is Route<Tags[K], Tags> & { readonly tag: K } {
    return this.tag === tag;
  }

  /** History navigation under `@ClientRoutes`; `@ServerRoutes` loads the url. */
  navigate(url: string, opts?: { replace?: boolean }): void {
    if (this.#nav) this.#nav.navigate(url, opts?.replace === true);
    else location.href = url;
  }
}

/** One section of a `@ClientRoutes`/`@ServerRoutes` block; xzor emits these in source order. */
export type RouteSection =
  | { kind: "tag"; tag: string; render: (route: Route, page: RenderFragment) => RenderFragment }
  | { kind: "regex"; re: RegExp; page: boolean; render: (route: Route, page: RenderFragment) => RenderFragment }
  | {
      kind: "pattern";
      match: (segments: string[]) => Record<string, string> | null;
      page: boolean;
      render: (route: Route, page: RenderFragment) => RenderFragment;
    }
  | { kind: "notFound"; render: (route: Route) => RenderFragment }
  | { kind: "catch"; render: (route: Route, error: unknown) => RenderFragment }
  | { kind: "default"; render: (route: Route, page: RenderFragment) => RenderFragment };

/** How `@ClientRoutes` reaches the browser's history; `setNavigationForTests` swaps it. */
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

function notifyNavigated(): void {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<unknown> } };
  // `ready` rejects when the browser skips the animation (a hidden tab, a newer navigation): the update still ran.
  if (transitions && doc.startViewTransition) doc.startViewTransition(notifyAll).ready.catch(noop);
  else notifyAll();
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

/** What one mounted routes block keeps between renders. */
type Router = {
  // Set under `@ClientRoutes` only: it is also what `route.navigate` uses.
  nav: Navigation | undefined;
  off: (() => void) | undefined;
  onError: ((err: unknown, nav: number) => void) | undefined;
  caught: Extract<RouteSection, { kind: "catch" }> | undefined;
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

const ROUTER: unique symbol = Symbol("xzor.router");
type Routed = { [ROUTER]?: Router };

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

/** Spec order: a page route picks among the `(page)` sections, otherwise the page-less ones decide. */
function resolveRoute(router: Router, table: RouteTable, sections: readonly RouteSection[], url: URL): void {
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

/** A navigation raised while something renders (a page redirecting itself) waits for that render to end. */
function renavigate(owner: ComponentBase): void {
  if (depth === 0) update(owner);
  else queueMicrotask(() => update(owner));
}

type Ctor<C extends ComponentBase> = new (...args: any[]) => C;
// `latest` is the current vnode of a component still waiting for its instance; cleared on arrival or removal.
type Mounted = {
  tree: VNode[];
  anchor: Comment;
  app: IApplication | undefined;
  scope: CascadeRecord | undefined;
  latest: VComponent | undefined;
  // The render pass that last refreshed this component's parameters; a cascade skips it then.
  pass: number;
  // A routed page kept across navigations: the latest one it belongs to.
  nav?: number;
};

/** Builds components that need injected services; generated by xzor from `@Mount` and `@ServiceProvider`. */
export interface IApplication {
  onStarted?(): void | Promise<void>;
  /** Consulted only for component classes with a non-empty `static inject`; returns the component, a promise for it, or `undefined` (the runtime then throws). */
  createComponent?(type: Function): ComponentBase | Promise<ComponentBase> | undefined;
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
export const Mount = (_component: Function, _target: string): ClassDecorator => noop;
export const Import = (..._providers: Function[]): ClassDecorator => noop;
export const Singleton: ServiceDecorator = () => noop;
export const Scoped: ServiceDecorator = () => noop;
export const Transient: ServiceDecorator = () => noop;
export const SharedInstance: unique symbol = Symbol("xzor.sharedInstance");

const mountedComponents = new WeakMap<ComponentBase, Mounted>();
const elementHandlers = new WeakMap<
  Element,
  { owner: ComponentBase; events: Record<string, Handler>; modifiers: Record<string, Modifiers>; listening: Set<string> }
>();

const FRAGMENT: unique symbol = Symbol("xzor.fragment");

type Fragment = ((builder: RenderTreeBuilder) => void) & { readonly [FRAGMENT]: true };

/** Markup held as a value (Blazor's RenderFragment); render it with `@member`. */
export type RenderFragment = Fragment;
export type Renderer = RenderFragment;

/** A component event; invoking it re-renders the component that passed it in. */
export type EventCallback<T = void> = (arg: T) => unknown;

/** The DOM element type for a tag name, as `document.createElement` would return it. */
export type ElementOf<T extends string> = T extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[T]
  : T extends keyof SVGElementTagNameMap
    ? SVGElementTagNameMap[T]
    : HTMLElement;

function isFragment(value: unknown): value is Fragment {
  return typeof value === "function" && FRAGMENT in value;
}

/** A pending `@bind:debounce` write, on the input it came from. */
type Debounced = { timer: ReturnType<typeof setTimeout>; settle: (value: unknown) => void };
const DEBOUNCED = Symbol("xzor.debounced");

/**
 * Base of every component. A `.xzor` component's fields are tracked like a model's (the bundle rewrites them), so a
 * handler that writes one updates what reads it; `stateHasChanged()` re-runs every binding.
 */
export abstract class ComponentBase {
  #subs: Watcher[] | undefined;
  /** @internal Set by components that use `@leave`: until then, removal skips the `data-leave` check. */
  static $leaves = false;

  /** @internal What tracked getters report to; the bundle emits `ComponentBase.$reader?.(this, i)`. */
  static get $reader(): ((source: object, index: number) => void) | undefined {
    return tracking?.model.$reader;
  }

  static same(a: unknown, b: unknown): boolean {
    return tracking === undefined ? Object.is(a, b) : tracking.model.same(a, b);
  }

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
    if (subs !== undefined) for (let i = 0; i < subs.length; i++) tracking!.notify(subs[i]!, index);
  }

  /** Wraps builder calls as a RenderFragment; xzor emits this for markup used as a value. */
  static fragment(build: (builder: RenderTreeBuilder) => void): RenderFragment {
    return Object.assign(build, { [FRAGMENT]: true as const });
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
  slots: {} = {};

  protected abstract buildRenderTree(builder: RenderTreeBuilder): void;

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

type Hooks = {
  buildRenderTree(b: RenderTreeBuilder): void;
  onInitialized(): void;
  onInitializedAsync(): Promise<void> | void;
  onParametersSet(): void;
  onParametersSetAsync(): Promise<void> | void;
  onAfterRender(first: boolean): void;
  onAfterRenderAsync(first: boolean): Promise<void> | void;
  shouldRender(): boolean;
  dispose(): void;
};

const hooks = (c: ComponentBase) => c as unknown as Hooks;

export class RenderTreeBuilder {
  readonly #root: VNode[] = [];
  readonly #open: (VElement | VRegion)[] = [];

  constructor(private readonly owner: ComponentBase) {}

  get nodes(): VNode[] {
    return this.#root;
  }

  #append(node: VNode): void {
    (this.#open.at(-1)?.children ?? this.#root).push(node);
  }

  #current(): VElement {
    const el = this.#open.at(-1);
    if (el?.kind !== "element") throw new Error("xzor: attribute outside of an element");
    return el;
  }

  openElement(tag: string): void {
    const el: VElement = { kind: "element", tag, attrs: {}, events: {}, modifiers: {}, children: [] };
    this.#append(el);
    this.#open.push(el);
  }

  closeElement(): void {
    this.#open.pop();
  }

  openRegion(): void {
    const region: VRegion = { kind: "region", children: [] };
    this.#append(region);
    this.#open.push(region);
  }

  /** `@cascade:name(value)`: a region whose children see `value` under `name`; `fixed` keeps the first value. */
  openCascade(name: string, value: unknown, fixed?: boolean): void {
    const region: VRegion = { kind: "region", children: [], name, value, fixed: fixed === true };
    this.#append(region);
    this.#open.push(region);
  }

  closeRegion(): void {
    this.#open.pop();
  }

  /** `@ClientRoutes`/`@ServerRoutes`: renders the section that matches the current navigation. */
  addRoutes(engine: "client" | "server", table: RouteTable, sections: readonly RouteSection[]): void {
    const owner = this.owner as ComponentBase & Routed;
    const nav = navigationOf();
    let router = owner[ROUTER];
    if (!router) {
      router = owner[ROUTER] = {
        nav: engine === "client" ? nav : undefined,
        off: undefined,
        onError: undefined,
        caught: sections.find((s): s is Extract<RouteSection, { kind: "catch" }> => s.kind === "catch"),
        href: "",
        id: 0,
        route: undefined,
        section: -1,
        page: undefined,
        params: {},
        error: undefined,
        failed: false,
      };
      const failing = router;
      if (router.caught) {
        // The page's own failures reach this one handler; one raised by a page we left is dropped.
        router.onError = (err, id) => {
          if (id !== failing.id) return;
          failing.error = err;
          failing.failed = true;
          queueMicrotask(() => update(owner));
        };
      }
      // `@ServerRoutes` matches once on load: no listeners, no re-render.
      if (router.nav) router.off = router.nav.subscribe(() => renavigate(owner));
    }
    const state = router;
    const url = nav.current();
    if (url.href !== state.href || !state.route) {
      // A navigation clears the error the last page raised.
      state.failed = false;
      state.error = undefined;
      resolveRoute(state, table, sections, url);
    }
    const route = state.route!;
    const section = sections[state.section];
    const page = state.page;
    this.openCascade("route", route);
    if (state.failed) {
      state.caught!.render(route, state.error)(this);
    } else if (page) {
      const entry = page;
      const fragment = ComponentBase.fragment((b) => b.#addPage(entry, state));
      if (section) (section.render as (r: Route, p: RenderFragment) => RenderFragment)(route, fragment)(this);
      else fragment(this);
    } else if (section) {
      (section.render as (r: Route) => RenderFragment)(route)(this);
    }
    this.closeRegion();
  }

  // Keyed by route family: navigating between routes of one family (or params only) keeps the page instance.
  #addPage(entry: RouteEntry, router: Router): void {
    this.#append({
      kind: "component",
      type: entry.component as Ctor<ComponentBase>,
      props: router.params,
      key: entry.family ?? entry.pattern,
      onError: router.onError,
      nav: router.id,
    });
  }

  addAttribute(name: string, value: unknown): void {
    const el = this.#current();
    // `aria-*` states are the strings "true" and "false".
    if (typeof value === "boolean" && name.startsWith("aria-")) value = String(value);
    if (value === false || value == null) delete el.attrs[name];
    else el.attrs[name] = value === true ? "" : String(value);
  }

  /** `class:name="@on"`: adds `name` to the open element's class while `on` is truthy. */
  toggleClass(name: string, on: unknown): void {
    if (!on) return;
    const attrs = this.#current().attrs;
    const own = attrs["class"];
    attrs["class"] = own ? `${own} ${name}` : name;
  }

  /** `@attributes`: each entry is added in order, so later attributes override it. */
  addAttributes(attrs: Record<string, unknown> | null | undefined): void {
    for (const [name, value] of Object.entries(attrs ?? {})) this.addAttribute(name, value);
  }

  /** `@attr:name`: an attribute of the nearest open element; `class` adds to its classes. */
  addParentAttribute(name: string, value: unknown): void {
    const open = this.#open;
    let i = open.length - 1;
    while (i >= 0 && open[i]!.kind !== "element") i--;
    if (i < 0) throw new Error(`xzor: @attr:${name} outside of an element`);
    const el = open[i] as VElement;
    const own = el.attrs[name];
    if (name === "class" && own && value !== false && value != null) el.attrs["class"] = `${own} ${value === true ? "" : String(value)}`.trimEnd();
    else if (value === false || value == null) delete el.attrs[name];
    else el.attrs[name] = value === true ? "" : String(value);
  }

  /** `@onclick:preventDefault` and `@onclick:stopPropagation`, with or without a handler. */
  addEventModifier(event: string, modifier: Modifier, enabled: boolean): void {
    const el = this.#current();
    (el.modifiers[event] ??= {})[modifier] = enabled;
  }

  /** `@key`: list diffs match this element by key instead of position. */
  setKey(key: unknown): void {
    this.#current().key = key;
  }

  /** `@ref`: receives the DOM element (typed from its tag) after each render. */
  setRef<T extends string>(_tag: T, ref: (el: ElementOf<T>) => void): void {
    this.#current().ref = ref as (el: Element) => void;
  }

  addEventHandler<K extends keyof HTMLElementEventMap>(
    event: K,
    handler: (e: HTMLElementEventMap[K]) => unknown,
  ): void;
  addEventHandler(event: string, handler: Handler): void;
  addEventHandler(event: string, handler: (e: never) => unknown): void {
    this.#current().events[event] = handler as Handler;
  }

  addText(text: string): void {
    this.#append({ kind: "text", text });
  }

  /** `@fine`: the whole template, built once into the DOM; its bindings keep it current. */
  addFine(build: (parent: Node) => void): void {
    this.#append({ kind: "fine", build });
  }

  addContent(value: unknown): void {
    if (isFragment(value)) {
      this.openRegion();
      value(this);
      this.closeRegion();
      return;
    }
    // An empty text node keeps the slot, so siblings stay aligned when content comes and goes.
    if (value === false || value == null) value = "";
    this.#append({ kind: "text", text: String(value) });
  }

  addComponent<C extends ComponentBase>(
    type: Ctor<C>,
    props: Partial<C>,
    slots?: C["slots"],
    extra?: { key?: unknown; ref?: (c: C) => void },
  ): void {
    this.#append({
      kind: "component",
      type,
      props: props as Record<string, unknown>,
      slots,
      key: extra?.key,
      ref: extra?.ref as ((c: ComponentBase) => void) | undefined,
    });
  }

  /** Wraps a handler passed to a child as an EventCallback (re-renders this owner). */
  callback<T>(handler: (arg: T) => unknown): EventCallback<T> {
    const owner = this.owner;
    if (isFine(owner))
      return (arg: T) => {
        const result = handler(arg);
        fineHooks!.handled(owner, result);
        return result;
      };
    return (arg: T) => {
      const result = handler(arg);
      update(owner);
      if (result instanceof Promise) void result.then(() => update(owner));
      return result;
    };
  }
}

// Inputs keep live state in properties, so bound attributes are mirrored onto them. `--name` is a custom property.
function setAttr(el: Element, name: string, value: string): void {
  if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) return (el as HTMLElement).style.setProperty(name, value);
  el.setAttribute(name, value);
  if (name === "value" && "value" in el) (el as HTMLInputElement).value = value;
  if (name === "checked" && "checked" in el) (el as HTMLInputElement).checked = true;
}

function removeAttr(el: Element, name: string): void {
  if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) return void (el as HTMLElement).style.removeProperty(name);
  el.removeAttribute(name);
  if (name === "value" && "value" in el) (el as HTMLInputElement).value = "";
  if (name === "checked" && "checked" in el) (el as HTMLInputElement).checked = false;
}

/** What `@source-crafter/xzor-runtime/model` installs to learn which models a render read. */
export type RenderObserver = {
  begin(component: ComponentBase): void;
  end(component: ComponentBase): void;
  dispose(component: ComponentBase): void;
};

let observer: RenderObserver | undefined;

/** @internal Set by the model entry; the renderer costs one null check while none is installed. */
export function setRenderObserver(o: RenderObserver | undefined): void {
  observer = o;
}

function render(component: ComponentBase): VNode[] {
  const builder = new RenderTreeBuilder(component);
  if (observer === undefined) hooks(component).buildRenderTree(builder);
  else {
    observer.begin(component);
    try {
      hooks(component).buildRenderTree(builder);
    } finally {
      observer.end(component);
    }
  }
  return builder.nodes;
}

// After-render callbacks wait until the outermost render pass has touched the DOM.
let depth = 0;
let pass = 0;
const afterRender: (() => void)[] = [];

function batch(fn: () => void): void {
  if (depth++ === 0) pass++;
  try {
    fn();
  } finally {
    if (--depth === 0) for (const done of afterRender.splice(0)) done();
  }
}

function settle(component: ComponentBase, result: Promise<void> | void, node?: VComponent): void {
  if (!(result instanceof Promise)) return;
  void result.then(() => update(component), node?.onError && ((err: unknown) => fail(node, err)));
}

/** `@catch`: the failure is reported with the navigation the page belongs to, so a late one can be dropped. */
function fail(v: VComponent, err: unknown): void {
  if (v.onError) v.onError(err, v.mounted?.nav ?? v.nav ?? 0);
  else rethrow(err);
}

function parametersSet(component: ComponentBase): void {
  hooks(component).onParametersSet();
  settle(component, hooks(component).onParametersSetAsync());
}

/** `static cascades` on a component class: one `[property, cascade name]` pair per `@Cascade` member. */
type CascadeList = readonly (readonly [prop: string, name: string])[];

const cascadesOf = (type: Function): CascadeList | undefined => (type as { cascades?: CascadeList }).cascades;

const fields = (c: ComponentBase) => c as unknown as Record<string, unknown>;

function findCascade(scope: CascadeRecord | undefined, name: string): CascadeRecord | undefined {
  for (let s = scope; s; s = s.parent) if (s.name === name) return s;
  return undefined;
}

/** Gives each `@Cascade` member the nearest provider's value and subscribes to later changes. */
function resolveCascades(instance: ComponentBase, scope: CascadeRecord | undefined): void {
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

function unsubscribeCascades(instance: ComponentBase, scope: CascadeRecord | undefined): void {
  const list = cascadesOf(instance.constructor);
  if (!list) return;
  for (const [, name] of list) findCascade(scope, name)?.consumers?.delete(instance);
}

// Assigning before the region's children are patched lets a consumer whose props also changed
// render once with both; the leftovers are told afterwards.
function assignCascade(record: CascadeRecord, consumers: readonly ComponentBase[]): void {
  for (const consumer of consumers) {
    for (const [prop, name] of cascadesOf(consumer.constructor)!) {
      if (name === record.name) fields(consumer)[prop] = record.value;
    }
  }
}

// A changed cascade takes the same path as a changed prop: onParametersSet, then re-render.
function notifyCascade(consumers: readonly ComponentBase[]): void {
  for (const consumer of consumers) {
    const m = mountedComponents.get(consumer);
    if (!m || m.pass === pass) continue;
    m.pass = pass;
    try {
      parametersSet(consumer);
      update(consumer);
    } catch (err) {
      // One consumer's failure must not keep the rest from seeing the new value.
      rethrow(err);
    }
  }
}

function queueAfterRender(component: ComponentBase, first: boolean): void {
  afterRender.push(() => {
    hooks(component).onAfterRender(first);
    void hooks(component).onAfterRenderAsync(first);
  });
}

function update(component: ComponentBase): void {
  batch(() => {
    const m = mountedComponents.get(component);
    const parent = m?.anchor.parentNode;
    if (!m || !parent || !hooks(component).shouldRender()) return;
    const next = render(component);
    patchList(parent, m.tree, next, m.anchor, component, m.app, m.scope);
    m.tree = next;
    queueAfterRender(component, false);
  });
}

// `into` is the placeholder left by an async component; it keeps its anchor and the nodes go before it.
function mountComponent(
  component: ComponentBase,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
  into?: Mounted,
  node?: VComponent,
): { nodes: Node[]; mounted: Mounted } {
  hooks(component).onInitialized();
  settle(component, hooks(component).onInitializedAsync(), node);
  parametersSet(component);
  const tree = render(component);
  const mounted = into ?? { tree, anchor: document.createComment(""), app, scope, latest: undefined, pass };
  if (into) into.tree = tree;
  mountedComponents.set(component, mounted);
  const nodes = tree.flatMap((v) => create(v, component, app, scope));
  queueAfterRender(component, true);
  if (!into) nodes.push(mounted.anchor);
  return { nodes, mounted };
}

const LAZY = Symbol("xzor.lazy");
type Lazy = { [LAZY]: () => Promise<Ctor<ComponentBase>>; loaded: Ctor<ComponentBase> | undefined };

/**
 * A component loaded on first use (a chunk of its own in a split bundle). It stands for the class in the
 * tree: an anchor holds its place until the module arrives, and later uses construct it at once.
 */
export function lazy<C>(load: () => Promise<{ default: C }>): C {
  let pending: Promise<Ctor<ComponentBase>> | undefined;
  const stub: Lazy = {
    [LAZY]: () => (pending ??= load().then((m) => (stub.loaded = m.default as Ctor<ComponentBase>))),
    loaded: undefined,
  };
  return stub as unknown as C;
}

function construct(type: Ctor<ComponentBase>, app: IApplication | undefined): ComponentBase | Promise<ComponentBase> {
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

function arrive(mounted: Mounted, instance: ComponentBase): void {
  const v = mounted.latest;
  const parent = mounted.anchor.parentNode;
  mounted.latest = undefined;
  // No vnode: removed before arrival. No parent: the anchor was detached without a dispose.
  if (!v || !parent) {
    disposeInstance(instance);
    return;
  }
  try {
    batch(() => {
      applyProps(instance, v);
      resolveCascades(instance, mounted.scope);
      v.ref?.(instance);
      for (const node of mountComponent(instance, mounted.app, mounted.scope, mounted, v).nodes)
        parent.insertBefore(node, mounted.anchor);
      v.instance = instance;
    });
  } catch (err) {
    fail(v, err);
    if (!v.instance) {
      mountedComponents.delete(instance);
      observer?.dispose(instance);
      unsubscribeCascades(instance, mounted.scope);
      // Nodes of the failed render were never inserted; keep only the empty placeholder.
      const partial = mounted.tree;
      mounted.tree = [];
      for (const node of partial) {
        try {
          dispose(node);
        } catch (disposeErr) {
          rethrow(disposeErr);
        }
      }
    }
  }
}

function applyProps(instance: ComponentBase, v: VComponent): void {
  Object.assign(instance, v.props);
  if (v.slots) instance.slots = v.slots;
}

function propsChanged(o: VComponent, n: VComponent): boolean {
  // Slot lambdas are recreated on every parent render, so a child with slots always refreshes.
  if (n.slots) return true;
  for (const [key, value] of Object.entries(n.props)) {
    // Like Blazor, objects may have been mutated, so they always count as changed.
    if (!Object.is(o.props[key], value) || (typeof value === "object" && value !== null)) return true;
  }
  return false;
}

const eventNames = (v: VElement) => new Set([...Object.keys(v.events), ...Object.keys(v.modifiers)]);

function listen(el: Element, event: string): void {
  elementHandlers.get(el)!.listening.add(event);
  el.addEventListener(event, (e) => {
    const record = elementHandlers.get(el);
    if (!record) return;
    const mods = record.modifiers[event];
    if (mods?.preventDefault) e.preventDefault();
    if (mods?.stopPropagation) e.stopPropagation();
    const handler = record.events[event];
    if (!handler) return;
    const result = handler(e);
    if (isFine(record.owner)) return fineHooks!.handled(record.owner, result);
    update(record.owner);
    if (result instanceof Promise) void result.then(() => update(record.owner));
  });
}

function create(
  v: VNode,
  owner: ComponentBase,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
  svg = false,
): Node[] {
  switch (v.kind) {
    case "text":
      v.dom = document.createTextNode(v.text);
      return [v.dom];
    case "element": {
      const el = svg || v.tag === "svg" ? document.createElementNS(SVG, v.tag) : document.createElement(v.tag);
      for (const [name, value] of Object.entries(v.attrs)) setAttr(el, name, value);
      elementHandlers.set(el, { owner, events: v.events, modifiers: v.modifiers, listening: new Set() });
      for (const event of eventNames(v)) listen(el, event);
      const inner = inSvg(el);
      for (const child of v.children) el.append(...create(child, owner, app, scope, inner));
      v.dom = el;
      v.ref?.(el);
      return [el];
    }
    case "region": {
      v.anchor = document.createComment("");
      // The record outlives the vnode: later renders carry it over in `patch`.
      const inner =
        v.name === undefined
          ? scope
          : (v.cascade = { name: v.name, value: v.value, fixed: v.fixed === true, consumers: undefined, parent: scope });
      return [...v.children.flatMap((c) => create(c, owner, app, inner, svg)), v.anchor];
    }
    case "component": {
      if (!v.onError) return createComponent(v, app, scope);
      try {
        return createComponent(v, app, scope);
      } catch (err) {
        return failedComponent(v, err, app, scope);
      }
    }
    case "fine": {
      if (!fineHooks) throw new Error("xzor: a @fine component needs @source-crafter/xzor-runtime/model");
      return fineNodes((v.root = fineHooks.create(v.build, owner, app, scope)));
    }
  }
}

// `@cached` components that left the tree, by type and key; their nodes stay built, detached.
// ponytail: never evicted; one entry per type and key, so a page with keyed routes keeps one per family.
const kept = new WeakMap<Function, Map<unknown, VComponent>>();
let keptCount = 0;

function keep(v: VComponent): void {
  let byKey = kept.get(v.type);
  if (byKey === undefined) kept.set(v.type, (byKey = new Map()));
  if (!byKey.has(v.key)) keptCount++;
  byKey.set(v.key, v);
}

/** The nodes of a kept instance of `v`'s type and key, patched to `v`'s props; `undefined` if none is kept. */
function revive(v: VComponent, app: IApplication | undefined, scope: CascadeRecord | undefined): Node[] | undefined {
  if (keptCount === 0) return undefined;
  const byKey = kept.get(v.type);
  const old = byKey?.get(v.key);
  if (old === undefined) return undefined;
  byKey!.delete(v.key);
  keptCount--;
  const instance = (v.instance = old.instance!);
  const mounted = (v.mounted = old.mounted!);
  mounted.app = app;
  mounted.scope = scope;
  applyProps(instance, v);
  resolveCascades(instance, scope);
  v.ref?.(instance);
  // Re-rendered in a fragment: `update` patches before the anchor, which needs a parent.
  const frag = document.createDocumentFragment();
  for (const node of nodesOf(old)) frag.appendChild(node);
  mounted.pass = pass;
  parametersSet(instance);
  update(instance);
  return [...frag.childNodes];
}

function createComponent(v: VComponent, app: IApplication | undefined, scope: CascadeRecord | undefined): Node[] {
  const revived = revive(v, app, scope);
  if (revived !== undefined) return revived;
  const made = construct(v.type, app);
  if (made instanceof Promise) {
    const mounted: Mounted = (v.mounted = {
      tree: [],
      anchor: document.createComment(""),
      app,
      scope,
      latest: v,
      pass,
    });
    made.then(
      (instance) => arrive(mounted, instance),
      (err) => {
        const latest = mounted.latest;
        mounted.latest = undefined;
        if (latest) fail(latest, err);
        // A routed page we already left: its failure is stale, like any other.
        else if (!v.onError) rethrow(err);
      },
    );
    return [mounted.anchor];
  }
  v.instance = made;
  applyProps(made, v);
  resolveCascades(made, scope);
  v.ref?.(made);
  const { nodes, mounted } = mountComponent(made, app, scope, undefined, v);
  v.mounted = mounted;
  return nodes;
}

// `@catch`: the page's nodes never reached the DOM, so only an anchor stays until the block re-renders.
function failedComponent(
  v: VComponent,
  err: unknown,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
): Node[] {
  const instance = v.instance;
  v.instance = undefined;
  if (instance) {
    // Children the page had already mounted go with it, or they keep taking cascades and hooks.
    const partial = mountedComponents.get(instance);
    mountedComponents.delete(instance);
    observer?.dispose(instance);
    unsubscribeCascades(instance, scope);
    for (const node of partial?.tree ?? []) {
      try {
        dispose(node);
      } catch (disposeErr) {
        rethrow(disposeErr);
      }
    }
  }
  v.mounted = { tree: [], anchor: document.createComment(""), app, scope, latest: undefined, pass };
  fail(v, err);
  return [v.mounted.anchor];
}

function nodesOf(v: VNode): Node[] {
  switch (v.kind) {
    case "text":
    case "element":
      return [v.dom!];
    case "region":
      return [...v.children.flatMap(nodesOf), v.anchor!];
    case "component":
      return [...v.mounted!.tree.flatMap(nodesOf), v.mounted!.anchor];
    case "fine":
      return fineNodes(v.root!);
  }
}

function same(o: VNode, n: VNode): boolean {
  if (o.kind !== n.kind) return false;
  if (o.kind === "element") return o.tag === (n as VElement).tag && o.key === (n as VElement).key;
  if (o.kind === "component") return o.type === (n as VComponent).type && o.key === (n as VComponent).key;
  // A provider is only ever patched against the same provider; anything else replaces it.
  if (o.kind === "region") return o.name === (n as VRegion).name && o.fixed === (n as VRegion).fixed;
  return true;
}

function dispose(v: VNode): void {
  switch (v.kind) {
    case "element":
      v.children.forEach(dispose);
      return;
    case "region":
      // The provider goes away with its region, so its consumers need not unsubscribe one by one.
      if (v.cascade) v.cascade.consumers = undefined;
      v.children.forEach(dispose);
      return;
    case "component":
      if (!v.instance) {
        if (v.mounted) v.mounted.latest = undefined;
        return;
      }
      unsubscribeCascades(v.instance, v.mounted?.scope);
      if ((v.instance.constructor as { cached?: boolean }).cached === true) return keep(v);
      v.mounted?.tree.forEach(dispose);
      mountedComponents.delete(v.instance);
      disposeInstance(v.instance);
      return;
    case "fine":
      fineHooks!.dispose(v.root!);
      return;
  }
}

function disposeInstance(c: ComponentBase): void {
  observer?.dispose(c);
  (c as Routed)[ROUTER]?.off?.();
  hooks(c).dispose();
  const d = c as unknown as Record<symbol, (() => unknown) | undefined>;
  d[wellKnown.dispose]?.();
  surface(d[wellKnown.asyncDispose]?.());
}

function remove(parent: Node, v: VNode): void {
  for (const node of nodesOf(v)) $leave(node);
  dispose(v);
}

/**
 * @internal Removes `node`. A `data-leave` element gets `data-leaving` first and goes when the finite animations
 * that starts (in it and below) finish; with none, or removed again meanwhile, it goes at once.
 */
export function $leave(node: Node): void {
  const el = node as Element;
  if (!ComponentBase.$leaves || el.nodeType !== 1 || !el.hasAttribute("data-leave") || el.hasAttribute("data-leaving")) return void node.parentNode?.removeChild(node);
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

function patch(
  o: VNode,
  n: VNode,
  owner: ComponentBase,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
): void {
  switch (n.kind) {
    case "text": {
      const dom = (n.dom = (o as VText).dom!);
      if (dom.data !== n.text) dom.data = n.text;
      return;
    }
    case "element": {
      const old = o as VElement;
      const el = (n.dom = old.dom!);
      for (const name of Object.keys(old.attrs)) if (!(name in n.attrs)) removeAttr(el, name);
      for (const [name, value] of Object.entries(n.attrs)) {
        const live = name === "value" ? (el as HTMLInputElement).value : undefined;
        if (old.attrs[name] !== value || (live !== undefined && live !== value)) setAttr(el, name, value);
      }
      const record = elementHandlers.get(el)!;
      record.events = n.events;
      record.modifiers = n.modifiers;
      for (const event of eventNames(n)) if (!record.listening.has(event)) listen(el, event);
      patchList(el, old.children, n.children, null, owner, app, scope);
      n.ref?.(el);
      return;
    }
    case "region": {
      const old = o as VRegion;
      const anchor = (n.anchor = old.anchor!);
      // The provider record is carried like the anchor, so consumers keep their subscription.
      const record = old.cascade;
      let subscribers: ComponentBase[] | undefined;
      let inner = scope;
      if (record) {
        record.parent = scope;
        n.cascade = record;
        inner = record;
        // A fixed provider keeps the value of its first render, for consumers mounted later too.
        if (!record.fixed && !Object.is(record.value, n.value)) {
          record.value = n.value;
          if (record.consumers?.size) {
            subscribers = [...record.consumers];
            assignCascade(record, subscribers);
          }
        }
      }
      patchList(anchor.parentNode!, old.children, n.children, anchor, owner, app, inner);
      // Consumers that this patch mounted or already refreshed skip the notification.
      if (subscribers) notifyCascade(subscribers);
      return;
    }
    case "component": {
      const old = o as VComponent;
      n.mounted = old.mounted;
      if (!old.instance) {
        // Still waiting for its instance: carry the newest props to arrival.
        if (n.mounted!.latest) n.mounted!.latest = n;
        return;
      }
      const instance = (n.instance = old.instance);
      // A page whose navigation moved on takes its params again even when they compare equal.
      const changed = n.nav !== old.nav || propsChanged(old, n);
      if (n.nav !== undefined) n.mounted!.nav = n.nav;
      applyProps(instance, n);
      n.ref?.(instance);
      if (changed) {
        n.mounted!.pass = pass;
        parametersSet(instance);
        update(instance);
      }
      return;
    }
    case "fine": {
      // Built once: a re-render (`stateHasChanged`) re-runs the bindings, for changes nothing tracks.
      fineHooks!.refresh((n.root = (o as VFine).root!));
      return;
    }
  }
}

const keyOf = (v: VNode | undefined) => (v && (v.kind === "element" || v.kind === "component") ? v.key : undefined);

function patchList(
  parent: Node,
  old: VNode[],
  next: VNode[],
  end: Node | null,
  owner: ComponentBase,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
): void {
  if (old.some((v) => keyOf(v) != null) || next.some((v) => keyOf(v) != null)) {
    patchKeyed(parent, old, next, end, owner, app, scope);
    return;
  }
  // Positional diff; regions keep variable-length blocks from misaligning their siblings.
  for (let i = 0; i < next.length; i++) {
    const n = next[i]!;
    const o = old[i];
    if (o && same(o, n)) {
      patch(o, n, owner, app, scope);
      continue;
    }
    const ref = o ? nodesOf(o)[0]! : end;
    for (const node of create(n, owner, app, scope, inSvg(parent))) parent.insertBefore(node, ref);
    if (o) remove(parent, o);
  }
  for (const o of old.slice(next.length)) remove(parent, o);
}

/** `@key` diff: keyed nodes are matched by key and moved; unkeyed ones by position. */
function patchKeyed(
  parent: Node,
  old: VNode[],
  next: VNode[],
  end: Node | null,
  owner: ComponentBase,
  app: IApplication | undefined,
  scope: CascadeRecord | undefined,
): void {
  const byKey = new Map<unknown, VNode>();
  for (const o of old) if (keyOf(o) != null) byKey.set(keyOf(o), o);
  const used = new Set<VNode>();
  const matches = next.map((n, i) => {
    const key = keyOf(n);
    const o = key != null ? byKey.get(key) : keyOf(old[i]) == null ? old[i] : undefined;
    if (o && !used.has(o) && same(o, n)) {
      used.add(o);
      return o;
    }
    return undefined;
  });
  for (const o of old) if (!used.has(o)) remove(parent, o);
  let ref = end;
  for (let i = next.length - 1; i >= 0; i--) {
    const n = next[i]!;
    const o = matches[i];
    let nodes: Node[];
    if (o) {
      patch(o, n, owner, app, scope);
      nodes = nodesOf(n);
    } else {
      nodes = create(n, owner, app, scope, inSvg(parent));
    }
    for (let j = nodes.length - 1; j >= 0; j--) {
      const node = nodes[j]!;
      if (node.parentNode !== parent || node.nextSibling !== ref) parent.insertBefore(node, ref);
      ref = node;
    }
  }
}

function resolveTarget(target: string | Element): Element {
  if (typeof target !== "string") return target;
  const found = SELECTOR.test(target) ? document.querySelector(target) : document.getElementById(target);
  if (!found) throw new Error(`xzor: mount target "${target}" not found`);
  return found;
}

/** `target` is an element, an element id, or a selector (anything containing `#`, `.` or `[`). */
export function mount<C extends ComponentBase>(type: Ctor<C>, target: string | Element, app?: IApplication): C {
  const host = resolveTarget(target);
  const root = construct(type, app);
  if (root instanceof Promise) throw new Error(`xzor: root component ${type.name} cannot be asynchronous`);
  batch(() => host.replaceChildren(...mountComponent(root, app, undefined).nodes));
  surface(app?.onStarted?.());
  return root as C;
}

/** An `<a>` that carries `activeClass` while the current URL is on its `href`; it follows navigation itself. */
export class NavLink extends ComponentBase {
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

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("a");
    b.addAttribute("href", this.href);
    if (this.#active()) {
      b.addAttribute("class", this.activeClass);
      b.addAttribute("aria-current", "page");
    }
    b.addContent(this.slots.default?.() ?? null);
    b.closeElement();
  }
}
