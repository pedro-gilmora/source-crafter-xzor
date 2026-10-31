import { beforeEach, expect, test } from "bun:test";
import { $leave, Component, type El, HttpError, type Remote, call, dom, lazy, mount, segment } from "./index";
import { HttpError as ServerHttpError } from "./server";

const realFetch = globalThis.fetch;
function stub(res: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => (seen.push({ url, init }), res)) as unknown as typeof fetch;
  return seen;
}

test("call sends the query without undefined keys and the body as JSON", async () => {
  const seen = stub(Response.json({ ok: 1 }));
  try {
    expect(await call("POST", "/api/posts", { tag: "a b", page: 2, none: undefined }, { title: "t" })).toEqual({ ok: 1 });
    expect(seen[0].url).toBe("/api/posts?tag=a+b&page=2");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(seen[0].init.body).toBe('{"title":"t"}');
    const bare = stub(Response.json(1));
    await call("GET", "/api/posts", undefined, undefined);
    expect(bare[0].url).toBe("/api/posts");
    expect(bare[0].init.body).toBeUndefined();
    expect(bare[0].init.headers).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("call resolves undefined for 404 and 204 and rejects other failures with HttpError", async () => {
  try {
    stub(new Response("nope", { status: 404 }));
    expect(await call("GET", "/x", undefined, undefined)).toBeUndefined();
    stub(new Response(null, { status: 204 }));
    expect(await call("DELETE", "/x", undefined, undefined)).toBeUndefined();
    stub(new Response("boom", { status: 500 }));
    const err = (await call("GET", "/x", undefined, undefined).catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("boom");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("call resolves undefined for a 200 with an empty body", async () => {
  try {
    stub(new Response("", { status: 200 }));
    expect(await call("POST", "/x", undefined, undefined)).toBeUndefined();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("segment encodes a path parameter and rejects the ones URL normalization would turn into another route", () => {
  expect(segment("a b/c")).toBe("a%20b%2Fc");
  expect(segment(7)).toBe("7");
  expect(segment("...")).toBe("...");
  for (const bad of ["", ".", ".."]) {
    const err = (() => {
      try {
        segment(bad);
      } catch (e) {
        return e as HttpError;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(400);
  }
  // Why: the URL parser resolves dot segments, and no encoding of `..` prevents it.
  expect(new URL("/api/posts/" + encodeURIComponent("..") + "/comments", "http://x").pathname).toBe("/api/comments");
});

test("the server's HttpError is the main export's class", () => {
  expect(ServerHttpError).toBe(HttpError);
});

// Checked by `bun x tsc -p jsconfig.json --noEmit`.
test("Remote<T> makes every method async and the rest never", () => {
  interface IApi {
    a(x: number, label?: string): string;
    b(): Promise<number>;
    c(): void;
    name: string;
  }
  type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
  const ok: [
    Same<Remote<IApi>["a"], (x: number, label?: string) => Promise<string>>,
    Same<Remote<IApi>["b"], () => Promise<number>>,
    Same<Remote<IApi>["c"], () => Promise<void>>,
    Same<Remote<IApi>["name"], never>,
  ] = [true, true, true, true];
  expect(ok).toEqual([true, true, true, true]);
  // Type-checked only.
  const misuse = (api: Remote<IApi>) => {
    // @ts-expect-error `a` takes a number
    api.a("1");
    // @ts-expect-error a result is always a promise
    const n: number = api.b();
    return n;
  };
  expect(misuse).toBeFunction();
});

// Components below are written the way xzor's codegen emits them.

let renders: Record<string, number>;
const rendered = (key: string) => (renders[key] = (renders[key] ?? 0) + 1);
let params: string[];

class Counter extends Component {
  label = "";
  count = 0;

  protected override onParametersSet(): void {
    params.push(this.label);
  }

  protected override render(__p: Node): void {
    rendered(this.label);
    const _e0 = __counter() as El<"div">;
    const _e1 = _e0.firstChild as El<"span">;
    const _e2 = _e1.nextSibling as El<"button">;
    const _e3 = _e2.nextSibling as El<"button">;
    const _e4 = _e3.nextSibling!.nextSibling!.nextSibling as Comment;
    const _e5 = _e4.nextSibling as El<"i">;
    dom.textAt(_e1.firstChild as Text, () => this.count);
    dom.on(_e2, "click", () => this.count++);
    dom.on(_e3, "click", () => (this.count = 0));
    dom.branchAt(_e4, (__p) => {
      if (this.count > 0) {
        if (!__p) return 0;
        const _e6 = __positive() as El<"p">;
        __p.appendChild(_e6);
      }
      return 1;
    });
    dom.attr(_e5, "data-zero", () => this.count === 0);
    __p.appendChild(_e0);
  }
}

class App extends Component {
  title = "app";
  firstLabel = "a";
  items = ["x", "y"];

  protected override render(__p: Node): void {
    rendered("app");
    const _e0 = __app();
    const _e1 = _e0.firstChild as El<"h1">;
    const _e2 = _e1.nextSibling as Comment;
    const _e3 = _e2.nextSibling as Comment;
    const _e4 = _e3.nextSibling as El<"ul">;
    const _e5 = _e4.firstChild!.nextSibling as Comment;
    dom.textAt(_e1.firstChild as Text, () => this.title);
    dom.component(_e2, Counter, (): Partial<Counter> => ({ label: this.firstLabel }));
    dom.component(_e3, Counter, (): Partial<Counter> => ({ label: "b" }));
    dom.listAt(_e5, () => this.items, [(item) => item], (__p) => {
      const _e6 = __li() as El<"li">;
      dom.textItem(_e6.firstChild as Text, 0);
      __p.appendChild(_e6);
    });
    __p.appendChild(_e0);
  }
}

const __counter = dom.template([["div", 0, ["span", 0, ""], ["button", 0, "+"], ["button", 0, "0"], ["input", 0], null, null, ["i", 0, "end"]]]);
const __positive = dom.template([["p", 0, "positive"]]);
const __app = dom.template([["h1", 0, ""], null, null, ["ul", 0, null, null]]);
const __li = dom.template([["li", 0, ""]]);

function setup() {
  renders = {};
  params = [];
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const app = mount(App, host);
  const [a, b] = Array.from(host.querySelectorAll("div"));
  const buttons = (el: Element) => Array.from(el.querySelectorAll("button"));
  return { host, app, a: a!, b: b!, buttons };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const tags = (el: Element) => Array.from(el.children, (c) => c.tagName.toLowerCase());

beforeEach(() => document.body.replaceChildren());

test("a data-leave element the region removes leaves when its animations finish; without any, at once", async () => {
  Component.$leaves = true;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  class Toast extends Component {
    show = true;
    protected override render(__p: Node): void {
      const _e0 = __toast();
      const _e1 = _e0.firstChild!.nextSibling as Comment;
      dom.branchAt(_e1, (__p) => {
        if (this.show) {
          if (!__p) return 0;
          __p.appendChild(__leaving());
        }
        return 1;
      });
      __p.appendChild(_e0);
    }
  }
  const __toast = dom.template([null, null]);
  const __leaving = dom.template([["output", ["data-leave", ""]], ["b", 0]]);
  const host = document.createElement("main");
  document.body.append(host);
  const t = mount(Toast, host);
  const output = host.querySelector("output")!;
  (output as unknown as { getAnimations(): unknown[] }).getAnimations = () => [{ finished }];
  t.show = false;
  t.stateHasChanged();
  expect(output.isConnected).toBe(true);
  expect(output.hasAttribute("data-leaving")).toBe(true);
  expect(host.querySelector("b")).toBeNull();
  finish();
  await new Promise((r) => setTimeout(r, 0));
  expect(output.isConnected).toBe(false);
});

test("a leaving element waits only for the finite animations its leaving started, not an endless spinner inside (#2)", async () => {
  Component.$leaves = true;
  const endless = (): { finished: Promise<void>; effect: { getComputedTiming(): { endTime: number } } } => ({
    finished: new Promise<void>(() => {}),
    effect: { getComputedTiming: () => ({ endTime: Infinity }) },
  });
  const spinner = endless();
  let finish!: () => void;
  const fade = { finished: new Promise<void>((r) => (finish = r)), effect: { getComputedTiming: () => ({ endTime: 150 }) } };
  const pulse = endless();
  const dialog = document.createElement("dialog");
  dialog.setAttribute("data-leave", "");
  (dialog as unknown as { getAnimations(): unknown[] }).getAnimations = () => (dialog.hasAttribute("data-leaving") ? [spinner, fade, pulse] : [spinner]);
  const host = document.createElement("main");
  host.append(dialog);
  document.body.append(host);
  $leave(dialog);
  expect(dialog.hasAttribute("data-leaving")).toBe(true);
  expect(dialog.isConnected).toBe(true);
  finish();
  await new Promise((r) => setTimeout(r, 0));
  expect(dialog.isConnected).toBe(false);
});

test("class:name adds to the element's class while on", () => {
  class Field extends Component {
    err = false;
    protected override render(__p: Node): void {
      const _e0 = __field() as El<"div">;
      dom.attr(_e0, "class:invalid", () => this.err);
      __p.appendChild(_e0);
    }
  }
  const __field = dom.template([["div", ["class", "field"]]]);
  const host = document.createElement("main");
  document.body.append(host);
  const f = mount(Field, host);
  const div = host.querySelector("div")!;
  expect(div.className).toBe("field");
  f.err = true;
  f.stateHasChanged();
  expect(div.className).toBe("field invalid");
});

test("aria-* attributes write booleans as true and false", () => {
  class Toggle extends Component {
    open = false;
    protected override render(__p: Node): void {
      const _e0 = __toggle() as El<"button">;
      dom.attr(_e0, "aria-expanded", () => this.open);
      dom.attr(_e0, "hidden", () => this.open);
      __p.appendChild(_e0);
    }
  }
  const __toggle = dom.template([["button", 0]]);
  const host = document.createElement("main");
  document.body.append(host);
  const t = mount(Toggle, host);
  const button = host.querySelector("button")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  t.open = true;
  t.stateHasChanged();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.getAttribute("hidden")).toBe("");
});

test("debounce runs the last call after a pause, once, and settles every call's promise", async () => {
  const input = document.createElement("input");
  const event = (): Event => {
    const e = new Event("input");
    Object.defineProperty(e, "target", { value: input });
    return e;
  };
  let runs = 0;
  const first = Component.debounce(event(), 20, () => runs++);
  const second = Component.debounce(event(), 20, () => (runs++, "done"));
  expect(runs).toBe(0);
  expect(await second).toBe("done");
  await first;
  expect(runs).toBe(1);
});

test("a lazy component holds its place until its module arrives, then mounts there; later uses mount at once", async () => {
  class Chart extends Component {
    label = "";
    protected override render(__p: Node): void {
      const _e0 = __chart() as El<"em">;
      dom.textAt(_e0.firstChild as Text, () => this.label);
      __p.appendChild(_e0);
    }
  }
  const __chart = dom.template([["em", 0, ""]]);
  let loads = 0;
  const LazyChart = lazy(async () => (loads++, { default: Chart }));
  class Page extends Component {
    n = 1;
    protected override render(__p: Node): void {
      const _e0 = __page();
      const _e1 = _e0.firstChild!.nextSibling!.nextSibling as Comment;
      dom.listAt(_e1, () => Array.from({ length: this.n }, (_, i) => `c${i}`), [(label: string): Partial<Chart> => ({ label })], (__p) => {
        dom.componentItem(dom.anchor(__p), LazyChart, 0);
      });
      __p.appendChild(_e0);
    }
  }
  const __page = dom.template([["p", 0, "a"], null, null, ["p", 0, "b"]]);
  const host = document.createElement("main");
  document.body.append(host);
  const page = mount(Page, host);
  expect(host.querySelector("em")).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(host.textContent).toBe("ac0b");
  page.n = 2;
  page.stateHasChanged();
  expect(host.textContent).toBe("ac0c1b");
  expect(loads).toBe(1);
});

test("a cached component leaving the tree keeps its instance and nodes, and comes back with them", () => {
  let made = 0;
  let disposed = 0;
  class Tab extends Component {
    static readonly cached = true;
    label = "";
    clicks = 0;
    constructor() {
      super();
      made++;
    }
    protected override dispose(): void {
      disposed++;
    }
    protected override render(__p: Node): void {
      const _e0 = __tab() as El<"button">;
      dom.on(_e0, "click", () => this.clicks++);
      dom.textAt(_e0.firstChild as Text, () => `${this.label}${this.clicks}`);
      __p.appendChild(_e0);
    }
  }
  const __tab = dom.template([["button", 0, ""]]);
  class Tabs extends Component {
    show = true;
    label = "a";
    protected override render(__p: Node): void {
      const _e0 = __tabs();
      const _e1 = _e0.firstChild!.nextSibling as Comment;
      dom.branchAt(_e1, (__p) => {
        if (this.show) {
          if (!__p) return 0;
          dom.component(dom.anchor(__p), Tab, (): Partial<Tab> => ({ label: this.label }), undefined, undefined, undefined, "k");
        } else {
          if (!__p) return 1;
          dom.t(__p, "none");
        }
        return 2;
      });
      __p.appendChild(_e0);
    }
  }
  const __tabs = dom.template([null, null]);
  const host = document.createElement("main");
  document.body.append(host);
  const tabs = mount(Tabs, host);
  const button = host.querySelector("button")!;
  click(button);
  expect(button.textContent).toBe("a1");
  tabs.show = false;
  tabs.stateHasChanged();
  expect(host.textContent).toBe("none");
  tabs.show = true;
  tabs.label = "b";
  tabs.stateHasChanged();
  expect(host.querySelector("button")).toBe(button);
  expect(button.textContent).toBe("b1");
  expect([made, disposed]).toEqual([1, 0]);
});

test("@attr: sets the nearest open element past regions, and class adds to its own", () => {
  class Stock extends Component {
    n = 0;
    protected override render(__p: Node): void {
      const _e0 = __stock() as El<"span">;
      const _e1 = _e0.firstChild!.nextSibling as Comment;
      dom.branchAt(_e1, (__p) => {
        if (this.n > 0) {
          if (!__p) return 0;
          dom.text(__p, () => this.n);
        } else {
          if (!__p) return 1;
          dom.attrOf(_e0, "class", () => "error-text");
          dom.attrOf(_e0, "title", () => "none");
          dom.t(__p, "Agotado");
        }
        return 2;
      });
      __p.appendChild(_e0);
    }
  }
  const __stock = dom.template([["span", ["class", "cell"], null, null]]);
  const host = document.createElement("main");
  document.body.append(host);
  const c = mount(Stock, host);
  const span = host.querySelector("span")!;
  expect(span.getAttribute("class")).toBe("cell error-text");
  expect(span.getAttribute("title")).toBe("none");
  c.n = 3;
  c.stateHasChanged();
  expect(host.querySelector("span")).toBe(span);
  expect(span.getAttribute("class")).toBe("cell");
  expect(span.hasAttribute("title")).toBe(false);
});

test("an event updates only the owning component's nodes, in place, and builds nothing again", () => {
  const { host, a, b, buttons } = setup();
  const span = a.querySelector("span")!;
  const text = span.firstChild;
  const input = a.querySelector("input")!;
  const h1 = host.querySelector("h1")!;
  const bSpanText = b.querySelector("span")!.firstChild;
  expect(renders).toEqual({ app: 1, a: 1, b: 1 });
  params.length = 0;

  click(buttons(a)[0]!);

  expect(renders).toEqual({ app: 1, a: 1, b: 1 });
  expect(params).toEqual([]);
  expect(span.textContent).toBe("1");
  expect(span.firstChild).toBe(text);
  expect(a.querySelector("input")).toBe(input);
  expect(host.querySelector("h1")).toBe(h1);
  expect(host.querySelectorAll("div")[0]).toBe(a);
  expect(b.querySelector("span")!.firstChild).toBe(bSpanText);
  expect(b.querySelector("span")!.textContent).toBe("0");
});

class Styled extends Component {
  width = 10;

  protected override render(__p: Node): void {
    const _e0 = __styled() as El<"div">;
    dom.attr(_e0, "--w", () => (this.width === 0 ? null : this.width + "px"));
    dom.on(_e0, "click", () => (this.width = this.width ? 0 : 5));
    __p.appendChild(_e0);
  }
}

const __styled = dom.template([["div", 0]]);

test("a -- attribute writes a custom property in the render pass, and null removes it", () => {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  mount(Styled, host);
  const div = host.querySelector("div")!;
  expect(div.style.getPropertyValue("--w")).toBe("10px");
  expect(div.hasAttribute("--w")).toBe(false);
  click(div);
  expect(div.style.getPropertyValue("--w")).toBe("");
  click(div);
  expect(div.style.getPropertyValue("--w")).toBe("5px");
});

test("conditional blocks insert and remove without recreating siblings", () => {
  const { a, buttons } = setup();
  const i = a.querySelector("i")!;
  expect(tags(a)).toEqual(["span", "button", "button", "input", "i"]);

  click(buttons(a)[0]!);
  expect(tags(a)).toEqual(["span", "button", "button", "input", "p", "i"]);
  expect(a.querySelector("p")!.textContent).toBe("positive");
  expect(a.querySelector("i")).toBe(i);

  click(buttons(a)[1]!);
  expect(tags(a)).toEqual(["span", "button", "button", "input", "i"]);
  expect(a.querySelector("i")).toBe(i);
});

test("boolean attributes are added and removed", () => {
  const { a, buttons } = setup();
  const i = a.querySelector("i")!;
  expect(i.hasAttribute("data-zero")).toBe(true);
  click(buttons(a)[0]!);
  expect(i.hasAttribute("data-zero")).toBe(false);
  click(buttons(a)[1]!);
  expect(i.getAttribute("data-zero")).toBe("");
});

test("a parent update leaves children whose props did not change alone, and hands the changed ones their new props", () => {
  const { host, app, a } = setup();
  expect(params).toEqual(["a", "b"]);
  params.length = 0;
  app.title = "changed";
  app.stateHasChanged();
  expect(params).toEqual([]);
  expect(host.querySelector("h1")!.textContent).toBe("changed");

  app.firstLabel = "a2";
  app.stateHasChanged();
  expect(params).toEqual(["a2"]);
  expect(renders).toEqual({ app: 1, a: 1, b: 1 });
  expect(host.querySelectorAll("div")[0]).toBe(a);
});

test("loops grow and shrink in place, keeping the rows that stay", () => {
  const { host, app } = setup();
  const ul = host.querySelector("ul")!;
  const [x, y] = Array.from(ul.querySelectorAll("li"));

  app.items = ["x", "y", "z"];
  app.stateHasChanged();
  expect(Array.from(ul.querySelectorAll("li"), (li) => li.textContent)).toEqual(["x", "y", "z"]);
  expect(ul.querySelector("li")).toBe(x!);

  app.items = ["x"];
  app.stateHasChanged();
  expect(Array.from(ul.querySelectorAll("li"), (li) => li.textContent)).toEqual(["x"]);
  expect(ul.querySelector("li")).toBe(x!);
  expect(y!.isConnected).toBe(false);
});

test("async handlers update again when they settle", async () => {
  class Loader extends Component {
    state = "idle";
    protected override render(__p: Node): void {
      const _e0 = __loader() as El<"button">;
      dom.on(_e0, "click", async () => {
        this.state = "loading";
        await Promise.resolve();
        this.state = "done";
      });
      dom.textAt(_e0.firstChild as Text, () => this.state);
      __p.appendChild(_e0);
    }
  }
  const __loader = dom.template([["button", 0, ""]]);
  const host = document.createElement("div");
  document.body.append(host);
  mount(Loader, host);
  const button = host.querySelector("button")!;
  click(button);
  expect(button.textContent).toBe("loading");
  await new Promise((r) => setTimeout(r, 0));
  expect(button.textContent).toBe("done");
  expect(host.querySelector("button")).toBe(button);
});

test("<svg> elements and their children in a template are created in the SVG namespace", () => {
  class Icon extends Component {
    d = "M0 0";
    protected override render(__p: Node): void {
      const _e0 = __icon() as El<"svg">;
      dom.attr(_e0.firstChild as Element, "d", () => this.d);
      __p.appendChild(_e0);
    }
  }
  // An SVG child alone in a region is HTML, so the <svg> stays in the same template.
  const __icon = dom.template([["svg", ["viewBox", "0 0 24 24"], ["path", 0]]]);
  const host = document.createElement("div");
  const c = mount(Icon, host);
  const SVG = "http://www.w3.org/2000/svg";
  expect(host.querySelector("svg")!.namespaceURI).toBe(SVG);
  expect(host.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(host.querySelector("path")!.namespaceURI).toBe(SVG);
  c.d = "M1 1";
  c.stateHasChanged();
  expect(host.querySelector("path")!.getAttribute("d")).toBe("M1 1");
});
