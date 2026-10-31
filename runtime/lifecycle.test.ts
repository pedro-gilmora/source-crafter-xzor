import { expect, test } from "bun:test";
import { Component, type El, dom, mount } from "./index";

// Written the way xzor emits lifecycle overrides, @key and @ref.

const log: string[] = [];

class Child extends Component {
  label = "";
  clicks = 0;
  protected override onInitialized(): void {
    log.push(`init ${this.label}`);
  }
  protected override onParametersSet(): void {
    log.push(`params ${this.label}`);
  }
  protected override onAfterRender(first: boolean): void {
    log.push(`after ${this.label} ${first}`);
  }
  protected override dispose(): void {
    log.push(`dispose ${this.label}`);
  }
  protected override render(__p: Node): void {
    log.push(`render ${this.label}`);
    const _e0 = __child() as El<"i">;
    dom.textAt(_e0.firstChild as Text, () => `${this.label}:${this.clicks}`);
    __p.appendChild(_e0);
  }
}

class Parent extends Component {
  show = true;
  label = "a";
  protected override render(__p: Node): void {
    const _e0 = __parent();
    const _e1 = _e0.firstChild!.nextSibling! as Comment;
    const _e2 = _e1.nextSibling! as Comment;
    dom.branchAt(_e1, (__p) => {
      if (this.show) {
        if (!__p) return 0;
        dom.component(dom.anchor(__p), Child, (): Partial<Child> => ({ label: "x" }));
      }
      return 1;
    });
    dom.component(_e2, Child, (): Partial<Child> => ({ label: this.label }));
    __p.appendChild(_e0);
  }
}

const __child = dom.template([["i", 0, ""]]);
const __parent = dom.template([null, null, null]);

test("lifecycle runs in Blazor order and disposes removed children", () => {
  log.length = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const p = mount(Parent, host);
  expect(log).toEqual([
    "init x", "params x", "render x",
    "init a", "params a", "render a",
    "after x true", "after a true",
  ]);

  log.length = 0;
  p.stateHasChanged();
  expect(log).toEqual([]);

  // `render` runs once: a changed prop re-runs the child's bindings, not its build.
  p.label = "b";
  p.stateHasChanged();
  expect(log).toEqual(["params b", "after b false"]);

  log.length = 0;
  p.show = false;
  p.stateHasChanged();
  expect(log).toEqual(["dispose x"]);
  expect(host.textContent).toBe("b:0");
  host.remove();
});

test("component identity follows position, so an @if before a sibling keeps its state", () => {
  const host = document.createElement("div");
  // `@ref` runs again whenever the child's binding does, so count distinct instances.
  const refs = new Set<Child>();
  class Probe extends Component {
    show = true;
    protected override render(__p: Node): void {
      const _e0 = __parent();
      const _e1 = _e0.firstChild!.nextSibling! as Comment;
      const _e2 = _e1.nextSibling! as Comment;
      dom.branchAt(_e1, (__p) => {
        if (this.show) {
          if (!__p) return 0;
          dom.component(dom.anchor(__p), Child, (): Partial<Child> => ({ label: "x" }), undefined, undefined, (c) => { refs.add(c); });
        }
        return 1;
      });
      dom.component(_e2, Child, (): Partial<Child> => ({ label: "y" }), undefined, undefined, (c) => { refs.add(c); });
      __p.appendChild(_e0);
    }
  }
  const probe = mount(Probe, host);
  expect(refs.size).toBe(2);
  const [x, y] = [...refs] as [Child, Child];
  y.clicks = 5;
  y.stateHasChanged();
  probe.show = false;
  probe.stateHasChanged();
  expect(refs.size).toBe(2);
  probe.show = true;
  probe.stateHasChanged();
  expect(refs.size).toBe(3);
  expect([...refs][2]).not.toBe(x);
  expect([...refs][1]).toBe(y);
  expect(host.textContent).toBe("x:0y:5");
});

test("async lifecycle methods re-render when they settle; shouldRender can veto", async () => {
  class Loader extends Component {
    data = "loading";
    frozen = false;
    protected override async onInitializedAsync(): Promise<void> {
      await Promise.resolve();
      this.data = "loaded";
    }
    protected override shouldRender(): boolean {
      return !this.frozen;
    }
    protected override render(__p: Node): void {
      dom.text(__p, () => this.data);
    }
  }
  const host = document.createElement("div");
  const c = mount(Loader, host);
  expect(host.textContent).toBe("loading");
  await new Promise((r) => setTimeout(r, 0));
  expect(host.textContent).toBe("loaded");
  c.frozen = true;
  c.data = "changed";
  c.stateHasChanged();
  expect(host.textContent).toBe("loaded");
});

test("@key moves keyed DOM nodes and component state instead of rewriting them", () => {
  class Rows extends Component {
    items = ["a", "b", "c"];
    protected override render(__p: Node): void {
      const _e0 = __rows();
      const _e1 = _e0.firstChild! as El<"ul">;
      const _e2 = _e1.firstChild! as Comment;
      const _e3 = _e1.nextSibling! as Comment;
      dom.listAt(_e2, () => this.items, [(item) => item], (__p) => {
        const _e4 = __li() as El<"li">;
        dom.textItem(_e4.firstChild as Text, 0);
        __p.appendChild(_e4);
      }, undefined, (item) => item);
      dom.listAt(_e3, () => this.items, [(item): Partial<Child> => ({ label: item })], (__p, item) => {
        dom.rowItem((__v: typeof item) => { item = __v; });
        dom.componentItem(dom.anchor(__p), Child, 0, undefined, undefined, undefined, item);
      }, undefined, (item) => item);
      __p.appendChild(_e0);
    }
  }
  const __rows = dom.template([["ul", 0, null], null]);
  const __li = dom.template([["li", 0, ""]]);
  const host = document.createElement("div");
  const rows = mount(Rows, host);
  const [a, b, c] = Array.from(host.querySelectorAll("li"));
  rows.items = ["c", "a"];
  rows.stateHasChanged();
  const lis = Array.from(host.querySelectorAll("li"));
  expect(lis.map((li) => li.textContent)).toEqual(["c", "a"]);
  expect(lis[0]).toBe(c!);
  expect(lis[1]).toBe(a!);
  expect(b!.isConnected).toBe(false);
  expect(Array.from(host.querySelectorAll("i"), (i) => i.textContent)).toEqual(["c:0", "a:0"]);
});

test("@ref assigns elements and component instances", () => {
  class Form extends Component {
    input?: HTMLInputElement;
    child?: Child;
    protected override render(__p: Node): void {
      const _e0 = __form();
      const _e1 = _e0.firstChild! as El<"input">;
      const _e2 = _e1.nextSibling! as Comment;
      dom.component(_e2, Child, (): Partial<Child> => ({ label: "r" }), undefined, undefined, (__c) => { this.child = __c; });
      this.input = _e1;
      __p.appendChild(_e0);
    }
  }
  const __form = dom.template([["input", 0], null]);
  const host = document.createElement("div");
  const f = mount(Form, host);
  expect(f.input).toBe(host.querySelector("input")!);
  expect(f.child).toBeInstanceOf(Child);
  expect(f.child!.label).toBe("r");
});
