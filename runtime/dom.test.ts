import { expect, test } from "bun:test";
import { Component, dom, lazy, mount, type Markup, NavLink, type Route, type RouteTable, type RouteSection, setNavigationForTests, setTransitionCapForTests, viewTransitions } from "./index";
import { EntitySet, Key, Model } from "./model";

// Models and components are written the way the bundle and codegen emit them.

class Worker extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #name = ""; get name(): string { Model.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(0, p); }
  #hours = 0; get hours(): number { Model.$reader?.(this, 1); return this.#hours; } set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(1, p); }
  #tax = 0; get tax(): number { Model.$reader?.(this, 2); return this.#tax; } set tax(v: number) { const p = this.#tax; if (Model.same(p, v)) return; this.#tax = v; this.$changed(2, p); }
  get payment(): number {
    return this.hours * 20 * (1 - this.tax / 100);
  }
static { Model.$define(this, ["name", "hours", "tax"]); } }

const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => queueMicrotask(r));
};

function host(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

let renders = 0;

class Counter extends Component {
  #count = 0; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
  #label = "n"; get label(): string { Component.$reader?.(this, 1); return this.#label; } set label(v: string) { const p = this.#label; if (Component.same(p, v)) return; this.#label = v; this.$changed(1, p); }
  untracked = 0;
  static { Component.$define(this, ["count", "label"]); }

  protected override render(__p: Node): void {
    renders++;
    const _button0 = dom.el(__p, "button");
    _button0.addEventListener("click", () => this.count++);
    dom.attr(_button0, "title", () => `${this.label}${this.count}`);
    dom.text(_button0, () => this.count);
    dom.t(__p, " ");
    dom.text(__p, () => this.untracked);
  }
}

test("a tracked component field updates its bindings without a re-render", async () => {
  renders = 0;
  const el = host();
  const c = mount(Counter, el);
  const button = el.querySelector("button")!;
  expect(button.textContent).toBe("0");
  button.click();
  button.click();
  await tick();
  expect(button.textContent).toBe("2");
  expect(button.getAttribute("title")).toBe("n2");
  expect(renders).toBe(1);
  c.label = "x";
  await tick();
  expect(button.getAttribute("title")).toBe("x2");
});

class Bar extends Component {
  #count = 0; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
  static { Component.$define(this, ["count"]); }

  protected override render(__p: Node): void {
    const _div0 = dom.el(__p, "div");
    dom.attr(_div0, "--w", () => this.count * 10 + "%");
    dom.attr(_div0, "--on", () => this.count > 1 || null);
  }
}

test("a -- attribute binding writes a custom property, and null removes it", async () => {
  const el = host();
  const c = mount(Bar, el);
  const div = el.querySelector("div")!;
  expect(div.style.getPropertyValue("--w")).toBe("0%");
  expect(div.style.getPropertyValue("--on")).toBe("");
  expect(div.hasAttribute("--w")).toBe(false);
  c.count = 2;
  await tick();
  expect(div.style.getPropertyValue("--w")).toBe("20%");
  expect(div.style.getPropertyValue("--on")).toBe("true");
  c.count = 0;
  await tick();
  expect(div.style.getPropertyValue("--on")).toBe("");
});

test("stateHasChanged refreshes what nothing tracks", async () => {
  const el = host();
  const c = mount(Counter, el);
  c.untracked = 5;
  await tick();
  expect(el.textContent).toBe("0 0");
  c.stateHasChanged();
  expect(el.textContent).toBe("0 5");
});

class Sheet extends Component {
  #team = new EntitySet<Worker>(); get team(): EntitySet<Worker> { Component.$reader?.(this, 0); return this.#team; } set team(v: EntitySet<Worker>) { const p = this.#team; if (Component.same(p, v)) return; this.#team = v; this.$changed(0, p); }
  static { Component.$define(this, ["team"]); }

  protected override render(__p: Node): void {
    const _ul0 = dom.el(__p, "ul");
    dom.list(_ul0, () => this.team.view, (__p, worker: Worker) => {
      const _li0 = dom.el(__p, "li");
      const _input0 = dom.el(_li0, "input");
      dom.attr(_input0, "value", () => worker.hours);
      _input0.addEventListener("input", (__e) => (worker.hours = Number((__e.target as HTMLInputElement).value)));
      const _span0 = dom.el(_li0, "span");
      dom.text(_span0, () => worker.payment.toFixed(2));
      dom.region(_li0, (__p) => {
        if (worker.hours > 24) dom.t(dom.el(__p, "small"), "too many");
      });
    });
    const _b0 = dom.el(__p, "b");
    dom.text(_b0, () => this.team.view.reduce((sum, w) => sum + w.payment, 0));
  }
}

function sheet(n: number): { el: HTMLElement; c: Sheet; rows: () => HTMLLIElement[]; total: () => string } {
  const el = host();
  const c = mount(Sheet, el);
  c.team = EntitySet.track(Worker, Array.from({ length: n }, (_, i) => ({ name: `W${i}`, hours: 1, tax: 0 })));
  return { el, c, rows: () => [...el.querySelectorAll("li")], total: () => el.querySelector("b")!.textContent! };
}

test("a field change writes only its own nodes, once per task", async () => {
  const { c, rows } = sheet(3);
  await tick();
  const input = rows()[1]!.querySelector("input")!;
  let writes = 0;
  const set = input.setAttribute.bind(input);
  input.setAttribute = (name: string, value: string) => (name === "value" && writes++, set(name, value));
  for (let i = 2; i <= 9; i++) c.team[1]!.hours = i;
  await tick();
  expect(writes).toBe(1);
  expect(input.value).toBe("9");
  expect(rows()[1]!.querySelector("span")!.textContent).toBe("180.00");
});

test("derived getters and aggregates follow the fields they read", async () => {
  const { c, total } = sheet(3);
  await tick();
  expect(total()).toBe("60");
  c.team[0]!.tax = 50;
  await tick();
  expect(total()).toBe("50");
});

test("list rows are keyed: a push adds one row, the rest keep their nodes", async () => {
  const { c, rows, total } = sheet(3);
  await tick();
  const before = rows();
  c.team.push(new Worker({ name: "N", hours: 2, tax: 0 }).markAdded());
  await tick();
  const after = rows();
  expect(after.length).toBe(4);
  expect(before.every((li, i) => after[i] === li)).toBe(true);
  expect(total()).toBe("100");
});

test("a deleted item leaves the view, and its bindings stop writing", async () => {
  const { c, rows } = sheet(3);
  await tick();
  const gone = c.team[1]!;
  const li = rows()[1]!;
  c.team.delete(gone);
  await tick();
  expect(rows().length).toBe(2);
  expect(rows().includes(li)).toBe(false);
  gone.hours = 7;
  await tick();
  expect(li.querySelector("span")!.textContent).toBe("20.00");
});

test("a markup value in @expr renders as markup and follows what it reads", async () => {
  class Page extends Component {
    #n = 1; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { Component.$define(this, ["n"]); }
    summary = Component.fragment((__p) => dom.text(dom.el(__p, "u"), () => this.n), this);
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "div"), () => this.summary);
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.querySelector("div u")!.textContent).toBe("1");
  p.n = 2;
  await tick();
  expect(el.querySelector("div u")!.textContent).toBe("2");
});

test("after its own handler, a component re-runs the bindings that read nothing tracked", async () => {
  const work = { changes: 0 };
  let tracked = 0;
  class Page extends Component {
    #count = 0; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { Component.$define(this, ["count"]); }
    protected override render(__p: Node): void {
      const _e0 = dom.el(__p, "button");
      dom.on(_e0, "click", () => {
        work.changes++;
        this.count++;
      });
      dom.text(dom.el(__p, "i"), () => work.changes);
      dom.text(dom.el(__p, "b"), () => (tracked++, this.count));
    }
  }
  const el = host();
  mount(Page, el);
  el.querySelector("button")!.click();
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("1");
  expect(el.querySelector("b")!.textContent).toBe("1");
  // The tracked binding ran once for the change, not again for the handler.
  expect(tracked).toBe(2);
});

test("a set's hasChanges and hasErrors follow pushes", async () => {
  const el = host();
  const set = EntitySet.track(Worker, [{ name: "a", hours: 1, tax: 0 }]);
  class Flags extends Component {
    protected override render(__p: Node): void {
      dom.text(__p, () => `${set.hasChanges}/${set.hasErrors}`);
    }
  }
  mount(Flags, el);
  expect(el.textContent).toBe("false/false");
  set.push(new Worker({ name: "b", hours: 99, tax: 0 }).markAdded());
  await tick();
  // This `Worker` has no validators: `hasErrors` re-ran and stays false.
  expect(el.textContent).toBe("true/false");
});

test("a reorder moves rows without rebuilding them", async () => {
  const { c, rows } = sheet(3);
  await tick();
  const [a, b, d] = rows();
  c.team.reverse();
  await tick();
  const after = rows();
  expect(after.length).toBe(3);
  expect(after[0] === d && after[1] === b && after[2] === a).toBe(true);
});

test("a region rebuilds when what it read changes", async () => {
  const { c, rows } = sheet(2);
  await tick();
  c.team[0]!.hours = 30;
  await tick();
  expect(rows()[0]!.querySelector("small")?.textContent).toBe("too many");
  c.team[0]!.hours = 3;
  await tick();
  expect(rows()[0]!.querySelector("small")).toBeNull();
});

test("replacing the list field rebuilds the rows", async () => {
  const { c, rows } = sheet(2);
  await tick();
  c.team = EntitySet.track(Worker, [{ name: "Z", hours: 4, tax: 0 }]);
  await tick();
  expect(rows().length).toBe(1);
  expect(rows()[0]!.querySelector("input")!.value).toBe("4");
});

test("bindings inside a region that drops them stop writing", async () => {
  const el = host();
  const worker = new Worker({ name: "a", hours: 1, tax: 0 });
  class Parent extends Component {
    #show = true; get show(): boolean { Component.$reader?.(this, 0); return this.#show; } set show(v: boolean) { const p = this.#show; if (Component.same(p, v)) return; this.#show = v; this.$changed(0, p); }
    static { Component.$define(this, ["show"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.show) dom.text(dom.el(__p, "p"), () => worker.hours);
      });
    }
  }
  const p = mount(Parent, el);
  const node = el.querySelector("p")!;
  p.show = false;
  await tick();
  expect(el.querySelector("p")).toBeNull();
  worker.hours = 5;
  await tick();
  expect(node.textContent).toBe("1");
});

