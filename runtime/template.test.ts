import { expect, test } from "bun:test";
import { Component, type El, dom, mount } from "./index";

// Written the way xzor emits @attributes and event modifiers.

// Handlers run from one listener on the document, so a host must be in it.
const attached = () => document.body.appendChild(document.createElement("div"));

class Splat extends Component {
  extra: Record<string, unknown> = { id: "a", title: "from splat", hidden: false };
  clicks = 0;
  protected override render(__p: Node): void {
    const _e0 = __t0() as El<"div">;
    const _e1 = _e0.firstChild! as El<"p">;
    const _e2 = _e1.nextSibling! as El<"a">;
    const _e3 = _e2.nextSibling! as El<"button">;
    dom.on(_e0, "click", () => this.clicks++);
    dom.attrs(_e1, () => this.extra, ["id"], ["title", "before"]);
    dom.on(_e2, "click", undefined, 3);
    dom.on(_e3, "click", (__e: any) => { if (this.clicks > 0) __e.stopPropagation(); return ((() => this.clicks++) as (e: any) => unknown)(__e); });
    __p.appendChild(_e0);
  }
}

const __t0 = dom.template([["div", 0, ["p", ["title", "before", "id", "after"]], ["a", ["href", "#x"]], ["button", 0]]]);

test("@attributes splats, with later attributes winning", () => {
  const host = attached();
  mount(Splat, host);
  const p = host.querySelector("p")!;
  expect(p.getAttribute("title")).toBe("from splat");
  expect(p.getAttribute("id")).toBe("after");
  expect(p.hasAttribute("hidden")).toBe(false);
});

test("event modifiers work with and without a handler", () => {
  const host = attached();
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
