import { afterEach, expect, test } from "bun:test";
import {
  ComponentBase,
  type IApplication,
  NavLink,
  type RenderFragment,
  type RenderTreeBuilder,
  Route,
  type RouteSection,
  type RouteTable,
  mount,
  setNavigationForTests,
  viewTransitions,
} from "./index";

// happy-dom starts on about:blank, where relative URLs and pushState are not allowed.
(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost/");

// Written the way xzor emits `@Routes`: a hand-written table in the shape of
// `.xzor/routes.ts` and sections in the shape of the generated descriptors.

let lastUser: UserPage | undefined;

class UserPage extends ComponentBase {
  id = 0;
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    lastUser = this;
    this.renders++;
    b.openElement("u");
    b.addContent(this.id);
    b.closeElement();
  }
}

class NewUser extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("n");
    b.addText("new");
    b.closeElement();
  }
}

class DocPage extends ComponentBase {
  rest = "";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("d");
    b.addContent(this.rest);
    b.closeElement();
  }
}

class RootPage extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("r");
    b.addText("root");
    b.closeElement();
  }
}

class ListPage extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("l");
    b.addText("list");
    b.closeElement();
  }
}

const decimal = /^-?\d+$/;

const pages: RouteTable = [
  {
    tag: undefined,
    pattern: "/",
    component: RootPage,
    match: (s) => (s.length === 0 ? {} : null),
  },
  {
    tag: undefined,
    pattern: "/users",
    component: ListPage,
    match: (s) => (s.length === 1 && s[0] === "users" ? {} : null),
  },
  {
    tag: undefined,
    pattern: "/users/new",
    component: NewUser,
    match: (s) => (s.length === 2 && s[0] === "users" && s[1] === "new" ? {} : null),
  },
  {
    tag: "admin",
    pattern: "/users/:id",
    component: UserPage,
    match: (s) => (s.length === 2 && s[0] === "users" && decimal.test(s[1]!) ? { id: Number(s[1]) } : null),
  },
  {
    tag: undefined,
    pattern: "/docs/*",
    component: DocPage,
    match: (s) => (s[0] === "docs" ? { rest: s.slice(1).join("/") } : null),
  },
];

const frag = (fn: (b: RenderTreeBuilder) => void): RenderFragment => ComponentBase.fragment(fn);

/** A layout section: renders the page inside `tag`. */
const wrap =
  (tag: string) =>
  (_route: Route, page: RenderFragment): RenderFragment =>
    frag((b) => {
      b.openElement(tag);
      b.addContent(page);
      b.closeElement();
    });

/** A page-less section: renders one value read from `route`. */
const label =
  (tag: string, read: (route: Route) => unknown) =>
  (route: Route): RenderFragment =>
    frag((b) => {
      b.openElement(tag);
      b.addContent(read(route));
      b.closeElement();
    });

class MemoryNavigation {
  url: URL;
  readonly calls: [string, boolean][] = [];
  readonly subs = new Set<() => void>();
  subscriptions = 0;

  constructor(start: string) {
    this.url = new URL(start, "http://localhost");
  }

  current(): URL {
    return this.url;
  }

  navigate(url: string, replace: boolean): void {
    this.calls.push([url, replace]);
    this.go(url);
  }

  subscribe(fn: () => void): () => void {
    this.subscriptions++;
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** A navigation the app did not start, like a back button. */
  go(url: string): void {
    this.url = new URL(url, "http://localhost");
    for (const fn of [...this.subs]) fn();
  }
}

const nav = (start: string): MemoryNavigation => {
  const memory = new MemoryNavigation(start);
  setNavigationForTests(memory);
  return memory;
};

const live: { host: Element; drop: () => void; unguard: () => void }[] = [];

afterEach(() => {
  for (const { host, drop, unguard } of live.splice(0)) {
    drop();
    unguard();
    host.remove();
  }
  setNavigationForTests(undefined);
  history.replaceState(null, "", "/");
});

const event = (init: MouseEventInit): MouseEvent =>
  new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });

