import { expect, test } from "bun:test";
import { $hot, Component, dom, mount } from "../runtime/index";
import { installHot } from "../npm/xzor/bin/hot";

const ID = ".xzor/C.xzor.ts";
const IMPORTS = ["Component", "dom"];
const imports = () => ({ Component, dom });

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
  const hot = installHot(target);
  // What a hot bundle's modules do when they load.
  hot.link($hot());
  return { host, calls, target, hot };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** A counter as codegen emits it (`<b>n:@n</b>` plus a button); a fresh class per test, since patching mutates it. */
const counter = () =>
  class C extends Component {
    n = 0;

    protected override render(__p: Node): void {
      const b = dom.el(__p, "b");
      dom.t(b, "n:");
      dom.text(b, () => this.n);
      const button = dom.el(__p, "button");
      dom.on(button, "click", () => (this.n = 5));
      dom.t(button, "set");
    }
  };

const V2 = `class C extends Component {
  n = 0;
  render(__p) {
    const i = dom.el(__p, "i");
    dom.t(i, "count ");
    dom.text(i, () => this.n);
  }
}
return C;`;

test("a new reference field is not shared between instances", () => {
  const { host, hot } = setup();
  const C = counter();
  class List extends Component {
    protected override render(__p: Node): void {
      dom.component(dom.anchor(__p), C, () => ({}));
      dom.component(dom.anchor(__p), C, () => ({}));
    }
  }
  hot.register(ID, C, imports);
  const seen: any[] = ((globalThis as any).__seen = []);
  const code = `class C extends Component {
    n = 0;
    items = [];
    render(__p) { globalThis.__seen.push(this); dom.t(__p, String(this.items.length)); }
  }
  return C;`;
  mount(List, host);
  expect(hot.apply([{ id: ID, code, imports: IMPORTS }])).toBe(true);
  const [a, b] = [...new Set(seen)];
  expect(a.items).toEqual([]);
  expect(a.items).not.toBe(b.items);
  delete (globalThis as any).__seen;
});

test("members deleted by an edit are removed", () => {
  const { host, hot } = setup();
  class Quiet extends Component {
    n = 0;
    protected override shouldRender(): boolean {
      return false;
    }
    protected override render(__p: Node): void {
      dom.t(__p, "old");
    }
  }
  hot.register(ID, Quiet, imports);
  mount(Quiet, host);
  const code = `class Quiet extends Component {
    n = 0;
    render(__p) { dom.t(__p, "new"); }
  }
  return Quiet;`;
  expect(hot.apply([{ id: ID, code, imports: IMPORTS }])).toBe(true);
  expect(host.textContent).toBe("new");
});

test("installHot publishes the registry on the target", () => {
  const { target, hot } = setup();
  expect(target.__xzorHot).toBe(hot);
});

test("patches the render and keeps the state", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  const root = mount(C, host);
  click(host.querySelector("button")!);
  expect(host.textContent).toBe("n:5set");

  expect(hot.apply([{ id: ID, code: V2, imports: IMPORTS }])).toBe(true);
  expect(host.querySelector("i")!.textContent).toBe("count 5");
  expect(root.n).toBe(5);
  expect(calls.reload).toBe(0);
});

