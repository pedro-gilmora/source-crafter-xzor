// Fine components (`@fine`): no render pass. A fine component builds its DOM once, and each dynamic expression
// is a binding: it collects the tracked fields it reads while it runs, and re-runs through the model queue (once
// per microtask) when one of them changes. A binding is its own dep for the first source it reads.

import { $isFragment, ComponentBase, disposeIsland, FINE, patchIsland, setFineHooks, type FineRoot, type IApplication, type RenderTreeBuilder, type VNode } from "./index";
import { $notify, Model } from "./model";

const TEXT = 0;
const ATTR = 1;
const REGION = 2;
const LIST = 3;
/** A virtual-DOM subtree (child components, slots, `@cascade`, routes, markup values), patched on change. */
const ISLAND = 4;
const KIND = 7;
/** The tracker has it queued; `at` reads 0 then, else -1. */
const QUEUED = 8;
/** `model` is a map of deps: the binding read more than one source. */
const MANY = 16;
const DEAD = 32;
/** In its component's `loose` list: its last run read nothing tracked. */
const LOOSE = 64;

// Same bits as the model tracker: fields from the 30th share bit 30, `state` (-1) has bit 31.
const bitOf = (index: number): number => (index === -1 ? 1 << 31 : index < 30 ? 1 << index : 1 << 30);

type Source = { $watch(dep: object): void; $unwatch(dep: object): void };
type Dep = { model: Source; owner: Binding; mask: number; slot: number };
/** Where the fine component was mounted: what an island needs to mount components. */
type Ctx = { owner: ComponentBase; app: IApplication | undefined; scope: unknown; loose: Binding[] };
/** Where bindings are chained: a fine root, a region or a list row. */
type Holder = { bindings: unknown; ctx: Ctx };
type Region = { bindings: Binding | undefined; ctx: Ctx; start: Comment };
type Row = { bindings: Binding | undefined; ctx: Ctx; head: Node; tail: Node };
type Island = { ctx: Ctx; tree: VNode[]; build: (b: RenderTreeBuilder) => void };
type Build = (parent: Node) => void;
type ListState = { build: (parent: Node, item: any) => void; ctx: Ctx; rows: Map<unknown, Row>; order: Row[] };

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
    /** TEXT: its Text; ATTR: its element; REGION, LIST and ISLAND: the comment that ends them. */
    public node: Node,
    /** TEXT and ATTR: the value; REGION: builds into its argument; LIST: the items; ISLAND: patches it. */
    public read: (parent?: Node) => unknown,
    /** TEXT: the mount context; ATTR: the attribute; REGION: its `Region`; LIST: its `ListState`; ISLAND: its `Island`. */
    public data: any,
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
    if (own === undefined) return this.#loose();
    if ((this.flags & MANY) === 0) {
      if (this.mask === 0) {
        (own as Source).$unwatch(this);
        this.model = undefined;
        this.#loose();
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
      this.#loose();
    }
  }

  // Nothing tracked tells it about changes: its component re-runs it after each of its handlers.
  #loose(): void {
    if ((this.flags & (LOOSE | DEAD)) !== 0 || holder === undefined) return;
    this.flags |= LOOSE;
    holder.ctx.loose.push(this);
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
        const value = this.#run();
        if ($isFragment(value)) return this.#becomeIsland();
        const text = textOf(value);
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
      case ISLAND:
        this.#run();
        return;
    }
  }

  // `@expr` gave markup: from now on it renders through the virtual DOM, whatever it gives.
  #becomeIsland(): void {
    const value = this.read;
    const text = this.node;
    const end = text.parentNode!.insertBefore(document.createComment(""), text.nextSibling);
    text.parentNode!.removeChild(text);
    this.node = end;
    this.flags = (this.flags & ~KIND) | ISLAND;
    island(this, this.data as Ctx, (b) => {
      const v = value();
      if ($isFragment(v)) (v as (b: RenderTreeBuilder) => void)(b);
      else b.addContent(v);
    });
    this.stateHasChanged();
  }

  dispose(): void {
    if ((this.flags & DEAD) !== 0) return;
    const kind = this.flags & KIND;
    if (kind === REGION) disposeAll(this.data as Region);
    else if (kind === LIST) for (const row of (this.data as ListState).order) disposeAll(row);
    else if (kind === ISLAND) {
      disposeIsland((this.data as Island).tree);
      (this.data as Island).tree = [];
    }
    this.#reset();
    this.#sweep();
    this.flags = DEAD;
  }
}