function routed(
  sections: RouteSection[],
  opts: { table?: RouteTable; app?: IApplication } = {},
) {
  const table = opts.table ?? pages;
  class Block extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addRoutes(table, sections);
    }
  }
  class Shell extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(Block, {});
      b.closeRegion();
    }
  }
  const host = document.createElement("div");
  document.body.append(host);
  const shell = mount(Shell, host, opts.app);
  // Runs after the router's own listener: it reports what the router did and keeps happy-dom from
  // really loading the links the router left alone.
  let prevented = false;
  const guard = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", guard);
  const drop = () => {
    shell.show = false;
    shell.stateHasChanged();
  };
  const unguard = () => document.removeEventListener("click", guard);
  live.push({ host, drop, unguard });
  return {
    host,
    drop,
    html: () => host.innerHTML.replaceAll("<!---->", ""),
    /** Dispatches a click and reports whether the router intercepted it. */
    click: (el: Element, init: MouseEventInit = {}) => {
      prevented = false;
      el.dispatchEvent(event(init));
      return prevented;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a matched page route renders in the first section that takes a page", () => {
  nav("/users/7");
  const r = routed([
    { kind: "tag", tag: "admin", render: wrap("main") },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(r.html()).toBe("<main><u>7</u></main>");
});

test("a tag section is skipped when the matched route has another tag", () => {
  nav("/users/new");
  const r = routed([
    { kind: "tag", tag: "admin", render: wrap("main") },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(r.html()).toBe("<aside><n>new</n></aside>");
});

test("a regex section with a page exposes its named groups as route.match", () => {
  nav("/users/7");
  const r = routed([
    { kind: "regex", re: /^\/users\/(?<who>\w+)/, page: true, render: label("b", (route) => route.match.who) },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(r.html()).toBe("<b>7</b>");
});

test("a pattern section with a page exposes its own segments as route.match", () => {
  nav("/docs/a/b");
  const r = routed([
    {
      kind: "pattern",
      match: (s) => (s[0] === "docs" ? { area: s[1] ?? "" } : null),
      page: true,
      render: (route: Route, page: RenderFragment) =>
        frag((b) => {
          b.openElement("i");
          b.addContent(route.match.area);
          b.addContent(page);
          b.closeElement();
        }),
    },
  ]);
  expect(r.html()).toBe("<i>a<d>a/b</d></i>");
});

test("a pattern section never overwrites the page's converted params", () => {
  nav("/users/7");
  let captured: Route | undefined;
  const r = routed([
    {
      kind: "pattern",
      match: (s) => (s[0] === "users" ? { id: s[1] ?? "" } : null),
      page: true,
      render: (route: Route, page: RenderFragment) => {
        captured = route;
        return wrap("i")(route, page);
      },
    },
  ]);
  expect(r.html()).toBe("<i><u>7</u></i>");
  expect(lastUser!.id).toBe(7);
  expect(captured!.params).toEqual({ id: 7 });
  expect(captured!.match).toEqual({ id: "7" });
});

test("a page with no matching section falls back to @default, then to the bare page", () => {
  const memory = nav("/users/7");
  const withDefault = routed([
    { kind: "tag", tag: "none", render: wrap("main") },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(withDefault.html()).toBe("<aside><u>7</u></aside>");

  setNavigationForTests(memory);
  const bare = routed([{ kind: "tag", tag: "none", render: wrap("main") }]);
  expect(bare.html()).toBe("<u>7</u>");
});

test("without a page route only page-less sections are tried, in order", () => {
  nav("/legal/terms");
  const r = routed([
    { kind: "tag", tag: "admin", render: wrap("main") },
    { kind: "regex", re: /^\/legal\//, page: true, render: label("b", () => "wrong") },
    {
      kind: "pattern",
      match: (s) => (s[0] === "legal" ? { doc: s[1] ?? "" } : null),
      page: false,
      render: label("i", (route) => (route.params as { doc: string }).doc),
    },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(r.html()).toBe("<i>terms</i>");
});

test("nothing matching renders @notFound, or nothing at all", () => {
  const memory = nav("/missing");
  const found = routed([
    { kind: "default", render: wrap("aside") },
    { kind: "notFound", render: label("p", () => "missing") },
  ]);
  expect(found.html()).toBe("<p>missing</p>");

  setNavigationForTests(memory);
  const empty = routed([{ kind: "default", render: wrap("aside") }]);
  expect(empty.html()).toBe("");
});

test("the table converts the params before they reach the page", () => {
  nav("/users/7");
  routed([{ kind: "default", render: wrap("aside") }]);
  expect(lastUser!.id).toBe(7);
  expect(lastUser!.paramsSet).toBe(1);
});

test("param-only navigation keeps the page instance and sets its parameters again", () => {
  const memory = nav("/users/1");
  const r = routed([{ kind: "default", render: wrap("aside") }]);
  const page = lastUser!;

  memory.go("/users/2");
  expect(r.html()).toBe("<aside><u>2</u></aside>");
  expect(lastUser).toBe(page);
  expect(page.id).toBe(2);
  expect(page.paramsSet).toBe(2);
  expect(page.renders).toBe(2);
});

test("a query-only navigation sets the page's parameters again", () => {
  const memory = nav("/users/1?q=a");
  const r = routed([{ kind: "default", render: wrap("aside") }]);
  const page = lastUser!;

  memory.go("/users/1?q=b");
  expect(lastUser).toBe(page);
  expect(page.paramsSet).toBe(2);
  expect(page.renders).toBe(2);
  expect(r.html()).toBe("<aside><u>1</u></aside>");
});

test("navigating to another route pattern builds a new page", () => {
  const memory = nav("/users/1");
  const r = routed([{ kind: "default", render: wrap("aside") }]);
  const page = lastUser!;

  memory.go("/docs/a");
  expect(r.html()).toBe("<aside><d>a</d></aside>");
  memory.go("/users/1");
  expect(lastUser).not.toBe(page);
});

class Crumb extends ComponentBase {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("span");
    b.addContent(`${this.route?.path ?? "none"}?${this.route?.query.get("q") ?? ""}`);
    b.closeElement();
  }
}

test("route is cascaded to consumers nested in a section", () => {
  const memory = nav("/users/1?q=a");
  let crumb: Crumb | undefined;
  const r = routed([
    {
      kind: "default",
      render: (_route: Route, page: RenderFragment) =>
        frag((b) => {
          b.addComponent(Crumb, {}, undefined, { ref: (c) => (crumb = c) });
          b.addContent(page);
        }),
    },
  ]);
  expect(r.html()).toBe("<span>/users/1?a</span><u>1</u>");
  expect(crumb!.paramsSet).toBe(1);

  memory.go("/users/2?q=b");
  expect(r.html()).toBe("<span>/users/2?b</span><u>2</u>");
  expect(crumb!.paramsSet).toBe(2);
});

test("route.is narrows by the matched route's tag", () => {
  nav("/users/7");
  let captured: Route | undefined;
  routed([
    {
      kind: "default",
      render: (route: Route, page: RenderFragment) => {
        captured = route;
        return wrap("aside")(route, page);
      },
    },
  ]);
  expect(captured!.tag).toBe("admin");
  expect(captured!.is("admin")).toBe(true);
  expect(captured!.is("other")).toBe(false);
});

test("navigate pushes by default and replaces on request", () => {
  const memory = nav("/users/1");
  let captured: Route | undefined;
  const r = routed([
    {
      kind: "default",
      render: (route: Route, page: RenderFragment) => {
        captured = route;
        return wrap("aside")(route, page);
      },
    },
  ]);

  captured!.navigate("/users/2");
  expect(memory.calls).toEqual([["/users/2", false]]);
  expect(r.html()).toBe("<aside><u>2</u></aside>");

  captured!.navigate("/users/3", { replace: true });
  expect(memory.calls[1]).toEqual(["/users/3", true]);
  expect(r.html()).toBe("<aside><u>3</u></aside>");
});

const links = (_route: Route, page: RenderFragment): RenderFragment =>
  frag((b) => {
    b.addContent(page);
    const link = (href: string, attrs: Record<string, string> = {}) => {
      b.openElement("a");
      b.addAttribute("href", href);
      for (const [name, value] of Object.entries(attrs)) b.addAttribute(name, value);
      b.addText(href);
      b.closeElement();
    };
    link("/users/2");
    link("/users/3", { target: "_blank" });
    link("/users/4", { download: "" });
    link("/users/5", { rel: "noopener external" });
    link("http://elsewhere.test/users/6");
    link("/users/7", { target: "_self" });
  });

test("a plain in-app link is intercepted and navigates", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: links }]);

  expect(r.click(r.host.querySelectorAll("a")[0]!)).toBe(true);
  expect(location.pathname).toBe("/users/2");
  expect(r.html()).toContain("<u>2</u>");

  expect(r.click(r.host.querySelectorAll("a")[5]!)).toBe(true);
  expect(location.pathname).toBe("/users/7");
});

test("modified clicks and opted-out links are left to the browser", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: links }]);
  const anchor = (index: number) => r.host.querySelectorAll("a")[index]!;

  const modifiers: MouseEventInit[] = [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ];
  for (const init of modifiers) {
    expect(r.click(anchor(0), init)).toBe(false);
  }
  // target=_blank, download, rel=external and another origin.
  for (const index of [1, 2, 3, 4]) {
    expect(r.click(anchor(index))).toBe(false);
  }
  expect(location.pathname).toBe("/users/1");
  expect(r.html()).toContain("<u>1</u>");
});

const hashLinks = (_route: Route, page: RenderFragment): RenderFragment =>
  frag((b) => {
    b.addContent(page);
    for (const href of ["#part2", "/users/1#part2", "/users/2#part2"]) {
      b.openElement("a");
      b.addAttribute("href", href);
      b.addText(href);
      b.closeElement();
    }
  });

test("a link that only moves to a fragment of this page is left to the browser", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: hashLinks }]);
  const anchor = (index: number) => r.host.querySelectorAll("a")[index]!;

  expect(r.click(anchor(0))).toBe(false);
  expect(r.click(anchor(1))).toBe(false);
  expect(location.pathname).toBe("/users/1");

  expect(r.click(anchor(2))).toBe(true);
  expect(location.pathname).toBe("/users/2");
});

