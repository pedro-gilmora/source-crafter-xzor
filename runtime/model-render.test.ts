import { beforeEach, expect, spyOn, test } from "bun:test";
import {
  ComponentBase,
  type IApplication,
  type RenderTreeBuilder,
  type Route,
  type RouteSection,
  type RouteTable,
  mount,
} from "./index";
import { EntitySet, Model, ModelChangeEvent, Persist, State } from "./model";

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

class Writer extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    row.hours = this.count;
    b.addContent(row.label);
  }
}

// 41 tracked fields, as the bundle would rewrite them, to reach past the 30th.
const wideNames = Array.from({ length: 41 }, (_, i) => `f${i}`);

class Wide extends Model {
  slots: number[] = wideNames.map(() => 0);
  static { Model.$define(this, wideNames); }
}

for (let i = 0; i < wideNames.length; i++)
  Object.defineProperty(Wide.prototype, wideNames[i]!, {
    get(this: Wide): number {
      Model.$reader?.(this, i);
      return this.slots[i]!;
    },
    set(this: Wide, v: number): void {
      const p = this.slots[i]!;
      if (Model.same(p, v)) return;
      this.slots[i] = v;
      (this as unknown as { $changed(index: number, previous: unknown): void }).$changed(i, p);
    },
  });

type WideModel = Wide & Record<string, number>;
let wide: WideModel;

class Near extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(wide.f0);
  }
}

class Far extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(wide.f40);
  }
}

class Both extends ComponentBase {
  near!: Near;
  far!: Far;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addComponent(Near, {}, undefined, { ref: (c) => void (this.near = c) });
    b.addComponent(Far, {}, undefined, { ref: (c) => void (this.far = c) });
  }
}

class Boom extends ComponentBase {
  count = 0;
  constructor() {
    super();
    boom = this;
  }

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.label);
    throw new Error("boom");
  }
}

class AsyncBoom extends Boom {
  static readonly inject = ["service"];
}

let boom: Boom | undefined;

const page = (component: unknown): RouteTable => [
  { tag: undefined, pattern: "/", component, match: () => ({}) },
];

const caught: RouteSection[] = [
  { kind: "catch", render: (_route: Route, error: unknown) => ComponentBase.fragment((b) => b.addContent(String(error))) },
];

function routed(table: RouteTable, app?: IApplication): void {
  class Block extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addRoutes("server", table, caught);
    }
  }
  host = document.createElement("main");
  document.body.replaceChildren(host);
  mount(Block, host, app);
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
  wide = new Wide() as WideModel;
  boom = undefined;
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
  const forget = spyOn(row, "$unwatch");
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
  const forget = spyOn(row, "$unwatch");
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

class StateView extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.state);
  }
}

class SetView extends ComponentBase {
  count = 0;
  set = new EntitySet<Row>();

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(this.set.view.length);
  }
}

class Dirty extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    b.addContent(row.hasChanges ? "dirty" : "clean");
  }
}

let made: Row | undefined;

class Maker extends ComponentBase {
  count = 0;

  protected override buildRenderTree(b: RenderTreeBuilder): void {
    this.count++;
    made = new Row({ label: "x" });
    b.addContent("m");
  }
}

test("a state change alone re-renders the readers of state", async () => {
  const view = show(StateView);
  row.markModified();
  await tick();
  expect(view.count).toBe(2);
  expect(host.textContent).toBe(String(State.Modified));
});

test("markDeleted outside a handler re-renders a component showing a set's view", async () => {
  const view = show(SetView);
  view.set.push(row);
  view.stateHasChanged();
  expect(host.textContent).toBe("1");
  row.markDeleted();
  await tick();
  expect(view.count).toBe(3);
  expect(host.textContent).toBe("0");
});

test("confirmChanges with no field change re-renders a component showing hasChanges", async () => {
  row.markModified();
  const dirty = show(Dirty);
  expect(host.textContent).toBe("dirty");
  row.confirmChanges();
  await tick();
  expect(dirty.count).toBe(2);
  expect(host.textContent).toBe("clean");
});

test("a model built during a render does not subscribe the renderer", async () => {
  const maker = show(Maker);
  made!.label = "y";
  await tick();
  expect(maker.count).toBe(1);
});

test("a manual change event re-renders the readers of that property", async () => {
  const pay = show(Pay);
  row.dispatchEvent(new ModelChangeEvent("hours", 5, 2));
  await tick();
  expect(pay.count).toBe(2);
});

test("a field past the 30th re-renders its own readers only", async () => {
  const both = show(Both);
  expect(both.near.count).toBe(1);
  wide.f35 = 1;
  await tick();
  expect(both.near.count).toBe(1);
  expect(both.far.count).toBe(2);
});

test("a write during a render does not subscribe the renderer to that field", async () => {
  const writer = show(Writer);
  expect(writer.count).toBe(1);
  await tick();
  await tick();
  expect(writer.count).toBe(1);
  expect(row.hours).toBe(1);
});

test("a page whose first render throws keeps no subscription", async () => {
  const forget = spyOn(row, "$unwatch");
  const dispatch = spyOn(row, "dispatchEvent");
  routed(page(Boom));
  await tick();
  expect(host.textContent).toBe("Error: boom");
  expect(boom!.count).toBe(1);
  expect(forget).toHaveBeenCalledTimes(1);
  row.label = "b";
  await tick();
  expect(boom!.count).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test("an async component whose first render throws keeps no subscription", async () => {
  const forget = spyOn(row, "$unwatch");
  const dispatch = spyOn(row, "dispatchEvent");
  routed(page(AsyncBoom), { createComponent: () => Promise.resolve(new AsyncBoom()) });
  await tick();
  await tick();
  expect(host.textContent).toBe("Error: boom");
  expect(boom!.count).toBe(1);
  expect(forget).toHaveBeenCalledTimes(1);
  row.label = "b";
  await tick();
  expect(boom!.count).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});
