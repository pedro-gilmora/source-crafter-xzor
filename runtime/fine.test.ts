import { expect, test } from "bun:test";
import { ComponentBase, mount, type RenderTreeBuilder } from "./index";
import { EntitySet, FineComponent, Key, Model, fine } from "./model";

// Models and fine components are written the way the bundle and codegen emit them.

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

class Counter extends FineComponent {
  #count = 0; get count(): number { FineComponent.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (FineComponent.same(p, v)) return; this.#count = v; this.$changed(0, p); }
  #label = "n"; get label(): string { FineComponent.$reader?.(this, 1); return this.#label; } set label(v: string) { const p = this.#label; if (FineComponent.same(p, v)) return; this.#label = v; this.$changed(1, p); }
  untracked = 0;
  static { FineComponent.$define(this, ["count", "label"]); }

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    renders++;
    __b.addFine((__p) => {
      const _button0 = fine.el(__p, "button");
      _button0.addEventListener("click", () => this.count++);
      fine.attr(_button0, "title", () => `${this.label}${this.count}`);
      fine.text(_button0, () => this.count);
      fine.t(__p, " ");
      fine.text(__p, () => this.untracked);
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

class Bar extends FineComponent {
  #count = 0; get count(): number { FineComponent.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (FineComponent.same(p, v)) return; this.#count = v; this.$changed(0, p); }
  static { FineComponent.$define(this, ["count"]); }

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
      const _div0 = fine.el(__p, "div");
      fine.attr(_div0, "--w", () => this.count * 10 + "%");
      fine.attr(_div0, "--on", () => this.count > 1 || null);
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

class Sheet extends FineComponent {
  #team = new EntitySet<Worker>(); get team(): EntitySet<Worker> { FineComponent.$reader?.(this, 0); return this.#team; } set team(v: EntitySet<Worker>) { const p = this.#team; if (FineComponent.same(p, v)) return; this.#team = v; this.$changed(0, p); }
  static { FineComponent.$define(this, ["team"]); }

  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
      const _ul0 = fine.el(__p, "ul");
      fine.list(_ul0, () => this.team.view, (__p, worker: Worker) => {
        const _li0 = fine.el(__p, "li");
        const _input0 = fine.el(_li0, "input");
        fine.attr(_input0, "value", () => worker.hours);
        _input0.addEventListener("input", (__e) => (worker.hours = Number((__e.target as HTMLInputElement).value)));
        const _span0 = fine.el(_li0, "span");
        fine.text(_span0, () => worker.payment.toFixed(2));
        fine.region(_li0, (__p) => {
          if (worker.hours > 24) fine.t(fine.el(__p, "small"), "too many");
        });
      });
      const _b0 = fine.el(__p, "b");
      fine.text(_b0, () => this.team.view.reduce((sum, w) => sum + w.payment, 0));
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
  class Child extends ComponentBase {
    label = "";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      childRenders++;
      b.openElement("em");
      b.addContent(this.label);
      b.closeElement();
    }
  }
  class Parent extends FineComponent {
    #name = "a"; get name(): string { FineComponent.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (FineComponent.same(p, v)) return; this.#name = v; this.$changed(0, p); }
    #other = 0; get other(): number { FineComponent.$reader?.(this, 1); return this.#other; } set other(v: number) { const p = this.#other; if (FineComponent.same(p, v)) return; this.#other = v; this.$changed(1, p); }
    static { FineComponent.$define(this, ["name", "other"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.text(fine.el(__p, "b"), () => this.other);
        fine.island(__p, (__b) => __b.addComponent(Child, { label: this.name }));
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
  class Card extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("section");
      b.addContent((this.slots as { default?: () => unknown }).default?.() ?? null);
      b.closeElement();
    }
  }
  class Page extends FineComponent {
    #name = "a"; get name(): string { FineComponent.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (FineComponent.same(p, v)) return; this.#name = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["name"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => fine.island(__p, (__b) => __b.addComponent(Card, {}, { default: () => ComponentBase.fragment((__b) => { __b.openElement("i"); __b.addContent(this.name); __b.closeElement(); }) } as never)));
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
  class Btn extends ComponentBase {
    onPick?: (n: number) => unknown;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("button");
      b.addEventHandler("click", () => this.onPick?.(7));
      b.closeElement();
    }
  }
  let renders = 0;
  class Page extends FineComponent {
    #picked = 0; get picked(): number { FineComponent.$reader?.(this, 0); return this.#picked; } set picked(v: number) { const p = this.#picked; if (FineComponent.same(p, v)) return; this.#picked = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["picked"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      renders++;
      __b.addFine((__p) => {
        fine.island(__p, (__b) => __b.addComponent(Btn, { onPick: __b.callback((n: number) => (this.picked = n)) }));
        fine.text(fine.el(__p, "b"), () => this.picked);
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
  class Page extends FineComponent {
    #n = 1; get n(): number { FineComponent.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (FineComponent.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["n"]); }
    summary = ComponentBase.fragment((__b) => { __b.openElement("u"); __b.addContent(this.n); __b.closeElement(); });
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => fine.text(fine.el(__p, "div"), () => this.summary));
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
  class Page extends FineComponent {
    #count = 0; get count(): number { FineComponent.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (FineComponent.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["count"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const _e0 = fine.el(__p, "button");
        fine.on(_e0, "click", () => {
          work.changes++;
          this.count++;
        });
        fine.text(fine.el(__p, "i"), () => work.changes);
        fine.text(fine.el(__p, "b"), () => (tracked++, this.count));
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
  class Flags extends FineComponent {
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => fine.text(__p, () => `${set.hasChanges}/${set.hasErrors}`));
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
  class Parent extends FineComponent {
    #show = true; get show(): boolean { FineComponent.$reader?.(this, 0); return this.#show; } set show(v: boolean) { const p = this.#show; if (FineComponent.same(p, v)) return; this.#show = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["show"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => fine.region(__p, (__p) => {
        if (this.show) fine.text(fine.el(__p, "p"), () => worker.hours);
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
  const __t0 = fine.template([null, null]);
  const __t1 = fine.template([["dialog", 0, ["input", 0], null, null, ["ul", 0, null]]]);
  const __t2 = fine.template([["p", 0, "long"]]);
  const __t3 = fine.template([["li", 0, ""]]);
  let outer = 0;
  class Page extends FineComponent {
    #open = true; get open(): boolean { FineComponent.$reader?.(this, 0); return this.#open; } set open(v: boolean) { const p = this.#open; if (FineComponent.same(p, v)) return; this.#open = v; this.$changed(0, p); }
    #items = ["a", "b"]; get items(): string[] { FineComponent.$reader?.(this, 1); return this.#items; } set items(v: string[]) { const p = this.#items; if (FineComponent.same(p, v)) return; this.#items = v; this.$changed(1, p); }
    #text = ""; get text(): string { FineComponent.$reader?.(this, 2); return this.#text; } set text(v: string) { const p = this.#text; if (FineComponent.same(p, v)) return; this.#text = v; this.$changed(2, p); }
    static { FineComponent.$define(this, ["open", "items", "text"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const _e0 = __t0();
        fine.regionAt(_e0.firstChild!.nextSibling! as Comment, (__p) => {
          outer++;
          if (this.open) {
            const _e2 = __t1() as HTMLDialogElement;
            const _e3 = _e2.firstChild! as HTMLInputElement;
            const _e4 = _e3.nextSibling!.nextSibling! as Comment;
            const _e5 = _e4.nextSibling! as HTMLUListElement;
            fine.attr(_e3, "value", () => this.text);
            fine.regionAt(_e4, (__p) => {
              if (this.text.length > 2) __p.appendChild(__t2());
            });
            fine.listAt(_e5.firstChild! as Comment, () => this.items, [(it: string) => it], (__p) => {
              const _e8 = __t3() as HTMLLIElement;
              fine.textItem(_e8.firstChild! as Text, 0);
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
  class Page extends FineComponent {
    #items: string[] = []; get items(): string[] { FineComponent.$reader?.(this, 0); return this.#items; } set items(v: string[]) { const p = this.#items; if (FineComponent.same(p, v)) return; this.#items = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["items"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const ul = fine.el(__p, "ul");
        const end = ul.appendChild(document.createComment(""));
        fine.listAt(end, () => this.items, [(it: string) => it], (__p) => {
          const li = __p.appendChild(document.createElement("li"));
          fine.textItem(li.appendChild(document.createTextNode("")), 0);
        }, (__p) => {
          fine.textAt(__p.appendChild(document.createElement("p")).appendChild(document.createTextNode("")), () => `none ${this.items.length}`);
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
  class Stock extends FineComponent {
    #n = 0; get n(): number { FineComponent.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (FineComponent.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["n"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const span = fine.el(__p, "span");
        span.setAttribute("class", "cell");
        span.setAttribute("title", "stock");
        fine.region(span, (__p) => {
          if (this.n > 0) fine.text(__p, () => this.n);
          else {
            fine.attrOf(span, "class", () => "error-text cell");
            fine.attrOf(span, "title", () => `none ${this.n}`);
            fine.t(__p, "Agotado");
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
  class Page extends FineComponent {
    #team: Record<string, number> = { a: 1, b: 2, c: 3 }; get team(): Record<string, number> { FineComponent.$reader?.(this, 0); return this.#team; } set team(v: Record<string, number>) { const p = this.#team; if (FineComponent.same(p, v)) return; this.#team = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["team"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const ul = fine.el(__p, "ul");
        fine.keyedAt(ul.appendChild(document.createComment("")), (__pass) => {
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
  class Page extends FineComponent {
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.keyedAt(__p.appendChild(document.createComment("")), (__pass) => {
          for (const x of [1, 2, 1]) __pass(x, [x]);
        });
      });
    }
  }
  expect(() => mount(Page, host())).toThrow("xzor: duplicate @key 1");
});

test("a list keyed by a function keeps a row whose item is replaced by one with the same key", async () => {
  type Row = { id: number; name: string };
  class Page extends FineComponent {
    #rows: Row[] = [{ id: 1, name: "a" }, { id: 2, name: "b" }]; get rows(): Row[] { FineComponent.$reader?.(this, 0); return this.#rows; } set rows(v: Row[]) { const p = this.#rows; if (FineComponent.same(p, v)) return; this.#rows = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["rows"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const ul = fine.el(__p, "ul");
        fine.listAt(ul.appendChild(document.createComment("")), () => this.rows, [(r: Row) => r.name], (__p) => {
          fine.textItem(__p.appendChild(document.createElement("li")).appendChild(document.createTextNode("")), 0);
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
  // Same key, another object: its row is rebuilt in place; the other row only moved.
  expect(after[0]).toBe(second!);
  expect(after[1]).not.toBe(first!);
});

test("a list of models matches rows by the model's @Key", async () => {
  class Item extends Model { constructor(data?: object) { super(data); this.assign(data); }
    #id = 0; @Key get id(): number { Model.$reader?.(this, 0); return this.#id; } set id(v: number) { const p = this.#id; if (Model.same(p, v)) return; this.#id = v; this.$changed(0, p); }
  static { Model.$define(this, ["id"]); } }
  class Page extends FineComponent {
    #items: Item[] = [new Item({ id: 1 }), new Item({ id: 2 })]; get items(): Item[] { FineComponent.$reader?.(this, 0); return this.#items; } set items(v: Item[]) { const p = this.#items; if (FineComponent.same(p, v)) return; this.#items = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["items"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.listAt(__p.appendChild(document.createComment("")), () => this.items, [], (__p, it: Item) => {
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
  class Page extends FineComponent {
    #count = 0; get count(): number { FineComponent.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (FineComponent.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["count"]); }
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
        fine.text(fine.el(__p, "b"), () => this.count);
        fine.text(fine.el(__p, "i"), () => outside.n);
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
  class Page extends FineComponent {
    #n = 1; get n(): number { FineComponent.$reader?.(this, 0); return this.#n; } set n(v: number) { const p = this.#n; if (FineComponent.same(p, v)) return; this.#n = v; this.$changed(0, p); }
    #show = true; get show(): boolean { FineComponent.$reader?.(this, 1); return this.#show; } set show(v: boolean) { const p = this.#show; if (FineComponent.same(p, v)) return; this.#show = v; this.$changed(1, p); }
    static { FineComponent.$define(this, ["n", "show"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const t = __p.appendChild(document.createTextNode(""));
        fine.textOnce(t, () => this.n);
        fine.region(__p, (__p) => {
          if (this.show) {
            fine.onceAt(__p.appendChild(document.createComment("")), (__p) => {
              const b = __p.appendChild(document.createElement("b"));
              fine.set(b, "title", this.n);
              fine.setText(b.appendChild(document.createTextNode("")), this.n);
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
  class Page extends FineComponent {
    #a = 1; get a(): number { FineComponent.$reader?.(this, 0); return this.#a; } set a(v: number) { const p = this.#a; if (FineComponent.same(p, v)) return; this.#a = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["a"]); }
    get total(): number {
      runs++;
      return this.a * 10;
    }
    get loose(): number {
      return outside.n;
    }
    static { fine.memo(this, ["total", "loose"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.text(fine.el(__p, "b"), () => this.total);
        fine.text(fine.el(__p, "i"), () => this.total + 1);
        fine.text(fine.el(__p, "u"), () => `${this.total}/${this.loose}`);
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
  class Page extends FineComponent {
    #a = 1; get a(): number { FineComponent.$reader?.(this, 0); return this.#a; } set a(v: number) { const p = this.#a; if (FineComponent.same(p, v)) return; this.#a = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["a"]); }
    get total(): number {
      runs++;
      return this.a * 10;
    }
    static { fine.memo(this, ["total"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.text(fine.el(__p, "b"), () => this.total);
      });
    }
  }
  const memos = (o: object) => Object.getOwnPropertySymbols(o).filter((s) => s.description === "xzor.fine.memos").length;
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

test("@await: pending, then the value; a newer promise wins; what then reads re-renders it without a new request", async () => {
  const gates: ((v: string[]) => void)[] = [];
  let requests = 0;
  class Page extends FineComponent {
    #q = "a"; get q(): string { FineComponent.$reader?.(this, 0); return this.#q; } set q(v: string) { const p = this.#q; if (FineComponent.same(p, v)) return; this.#q = v; this.$changed(0, p); }
    #suffix = "!"; get suffix(): string { FineComponent.$reader?.(this, 1); return this.#suffix; } set suffix(v: string) { const p = this.#suffix; if (FineComponent.same(p, v)) return; this.#suffix = v; this.$changed(1, p); }
    static { FineComponent.$define(this, ["q", "suffix"]); }
    load(q: string): Promise<string[]> {
      requests++;
      return new Promise((r) => gates.push(() => r([q])));
    }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const end = fine.anchors(__p);
        fine.awaitAt(end, () => this.load(this.q), (__p) => {
          __p.appendChild(document.createTextNode("wait"));
        }, (__p, rows) => {
          fine.text(__p, () => rows.join() + this.suffix);
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
  class Page extends FineComponent {
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.awaitAt(fine.anchors(__p), () => Promise.reject(new Error("no")), undefined, undefined, (__p, e) => {
          __p.appendChild(document.createTextNode(String((e as Error).message)));
        });
        fine.awaitAt(fine.anchors(__p), () => 5, undefined, (__p, n) => {
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
  class Page extends FineComponent {
    #count = 3; get count(): number { FineComponent.$reader?.(this, 0); return this.#count; } set count(v: number) { const p = this.#count; if (FineComponent.same(p, v)) return; this.#count = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["count"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const end = fine.anchors(__p);
        fine.branchAt(end, (__p) => {
          if (!this.count) {
            if (!__p) return 0;
            __p.appendChild(document.createElement("p")).textContent = "none";
          } else {
            if (!__p) return 1;
            fine.textAt(__p.appendChild(document.createElement("ul")).appendChild(document.createTextNode("")), () => this.count);
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

test("a data-leave element removed by its region stays, data-leaving, until its animations finish", async () => {
  ComponentBase.$leaves = true;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  class Page extends FineComponent {
    #open = true; get open(): boolean { FineComponent.$reader?.(this, 0); return this.#open; } set open(v: boolean) { const p = this.#open; if (FineComponent.same(p, v)) return; this.#open = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["open"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        fine.region(__p, (__p) => {
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
  class Page extends FineComponent {
    #err = ""; get err(): string { FineComponent.$reader?.(this, 0); return this.#err; } set err(v: string) { const p = this.#err; if (FineComponent.same(p, v)) return; this.#err = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["err"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const d = fine.el(__p, "div");
        d.setAttribute("class", "field");
        fine.attr(d, "class:invalid", () => this.err);
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
  class Page extends FineComponent {
    #on = false; get on(): boolean { FineComponent.$reader?.(this, 0); return this.#on; } set on(v: boolean) { const p = this.#on; if (FineComponent.same(p, v)) return; this.#on = v; this.$changed(0, p); }
    static { FineComponent.$define(this, ["on"]); }
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => {
        const b = fine.el(__p, "button");
        fine.attr(b, "aria-pressed", () => this.on);
        fine.attr(b, "disabled", () => this.on);
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
  class One extends FineComponent {
    protected override buildRenderTree(__b: RenderTreeBuilder): void {
      __b.addFine((__p) => fine.text(fine.el(__p, "i"), () => worker.hours));
    }
  }
  class Parent extends ComponentBase {
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
const __row = fine.template([["li", ["class", "row"], ["input", 0], ["span", 0, ""], null, null, ["button", 0, "x"]]]);
const __ul = fine.template([["ul", 0, null], ["p", 0, ""]]);
let picked: Worker[] = [];
class Rows extends FineComponent {
  #team = new EntitySet<Worker>(); get team(): EntitySet<Worker> { FineComponent.$reader?.(this, 0); return this.#team; } set team(v: EntitySet<Worker>) { const p = this.#team; if (FineComponent.same(p, v)) return; this.#team = v; this.$changed(0, p); }
  static { FineComponent.$define(this, ["team"]); }
  outer = 0;
  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addFine((__p) => {
      const _e0 = __ul() as Node;
      const _e1 = _e0.firstChild! as HTMLElement;
      const _e2 = _e1.firstChild! as Comment;
      const _e3 = _e1.nextSibling!.firstChild! as Text;
      fine.on(_e1, "click", () => this.outer++);
      fine.listAt(_e2, () => this.team.view, [
        (w) => w.hours,
        (w) => (__e: Event) => { w.hours = ComponentBase.bindValue(__e, w.hours); },
        (w) => w.payment.toFixed(2),
        (w, __p) => {
          if (w.hours > 24) fine.t(fine.el(__p, "small"), "too many");
        },
        (w) => (__e: Event) => { picked.push(w); __e.stopPropagation(); },
      ], (__p) => {
        const _e4 = __row() as HTMLLIElement;
        const _e5 = _e4.firstChild! as HTMLInputElement;
        const _e6 = _e5.nextSibling!.firstChild! as Text;
        const _e7 = _e5.nextSibling!.nextSibling!.nextSibling! as Comment;
        const _e8 = _e7.nextSibling! as HTMLButtonElement;
        fine.attrItem(_e5, "value", 0);
        fine.onItem(_e5, "input", 1);
        fine.textItem(_e6, 2);
        fine.regionItem(_e7, 3);
        fine.onItem(_e8, "click", 4);
        __p.appendChild(_e4);
      });
      fine.textAt(_e3, () => this.team.view.length);
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
  const icon = fine.template([["svg", ["viewBox", "0 0 24 24"], ["path", ["d", "M0 0"]]], ["p", 0, "x"]]);
  const frag = icon() as DocumentFragment;
  const svg = frag.firstChild as Element;
  expect(svg.namespaceURI).toBe(SVG);
  expect((svg.firstChild as Element).namespaceURI).toBe(SVG);
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect((frag.lastChild as Element).namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  const parent = document.createElementNS(SVG, "svg");
  expect(fine.el(parent, "path").namespaceURI).toBe(SVG);
});
