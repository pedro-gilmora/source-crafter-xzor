import { beforeEach, expect, test } from "bun:test";
import { ComponentBase, type RenderTreeBuilder, mount } from "./index";

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
