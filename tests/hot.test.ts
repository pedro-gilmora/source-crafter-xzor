import { expect, test } from "bun:test";
import { ComponentBase, type RenderTreeBuilder, mount } from "../runtime/index";
import { installHot } from "../npm/xzor/bin/hot";

const ID = ".xzor/C.xzor.ts";

function setup() {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  const calls = { reload: 0 };
  const target: { __xzorHot?: unknown; location: { reload(): void } } = {
    location: {
      reload() {
        calls.reload++;
      },
    },
  };
  return { host, calls, target, hot: installHot(target) };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** A counter as codegen emits it (`<b>n:@n</b>` plus a button); a fresh class per test, since patching mutates it. */
const counter = () =>
  class C extends ComponentBase {
    n = 0;

    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("b");
      b.addText("n:");
      b.addContent(this.n);
      b.closeElement();
      b.openElement("button");
      b.addEventHandler("click", () => (this.n = 5));
      b.addText("set");
      b.closeElement();
    }
  };

const V2 = `class C extends ComponentBase {
  n = 0;
  buildRenderTree(__b) {
    __b.openElement("i");
    __b.addText("count ");
    __b.addContent(this.n);
    __b.closeElement();
  }
}
return C;`;

test("installHot publishes the registry on the target", () => {
  const { target, hot } = setup();
  expect(target.__xzorHot).toBe(hot);
});

test("patches the render and keeps the state", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  const root = mount(C, host);
  click(host.querySelector("button")!);
  expect(host.textContent).toBe("n:5set");

  expect(hot.apply([{ id: ID, code: V2, imports: ["ComponentBase"] }])).toBe(true);
  expect(host.querySelector("i")!.textContent).toBe("count 5");
  expect(root.n).toBe(5);
  expect(calls.reload).toBe(0);
});

test("adds fields the live instances lack", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  click(host.querySelector("button")!);

  const code = `class C extends ComponentBase {
    n = 0;
    label = "hi";
    buildRenderTree(__b) {
      __b.openElement("i");
      __b.addContent(this.label);
      __b.addContent(this.n);
      __b.closeElement();
    }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: ["ComponentBase"] }])).toBe(true);
  expect(host.querySelector("i")!.textContent).toBe("hi5");
});

test("a child keeps its instance and state when the parent is patched", () => {
  const { host, hot } = setup();
  const kids: Child[] = [];
  class Child extends ComponentBase {
    count = 0;

    constructor() {
      super();
      kids.push(this);
    }

    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("span");
      b.addContent(this.count);
      b.closeElement();
      b.openElement("button");
      b.addEventHandler("click", () => (this.count = 3));
      b.addText("+");
      b.closeElement();
    }
  }
  class Parent extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("h1");
      b.addText("old");
      b.closeElement();
      b.addComponent(Child, {});
    }
  }
  hot.register(".xzor/Parent.xzor.ts", Parent, () => ({ ComponentBase, Child }));
  mount(Parent, host);
  click(host.querySelector("button")!);
  expect(host.querySelector("span")!.textContent).toBe("3");

  const code = `class Parent extends ComponentBase {
    buildRenderTree(__b) {
      __b.openElement("h2");
      __b.addText("new");
      __b.closeElement();
      __b.addComponent(Child, {});
    }
  }
  return Parent;`;
  expect(hot.apply([{ id: ".xzor/Parent.xzor.ts", code, imports: ["ComponentBase", "Child"] }])).toBe(true);
  expect(host.querySelector("h2")!.textContent).toBe("new");
  expect(host.querySelector("span")!.textContent).toBe("3");
  expect(kids.length).toBe(1);
  expect(kids[0]!.count).toBe(3);
});

test("a second patch applies on top of the first", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  click(host.querySelector("button")!);
  expect(hot.apply([{ id: ID, code: V2, imports: ["ComponentBase"] }])).toBe(true);

  const v3 = `class C extends ComponentBase {
    n = 0;
    buildRenderTree(__b) {
      __b.openElement("u");
      __b.addText("total ");
      __b.addContent(this.n);
      __b.closeElement();
    }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code: v3, imports: ["ComponentBase"] }])).toBe(true);
  expect(host.querySelector("u")!.textContent).toBe("total 5");
  expect(host.querySelector("i")).toBe(null);
});

test("a component that is not on the page renders the new markup when it mounts", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  expect(hot.apply([{ id: ID, code: V2, imports: ["ComponentBase"] }])).toBe(true);
  mount(C, host);
  expect(host.querySelector("i")!.textContent).toBe("count 0");
});

test("falls back when an import binding is missing", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  const code = `class C extends Helper {
    buildRenderTree(__b) { __b.addText("new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: ["ComponentBase", "Helper"] }])).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("falls back on an undeclared identifier", () => {
  const { hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  const code = `class C extends Helper {
    buildRenderTree(__b) { __b.addText("new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back on a #private member", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  const code = `class C extends ComponentBase {
    #secret = 1;
    buildRenderTree(__b) { __b.addText("new " + this.#secret); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: ["ComponentBase"] }])).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("falls back when the new render throws", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  const code = `class C extends ComponentBase {
    buildRenderTree(__b) { throw new Error("boom"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: ["ComponentBase"] }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back when the base class changed", () => {
  const { hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  const code = `class C {
    buildRenderTree(__b) { __b.addText("new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: [] }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back for an unknown id", () => {
  const { hot, calls } = setup();
  expect(hot.apply([{ id: ".xzor/Gone.xzor.ts", code: V2, imports: ["ComponentBase"] }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("applies no update when another one in the batch fails", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  mount(C, host);
  const bad = `class D extends ComponentBase {
    #secret = 1;
    buildRenderTree(__b) { __b.addText("bad"); }
  }
  return D;`;
  const updates = [
    { id: ID, code: V2, imports: ["ComponentBase"] },
    { id: ".xzor/D.xzor.ts", code: bad, imports: ["ComponentBase"] },
  ];
  expect(hot.apply(updates)).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("a disposed instance is not re-rendered", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, () => ({ ComponentBase }));
  class Shell extends ComponentBase {
    show = true;

    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(C, {});
      b.closeRegion();
      b.openElement("button");
      b.addEventHandler("click", () => (this.show = false));
      b.addText("hide");
      b.closeElement();
    }
  }
  mount(Shell, host);
  click(host.querySelectorAll("button")[1]!);
  expect(host.querySelector("b")).toBe(null);
  expect(hot.apply([{ id: ID, code: V2, imports: ["ComponentBase"] }])).toBe(true);
  expect(host.querySelector("i")).toBe(null);
});