/** Makes `b` patch a virtual-DOM island built by `build`, before its end comment. */
function island(b: Binding, ctx: Ctx, build: (b: RenderTreeBuilder) => void): void {
  const state: Island = { ctx, tree: [], build };
  b.data = state;
  b.read = () => {
    state.tree = patchIsland(ctx.owner, ctx.app, ctx.scope, b.node, state.tree, build);
  };
}

/** Re-runs the component's bindings that read nothing tracked; drops the dead ones and those that now track. */
function refreshLoose(ctx: Ctx): void {
  const loose = ctx.loose;
  for (let i = 0; i < loose.length; ) {
    const b = loose[i]!;
    if ((b.flags & DEAD) !== 0 || b.model !== undefined) {
      b.flags &= ~LOOSE;
      loose[i] = loose[loose.length - 1]!;
      loose.pop();
      continue;
    }
    b.stateHasChanged();
    i++;
  }
}

function afterHandler(ctx: Ctx, result: unknown): void {
  refreshLoose(ctx);
  if (result instanceof Promise) void result.then(() => refreshLoose(ctx));
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
      const made: Row = { bindings: undefined, ctx: state.ctx, head: frag, tail: frag };
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

  /** A handler; afterwards the component re-runs its bindings that read nothing tracked. */
  on(el: Element, event: string, handler: (e: any) => unknown): void {
    const ctx = holder!.ctx;
    el.addEventListener(event, (e) => afterHandler(ctx, handler(e)));
  },

  /** Static text. */
  t(parent: Node, text: string): void {
    parent.appendChild(document.createTextNode(text));
  },

  /** Text that follows `read()`; markup (a `RenderFragment`) renders as markup. */
  text(parent: Node, read: () => unknown): void {
    track(new Binding(TEXT, parent.appendChild(document.createTextNode("")), read, holder!.ctx));
  },

  /** Attribute `name` of `el` that follows `read()`; `false`/`null`/`undefined` remove it. */
  attr(el: Element, name: string, read: () => unknown): void {
    track(new Binding(ATTR, el, read, name));
  },

  /** `@if`, `@switch`, a `@for` that is not a plain list, `@{ }`: rebuilt whenever what `build` read changes. */
  region(parent: Node, build: Build): void {
    const region: Region = { bindings: undefined, ctx: holder!.ctx, start: parent.appendChild(document.createComment("")) };
    track(new Binding(REGION, parent.appendChild(document.createComment("")), build as (p?: Node) => unknown, region));
  },

  /** `@for (const item of items)`: one row per item, matched by identity; a row is built once. */
  list<T>(parent: Node, items: () => Iterable<T>, build: (parent: Node, item: T) => void): void {
    const state: ListState = { build, ctx: holder!.ctx, rows: new Map(), order: [] };
    track(new Binding(LIST, parent.appendChild(document.createComment("")), items, state));
  },

  /** Child components, slots, `@cascade`, routes: virtual-DOM builder calls, patched when what they read changes. */
  island(parent: Node, build: (b: RenderTreeBuilder) => void): void {
    const b = new Binding(ISLAND, parent.appendChild(document.createComment("")), noop, undefined);
    island(b, holder!.ctx, build);
    track(b);
  },
};

const noop = (): void => {};

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

(FineComponent.prototype as unknown as Record<symbol, boolean>)[FINE] = true;

const CTX = Symbol("xzor.fine.ctx");

setFineHooks({
  create(build: Build, owner: ComponentBase, app: IApplication | undefined, scope: unknown): FineRoot {
    const frag = document.createDocumentFragment();
    const start = frag.appendChild(document.createComment(""));
    const ctx: Ctx = { owner, app, scope, loose: [] };
    (owner as unknown as Record<symbol, Ctx>)[CTX] = ctx;
    const root: FineRoot & Holder = { bindings: undefined, ctx, start, end: start };
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
  refresh: (root) => refreshAll(root as FineRoot & Holder),
  dispose: (root) => disposeAll(root as FineRoot & Holder),
  handled(owner: ComponentBase, result: unknown): void {
    const ctx = (owner as unknown as Record<symbol, Ctx | undefined>)[CTX];
    if (ctx !== undefined) afterHandler(ctx, result);
  },
});