test("the navigation listeners go away with the routes block", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: wrap("aside") }]);
  const outside = document.createElement("a");
  outside.setAttribute("href", "/users/9");
  document.body.append(outside);

  expect(r.click(outside)).toBe(true);
  expect(location.pathname).toBe("/users/9");
  expect(r.html()).toBe("<aside><u>9</u></aside>");

  r.drop();
  expect(r.click(outside)).toBe(false);
  expect(location.pathname).toBe("/users/9");
  outside.remove();
});

test("popstate re-renders the routes block", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: wrap("aside") }]);
  expect(r.html()).toBe("<aside><u>1</u></aside>");

  history.replaceState(null, "", "/users/2");
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(r.html()).toBe("<aside><u>2</u></aside>");
});

test("viewTransitions(true) commits a navigation inside document.startViewTransition", () => {
  const doc = document as unknown as { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  let called = 0;
  doc.startViewTransition = (cb) => {
    called++;
    cb();
    // As when the browser skips the animation: the rejection must be handled.
    return { ready: Promise.reject(new Error("skipped")) };
  };
  try {
    history.replaceState(null, "", "/users/1");
    const r = routed([{ kind: "default", render: wrap("aside") }]);
    history.replaceState(null, "", "/users/2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(called).toBe(0);

    viewTransitions(true);
    history.replaceState(null, "", "/users/3");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(called).toBe(1);
    expect(r.html()).toBe("<aside><u>3</u></aside>");

    delete doc.startViewTransition;
    history.replaceState(null, "", "/users/4");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(r.html()).toBe("<aside><u>4</u></aside>");
  } finally {
    viewTransitions(false);
    delete doc.startViewTransition;
  }
});

class ThrowingCtor extends ComponentBase {
  constructor() {
    super();
    throw new Error("ctor");
  }
  protected override buildRenderTree(): void {}
}

class ThrowingInit extends ComponentBase {
  protected override onInitialized(): void {
    throw new Error("init");
  }
  protected override buildRenderTree(): void {}
}

class RejectingInit extends ComponentBase {
  protected override onInitializedAsync(): Promise<void> {
    return Promise.reject(new Error("init async"));
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addText("waiting");
  }
}

class ThrowingRender extends ComponentBase {
  protected override buildRenderTree(): void {
    throw new Error("render");
  }
}

class InjectedPage extends ComponentBase {
  static readonly inject = ["service"];
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addText("injected");
  }
}

const breaking = (component: unknown): RouteTable => [
  {
    tag: undefined,
    pattern: "/boom",
    component,
    match: (s) => (s.length === 1 && s[0] === "boom" ? {} : null),
  },
  ...pages,
];

const caught: RouteSection[] = [
  { kind: "catch", render: (route: Route, error: unknown) => label("em", () => String(error))(route) },
  { kind: "default", render: wrap("aside") },
];

test("@catch renders for a page whose constructor throws", async () => {
  nav("/boom");
  const r = routed(caught, { table: breaking(ThrowingCtor) });
  await tick();
  expect(r.html()).toBe("<em>Error: ctor</em>");
});

test("@catch renders for a page whose onInitialized throws", async () => {
  nav("/boom");
  const r = routed(caught, { table: breaking(ThrowingInit) });
  await tick();
  expect(r.html()).toBe("<em>Error: init</em>");
});

test("@catch renders for a page whose onInitializedAsync rejects", async () => {
  nav("/boom");
  const r = routed(caught, { table: breaking(RejectingInit) });
  await tick();
  expect(r.html()).toBe("<em>Error: init async</em>");
});

test("@catch renders for a page whose first render throws", async () => {
  nav("/boom");
  const r = routed(caught, { table: breaking(ThrowingRender) });
  await tick();
  expect(r.html()).toBe("<em>Error: render</em>");
});

test("@catch renders for a page the application fails to build", async () => {
  nav("/boom");
  const app: IApplication = { createComponent: () => Promise.reject(new Error("di")) };
  const r = routed(caught, { table: breaking(InjectedPage), app });
  await tick();
  expect(r.html()).toBe("<em>Error: di</em>");
});

test("@catch is cleared by the next navigation", async () => {
  const memory = nav("/boom");
  const r = routed(caught, { table: breaking(ThrowingRender) });
  await tick();
  expect(r.html()).toBe("<em>Error: render</em>");

  memory.go("/users/1");
  expect(r.html()).toBe("<aside><u>1</u></aside>");
});

let failSlow: ((err: unknown) => void) | undefined;

class SlowPage extends ComponentBase {
  protected override onInitializedAsync(): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      failSlow = reject;
    });
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addText("slow");
  }
}

