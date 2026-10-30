import { expect, test } from "bun:test";
import { Component, dom, mount, type RenderTreeBuilder } from "./index";
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

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    renders++;
    __b.addFine((__p) => {
      const _button0 = dom.el(__p, "button");
      _button0.addEventListener("click", () => this.count++);
      dom.attr(_button0, "title", () => `${this.label}${this.count}`);
      dom.text(_button0, () => this.count);
      dom.t(__p, " ");
      dom.text(__p, () => this.untracked);
    });
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

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
      const _div0 = dom.el(__p, "div");
      dom.attr(_div0, "--w", () => this.count * 10 + "%");
      dom.attr(_div0, "--on", () => this.count > 1 || null);
    });
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

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
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
    });
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

test("islands: child components get their parameters, and re-render only when what they read changes", async () => {
  let childRenders = 0;
  class Child extends Component {
    label = "";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      childRenders++;
      b.openElement("em");
      b.addContent(this.label);
      b.closeElement();
    }
  }
  class Parent extends Component {
    #name = "a"; get name(): string { Component.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (Component.same(p, v)) return; this.#name = v; this.$changed(0, p); }
    #other = 0; get other(): number { Component.$reader?.(this, 1); return this.#other; } set other(v: number) { const p = this.#other; if (Component.same(p, v)) return; this.#other = v; this.$changed(1, p); }
    static { Component.$define(this, ["name", "other"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.text(dom.el(__p, "b"), () => this.other);
        dom.island(__p, (__b) => __b.addComponent(Child, { label: this.name }));
      });
    }
  }
  const el = host();
  const p = mount(Parent, el);
  expect(el.querySelector("em")!.textContent).toBe("a");
  p.other = 1;
  await tick();
  expect(childRenders).toBe(1);
  p.name = "b";
  await tick();
  expect(el.querySelector("em")!.textContent).toBe("b");
  expect(childRenders).toBe(2);
});

test("islands: slot content reading the fine parent re-renders the child that shows it", async () => {
  class Card extends Component {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("section");
      b.addContent((this.slots as { default?: () => unknown }).default?.() ?? null);
      b.closeElement();
    }
  }
  class Page extends Component {
    #name = "a"; get name(): string { Component.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (Component.same(p, v)) return; this.#name = v; this.$changed(0, p); }
    static { Component.$define(this, ["name"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => dom.island(__p, (__b) => __b.addComponent(Card, {}, { default: () => Component.fragment((__b) => { __b.openElement("i"); __b.addContent(this.name); __b.closeElement(); }) } as never)));
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.querySelector("section i")!.textContent).toBe("a");
  p.name = "b";
  await tick();
  expect(el.querySelector("section i")!.textContent).toBe("b");
});

test("islands: a callback from a child updates the fine parent through its tracked field", async () => {
  class Btn extends Component {
    onPick?: (n: number) => unknown;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("button");
      b.addEventHandler("click", () => this.onPick?.(7));
      b.closeElement();
    }
  }
  let renders = 0;
  class Page extends Component {
    #picked = 0; get picked(): number { Component.$reader?.(this, 0); return this.#picked; } set picked(v: number) { const p = this.#picked; if (Component.same(p, v)) return; this.#picked = v; this.$changed(0, p); }
    static { Component.$define(this, ["picked"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      renders++;
      __b.addFine((__p) => {
        dom.island(__p, (__b) => __b.addComponent(Btn, { onPick: __b.callback((n: number) => (this.picked = n)) }));
        dom.text(dom.el(__p, "b"), () => this.picked);
      });
    }
  }
  const el = host();
  mount(Page, el);
  el.querySelector("button")!.click();
  await tick();
  expect(el.querySelector("b")!.textContent).toBe("7");
  expect(renders).toBe(1);
});

test("a markup value in @expr renders as markup and follows what it reads", async () => {
  class Page extends Component {
    #n = 1; get n(): number { Component.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (Component.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { Component.$define(this, ["n"]); }
    summary = Component.fragment((__b) => { __b.openElement("u"); __b.addContent(this.n); __b.closeElement(); });
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => dom.text(dom.el(__p, "div"), () => this.summary));
    }
  }
  const el = host();
  const p = mount(Page, el);
  expect(el.querySelector("div u")!.textContent).toBe("1");
  p.n = 2;
  await tick();
  expect(el.querySelector("div u")!.textContent).toBe("2");
});

