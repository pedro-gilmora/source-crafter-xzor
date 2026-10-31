import { beforeEach, expect, spyOn, test } from "bun:test";
import {
  Component,
  type El,
  type IApplication,
  type Route,
  type DomRouteSection,
  type RouteTable,
  dom,
  mount,
  setNavigationForTests,
} from "./index";
import { EntitySet, Model, ModelChangeEvent, Persist, State, StateKey } from "./model";

// Models are written the way the bundle rewrites them (Task 2), components the way codegen emits them.
// A component's `count` is how many times its bindings read the model: a change re-runs only the bindings that read it.

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

// A derived model: its fields continue after its base's, at the offset `$define` returns.
class Chore extends Row { constructor(data?: object) { super(data); if (new.target === Chore) this.assign(data); }
  #done = false; get done(): boolean { Row.$reader?.(this, Chore.#at + 0); return this.#done; } set done(v: boolean) { const p = this.#done; if (Row.same(p, v)) return; this.#done = v; this.$changed(Chore.#at + 0, p); }
static #at = 0; static { this.#at = Row.$define(this, ["done"]); } }

let row: Row;
let sheet: Sheet;
let host: HTMLElement;
let views: RowView[];
let labels: Label[];
let leaf: Leaf | undefined;

class RowView extends Component {
  row!: Row;
  count = 0;
  constructor() {
    super();
    views.push(this);
  }

  protected override render(__p: Node): void {
    const _e0 = __rowView() as El<"li">;
    dom.textAt(_e0.firstChild as Text, () => (this.count++, this.row.label));
    __p.appendChild(_e0);
  }
}

class Grid extends Component {
  count = 0;

  protected override render(__p: Node): void {
    const _e0 = __grid() as El<"ul">;
    const _e1 = _e0.firstChild!.nextSibling as Comment;
    dom.listAt(_e1, () => (this.count++, sheet.rows), [(r: Row): Partial<RowView> => ({ row: r })], (__p) => {
      dom.componentItem(dom.anchor(__p), RowView, 0);
    }, undefined, (r) => r);
    __p.appendChild(_e0);
  }
}

class Label extends Component {
  count = 0;
  constructor() {
    super();
    labels.push(this);
  }

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, row.label));
  }
}

class Pair extends Component {
  count = 0;

  protected override render(__p: Node): void {
    this.count++;
    dom.component(dom.anchor(__p), Label, (): Partial<Label> => ({}));
    dom.component(dom.anchor(__p), Label, (): Partial<Label> => ({}));
  }
}

class Summary extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, `${row.label} ${row.hours} ${row.tax}`));
  }
}

class Pay extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, row.payment));
  }
}

class Toggle extends Component {
  count = 0;
  show = true;

  protected override render(__p: Node): void {
    const _e0 = __anchors();
    const _e1 = _e0.firstChild!.nextSibling as Comment;
    dom.branchAt(_e1, (__p) => {
      if (this.show) {
        if (!__p) return 0;
        dom.text(__p, () => (this.count++, row.label));
      }
      return 1;
    });
    __p.appendChild(_e0);
  }
}

class Leaf extends Component {
  count = 0;
  constructor() {
    super();
    leaf = this;
  }

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, row.label));
  }
}

class Shell extends Component {
  show = true;

  protected override render(__p: Node): void {
    const _e0 = __anchors();
    const _e1 = _e0.firstChild!.nextSibling as Comment;
    dom.branchAt(_e1, (__p) => {
      if (this.show) {
        if (!__p) return 0;
        dom.component(dom.anchor(__p), Leaf, (): Partial<Leaf> => ({}));
      }
      return 1;
    });
    __p.appendChild(_e0);
  }
}

class Editor extends Component {
  count = 0;

  protected override render(__p: Node): void {
    const _e0 = __editor() as El<"button">;
    dom.on(_e0, "click", () => void row.hours++);
    dom.textAt(_e0.firstChild as Text, () => (this.count++, row.hours));
    __p.appendChild(_e0);
  }
}

class Writer extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => {
      this.count++;
      row.hours = this.count;
      return row.label;
    });
  }
}

let chore: Chore;

class ChoreView extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, `${chore.label} ${chore.done}`));
  }
}

const __rowView = dom.template([["li", 0, ""]]);
const __grid = dom.template([["ul", 0, null, null]]);
const __anchors = dom.template([null, null]);
const __editor = dom.template([["button", 0, ""]]);

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

class Near extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, wide.f0));
  }
}

class Far extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, wide.f40));
  }
}

class Both extends Component {
  near!: Near;
  far!: Far;

  protected override render(__p: Node): void {
    const _e0 = __anchors();
    const _e1 = _e0.firstChild as Comment;
    const _e2 = _e1.nextSibling as Comment;
    dom.component(_e1, Near, (): Partial<Near> => ({}), undefined, undefined, (c) => void (this.near = c));
    dom.component(_e2, Far, (): Partial<Far> => ({}), undefined, undefined, (c) => void (this.far = c));
    __p.appendChild(_e0);
  }
}

class Boom extends Component {
  count = 0;
  constructor() {
    super();
    boom = this;
  }

