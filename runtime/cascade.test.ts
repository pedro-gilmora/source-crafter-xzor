import { expect, test } from "bun:test";
import { Component, type El, type IApplication, dom, mount } from "./index";

// Written the way xzor emits `@cascade:name(value)` providers and `@Cascade` members.

const host = () => document.createElement("div");
// Components keep an empty anchor comment after their nodes; compare markup without them.
const html = (el: Element) => el.innerHTML.replaceAll("<!---->", "");
type Scope = { consumers: Set<unknown> | undefined };
const scopeOf = (c: Component) => c.$scope as Scope;

const __span = dom.template([["span", 0, ""]]);
const __i = dom.template([["i", 0, ""]]);
const __b = dom.template([["b", 0, ""]]);
const __p1 = dom.template([["p", 0, ""]]);

// `renders` counts the runs of the text binding: each pass over the component that reads it.
class Themed extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void {
    this.paramsSet++;
  }
  protected override render(__p: Node): void {
    const _e0 = __span() as El<"span">;
    dom.textAt(_e0.firstChild as Text, () => (this.renders++, this.theme));
    __p.appendChild(_e0);
  }
}

class Nested extends Component {
  theme = "dark";
  outer?: Themed;
  inner?: Themed;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.outer = __c; });
      dom.cascadeAt(dom.anchors(__p), "theme", () => "inner", false, (__p) => {
        dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.inner = __c; });
      });
    });
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
  protected override render(__p: Node): void {
    dom.text(__p, () => (this.renders++, this.label));
  }
}

class Board extends Component {
  theme = "dark";
  consumer?: Themed;
  sibling?: Plain;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
      dom.component(dom.anchor(__p), Plain, (): Partial<Plain> => ({ label: "x" }), undefined, undefined, (__c) => { this.sibling = __c; });
    });
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
  protected override render(__p: Node): void {
    dom.text(__p, () => (this.renders++, this.cfg));
  }
}

class FixedRoot extends Component {
  cfg = "one";
  consumer?: Configured;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "cfg", () => this.cfg, true, (__p) => {
      dom.component(dom.anchor(__p), Configured, (): Partial<Configured> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
    });
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
  expect(scopeOf(root.consumer!).consumers).toBeUndefined();
});

class Leaf extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  protected override render(__p: Node): void {
    const _e0 = __i() as El<"i">;
    dom.textAt(_e0.firstChild as Text, () => this.theme);
    __p.appendChild(_e0);
  }
}

class Branch extends Component {
  static readonly cascades = [["theme", "theme"]] as const;
  theme = "none";
  show = false;
  protected override render(__p: Node): void {
    const _e0 = __span() as El<"span">;
    dom.textAt(_e0.firstChild as Text, () => this.theme);
    __p.appendChild(_e0);
    dom.branchAt(dom.anchors(__p), (__p) => {
      if (this.show) {
        if (!__p) return 0;
        dom.component(dom.anchor(__p), Leaf, (): Partial<Leaf> => ({}));
      }
      return 1;
    });
  }
}

class Trunk extends Component {
  branch?: Branch;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => "dark", false, (__p) => {
      dom.component(dom.anchor(__p), Branch, (): Partial<Branch> => ({}), undefined, undefined, (__c) => { this.branch = __c; });
    });
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
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.branchAt(dom.anchors(__p), (__p) => {
        if (this.show) {
          if (!__p) return 0;
          dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
        }
        return 1;
      });
    });
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
  consumer?: Themed;
  protected override render(__p: Node): void {
    dom.branchAt(dom.anchors(__p), (__p) => {
      if (this.show) {
        if (!__p) return 0;
        dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
          dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
        });
      }
      return 1;
    });
  }
}

test("disposing a provider region leaves no consumer subscribed", () => {
  const el = host();
  const root = mount(Removable, el);
  const record = scopeOf(root.consumer!);
  expect(record.consumers!.size).toBe(1);

  root.show = false;
  root.stateHasChanged();
  expect(html(el)).toBe("");
  expect(record.consumers?.size ?? 0).toBe(0);
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
  protected override render(__p: Node): void {
    const _e0 = __b() as El<"b">;
    dom.textAt(_e0.firstChild as Text, () => this.theme);
    __p.appendChild(_e0);
  }
}

class AsyncHost extends Component {
  theme = "dark";
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Injected, (): Partial<Injected> => ({}));
    });
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

