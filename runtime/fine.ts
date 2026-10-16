// Fine components (`@fine`): no render pass. A fine component builds its DOM once, and each dynamic expression
// is a binding: it collects the tracked fields it reads while it runs, and re-runs through the model queue (once
// per microtask) when one of them changes. A binding is its own dep for the first source it reads.

import { ComponentBase, setFineHooks, type FineRoot } from "./index";
import { $notify, Model } from "./model";

const TEXT = 0;
const ATTR = 1;
const REGION = 2;
const LIST = 3;
const KIND = 3;
/** The tracker has it queued; `at` reads 0 then, else -1. */
const QUEUED = 4;
/** `model` is a map of deps: the binding read more than one source. */
const MANY = 8;
const DEAD = 16;

// Same bits as the model tracker: fields from the 30th share bit 30, `state` (-1) has bit 31.
const bitOf = (index: number): number => (index === -1 ? 1 << 31 : index < 30 ? 1 << index : 1 << 30);

type Source = { $watch(dep: object): void; $unwatch(dep: object): void };
type Dep = { model: Source; owner: Binding; mask: number; slot: number };
/** Where bindings are chained: a fine root, a region or a list row. */
type Holder = { bindings: unknown };
type Region = { bindings: Binding | undefined; start: Comment };
type Row = { bindings: Binding | undefined; head: Node; tail: Node };
type Build = (parent: Node) => void;
type ListState = { build: (parent: Node, item: any) => void; rows: Map<unknown, Row>; order: Row[] };

let collecting: Binding | undefined;
let holder: Holder | undefined;

function collect(source: Source, index: number): void {
  const b = collecting!;
  const bit = bitOf(index);
  const own = b.model;
  if (own === source) {
    b.mask |= bit;
    return;
  }
  if (own === undefined) {
    b.model = source;
    b.mask = bit;
    source.$watch(b);
    return;
  }
  let deps: Map<Source, Dep>;
  if ((b.flags & MANY) !== 0) deps = own as Map<Source, Dep>;
  else {
    // The first source moves to a plain dep too, so the map holds one shape.
    const first: Dep = { model: own as Source, owner: b, mask: b.mask, slot: 0 };
    (own as Source).$unwatch(b);
    (own as Source).$watch(first);
    b.model = deps = new Map([[own as Source, first]]);
    b.flags |= MANY;
  }
  let dep = deps.get(source);
  if (dep === undefined) {
    dep = { model: source, owner: b, mask: 0, slot: 0 };
    source.$watch(dep);
    deps.set(source, dep);
  }
  dep.mask |= bit;
}

/** One dynamic part of a fine component. 8 fields, so one 80-byte JSC cell. */
class Binding {
  model: Source | Map<Source, Dep> | undefined = undefined;
  mask = 0;
  slot = 0;
  next: Binding | undefined = undefined;

  constructor(
    public flags: number,
    /** TEXT: its Text; ATTR: its element; REGION and LIST: the comment that ends them. */
    readonly node: Node,
    /** TEXT and ATTR: the value; REGION: builds into its argument; LIST: the items. */
    readonly read: (parent?: Node) => unknown,
    /** ATTR: the attribute; REGION: its `Region`; LIST: its `ListState`. */
    readonly data: any,
  ) {}

  // The model queue reads these; prototype accessors cost no field.
  get owner(): Binding {
    return this;
  }
  get component(): Binding {
    return this;
  }
  get renders(): number {
    return 0;
  }
  get at(): number {
    return (this.flags & (QUEUED | DEAD)) !== 0 ? 0 : -1;
  }
  set at(value: number) {
    if ((this.flags & DEAD) === 0) this.flags = value < 0 ? this.flags & ~QUEUED : this.flags | QUEUED;
  }

