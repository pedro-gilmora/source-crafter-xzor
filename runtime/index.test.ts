import { beforeEach, expect, test } from "bun:test";
import { $leave, ComponentBase, type RenderTreeBuilder, lazy, mount } from "./index";

// Components below are written the way xzor's codegen emits them.

let renders: Record<string, number>;
const rendered = (key: string) => (renders[key] = (renders[key] ?? 0) + 1);

class Counter extends ComponentBase {
  label = "";
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    rendered(this.label);
    b.openElement("div");
    b.openElement("span");
    b.addContent(this.count);
    b.closeElement();
    b.openElement("button");
    b.addEventHandler("click", () => this.count++);
    b.addText("+");
    b.closeElement();
    b.openElement("button");
    b.addEventHandler("click", () => (this.count = 0));
    b.addText("0");
    b.closeElement();
    b.openElement("input");
    b.closeElement();
    b.openRegion();
    if (this.count > 0) {
      b.openElement("p");
      b.addText("positive");
      b.closeElement();
    }
    b.closeRegion();
    b.openElement("i");
    b.addAttribute("data-zero", this.count === 0);
    b.addText("end");
    b.closeElement();
    b.closeElement();
  }
}

class App extends ComponentBase {
  title = "app";
  firstLabel = "a";
  items = ["x", "y"];

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    rendered("app");
    b.openElement("h1");
    b.addContent(this.title);
    b.closeElement();
    b.addComponent(Counter, { label: this.firstLabel });
    b.addComponent(Counter, { label: "b" });
    b.openElement("ul");
    b.openRegion();
    for (const item of this.items) {
      b.openElement("li");
      b.addContent(item);
      b.closeElement();
    }
    b.closeRegion();
    b.closeElement();
  }
}

function setup() {
  renders = {};
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

test("a data-leave element the diff removes leaves when its animations finish; without any, at once", async () => {
  ComponentBase.$leaves = true;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  class Toast extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) {
        b.openElement("output");
        b.addAttribute("data-leave", "");
        b.closeElement();
        b.openElement("b");
        b.closeElement();
      }
      b.closeRegion();
    }
  }
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
  ComponentBase.$leaves = true;
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

test("toggleClass adds to the element's class while on", () => {
  class Field extends ComponentBase {
    err = false;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("div");
      b.addAttribute("class", "field");
      b.toggleClass("invalid", this.err);
      b.closeElement();
    }
  }
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
  class Toggle extends ComponentBase {
    open = false;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("button");
      b.addAttribute("aria-expanded", this.open);
      b.addAttribute("hidden", this.open);
      b.closeElement();
    }
  }
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
  const first = ComponentBase.debounce(event(), 20, () => runs++);
  const second = ComponentBase.debounce(event(), 20, () => (runs++, "done"));
  expect(runs).toBe(0);
  expect(await second).toBe("done");
  await first;
  expect(runs).toBe(1);
});

test("a lazy component holds its place until its module arrives, then mounts there; later uses mount at once", async () => {
  class Chart extends ComponentBase {
    label = "";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("em");
      b.addContent(this.label);
      b.closeElement();
    }
  }
  let loads = 0;
  const LazyChart = lazy(async () => (loads++, { default: Chart }));
  class Page extends ComponentBase {
    n = 1;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("p");
      b.addText("a");
      b.closeElement();
      for (let i = 0; i < this.n; i++) b.addComponent(LazyChart, { label: `c${i}` });
      b.openElement("p");
      b.addText("b");
      b.closeElement();
    }
  }
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
  class Tab extends ComponentBase {
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
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("button");
      b.addEventHandler("click", () => this.clicks++);
      b.addContent(`${this.label}${this.clicks}`);
      b.closeElement();
    }
  }
  class Tabs extends ComponentBase {
    show = true;
    label = "a";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      if (this.show) b.addComponent(Tab, { label: this.label });
      else b.addText("none");
    }
  }
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
  class Stock extends ComponentBase {
    n = 0;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("span");
      b.addAttribute("class", "cell");
      b.openRegion();
      if (this.n > 0) b.addContent(this.n);
      else {
        b.addParentAttribute("class", "error-text");
        b.addParentAttribute("title", "none");
        b.addText("Agotado");
      }
      b.closeRegion();
      b.closeElement();
    }
  }
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

test("an event re-renders only the owning component and patches nodes in place", () => {
  const { host, a, b, buttons } = setup();
  const span = a.querySelector("span")!;
  const text = span.firstChild;
  const input = a.querySelector("input")!;
  const h1 = host.querySelector("h1")!;
  const bSpanText = b.querySelector("span")!.firstChild;
  expect(renders).toEqual({ app: 1, a: 1, b: 1 });

  click(buttons(a)[0]!);

  expect(renders).toEqual({ app: 1, a: 2, b: 1 });
  expect(span.textContent).toBe("1");
  expect(span.firstChild).toBe(text);
  expect(a.querySelector("input")).toBe(input);
  expect(host.querySelector("h1")).toBe(h1);
  expect(host.querySelectorAll("div")[0]).toBe(a);
  expect(b.querySelector("span")!.firstChild).toBe(bSpanText);
});

class Styled extends ComponentBase {
  width = 10;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("div");
    b.addAttribute("--w", this.width === 0 ? null : this.width + "px");
    b.addEventHandler("click", () => (this.width = this.width ? 0 : 5));
    b.closeElement();
  }
}

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

test("parent re-render skips children whose props did not change", () => {
  const { host, app, a } = setup();
  app.title = "changed";
  app.stateHasChanged();
  expect(renders).toEqual({ app: 2, a: 1, b: 1 });
  expect(host.querySelector("h1")!.textContent).toBe("changed");

  app.firstLabel = "a2";
  app.stateHasChanged();
  expect(renders).toEqual({ app: 3, a: 1, b: 1, a2: 1 });
  expect(host.querySelectorAll("div")[0]).toBe(a);
});

test("loops grow and shrink in place", () => {
  const { host, app } = setup();
  const ul = host.querySelector("ul")!;
  const first = ul.querySelector("li")!;

  app.items = ["x", "y", "z"];
  app.stateHasChanged();
  expect(Array.from(ul.querySelectorAll("li"), (li) => li.textContent)).toEqual(["x", "y", "z"]);
  expect(ul.querySelector("li")).toBe(first);

  app.items = ["w"];
  app.stateHasChanged();
  expect(Array.from(ul.querySelectorAll("li"), (li) => li.textContent)).toEqual(["w"]);
  expect(ul.querySelector("li")).toBe(first);
});

test("async handlers re-render again when they settle", async () => {
  class Loader extends ComponentBase {
    state = "idle";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("button");
      b.addEventHandler("click", async () => {
        this.state = "loading";
        await Promise.resolve();
        this.state = "done";
      });
      b.addContent(this.state);
      b.closeElement();
    }
  }
  const host = document.createElement("div");
  mount(Loader, host);
  const button = host.querySelector("button")!;
  click(button);
  expect(button.textContent).toBe("loading");
  await new Promise((r) => setTimeout(r, 0));
  expect(button.textContent).toBe("done");
  expect(host.querySelector("button")).toBe(button);
});

test("render-tree <svg> elements and their children are created in the SVG namespace", () => {
  class Icon extends ComponentBase {
    d = "M0 0";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("svg");
      b.addAttribute("viewBox", "0 0 24 24");
      b.openRegion();
      b.openElement("path");
      b.addAttribute("d", this.d);
      b.closeElement();
      b.closeRegion();
      b.closeElement();
    }
  }
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
