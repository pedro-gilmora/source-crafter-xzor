// Fine components (`@fine`): no render pass. A fine component builds its DOM once, and each dynamic expression
// is a binding: it collects the tracked fields it reads while it runs, and re-runs through the model queue (once
// per microtask) when one of them changes. A binding is its own dep for the first source it reads.

import { $inSvg as inSvg, $isFragment, $leave as leave, ComponentBase, disposeIsland, FINE, patchIsland, setFineHooks, SVG, type FineRoot, type IApplication, type RenderTreeBuilder, type VNode } from "./index";
import { $flush, $keyName, $notify, Model } from "./model";

const TEXT = 0;
const ATTR = 1;
const REGION = 2;
const LIST = 3;
/** A virtual-DOM subtree (child components, slots, `@cascade`, routes, markup values), patched on change. */
const ISLAND = 4;
/** A loop run in place whose passes keep their rows by key (`Keyed`). */
const KEYED = 5;
/** Runs `read` for what it does (`@await`'s request): never re-run after handlers, so never loose. */
const EFFECT = 6;
/** A cached getter (value in `data`): a change to what it read marks it stale; it recomputes when read. Always QUEUED, so never queued. */
const MEMO = 7;
const KIND = 7;
/** The tracker has it queued; `at` reads 0 then, else -1. */
const QUEUED = 8;
/** `model` is a map of deps: the binding read more than one source. */
const MANY = 16;
const DEAD = 32;
/** In its component's `loose` list: its last run read nothing tracked. */
const LOOSE = 64;
/** A row's binding: `read` is shared by the list's rows and takes the row's item (`data.item`). */
const ITEM = 128;
/** An ATTR binding from `@attr:` on an enclosing element: disposing it takes its value back off (`data` is `Owned`). */
const OWNED = 256;
/** A MEMO's value is current. */
const FRESH = 512;

// Same bits as the model tracker: fields from the 30th share bit 30, `state` (-1) has bit 31.
const bitOf = (index: number): number => (index === -1 ? 1 << 31 : index < 30 ? 1 << index : 1 << 30);

type Source = { $watch(dep: object): void; $unwatch(dep: object): void };
type Dep = { model: Source; owner: Binding; mask: number; slot: number };
/** Where the fine component was mounted: what an island needs to mount components. */
type Ctx = { owner: ComponentBase; app: IApplication | undefined; scope: unknown; loose: Binding[] };
/** Where bindings are chained: a fine root, a region or a list row. */
type Holder = { bindings: unknown; ctx: Ctx };
type Region = { bindings: Binding | undefined; ctx: Ctx; start: Comment; item: unknown };
/** A row's shared reads, from the list: `(item, x) => value`; a handler's gives the handler. */
type Reads = readonly ((item: any, x?: any) => any)[];
type Row = { bindings: Binding | undefined; ctx: Ctx; head: Node; tail: Node; item: unknown; reads: Reads | undefined };
type Island = { ctx: Ctx; tree: VNode[]; build: (b: RenderTreeBuilder) => void };
type Build = (parent: Node) => void;
type ListState = { build: (parent: Node, item: any) => void; ctx: Ctx; rows: Map<unknown, Row>; order: Row[]; reads: Reads | undefined; empty: Build | undefined; key: ((item: any) => unknown) | undefined };
/** One pass of a keyed loop: its key and the loop variables it saw; a node to build its row into, or `undefined` to keep it. */
type Pass = (key: unknown, values: readonly unknown[]) => Node | undefined;
type Keyed = { ctx: Ctx; rows: Map<unknown, Row>; order: Row[]; empty: Build | undefined };
/** A component's cached getters, created on first read. */
const MEMOS = Symbol("xzor.fine.memos");
/** The key of the row an empty list's else builds. */
const EMPTY = Symbol("xzor.fine.empty");

/** The element type of tag `K`. */
export type El<K extends string> = K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement;

let collecting: Binding | undefined;
let holder: Holder | undefined;

function collect(source: Source, index: number): void {
  collectBits(source, bitOf(index));
}

