import { afterEach, expect, test } from "bun:test";
import {
  Component,
  dom,
  type DomRouteSection,
  type IApplication,
  type Markup,
  type Route,
  type RouteTable,
  mount,
  setNavigationForTests,
} from "./index";

// happy-dom starts on about:blank, where relative URLs and pushState are not allowed.
(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost/");

// Written the way xzor emits `@Routes`: a hand-written table in the shape of
// `.xzor/routes.ts` and sections in the shape of the generated descriptors.

let lastUser: UserPage | undefined;

class UserPage extends Component {
  id = 0;
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override render(__p: Node): void {
    lastUser = this;
    dom.text(dom.el(__p, "u"), () => (this.renders++, this.id));
  }
}

class NewUser extends Component {
  protected override render(__p: Node): void {
    dom.t(dom.el(__p, "n"), "new");
  }
}

class DocPage extends Component {
  rest = "";
  protected override render(__p: Node): void {
    dom.text(dom.el(__p, "d"), () => this.rest);
  }
}

class RootPage extends Component {
  protected override render(__p: Node): void {
    dom.t(dom.el(__p, "r"), "root");
  }
}

class ListPage extends Component {
  protected override render(__p: Node): void {
    dom.t(dom.el(__p, "l"), "list");
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

/** A layout section: renders the page inside `tag`. */
const wrap =
  (tag: string) =>
  (_route: Route, page: Markup): Markup =>
    Component.$fragment((__p) => dom.text(dom.el(__p, tag), () => page));

/** A page-less section: renders one value read from `route`. */
const label =
  (tag: string, read: (route: Route) => unknown) =>
  (route: Route): Markup =>
    Component.$fragment((__p) => dom.text(dom.el(__p, tag), () => read(route)));

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
  sections: DomRouteSection[],
  opts: { table?: RouteTable; app?: IApplication } = {},
) {
  const table = opts.table ?? pages;
  class Shell extends Component {
    show = true;
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.show) dom.routesAt(dom.anchors(__p), table, sections);
      });
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
      render: (route: Route, page: Markup) =>
        Component.$fragment((__p) => {
          const _e0 = dom.el(__p, "i");
          dom.text(_e0, () => route.match.area);
          dom.text(_e0, () => page);
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
      render: (route: Route, page: Markup) => {
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

class Crumb extends Component {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override render(__p: Node): void {
    dom.text(dom.el(__p, "span"), () => `${this.route?.path ?? "none"}?${this.route?.query.get("q") ?? ""}`);
  }
}

test("route is cascaded to consumers nested in a section", () => {
  const memory = nav("/users/1?q=a");
  let crumb: Crumb | undefined;
  const r = routed([
    {
      kind: "default",
      render: (_route: Route, page: Markup) =>
        Component.$fragment((__p) => {
          dom.component(dom.anchor(__p), Crumb, () => ({}), undefined, undefined, (c) => (crumb = c as Crumb));
          dom.text(__p, () => page);
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
      render: (route: Route, page: Markup) => {
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
      render: (route: Route, page: Markup) => {
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
