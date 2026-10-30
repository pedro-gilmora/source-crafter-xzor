import { expect, test } from "bun:test";
import { Component, type IApplication, type RenderTreeBuilder, type VRegion, mount } from "./index";

// Written the way xzor emits `@cascade:name(value)` providers and `@Cascade` members.

const host = () => document.createElement("div");
// Components keep an empty anchor comment after their nodes; compare markup without them.
const html = (el: Element) => el.innerHTML.replaceAll("<!---->", "");

class Themed extends Component {
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

class Nested extends Component {
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

class Plain extends Component {
  label = "";
  renders = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(this.label);
  }
}

class Board extends Component {
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

class Configured extends Component {
  static readonly cascades = [["cfg", "cfg"]] as const;
  cfg = "none";
  renders = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(this.cfg);
  }
}

class FixedRoot extends Component {
  cfg = "one";
  consumer?: Configured;
  region?: VRegion;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("cfg", this.cfg, true);
    b.addComponent(Configured, {}, undefined, { ref: (c) => (this.consumer = c) });
    b.closeRegion();
    this.region ??= b.nodes[0] as VRegion;
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
  // No subscriber, no set.
  expect(root.region!.cascade!.consumers).toBeUndefined();
});

class Leaf extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("i");
    b.addContent(this.theme);
    b.closeElement();
  }
}

class Branch extends Component {
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

class Trunk extends Component {
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

class Toggle extends Component {
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

class Removable extends Component {
  show = true;
  theme = "dark";
  region?: VRegion;
  consumer?: Themed;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openRegion();
    if (this.show) {
      b.openCascade("theme", this.theme);
      b.addComponent(Themed, {}, undefined, { ref: (c) => (this.consumer = c) });
      b.closeRegion();
      this.region ??= (b.nodes[0] as VRegion).children[0] as VRegion;
    }
    b.closeRegion();
  }
}

test("disposing a provider region drops the record instead of unsubscribing", () => {
  const el = host();
  const root = mount(Removable, el);
  const record = root.region!.cascade!;
  expect(record.consumers!.size).toBe(1);

  root.show = false;
  root.stateHasChanged();
  expect(html(el)).toBe("");
  expect(record.consumers).toBeUndefined();
});

test("a missing provider leaves the field", () => {
  const el = host();
  mount(Themed, el);
  expect(html(el)).toBe("<span>none</span>");
});

class Injected extends Component {
  static readonly inject = ["dep"] as const;
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("b");
    b.addContent(this.theme);
    b.closeElement();
  }
}

class AsyncHost extends Component {
  theme = "dark";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Injected, {});
    b.closeRegion();
  }
}

test("an async consumer gets the current value on arrival", async () => {
  let resolve!: (c: Component) => void;
  const arrival = new Promise<Component>((r) => (resolve = r));
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

// `@if` emits one region for all branches, so two different regions can meet at the same index.
class BranchSwap extends Component {
  provide = true;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openRegion();
    if (this.provide) {
      b.openCascade("theme", "dark");
      b.addComponent(Themed, {});
      b.closeRegion();
    } else {
      b.openRegion();
      b.addComponent(Themed, {});
      b.closeRegion();
    }
    b.closeRegion();
  }
}

test("a provider region is never patched against a plain region", () => {
  const el = host();
  const root = mount(BranchSwap, el);
  expect(html(el)).toBe("<span>dark</span>");

  root.provide = false;
  root.stateHasChanged();
  expect(html(el)).toBe("<span>none</span>");

  root.provide = true;
  root.stateHasChanged();
  expect(html(el)).toBe("<span>dark</span>");
});

class NameSwap extends Component {
  role = false;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openRegion();
    if (this.role) {
      b.openCascade("role", "admin");
      b.addComponent(Themed, {});
      b.closeRegion();
    } else {
      b.openCascade("theme", "dark");
      b.addComponent(Themed, {});
      b.closeRegion();
    }
    b.closeRegion();
  }
}

test("providers with different names are never patched against each other", () => {
  const el = host();
  const root = mount(NameSwap, el);
  expect(html(el)).toBe("<span>dark</span>");

  root.role = true;
  root.stateHasChanged();
  expect(html(el)).toBe("<span>none</span>");
});

class Boxed extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  data: object = {};
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(this.theme);
  }
}

class Pair extends Component {
  theme = "dark";
  data = { n: 1 };
  consumer?: Boxed;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Boxed, { data: this.data }, undefined, { ref: (c) => (this.consumer = c) });
    b.closeRegion();
  }
}

test("a consumer whose props and cascade both change renders once", () => {
  const el = host();
  const root = mount(Pair, el);
  const consumer = root.consumer!;
  expect(consumer.renders).toBe(1);

  root.theme = "light";
  root.stateHasChanged();
  expect(html(el)).toBe("light");
  expect(consumer.renders).toBe(2);
  expect(consumer.paramsSet).toBe(2);
});

class Fragile extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override onParametersSet(): void {
    if (this.theme === "light") throw new Error("boom");
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addContent(this.theme);
  }
}

class TwoConsumers extends Component {
  theme = "dark";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Fragile, {});
    b.addComponent(Themed, {});
    b.closeRegion();
  }
}

// The runtime rethrows from a microtask; capture it instead of failing the runner.
async function thrownFrom(run: () => unknown): Promise<unknown[]> {
  const original = globalThis.queueMicrotask;
  const thrown: unknown[] = [];
  globalThis.queueMicrotask = (fn) =>
    original(() => {
      try {
        fn();
      } catch (err) {
        thrown.push(err);
      }
    });
  try {
    await run();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.queueMicrotask = original;
  }
  return thrown;
}

test("a throwing consumer does not stop the others", async () => {
  const el = host();
  const root = mount(TwoConsumers, el);
  const thrown = await thrownFrom(() => {
    root.theme = "light";
    root.stateHasChanged();
  });
  expect((thrown[0] as Error).message).toBe("boom");
  expect(el.querySelector("span")!.textContent).toBe("light");
});

class FixedLate extends Component {
  cfg = "one";
  show = false;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("cfg", this.cfg, true);
    b.openRegion();
    if (this.show) b.addComponent(Configured, {});
    b.closeRegion();
    b.closeRegion();
  }
}

test("a fixed provider keeps its first value for later consumers", () => {
  const el = host();
  const root = mount(FixedLate, el);
  root.cfg = "two";
  root.show = true;
  root.stateHasChanged();
  expect(html(el)).toBe("one");
});

class Twice extends Component {
  static readonly cascades = [
    ["theme", "theme"],
    ["alt", "theme"],
  ] as const;
  theme = "none";
  alt = "none";
  renders = 0;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.renders++;
    b.addContent(`${this.theme}/${this.alt}`);
  }
}

class TwiceRoot extends Component {
  theme = "dark";
  consumer?: Twice;
  region?: VRegion;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openCascade("theme", this.theme);
    b.addComponent(Twice, {}, undefined, { ref: (c) => (this.consumer = c) });
    b.closeRegion();
    this.region ??= b.nodes[0] as VRegion;
  }
}

test("two members bound to one name are set together and subscribe once", () => {
  const el = host();
  const root = mount(TwiceRoot, el);
  expect(html(el)).toBe("dark/dark");
  expect(root.region!.cascade!.consumers!.size).toBe(1);

  root.theme = "light";
  root.stateHasChanged();
  expect(html(el)).toBe("light/light");
  expect(root.consumer!.renders).toBe(2);
});