test("a template edit shows after apply with the instance's state kept", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  const root = mount(C, host);
  click(host.querySelector("button")!);
  const old = host.querySelector("b")!;

  const code = `class C extends Component {
    n = 0;
    render(__p) {
      const b = dom.el(__p, "b");
      dom.t(b, "total ");
      dom.text(b, () => this.n);
      const button = dom.el(__p, "button");
      dom.on(button, "click", () => (this.n = 9));
      dom.t(button, "nine");
    }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: IMPORTS }])).toBe(true);
  expect(host.textContent).toBe("total 5nine");
  expect(host.querySelectorAll("b").length).toBe(1);
  expect(host.querySelector("b")).not.toBe(old);
  expect(root.n).toBe(5);
  // The new DOM is live and the old bindings are gone.
  click(host.querySelector("button")!);
  expect(host.textContent).toBe("total 9nine");
  expect(old.textContent).toBe("n:5");
  expect(calls.reload).toBe(0);
});

test("an edited child is rebuilt in place and keeps its instance and state", () => {
  const { host, hot } = setup();
  const kids: Kid[] = [];
  class Kid extends Component {
    count = 0;

    constructor() {
      super();
      kids.push(this);
    }

    protected override render(__p: Node): void {
      const span = dom.el(__p, "span");
      dom.text(span, () => this.count);
      const button = dom.el(__p, "button");
      dom.on(button, "click", () => (this.count = 3));
      dom.t(button, "+");
    }
  }
  class Page extends Component {
    protected override render(__p: Node): void {
      dom.t(dom.el(__p, "h1"), "before");
      dom.component(dom.anchor(__p), Kid, () => ({}));
      dom.t(dom.el(__p, "h2"), "after");
    }
  }
  hot.register(".xzor/Kid.xzor.ts", Kid, imports);
  mount(Page, host);
  click(host.querySelector("button")!);
  expect(host.querySelector("span")!.textContent).toBe("3");

  const code = `class Kid extends Component {
    count = 0;
    render(__p) {
      const em = dom.el(__p, "em");
      dom.text(em, () => this.count);
      dom.t(__p, "!");
    }
  }
  return Kid;`;
  expect(hot.apply([{ id: ".xzor/Kid.xzor.ts", code, imports: IMPORTS }])).toBe(true);
  expect(host.textContent).toBe("before3!after");
  expect([...host.children].map((el) => el.tagName)).toEqual(["H1", "EM", "H2"]);
  expect(kids.length).toBe(1);
});

test("a child keeps its instance and state when the parent is patched", () => {
  const { host, hot } = setup();
  const kids: Child[] = [];
  class Child extends Component {
    count = 0;

    constructor() {
      super();
      kids.push(this);
    }

    protected override render(__p: Node): void {
      const span = dom.el(__p, "span");
      dom.text(span, () => this.count);
      const button = dom.el(__p, "button");
      dom.on(button, "click", () => (this.count = 3));
      dom.t(button, "+");
    }
  }
  class Parent extends Component {
    title(): string {
      return "old";
    }

    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "h1"), () => this.title());
      dom.component(dom.anchor(__p), Child, () => ({}));
    }
  }
  hot.register(".xzor/Parent.xzor.ts", Parent, () => ({ Component, dom, Child }));
  mount(Parent, host);
  click(host.querySelector("button")!);
  expect(host.querySelector("span")!.textContent).toBe("3");

  // Same template: the parent re-runs its bindings and its child stays.
  const code = `class Parent extends Component {
    title() { return "new"; }
    render(__p) {
      dom.text(dom.el(__p, "h1"), () => this.title());
      dom.component(dom.anchor(__p), Child, () => ({}));
    }
  }
  return Parent;`;
  expect(hot.apply([{ id: ".xzor/Parent.xzor.ts", code, imports: [...IMPORTS, "Child"] }])).toBe(true);
  expect(host.querySelector("h1")!.textContent).toBe("new");
  expect(host.querySelector("span")!.textContent).toBe("3");
  expect(kids.length).toBe(1);
  expect(kids[0]!.count).toBe(3);
});

test("a second patch applies on top of the first", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  click(host.querySelector("button")!);
  expect(hot.apply([{ id: ID, code: V2, imports: IMPORTS }])).toBe(true);

  const v3 = `class C extends Component {
    n = 0;
    render(__p) {
      const u = dom.el(__p, "u");
      dom.t(u, "total ");
      dom.text(u, () => this.n);
    }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code: v3, imports: IMPORTS }])).toBe(true);
  expect(host.querySelector("u")!.textContent).toBe("total 5");
  expect(host.querySelector("i")).toBe(null);
});

test("a component that is not on the page renders the new markup when it mounts", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  expect(hot.apply([{ id: ID, code: V2, imports: IMPORTS }])).toBe(true);
  mount(C, host);
  expect(host.querySelector("i")!.textContent).toBe("count 0");
});

test("falls back when an import binding is missing", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  const code = `class C extends Helper {
    render(__p) { dom.t(__p, "new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: [...IMPORTS, "Helper"] }])).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("falls back on an undeclared identifier", () => {
  const { hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  const code = `class C extends Helper {
    render(__p) { dom.t(__p, "new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back on a #private member", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  const code = `class C extends Component {
    #secret = 1;
    render(__p) { dom.t(__p, "new " + this.#secret); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: IMPORTS }])).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("falls back when the new render throws", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  const code = `class C extends Component {
    render(__p) { throw new Error("boom"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: IMPORTS }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back when the base class changed", () => {
  const { hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  const code = `class C {
    render(__p) { dom.t(__p, "new"); }
  }
  return C;`;
  expect(hot.apply([{ id: ID, code, imports: [] }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back for an unknown id", () => {
  const { hot, calls } = setup();
  expect(hot.apply([{ id: ".xzor/Gone.xzor.ts", code: V2, imports: IMPORTS }])).toBe(false);
  expect(calls.reload).toBe(1);
});

test("falls back when a template changed and the runtime was never linked", () => {
  const host = document.createElement("main");
  document.body.replaceChildren(host);
  let reloads = 0;
  const hot = installHot({ location: { reload: () => void reloads++ } });
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  expect(hot.apply([{ id: ID, code: V2, imports: IMPORTS }])).toBe(false);
  expect(reloads).toBe(1);
});

test("applies no update when another one in the batch fails", () => {
  const { host, hot, calls } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  mount(C, host);
  const bad = `class D extends Component {
    #secret = 1;
    render(__p) { dom.t(__p, "bad"); }
  }
  return D;`;
  const updates = [
    { id: ID, code: V2, imports: IMPORTS },
    { id: ".xzor/D.xzor.ts", code: bad, imports: IMPORTS },
  ];
  expect(hot.apply(updates)).toBe(false);
  expect(calls.reload).toBe(1);
  expect(host.textContent).toBe("n:0set");
});

test("a disposed instance is not re-rendered", () => {
  const { host, hot } = setup();
  const C = counter();
  hot.register(ID, C, imports);
  class Shell extends Component {
    show = true;

    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.show) dom.component(dom.anchor(__p), C, () => ({}));
      });
      const button = dom.el(__p, "button");
      dom.on(button, "click", () => (this.show = false));
      dom.t(button, "hide");
    }
  }
  mount(Shell, host);
  click(host.querySelectorAll("button")[1]!);
  expect(host.querySelector("b")).toBe(null);
  expect(hot.apply([{ id: ID, code: V2, imports: IMPORTS }])).toBe(true);
  expect(host.querySelector("i")).toBe(null);
});