// `@if` emits one branch region, so a provider and a plain region take turns at the same place.
class BranchSwap extends Component {
  provide = true;
  protected override render(__p: Node): void {
    dom.branchAt(dom.anchors(__p), (__p) => {
      if (this.provide) {
        if (!__p) return 0;
        dom.cascadeAt(dom.anchors(__p), "theme", () => "dark", false, (__p) => {
          dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}));
        });
      } else {
        if (!__p) return 1;
        dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}));
      }
      return 2;
    });
  }
}

test("a provider branch never leaks into a plain branch", () => {
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
  protected override render(__p: Node): void {
    dom.branchAt(dom.anchors(__p), (__p) => {
      if (this.role) {
        if (!__p) return 0;
        dom.cascadeAt(dom.anchors(__p), "role", () => "admin", false, (__p) => {
          dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}));
        });
      } else {
        if (!__p) return 1;
        dom.cascadeAt(dom.anchors(__p), "theme", () => "dark", false, (__p) => {
          dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}));
        });
      }
      return 2;
    });
  }
}

test("providers with different names never feed each other's consumers", () => {
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
  protected override render(__p: Node): void {
    dom.text(__p, () => (this.renders++, this.theme));
  }
}

class Pair extends Component {
  theme = "dark";
  data = { n: 1 };
  consumer?: Boxed;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Boxed, (): Partial<Boxed> => ({ data: this.data }), undefined, undefined, (__c) => { this.consumer = __c; });
    });
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
  protected override render(__p: Node): void {
    dom.text(__p, () => this.theme);
  }
}

class TwoConsumers extends Component {
  theme = "dark";
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Fragile, (): Partial<Fragile> => ({}));
      dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}));
    });
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
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "cfg", () => this.cfg, true, (__p) => {
      dom.branchAt(dom.anchors(__p), (__p) => {
        if (this.show) {
          if (!__p) return 0;
          dom.component(dom.anchor(__p), Configured, (): Partial<Configured> => ({}));
        }
        return 1;
      });
    });
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
  protected override render(__p: Node): void {
    dom.text(__p, () => (this.renders++, `${this.theme}/${this.alt}`));
  }
}

class TwiceRoot extends Component {
  theme = "dark";
  consumer?: Twice;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Twice, (): Partial<Twice> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
    });
  }
}

test("two members bound to one name are set together and subscribe once", () => {
  const el = host();
  const root = mount(TwiceRoot, el);
  expect(html(el)).toBe("dark/dark");
  expect(scopeOf(root.consumer!).consumers!.size).toBe(1);

  root.theme = "light";
  root.stateHasChanged();
  expect(html(el)).toBe("light/light");
  expect(root.consumer!.renders).toBe(2);
});

class Tracked extends Component {
  #theme = "dark";
  get theme(): string {
    Component.$reader?.(this, 0);
    return this.#theme;
  }
  set theme(v: string) {
    const p = this.#theme;
    if (Component.same(p, v)) return;
    this.#theme = v;
    this.$changed(0, p);
  }
  static {
    Component.$define(this, ["theme"]);
  }
  fail = false;
  consumer?: Themed;
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => {
      const theme = this.theme;
      if (this.fail) throw new Error("value failed");
      return theme;
    }, false, (__p) => {
      dom.component(dom.anchor(__p), Themed, (): Partial<Themed> => ({}), undefined, undefined, (__c) => { this.consumer = __c; });
    });
  }
}

test("a cascade value that throws during a whole pass does not hold back later changes", async () => {
  const el = host();
  const root = mount(Tracked, el);
  root.fail = true;
  try {
    root.stateHasChanged();
  } catch {}
  root.fail = false;
  root.theme = "light";
  await Promise.resolve();
  expect(el.querySelector("span")!.textContent).toBe("light");
  expect(root.consumer!.theme).toBe("light");
});