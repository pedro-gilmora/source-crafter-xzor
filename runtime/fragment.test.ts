import { expect, test } from "bun:test";
import { Component, type El, type RenderFragment, dom, mount } from "./index";

// Written the way xzor emits markup used as a value inside @code.
class Badge extends Component {
  text = "";
  protected override render(__p: Node): void {
    const _e0 = __t0() as El<"b">;
    dom.textAt(_e0.firstChild as Text, () => this.text);
    __p.appendChild(_e0);
  }
}

class Host extends Component {
  kind: "badge" | "cached" | "none" = "badge";
  cached: RenderFragment = Component.$fragment((__p) => {
    __p.appendChild(__t1());
  }, this);

  view(kind: Host["kind"]): RenderFragment | null {
    switch (kind) {
      case "badge":
        return Component.$fragment((__p) => {
          dom.component(dom.anchor(__p), Badge, (): Partial<Badge> => ({ text: "hi" }));
        }, this);
      case "cached":
        return this.cached;
      default:
        return null;
    }
  }

  protected override render(__p: Node): void {
    const _e0 = __t2() as El<"div">;
    dom.textAt(_e0.firstChild as Text, () => this.view(this.kind));
    __p.appendChild(_e0);
  }
}

const __t0 = dom.template([["b", 0, ""]]);
const __t1 = dom.template([["i", 0, "cached"]]);
const __t2 = dom.template([["div", 0, "", ["span", 0, "tail"]]]);
const __t3 = dom.template([["p", 0, ""]]);

test("fragments returned by members render in place and switch cleanly", () => {
  const host = document.createElement("div");
  const app = mount(Host, host);
  const div = host.querySelector("div")!;
  const span = div.querySelector("span")!;
  const tags = () => Array.from(div.children, (c) => c.tagName.toLowerCase());

  expect(tags()).toEqual(["b", "span"]);
  expect(div.querySelector("b")!.textContent).toBe("hi");

  app.kind = "cached";
  app.stateHasChanged();
  expect(tags()).toEqual(["i", "span"]);

  app.kind = "none";
  app.stateHasChanged();
  expect(tags()).toEqual(["span"]);
  expect(div.querySelector("span")).toBe(span);
});

test("plain functions are not treated as fragments", () => {
  class Plain extends Component {
    protected override render(__p: Node): void {
      const _e0 = __t3() as El<"p">;
      dom.textAt(_e0.firstChild as Text, () => () => 1);
      __p.appendChild(_e0);
    }
  }
  const host = document.createElement("div");
  mount(Plain, host);
  expect(host.querySelector("p")!.textContent).toBe("() => 1");
});