  #reset(): void {
    this.mask = 0;
    if ((this.flags & MANY) !== 0) for (const dep of (this.model as Map<Source, Dep>).values()) dep.mask = 0;
  }

  // Drops the sources the last run did not read again.
  #sweep(): void {
    const own = this.model;
    if (own === undefined) return;
    if ((this.flags & MANY) === 0) {
      if (this.mask === 0) {
        (own as Source).$unwatch(this);
        this.model = undefined;
      }
      return;
    }
    const deps = own as Map<Source, Dep>;
    for (const [source, dep] of deps)
      if (dep.mask === 0) {
        source.$unwatch(dep);
        deps.delete(source);
      }
    if (deps.size === 0) {
      this.model = undefined;
      this.flags &= ~MANY;
    }
  }

  #run(parent?: Node): unknown {
    const prev = collecting;
    const reader = Model.$reader;
    collecting = this;
    Model.$reader = collect as unknown as typeof Model.$reader;
    this.#reset();
    try {
      return this.read(parent);
    } finally {
      collecting = prev;
      Model.$reader = reader;
      this.#sweep();
    }
  }

  stateHasChanged(): void {
    const flags = this.flags;
    if ((flags & DEAD) !== 0) return;
    switch (flags & KIND) {
      case TEXT: {
        const text = textOf(this.#run());
        const node = this.node as Text;
        if (node.data !== text) node.data = text;
        return;
      }
      case ATTR:
        return setAttr(this.node as Element, this.data, this.#run());
      case REGION: {
        const region = this.data as Region;
        disposeAll(region);
        const end = this.node;
        const parent = end.parentNode!;
        while (region.start.nextSibling !== end) parent.removeChild(region.start.nextSibling!);
        const frag = document.createDocumentFragment();
        within(region, () => this.#run(frag));
        parent.insertBefore(frag, end);
        return;
      }
      case LIST:
        return reconcile(this, this.#run() as Iterable<unknown>);
    }
  }

  dispose(): void {
    if ((this.flags & DEAD) !== 0) return;
    const kind = this.flags & KIND;
    if (kind === REGION) disposeAll(this.data as Region);
    else if (kind === LIST) for (const row of (this.data as ListState).order) disposeAll(row);
    this.#reset();
    this.#sweep();
    this.flags = DEAD;
  }
}

function within(h: Holder, run: () => void): void {
  const prev = holder;
  holder = h;
  try {
    run();
  } finally {
    holder = prev;
  }
}

function track(b: Binding): void {
  const h = holder!;
  b.next = h.bindings as Binding | undefined;
  h.bindings = b;
  b.stateHasChanged();
}

function disposeAll(h: Holder): void {
  for (let b = h.bindings as Binding | undefined; b !== undefined; b = b.next) b.dispose();
  h.bindings = undefined;
}

/** Re-runs every binding under `h`, rows included: what `stateHasChanged` does for changes nothing tracks. */
function refreshAll(h: Holder): void {
  for (let b = h.bindings as Binding | undefined; b !== undefined; b = b.next) {
    b.stateHasChanged();
    if ((b.flags & KIND) === LIST) for (const row of (b.data as ListState).order) refreshAll(row);
  }
}

const textOf = (value: unknown): string => (value === null || value === undefined || value === false ? "" : String(value));

/** `null`, `undefined` and `false` remove it, `true` sets it empty; `value` and `checked` follow onto the property. */
function setAttr(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    if (name === "checked" && "checked" in el) (el as HTMLInputElement).checked = false;
    return;
  }
  const text = value === true ? "" : String(value);
  if (el.getAttribute(name) !== text) el.setAttribute(name, text);
  if (name === "value" && "value" in el && (el as HTMLInputElement).value !== text) (el as HTMLInputElement).value = text;
  else if (name === "checked" && "checked" in el) (el as HTMLInputElement).checked = true;
}

function removeRange(head: Node, tail: Node): void {
  const parent = head.parentNode!;
  for (let node = head; ; ) {
    const next = node.nextSibling;
    parent.removeChild(node);
    if (node === tail) return;
    node = next!;
  }
}

// Rows are matched by identity: kept rows keep their nodes and bindings, and only move when out of place.
function reconcile(list: Binding, items: Iterable<unknown>): void {
  const state = list.data as ListState;
  const end = list.node;
  const parent = end.parentNode!;
  const next = Array.isArray(items) ? (items as unknown[]) : [...items];
  const keep = new Set(next);
  for (const [item, row] of state.rows)
    if (!keep.has(item)) {
      disposeAll(row);
      removeRange(row.head, row.tail);
      state.rows.delete(item);
    }
  let cursor: Node = end;
  for (const row of state.order)
    if (row.head.parentNode === parent) {
      cursor = row.head;
      break;
    }
  const order: Row[] = [];
  for (const item of next) {
    let row = state.rows.get(item);
    if (row === undefined) {
      const frag = document.createDocumentFragment();
      const made: Row = { bindings: undefined, head: frag, tail: frag };
      within(made, () => state.build(frag, item));
      // A row keeps at least one node, so it always has a place.
      if (frag.firstChild === null) frag.appendChild(document.createComment(""));
      made.head = frag.firstChild!;
      made.tail = frag.lastChild!;
      parent.insertBefore(frag, cursor);
      state.rows.set(item, (row = made));
    } else if (row.head !== cursor) {
      for (let node = row.head; ; ) {
        const after = node.nextSibling!;
        parent.insertBefore(node, cursor);
        if (node === row.tail) break;
        node = after;
      }
    } else cursor = row.tail.nextSibling!;
    order.push(row);
  }
  state.order = order;
}

/** What generated `@fine` code calls. `parent` is the element (or fragment) the new node is appended to. */
export const fine = {
  el<K extends keyof HTMLElementTagNameMap>(parent: Node, tag: K): HTMLElementTagNameMap[K] {
    return parent.appendChild(document.createElement(tag));
  },

  /** Static text. */
  t(parent: Node, text: string): void {
    parent.appendChild(document.createTextNode(text));
  },

  /** Text that follows `read()`. */
  text(parent: Node, read: () => unknown): void {
    track(new Binding(TEXT, parent.appendChild(document.createTextNode("")), read, undefined));
  },

  /** Attribute `name` of `el` that follows `read()`; `false`/`null`/`undefined` remove it. */
  attr(el: Element, name: string, read: () => unknown): void {
    track(new Binding(ATTR, el, read, name));
  },

  /** `@if`, `@switch`, a `@for` that is not a plain list, `@{ }`: rebuilt whenever what `build` read changes. */
  region(parent: Node, build: Build): void {
    const region: Region = { bindings: undefined, start: parent.appendChild(document.createComment("")) };
    track(new Binding(REGION, parent.appendChild(document.createComment("")), build as (p?: Node) => unknown, region));
  },

  /** `@for (const item of items)`: one row per item, matched by identity; a row is built once. */
  list<T>(parent: Node, items: () => Iterable<T>, build: (parent: Node, item: T) => void): void {
    const state: ListState = { build, rows: new Map(), order: [] };
    track(new Binding(LIST, parent.appendChild(document.createComment("")), items, state));
  },
};

const FIELDS = Symbol("xzor.fine.fields");

/**
 * Base of `@fine` components. The bundle turns their fields into tracked ones, as it does a model's, so a
 * handler that writes a field updates what reads it. `stateHasChanged()` re-runs every binding.
 */
export abstract class FineComponent extends ComponentBase {
  #subs: object[] | undefined;

  /** @internal What tracked getters report to; the bundle emits `FineComponent.$reader?.(this, i)`. */
  static get $reader(): typeof Model.$reader {
    return Model.$reader;
  }

  static same(a: unknown, b: unknown): boolean {
    return Model.same(a, b);
  }

  /** @internal Records a class's tracked fields after its base's; returns where they start. */
  static $define(cls: Function, names: string[]): number {
    const counts = cls as unknown as Record<symbol, number | undefined>;
    const at = counts[FIELDS] ?? 0;
    counts[FIELDS] = at + names.length;
    return at;
  }

  /** @internal */
  $watch(dep: object): void {
    const subs = (this.#subs ??= []);
    (dep as Dep).slot = subs.length;
    subs.push(dep);
  }

  /** @internal */
  $unwatch(dep: object): void {
    const subs = this.#subs;
    if (subs === undefined || subs.length === 0) return;
    const last = subs.pop() as Dep;
    if (last !== dep) {
      subs[(dep as Dep).slot] = last;
      last.slot = (dep as Dep).slot;
    }
  }

  /** @internal What a tracked setter reports once it stored a different value. */
  protected $changed(index: number, _previous: unknown): void {
    const subs = this.#subs;
    if (subs !== undefined) for (let i = 0; i < subs.length; i++) $notify(subs[i]!, index);
  }
}

setFineHooks({
  create(build: Build): FineRoot {
    const frag = document.createDocumentFragment();
    const start = frag.appendChild(document.createComment(""));
    const root: FineRoot = { bindings: undefined, start, end: start };
    // Reads outside a binding subscribe nothing: a fine component is never re-rendered by what it reads.
    const reader = Model.$reader;
    Model.$reader = undefined;
    try {
      within(root, () => build(frag));
    } finally {
      Model.$reader = reader;
    }
    root.end = frag.appendChild(document.createComment(""));
    return root;
  },
  refresh: refreshAll,
  dispose: disposeAll,
});