function collectBits(source: Source, bit: number): void {
  const b = collecting!;
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
    public read: (a?: any, b?: any) => unknown,
    /** TEXT: its holder; ATTR: the attribute (ITEM: its row); REGION: its `Region`; LIST: its `ListState`; ISLAND: its `Island`. */
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
    if ((this.flags & DEAD) !== 0) return;
    // Stale as soon as what it read changes, so no binding re-run in the same flush reads the old value.
    if ((this.flags & KIND) === MEMO) {
      if (value >= 0) this.flags &= ~FRESH;
      return;
    }
    this.flags = value < 0 ? this.flags & ~QUEUED : this.flags | QUEUED;
  }

  /** @internal A cached getter's value: computed again when stale, and its reads passed on to the reader. */
  $memo(): unknown {
    if ((this.flags & FRESH) === 0) {
      this.data = this.#run();
      // What reads nothing tracked has nothing to tell it about changes: computed on every read.
      if (this.model !== undefined && (this.flags & DEAD) === 0) this.flags |= FRESH;
    }
    if (collecting !== undefined) {
      const own = this.model;
      if ((this.flags & MANY) === 0) {
        if (own !== undefined) collectBits(own as Source, this.mask);
      } else for (const dep of (own as Map<Source, Dep>).values()) collectBits(dep.model, dep.mask);
    }
    return this.data;
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
    if ((this.flags & (LOOSE | DEAD)) !== 0 || (this.flags & KIND) >= EFFECT || holder === undefined) return;
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
      return (this.flags & ITEM) !== 0 ? this.read(this.data.item, parent) : this.read(parent);
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
        if ((flags & OWNED) !== 0) return ownAttr(this.node as Element, this.data as Owned, this.#run());
        return setAttr(this.node as Element, (flags & ITEM) !== 0 ? (this.read as unknown as Named).$n : this.data, this.#run());
      case REGION: {
        const region = this.data as Region;
        disposeAll(region);
        const end = this.node;
        const parent = end.parentNode!;
        // A leaving element stays where it was: the new content goes after it.
        for (let node = region.start.nextSibling!; node !== end; ) {
          const next = node.nextSibling!;
          leave(node);
          node = next;
        }
        const frag = document.createDocumentFragment();
        within(region, () => this.#run(frag));
        parent.insertBefore(frag, end);
        return;
      }
      case LIST:
        return reconcile(this, this.#run() as Iterable<unknown>);
      case KEYED: {
        const keyed = this.data as Keyed;
        keyed.order = this.#run() as Row[];
        return;
      }
      case ISLAND:
      case EFFECT:
        this.#run();
        return;
      case MEMO:
        return;
    }
  }

  // `@expr` gave markup: from now on it renders through the virtual DOM, whatever it gives.
  #becomeIsland(): void {
    const read = this.read;
    const h = this.data as Holder & { item?: unknown };
    const value = (this.flags & ITEM) !== 0 ? () => read(h.item) : read;
    const text = this.node;
    const end = text.parentNode!.insertBefore(document.createComment(""), text.nextSibling);
    text.parentNode!.removeChild(text);
    this.node = end;
    this.flags = (this.flags & ~(KIND | ITEM)) | ISLAND;
    island(this, h.ctx, (b) => {
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
    else if (kind === LIST || kind === KEYED) for (const row of (this.data as ListState | Keyed).order) disposeAll(row);
    else if (kind === ISLAND) {
      disposeIsland((this.data as Island).tree);
      (this.data as Island).tree = [];
    } else if ((this.flags & OWNED) !== 0) undoAttr(this.node as Element, this.data as Owned);
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

// Like a render after a vdom handler, what the handler changed shows before it returns.
function afterHandler(ctx: Ctx, result: unknown): void {
  $flush();
  refreshLoose(ctx);
  if (result instanceof Promise) void result.then(() => refreshLoose(ctx));
}

// Runs `run` with no binding collecting, so what it reads subscribes nothing (`@once`).
function untracked<T>(run: () => T): T {
  const prev = collecting;
  const reader = Model.$reader;
  collecting = undefined;
  Model.$reader = undefined;
  try {
    return run();
  } finally {
    collecting = prev;
    Model.$reader = reader;
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
    const kind = b.flags & KIND;
    if (kind === LIST || kind === KEYED) for (const row of (b.data as ListState | Keyed).order) refreshAll(row);
  }
}

const textOf = (value: unknown): string => (value === null || value === undefined || value === false ? "" : String(value));

/** `null`, `undefined` and `false` remove it, `true` sets it empty; `value` and `checked` follow onto the property. */
function setAttr(el: Element, name: string, value: unknown): void {
  // `aria-*` states are the strings "true" and "false": a boolean writes its name, never removes it.
  if (typeof value === "boolean" && name.startsWith("aria-")) value = String(value);
  // `class:name` toggles one class and leaves the element's others.
  if (name.startsWith("class:")) return void el.classList.toggle(name.slice(6), !!value);
  // `--name`: a custom property from a component's `<style>`; reading first skips a costly same-value write.
  if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
    const style = (el as HTMLElement).style;
    const text = value === null || value === undefined || value === false ? "" : String(value);
    if (style.getPropertyValue(name) === text) return;
    if (text === "") style.removeProperty(name);
    else style.setProperty(name, text);
    return;
  }
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

/** `class` adds the tokens the element lacks; other names keep the element's value to restore. */
type Owned = { name: string; text: string | undefined; prev: string | null | undefined; added: string[] };

// ponytail: two `@attr:class` adding one token share it, so the first undone removes it for both.
function ownAttr(el: Element, s: Owned, value: unknown): void {
  if (s.name !== "class") {
    if (s.prev === undefined) s.prev = el.getAttribute(s.name);
    return setAttr(el, s.name, value);
  }
  const text = value === null || value === undefined || value === false || value === true ? "" : String(value);
  if (text === s.text) return;
  s.text = text;
  for (const t of s.added) el.classList.remove(t);
  s.added = [];
  for (const t of text.split(/\s+/))
    if (t !== "" && !el.classList.contains(t)) {
      el.classList.add(t);
      s.added.push(t);
    }
}

function undoAttr(el: Element, s: Owned): void {
  if (s.name === "class") for (const t of s.added) el.classList.remove(t);
  else if (s.prev !== undefined) setAttr(el, s.name, s.prev);
}

function removeRange(head: Node, tail: Node): void {
  for (let node = head; ; ) {
    const next = node.nextSibling;
    leave(node);
    if (node === tail) return;
    node = next!;
  }
}

/** A row built by `build` (given the item), its nodes in a fragment until `place` puts them. */
function newRow(ctx: Ctx, item: unknown, reads: Reads | undefined, build: (parent: Node, item: any) => void): Row {
  const frag = document.createDocumentFragment();
  const row: Row = { bindings: undefined, ctx, head: frag, tail: frag, item, reads };
  within(row, () => build(frag, item));
  seal(row, frag);
  return row;
}

// ponytail: a fragment per row, not one per run: in happy-dom a shared one costs heap and saves no time; recheck in a real browser.
/** Gives `row` its fragment's nodes; at least one, so it always has a place. */
function seal(row: Row, frag: DocumentFragment): void {
  if (frag.firstChild === null) frag.appendChild(document.createComment(""));
  row.head = frag.firstChild!;
  row.tail = frag.lastChild!;
}

function dropRow(row: Row): void {
  disposeAll(row);
  removeRange(row.head, row.tail);
}

// Kept rows keep their nodes and bindings, and only move when out of place; new ones come out of their fragment.
function place(end: Node, old: Row[], order: Row[]): void {
  const parent = end.parentNode!;
  let cursor: Node = end;
  for (const row of old)
    if (row.head.parentNode === parent) {
      cursor = row.head;
      break;
    }
  for (const row of order) {
    if (row.head !== cursor) {
      for (let node = row.head; ; ) {
        const after = node.nextSibling!;
        parent.insertBefore(node, cursor);
        if (node === row.tail) break;
        node = after;
      }
    } else cursor = row.tail.nextSibling!;
  }
}

const duplicate = (key: unknown): Error => new Error(`xzor: duplicate @key ${String(key)}`);

// Rows are matched by key (the list's, the models' `@Key`, else the item itself); a key whose item changed is rebuilt.
// ponytail: a rebuilt row loses its nodes; patching it needs every row binding to read through `row.item`.
function reconcile(list: Binding, items: Iterable<unknown>): void {
  const state = list.data as ListState;
  const rows = state.rows;
  let next = Array.isArray(items) ? (items as unknown[]) : [...items];
  if (next.length === 0 && state.empty !== undefined) next = [EMPTY];
  const named = state.key === undefined ? $keyName(next[0]) : undefined;
  const keyOf = state.key ?? (named === undefined ? undefined : (item: any) => item[named]);
  let keys = next;
  if (keyOf === undefined) {
    const keep = new Set(next);
    for (const [item, row] of rows)
      if (!keep.has(item)) {
        dropRow(row);
        rows.delete(item);
      }
  } else {
    const at = new Map<unknown, unknown>();
    keys = next.map((item) => (item === EMPTY ? EMPTY : keyOf(item)));
    for (let i = 0; i < next.length; i++) {
      if (at.has(keys[i])) throw duplicate(keys[i]);
      at.set(keys[i], next[i]);
    }
    for (const [key, row] of rows)
      if (!at.has(key) || at.get(key) !== row.item) {
        dropRow(row);
        rows.delete(key);
      }
  }
  const order: Row[] = [];
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    let row = rows.get(keys[i]);
    if (row === undefined) {
      row = item === EMPTY ? newRow(state.ctx, item, undefined, state.empty!) : newRow(state.ctx, item, state.reads, state.build);
      rows.set(keys[i], row);
    }
    order.push(row);
  }
  place(list.node, state.order, order);
  state.order = order;
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// Runs the loop: a pass that saw the same values as its key's row keeps it; else the generated code builds the
// row there and then, while the loop's state is the pass's own, into the node `pass` returns.
function runKeyed(s: Keyed, end: Node, run: (pass: Pass) => void): Row[] {
  const order: Row[] = [];
  const seen = new Set<unknown>();
  const outer = holder;
  let building: Row | undefined;
  const finish = (): void => {
    if (building === undefined) return;
    seal(building, building.head as DocumentFragment);
    building = undefined;
    holder = outer;
  };
  try {
    run((key, values) => {
      finish();
      if (seen.has(key)) throw duplicate(key);
      seen.add(key);
      let row = s.rows.get(key);
      if (row !== undefined && !sameValues(row.item as unknown[], values)) {
        dropRow(row);
        row = undefined;
      }
      if (row !== undefined) {
        order.push(row);
        return undefined;
      }
      const frag = document.createDocumentFragment();
      row = { bindings: undefined, ctx: s.ctx, head: frag, tail: frag, item: values, reads: undefined };
      s.rows.set(key, row);
      order.push(row);
      building = row;
      holder = row;
      return frag;
    });
    finish();
  } finally {
    holder = outer;
  }
  if (order.length === 0 && s.empty !== undefined) {
    let row = s.rows.get(EMPTY);
    if (row === undefined) s.rows.set(EMPTY, (row = newRow(s.ctx, EMPTY, undefined, s.empty)));
    order.push(row);
    seen.add(EMPTY);
  }
  for (const [key, row] of s.rows)
    if (!seen.has(key)) {
      dropRow(row);
      s.rows.delete(key);
    }
  place(end, s.order, order);
  return order;
}

type Named = { $n: string };

/** A template node: text (`""` is a binding's place), `null` a comment (an anchor), or `[tag, attrs | 0, ...children]`. */
type Spec = string | null | readonly [string, 0 | readonly string[], ...unknown[]];

function make(spec: Spec, svg = false): Node {
  if (spec === null) return document.createComment("");
  if (typeof spec === "string") return document.createTextNode(spec);
  const tag = spec[0];
  const el = svg || tag === "svg" ? document.createElementNS(SVG, tag) : document.createElement(tag);
  const attrs = spec[1];
  if (attrs !== 0) for (let i = 0; i < attrs.length; i += 2) el.setAttribute(attrs[i]!, attrs[i + 1]!);
  const inner = inSvg(el);
  for (let i = 2; i < spec.length; i++) el.appendChild(make(spec[i] as Spec, inner));
  return el;
}

// Events that bubble go through one listener on the document: an element only holds its handler and holder.
const DELEGATED = new Set(["beforeinput", "click", "dblclick", "contextmenu", "focusin", "focusout", "input", "keydown", "keyup", "mousedown", "mousemove", "mouseout", "mouseover", "mouseup", "pointerdown", "pointermove", "pointerout", "pointerover", "pointerup", "touchend", "touchmove", "touchstart"]);
// Symbols, so another copy of the runtime on the page (another bundle) never runs this one's handlers.
const keys = new Map<string, symbol>();
const HOLDER = Symbol("xzor.fine.holder");

function keyOf(type: string): symbol {
  let key = keys.get(type);
  if (key === undefined) {
    keys.set(type, (key = Symbol(type)));
    document.addEventListener(type, dispatch);
    // The capture phase sees events that do not bubble (dispatched by code) on their way to their target.
    document.addEventListener(type, dispatchAtTarget, true);
  }
  return key;
}

type Target = Node & Record<symbol, any>;

// Runs `node`'s handler; whether the event stopped.
function fire(node: Target, e: Event): boolean {
  const handler = node[keys.get(e.type)!];
  if (handler === undefined) return false;
  const h = node[HOLDER] as Holder & Partial<Row>;
  Object.defineProperty(e, "currentTarget", { configurable: true, value: node });
  afterHandler(h.ctx, h.reads !== undefined ? handler(h.item)(e) : handler(e));
  return e.cancelBubble;
}

/** Calls the handlers from the target up, as bubbling would; a row's handler comes from its item. */
function dispatch(e: Event): void {
  for (let node = e.target as Target | null; node !== null && !fire(node, e); node = node.parentNode as Target | null);
}

function dispatchAtTarget(e: Event): void {
  if (!e.bubbles && e.target !== null) fire(e.target as Target, e);
}

function on(el: Element, event: string, handler: (e: any) => unknown, h: Holder): void {
  if (DELEGATED.has(event)) {
    const target = el as unknown as Record<symbol, unknown>;
    target[keyOf(event)] = handler;
    target[HOLDER] = h;
  } else el.addEventListener(event, (e) => afterHandler(h.ctx, handler(e)));
}

function region(start: Comment, end: Comment, build: (a?: any, b?: any) => unknown, item: unknown, flags: number): void {
  const region: Region = { bindings: undefined, ctx: holder!.ctx, start, item };
  track(new Binding(REGION | flags, end, build, region));
}

function list(end: Comment, items: () => Iterable<unknown>, reads: Reads | undefined, build: (parent: Node, item: any) => void, empty?: Build, key?: (item: any) => unknown): void {
  const state: ListState = { build, ctx: holder!.ctx, rows: new Map(), order: [], reads, empty, key };
  track(new Binding(LIST, end, items, state));
}

const anchor = (parent: Node): Comment => parent.appendChild(document.createComment(""));

/**
 * What generated `@fine` code calls. A run of nodes is a `template` clone; the `...At` calls bind the nodes it
 * has in place, and the `...Item` ones bind a row's nodes to a read its list shares (`reads[i]`, given the item).
 * The others append the node they bind to `parent`.
 */
export const fine = {
  /**
   * Builds the nodes of `specs` (a fragment unless they are one element). The first call builds them directly:
   * a component used once keeps no copy. From the second on, calls clone a copy built then.
   */
  template(specs: readonly unknown[]): () => Node {
    let node: Node | undefined;
    let used = false;
    const build = (): Node => {
      const first = specs[0];
      if (specs.length === 1 && Array.isArray(first)) return make(first as unknown as Spec);
      const frag = document.createDocumentFragment();
      for (const spec of specs) frag.appendChild(make(spec as Spec));
      return frag;
    };
    return () => {
      if (node !== undefined) return node.cloneNode(true);
      if (!used) {
        used = true;
        return build();
      }
      node = build();
      return node.cloneNode(true);
    };
  },

  el<K extends string>(parent: Node, tag: K): El<K> {
    return parent.appendChild(inSvg(parent) ? document.createElementNS(SVG, tag) : document.createElement(tag)) as El<K>;
  },

  /** A handler; afterwards the component re-runs its bindings that read nothing tracked. */
  on(el: Element, event: string, handler: (e: any) => unknown): void {
    const h = holder!;
    // The dispatcher asks a row with shared reads for the handler of its item.
    on(el, event, (h as Partial<Row>).reads !== undefined && DELEGATED.has(event) ? () => handler : handler, h);
  },

  /** A row's handler: `reads[i](item)` gives it. */
  onItem(el: Element, event: string, i: number): void {
    const row = holder as Row;
    const read = row.reads![i]!;
    if (DELEGATED.has(event)) on(el, event, read, row);
    else el.addEventListener(event, (e) => afterHandler(row.ctx, read(row.item)(e)));
  },

  /** Static text. */
  t(parent: Node, text: string): void {
    parent.appendChild(document.createTextNode(text));
  },

  /** Text that follows `read()`; markup (a `RenderFragment`) renders as markup. */
  text(parent: Node, read: () => unknown): void {
    fine.textAt(parent.appendChild(document.createTextNode("")), read);
  },

  textAt(node: Text, read: () => unknown): void {
    track(new Binding(TEXT, node, read, holder!));
  },

  textItem(node: Text, i: number): void {
    const row = holder as Row;
    track(new Binding(TEXT | ITEM, node, row.reads![i]!, row));
  },

  /** Attribute `name` of `el` that follows `read()`; `false`/`null`/`undefined` remove it. */
  attr(el: Element, name: string, read: () => unknown): void {
    track(new Binding(ATTR, el, read, name));
  },

  attrItem(el: Element, name: string, i: number): void {
    const row = holder as Row;
    const read = row.reads![i]! as Reads[number] & Named;
    read.$n = name;
    track(new Binding(ATTR | ITEM, el, read, row));
  },

  /** `@attr:name` on the enclosing `el`, taken back off when the region or row holding it goes. */
  attrOf(el: Element, name: string, read: () => unknown): void {
    track(new Binding(ATTR | OWNED, el, read, { name, text: undefined, prev: undefined, added: [] } satisfies Owned));
  },

  /** `@if`, `@switch`, a `@for` that is not a plain list, `@{ }`: rebuilt whenever what `build` read changes. */
  region(parent: Node, build: Build): void {
    region(anchor(parent), anchor(parent), build, undefined, 0);
  },

  /** A region between `end` and the comment before it. */
  regionAt(end: Comment, build: Build): void {
    region(end.previousSibling as Comment, end, build, undefined, 0);
  },

  /** `@once(expr)`: `read()` once, untracked, into `node`. */
  textOnce(node: Text, read: () => unknown): void {
    node.data = textOf(untracked(read));
  },

  /** `@once { }`: `build` once, untracked, before `end`; its values are set, not bound. */
  onceAt(end: Comment, build: Build): void {
    const frag = document.createDocumentFragment();
    untracked(() => build(frag));
    end.parentNode!.insertBefore(frag, end);
  },

  /** An attribute set once, inside `@once`. */
  set(el: Element, name: string, value: unknown): void {
    setAttr(el, name, value);
  },

  /** Text set once, inside `@once`. */
  setText(node: Text, value: unknown): void {
    node.data = textOf(value);
  },

  /** A comment appended to `parent`: where a lone list, keyed loop or island goes. */
  anchor,

  /**
   * Caches the getters `names` of `cls` per instance: computed once per change of what they read, whoever
   * reads them. One that reads nothing tracked is computed on every read; `@Volatile` getters are left out.
   */
  memo(cls: Function, names: readonly string[]): void {
    const proto = cls.prototype as object;
    for (const name of names) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const get = desc?.get;
      if (get === undefined) continue;
      const key = Symbol(name);
      Object.defineProperty(proto, name, {
        ...desc,
        get(this: Record<symbol, unknown>) {
          let b = this[key] as Binding | undefined;
          if (b === undefined) {
            b = this[key] = new Binding(MEMO | QUEUED, null as unknown as Node, () => get.call(this), undefined);
            ((this[MEMOS] ??= []) as Binding[]).push(b);
          }
          return b.$memo();
        },
      });
    }
  },

  /**
   * `@await (read()) { pending } then (v) { } catch (e) { }` between `end` and the comment before it. `read`
   * runs again when what it reads changes, and a promise it replaced is ignored when it settles; the arms re-run
   * on their own reads like a region's. A rejection without `catch` is reported.
   */
  awaitAt<R>(end: Comment, read: () => R, pending: Build | undefined, then: ((parent: Node, value: Awaited<R>) => void) | undefined, fail: ((parent: Node, error: unknown) => void) | undefined): void {
    const state = { phase: 0, value: undefined as unknown, seq: 0 };
    const view = new Binding(REGION, end, (p: Node) => {
      if (state.phase === 0) pending?.(p);
      else if (state.phase === 1) then?.(p, state.value as Awaited<R>);
      else fail?.(p, state.value);
    }, { bindings: undefined, ctx: holder!.ctx, start: end.previousSibling as Comment, item: undefined } satisfies Region);
    const show = (phase: number, value: unknown): void => {
      if ((view.flags & DEAD) !== 0) return;
      state.phase = phase;
      state.value = value;
      view.stateHasChanged();
    };
    track(view);
    track(new Binding(EFFECT, end, () => {
      const result = read();
      const seq = ++state.seq;
      if (typeof (result as PromiseLike<unknown> | null)?.then !== "function") return show(1, result);
      if (state.phase !== 0) show(0, undefined);
      (result as PromiseLike<unknown>).then(
        (value) => seq === state.seq && show(1, value),
        (error) => {
          if (seq !== state.seq) return;
          show(2, error);
          if (fail === undefined) queueMicrotask(() => { throw error; });
        },
      );
    }, undefined));
  },

  /** Two comments appended to `parent`, for a lone region; the end one. */
  anchors(parent: Node): Comment {
    anchor(parent);
    return anchor(parent);
  },

  /** A row's region: `reads[i](item, parent)` builds it. */
  regionItem(end: Comment, i: number): void {
    const row = holder as Row;
    region(end.previousSibling as Comment, end, row.reads![i]!, row.item, ITEM);
  },

  /** `@for (const item of items)`: one row per item, matched by identity; a row is built once. */
  list<T>(parent: Node, items: () => Iterable<T>, build: (parent: Node, item: T) => void): void {
    list(anchor(parent), items, undefined, build);
  },

  /** A list before `end`; its rows' bindings use `reads`, shared by the rows. `empty` builds its `else`; `key` matches rows. */
  listAt<T>(end: Comment, items: () => Iterable<T>, reads: readonly ((item: T, x?: any) => any)[], build: (parent: Node, item: T) => void, empty?: Build, key?: (item: T) => unknown): void {
    list(end, items, reads, build, empty, key);
  },

  /** A loop before `end` run in place: `run` calls `pass` once per pass; `empty` builds its `else`. */
  keyedAt(end: Comment, run: (pass: Pass) => void, empty?: Build): void {
    const state: Keyed = { ctx: holder!.ctx, rows: new Map(), order: [], empty };
    track(new Binding(KEYED, end, () => runKeyed(state, end, run), state));
  },

  /** Child components, slots, `@cascade`, routes: virtual-DOM builder calls, patched when what they read changes. */
  island(parent: Node, build: (b: RenderTreeBuilder) => void): void {
    fine.islandAt(anchor(parent), build);
  },

  islandAt(end: Comment, build: (b: RenderTreeBuilder) => void): void {
    const b = new Binding(ISLAND, end, noop, undefined);
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
  static get $reader(): ((source: object, index: number) => void) | undefined {
    return Model.$reader as ((source: object, index: number) => void) | undefined;
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
  refresh(root) {
    // A whole-component pass recomputes the cached getters too: what changed may be untracked.
    const memos = ((root as FineRoot & Holder).ctx.owner as unknown as Record<symbol, Binding[] | undefined>)[MEMOS];
    if (memos !== undefined) for (const m of memos) m.flags &= ~FRESH;
    refreshAll(root as FineRoot & Holder);
  },
  dispose(root) {
    const memos = ((root as FineRoot & Holder).ctx.owner as unknown as Record<symbol, Binding[] | undefined>)[MEMOS];
    if (memos !== undefined) for (const m of memos) m.dispose();
    disposeAll(root as FineRoot & Holder);
  },
  handled(owner: ComponentBase, result: unknown): void {
    const ctx = (owner as unknown as Record<symbol, Ctx | undefined>)[CTX];
    if (ctx !== undefined) afterHandler(ctx, result);
  },
});
