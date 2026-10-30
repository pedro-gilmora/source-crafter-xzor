import { expect, test } from "bun:test";
import { Component, type RenderFragment, type RenderTreeBuilder, mount } from "./index";

// Written the way xzor emits markup used as a value inside @code.
class Badge extends Component {
  text = "";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("b");
    b.addContent(this.text);
    b.closeElement();
  }
}

class Host extends Component {
  kind: "badge" | "cached" | "none" = "badge";
  cached: RenderFragment = Component.fragment((__b) => {
    __b.openElement("i");
    __b.addText("cached");
    __b.closeElement();
  });

  view(kind: Host["kind"]): RenderFragment | null {
    switch (kind) {
      case "badge":
        return Component.fragment((__b) => {
          __b.addComponent(Badge, { text: "hi" });
        });
      case "cached":
        return this.cached;
      default:
        return null;
    }
  }

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("div");
    b.addContent(this.view(this.kind));
    b.openElement("span");
    b.addText("tail");
    b.closeElement();
    b.closeElement();
  }
}

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
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("p");
      b.addContent(() => 1);
      b.closeElement();
    }
  }
  const host = document.createElement("div");
  mount(Plain, host);
  expect(host.querySelector("p")!.textContent).toBe("() => 1");
});