test("nested regions and lists in a region change alone: the outer block keeps its nodes", async () => {
  const __t0 = dom.template([null, null]);
  const __t1 = dom.template([["dialog", 0, ["input", 0], null, null, ["ul", 0, null]]]);
  const __t2 = dom.template([["p", 0, "long"]]);
  const __t3 = dom.template([["li", 0, ""]]);
  let outer = 0;
  class Page extends Component {
    #open = true; get open(): boolean { Component.$reader?.(this, 0); return this.#open; } set open(v: boolean) { const p = this.#open; if (Component.same(p, v)) return; this.#open = v; this.$changed(0, p); }
    #items = ["a", "b"]; get items(): string[] { Component.$reader?.(this, 1); return this.#items; } set items(v: string[]) { const p = this.#items; if (Component.same(p, v)) return; this.#items = v; this.$changed(1, p); }
    #text = ""; get text(): string { Component.$reader?.(this, 2); return this.#text; } set text(v: string) { const p = this.#text; if (Component.same(p, v)) return; this.#text = v; this.$changed(2, p); }
    static { Component.$define(this, ["open", "items", "text"]); }
    protected override render(__p: Node): void {
      const _e0 = __t0();
      dom.regionAt(_e0.firstChild!.nextSibling! as Comment, (__p) => {
        outer++;
        if (this.open) {
          const _e2 = __t1() as HTMLDialogElement;
          const _e3 = _e2.firstChild! as HTMLInputElement;
          const _e4 = _e3.nextSibling!.nextSibling! as Comment;
          const _e5 = _e4.nextSibling! as HTMLUListElement;
          dom.attr(_e3, "value", () => this.text);
          dom.regionAt(_e4, (__p) => {
            if (this.text.length > 2) __p.appendChild(__t2());
          });
          dom.listAt(_e5.firstChild! as Comment, () => this.items, [(it: string) => it], (__p) => {
            const _e8 = __t3() as HTMLLIElement;
            dom.textItem(_e8.firstChild! as Text, 0);
            __p.appendChild(_e8);
          });
          __p.appendChild(_e2);
        }
      });
      __p.appendChild(_e0);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const dialog = el.querySelector("dialog")!;
  const input = el.querySelector("input")!;
  p.text = "long";
  await tick();
  expect(el.querySelector("p")?.textContent).toBe("long");
  p.items = ["a"];
  await tick();
  expect(el.querySelectorAll("li").length).toBe(1);
  expect(el.querySelector("dialog")).toBe(dialog);
  expect(el.querySelector("input")).toBe(input);
  expect(outer).toBe(1);
  p.open = false;
  await tick();
  expect(el.querySelector("dialog")).toBeNull();
});

test("a list's else shows while it has no rows, and leaves with the first one", async () => {
  class Page extends Component {
    #items: string[] = []; get items(): string[] { Component.$reader?.(this, 0); return this.#items; } set items(v: string[]) { const p = this.#items; if (Component.same(p, v)) return; this.#items = v; this.$changed(0, p); }
    static { Component.$define(this, ["items"]); }
    protected override render(__p: Node): void {
      const ul = dom.el(__p, "ul");
      const end = ul.appendChild(document.createComment(""));
      dom.listAt(end, () => this.items, [(it: string) => it], (__p) => {
        const li = __p.appendChild(document.createElement("li"));
        dom.textItem(li.appendChild(document.createTextNode("")), 0);
      }, (__p) => {
        dom.textAt(__p.appendChild(document.createElement("p")).appendChild(document.createTextNode("")), () => `none ${this.items.length}`);
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.querySelector("ul")!.innerHTML).toBe("<p>none 0</p><!---->");
  p.items = ["a", "b"];
  await tick();
  expect(el.querySelector("ul")!.innerHTML).toBe("<li>a</li><li>b</li><!---->");
  p.items = [];
  await tick();
  expect(el.querySelector("ul")!.innerHTML).toBe("<p>none 0</p><!---->");
});

test("@attr: in a region sets its element while the branch shows, and comes off when it goes", async () => {
  class Stock extends Component {
    #n = 0; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { Component.$define(this, ["n"]); }
    protected override render(__p: Node): void {
      const span = dom.el(__p, "span");
      span.setAttribute("class", "cell");
      span.setAttribute("title", "stock");
      dom.region(span, (__p) => {
        if (this.n > 0) dom.text(__p, () => this.n);
        else {
          dom.attrOf(span, "class", () => "error-text cell");
          dom.attrOf(span, "title", () => `none ${this.n}`);
          dom.t(__p, "Agotado");
        }
      });
    }
  }
  const el = host();
  const c = mount(Stock, el);
  const span = el.querySelector("span")!;
  expect(span.getAttribute("class")).toBe("cell error-text");
  expect(span.getAttribute("title")).toBe("none 0");
  c.n = 2;
  await tick();
  expect(span.getAttribute("class")).toBe("cell");
  expect(span.getAttribute("title")).toBe("stock");
  expect(span.textContent).toBe("2");
});

test("keyed passes keep their rows: same key and values keep the nodes, changed values rebuild only that row", async () => {
  let builds = 0;
  class Page extends Component {
    #team: Record<string, number> = { a: 1, b: 2, c: 3 }; get team(): Record<string, number> { Component.$reader?.(this, 0); return this.#team; } set team(v: Record<string, number>) { const p = this.#team; if (Component.same(p, v)) return; this.#team = v; this.$changed(0, p); }
    static { Component.$define(this, ["team"]); }
    protected override render(__p: Node): void {
      const ul = dom.el(__p, "ul");
      dom.keyedAt(ul.appendChild(document.createComment("")), (__pass) => {
        for (const [k, v] of Object.entries(this.team)) {
          const __p = __pass(k, [k, v]);
          if (__p !== undefined) {
            builds++;
            __p.appendChild(document.createElement("li")).textContent = `${k}${v}`;
          }
        }
      }, (__p) => {
        __p.appendChild(document.createElement("p")).textContent = "none";
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  const ul = el.querySelector("ul")!;
  const [a, b] = [...ul.querySelectorAll("li")];
  expect(ul.textContent).toBe("a1b2c3");
  p.team = { b: 2, a: 9, d: 4 };
  await tick();
  expect(ul.textContent).toBe("b2a9d4");
  const after = [...ul.querySelectorAll("li")];
  expect(after[0]).toBe(b!);
  expect(after[1]).not.toBe(a!);
  expect(builds).toBe(3 + 2);
  p.team = {};
  await tick();
  expect(ul.innerHTML).toBe("<p>none</p><!---->");
});

test("a keyed run with a duplicate key throws, naming it", () => {
  class Page extends Component {
    protected override render(__p: Node): void {
      dom.keyedAt(__p.appendChild(document.createComment("")), (__pass) => {
        for (const x of [1, 2, 1]) __pass(x, [x]);
      });
    }
  }
  expect(() => mount(Page, host())).toThrow("xzor: duplicate @key 1");
});

test("a list keyed by a function keeps a row whose item is replaced by one with the same key", async () => {
  type Row = { id: number; name: string };
  class Page extends Component {
    #rows: Row[] = [{ id: 1, name: "a" }, { id: 2, name: "b" }]; get rows(): Row[] { Component.$reader?.(this, 0); return this.#rows; } set rows(v: Row[]) { const p = this.#rows; if (Component.same(p, v)) return; this.#rows = v; this.$changed(0, p); }
    static { Component.$define(this, ["rows"]); }
    protected override render(__p: Node): void {
      const ul = dom.el(__p, "ul");
      dom.listAt(ul.appendChild(document.createComment("")), () => this.rows, [(r: Row) => r.name], (__p) => {
        dom.textItem(__p.appendChild(document.createElement("li")).appendChild(document.createTextNode("")), 0);
      }, undefined, (r) => r.id);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const [first, second] = [...el.querySelectorAll("li")];
  p.rows = [p.rows[1]!, { id: 1, name: "a2" }];
  await tick();
  const after = [...el.querySelectorAll("li")];
  expect(el.querySelector("ul")!.textContent).toBe("ba2");
  // Same key, another object: its row is kept and takes it; the other row only moved.
  expect(after[0]).toBe(second!);
  expect(after[1]).toBe(first!);
});

test("a list of models matches rows by the model's @Key", async () => {
  class Item extends Model { constructor(data?: object) { super(data); this.assign(data); }
    #id = 0; @Key get id(): number { Model.$reader?.(this, 0); return this.#id; } set id(v: number) { const p = this.#id; if (Model.same(p, v)) return; this.#id = v; this.$changed(0, p); }
  static { Model.$define(this, ["id"]); } }
  class Page extends Component {
    #items: Item[] = [new Item({ id: 1 }), new Item({ id: 2 })]; get items(): Item[] { Component.$reader?.(this, 0); return this.#items; } set items(v: Item[]) { const p = this.#items; if (Component.same(p, v)) return; this.#items = v; this.$changed(0, p); }
    static { Component.$define(this, ["items"]); }
    protected override render(__p: Node): void {
      dom.listAt(__p.appendChild(document.createComment("")), () => this.items, [], (__p, it: Item) => {
        __p.appendChild(document.createElement("li")).textContent = String(it.id);
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect([...el.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["1", "2"]);
  p.items = [p.items[1]!, new Item({ id: 3 })];
  await tick();
  expect([...el.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["2", "3"]);
  // Two objects with one id are one key, unlike identity.
  class Twice extends Page {
    override get items(): Item[] {
      return [new Item({ id: 1 }), new Item({ id: 1 })];
    }
  }
  expect(() => mount(Twice, host())).toThrow("xzor: duplicate @key 1");
});

test("stateHasChanged re-runs every binding behind shouldRender, then onAfterRender; tracked writes update alone", async () => {
  const log: string[] = [];
  const outside = { n: 1 };
  class Page extends Component {
    #count = 0; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { Component.$define(this, ["count"]); }
    allow = true;
    protected override shouldRender(): boolean {
      log.push("should");
      return this.allow;
    }
    protected override onAfterRender(first: boolean): void {
      log.push(`after ${first}`);
    }
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "b"), () => this.count);
      dom.text(dom.el(__p, "i"), () => outside.n);
    }
  }
  const el = host();
  const p = mount(Page, el);
  await tick();
  expect(log).toEqual(["after true"]);
  p.count = 1;
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("1");
  expect(log).toEqual(["after true"]);
  outside.n = 2;
  p.stateHasChanged();
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("2");
  expect(log).toEqual(["after true", "should", "after false"]);
  p.allow = false;
  outside.n = 3;
  p.stateHasChanged();
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("2");
});

test("@once: read once, untracked, even inside a region", async () => {
  class Page extends Component {
    #n = 1; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    #show = true; get show(): boolean { Component.$reader?.(this, 1); return this.#show; } set show(v: boolean) { const p = this.#show; if (Component.same(p, v)) return; this.#show = v; this.$changed(1, p); }
    static { Component.$define(this, ["n", "show"]); }
    protected override render(__p: Node): void {
      const t = __p.appendChild(document.createTextNode(""));
      dom.textOnce(t, () => this.n);
      dom.region(__p, (__p) => {
        if (this.show) {
          dom.onceAt(__p.appendChild(document.createComment("")), (__p) => {
            const b = __p.appendChild(document.createElement("b"));
            dom.set(b, "title", this.n);
            dom.setText(b.appendChild(document.createTextNode("")), this.n);
          });
        }
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  const b = el.querySelector("b")!;
  expect(el.textContent).toBe("11");
  expect(b.getAttribute("title")).toBe("1");
  p.n = 2;
  await tick();
  // Nothing re-ran: not the value, not the region around the block.
  expect(el.textContent).toBe("11");
  expect(el.querySelector("b")).toBe(b);
  p.show = false;
  await tick();
  p.show = true;
  await tick();
  // A rebuilt region builds its block again, once.
  expect(el.querySelector("b")!.textContent).toBe("2");
});

test("a cached getter runs once per change for all its readers, and is never stale", async () => {
  let runs = 0;
  const outside = { n: 1 };
  class Page extends Component {
    #a = 1; get a(): number { Component.$reader?.(this, 0); return this.#a; } set a(v: number) { const p = this.#a; if (Component.same(p, v)) return; this.#a = v; this.$changed(0, p); }
    static { Component.$define(this, ["a"]); }
    get total(): number {
      runs++;
      return this.a * 10;
    }
    get loose(): number {
      return outside.n;
    }
    static { dom.memo(this, ["total", "loose"]); }
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "b"), () => this.total);
      dom.text(dom.el(__p, "i"), () => this.total + 1);
      dom.text(dom.el(__p, "u"), () => `${this.total}/${this.loose}`);
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.textContent).toBe("101110/1");
  // Its first reader ran it uncached; the second made the cache.
  expect(runs).toBe(2);
  p.a = 2;
  await tick();
  expect(el.textContent).toBe("202120/1");
  expect(runs).toBe(3);
  // Read outside a binding, between changes: still cached.
  expect(p.total).toBe(20);
  expect(runs).toBe(3);
  // What nothing tracks is never cached.
  outside.n = 5;
  p.stateHasChanged();
  expect(el.querySelector("u")!.textContent).toBe("20/5");
});

test("a getter with one reader, or read outside bindings, gets no cache", async () => {
  let runs = 0;
  class Page extends Component {
    #a = 1; get a(): number { Component.$reader?.(this, 0); return this.#a; } set a(v: number) { const p = this.#a; if (Component.same(p, v)) return; this.#a = v; this.$changed(0, p); }
    static { Component.$define(this, ["a"]); }
    get total(): number {
      runs++;
      return this.a * 10;
    }
    static { dom.memo(this, ["total"]); }
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "b"), () => this.total);
    }
  }
  const memos = (o: object) => Object.getOwnPropertySymbols(o).filter((s) => s.description === "xzor.dom.memos").length;
  const loose = new Page();
  expect(loose.total).toBe(10);
  expect(memos(loose)).toBe(0);
  const el = host();
  const p = mount(Page, el);
  p.a = 2;
  await tick();
  expect(el.textContent).toBe("20");
  expect(runs).toBe(3);
  expect(memos(p)).toBe(0);
});

test("@await of a call requests again only when an argument changes, or what the call itself reads", async () => {
  const requests: string[] = [];
  class Page extends Component {
    #q = "Ab"; get q(): string { Component.$reader?.(this, 0); return this.#q; } set q(v: string) { const p = this.#q; if (Component.same(p, v)) return; this.#q = v; this.$changed(0, p); }
    #lang = "en"; get lang(): string { Component.$reader?.(this, 1); return this.#lang; } set lang(v: string) { const p = this.#lang; if (Component.same(p, v)) return; this.#lang = v; this.$changed(1, p); }
    static { Component.$define(this, ["q", "lang"]); }
    get key(): string {
      return this.q.toLowerCase();
    }
    load(key: string): Promise<string> {
      requests.push(`${key}/${this.lang}`);
      return Promise.resolve(key);
    }
    protected override render(__p: Node): void {
      const end = dom.anchors(__p);
      dom.awaitCallAt(end, () => [this.key], (__a0) => this.load(__a0), undefined, (__p, v) => {
        dom.textAt(__p.appendChild(document.createTextNode("")), () => v);
      }, undefined);
    }
  }
  const el = host();
  const p = mount(Page, el);
  await tick();
  expect(el.textContent).toBe("ab");
  // `key` reads `q` but gives the same value: no new request.
  p.q = "AB";
  await tick();
  expect(requests).toEqual(["ab/en"]);
  p.q = "cd";
  await tick();
  expect(el.textContent).toBe("cd");
  // What the call reads inside still asks again.
  p.lang = "es";
  await tick();
  expect(requests).toEqual(["ab/en", "cd/en", "cd/es"]);
});

test("@await: pending, then the value; a newer promise wins; what then reads re-renders it without a new request", async () => {
  const gates: ((v: string[]) => void)[] = [];
  let requests = 0;
  class Page extends Component {
    #q = "a"; get q(): string { Component.$reader?.(this, 0); return this.#q; } set q(v: string) { const p = this.#q; if (Component.same(p, v)) return; this.#q = v; this.$changed(0, p); }
    #suffix = "!"; get suffix(): string { Component.$reader?.(this, 1); return this.#suffix; } set suffix(v: string) { const p = this.#suffix; if (Component.same(p, v)) return; this.#suffix = v; this.$changed(1, p); }
    static { Component.$define(this, ["q", "suffix"]); }
    load(q: string): Promise<string[]> {
      requests++;
      return new Promise((r) => gates.push(() => r([q])));
    }
    protected override render(__p: Node): void {
      const end = dom.anchors(__p);
      dom.awaitAt(end, () => this.load(this.q), (__p) => {
        __p.appendChild(document.createTextNode("wait"));
      }, (__p, rows) => {
        dom.text(__p, () => rows.join() + this.suffix);
      }, undefined);
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.textContent).toBe("wait");
  p.q = "b";
  await tick();
  expect(requests).toBe(2);
  gates[1]!(["b"]);
  await tick();
  expect(el.textContent).toBe("b!");
  // The older request lands late: ignored.
  gates[0]!(["a"]);
  await tick();
  expect(el.textContent).toBe("b!");
  p.suffix = "?";
  await tick();
  expect(el.textContent).toBe("b?");
  expect(requests).toBe(2);
});

test("@await: a rejection shows catch; a plain value shows then at once", async () => {
  class Page extends Component {
    protected override render(__p: Node): void {
      dom.awaitAt(dom.anchors(__p), () => Promise.reject(new Error("no")), undefined, undefined, (__p, e) => {
        __p.appendChild(document.createTextNode(String((e as Error).message)));
      });
      dom.awaitAt(dom.anchors(__p), () => 5, undefined, (__p, n) => {
        __p.appendChild(document.createTextNode(String(n + 1)));
      }, undefined);
    }
  }
  const el = host();
  mount(Page, el);
  expect(el.textContent).toBe("6");
  await tick();
  expect(el.textContent).toBe("no6");
});

test("a branch region keeps its branch's DOM while the chosen branch stays the same (#3)", async () => {
  class Page extends Component {
    #count = 3; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { Component.$define(this, ["count"]); }
    protected override render(__p: Node): void {
      const end = dom.anchors(__p);
      dom.branchAt(end, (__p) => {
        if (!this.count) {
          if (!__p) return 0;
          __p.appendChild(document.createElement("p")).textContent = "none";
        } else {
          if (!__p) return 1;
          dom.textAt(__p.appendChild(document.createElement("ul")).appendChild(document.createTextNode("")), () => this.count);
        }
        return 2;
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  const ul = el.querySelector("ul")!;
  expect(ul.textContent).toBe("3");
  p.count = 2;
  await tick();
  expect(el.querySelector("ul")).toBe(ul);
  expect(ul.textContent).toBe("2");
  p.count = 0;
  await tick();
  expect(el.textContent).toBe("none");
  p.count = 1;
  await tick();
  expect(el.querySelector("ul")!.textContent).toBe("1");
});

test("@show: a chosen branch is built once and kept, the others hidden; hidden ones stay live, @pause ones catch up when shown", async () => {
  let builds = 0;
  let liveRuns = 0;
  let pausedRuns = 0;
  class Page extends Component {
    #tab = "a"; get tab(): string { Component.$reader?.(this, 0); return this.#tab; } set tab(v: string) { const p = this.#tab; if (Component.same(p, v)) return; this.#tab = v; this.$changed(0, p); }
    #n = 1; get n(): number { Component.$reader?.(this, 1); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(1, p); }
    #on = true; get on(): boolean { Component.$reader?.(this, 2); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(2, p); }
    static { Component.$define(this, ["tab", "n", "on"]); }
    protected override render(__p: Node): void {
      dom.branchAt(dom.anchors(__p), (__p) => {
        if (this.on) {
          if (!__p) return 0;
          dom.showAt(dom.anchors(__p), (__p) => {
            if (this.tab === "a") {
              if (!__p) return 0;
              builds++;
              const a = __p.appendChild(document.createElement("section"));
              a.className = "a";
              a.setAttribute("style", "display: flex");
              dom.textAt(a.appendChild(document.createTextNode("")), () => (liveRuns++, this.n));
            } else {
              if (!__p) return 1;
              builds++;
              const b = __p.appendChild(document.createElement("section"));
              b.className = "b";
              dom.pauseAt(dom.anchors(b), (__p) => {
                dom.textAt(__p.appendChild(document.createTextNode("")), () => (pausedRuns++, this.n));
              });
            }
            return 2;
          });
        }
        return 1;
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  const a = el.querySelector<HTMLElement>(".a")!;
  expect(a.textContent).toBe("1");
  expect(el.querySelector(".b")).toBeNull();
  p.tab = "b";
  await tick();
  const b = el.querySelector<HTMLElement>(".b")!;
  expect(a.style.display).toBe("none");
  expect(b.textContent).toBe("1");
  // Hidden and live: it keeps up.
  p.n = 2;
  await tick();
  expect(a.textContent).toBe("2");
  expect(b.textContent).toBe("2");
  p.tab = "a";
  await tick();
  expect(el.querySelector(".a")).toBe(a);
  expect(a.style.display).toBe("flex");
  expect(b.style.display).toBe("none");
  // Hidden and paused: nothing runs, and showing it brings it up to date once.
  const paused = pausedRuns;
  p.n = 3;
  await tick();
  p.n = 4;
  await tick();
  expect(pausedRuns).toBe(paused);
  expect(b.textContent).toBe("2");
  p.tab = "b";
  await tick();
  expect(b.textContent).toBe("4");
  expect(pausedRuns).toBe(paused + 1);
  expect(b.style.display).toBe("");
  expect(builds).toBe(2);
  // Removed with its region: hidden branches go too.
  p.on = false;
  await tick();
  const live = liveRuns;
  p.n = 5;
  await tick();
  expect(liveRuns).toBe(live);
  expect(el.querySelector("section")).toBeNull();
});

test("a keyed row whose item is a new object keeps its nodes and takes the new item (#5)", async () => {
  type Line = { id: number; qty: number };
  let clicked: Line | undefined;
  class Page extends Component {
    #lines: Line[] = [{ id: 1, qty: 1 }, { id: 2, qty: 1 }]; get lines(): Line[] { Component.$reader?.(this, 0); return this.#lines; } set lines(v: Line[]) { const p = this.#lines; if (Component.same(p, v)) return; this.#lines = v; this.$changed(0, p); }
    static { Component.$define(this, ["lines"]); }
    protected override render(__p: Node): void {
      dom.listAt(dom.anchors(__p), () => this.lines, [
        (l: Line) => l.qty,
        (l: Line) => () => (clicked = l),
        (l: Line, __p?: Node) => {
          if (l.qty > 1) {
            if (!__p) return 0;
            __p.appendChild(document.createElement("b"));
          } else {
            if (!__p) return 1;
            __p.appendChild(document.createElement("i"));
          }
          return 2;
        },
      ], (__p) => {
        const li = __p.appendChild(document.createElement("li"));
        dom.textItem(li.appendChild(document.createTextNode("")), 0);
        dom.onItem(li.appendChild(document.createElement("button")), "click", 1);
        dom.branchItem(dom.anchors(li), 2);
      }, undefined, (l: Line) => l.id);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const [first, second] = [...el.querySelectorAll("li")];
  expect(first!.querySelector("i")).not.toBeNull();
  p.lines = p.lines.map((l) => (l.id === 1 ? { id: 1, qty: 2 } : l));
  await tick();
  expect([...el.querySelectorAll("li")]).toEqual([first!, second!]);
  expect(first!.textContent).toBe("2");
  const b = first!.querySelector("b")!;
  expect(b).not.toBeNull();
  first!.querySelector("button")!.click();
  expect(clicked).toEqual({ id: 1, qty: 2 });
  // Same branch for the new item: its nodes stay too.
  p.lines = p.lines.map((l) => (l.id === 1 ? { id: 1, qty: 3 } : l));
  await tick();
  expect(first!.textContent).toBe("3");
  expect(first!.querySelector("b")).toBe(b);
});

test("rows dropped outside a handler leave nothing in the component's loose list", async () => {
  type Row = { id: number; name: string };
  let next = 0;
  const rows = (): Row[] => Array.from({ length: 20 }, () => ({ id: ++next, name: "r" }));
  class Page extends Component {
    #items: Row[] = rows(); get items(): Row[] { Component.$reader?.(this, 0); return this.#items; } set items(v: Row[]) { const p = this.#items; if (Component.same(p, v)) return; this.#items = v; this.$changed(0, p); }
    static { Component.$define(this, ["items"]); }
    protected override render(__p: Node): void {
      dom.listAt(dom.anchors(__p), () => this.items, [(r: Row) => r.name], (__p) => {
        dom.textItem(__p.appendChild(document.createElement("li")).appendChild(document.createTextNode("")), 0);
      }, undefined, (r: Row) => r.id);
    }
  }
  const p = mount(Page, host());
  const loose = (): unknown[] => p.$loose ?? [];
  // Plain objects: each row's text reads nothing tracked, so it waits in the loose list for handlers.
  expect(loose()).toHaveLength(20);
  for (let i = 0; i < 5; i++) {
    p.items = rows();
    await tick();
  }
  expect(loose()).toHaveLength(20);
});

test("a keyed row that closes over its item keeps its nodes, nested rows and child components for a new item (#6)", async () => {
  type Person = { id: number; name: string; roles: string[] };
  const ROLES = ["a", "b"];
  const children: Card[] = [];
  let inits = 0;
  class Card extends Component {
    #person!: Person; get person(): Person { Component.$reader?.(this, 0); return this.#person; } set person(v: Person) { const p = this.#person; if (Component.same(p, v)) return; this.#person = v; this.$changed(0, p); }
    static { Component.$define(this, ["person"]); }
    protected override onInitialized(): void {
      inits++;
      children.push(this);
    }
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "em"), () => this.person.name);
    }
  }
  class Page extends Component {
    #people: Person[] = [{ id: 1, name: "Ana", roles: ["a"] }, { id: 2, name: "Luis", roles: [] }]; get people(): Person[] { Component.$reader?.(this, 0); return this.#people; } set people(v: Person[]) { const p = this.#people; if (Component.same(p, v)) return; this.#people = v; this.$changed(0, p); }
    static { Component.$define(this, ["people"]); }
    protected override render(__p: Node): void {
      dom.listAt(dom.anchors(__p), () => this.people, [(p: Person) => ({ person: p })], (__p, p: Person) => {
        dom.rowItem((__v: typeof p) => { p = __v; });
        const li = __p.appendChild(document.createElement("li"));
        dom.listAt(dom.anchors(li), () => ROLES, [(r: string) => (p.roles.includes(r) ? r : "-")], (__p) => {
          dom.textItem(__p.appendChild(document.createElement("b")).appendChild(document.createTextNode("")), 0);
        }, undefined, (r: string) => r);
        dom.componentItem(dom.anchor(li), Card, 0);
      }, undefined, (p: Person) => p.id);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const lis = [...el.querySelectorAll("li")];
  const bs = [...el.querySelectorAll("b")];
  expect(el.querySelector("li")!.textContent).toBe("a-Ana");
  p.people = p.people.map((x) => (x.id === 1 ? { ...x, name: "Ana M", roles: ["b"] } : { ...x }));
  await tick();
  expect([...el.querySelectorAll("li")]).toEqual(lis);
  expect([...el.querySelectorAll("b")]).toEqual(bs);
  expect(el.querySelector("li")!.textContent).toBe("-bAna M");
  expect(inits).toBe(2);
  expect(children[0]!.person.name).toBe("Ana M");
});

test("a data-leave element removed by its region stays, data-leaving, until its animations finish", async () => {
  Component.$leaves = true;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  class Page extends Component {
    #open = true; get open(): boolean { Component.$reader?.(this, 0); return this.#open; } set open(v: boolean) { const p = this.#open; if (Component.same(p, v)) return; this.#open = v; this.$changed(0, p); }
    static { Component.$define(this, ["open"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.open) {
          const d = __p.appendChild(document.createElement("dialog"));
          d.setAttribute("data-leave", "");
          (d as unknown as { getAnimations(): unknown[] }).getAnimations = () => (d.hasAttribute("data-leaving") ? [{ finished }] : []);
        } else __p.appendChild(document.createElement("p"));
      });
    }
  }
  const el = host();
  const page = mount(Page, el);
  const dialog = el.querySelector("dialog")!;
  page.open = false;
  await tick();
  expect(dialog.isConnected).toBe(true);
  expect(dialog.hasAttribute("data-leaving")).toBe(true);
  expect(el.querySelector("p")).not.toBeNull();
  finish();
  await tick();
  expect(dialog.isConnected).toBe(false);
});

test("class:name toggles one class, leaving the element's others", async () => {
  class Page extends Component {
    #err = ""; get err(): string { Component.$reader?.(this, 0); return this.#err; } set err(v: string) { const p = this.#err; if (Component.same(p, v)) return; this.#err = v; this.$changed(0, p); }
    static { Component.$define(this, ["err"]); }
    protected override render(__p: Node): void {
      const d = dom.el(__p, "div");
      d.setAttribute("class", "field");
      dom.attr(d, "class:invalid", () => this.err);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const d = el.querySelector("div")!;
  expect(d.className).toBe("field");
  p.err = "bad";
  await tick();
  expect(d.className).toBe("field invalid");
  p.err = "";
  await tick();
  expect(d.className).toBe("field");
});

test("aria-* attributes write booleans as true and false", async () => {
  class Page extends Component {
    #on = false; get on(): boolean { Component.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(0, p); }
    static { Component.$define(this, ["on"]); }
    protected override render(__p: Node): void {
      const b = dom.el(__p, "button");
      dom.attr(b, "aria-pressed", () => this.on);
      dom.attr(b, "disabled", () => this.on);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const b = el.querySelector("button")!;
  expect(b.getAttribute("aria-pressed")).toBe("false");
  expect(b.hasAttribute("disabled")).toBe(false);
  p.on = true;
  await tick();
  expect(b.getAttribute("aria-pressed")).toBe("true");
  expect(b.getAttribute("disabled")).toBe("");
});

test("a child removed by its region stops writing", async () => {
  const el = host();
  const worker = new Worker({ name: "a", hours: 1, tax: 0 });
  class One extends Component {
    protected override render(__p: Node): void {
      dom.text(dom.el(__p, "i"), () => worker.hours);
    }
  }
  class Parent extends Component {
    show = true;
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.show) dom.component(dom.anchor(__p), One, () => ({}));
      });
    }
  }
  const p = mount(Parent, el);
  const node = el.querySelector("i")!;
  worker.hours = 2;
  await tick();
  expect(node.textContent).toBe("2");
  p.show = false;
  p.stateHasChanged();
  expect(el.querySelector("i")).toBeNull();
  worker.hours = 3;
  await tick();
  expect(node.textContent).toBe("2");
});

// As codegen emits a list: a template per run, and rows whose bindings and handlers share the list's reads.
const __row = dom.template([["li", ["class", "row"], ["input", 0], ["span", 0, ""], null, null, ["button", 0, "x"]]]);
const __ul = dom.template([["ul", 0, null], ["p", 0, ""]]);
let picked: Worker[] = [];
class Rows extends Component {
  #team = new EntitySet<Worker>(); get team(): EntitySet<Worker> { Component.$reader?.(this, 0); return this.#team; } set team(v: EntitySet<Worker>) { const p = this.#team; if (Component.same(p, v)) return; this.#team = v; this.$changed(0, p); }
  static { Component.$define(this, ["team"]); }
  outer = 0;
  protected override render(__p: Node): void {
    const _e0 = __ul() as Node;
    const _e1 = _e0.firstChild! as HTMLElement;
    const _e2 = _e1.firstChild! as Comment;
    const _e3 = _e1.nextSibling!.firstChild! as Text;
    dom.on(_e1, "click", () => this.outer++);
    dom.listAt(_e2, () => this.team.view, [
      (w) => w.hours,
      (w) => (__e: Event) => { w.hours = Component.bindValue(__e, w.hours); },
      (w) => w.payment.toFixed(2),
      (w, __p) => {
        if (w.hours > 24) dom.t(dom.el(__p, "small"), "too many");
      },
      (w) => (__e: Event) => { picked.push(w); __e.stopPropagation(); },
    ], (__p) => {
      const _e4 = __row() as HTMLLIElement;
      const _e5 = _e4.firstChild! as HTMLInputElement;
      const _e6 = _e5.nextSibling!.firstChild! as Text;
      const _e7 = _e5.nextSibling!.nextSibling!.nextSibling! as Comment;
      const _e8 = _e7.nextSibling! as HTMLButtonElement;
      dom.attrItem(_e5, "value", 0);
      dom.onItem(_e5, "input", 1);
      dom.textItem(_e6, 2);
      dom.regionItem(_e7, 3);
      dom.onItem(_e8, "click", 4);
      __p.appendChild(_e4);
    });
    dom.textAt(_e3, () => this.team.view.length);
    __p.appendChild(_e0);
  }
}

test("template rows: shared reads bind each row's item, and delegated handlers get it", async () => {
  const el = host();
  const c = mount(Rows, el);
  c.team = EntitySet.track(Worker, [{ name: "a", hours: 1, tax: 0 }, { name: "b", hours: 2, tax: 0 }]);
  await tick();
  const rows = () => [...el.querySelectorAll("li")];
  expect(rows().length).toBe(2);
  expect(rows()[1]!.className).toBe("row");
  expect(rows()[1]!.querySelector("input")!.value).toBe("2");
  expect(rows()[1]!.querySelector("span")!.textContent).toBe("40.00");
  expect(el.querySelector("p")!.textContent).toBe("2");
  const input = rows()[0]!.querySelector("input")!;
  input.value = "30";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  expect(c.team[0]!.hours).toBe(30);
  expect(rows()[0]!.querySelector("span")!.textContent).toBe("600.00");
  expect(rows()[0]!.querySelector("small")?.textContent).toBe("too many");
  // An event dispatched without bubbling still reaches its target's handler.
  input.value = "31";
  input.dispatchEvent(new Event("input"));
  expect(c.team[0]!.hours).toBe(31);
  // A click on the row reaches the `<ul>` handler; the button's handler stops it.
  expect(c.outer).toBe(0);
  rows()[0]!.click();
  expect(c.outer).toBe(1);
  picked = [];
  rows()[1]!.querySelector("button")!.click();
  expect(picked).toEqual([c.team[1]!]);
  expect(c.outer).toBe(1);
  c.team.push(new Worker({ name: "c", hours: 3, tax: 0 }).markAdded());
  await tick();
  expect(rows().length).toBe(3);
  expect(rows()[2]!.querySelector("span")!.textContent).toBe("60.00");
  expect(el.querySelector("p")!.textContent).toBe("3");
});

test("templates create <svg> and its children in the SVG namespace", () => {
  const SVG = "http://www.w3.org/2000/svg";
  const icon = dom.template([["svg", ["viewBox", "0 0 24 24"], ["path", ["d", "M0 0"]]], ["p", 0, "x"]]);
  const frag = icon() as DocumentFragment;
  const svg = frag.firstChild as Element;
  expect(svg.namespaceURI).toBe(SVG);
  expect((svg.firstChild as Element).namespaceURI).toBe(SVG);
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect((frag.lastChild as Element).namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  const parent = document.createElementNS(SVG, "svg");
  expect(dom.el(parent, "path").namespaceURI).toBe(SVG);
});

test("Model and Component share one reader slot and the same `same`", () => {
  const read = (): void => {};
  Model.$reader = read;
  expect(Component.$reader).toBe(read);
  Component.$reader = undefined;
  expect(Model.$reader).toBeUndefined();
  expect(Component.same([1, { a: 2 }], [1, { a: 2 }])).toBe(true);
  expect(Component.same(new Date(5), new Date(5))).toBe(true);
  expect(Component.same([1], [2])).toBe(false);
  expect(Component.same(new Worker(), new Worker())).toBe(false);
  expect(Model.same).toBe(Component.same);
});

// Components that render through `dom` (`render(parent)`), and children as COMPONENT bindings, as codegen will emit them.
let log: string[] = [];
let childRuns = 0;
const __kid = dom.template([["span", 0, ""]]);
class Kid extends Component {
  #title = ""; get title(): string { Component.$reader?.(this, 0); return this.#title; } set title(v: string) { const p = this.#title; if (Component.same(p, v)) return; this.#title = v; this.$changed(0, p); }
  static { Component.$define(this, ["title"]); }
  count = 0;
  box: { n: number } | undefined = undefined;
  onPick: ((v: string) => void) | undefined = undefined;
  declare slots: { default?: unknown };
  protected override onInitialized(): void { log.push(`kid init ${this.title}`); }
  protected override onInitializedAsync(): void { log.push("kid initAsync"); }
  protected override onParametersSet(): void { log.push(`kid params ${this.title}`); }
  protected override onParametersSetAsync(): void { log.push("kid paramsAsync"); }
  protected override onAfterRender(first: boolean): void { log.push(`kid after ${first}`); }
  protected override render(__p: Node): void {
    log.push("kid render");
    const _e0 = __kid() as HTMLSpanElement;
    dom.textAt(_e0.firstChild as Text, () => { childRuns++; return `${this.title}:${this.count}:${this.box?.n ?? "-"}`; });
    __p.appendChild(_e0);
  }
}

const __host = dom.template([["div", 0, null]]);
class Host extends Component {
  #title = "a"; get title(): string { Component.$reader?.(this, 0); return this.#title; } set title(v: string) { const p = this.#title; if (Component.same(p, v)) return; this.#title = v; this.$changed(0, p); }
  static { Component.$define(this, ["title"]); }
  count = 1;
  box: { n: number } | undefined = undefined;
  withSlots = false;
  picked: string[] = [];
  kid: Kid | undefined;
  protected override onInitialized(): void { log.push("host init"); }
  protected override onParametersSet(): void { log.push("host params"); }
  protected override onAfterRender(first: boolean): void { log.push(`host after ${first}`); }
  protected override render(__p: Node): void {
    log.push("host render");
    const _e0 = __host() as HTMLDivElement;
    dom.component(_e0.firstChild as Comment, Kid, () => ({ title: this.title, count: this.count, box: this.box }), { onPick: (v: string) => this.picked.push(v) }, this.withSlots ? { default: "x" } : undefined, (c) => (this.kid = c as Kid));
    __p.appendChild(_e0);
  }
}

test("a render component mounts through dom; a child binding mounts its child in lifecycle order", () => {
  log = [];
  const el = host();
  const h = mount(Host, el);
  expect(el.innerHTML).toBe("<!----><div><span>a:1:-</span><!----></div><!---->");
  expect(log).toEqual(["host init", "host params", "host render", "kid init a", "kid initAsync", "kid params a", "kid paramsAsync", "kid render", "kid after true", "host after true"]);
  expect(h.kid).toBeInstanceOf(Kid);
  h.kid!.onPick!("v");
  expect(h.picked).toEqual(["v"]);
});

test("a changed prop: assigned, onParametersSet, then the child's pass", async () => {
  const el = host();
  const h = mount(Host, el);
  log = [];
  h.title = "b";
  await tick();
  expect(el.querySelector("span")!.textContent).toBe("b:1:-");
  expect(log).toEqual(["kid params b", "kid paramsAsync", "kid after false"]);
});

test("a parent stateHasChanged with unchanged primitive props runs no child binding", () => {
  const el = host();
  const h = mount(Host, el);
  log = [];
  childRuns = 0;
  h.stateHasChanged();
  expect(childRuns).toBe(0);
  expect(log).toEqual(["host after false"]);
  h.count = 2;
  h.stateHasChanged();
  expect(childRuns).toBe(1);
  expect(el.querySelector("span")!.textContent).toBe("a:2:-");
});

test("an object prop counts as changed: the child gets a pass", () => {
  const el = host();
  const h = mount(Host, el);
  h.box = { n: 1 };
  h.stateHasChanged();
  expect(el.querySelector("span")!.textContent).toBe("a:1:1");
  h.box.n = 2;
  childRuns = 0;
  h.stateHasChanged();
  expect(childRuns).toBe(1);
  expect(el.querySelector("span")!.textContent).toBe("a:1:2");
});

test("a child given slots gets a pass on every parent pass", () => {
  class Slotted extends Host {
    override withSlots = true;
  }
  const el = host();
  const s = mount(Slotted, el);
  expect(s.kid!.slots).toEqual({ default: "x" });
  // Every prop is assigned on each re-run: a child's local write to a prop gives way to the parent's value.
  s.kid!.count = 9;
  childRuns = 0;
  s.stateHasChanged();
  expect(childRuns).toBe(1);
  expect(el.querySelector("span")!.textContent).toBe("a:1:-");
});

test("a re-run with no changed prop assigns them all, but calls no onParametersSet", () => {
  const el = host();
  const h = mount(Host, el);
  h.kid!.count = 7;
  log = [];
  // Host's one binding is the child's: re-run it with the same props.
  (h as unknown as { $bindings: { stateHasChanged(): void } }).$bindings.stateHasChanged();
  expect(log).toEqual([]);
  expect(h.kid!.count).toBe(1);
});

test("the default slots object is shared and frozen", () => {
  const a = new Kid();
  const b = new Kid();
  expect(a.slots).toBe(b.slots);
  expect(Object.isFrozen(a.slots)).toBe(true);
});

test("a render component: shouldRender false skips a pass; onAfterRender(false) after it", () => {
  log = [];
  let allow = true;
  class Gate extends Component {
    value = 0;
    protected override shouldRender(): boolean { return allow; }
    protected override onAfterRender(first: boolean): void { log.push(`after ${first}`); }
    protected override render(__p: Node): void { dom.text(__p, () => this.value); }
  }
  const el = host();
  const g = mount(Gate, el);
  g.value = 1;
  allow = false;
  g.stateHasChanged();
  expect(el.textContent).toBe("0");
  allow = true;
  g.stateHasChanged();
  expect(el.textContent).toBe("1");
  expect(log).toEqual(["after true", "after false"]);
});

class Needs extends Component {
  static inject = ["svc"];
  constructor(public svc: string) { super(); }
  protected override render(__p: Node): void { dom.t(__p, this.svc); }
}
class NeedsHost extends Component {
  protected override render(__p: Node): void { dom.component(dom.anchor(__p), Needs, () => ({})); }
}

test("a child with injected services is built by the application", () => {
  const el = host();
  const made: Function[] = [];
  mount(NeedsHost, el, { createComponent: (type) => (made.push(type), new (type as typeof Needs)("svc!")) });
  expect(made).toEqual([Needs]);
  expect(el.textContent).toBe("svc!");
});

test("a lazy child: its anchor holds the place, and it arrives with the latest props", async () => {
  let arrive!: (m: { default: typeof Kid }) => void;
  const Late = lazy(() => new Promise<{ default: typeof Kid }>((r) => (arrive = r)));
  class LazyHost extends Component {
    #title = "a"; get title(): string { Component.$reader?.(this, 0); return this.#title; } set title(v: string) { const p = this.#title; if (Component.same(p, v)) return; this.#title = v; this.$changed(0, p); }
    static { Component.$define(this, ["title"]); }
    protected override render(__p: Node): void {
      const _e0 = __host() as HTMLDivElement;
      dom.component(_e0.firstChild as Comment, Late, () => ({ title: this.title }));
      __p.appendChild(_e0);
    }
  }
  const el = host();
  const h = mount(LazyHost, el);
  expect(el.querySelector("div")!.innerHTML).toBe("<!---->");
  h.title = "late";
  await tick();
  arrive({ default: Kid });
  await tick();
  expect(el.querySelector("div")!.innerHTML).toBe("<span>late:0:-</span><!---->");
});

let cachedMade = 0;
let cachedDisposed = 0;
class Kept extends Component {
  static cached = true;
  #n = 0; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
  static { Component.$define(this, ["n"]); }
  label = "";
  constructor() { super(); cachedMade++; }
  protected override dispose(): void { cachedDisposed++; }
  protected override render(__p: Node): void {
    const _e0 = __kid() as HTMLSpanElement;
    dom.textAt(_e0.firstChild as Text, () => `${this.label}${this.n}`);
    __p.appendChild(_e0);
  }
}
class Toggle extends Component {
  #on = true; get on(): boolean { Component.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(0, p); }
  static { Component.$define(this, ["on"]); }
  label = "x";
  type: Function = Kept;
  kid: Component | undefined;
  protected override render(__p: Node): void {
    dom.region(__p, (__p) => {
      if (this.on) dom.component(dom.anchor(__p), this.type as typeof Kept, () => ({ label: this.label }), undefined, undefined, (c) => (this.kid = c), "k");
    });
  }
}

test("a @cached child is kept detached when it leaves, and revived by type and key", async () => {
  cachedMade = cachedDisposed = 0;
  const el = host();
  const t = mount(Toggle, el);
  const first = t.kid as Kept;
  first.n = 5;
  await tick();
  expect(el.querySelector("span")!.textContent).toBe("x5");
  t.on = false;
  await tick();
  expect(el.querySelector("span")).toBeNull();
  expect(cachedDisposed).toBe(0);
  t.label = "y";
  t.on = true;
  await tick();
  expect(t.kid).toBe(first);
  expect(cachedMade).toBe(1);
  expect(el.querySelector("span")!.textContent).toBe("y5");
  first.n = 6;
  await tick();
  expect(el.querySelector("span")!.textContent).toBe("y6");
});

class Themed extends Component {
  static cascades = [["theme", "theme"]] as const;
  theme = "";
  protected override onParametersSet(): void { log.push(`themed params ${this.theme}`); }
  protected override render(__p: Node): void { dom.text(__p, () => this.theme); }
}
class Provider extends Component {
  theme = "dark";
  protected override render(__p: Node): void {
    dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, false, (__p) => {
      dom.component(dom.anchor(__p), Themed, () => ({}));
    });
  }
}

test("a child's @Cascade members come from the scope it is mounted in, and follow its changes", () => {
  log = [];
  const el = host();
  const p = mount(Provider, el);
  expect(el.textContent).toBe("dark");
  p.theme = "light";
  p.stateHasChanged();
  expect(el.textContent).toBe("light");
  expect(log).toEqual(["themed params dark", "themed params light"]);
});

let subs = 0;
let gone: string[] = [];
class Disposable extends Component {
  label = "";
  protected override dispose(): void { gone.push(`dispose ${this.label}`); }
  [Symbol.dispose](): void { gone.push(`Symbol.dispose ${this.label}`); }
  protected override render(__p: Node): void { dom.text(__p, () => this.label); }
}
class Many extends Component {
  #n = 0; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
  #tag = "t"; get tag(): string { Component.$reader?.(this, 1); return this.#tag; } set tag(v: string) { const p = this.#tag; if (Component.same(p, v)) return; this.#tag = v; this.$changed(1, p); }
  static { Component.$define(this, ["n", "tag"]); }
  override $watch(dep: object): void { subs++; super.$watch(dep); }
  override $unwatch(dep: object): void { subs--; super.$unwatch(dep); }
  protected override render(__p: Node): void {
    dom.region(__p, (__p) => {
      for (let i = 0; i < this.n; i++) dom.component(dom.anchor(__p), Disposable, () => ({ label: `${this.tag}${i}` }));
    });
  }
}

test("a removed child is disposed (dispose, Symbol.dispose) and its props binding unsubscribes", async () => {
  subs = 0;
  gone = [];
  const el = host();
  const m = mount(Many, el);
  m.n = 2;
  await tick();
  expect(el.textContent).toBe("t0t1");
  m.n = 0;
  await tick();
  expect(el.textContent).toBe("");
  expect([...gone].sort()).toEqual(["Symbol.dispose t0", "Symbol.dispose t1", "dispose t0", "dispose t1"]);
  // The region reads `n`; the children's props bindings read `tag`: only the region's subscription is left.
  expect(subs).toBe(1);
});

test("a @catch child that fails to mount reports to onError and leaves its anchor", () => {
  class Broken extends Component {
    protected override onInitialized(): void { throw new Error("boom"); }
    protected override render(__p: Node): void { dom.t(__p, "never"); }
  }
  const errors: unknown[] = [];
  class Catcher extends Component {
    protected override render(__p: Node): void {
      dom.component(dom.anchor(__p), Broken, () => ({}), undefined, undefined, undefined, undefined, (err) => errors.push(err));
    }
  }
  const el = host();
  mount(Catcher, el);
  expect(errors.length).toBe(1);
  expect((errors[0] as Error).message).toBe("boom");
  expect(el.textContent).toBe("");
});

test("leak check: 1000 children mounted and removed leave the heap and the subscribers as they were", async () => {
  const { heapSize } = await import("bun:jsc");
  const el = host();
  const m = mount(Many, el);
  const cycle = async (): Promise<void> => {
    m.n = 1000;
    await tick();
    m.n = 0;
    await tick();
  };
  await cycle();
  subs = 0;
  gone = [];
  Bun.gc(true);
  Bun.gc(true);
  const before = heapSize();
  await cycle();
  expect(gone.length).toBe(2000);
  gone = [];
  Bun.gc(true);
  Bun.gc(true);
  const after = heapSize();
  const msg = `leak check: before ${before} B, after ${after} B, delta ${after - before} B, subscribers ${subs}`;
  expect(subs, msg).toBe(0);
  expect(after - before, msg).toBeLessThan(0.1 * 1024 * 1024);
});

// Markup values, content regions and slots, as codegen will emit them.
const __bold = dom.template([["b", 0, ""]]);
class Shows extends Component {
  #view: unknown = "t"; get view(): unknown { Component.$reader?.(this, 0); return this.#view; } set view(v: unknown) { const p = this.#view; if (Component.same(p, v)) return; this.#view = v; this.$changed(0, p); }
  #n = 0; get n(): number { Component.$reader?.(this, 1); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(1, p); }
  static { Component.$define(this, ["view", "n"]); }
  loose = 0;
  builds = 0;
  bold: Markup = Component.fragment((__p) => {
    this.builds++;
    const _e0 = __bold() as HTMLElement;
    dom.textAt(_e0.firstChild as Text, () => this.n);
    dom.on(_e0, "click", () => this.loose++);
    __p.appendChild(_e0);
  }, this);
  protected override render(__p: Node): void {
    dom.text(__p, () => this.view);
    dom.text(__p, () => this.loose);
  }
}

test("a markup value in @expr builds through a content region in its creator's context", async () => {
  const el = host();
  const s = mount(Shows, el);
  expect(el.textContent).toBe("t0");
  s.view = s.bold;
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("0");
  s.n = 3;
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("3");
  expect(s.builds).toBe(1);
  // The handler inside the fragment runs its creator's after-handler pass: the loose text follows.
  el.querySelector("b")!.click();
  expect(el.textContent).toBe("31");
});

test("a content region switches between markup and text, and back", async () => {
  const el = host();
  const s = mount(Shows, el);
  s.view = s.bold;
  await tick();
  s.view = "x";
  await tick();
  expect(el.querySelector("b")).toBeNull();
  expect(el.textContent).toBe("x0");
  const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent === "x")!;
  s.view = "y";
  await tick();
  expect(text.textContent).toBe("y");
  s.view = null;
  await tick();
  expect(el.textContent).toBe("0");
  s.view = s.bold;
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("0");
  expect(s.builds).toBe(2);
});

test("markup replaced by text disposes its bindings", async () => {
  const el = host();
  const s = mount(Shows, el);
  let runs = 0;
  s.view = Component.fragment((__p) => dom.text(__p, () => (runs++, s.n)), s);
  await tick();
  s.view = "x";
  await tick();
  const before = runs;
  s.n = 7;
  await tick();
  expect(runs).toBe(before);
  expect(el.textContent).toBe("x0");
});

test("perf: an @expr giving the same fragment, re-run 10k times, builds no DOM", async () => {
  const el = host();
  const s = mount(Shows, el);
  s.view = s.bold;
  await tick();
  const b = el.querySelector("b");
  const d = document as unknown as Record<string, (...a: unknown[]) => unknown>;
  const names = ["createElement", "createElementNS", "createTextNode", "createComment", "createDocumentFragment"];
  const saved = names.map((n) => d[n]!);
  let created = 0;
  names.forEach((n, i) => (d[n] = (...a: unknown[]) => (created++, saved[i]!.apply(document, a))));
  const t0 = performance.now();
  try {
    for (let i = 0; i < 10_000; i++) s.stateHasChanged();
  } finally {
    names.forEach((n, i) => (d[n] = saved[i]!));
  }
  const msg = `same fragment x10k: ${(performance.now() - t0).toFixed(2)} ms, nodes created ${created}`;
  expect(created, msg).toBe(0);
  expect(s.builds).toBe(1);
  expect(el.querySelector("b")).toBe(b);
});

test("a markup value in @expr rebuilds when it gives another markup", () => {
  class Page extends Component {
    view: Markup = Component.fragment((__p) => dom.text(dom.el(__p, "b"), () => "a"), this);
    protected override render(__p: Node): void {
      dom.text(__p, () => this.view);
    }
  }
  const el = host();
  const p = mount(Page, el);
  const first = el.querySelector("b");
  expect(first!.textContent).toBe("a");
  p.stateHasChanged();
  expect(el.querySelector("b")).toBe(first);
  p.view = Component.fragment((__p) => dom.text(dom.el(__p, "i"), () => "c"), p);
  p.stateHasChanged();
  expect(el.querySelector("b")).toBeNull();
  expect(el.querySelector("i")!.textContent).toBe("c");
});

const __card = dom.template([["div", 0, null, null]]);
const __it = dom.template([["i", 0, ""]]);
class Card extends Component {
  #k = 1; get k(): number { Component.$reader?.(this, 0); return this.#k; } set k(v: number) { const p = this.#k; if (Component.same(p, v)) return; this.#k = v; this.$changed(0, p); }
  static { Component.$define(this, ["k"]); }
  declare slots: { default?: () => Markup; title?: (n: number) => Markup };
  protected override render(__p: Node): void {
    const _e0 = __card() as HTMLDivElement;
    dom.slotAt(_e0.lastChild as Comment, () => this.slots.default, undefined, (__p) => dom.t(__p, "empty"));
    __p.appendChild(_e0);
    dom.slotAt(dom.anchors(__p), () => this.slots.title, () => [this.k]);
  }
}
class Deck extends Component {
  #label = "a"; get label(): string { Component.$reader?.(this, 0); return this.#label; } set label(v: string) { const p = this.#label; if (Component.same(p, v)) return; this.#label = v; this.$changed(0, p); }
  static { Component.$define(this, ["label"]); }
  untracked = 0;
  loose = 0;
  filled = true;
  card: Card | undefined;
  protected override render(__p: Node): void {
    dom.component(dom.anchor(__p), Card, () => ({}), undefined, this.filled ? {
      default: () => Component.fragment((__p) => {
        const _e0 = __it() as HTMLElement;
        dom.textAt(_e0.firstChild as Text, () => `${this.label}/${this.untracked}`);
        dom.on(_e0, "click", () => this.loose++);
        __p.appendChild(_e0);
      }, this),
      title: (n: number) => Component.fragment((__p) => dom.t(__p, `T${n}`), this),
    } : undefined, (c) => (this.card = c as Card));
    dom.text(__p, () => this.loose);
  }
}

test("@slot builds the fill, or the fallback when there is none", () => {
  const el = host();
  mount(Deck, el);
  expect(el.querySelector("div")!.innerHTML).toBe("<!----><i>a/0</i><!---->");
  expect(el.textContent).toBe("a/0T10");
  class Bare extends Deck {
    override filled = false;
  }
  const bare = host();
  mount(Bare, bare);
  expect(bare.querySelector("div")!.textContent).toBe("empty");
  expect(bare.textContent).toBe("empty0");
});

test("slot content follows the parent: tracked reads alone, untracked ones on the parent's pass; changed args rebuild", async () => {
  const el = host();
  const d = mount(Deck, el);
  const i = el.querySelector("i")!;
  d.label = "b";
  await tick();
  expect(i.textContent).toBe("b/0");
  d.untracked = 5;
  d.stateHasChanged();
  expect(i.textContent).toBe("b/5");
  // The child's own pass keeps the fill (same fill, same args).
  d.card!.stateHasChanged();
  expect(el.querySelector("i")).toBe(i);
  d.card!.k = 2;
  await tick();
  expect(el.textContent).toBe("b/5T20");
  expect(el.querySelector("i")).toBe(i);
});

test("a handler inside slot content runs the parent's after-handler pass", () => {
  const el = host();
  mount(Deck, el);
  el.querySelector("i")!.click();
  expect(el.textContent).toBe("a/0T11");
});

const __pick = dom.template([["button", 0, ""]]);
type Pickable = { id: number; name: string };
class Pick extends Component {
  name = "";
  onPick: (() => void) | undefined = undefined;
  protected override render(__p: Node): void {
    const _e0 = __pick() as HTMLButtonElement;
    dom.textAt(_e0.firstChild as Text, () => this.name);
    dom.on(_e0, "click", () => this.onPick!());
    __p.appendChild(_e0);
  }
}
class Picks extends Component {
  #items: Pickable[] = []; get items(): Pickable[] { Component.$reader?.(this, 0); return this.#items; } set items(v: Pickable[]) { const p = this.#items; if (Component.same(p, v)) return; this.#items = v; this.$changed(0, p); }
  static { Component.$define(this, ["items"]); }
  picked: string[] = [];
  protected override render(__p: Node): void {
    dom.listAt(dom.anchor(__p), () => this.items, [
      (it: Pickable) => ({ name: it.name }),
      (it: Pickable) => ({ onPick: () => this.picked.push(it.name) }),
    ], (__p) => dom.componentItem(dom.anchor(__p), Pick, 0, 1), undefined, (it) => it.id);
  }
}

test("click after the row's item is replaced under the same key uses the new item", async () => {
  const el = host();
  const p = mount(Picks, el);
  p.items = [{ id: 1, name: "a" }];
  await tick();
  const button = el.querySelector("button")!;
  button.click();
  p.items = [{ id: 1, name: "b" }];
  await tick();
  expect(el.querySelector("button")).toBe(button);
  expect(button.textContent).toBe("b");
  button.click();
  expect(p.picked).toEqual(["a", "b"]);
});

test("a callback made with dom.callback runs its owner's after-handler pass", () => {
  class Owner extends Component {
    clicks = 0;
    protected override render(__p: Node): void {
      dom.component(dom.anchor(__p), Pick, () => ({ name: "p" }), { onPick: dom.callback(this, () => void this.clicks++) });
      dom.text(__p, () => this.clicks);
    }
  }
  const el = host();
  mount(Owner, el);
  el.querySelector("button")!.click();
  expect(el.textContent).toBe("p1");
});

// `onPick="@(editing ? save : cancel)"`: read with the props, called with the owner as `this` (a member is not bound).
test("a callback prop that is a conditional follows the condition and runs with its owner as this", async () => {
  class Owner extends Component {
    #editing = false; get editing(): boolean { Component.$reader?.(this, 0); return this.#editing; } set editing(v: boolean) { const p = this.#editing; if (Component.same(p, v)) return; this.#editing = v; this.$changed(0, p); }
    static { Component.$define(this, ["editing"]); }
    log: string[] = [];
    save(): void { this.log.push("save"); }
    cancel(): void { this.log.push("cancel"); }
    protected override render(__p: Node): void {
      dom.component(dom.anchor(__p), Pick, (): Partial<Pick> => ({ name: "p", onPick: dom.callback(this, this.editing ? this.save : this.cancel) }));
    }
  }
  const el = host();
  const o = mount(Owner, el);
  el.querySelector("button")!.click();
  o.editing = true;
  await tick();
  el.querySelector("button")!.click();
  expect(o.log).toEqual(["cancel", "save"]);
});

test("dom.component and componentItem type their props against the component", () => {
  class Owner extends Component {
    protected override render(__p: Node): void {
      // @ts-expect-error `nam` is not a prop of Pick
      dom.component(dom.anchor(__p), Pick, (): Partial<Pick> => ({ nam: "x" }));
      // @ts-expect-error a prop of the wrong type
      dom.component(dom.anchor(__p), Pick, () => ({}), { name: 1 });
      dom.component(dom.anchor(__p), Pick, () => ({ name: "ok" }), undefined, undefined, (c) => void c.name.length);
    }
  }
  expect(Owner).toBeDefined();
});

// `@cascade:name(value[, fixed])`, as codegen will emit it.
let seen: string[] = [];
type Scope = { name: string; value: unknown; consumers: Set<Component> | undefined };
class Reader extends Component {
  static cascades = [["theme", "theme"]] as const;
  theme: unknown = undefined;
  tag = "";
  protected override onParametersSet(): void { seen.push(`${this.tag} params ${String(this.theme)}`); }
  protected override render(__p: Node): void { dom.text(__p, () => `${this.tag}=${String(this.theme)};`); }
}
class Theme extends Component {
  #theme = "dark"; get theme(): string { Component.$reader?.(this, 0); return this.#theme; } set theme(v: string) { const p = this.#theme; if (Component.same(p, v)) return; this.#theme = v; this.$changed(0, p); }
  #inner = "x"; get inner(): string { Component.$reader?.(this, 1); return this.#inner; } set inner(v: string) { const p = this.#inner; if (Component.same(p, v)) return; this.#inner = v; this.$changed(1, p); }
  #on = true; get on(): boolean { Component.$reader?.(this, 2); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(2, p); }
  #more = 0; get more(): number { Component.$reader?.(this, 3); return this.#more; } set more(v: number) { const p = this.#more; if (Component.same(p, v)) return; this.#more = v; this.$changed(3, p); }
  static { Component.$define(this, ["theme", "inner", "on", "more"]); }
  fixed = false;
  nested = false;
  a: Reader | undefined;
  protected override render(__p: Node): void {
    dom.region(__p, (__p) => {
      if (!this.on) return;
      dom.cascadeAt(dom.anchors(__p), "theme", () => this.theme, this.fixed, (__p) => {
        dom.component(dom.anchor(__p), Reader, () => ({ tag: "a" }), undefined, undefined, (c) => (this.a = c as Reader));
        if (this.nested) dom.cascadeAt(dom.anchors(__p), "theme", () => this.inner, false, (__p) => dom.component(dom.anchor(__p), Reader, () => ({ tag: "b" })));
        dom.region(__p, (__p) => {
          for (let i = 0; i < this.more; i++) dom.component(dom.anchor(__p), Reader, () => ({ tag: `c${i}` }));
        });
      });
    });
  }
}

test("@cascade: a child takes the value, and a change assigns it, then onParametersSet and a pass", async () => {
  seen = [];
  const el = host();
  const t = mount(Theme, el);
  expect(el.textContent).toBe("a=dark;");
  t.theme = "light";
  await tick();
  expect(el.textContent).toBe("a=light;");
  expect(seen).toEqual(["a params dark", "a params light"]);
});

test("@cascade: a region inside it built later still sees it", async () => {
  const el = host();
  const t = mount(Theme, el);
  t.more = 2;
  await tick();
  expect(el.textContent).toBe("a=dark;c0=dark;c1=dark;");
  t.theme = "light";
  await tick();
  expect(el.textContent).toBe("a=light;c0=light;c1=light;");
});

test("@cascade fixed keeps its first value and subscribes no one", async () => {
  class Fixed extends Theme {
    override fixed = true;
  }
  seen = [];
  const el = host();
  const t = mount(Fixed, el);
  t.theme = "light";
  await tick();
  expect(el.textContent).toBe("a=dark;");
  expect(seen).toEqual(["a params dark"]);
  expect((t.a!.$scope as Scope).consumers).toBeUndefined();
});

test("@cascade nested: the nearest provider of a name wins", async () => {
  class Nested extends Theme {
    override nested = true;
  }
  seen = [];
  const el = host();
  const t = mount(Nested, el);
  expect(el.textContent).toBe("a=dark;b=x;");
  t.inner = "y";
  await tick();
  expect(el.textContent).toBe("a=dark;b=y;");
  t.theme = "light";
  await tick();
  expect(el.textContent).toBe("a=light;b=y;");
  expect(seen).toEqual(["a params dark", "b params x", "b params y", "a params light"]);
});

test("@cascade: a consumer that goes unsubscribes", async () => {
  const el = host();
  const t = mount(Theme, el);
  t.more = 3;
  await tick();
  const scope = t.a!.$scope as Scope;
  expect(scope.name).toBe("theme");
  expect(scope.consumers!.size).toBe(4);
  t.more = 1;
  await tick();
  expect(scope.consumers!.size).toBe(2);
  t.on = false;
  await tick();
  expect(el.textContent).toBe("");
  expect(scope.consumers!.size).toBe(0);
});

test("leak check: 1000 consumers under a cascade mounted and removed leave the heap and the consumers as they were", async () => {
  const { heapSize } = await import("bun:jsc");
  const el = host();
  const t = mount(Theme, el);
  const scope = t.a!.$scope as Scope;
  const cycle = async (): Promise<void> => {
    t.more = 1000;
    await tick();
    t.more = 0;
    await tick();
  };
  await cycle();
  seen = [];
  Bun.gc(true);
  Bun.gc(true);
  const before = heapSize();
  await cycle();
  seen = [];
  Bun.gc(true);
  Bun.gc(true);
  const after = heapSize();
  const msg = `cascade leak check: before ${before} B, after ${after} B, delta ${after - before} B, consumers ${scope.consumers!.size - 1}`;
  expect(scope.consumers!.size - 1, msg).toBe(0);
  expect(after - before, msg).toBeLessThan(0.1 * 1024 * 1024);
});

// `@attributes="bag"`, as codegen will emit it.
class Bag extends Component {
  #bag: Record<string, unknown> | null | undefined = { id: "a", title: "t", disabled: true, value: "v", "aria-busy": false };
  get bag(): Record<string, unknown> | null | undefined { Component.$reader?.(this, 0); return this.#bag; } set bag(v: Record<string, unknown> | null | undefined) { const p = this.#bag; if (Component.same(p, v)) return; this.#bag = v; this.$changed(0, p); }
  static { Component.$define(this, ["bag"]); }
  protected override render(__p: Node): void {
    const _e0 = dom.el(__p, "input");
    _e0.setAttribute("name", "n");
    dom.attrs(_e0, () => this.bag);
  }
}

test("@attributes sets the bag's values, and removes the keys a new bag lacks", async () => {
  const el = host();
  const b = mount(Bag, el);
  const input = el.querySelector("input")!;
  expect(input.outerHTML).toBe('<input name="n" id="a" title="t" disabled="" value="v" aria-busy="false">');
  expect(input.value).toBe("v");
  b.bag = { id: "b", "data-x": 1, disabled: false };
  await tick();
  expect(input.outerHTML).toBe('<input name="n" id="b" data-x="1">');
  b.bag = null;
  await tick();
  expect(input.outerHTML).toBe('<input name="n">');
  b.bag = { title: "back" };
  await tick();
  expect(input.outerHTML).toBe('<input name="n" title="back">');
});

// Later attributes override the bag, earlier ones are overridden by it: codegen lists the names written after `@attributes`
// and the (name, value | read) pairs written before it.
class BagOrder extends Component {
  #bag: Record<string, unknown> | null | undefined = { class: "bag", id: "bag", title: "bag" };
  get bag(): Record<string, unknown> | null | undefined { Component.$reader?.(this, 0); return this.#bag; } set bag(v: Record<string, unknown> | null | undefined) { const p = this.#bag; if (Component.same(p, v)) return; this.#bag = v; this.$changed(0, p); }
  static { Component.$define(this, ["bag"]); }
  protected override render(__p: Node): void {
    const _e0 = dom.el(__p, "p");
    _e0.setAttribute("id", "before");
    _e0.setAttribute("class", "after");
    dom.attrs(_e0, () => this.bag, ["class"], ["id", "before"]);
  }
}

test("@attributes: a static written after it wins, one written before it loses while the bag has the key and comes back", async () => {
  const el = host();
  const b = mount(BagOrder, el);
  const p = el.querySelector("p")!;
  expect(p.outerHTML).toBe('<p id="bag" class="after" title="bag"></p>');
  b.bag = { class: "other", id: "other" };
  await tick();
  expect(p.outerHTML).toBe('<p id="other" class="after"></p>');
  b.bag = null;
  await tick();
  expect(p.outerHTML).toBe('<p id="before" class="after"></p>');
  b.bag = { id: "again", title: "t" };
  await tick();
  expect(p.outerHTML).toBe('<p id="again" class="after" title="t"></p>');
});

class BagDynamic extends Component {
  #bag: Record<string, unknown> | null | undefined = { title: "bag" };
  get bag(): Record<string, unknown> | null | undefined { Component.$reader?.(this, 0); return this.#bag; } set bag(v: Record<string, unknown> | null | undefined) { const p = this.#bag; if (Component.same(p, v)) return; this.#bag = v; this.$changed(0, p); }
  #before = "b1";
  get before(): string { Component.$reader?.(this, 1); return this.#before; } set before(v: string) { const p = this.#before; if (Component.same(p, v)) return; this.#before = v; this.$changed(1, p); }
  #after = "a1";
  get after(): string { Component.$reader?.(this, 2); return this.#after; } set after(v: string) { const p = this.#after; if (Component.same(p, v)) return; this.#after = v; this.$changed(2, p); }
  static { Component.$define(this, ["bag", "before", "after"]); }
  protected override render(__p: Node): void {
    const _e0 = dom.el(__p, "p");
    dom.attrs(_e0, () => this.bag, ["id"], ["title", () => this.before]);
    dom.attr(_e0, "id", () => this.after);
  }
}

test("@attributes: a dynamic attribute before it is overridden by the bag while it has the key, and follows its own reads otherwise", async () => {
  const el = host();
  const b = mount(BagDynamic, el);
  const p = el.querySelector("p")!;
  expect(p.outerHTML).toBe('<p title="bag" id="a1"></p>');
  b.before = "b2";
  await tick();
  expect(p.getAttribute("title")).toBe("bag");
  b.bag = {};
  await tick();
  expect(p.getAttribute("title")).toBe("b2");
  b.before = "b3";
  await tick();
  expect(p.getAttribute("title")).toBe("b3");
  b.bag = { title: "again", id: "bag-id" };
  await tick();
  expect(p.getAttribute("title")).toBe("again");
  b.before = "b4";
  await tick();
  expect(p.getAttribute("title")).toBe("again");
  // One written after it wins over the bag's key.
  expect(p.getAttribute("id")).toBe("a1");
  b.after = "a2";
  await tick();
  expect(p.getAttribute("id")).toBe("a2");
});

class BagClass extends Component {
  #bag: Record<string, unknown> | null | undefined = { class: "a" };
  get bag(): Record<string, unknown> | null | undefined { Component.$reader?.(this, 0); return this.#bag; } set bag(v: Record<string, unknown> | null | undefined) { const p = this.#bag; if (Component.same(p, v)) return; this.#bag = v; this.$changed(0, p); }
  #on = true;
  get on(): boolean { Component.$reader?.(this, 1); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(1, p); }
  static { Component.$define(this, ["bag", "on"]); }
  protected override render(__p: Node): void {
    const _e0 = dom.el(__p, "p");
    dom.attrs(_e0, () => this.bag, undefined, ["class:x", () => this.on]);
  }
}

test("@attributes: class:x toggles stay on top of a changing bag class", async () => {
  const el = host();
  const b = mount(BagClass, el);
  const p = el.querySelector("p")!;
  expect(p.className).toBe("a x");
  b.bag = { class: "b" };
  await tick();
  expect(p.className).toBe("b x");
  b.on = false;
  await tick();
  expect(p.className).toBe("b");
  b.bag = { class: "c" };
  await tick();
  expect(p.className).toBe("c");
  b.on = true;
  b.bag = null;
  await tick();
  expect(p.className).toBe("x");
});

test("@attributes inside @once sets the bag once, untracked", async () => {
  class OnceBag extends Component {
    #bag: Record<string, unknown> = { id: "a", class: "bag" };
    get bag(): Record<string, unknown> { Component.$reader?.(this, 0); return this.#bag; } set bag(v: Record<string, unknown>) { const p = this.#bag; if (Component.same(p, v)) return; this.#bag = v; this.$changed(0, p); }
    static { Component.$define(this, ["bag"]); }
    protected override render(__p: Node): void {
      dom.onceAt(__p.appendChild(document.createComment("")), (__p) => {
        const _e0 = dom.el(__p, "p");
        _e0.setAttribute("class", "after");
        dom.setAttrs(_e0, this.bag, ["class"], ["class:x", true]);
      });
    }
  }
  const el = host();
  const b = mount(OnceBag, el);
  const p = el.querySelector("p")!;
  expect(p.outerHTML).toBe('<p class="after x" id="a"></p>');
  b.bag = { id: "b" };
  await tick();
  expect(p.outerHTML).toBe('<p class="after x" id="a"></p>');
});

// Event modifiers: 1 = preventDefault, 2 = stopPropagation.
const __mods = dom.template([["div", 0, ["button", 0, "go"], ["form", 0, ["input", 0]]]]);
class Mods extends Component {
  hits: string[] = [];
  protected override render(__p: Node): void {
    const _e0 = __mods() as HTMLDivElement;
    const _e1 = _e0.firstChild as HTMLButtonElement;
    const _e2 = _e1.nextSibling as HTMLFormElement;
    dom.on(_e0, "click", () => this.hits.push("outer click"));
    dom.on(_e1, "click", () => this.hits.push("button click"), 3);
    dom.on(_e0, "submit", () => this.hits.push("outer submit"));
    dom.on(_e2, "submit", undefined, 3);
    dom.on(_e2.firstChild as HTMLInputElement, "focus", () => this.hits.push("focus"), 1);
    __p.appendChild(_e0);
  }
}

test("event modifiers: preventDefault and stopPropagation, delegated and not, with or without a handler", () => {
  const el = host();
  const m = mount(Mods, el);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.querySelector("button")!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  const submit = new Event("submit", { bubbles: true, cancelable: true });
  el.querySelector("form")!.dispatchEvent(submit);
  expect(submit.defaultPrevented).toBe(true);
  const focus = new FocusEvent("focus", { cancelable: true });
  el.querySelector("input")!.dispatchEvent(focus);
  expect(focus.defaultPrevented).toBe(true);
  expect(m.hits).toEqual(["button click", "focus"]);
  el.querySelector("div")!.click();
  expect(m.hits).toEqual(["button click", "focus", "outer click"]);
});

const __li = dom.template([["li", 0, ["a", 0, "x"]]]);
class ModRows extends Component {
  items = [{ n: 1 }, { n: 2 }];
  hits: number[] = [];
  outer = 0;
  protected override render(__p: Node): void {
    const _e0 = dom.el(__p, "ul");
    dom.on(_e0, "click", () => this.outer++);
    dom.listAt(dom.anchor(_e0), () => this.items, [(r: { n: number }) => () => this.hits.push(r.n)], (__p) => {
      const _e1 = __li() as HTMLLIElement;
      dom.onItem(_e1.firstChild as Element, "click", 0, 3);
      __p.appendChild(_e1);
    });
  }
}

test("event modifiers on a row's handler", () => {
  const el = host();
  const m = mount(ModRows, el);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.querySelectorAll("a")[1]!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(m.hits).toEqual([2]);
  expect(m.outer).toBe(0);
});

// `@Routes`, as codegen will emit it: a table in the shape of `.xzor/routes.ts`, sections whose renders give DOM markup.
(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("http://localhost/");

class MemoryNav {
  url: URL;
  readonly calls: [string, boolean][] = [];
  readonly subs = new Set<() => void>();
  constructor(start: string) {
    this.url = new URL(start, "http://localhost");
  }
  current(): URL {
    return this.url;
  }
  navigate(url: string, replace: boolean): void {
    this.calls.push([url, replace]);
    this.go(url);
  }
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  go(url: string): void {
    this.url = new URL(url, "http://localhost");
    for (const fn of [...this.subs]) fn();
  }
}

const memoryNav = (start: string): MemoryNav => {
  const m = new MemoryNav(start);
  setNavigationForTests(m);
  return m;
};

let lastView: UserView | undefined;
class UserView extends Component {
  id = 0;
  renders = 0;
  paramsSet = 0;
  protected override onParametersSet(): void { this.paramsSet++; }
  protected override render(__p: Node): void {
    lastView = this;
    dom.text(dom.el(__p, "u"), () => (this.renders++, this.id));
  }
}
class NewView extends Component {
  protected override render(__p: Node): void { dom.t(dom.el(__p, "n"), "new"); }
}
class DocView extends Component {
  rest = "";
  protected override render(__p: Node): void { dom.text(dom.el(__p, "d"), () => this.rest); }
}
class RootView extends Component {
  protected override render(__p: Node): void { dom.t(dom.el(__p, "r"), "root"); }
}
let lastEdit: EditView | undefined;
class EditView extends Component {
  id = 0;
  tab = "";
  protected override render(__p: Node): void {
    lastEdit = this;
    dom.text(dom.el(__p, "e"), () => `${this.id}${this.tab}`);
  }
}

const views: RouteTable = [
  { tag: undefined, pattern: "/", component: RootView, match: (s) => (s.length === 0 ? {} : null) },
  { tag: undefined, pattern: "/users/new", component: NewView, match: (s) => (s.length === 2 && s[0] === "users" && s[1] === "new" ? {} : null) },
  { tag: "admin", pattern: "/users/:id", component: UserView, match: (s) => (s.length === 2 && s[0] === "users" && /^\d+$/.test(s[1]!) ? { id: Number(s[1]) } : null) },
  { tag: undefined, pattern: "/docs/*", component: DocView, match: (s) => (s[0] === "docs" ? { rest: s.slice(1).join("/") } : null) },
  { tag: undefined, pattern: "/edit/:id", component: EditView, match: (s) => (s.length === 2 && s[0] === "edit" ? { id: Number(s[1]) } : null) },
  { tag: undefined, pattern: "/edit/:id/:tab", family: "/edit/:id", component: EditView, match: (s) => (s.length === 3 && s[0] === "edit" ? { id: Number(s[1]), tab: s[2] } : null) },
];

/** A layout section: the page inside `tag`. */
const around =
  (tag: string) =>
  (_route: Route, page: Markup): Markup =>
    Component.fragment((__p) => dom.text(dom.el(__p, tag), () => page));

/** A page-less section: one value read from `route`. */
const shows =
  (tag: string, read: (route: Route) => unknown) =>
  (route: Route): Markup =>
    Component.fragment((__p) => dom.text(dom.el(__p, tag), () => read(route)));

function routing(sections: RouteSection[], table: RouteTable = views) {
  class Shell extends Component {
    #on = true; get on(): boolean { Component.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(0, p); }
    static { Component.$define(this, ["on"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.on) dom.routesAt(dom.anchors(__p), table, sections);
      });
    }
  }
  const el = host();
  const shell = mount(Shell, el);
  return {
    el,
    html: () => el.innerHTML.replaceAll("<!---->", ""),
    drop: async () => {
      shell.on = false;
      await tick();
      el.remove();
    },
  };
}

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("routes through dom: the first section taking the page's tag, else @default, else the bare page", async () => {
  memoryNav("/users/7");
  const tagged = routing([{ kind: "tag", tag: "admin", render: around("main") }, { kind: "default", render: around("aside") }]);
  expect(tagged.html()).toBe("<main><u>7</u></main>");
  memoryNav("/users/new");
  const other = routing([{ kind: "tag", tag: "admin", render: around("main") }, { kind: "default", render: around("aside") }]);
  expect(other.html()).toBe("<aside><n>new</n></aside>");
  memoryNav("/users/7");
  const bare = routing([{ kind: "tag", tag: "none", render: around("main") }]);
  expect(bare.html()).toBe("<u>7</u>");
  for (const r of [tagged, other, bare]) await r.drop();
});

test("routes through dom: regex and pattern sections give route.match; page-less ones decide without a page; @notFound", async () => {
  memoryNav("/users/7");
  const regex = routing([{ kind: "regex", re: /^\/users\/(?<who>\w+)/, page: true, render: shows("b", (r) => r.match.who) }, { kind: "default", render: around("aside") }]);
  expect(regex.html()).toBe("<b>7</b>");
  memoryNav("/docs/a/b");
  const pattern = routing([
    {
      kind: "pattern",
      match: (s) => (s[0] === "docs" ? { area: s[1] ?? "" } : null),
      page: true,
      render: (route: Route, page: Markup) => Component.fragment((__p) => {
        const _e0 = dom.el(__p, "i");
        dom.text(_e0, () => route.match.area);
        dom.text(_e0, () => page);
      }),
    },
  ]);
  expect(pattern.html()).toBe("<i>a<d>a/b</d></i>");
  memoryNav("/legal/terms");
  const pageless = routing([
    { kind: "tag", tag: "admin", render: around("main") },
    { kind: "regex", re: /^\/legal\//, page: true, render: shows("b", () => "wrong") },
    { kind: "pattern", match: (s) => (s[0] === "legal" ? { doc: s[1] ?? "" } : null), page: false, render: shows("i", (r) => (r.params as { doc: string }).doc) },
    { kind: "default", render: around("aside") },
  ]);
  expect(pageless.html()).toBe("<i>terms</i>");
  const m = memoryNav("/missing");
  const missing = routing([{ kind: "default", render: around("aside") }, { kind: "notFound", render: shows("p", (r) => r.path) }]);
  expect(missing.html()).toBe("<p>/missing</p>");
  // A kept section reads the new route.
  m.go("/gone");
  expect(missing.html()).toBe("<p>/gone</p>");
  m.go("/users/new");
  expect(missing.html()).toBe("<aside><n>new</n></aside>");
  for (const r of [regex, pattern, pageless, missing]) await r.drop();
});

test("routes through dom: a params-only or query-only navigation keeps the page and sets its parameters again", async () => {
  const m = memoryNav("/users/1?q=a");
  const r = routing([{ kind: "default", render: around("aside") }]);
  const page = lastView!;
  expect(page.paramsSet).toBe(1);
  m.go("/users/2?q=a");
  expect(r.html()).toBe("<aside><u>2</u></aside>");
  expect(lastView).toBe(page);
  expect(page.paramsSet).toBe(2);
  expect(page.renders).toBe(2);
  // Equal params: the navigation moved on, so the page takes them again.
  m.go("/users/2?q=b");
  expect(lastView).toBe(page);
  expect(page.paramsSet).toBe(3);
  m.go("/docs/x");
  expect(r.html()).toBe("<aside><d>x</d></aside>");
  m.go("/users/2");
  expect(lastView).not.toBe(page);
  await r.drop();
});

test("routes through dom: routes of one family share the page instance", async () => {
  const m = memoryNav("/edit/1");
  const r = routing([{ kind: "default", render: around("aside") }]);
  const page = lastEdit!;
  m.go("/edit/1/tab");
  expect(r.html()).toBe("<aside><e>1tab</e></aside>");
  expect(lastEdit).toBe(page);
  await r.drop();
});

let failLater: ((err: unknown) => void) | undefined;
class SlowView extends Component {
  protected override onInitializedAsync(): Promise<void> {
    return new Promise<void>((_resolve, reject) => (failLater = reject));
  }
  protected override render(__p: Node): void { dom.t(__p, "slow"); }
}
class BrokenView extends Component {
  protected override onInitialized(): void { throw new Error("init"); }
  protected override render(__p: Node): void { dom.t(__p, "never"); }
}
const failing = (component: unknown): RouteTable => [{ tag: undefined, pattern: "/boom", component, match: (s) => (s.length === 1 && s[0] === "boom" ? {} : null) }, ...views];
const catching: RouteSection[] = [
  { kind: "catch", render: (route: Route, error: unknown) => shows("em", () => String(error))(route) },
  { kind: "default", render: around("aside") },
];

test("routes through dom: @catch shows the page's failure; a navigation clears it", async () => {
  const m = memoryNav("/boom");
  const r = routing(catching, failing(BrokenView));
  await tick();
  expect(r.html()).toBe("<em>Error: init</em>");
  m.go("/users/1");
  expect(r.html()).toBe("<aside><u>1</u></aside>");
  await r.drop();
});

test("routes through dom: a failure from a page we left is dropped; a page kept by a query-only navigation still reports", async () => {
  const m = memoryNav("/boom");
  const r = routing(catching, failing(SlowView));
  expect(r.html()).toBe("<aside>slow</aside>");
  m.go("/users/1");
  failLater!(new Error("late"));
  await tick();
  expect(r.html()).toBe("<aside><u>1</u></aside>");

  m.go("/boom");
  m.go("/boom?x=1");
  expect(r.html()).toBe("<aside>slow</aside>");
  failLater!(new Error("kept"));
  await tick();
  expect(r.html()).toBe("<em>Error: kept</em>");
  await r.drop();
});

class Crumbs extends Component {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  paramsSet = 0;
  protected override onParametersSet(): void { this.paramsSet++; }
  protected override render(__p: Node): void {
    dom.text(dom.el(__p, "span"), () => `${this.route?.path ?? "none"}?${this.route?.query.get("q") ?? ""}`);
  }
}

test("routes through dom: route is a cascading value; route.navigate pushes or replaces", async () => {
  const m = memoryNav("/users/1?q=a");
  let crumbs: Crumbs | undefined;
  let captured: Route | undefined;
  const r = routing([
    {
      kind: "default",
      render: (route: Route, page: Markup) => {
        captured = route;
        return Component.fragment((__p) => {
          dom.component(dom.anchor(__p), Crumbs, () => ({}), undefined, undefined, (c) => (crumbs = c as Crumbs));
          dom.text(__p, () => page);
        });
      },
    },
  ]);
  expect(r.html()).toBe("<span>/users/1?a</span><u>1</u>");
  const first = crumbs!;
  expect(first.paramsSet).toBe(1);
  m.go("/users/2?q=b");
  expect(r.html()).toBe("<span>/users/2?b</span><u>2</u>");
  expect(crumbs).toBe(first);
  expect(first.paramsSet).toBe(2);
  expect(captured!.path).toBe("/users/2");
  captured!.navigate("/users/3");
  captured!.navigate("/users/4", { replace: true });
  expect(m.calls).toEqual([["/users/3", false], ["/users/4", true]]);
  expect(r.html()).toBe("<span>/users/4?</span><u>4</u>");
  await r.drop();
});

class Redirect extends Component {
  static readonly cascades = [["route", "route"]] as const;
  route: Route | undefined;
  protected override onInitialized(): void { this.route!.navigate("/users/1", { replace: true }); }
  protected override render(__p: Node): void { dom.t(__p, "redirect"); }
}

test("routes through dom: a navigation raised while a page builds is applied once the pass ends", async () => {
  const m = memoryNav("/boom");
  const r = routing([{ kind: "default", render: around("aside") }], failing(Redirect));
  expect(m.calls).toEqual([["/users/1", true]]);
  await tick();
  expect(r.html()).toBe("<aside><u>1</u></aside>");
  await r.drop();
});

class InitLoad extends Component {
  #title = ""; get title(): string { Component.$reader?.(this, 0); return this.#title; } set title(v: string) { const p = this.#title; if (Component.same(p, v)) return; this.#title = v; this.$changed(0, p); }
  static { Component.$define(this, ["title"]); }
  protected override async onInitializedAsync(): Promise<void> {
    await later(5);
    this.title = "init";
  }
  protected override render(__p: Node): void { dom.text(dom.el(__p, "h1"), () => this.title); }
}
class ParamsLoad extends Component {
  id = 0;
  title = "";
  protected override async onParametersSetAsync(): Promise<void> {
    await later(5);
    this.title = `p${this.id}`;
  }
  protected override render(__p: Node): void { dom.text(dom.el(__p, "h1"), () => this.title); }
}

async function transitions(body: (updates: unknown[]) => Promise<void>): Promise<void> {
  setNavigationForTests(undefined);
  const doc = document as unknown as { startViewTransition?: (cb: () => unknown) => { ready: Promise<void> } };
  const updates: unknown[] = [];
  doc.startViewTransition = (cb) => {
    updates.push(cb());
    return { ready: Promise.resolve() };
  };
  viewTransitions(true);
  try {
    await body(updates);
  } finally {
    viewTransitions(false);
    setTransitionCapForTests(undefined);
    delete doc.startViewTransition;
    history.replaceState(null, "", "/");
  }
}

const go = (path: string): void => {
  history.replaceState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

test("routes through dom: a view transition waits for the new page's onInitializedAsync", async () => {
  await transitions(async (updates) => {
    history.replaceState(null, "", "/");
    const r = routing([{ kind: "default", render: around("aside") }], [{ tag: undefined, pattern: "/init", component: InitLoad, match: (s) => (s[0] === "init" ? {} : null) }, ...views]);
    go("/init");
    expect(r.html()).toBe("<aside><h1></h1></aside>");
    expect(updates[0]).toBeInstanceOf(Promise);
    await updates[0];
    expect(r.html()).toBe("<aside><h1>init</h1></aside>");
    await r.drop();
  });
});

test("routes through dom: a view transition waits for a lazy page's chunk, then its hooks; the cap holds", async () => {
  await transitions(async (updates) => {
    history.replaceState(null, "", "/");
    const table = (load: () => Promise<{ default: typeof ParamsLoad }>): RouteTable => [
      { tag: undefined, pattern: "/p/:id", component: lazy(load), match: (s) => (s.length === 2 && s[0] === "p" ? { id: Number(s[1]) } : null) },
      ...views,
    ];
    const r = routing([{ kind: "default", render: around("aside") }], table(() => later(10).then(() => ({ default: ParamsLoad }))));
    go("/p/7");
    expect(r.html()).toBe("<aside></aside>");
    await updates[0];
    expect(r.html()).toBe("<aside><h1>p7</h1></aside>");
    await r.drop();

    setTransitionCapForTests(20);
    go("/");
    const hung = routing([{ kind: "default", render: around("aside") }], table(() => new Promise(() => {})));
    go("/p/1");
    const started = performance.now();
    expect(updates.length).toBe(2);
    await updates[1];
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(hung.html()).toBe("<aside></aside>");
    await hung.drop();
  });
});

const left: string[] = [];
class LeftView extends Component {
  id = 0;
  protected override dispose(): void { left.push(`page ${this.id}`); }
  protected override render(__p: Node): void { dom.text(dom.el(__p, "u"), () => this.id); }
}

test("routes through dom: a page that leaves is disposed, a family change or a section without it too; unmounting unsubscribes and disposes the page", async () => {
  left.length = 0;
  const m = memoryNav("/users/1");
  const table: RouteTable = [{ tag: "admin", pattern: "/users/:id", component: LeftView, match: (s) => (s.length === 2 && s[0] === "users" && /^\d+$/.test(s[1]!) ? { id: Number(s[1]) } : null) }, ...views];
  const r = routing([{ kind: "tag", tag: "admin", render: around("main") }, { kind: "notFound", render: shows("p", (route) => route.path) }, { kind: "default", render: around("aside") }], table);
  expect(r.html()).toBe("<main><u>1</u></main>");
  m.go("/users/2");
  expect(left).toEqual([]);
  m.go("/docs/a");
  expect(left).toEqual(["page 2"]);
  expect(r.html()).toBe("<aside><d>a</d></aside>");
  m.go("/missing");
  expect(r.html()).toBe("<p>/missing</p>");
  m.go("/users/3");
  expect(m.subs.size).toBe(1);
  await r.drop();
  expect(left).toEqual(["page 2", "page 3"]);
  expect(m.subs.size).toBe(0);
  m.go("/users/4");
  expect(left).toEqual(["page 2", "page 3"]);
});

test("leak check: a routes block navigated 200 times and unmounted leaves the heap and the subscribers as they were", async () => {
  const { heapSize, heapStats } = await import("bun:jsc");
  // happy-dom's `baseURI` getter keeps one cache record per read after any DOM change.
  Object.defineProperty(document, "baseURI", { configurable: true, get: () => "http://localhost/" });
  const m = memoryNav("/users/1");
  const cycle = async (): Promise<void> => {
    const r = routing([{ kind: "default", render: around("aside") }]);
    for (let i = 0; i < 200; i++) m.go(i % 2 === 0 ? `/docs/${i}` : `/users/${i}`);
    expect(m.subs.size).toBe(1);
    await r.drop();
    lastView = undefined;
    Bun.gc(true);
    Bun.gc(true);
  };
  try {
    // Enough cycles for the JIT to settle: after one, its compiled code still grows the heap by ~50 KB a cycle.
    for (let i = 0; i < 5; i++) await cycle();
    const before = heapSize();
    const objects = heapStats().objectTypeCounts.Object!;
    for (let i = 0; i < 5; i++) await cycle();
    const after = heapSize();
    // happy-dom's `document.body` keeps one record per mount; a leak per navigation would be 1000.
    const grown = heapStats().objectTypeCounts.Object! - objects;
    const msg = `routes leak check: before ${before} B, after ${after} B, delta ${after - before} B, objects ${grown}, subscribers ${m.subs.size}`;
    expect(m.subs.size, msg).toBe(0);
    expect(grown, msg).toBeLessThan(50);
    expect(after - before, msg).toBeLessThan(0.1 * 1024 * 1024);
  } finally {
    delete (document as { baseURI?: string }).baseURI;
    setNavigationForTests(undefined);
  }
});

test("a child whose props read nothing tracked follows the handler that changed them", () => {
  class PlainHost extends Component {
    plain = { name: "a" };
    protected override render(__p: Node): void {
      dom.on(dom.el(__p, "button"), "click", () => (this.plain.name = "b"));
      dom.component(dom.anchor(__p), Kid, () => ({ title: this.plain.name }));
    }
  }
  const el = host();
  mount(PlainHost, el);
  expect(el.querySelector("span")!.textContent).toBe("a:0:-");
  el.querySelector("button")!.click();
  expect(el.querySelector("span")!.textContent).toBe("b:0:-");
});

test("@cascade: what a consumer's hooks read does not re-run the provider", async () => {
  let provided = 0;
  class Own extends Component {
    static cascades = [["theme", "theme"]] as const;
    #own = 0; get own(): number { Component.$reader?.(this, 0); return this.#own; } set own(v: number) { const p = this.#own; if (Component.same(p, v)) return; this.#own = v; this.$changed(0, p); }
    static { Component.$define(this, ["own"]); }
    theme = "";
    seen = 0;
    protected override onParametersSet(): void { this.seen = this.own; }
    protected override shouldRender(): boolean { return this.own >= 0; }
    protected override onAfterRender(): void { void this.own; }
    protected override render(__p: Node): void { dom.text(__p, () => this.theme); }
  }
  class Prov extends Component {
    #theme = "dark"; get theme(): string { Component.$reader?.(this, 0); return this.#theme; } set theme(v: string) { const p = this.#theme; if (Component.same(p, v)) return; this.#theme = v; this.$changed(0, p); }
    static { Component.$define(this, ["theme"]); }
    kid: Own | undefined;
    protected override render(__p: Node): void {
      dom.cascadeAt(dom.anchors(__p), "theme", () => (provided++, this.theme), false, (__p) => dom.component(dom.anchor(__p), Own, () => ({}), undefined, undefined, (c) => (this.kid = c as Own)));
    }
  }
  const el = host();
  const p = mount(Prov, el);
  p.theme = "light";
  await tick();
  expect(el.textContent).toBe("light");
  const runs = provided;
  p.kid!.own = 5;
  await tick();
  expect(provided, `provider runs ${provided - runs} after a consumer's own field changed`).toBe(runs);
});

test("leak check: 1000 builder-based children (NavLink) through the bridge, mounted and removed, leave the heap and the navigation observers as they were", async () => {
  const { heapSize } = await import("bun:jsc");
  Object.defineProperty(document, "baseURI", { configurable: true, get: () => "http://localhost/" });
  const m = memoryNav("/docs/1");
  class Links extends Component {
    #n = 0; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { Component.$define(this, ["n"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        for (let i = 0; i < this.n; i++) dom.component(dom.anchor(__p), NavLink, () => ({ href: `/docs/${i}` }));
      });
    }
  }
  try {
    const el = host();
    const l = mount(Links, el);
    let peak = 0;
    const cycle = async (): Promise<void> => {
      l.n = 1000;
      await tick();
      peak = m.subs.size;
      l.n = 0;
      await tick();
      Bun.gc(true);
      Bun.gc(true);
    };
    for (let i = 0; i < 5; i++) await cycle();
    expect(el.querySelectorAll("a").length).toBe(0);
    const before = heapSize();
    for (let i = 0; i < 5; i++) await cycle();
    const after = heapSize();
    const msg = `bridge leak: before ${before} B, after ${after} B, delta ${after - before} B, observers ${m.subs.size} (peak ${peak})`;
    expect(peak, msg).toBe(1000);
    expect(m.subs.size, msg).toBe(0);
    expect(after - before, msg).toBeLessThan(0.1 * 1024 * 1024);
  } finally {
    delete (document as { baseURI?: string }).baseURI;
    setNavigationForTests(undefined);
  }
});

test("a lazy child that arrived is disposed once when its region closes", async () => {
  let made = 0;
  let disposed = 0;
  class Old extends Component {
    title = "";
    constructor() { super(); made++; }
    protected override dispose(): void { disposed++; }
    protected override render(__p: Node): void {
      dom.t(dom.el(__p, "i"), this.title);
    }
  }
  let arrive!: (m: { default: typeof Old }) => void;
  const Late = lazy(() => new Promise<{ default: typeof Old }>((r) => (arrive = r)));
  class LateHost extends Component {
    #on = true; get on(): boolean { Component.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(0, p); }
    static { Component.$define(this, ["on"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.on) dom.component(dom.anchor(__p), Late, () => ({ title: "t" }));
      });
    }
  }
  const el = host();
  const h = mount(LateHost, el);
  arrive({ default: Old });
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("t");
  expect(made - disposed, `made ${made}, disposed ${disposed}`).toBe(1);
  h.on = false;
  await tick();
  expect(made - disposed, `made ${made}, disposed ${disposed}`).toBe(0);
});

test("a lazy child removed before it arrives is disposed on arrival, and nothing mounts", async () => {
  let made = 0;
  let disposed = 0;
  class Arrives extends Component {
    constructor() { super(); made++; }
    protected override dispose(): void { disposed++; }
    protected override render(__p: Node): void { dom.t(dom.el(__p, "b"), "here"); }
  }
  let arrive!: (m: { default: typeof Arrives }) => void;
  const Late = lazy(() => new Promise<{ default: typeof Arrives }>((r) => (arrive = r)));
  class LateHost extends Component {
    #on = true; get on(): boolean { Component.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (Component.same(p, v)) return; this.#on = v; this.$changed(0, p); }
    static { Component.$define(this, ["on"]); }
    protected override render(__p: Node): void {
      dom.region(__p, (__p) => {
        if (this.on) dom.component(dom.anchor(__p), Late, () => ({}));
      });
    }
  }
  const el = host();
  const h = mount(LateHost, el);
  h.on = false;
  await tick();
  arrive({ default: Arrives });
  await tick();
  expect(el.querySelector("b")).toBeNull();
  expect([made, disposed]).toEqual([1, 1]);
});

test("an onAfterRender that starts a nested pass runs that pass's hooks at once, and the outer queue goes on in order", () => {
  const order: string[] = [];
  const other = mount(class Other extends Component {
    protected override onAfterRender(first: boolean): void { order.push(`other ${first}`); }
    protected override render(__p: Node): void { dom.t(__p, "o"); }
  }, host());
  let selfOnce = true;
  class A extends Component {
    protected override onAfterRender(first: boolean): void {
      order.push(`A ${first}`);
      if (!first) return;
      other.stateHasChanged();
      if (selfOnce) { selfOnce = false; this.stateHasChanged(); }
    }
    protected override render(__p: Node): void { dom.t(__p, "a"); }
  }
  class B extends Component {
    protected override onAfterRender(first: boolean): void { order.push(`B ${first}`); }
    protected override render(__p: Node): void { dom.t(__p, "b"); }
  }
  class Root extends Component {
    protected override onAfterRender(first: boolean): void { order.push(`Root ${first}`); }
    protected override render(__p: Node): void {
      dom.component(dom.anchor(__p), A, () => ({}));
      dom.component(dom.anchor(__p), B, () => ({}));
    }
  }
  order.length = 0;
  const el = host();
  mount(Root, el);
  // The nested pass (`other`, then A's own re-render) completes inside A's hook; B and Root still run after, once each.
  expect(order).toEqual(["A true", "other false", "A false", "B true", "Root true"]);
  expect(el.textContent).toBe("ab");
  order.length = 0;
  other.stateHasChanged();
  expect(order).toEqual(["other false"]);
});

test("a @pause region holding a child component freezes the child while hidden and catches it up when shown", async () => {
  let runs = 0;
  let kid: PKid | undefined;
  class PKid extends Component {
    #v = 0; get v(): number { Component.$reader?.(this, 0); return this.#v; } set v(x: number) { const p = this.#v; if (Component.same(p, x)) return; this.#v = x; this.$changed(0, p); }
    #own = 0; get own(): number { Component.$reader?.(this, 1); return this.#own; } set own(x: number) { const p = this.#own; if (Component.same(p, x)) return; this.#own = x; this.$changed(1, p); }
    static { Component.$define(this, ["v", "own"]); }
    protected override render(__p: Node): void {
      dom.textAt(dom.el(__p, "i").appendChild(document.createTextNode("")), () => (runs++, `${this.v}:${this.own}`));
    }
  }
  class Page extends Component {
    #tab = "a"; get tab(): string { Component.$reader?.(this, 0); return this.#tab; } set tab(v: string) { const p = this.#tab; if (Component.same(p, v)) return; this.#tab = v; this.$changed(0, p); }
    #n = 1; get n(): number { Component.$reader?.(this, 1); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(1, p); }
    static { Component.$define(this, ["tab", "n"]); }
    protected override render(__p: Node): void {
      dom.showAt(dom.anchors(__p), (__p) => {
        if (this.tab === "a") {
          if (!__p) return 0;
          __p.appendChild(document.createElement("u"));
        } else {
          if (!__p) return 1;
          const b = __p.appendChild(document.createElement("section"));
          dom.pauseAt(dom.anchors(b), (__p) => {
            dom.component(dom.anchor(__p), PKid, () => ({ v: this.n }), undefined, undefined, (c) => (kid = c as PKid));
          });
        }
        return 2;
      });
    }
  }
  const el = host();
  const p = mount(Page, el);
  p.tab = "b";
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("1:0");
  p.tab = "a";
  await tick();
  expect(el.querySelector("section")!.style.display).toBe("none");
  const before = runs;
  p.n = 2;
  kid!.own = 5;
  await tick();
  p.n = 3;
  await tick();
  expect(runs).toBe(before);
  expect(el.querySelector("i")!.textContent).toBe("1:0");
  p.tab = "b";
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("3:5");
  // Once from the thaw, once more from the flush the new prop queued meanwhile; never one per missed change.
  expect(runs).toBeLessThanOrEqual(before + 2);
  expect(el.querySelector("section")!.style.display).toBe("");
  p.n = 4;
  await tick();
  expect(el.querySelector("i")!.textContent).toBe("4:5");
});


// A binding that goes loose joins the list of the component it was built in, wherever it is re-run.
class LooseKid extends Component {
  declare slots: { default?: () => Markup };
  protected override render(__p: Node): void {
    dom.slotAt(dom.anchors(__p), () => this.slots.default);
  }
}
class LooseHost extends Component {
  #t = "t"; get t(): string { Component.$reader?.(this, 0); return this.#t; } set t(v: string) { const p = this.#t; if (Component.same(p, v)) return; this.#t = v; this.$changed(0, p); }
  static { Component.$define(this, ["t"]); }
  mode = true;
  plain = "p";
  protected override render(__p: Node): void {
    // The child binding reads tracked state, so it is not what refreshes the slot content after a handler.
    dom.component(dom.anchor(__p), LooseKid, () => ({ x: this.t }), undefined, {
      default: () => Component.fragment((__p) => dom.text(dom.el(__p, "b"), () => (this.mode ? this.t : this.plain)), this),
    });
    const button = dom.el(__p, "button");
    dom.on(button, "click", () => (this.plain = "z"));
  }
}

test("slot content that goes loose in the child's pass is refreshed after the parent's handlers", () => {
  const el = host();
  const h = mount(LooseHost, el);
  expect(el.querySelector("b")!.textContent).toBe("t");
  h.mode = false;
  h.stateHasChanged();
  expect(el.querySelector("b")!.textContent).toBe("p");
  el.querySelector("button")!.click();
  expect(el.querySelector("b")!.textContent).toBe("z");
});

class QueuedLoose extends Component {
  #t = 1; get t(): number { Component.$reader?.(this, 0); return this.#t; } set t(v: number) { const p = this.#t; if (Component.same(p, v)) return; this.#t = v; this.$changed(0, p); }
  static { Component.$define(this, ["t"]); }
  flag = true;
  plain = "p";
  protected override render(__p: Node): void {
    dom.text(dom.el(__p, "b"), () => (this.flag ? this.t : this.plain));
    dom.on(dom.el(__p, "button"), "click", () => (this.plain = "z"));
  }
}

test("a binding that goes loose in a queued flush is refreshed after its component's next handler", async () => {
  const el = host();
  const c = mount(QueuedLoose, el);
  expect(el.querySelector("b")!.textContent).toBe("1");
  c.flag = false;
  c.t = 2;
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("p");
  el.querySelector("button")!.click();
  expect(el.querySelector("b")!.textContent).toBe("z");
});
