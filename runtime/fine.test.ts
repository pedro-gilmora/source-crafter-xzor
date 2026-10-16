import { expect, test } from "bun:test";
import { ComponentBase, mount, type RenderTreeBuilder } from "./index";
import { EntitySet, FineComponent, Model, fine } from "./model";

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
