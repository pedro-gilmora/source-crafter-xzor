import { beforeEach, expect, spyOn, test } from "bun:test";
import { ComponentBase, type RenderTreeBuilder, mount } from "./index";
import { EntitySet, Model, ModelChangeEvent, Persist } from "./model";

// Models are written the way the bundle rewrites them (Task 2), components the way codegen emits them.

class Row extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #label = ""; get label(): string { Model.$reader?.(this, 0); return this.#label; } set label(v: string) { const p = this.#label; if (Model.same(p, v)) return; this.#label = v; this.$changed(0, p); }
  #hours = 0; get hours(): number { Model.$reader?.(this, 1); return this.#hours; } set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(1, p); }
  #tax = 0; get tax(): number { Model.$reader?.(this, 2); return this.#tax; } set tax(v: number) { const p = this.#tax; if (Model.same(p, v)) return; this.#tax = v; this.$changed(2, p); }
  #note = ""; get note(): string { Model.$reader?.(this, 3); return this.#note; } set note(v: string) { const p = this.#note; if (Model.same(p, v)) return; this.#note = v; this.$changed(3, p); }

  @Persist get payment(): number {
    return this.hours * this.tax;
  }
static { Model.$define(this, ["label", "hours", "tax", "note"]); } }

class Sheet extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #rows = new EntitySet<Row>(); get rows(): EntitySet<Row> { Model.$reader?.(this, 0); return this.#rows; } set rows(v: EntitySet<Row>) { const p = this.#rows; if (Model.same(p, v)) return; this.#rows = v; this.$changed(0, p); }
static { Model.$define(this, ["rows"]); } }

let row: Row;
let sheet: Sheet;
let host: HTMLElement;
let views: RowView[];
let labels: Label[];
let leaf: Leaf | undefined;

class RowView extends ComponentBase {
  row!: Row;
  count = 0;
  constructor() {
    super();
    views.push(this);
  }

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.openElement("li");
    b.addContent(this.row.label);
    b.closeElement();
  }
}

class Grid extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.openElement("ul");
    b.openRegion();
    for (const r of sheet.rows) b.addComponent(RowView, { row: r }, undefined, { key: r });
    b.closeRegion();
    b.closeElement();
  }
}

class Label extends ComponentBase {
  count = 0;
  constructor() {
    super();
    labels.push(this);
  }

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.label);
  }
}

class Pair extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addComponent(Label, {});
    b.addComponent(Label, {});
  }
}

class Summary extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(`${row.label} ${row.hours} ${row.tax}`);
  }
}

class Pay extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.payment);
  }
}

class Toggle extends ComponentBase {
  count = 0;
  show = true;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.openRegion();
    if (this.show) b.addContent(row.label);
    b.closeRegion();
  }
}

class Leaf extends ComponentBase {
  count = 0;
  constructor() {
    super();
    leaf = this;
  }

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.label);
  }
}

class Shell extends ComponentBase {
  count = 0;
  show = true;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.openRegion();
    if (this.show) b.addComponent(Leaf, {});
    b.closeRegion();
  }
}

class Editor extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.openElement("button");
    b.addEventHandler("click", () => void row.hours++);
    b.addContent(row.hours);
    b.closeElement();
  }
}

// Queued after the flush that a change schedules.
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function show<C extends ComponentBase>(type: new () => C): C {
  host = document.createElement("main");
  document.body.replaceChildren(host);
  return mount(type, host);
}

beforeEach(() => {
  document.body.replaceChildren();
  row = new Row({ label: "a", hours: 2, tax: 3 });
  sheet = new Sheet();
  views = [];
  labels = [];
  leaf = undefined;
});

test("a change to one row of a thousand re-renders only that row", async () => {
  for (let i = 0; i < 1000; i++) sheet.rows.push(new Row({ label: `r${i}` }));
  const grid = show(Grid);
  expect(views.length).toBe(1000);
  const before = views.map((v) => v.count);
  sheet.rows[7]!.label = "edited";
  await tick();
  expect(views[7]!.count).toBe(before[7]! + 1);
  expect(views.reduce((total, v, i) => total + v.count - before[i]!, 0)).toBe(1);
  expect(grid.count).toBe(1);
  expect(host.querySelectorAll("li")[7]!.textContent).toBe("edited");
});

test("a change from outside a handler re-renders every component showing it, once each", async () => {
  const pair = show(Pair);
  expect(labels.map((l) => l.count)).toEqual([1, 1]);
  row.label = "b";
  await tick();
  expect(labels.map((l) => l.count)).toEqual([2, 2]);
  expect(pair.count).toBe(1);
});

test("many changes in one tick render once", async () => {
  const summary = show(Summary);
  row.label = "b";
  row.hours = 9;
  row.tax = 4;
  await tick();
  expect(summary.count).toBe(2);
});

test("a change that arrives after an unrelated re-render still renders", async () => {
  const summary = show(Summary);
  row.label = "b";
  summary.stateHasChanged();
  expect(summary.count).toBe(2);
  row.hours = 9;
  await tick();
  expect(summary.count).toBe(3);
});

test("a persisted getter re-renders its components when a field it reads changes", async () => {
  const pay = show(Pay);
  expect(host.textContent).toBe("6");
  row.tax = 7;
  await tick();
  expect(pay.count).toBe(2);
  expect(host.textContent).toBe("14");
});

test("a change to a property no component read renders nothing", async () => {
  const pay = show(Pay);
  row.note = "x";
  await tick();
  expect(pay.count).toBe(1);
});

test("a component that stops showing a model stops re-rendering on its changes", async () => {
  const forget = spyOn(row, "removeEventListener");
  const toggle = show(Toggle);
  toggle.show = false;
  toggle.stateHasChanged();
  expect(toggle.count).toBe(2);
  expect(forget).toHaveBeenCalledTimes(1);
  row.label = "b";
  await tick();
  expect(toggle.count).toBe(2);
});

test("a disposed component holds no listener", async () => {
  const forget = spyOn(row, "removeEventListener");
  const shell = show(Shell);
  const child = leaf!;
  expect(child.count).toBe(1);
  shell.show = false;
  shell.stateHasChanged();
  expect(forget).toHaveBeenCalledTimes(1);
  row.label = "b";
  await tick();
  expect(child.count).toBe(1);
});

test("a change made in an event handler renders the owner once", async () => {
  const editor = show(Editor);
  host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(editor.count).toBe(2);
  await tick();
  expect(editor.count).toBe(2);
  expect(host.textContent).toBe("3");
});

test("an EntitySet mutation re-renders the components reading that property", async () => {
  sheet.rows.push(new Row({ label: "a" }));
  const grid = show(Grid);
  expect(grid.count).toBe(1);
  sheet.rows.push(new Row({ label: "b" }));
  await tick();
  expect(grid.count).toBe(2);
  expect(views.length).toBe(2);
  expect(host.textContent).toBe("ab");
});

test("a manual change event re-renders the readers of that property", async () => {
  const pay = show(Pay);
  row.dispatchEvent(new ModelChangeEvent("hours", 5, 2));
  await tick();
  expect(pay.count).toBe(2);
});