test("a failure from the page we navigated away from is not shown on the new route", async () => {
  const memory = nav("/boom");
  const r = routed(caught, { table: breaking(SlowPage) });
  expect(r.html()).toBe("<aside>slow</aside>");

  memory.go("/users/1");
  expect(r.html()).toBe("<aside><u>1</u></aside>");

  failSlow!(new Error("late"));
  await tick();
  expect(r.html()).toBe("<aside><u>1</u></aside>");
});

test("a page the application fails to build after we left is dropped, not reported", async () => {
  const memory = nav("/boom");
  let failBuild: ((err: unknown) => void) | undefined;
  const app: IApplication = { createComponent: () => new Promise((_resolve, reject) => (failBuild = reject)) };
  const r = routed(caught, { table: breaking(InjectedPage), app });
  memory.go("/users/1");
  expect(r.html()).toBe("<aside><u>1</u></aside>");

  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    errors.push(e.error);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  process.on("uncaughtException", onError as never);
  failBuild!(new Error("di late"));
  await tick();
  await tick();
  window.removeEventListener("error", onError);
  process.off("uncaughtException", onError as never);
  expect(errors).toEqual([]);
  expect(r.html()).toBe("<aside><u>1</u></aside>");
});

test("a page kept across a query-only navigation still reports its failure", async () => {
  const memory = nav("/boom");
  const r = routed(caught, { table: breaking(SlowPage) });
  memory.go("/boom?x=1");
  expect(r.html()).toBe("<aside>slow</aside>");

  failSlow!(new Error("kept"));
  await tick();
  expect(r.html()).toBe("<em>Error: kept</em>");
});