  protected override render(__p: Node): void {
    this.count++;
    dom.text(__p, () => row.label);
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

const caught: DomRouteSection[] = [
  { kind: "catch", render: (_route: Route, error: unknown) => Component.fragment((__p) => dom.text(__p, () => String(error))) },
];

function routed(table: RouteTable, app?: IApplication): void {
  // The test never unmounts, so it must not leave a document listener behind.
  setNavigationForTests({ current: () => new URL("http://localhost/"), navigate() {}, subscribe: () => () => {} });
  class Block extends Component {
    protected override render(__p: Node): void {
      dom.routesAt(dom.anchors(__p), table, caught);
    }
  }
  host = document.createElement("main");
  document.body.replaceChildren(host);
  mount(Block, host, app);
}

// Queued after the flush that a change schedules.
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function show<C extends Component>(type: new () => C): C {
  host = document.createElement("main");
  document.body.replaceChildren(host);
  return mount(type, host);
}

beforeEach(() => {
  setNavigationForTests(undefined);
  document.body.replaceChildren();
  row = new Row({ label: "a", hours: 2, tax: 3 });
  sheet = new Sheet();
  wide = new Wide() as WideModel;
  boom = undefined;
  views = [];
  labels = [];
  leaf = undefined;
});

test("a change to one row of a thousand updates only that row", async () => {
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

test("a change from outside a handler updates every component showing it, once each", async () => {
  const pair = show(Pair);
  expect(labels.map((l) => l.count)).toEqual([1, 1]);
  row.label = "b";
  await tick();
  expect(labels.map((l) => l.count)).toEqual([2, 2]);
  expect(host.textContent).toBe("bb");
  expect(pair.count).toBe(1);
});

test("many changes in one tick update once", async () => {
  const summary = show(Summary);
  row.label = "b";
  row.hours = 9;
  row.tax = 4;
  await tick();
  expect(summary.count).toBe(2);
  expect(host.textContent).toBe("b 9 4");
});

test("a change that arrives after an unrelated update still shows", async () => {
  const summary = show(Summary);
  row.label = "b";
  summary.stateHasChanged();
  expect(summary.count).toBe(2);
  row.hours = 9;
  await tick();
  expect(summary.count).toBe(3);
  expect(host.textContent).toBe("b 9 3");
});

test("a persisted getter updates its components when a field it reads changes", async () => {
  const pay = show(Pay);
  expect(host.textContent).toBe("6");
  row.tax = 7;
  await tick();
  expect(pay.count).toBe(2);
  expect(host.textContent).toBe("14");
});

test("a change to a property no component read updates nothing", async () => {
  const pay = show(Pay);
  row.note = "x";
  await tick();
  expect(pay.count).toBe(1);
});

test("a component reading a derived field updates when it changes", async () => {
  chore = new Chore({ label: "a", done: false });
  const view = show(ChoreView);
  expect(host.textContent).toBe("a false");
  chore.done = true;
  await tick();
  expect(view.count).toBe(2);
  expect(host.textContent).toBe("a true");
  chore.label = "b";
  await tick();
  expect(view.count).toBe(3);
  chore.note = "ignored";
  await tick();
  expect(view.count).toBe(3);
});

test("a component that stops showing a model stops updating on its changes", async () => {
  const forget = spyOn(row, "$unwatch");
  const toggle = show(Toggle);
  expect(toggle.count).toBe(1);
  toggle.show = false;
  toggle.stateHasChanged();
  expect(host.textContent).toBe("");
  expect(forget).toHaveBeenCalledTimes(1);
  row.label = "b";
  await tick();
  expect(toggle.count).toBe(1);
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

test("a change made in an event handler updates the owner once", async () => {
  const editor = show(Editor);
  host.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(editor.count).toBe(2);
  await tick();
  expect(editor.count).toBe(2);
  expect(host.textContent).toBe("3");
});

test("an EntitySet mutation updates the bindings reading that property", async () => {
  sheet.rows.push(new Row({ label: "a" }));
  const grid = show(Grid);
  expect(grid.count).toBe(1);
  sheet.rows.push(new Row({ label: "b" }));
  await tick();
  expect(grid.count).toBe(2);
  expect(views.length).toBe(2);
  expect(host.textContent).toBe("ab");
});

class StateView extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, row[StateKey]));
  }
}

class SetView extends Component {
  count = 0;
  set = new EntitySet<Row>();

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, this.set.view.length));
  }
}

class Dirty extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => (this.count++, row.hasChanges ? "dirty" : "clean"));
  }
}

let made: Row | undefined;

class Maker extends Component {
  count = 0;

  protected override render(__p: Node): void {
    dom.text(__p, () => {
      this.count++;
      made = new Row({ label: "x" });
      return "m";
    });
  }
}

test("a state change alone updates the readers of state", async () => {
  const view = show(StateView);
  row.markModified();
  await tick();
  expect(view.count).toBe(2);
  expect(host.textContent).toBe(String(State.Modified));
});

test("markDeleted outside a handler updates a component showing a set's view", async () => {
  const view = show(SetView);
  view.set.push(row);
  view.stateHasChanged();
  expect(host.textContent).toBe("1");
  row.markDeleted();
  await tick();
  expect(view.count).toBe(3);
  expect(host.textContent).toBe("0");
});

test("confirmChanges with no field change updates a component showing hasChanges", async () => {
  row.markModified();
  const dirty = show(Dirty);
  expect(host.textContent).toBe("dirty");
  row.confirmChanges();
  await tick();
  expect(dirty.count).toBe(2);
  expect(host.textContent).toBe("clean");
});

test("a model built during a binding's read does not subscribe it", async () => {
  const maker = show(Maker);
  made!.label = "y";
  await tick();
  expect(maker.count).toBe(1);
});

test("a manual change event updates the readers of that property", async () => {
  const pay = show(Pay);
  row.dispatchEvent(new ModelChangeEvent("hours", 5, 2));
  await tick();
  expect(pay.count).toBe(2);
});

test("a field past the 30th updates its own readers only", async () => {
  const both = show(Both);
  expect(both.near.count).toBe(1);
  wide.f35 = 1;
  await tick();
  expect(both.near.count).toBe(1);
  expect(both.far.count).toBe(2);
});

test("a write during a binding's read does not subscribe it to that field", async () => {
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
