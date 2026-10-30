import { expect, test } from "bun:test";
import { Component, type RenderTreeBuilder, mount } from "./index";

// Written the way xzor emits @attributes and event modifiers.

class Splat extends Component {
  extra: Record<string, unknown> = { id: "a", title: "from splat", hidden: false };
  clicks = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("div");
    b.addEventHandler("click", () => this.clicks++);
    b.openElement("p");
    b.addAttribute("title", "before");
    b.addAttributes(this.extra);
    b.addAttribute("id", "after");
    b.closeElement();
    b.openElement("a");
    b.addAttribute("href", "#x");
    b.addEventModifier("click", "preventDefault", true);
    b.addEventModifier("click", "stopPropagation", true);
    b.closeElement();
    b.openElement("button");
    b.addEventHandler("click", () => this.clicks++);
    b.addEventModifier("click", "stopPropagation", this.clicks > 0);
    b.closeElement();
    b.closeElement();
  }
}

test("@attributes splats, with later attributes winning", () => {
  const host = document.createElement("div");
  mount(Splat, host);
  const p = host.querySelector("p")!;
  expect(p.getAttribute("title")).toBe("from splat");
  expect(p.getAttribute("id")).toBe("after");
  expect(p.hasAttribute("hidden")).toBe(false);
});

test("event modifiers work with and without a handler", () => {
  const host = document.createElement("div");
  const c = mount(Splat, host);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  host.querySelector("a")!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(c.clicks).toBe(0);

  host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(c.clicks).toBe(2);
  host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(c.clicks).toBe(3);
});