let tracked: Tracked | undefined;

class Tracked extends ComponentBase {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  paramsSet = 0;
  disposed = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override dispose(): void {
    this.disposed++;
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addText("ok");
  }
}

class PartlyMounted extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addComponent(Tracked, {}, undefined, { ref: (c) => (tracked = c) });
    b.addComponent(ThrowingCtor, {});
  }
}

test("@catch disposes the children the failed page had already mounted", async () => {
  const memory = nav("/boom");
  const r = routed(caught, { table: breaking(PartlyMounted) });
  await tick();
  expect(r.html()).toBe("<em>Error: ctor</em>");
  const child = tracked!;
  expect(child.disposed).toBe(1);
  expect(child.paramsSet).toBe(1);

  memory.go("/users/1");
  memory.go("/users/2");
  expect(child.paramsSet).toBe(1);
});

class RedirectPage extends ComponentBase {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  protected override onInitialized(): void {
    this.route!.navigate("/users/1", { replace: true });
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addText("redirect");
  }
}

test("a navigation started during the first render is applied once it finishes", async () => {
  const memory = nav("/boom");
  const r = routed([{ kind: "default", render: wrap("aside") }], { table: breaking(RedirectPage) });

  expect(memory.calls).toEqual([["/users/1", true]]);
  await tick();
  expect(r.html()).toBe("<aside><u>1</u></aside>");
});

