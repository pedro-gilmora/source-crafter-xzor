import { expect, test } from "bun:test";
import { ComponentBase, type IApplication, type RenderTreeBuilder, mount } from "./index";

// Written the way zor emits `@cascade:name(value)` providers and `@Cascade` members.

const host = () => document.createElement("div");
// Components keep an empty anchor comment after their nodes; compare markup without them.
const html = (el: Element) => el.innerHTML.replaceAll("<!---->", "");

class Themed extends ComponentBase {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.openElement("span");
    b.addContent(this.theme);
    b.closeElement();
  }
}

class Nested extends ComponentBase {
  theme = "dark";
  outer?: Themed;
  inner?: Themed;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Themed, {}, undefined, { ref: (c) => (this.outer = c) });
    b.openCascade("theme", "inner");
    b.addComponent(Themed, {}, undefined, { ref: (c) => (this.inner = c) });
    b.closeRegion();
    b.closeRegion();
  }
}

test("a consumer receives the nearest provider's value", () => {
  const el = host();
  const root = mount(Nested, el);
  expect(Array.from(el.querySelectorAll("span"), (s) => s.textContent)).toEqual(["dark", "inner"]);

  root.theme = "light";
  root.stateHasChanged();
  expect(Array.from(el.querySelectorAll("span"), (s) => s.textContent)).toEqual(["light", "inner"]);
  expect(root.inner!.renders).toBe(1);
});

class Plain extends ComponentBase {
  label = "";
  renders = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(this.label);
  }
}

class Board extends ComponentBase {
  theme = "dark";
  consumer?: Themed;
  sibling?: Plain;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Themed, {}, undefined, { ref: (c) => (this.consumer = c) });
    b.addComponent(Plain, { label: "x" }, undefined, { ref: (c) => (this.sibling = c) });
    b.closeRegion();
  }
}

test("changing the provider re-renders only its consumers", () => {
  const el = host();
  const board = mount(Board, el);
  const consumer = board.consumer!;
  expect(consumer.renders).toBe(1);
  expect(consumer.paramsSet).toBe(1);

  board.theme = "light";
  board.stateHasChanged();
  expect(el.querySelector("span")!.textContent).toBe("light");
  expect(consumer.theme).toBe("light");
  expect(consumer.renders).toBe(2);
  expect(consumer.paramsSet).toBe(2);
  expect(board.sibling!.renders).toBe(1);
});

class Configured extends ComponentBase {
  static readonly cascades = [["cfg", "cfg"]] as const;
  cfg = "none";
  renders = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(this.cfg);
  }
}

class FixedRoot extends ComponentBase {
  cfg = "one";
  consumer?: Configured;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("cfg", this.cfg, true);
    b.addComponent(Configured, {}, undefined, { ref: (c) => (this.consumer = c) });
    b.closeRegion();
  }
}

test("fixed providers do not update consumers", () => {
  const el = host();
  const root = mount(FixedRoot, el);
  expect(html(el)).toBe("one");

  root.cfg = "two";
  root.stateHasChanged();
  expect(html(el)).toBe("one");
  expect(root.consumer!.renders).toBe(1);
});

class Leaf extends ComponentBase {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("i");
    b.addContent(this.theme);
    b.closeElement();
  }
}

class Branch extends ComponentBase {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  show = false;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("span");
    b.addContent(this.theme);
    b.closeElement();
    b.openRegion();
    if (this.show) b.addComponent(Leaf, {});
    b.closeRegion();
  }
}

class Trunk extends ComponentBase {
  branch?: Branch;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", "dark");
    b.addComponent(Branch, {}, undefined, { ref: (c) => (this.branch = c) });
    b.closeRegion();
  }
}

test("a consumer re-rendering itself keeps its scope", () => {
  const el = host();
  const trunk = mount(Trunk, el);
  const branch = trunk.branch!;
  expect(el.querySelector("span")!.textContent).toBe("dark");

  branch.show = true;
  branch.stateHasChanged();
  expect(el.querySelector("i")!.textContent).toBe("dark");
});

class Toggle extends ComponentBase {
  theme = "dark";
  show = true;
  consumer?: Themed;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.openRegion();
    if (this.show) b.addComponent(Themed, {}, undefined, { ref: (c) => (this.consumer = c) });
    b.closeRegion();
    b.closeRegion();
  }
}

test("disposed consumers are unsubscribed", () => {
  const el = host();
  const root = mount(Toggle, el);
  const consumer = root.consumer!;
  expect(consumer.renders).toBe(1);

  root.show = false;
  root.stateHasChanged();
  root.theme = "light";
  root.stateHasChanged();
  expect(html(el)).toBe("");
  expect(consumer.renders).toBe(1);
  expect(consumer.theme).toBe("dark");
});

test("a missing provider leaves the field", () => {
  const el = host();
  mount(Themed, el);
  expect(html(el)).toBe("<span>none</span>");
});

class Injected extends ComponentBase {
  static readonly inject = ["dep"] as const;
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("b");
    b.addContent(this.theme);
    b.closeElement();
  }
}

class AsyncHost extends ComponentBase {
  theme = "dark";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Injected, {});
    b.closeRegion();
  }
}

test("an async consumer gets the current value on arrival", async () => {
  let resolve!: (c: ComponentBase) => void;
  const arrival = new Promise<ComponentBase>((r) => (resolve = r));
  const app: IApplication = { createComponent: (type) => (type === Injected ? arrival : undefined) };
  const el = host();
  const root = mount(AsyncHost, el, app);
  expect(html(el)).toBe("");

  root.theme = "light";
  root.stateHasChanged();
  resolve(new Injected());
  await arrival;
  expect(html(el)).toBe("<b>light</b>");
});