test("after its own handler, a fine component re-runs the bindings that read nothing tracked", async () => {
  const work = { changes: 0 };
  let tracked = 0;
  class Page extends Component {
    #count = 0; get count(): number { Component.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (Component.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { Component.$define(this, ["count"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const _e0 = dom.el(__p, "button");
        dom.on(_e0, "click", () => {
          work.changes++;
          this.count++;
        });
        dom.text(dom.el(__p, "i"), () => work.changes);
        dom.text(dom.el(__p, "b"), () => (tracked++, this.count));
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => dom.text(__p, () => `${set.hasChanges}/${set.hasErrors}`));
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => dom.region(__p, (__p) => {
        if (this.show) dom.text(dom.el(__p, "p"), () => worker.hours);
      }));
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const ul = dom.el(__p, "ul");
        const end = ul.appendChild(document.createComment(""));
        dom.listAt(end, () => this.items, [(it: string) => it], (__p) => {
          const li = __p.appendChild(document.createElement("li"));
          dom.textItem(li.appendChild(document.createTextNode("")), 0);
        }, (__p) => {
          dom.textAt(__p.appendChild(document.createElement("p")).appendChild(document.createTextNode("")), () => `none ${this.items.length}`);
        });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.keyedAt(__p.appendChild(document.createComment("")), (__pass) => {
          for (const x of [1, 2, 1]) __pass(x, [x]);
        });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const ul = dom.el(__p, "ul");
        dom.listAt(ul.appendChild(document.createComment("")), () => this.rows, [(r: Row) => r.name], (__p) => {
          dom.textItem(__p.appendChild(document.createElement("li")).appendChild(document.createTextNode("")), 0);
        }, undefined, (r) => r.id);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.listAt(__p.appendChild(document.createComment("")), () => this.items, [], (__p, it: Item) => {
          __p.appendChild(document.createElement("li")).textContent = String(it.id);
        });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.text(dom.el(__p, "b"), () => this.count);
        dom.text(dom.el(__p, "i"), () => outside.n);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.text(dom.el(__p, "b"), () => this.total);
        dom.text(dom.el(__p, "i"), () => this.total + 1);
        dom.text(dom.el(__p, "u"), () => `${this.total}/${this.loose}`);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.text(dom.el(__p, "b"), () => this.total);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const end = dom.anchors(__p);
        dom.awaitCallAt(end, () => [this.key], (__a0) => this.load(__a0), undefined, (__p, v) => {
          dom.textAt(__p.appendChild(document.createTextNode("")), () => v);
        }, undefined);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const end = dom.anchors(__p);
        dom.awaitAt(end, () => this.load(this.q), (__p) => {
          __p.appendChild(document.createTextNode("wait"));
        }, (__p, rows) => {
          dom.text(__p, () => rows.join() + this.suffix);
        }, undefined);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.awaitAt(dom.anchors(__p), () => Promise.reject(new Error("no")), undefined, undefined, (__p, e) => {
          __p.appendChild(document.createTextNode(String((e as Error).message)));
        });
        dom.awaitAt(dom.anchors(__p), () => 5, undefined, (__p, n) => {
          __p.appendChild(document.createTextNode(String(n + 1)));
        }, undefined);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
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
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.listAt(dom.anchors(__p), () => this.items, [(r: Row) => r.name], (__p) => {
          dom.textItem(__p.appendChild(document.createElement("li")).appendChild(document.createTextNode("")), 0);
        }, undefined, (r: Row) => r.id);
      });
    }
  }
  const p = mount(Page, host());
  const loose = (): unknown[] => (p as unknown as Record<symbol, { loose: unknown[] }>)[Object.getOwnPropertySymbols(p).find((s) => s.description === "xzor.fine")!]!.loose;
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
    person!: Person;
    protected override onInitialized(): void {
      inits++;
      children.push(this);
    }
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("em");
      b.addContent(this.person.name);
      b.closeElement();
    }
  }
  class Page extends Component {
    #people: Person[] = [{ id: 1, name: "Ana", roles: ["a"] }, { id: 2, name: "Luis", roles: [] }]; get people(): Person[] { Component.$reader?.(this, 0); return this.#people; } set people(v: Person[]) { const p = this.#people; if (Component.same(p, v)) return; this.#people = v; this.$changed(0, p); }
    static { Component.$define(this, ["people"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.listAt(dom.anchors(__p), () => this.people, [], (__p, p: Person) => {
          dom.rowItem((__v: typeof p) => { p = __v; });
          const li = __p.appendChild(document.createElement("li"));
          dom.listAt(dom.anchors(li), () => ROLES, [(r: string) => (p.roles.includes(r) ? r : "-")], (__p) => {
            dom.textItem(__p.appendChild(document.createElement("b")).appendChild(document.createTextNode("")), 0);
          }, undefined, (r: string) => r);
          dom.islandAt(dom.anchor(li), (__b) => __b.addComponent(Card, { person: p }));
        }, undefined, (p: Person) => p.id);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        dom.region(__p, (__p) => {
          if (this.open) {
            const d = __p.appendChild(document.createElement("dialog"));
            d.setAttribute("data-leave", "");
            (d as unknown as { getAnimations(): unknown[] }).getAnimations = () => (d.hasAttribute("data-leaving") ? [{ finished }] : []);
          } else __p.appendChild(document.createElement("p"));
        });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const d = dom.el(__p, "div");
        d.setAttribute("class", "field");
        dom.attr(d, "class:invalid", () => this.err);
      });
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
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const b = dom.el(__p, "button");
        dom.attr(b, "aria-pressed", () => this.on);
        dom.attr(b, "disabled", () => this.on);
      });
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

test("a fine child removed by a vdom parent stops writing", async () => {
  const el = host();
  const worker = new Worker({ name: "a", hours: 1, tax: 0 });
  class One extends Component {
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => dom.text(dom.el(__p, "i"), () => worker.hours));
    }
  }
  class Parent extends Component {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(One, {});
      b.closeRegion();
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
  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
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
    });
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