test("a regex section matches in the browser", () => {
  const memory = nav("/users/1");
  const r = routed([
    { kind: "regex", re: /^\/docs\/(?<area>\w+)/, page: true, render: label("b", (route) => route.match.area) },
    { kind: "default", render: wrap("aside") },
  ]);
  expect(r.html()).toBe("<aside><u>1</u></aside>");

  memory.go("/docs/api");
  expect(r.html()).toBe("<b>api</b>");
});

test("links navigate in the browser and intercept link clicks", () => {
  history.replaceState(null, "", "/users/1");
  const r = routed([{ kind: "default", render: links }]);
  expect(r.click(r.host.querySelectorAll("a")[0]!)).toBe(true);
  expect(location.pathname).toBe("/users/2");
});

const navLinks = (_route: Route, page: RenderFragment): RenderFragment =>
  frag((b) => {
    b.addContent(page);
    const content = (text: string) => ({ default: () => frag((c) => c.addText(text)) });
    b.addComponent(NavLink, { href: "/users" }, content("all"));
    b.addComponent(NavLink, { href: "/users", match: "exact" }, content("exact"));
    b.addComponent(NavLink, { href: "/users/7", activeClass: "on" }, content("seven"));
    b.addComponent(NavLink, { href: "/" }, content("home"));
  });

test("NavLink marks the active link by prefix or exact match", () => {
  const memory = nav("/users/7");
  const r = routed([{ kind: "default", render: navLinks }]);
  const classes = () => Array.from(r.host.querySelectorAll("a"), (a) => a.getAttribute("class"));
  expect(classes()).toEqual(["active", null, "on", null]);
  expect(r.host.querySelector("a")!.getAttribute("href")).toBe("/users");

  memory.go("/users");
  expect(classes()).toEqual(["active", "active", null, null]);

  memory.go("/");
  expect(classes()).toEqual([null, null, null, "active"]);
  expect(Array.from(r.host.querySelectorAll("a"), (a) => a.getAttribute("aria-current"))).toEqual([null, null, null, "page"]);
});

/** Mounts `links` with no routes block anywhere in the tree. */
function bare(links: (b: RenderTreeBuilder) => void) {
  class Bar extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      links(b);
    }
  }
  class Shell extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(Bar, {});
      b.closeRegion();
    }
  }
  const host = document.createElement("div");
  document.body.append(host);
  const shell = mount(Shell, host);
  const drop = () => {
    shell.show = false;
    shell.stateHasChanged();
  };
  live.push({ host, drop, unguard: () => {} });
  return { host, drop, classes: () => Array.from(host.querySelectorAll("a"), (a) => a.getAttribute("class")) };
}

const text = (s: string) => ({ default: () => frag((c) => c.addText(s)) });

test("NavLink works outside the routes block and follows navigation by itself", () => {
  const memory = nav("/users/7");
  const r = bare((b) => {
    b.addComponent(NavLink, { href: "/users" }, text("a"));
    b.addComponent(NavLink, { href: "/" }, text("b"));
  });
  expect(r.classes()).toEqual(["active", null]);

  memory.go("/");
  expect(r.classes()).toEqual([null, "active"]);
});

test("each NavLink holds one subscription, released when it is disposed", () => {
  const memory = nav("/");
  const r = bare((b) => {
    b.addComponent(NavLink, { href: "/a" }, text("a"));
    b.addComponent(NavLink, { href: "/b" }, text("b"));
  });
  expect(memory.subs.size).toBe(2);
  memory.go("/a");
  memory.go("/b");
  expect(memory.subs.size).toBe(2);

  r.drop();
  expect(memory.subs.size).toBe(0);
});

test("a NavLink alone does not take over link clicks", () => {
  history.replaceState(null, "", "/");
  const r = bare((b) => b.addComponent(NavLink, { href: "/users/2" }, text("a")));
  let prevented: boolean | undefined;
  const guard = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener("click", guard);
  r.host.querySelector("a")!.dispatchEvent(event({}));
  document.removeEventListener("click", guard);
  expect(prevented).toBe(false);
  expect(location.pathname).toBe("/");
});

test("NavLink resolves a relative href against the base url", () => {
  const memory = nav("/users/7");
  const r = bare((b) => {
    b.addComponent(NavLink, { href: "users" }, text("a"));
    b.addComponent(NavLink, { href: "users/7?tab=1#x", match: "exact" }, text("b"));
    b.addComponent(NavLink, { href: "../other" }, text("c"));
    b.addComponent(NavLink, { href: "http://elsewhere.test/users" }, text("d"));
  });
  expect(r.classes()).toEqual(["active", "active", null, null]);
  expect(r.host.querySelector("a")!.getAttribute("href")).toBe("users");

  memory.go("/other");
  expect(r.classes()).toEqual([null, null, "active", null]);
});

test("NavLink compares encoded paths whichever way the href is written", () => {
  const memory = nav("/caf%C3%A9/a%20b");
  const r = bare((b) => {
    b.addComponent(NavLink, { href: "/café/a b", match: "exact" }, text("a"));
    b.addComponent(NavLink, { href: "/caf%C3%A9" }, text("b"));
    b.addComponent(NavLink, { href: "/café" }, text("c"));
    b.addComponent(NavLink, { href: "/cafe" }, text("d"));
  });
  expect(r.classes()).toEqual(["active", "active", "active", null]);
  memory.go("/cafe");
  expect(r.classes()).toEqual([null, null, null, "active"]);
});
