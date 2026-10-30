// The renderer: a component builds its DOM once, and each dynamic expression is a binding: it collects the
// tracked fields it reads while it runs, and re-runs through the change queue (once per microtask) when one of
// them changes. A binding is its own dep for the first source it reads.

import { $cascade, $child, $childItem, $currentRoute, $dropChild, $inSvg as inSvg, $isFragment, $leave as leave, $recascade, $resolve, $router, Component, disposeIsland, FINE, patchIsland, SVG, type CascadeRecord, type Child, type DomRouteSection, type FineRoot, type IApplication, type RenderTreeBuilder, type Route, type RouteEntry, type Router, type RouteTable, type VNode } from "./index";
import { bitOf, flush, keyName } from "./track";

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
/** A child component before its end comment: `read` gives its props, `data` is its `Child`. */
const COMPONENT = 8;
const KIND = 15;
/** The tracker has it queued; `at` reads 0 then, else -1. */
const QUEUED = 16;
/** `model` is a map of deps: the binding read more than one source. */
const MANY = 32;
const DEAD = 64;
/** In its component's `loose` list: its last run read nothing tracked. */
const LOOSE = 128;
/** A row's binding: `read` is shared by the list's rows and takes the row's item (`data.item`). */
const ITEM = 256;
/** An ATTR binding from `@attr:` on an enclosing element: disposing it takes its value back off (`data` is `Owned`). */
const OWNED = 512;
/** A MEMO's value is current. */
const FRESH = 1024;
/** A REGION that is `@show:if`/`@show:switch` (`data` is `Show`). */
const SHOW = 2048;
/** A REGION that is `@pause { }`: what it holds stops while its show branch is hidden. */
const PAUSE = 4096;
/** Under a `@pause` of a hidden branch: changes only mark it STALE. */
const PAUSED = 8192;
const STALE = 16384;
/** A REGION that shows a value (`data` is `Content`): markup builds, else text; rebuilt only when the value is another. */
const CONTENT = 32768;
/** An ATTR that sets a bag (`@attributes`); `data` is the last bag. */
const BAG = 65536;
/** A REGION that is a `@Routes` block (`data` is `Routes`). */
const ROUTES = 131072;

type Source = { $watch(dep: object): void; $unwatch(dep: object): void };
type Dep = { model: Source; owner: Binding; mask: number; slot: number };
/** The component bindings belong to: where it was mounted (`$app`, `$scope`) and its loose bindings. */
type Ctx = Component;
/** Where bindings are chained: a component (its root), a region or a list row. */
type Holder = { $bindings: unknown; $ctx: Ctx; $scope: unknown };
type Region = { $bindings: Binding | undefined; $ctx: Ctx; $scope: unknown; start: Comment; item: unknown; branch: Build | undefined; index: number };
/** A built branch of a show block: its top-level elements, and their inline `display` while hidden. */
type ShowBranch = Region & { first: Node | null; els: HTMLElement[]; display: string[] };
type Show = { ctx: Ctx; scope: unknown; start: Comment; index: number; build: (parent: Node) => unknown; branches: (ShowBranch | undefined)[] };
/** A row's shared reads, from the list: `(item, x) => value`; a handler's gives the handler. */
type Reads = readonly ((item: any, x?: any) => any)[];
/** `set`: a build that closes over its item gives it the new one (`dom.rowItem`). */
type Row = { $bindings: Binding | undefined; $ctx: Ctx; $scope: unknown; head: Node; tail: Node; item: unknown; reads: Reads | undefined; set: ((item: any) => void) | undefined };
type Island = { ctx: Ctx; tree: VNode[]; build: (b: RenderTreeBuilder) => void };
type Build = (parent: Node) => void;
/** `value`: what it shows; `owner`: the context of what has none (text, a slot's fallback, markup made outside a build). `branch` is a slot's fallback. */
type Content = Region & { value: unknown; owner: Ctx };
/** The routed page: one child binding between two comments, kept (and moved) while its route family stays. */
type Page = Holder & { start: Comment; end: Comment; key: unknown; child: Child; placed: boolean };
/**
 * A `@Routes` block: its region shows `section` (rebuilt when the section, the failure or whether there is a page
 * changes), `markup` places the page. Its scope is the `route` cascade.
 */
type Routes = Region & { router: Router; table: RouteTable; sections: readonly DomRouteSection[]; route: Route; section: number; failed: boolean; paged: boolean; page: Page | undefined; markup: Markup };

const MARKUP = Symbol("xzor.markup");
/** Markup held as a value: builds its nodes into `parent`; its handlers run in the context it was made in. */
export type Markup = ((parent: Node) => void) & { readonly [MARKUP]: Ctx | null };
const isMarkup = (value: unknown): value is Markup => typeof value === "function" && MARKUP in value;
// What a content region shows for a value: 1 markup, 2 nothing (a slot's fallback), 0 text.
const shows = (value: unknown): number => (isMarkup(value) ? 1 : value === null || value === undefined ? 2 : 0);
type ListState = { build: (parent: Node, item: any) => void; ctx: Ctx; scope: unknown; rows: Map<unknown, Row>; order: Row[]; reads: Reads | undefined; empty: Build | undefined; key: ((item: any) => unknown) | undefined };
/** One pass of a keyed loop: its key and the loop variables it saw; a node to build its row into, or `undefined` to keep it. */
type Pass = (key: unknown, values: readonly unknown[]) => Node | undefined;
/** `at`: the holder it was built in (its context and scope); `rows` comes with the first row. 4 fields: a 48-byte cell. */
type Keyed = { at: Holder; rows: Map<unknown, Row> | undefined; order: Row[]; empty: Build | undefined };
const NO_ROWS: Row[] = [];
/** The key of the row an empty list's else builds. */
const EMPTY = Symbol("xzor.dom.empty");

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

/** One dynamic part of a component. 8 fields, so one 80-byte JSC cell. */
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

  // The change queue reads these; prototype accessors cost no field.
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
    const kind = this.flags & KIND;
    if ((this.flags & (LOOSE | DEAD | PAUSE)) !== 0 || kind === EFFECT || kind === MEMO || holder === undefined) return;
    this.flags |= LOOSE;
    ((holder.$ctx.$loose ??= []) as Binding[]).push(this);
  }

  #run(parent?: Node): unknown {
    const prev = collecting;
    const reader = Component.$reader;
    collecting = this;
    Component.$reader = collect as unknown as typeof Component.$reader;
    this.#reset();
    try {
      return (this.flags & ITEM) !== 0 ? this.read(this.data.item, parent) : this.read(parent);
    } finally {
      collecting = prev;
      Component.$reader = reader;
      this.#sweep();
    }
  }

  stateHasChanged(): void {
    const flags = this.flags;
    if ((flags & (DEAD | PAUSED)) !== 0) {
      if ((flags & DEAD) === 0) this.flags |= STALE;
      return;
    }
    if ((flags & ROUTES) !== 0) return routes(this);
    if ((flags & SHOW) !== 0) return this.#show();
    if ((flags & CONTENT) !== 0) {
      const c = this.data as Content;
      const value = this.#run();
      if (c.index !== -1 && Object.is(value, c.value)) return;
      return this.#fill(c, value);
    }
    switch (flags & KIND) {
      case TEXT: {
        const value = this.#run();
        if (isMarkup(value)) return this.#becomeContent(value);
        if ($isFragment(value)) return this.#becomeIsland();
        const text = textOf(value);
        const node = this.node as Text;
        if (node.data !== text) node.data = text;
        return;
      }
      case ATTR:
        if ((flags & BAG) !== 0) return setBag(this, this.#run() as Record<string, unknown> | null | undefined);
        if ((flags & OWNED) !== 0) return ownAttr(this.node as Element, this.data as Owned, this.#run());
        return setAttr(this.node as Element, (flags & ITEM) !== 0 ? (this.read as unknown as Named).$n : this.data, this.#run());
      case REGION: {
        const region = this.data as Region;
        const branch = region.branch;
        // `@if`/`@switch`: `read` picks the branch, and the same one keeps its DOM (its parts bind themselves).
        if (branch !== undefined) {
          const index = this.#run() as number;
          if (index === region.index) return;
          region.index = index;
        }
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
        within(region, () => (branch !== undefined ? untracked(() => branch(frag)) : this.#run(frag)));
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
      case COMPONENT:
        return $child(this.data as Child, this.#run() as Record<string, unknown>);
    }
  }

  // `@show:if`/`@show:switch`: hides the branch it showed and shows the one `read` picks, built the first time.
  #show(): void {
    const show = this.data as Show;
    const index = this.#run() as number;
    if (index === show.index) return;
    const shown = show.branches[show.index];
    if (shown !== undefined) hideBranch(shown);
    show.index = index;
    let branch = show.branches[index];
    if (branch !== undefined) return showBranch(branch);
    branch = { $bindings: undefined, $ctx: show.ctx, $scope: show.scope, start: show.start, item: undefined, branch: undefined, index: -1, first: null, els: [], display: [] };
    show.branches[index] = branch;
    const frag = document.createDocumentFragment();
    within(branch, () => untracked(() => show.build(frag)));
    branch.first = frag.firstChild;
    for (let node = frag.firstChild; node !== null; node = node.nextSibling) if (node.nodeType === 1) branch.els.push(node as HTMLElement);
    // In source order: before the next branch built, else before the end.
    let before: Node = this.node;
    for (let i = index + 1; i < show.branches.length; i++) {
      const next = show.branches[i]?.first;
      if (next) {
        before = next;
        break;
      }
    }
    before.parentNode!.insertBefore(frag, before);
  }

  // `@expr` gave markup: from now on it is a content region, whatever it gives.
  #becomeContent(value: Markup): void {
    const text = this.node;
    const parent = text.parentNode!;
    const h = this.data as Holder & { item?: unknown };
    const start = parent.insertBefore(document.createComment(""), text);
    this.node = parent.insertBefore(document.createComment(""), text.nextSibling);
    parent.removeChild(text);
    this.flags = (this.flags & ~KIND) | REGION | CONTENT;
    const c: Content = { $bindings: undefined, $ctx: h.$ctx, $scope: h.$scope, start, item: (this.flags & ITEM) !== 0 ? h.item : undefined, branch: undefined, index: -1, value: undefined, owner: h.$ctx };
    this.data = c;
    this.#fill(c, value);
  }

  // Shows `value`: text stays one node written in place; markup or a fallback is built anew.
  #fill(c: Content, value: unknown): void {
    const kind = shows(value);
    const end = this.node;
    const text = kind === 0 && c.index !== -1 && shows(c.value) === 0;
    c.value = value;
    if (text) {
      const node = end.previousSibling as Text;
      const data = textOf(value);
      if (node.data !== data) node.data = data;
      return;
    }
    // A new index: `refreshAll` leaves what was just built alone.
    c.index++;
    disposeAll(c);
    for (let node = c.start.nextSibling!; node !== end; ) {
      const next = node.nextSibling!;
      leave(node);
      node = next;
    }
    const frag = document.createDocumentFragment();
    if (kind === 0) frag.appendChild(document.createTextNode(textOf(value)));
    else {
      const build = kind === 1 ? (value as Markup) : c.branch;
      c.$ctx = (kind === 1 ? (value as Markup)[MARKUP] : null) ?? c.owner;
      if (build !== undefined) within(c, () => untracked(() => build(frag)));
    }
    end.parentNode!.insertBefore(frag, end);
  }

  // `@expr` gave builder markup: from now on it renders through the virtual DOM, whatever it gives.
  #becomeIsland(): void {
    const read = this.read;
    const h = this.data as Holder & { item?: unknown };
    const value = (this.flags & ITEM) !== 0 ? () => read(h.item) : read;
    const text = this.node;
    const end = text.parentNode!.insertBefore(document.createComment(""), text.nextSibling);
    text.parentNode!.removeChild(text);
    this.node = end;
    this.flags = (this.flags & ~(KIND | ITEM)) | ISLAND;
    island(this, h.$ctx, h.$scope, (b) => {
      const v = value();
      if ($isFragment(v)) (v as (b: RenderTreeBuilder) => void)(b);
      else b.addContent(v);
    });
    this.stateHasChanged();
  }

  dispose(): void {
    if ((this.flags & DEAD) !== 0) return;
    const kind = this.flags & KIND;
    if ((this.flags & ROUTES) !== 0) {
      const s = this.data as Routes;
      s.router.off?.();
      if (s.page !== undefined) disposeAll(s.page);
      (s.$scope as CascadeRecord).consumers = undefined;
    }
    if ((this.flags & SHOW) !== 0) for (const branch of (this.data as Show).branches) branch !== undefined && disposeAll(branch);
    else if (kind === REGION) disposeAll(this.data as Region);
    else if (kind === LIST || kind === KEYED) for (const row of (this.data as ListState | Keyed).order) disposeAll(row);
    else if (kind === ISLAND) {
      disposeIsland((this.data as Island).tree);
      (this.data as Island).tree = [];
    } else if (kind === COMPONENT) $dropChild(this.data as Child);
    else if ((this.flags & OWNED) !== 0) undoAttr(this.node as Element, this.data as Owned);
    this.#reset();
    this.#sweep();
    this.flags = DEAD;
  }
}

/** Makes `b` patch a virtual-DOM island built by `build`, before its end comment. */
function island(b: Binding, ctx: Ctx, scope: unknown, build: (b: RenderTreeBuilder) => void): void {
  const state: Island = { ctx, tree: [], build };
  b.data = state;
  b.read = () => {
    state.tree = patchIsland(ctx, ctx.$app, scope, b.node, state.tree, build);
  };
}

/** Re-runs the component's bindings that read nothing tracked; drops the dead ones and those that now track. */
function refreshLoose(ctx: Ctx): void {
  const loose = ctx.$loose as Binding[] | undefined;
  if (loose === undefined) return;
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
  flush();
  refreshLoose(ctx);
  if (result instanceof Promise) void result.then(() => refreshLoose(ctx));
}

// Runs `run` with no binding collecting, so what it reads subscribes nothing (`@once`).
function untracked<T>(run: () => T): T {
  const prev = collecting;
  const reader = Component.$reader;
  collecting = undefined;
  Component.$reader = undefined;
  try {
    return run();
  } finally {
    collecting = prev;
    Component.$reader = reader;
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
  b.next = h.$bindings as Binding | undefined;
  h.$bindings = b;
  b.stateHasChanged();
}

function disposeAll(h: Holder): void {
  let loose = false;
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    if ((b.flags & LOOSE) !== 0) loose = true;
    b.dispose();
  }
  h.$bindings = undefined;
  if (loose) sweepLoose(h.$ctx);
}

// The loose list holds its bindings, and they their nodes, until a handler would drop them: a change from
// elsewhere (a timer, a server update) could grow it without end. One pass per component per microtask.
function sweepLoose(ctx: Ctx): void {
  if (ctx.$sweep) return;
  ctx.$sweep = true;
  queueMicrotask(() => {
    ctx.$sweep = false;
    const loose = ctx.$loose as Binding[];
    let kept = 0;
    for (const b of loose) if ((b.flags & DEAD) === 0) loose[kept++] = b;
    loose.length = kept;
  });
}

/** Re-runs every binding under `h`, rows included: what `stateHasChanged` does for changes nothing tracks. */
function refreshAll(h: Holder): void {
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    const kind = b.flags & KIND;
    const kept = kind === REGION ? (b.data as Region).index : -1;
    b.stateHasChanged();
    if ((b.flags & SHOW) !== 0) for (const branch of (b.data as Show).branches) branch !== undefined && refreshAll(branch);
    else if (kind === LIST || kind === KEYED) for (const row of (b.data as ListState | Keyed).order) refreshAll(row);
    else if (kept !== -1 && kept === (b.data as Region).index) refreshAll(b.data as Region);
  }
}

/** Calls `f` with each holder right under `b`: a region's, a list's rows, a show block's built branches, a child component. */
function under(b: Binding, f: (h: Holder) => void): void {
  const kind = b.flags & KIND;
  if ((b.flags & SHOW) !== 0) for (const branch of (b.data as Show).branches) branch !== undefined && f(branch);
  else if (kind === REGION) {
    f(b.data as Region);
    if ((b.flags & ROUTES) !== 0 && (b.data as Routes).page !== undefined) f((b.data as Routes).page!);
  } else if (kind === LIST || kind === KEYED) for (const row of (b.data as ListState | Keyed).order) f(row);
  else if (kind === COMPONENT) {
    const child = (b.data as Child).instance;
    if (child !== undefined) f(child);
  }
}

/** Pauses everything under the `@pause` regions of `h`. */
function pauseIn(h: Holder): void {
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    if ((b.flags & PAUSE) !== 0) under(b, freeze);
    else under(b, pauseIn);
  }
}

function freeze(h: Holder): void {
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    b.flags |= PAUSED;
    under(b, freeze);
  }
}

/** Resumes what `freeze` paused: a binding that missed a change runs once, then what is under it resumes. */
function thaw(h: Holder): void {
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    const stale = (b.flags & STALE) !== 0;
    b.flags &= ~(PAUSED | STALE);
    if (stale) b.stateHasChanged();
    under(b, thaw);
  }
}

function hideBranch(branch: ShowBranch): void {
  for (let i = 0; i < branch.els.length; i++) {
    const style = branch.els[i]!.style;
    branch.display[i] = style.display;
    style.display = "none";
  }
  pauseIn(branch);
}

function showBranch(branch: ShowBranch): void {
  for (let i = 0; i < branch.els.length; i++) branch.els[i]!.style.display = branch.display[i] ?? "";
  thaw(branch);
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

// ponytail: the same bag object, mutated and given again, can't show which keys it lost.
function setBag(b: Binding, bag: Record<string, unknown> | null | undefined): void {
  const el = b.node as Element;
  const prev = b.data as Record<string, unknown> | null | undefined;
  if (prev != null) for (const name in prev) if (bag == null || !(name in bag)) setAttr(el, name, null);
  if (bag != null) for (const name in bag) setAttr(el, name, bag[name]);
  b.data = bag;
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
function newRow(ctx: Ctx, scope: unknown, item: unknown, reads: Reads | undefined, build: (parent: Node, item: any) => void): Row {
  const frag = document.createDocumentFragment();
  const row: Row = { $bindings: undefined, $ctx: ctx, $scope: scope, head: frag, tail: frag, item, reads, set: undefined };
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

// Rows are matched by key (the list's, the models' `@Key`, else the item itself). A key whose item is a new object
// keeps its row, which takes the item, unless its build closes over the item (it is rebuilt then).
function reconcile(list: Binding, items: Iterable<unknown>): void {
  const state = list.data as ListState;
  const rows = state.rows;
  let next = Array.isArray(items) ? (items as unknown[]) : [...items];
  if (next.length === 0 && state.empty !== undefined) next = [EMPTY];
  const named = state.key === undefined ? keyName(next[0]) : undefined;
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
    for (const [key, row] of rows) {
      if (!at.has(key)) {
        dropRow(row);
        rows.delete(key);
        continue;
      }
      const item = at.get(key);
      if (item === row.item) continue;
      // A build that takes the item but can't be given a new one (compiled before `rowItem`) is rebuilt.
      if (row.set === undefined && state.build.length > 1) {
        dropRow(row);
        rows.delete(key);
      } else retake(row, item);
    }
  }
  const order: Row[] = [];
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    let row = rows.get(keys[i]);
    if (row === undefined) {
      row = item === EMPTY ? newRow(state.ctx, state.scope, item, undefined, state.empty!) : newRow(state.ctx, state.scope, item, state.reads, state.build);
      rows.set(keys[i], row);
    }
    order.push(row);
  }
  place(list.node, state.order, order);
  state.order = order;
}

/**
 * Gives a kept row its key's new item. Its own bindings read it through the row and run again; a build that closes
 * over it gets it through `set`, and then everything in the row runs again (nested lists keep their rows, child
 * components their instances).
 */
function retake(row: Row, item: unknown): void {
  row.item = item;
  if (row.set !== undefined) row.set(item);
  for (let b = row.$bindings; b !== undefined; b = b.next) {
    if ((b.flags & ITEM) === 0) continue;
    if ((b.flags & KIND) === REGION) (b.data as Region).item = item;
    else if ((b.flags & KIND) === COMPONENT) $childItem(b.data as Child, item);
    if (row.set === undefined) b.stateHasChanged();
  }
  if (row.set !== undefined) refreshAll(row);
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
      const rows = (s.rows ??= new Map());
      let row = rows.get(key);
      if (row !== undefined && !sameValues(row.item as unknown[], values)) {
        dropRow(row);
        row = undefined;
      }
      if (row !== undefined) {
        order.push(row);
        return undefined;
      }
      const frag = document.createDocumentFragment();
      row = { $bindings: undefined, $ctx: s.at.$ctx, $scope: s.at.$scope, head: frag, tail: frag, item: values, reads: undefined, set: undefined };
      rows.set(key, row);
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
    const rows = (s.rows ??= new Map());
    let row = rows.get(EMPTY);
    if (row === undefined) rows.set(EMPTY, (row = newRow(s.at.$ctx, s.at.$scope, EMPTY, undefined, s.empty)));
    order.push(row);
    seen.add(EMPTY);
  }
  if (s.rows !== undefined)
    for (const [key, row] of s.rows)
      if (!seen.has(key)) {
        dropRow(row);
        s.rows.delete(key);
      }
  if (order.length === 0) return NO_ROWS;
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
const HOLDER = Symbol("xzor.dom.holder");

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
  afterHandler(h.$ctx, h.reads !== undefined ? handler(h.item)(e) : handler(e));
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
  } else el.addEventListener(event, (e) => afterHandler(h.$ctx, handler(e)));
}

/** `mods`: 1 prevents the default, 2 stops propagation; the handler may be missing. */
const modified =
  (handler: ((e: any) => unknown) | undefined, mods: number) =>
  (e: Event): unknown => {
    if ((mods & 1) !== 0) e.preventDefault();
    if ((mods & 2) !== 0) e.stopPropagation();
    return handler?.(e);
  };

function region(start: Comment, end: Comment, build: (a?: any, b?: any) => unknown, item: unknown, flags: number, branch?: Build): void {
  const h = holder!;
  const region: Region = { $bindings: undefined, $ctx: h.$ctx, $scope: h.$scope, start, item, branch, index: -1 };
  track(new Binding(REGION | flags, end, build, region));
}

function list(end: Comment, items: () => Iterable<unknown>, reads: Reads | undefined, build: (parent: Node, item: any) => void, empty?: Build, key?: (item: any) => unknown): void {
  const state: ListState = { build, ctx: holder!.$ctx, scope: holder!.$scope, rows: new Map(), order: [], reads, empty, key };
  track(new Binding(LIST, end, items, state));
}

const anchor = (parent: Node): Comment => parent.appendChild(document.createComment(""));

/** `@await`'s view before `end`; the function it gives shows what a request returned, a promise once it settles. */
function awaiting<R>(end: Comment, pending: Build | undefined, then: ((parent: Node, value: Awaited<R>) => void) | undefined, fail: ((parent: Node, error: unknown) => void) | undefined): (result: R) => void {
  const state = { phase: 0, value: undefined as unknown, seq: 0 };
  const view = new Binding(REGION, end, (p: Node) => {
    if (state.phase === 0) pending?.(p);
    else if (state.phase === 1) then?.(p, state.value as Awaited<R>);
    else fail?.(p, state.value);
  }, { $bindings: undefined, $ctx: holder!.$ctx, $scope: holder!.$scope, start: end.previousSibling as Comment, item: undefined, branch: undefined, index: -1 } satisfies Region);
  const show = (phase: number, value: unknown): void => {
    if ((view.flags & DEAD) !== 0) return;
    state.phase = phase;
    state.value = value;
    view.stateHasChanged();
  };
  track(view);
  return (result) => {
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
  };
}

/**
 * What generated code calls. A run of nodes is a `template` clone; the `...At` calls bind the nodes it
 * has in place, and the `...Item` ones bind a row's nodes to a read its list shares (`reads[i]`, given the item).
 * The others append the node they bind to `parent`.
 */
export const dom = {
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

  /** A handler; afterwards the component re-runs its bindings that read nothing tracked. `mods`: 1 preventDefault, 2 stopPropagation. */
  on(el: Element, event: string, handler: ((e: any) => unknown) | undefined, mods = 0): void {
    if (mods !== 0) handler = modified(handler, mods);
    else if (handler === undefined) return;
    const h = holder!;
    const run = handler;
    // The dispatcher asks a row with shared reads for the handler of its item.
    on(el, event, (h as Partial<Row>).reads !== undefined && DELEGATED.has(event) ? () => run : run, h);
  },

  /** A row's handler: `reads[i](item)` gives it; `mods` as `on`'s. */
  onItem(el: Element, event: string, i: number, mods = 0): void {
    const row = holder as Row;
    const given = row.reads![i]!;
    const read = mods === 0 ? given : (item: unknown) => modified(given(item), mods);
    if (DELEGATED.has(event)) on(el, event, read, row);
    else el.addEventListener(event, (e) => afterHandler(row.$ctx, read(row.item)(e)));
  },

  /** Static text. */
  t(parent: Node, text: string): void {
    parent.appendChild(document.createTextNode(text));
  },

  /** Text that follows `read()`; markup (a `RenderFragment`) renders as markup. */
  text(parent: Node, read: () => unknown): void {
    dom.textAt(parent.appendChild(document.createTextNode("")), read);
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

  /** `@attributes="bag"` on `el`: the bag's values set as `attr`'s; keys the next bag lacks are removed. */
  attrs(el: Element, read: () => Record<string, unknown> | null | undefined): void {
    track(new Binding(ATTR | BAG, el, read, undefined));
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

  /** `@if`/`@switch` before `end`: `run()` gives the branch's index, `run(parent)` builds it; rebuilt only when the index changes. */
  branchAt(end: Comment, run: (parent?: Node) => number): void {
    region(end.previousSibling as Comment, end, run, undefined, 0, run as Build);
  },

  /** `@show:if`/`@show:switch` before `end`: `run()` picks a branch, `run(parent)` builds the one picked; see `#show`. */
  showAt(end: Comment, run: (parent?: Node) => number): void {
    const show: Show = { ctx: holder!.$ctx, scope: holder!.$scope, start: end.previousSibling as Comment, index: -1, build: run, branches: [] };
    track(new Binding(REGION | SHOW, end, run, show));
  },

  /** `@pause { }` in a show branch, before `end`: built once; what it holds stops while the branch is hidden. */
  pauseAt(end: Comment, build: Build): void {
    region(end.previousSibling as Comment, end, () => 0, undefined, PAUSE, build);
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
    names.forEach((name, i) => {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const get = desc?.get;
      if (get === undefined) return;
      const reader = Symbol(name);
      Object.defineProperty(proto, name, {
        ...desc,
        get(this: Record<symbol, unknown>) {
          const memo = ((this as unknown as Component).$memos as (Binding | undefined)[] | undefined)?.[i];
          if (memo !== undefined) return memo.$memo();
          // A cache pays off from a second reader: outside bindings, or for its one reader, it runs as written.
          const by = collecting;
          if (by === undefined) return get.call(this);
          const first = this[reader] as Binding | undefined;
          if (first === undefined || first === by || (first.flags & DEAD) !== 0) {
            this[reader] = by;
            return get.call(this);
          }
          this[reader] = undefined;
          const b = new Binding(MEMO | QUEUED, null as unknown as Node, () => get.call(this), undefined);
          (((this as unknown as Component).$memos ??= []) as (Binding | undefined)[])[i] = b;
          return b.$memo();
        },
      });
    });
  },

  /**
   * `@await (read()) { pending } then (v) { } catch (e) { }` between `end` and the comment before it. `read`
   * runs again when what it reads changes, and a promise it replaced is ignored when it settles; the arms re-run
   * on their own reads like a region's. A rejection without `catch` is reported.
   */
  awaitAt<R>(end: Comment, read: () => R, pending: Build | undefined, then: ((parent: Node, value: Awaited<R>) => void) | undefined, fail: ((parent: Node, error: unknown) => void) | undefined): void {
    const show = awaiting(end, pending, then, fail);
    track(new Binding(EFFECT, end, () => show(read()), undefined));
  },

  /**
   * `@await (f(a, b))`: as `awaitAt`, but `f` is called again only when an argument changes (`Object.is`) or
   * what `f` itself reads does, not on every change to what the arguments read.
   */
  awaitCallAt<A extends unknown[], R>(end: Comment, args: () => [...A], call: (...args: A) => R, pending: Build | undefined, then: ((parent: Node, value: Awaited<R>) => void) | undefined, fail: ((parent: Node, error: unknown) => void) | undefined): void {
    const show = awaiting(end, pending, then, fail);
    let last: A | undefined;
    const request = new Binding(EFFECT, end, () => show(call(...last!)), undefined);
    track(new Binding(EFFECT, end, () => {
      const next = args();
      if (last !== undefined && next.every((v, i) => Object.is(v, last![i]))) return;
      const first = last === undefined;
      last = next;
      if (!first) request.stateHasChanged();
    }, undefined));
    track(request);
  },

  /** Two comments appended to `parent`, for a lone region; the end one. */
  anchors(parent: Node): Comment {
    anchor(parent);
    return anchor(parent);
  },

  /** A row's build closes over its item: `set` gives it the item that replaces it under the same key. */
  rowItem(set: (item: any) => void): void {
    (holder as Row).set = set;
  },

  /** A row's region: `reads[i](item, parent)` builds it. */
  regionItem(end: Comment, i: number): void {
    const row = holder as Row;
    region(end.previousSibling as Comment, end, row.reads![i]!, row.item, ITEM);
  },

  /** A row's `@if`/`@switch`: `reads[i](item)` picks the branch, `reads[i](item, parent)` builds it; see `branchAt`. */
  branchItem(end: Comment, i: number): void {
    const row = holder as Row;
    const read = row.reads![i]!;
    const state: Region = { $bindings: undefined, $ctx: row.$ctx, $scope: row.$scope, start: end.previousSibling as Comment, item: row.item, branch: undefined, index: -1 };
    state.branch = (p) => read(state.item, p);
    track(new Binding(REGION | ITEM, end, read, state));
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
    const state: Keyed = { at: holder!, rows: undefined, order: NO_ROWS, empty };
    track(new Binding(KEYED, end, () => runKeyed(state, end, run), state));
  },

  /**
   * A child component before `end` (its end comment): `props` gives its value props, diffed against the last ones;
   * `statics` (callbacks) and `slots` are assigned once. `key` keys a `@cached` one; `onError` is `@catch`'s.
   */
  component(end: Comment, type: abstract new (...args: any[]) => Component, props: () => Record<string, unknown>, statics?: Record<string, unknown>, slots?: object, ref?: (c: Component) => void, key?: unknown, onError?: (err: unknown, nav: number) => void): void {
    const h = holder!;
    const child: Child = { type: type as Child["type"], end, ctx: h.$ctx, scope: h.$scope as Child["scope"], props: undefined, statics, slots, ref, key, onError, nav: undefined, instance: undefined, phase: 0, tree: undefined, item: undefined };
    track(new Binding(COMPONENT, end, props, child));
  },

  /**
   * A list row's child component: `reads[i](item)` gives its props; `reads[statics](item)` its callbacks and
   * `reads[slots](item)` its slot fills, given again when the row's item is replaced under the same key.
   */
  componentItem(end: Comment, type: abstract new (...args: any[]) => Component, i: number, statics?: number, slots?: number, ref?: (c: Component) => void, key?: unknown, onError?: (err: unknown, nav: number) => void): void {
    const row = holder as Row;
    const reads = row.reads!;
    const child: Child = { type: type as Child["type"], end, ctx: row.$ctx, scope: row.$scope as Child["scope"], props: undefined, statics: statics === undefined ? undefined : reads[statics], slots: slots === undefined ? undefined : reads[slots], ref, key, onError, nav: undefined, instance: undefined, phase: 0, tree: undefined, item: row.item };
    track(new Binding(COMPONENT | ITEM, end, reads[i]!, child));
  },

  /**
   * `@slot` before `end` (and the comment before it): builds `fill()?.(...args())`, or `fallback` when there is no
   * fill. Called again when what they read changes and on the component's passes; rebuilt only when the fill or an
   * argument (`Object.is`) changed.
   */
  slotAt(end: Comment, fill: () => ((...args: any[]) => Markup | null | undefined) | null | undefined, args?: () => readonly unknown[], fallback?: Build): void {
    const ctx = holder!.$ctx;
    let last: ((...args: any[]) => unknown) | null | undefined;
    let lastArgs: readonly unknown[] = NO_ARGS;
    let markup: unknown;
    const read = (): unknown => {
      const f = fill();
      const a = args === undefined ? NO_ARGS : args();
      if (f === last && sameValues(a, lastArgs)) return markup;
      last = f;
      lastArgs = a;
      return (markup = f?.(...a));
    };
    const c: Content = { $bindings: undefined, $ctx: ctx, $scope: holder!.$scope, start: end.previousSibling as Comment, item: undefined, branch: fallback, index: -1, value: undefined, owner: ctx };
    track(new Binding(REGION | CONTENT, end, read, c));
  },

  /**
   * `@cascade:name(value[, fixed])` before `end` (and the comment before it): `build` once, its components given
   * `value()` under `name`. A change reaches them (assigned, `onParametersSet`, a pass); `fixed` keeps the first value.
   */
  cascadeAt(end: Comment, name: string, value: () => unknown, fixed: boolean, build: Build): void {
    const h = holder!;
    const record: CascadeRecord = { name, value: undefined, fixed, consumers: undefined, parent: h.$scope as CascadeRecord | undefined };
    if (fixed) record.value = untracked(value);
    // Untracked: what the consumers' hooks read is theirs, not the provider's.
    else track(new Binding(EFFECT, end, () => {
      const v = value();
      untracked(() => $cascade(record, v));
    }, undefined));
    const region: Region = { $bindings: undefined, $ctx: h.$ctx, $scope: record, start: end.previousSibling as Comment, item: undefined, branch: build, index: -1 };
    track(new Binding(REGION, end, zero, region));
  },

  /**
   * `@Routes` before `end` (and the comment before it): the section matching the current navigation, with the page
   * as a child keyed by its route family; `route` is cascaded. A section is kept while it stays the matching one.
   */
  routesAt(end: Comment, table: RouteTable, sections: readonly DomRouteSection[]): void {
    const h = holder!;
    const ctx = h.$ctx;
    const record: CascadeRecord = { name: "route", value: undefined, fixed: false, consumers: undefined, parent: h.$scope as CascadeRecord | undefined };
    const s = { $bindings: undefined, $ctx: ctx, $scope: record, start: end.previousSibling as Comment, item: undefined, branch: undefined, index: -1, table, sections, section: -1, failed: false, paged: false, page: undefined } as unknown as Routes;
    const b = new Binding(REGION | ROUTES, end, noop, s);
    s.router = $router(sections, () => b.stateHasChanged());
    s.route = $currentRoute(s.router);
    s.markup = fineHooks.markup((parent) => placePage(s, parent), ctx);
    track(b);
  },

  /** Child components, slots, `@cascade`, routes: virtual-DOM builder calls, patched when what they read changes. */
  island(parent: Node, build: (b: RenderTreeBuilder) => void): void {
    dom.islandAt(anchor(parent), build);
  },

  islandAt(end: Comment, build: (b: RenderTreeBuilder) => void): void {
    const b = new Binding(ISLAND, end, noop, undefined);
    island(b, holder!.$ctx, holder!.$scope, build);
    track(b);
  },
};

const noop = (): void => {};
const zero = (): number => 0;
const NO_ARGS: readonly unknown[] = [];

// A navigation, or the page failed: one pass that gives `route` to its consumers around the block's update.
function routes(b: Binding): void {
  const s = b.data as Routes;
  const r = s.router;
  if (!$resolve(r, s.table, s.sections) && s.index !== -1 && s.failed === r.failed) return;
  untracked(() =>
    $recascade(s.$scope as CascadeRecord, r.route, () => {
      const entry = r.failed ? undefined : r.page;
      if (s.index === -1 || r.failed !== s.failed || r.section !== s.section || (entry !== undefined) !== s.paged) return rebuild(b, s, entry);
      if (entry !== undefined && s.page !== undefined) pageAgain(s, entry);
      // Kept: what the section shows of `route` is read again.
      within(s, () => refreshAll(s));
    }),
  );
}

const familyOf = (entry: RouteEntry): unknown => entry.family ?? entry.pattern;

function rebuild(b: Binding, s: Routes, entry: RouteEntry | undefined): void {
  const r = s.router;
  let kept = s.page;
  if (kept !== undefined) {
    if (entry !== undefined && familyOf(entry) === kept.key) {
      // Out of the old section before it goes, so a leaving element there can't take it.
      kept.placed = false;
      const stash = document.createDocumentFragment();
      for (let node: Node = kept.start; ; ) {
        const next = node.nextSibling!;
        stash.appendChild(node);
        if (node === kept.end) break;
        node = next;
      }
    } else {
      disposeAll(kept);
      s.page = kept = undefined;
    }
  }
  s.index++;
  s.failed = r.failed;
  s.section = r.section;
  s.paged = entry !== undefined;
  disposeAll(s);
  const end = b.node;
  for (let node = s.start.nextSibling!; node !== end; ) {
    const next = node.nextSibling!;
    leave(node);
    node = next;
  }
  const frag = document.createDocumentFragment();
  const route = s.route;
  const section = s.sections[r.section];
  within(s, () => {
    if (r.failed) r.caught!.render(route, r.error)(frag);
    else if (entry !== undefined) (section === undefined ? s.markup : (section.render as (r: Route, p: Markup) => Markup)(route, s.markup))(frag);
    else if (section !== undefined) (section.render as (r: Route) => Markup)(route)(frag);
  });
  end.parentNode!.insertBefore(frag, end);
  // The new section doesn't show the page.
  if (kept !== undefined && !kept.placed) {
    disposeAll(kept);
    s.page = undefined;
  }
}

// The page markup a section builds: the page built the first time, else moved in and given its params again.
function placePage(s: Routes, parent: Node): void {
  const r = s.router;
  const page = s.page;
  if (page === undefined) {
    const entry = r.page!;
    const start = parent.appendChild(document.createComment(""));
    const end = parent.appendChild(document.createComment(""));
    const p = { $bindings: undefined, $ctx: s.$ctx, $scope: s.$scope, start, end, key: familyOf(entry), placed: true } as Page;
    s.page = p;
    return mountPage(s, p, entry);
  }
  if (page.placed) return;
  page.placed = true;
  for (let node: Node = page.start; ; ) {
    const next = node.nextSibling!;
    parent.appendChild(node);
    if (node === page.end) break;
    node = next;
  }
  page.child.nav = r.id;
  $child(page.child, r.params, true);
}

// A navigation that kept the section: the same family's page takes its params again, another replaces it.
function pageAgain(s: Routes, entry: RouteEntry): void {
  const r = s.router;
  const page = s.page!;
  const key = familyOf(entry);
  if (key === page.key) {
    page.child.nav = r.id;
    return $child(page.child, r.params, true);
  }
  disposeAll(page);
  for (let node = page.start.nextSibling!; node !== page.end; ) {
    const next = node.nextSibling!;
    leave(node);
    node = next;
  }
  page.key = key;
  mountPage(s, page, entry);
}

// Stamped with the navigation it belongs to, so `@catch` can drop a failure that comes after we left.
function mountPage(s: Routes, page: Page, entry: RouteEntry): void {
  const r = s.router;
  const child: Child = { type: entry.component as Child["type"], end: page.end, ctx: s.$ctx, scope: s.$scope as Child["scope"], props: undefined, statics: undefined, slots: undefined, ref: undefined, key: page.key, onError: r.onError, nav: r.id, instance: undefined, phase: 0, tree: undefined, item: undefined };
  page.child = child;
  within(page, () => track(new Binding(COMPONENT, page.end, () => r.params, child)));
}

/** @internal What `index.ts` calls to mount, refresh and dispose a component's DOM. */
export const fineHooks = {
  create(build: Build, owner: Component, app: IApplication | undefined, scope: unknown): FineRoot {
    const frag = document.createDocumentFragment();
    const start = frag.appendChild(document.createComment(""));
    // DOM markup shown by a builder component: built in its creator's context, which it leaves as it is.
    const made = isMarkup(build) ? build[MARKUP] : null;
    if (made === null) {
      owner.$app = app;
      owner.$scope = scope;
      (owner as unknown as Record<symbol, Ctx>)[FINE] = owner;
    }
    const root: FineRoot & Holder = { $bindings: undefined, $ctx: made ?? owner, $scope: scope, start, end: start };
    // Reads outside a binding subscribe nothing: a component is never re-rendered by what it reads.
    const reader = Component.$reader;
    Component.$reader = undefined;
    try {
      within(root, () => build(frag));
    } finally {
      Component.$reader = reader;
    }
    root.end = frag.appendChild(document.createComment(""));
    return root;
  },
  /** Runs `c.render` into `parent`, untracked, with `c` holding its bindings. */
  build(c: Component, parent: Node): void {
    const prev = collecting;
    const reader = Component.$reader;
    const outer = holder;
    collecting = undefined;
    Component.$reader = undefined;
    holder = c;
    try {
      (c as unknown as { render(parent: Node): void }).render(parent);
    } finally {
      collecting = prev;
      Component.$reader = reader;
      holder = outer;
    }
  },
  /** A whole-component pass: a fine root's, or a render component's (`h` is the component). */
  refresh(h: FineRoot | Component): void {
    const root = h as unknown as Holder;
    // A whole-component pass recomputes the cached getters too: what changed may be untracked.
    const memos = root.$ctx.$memos as (Binding | undefined)[] | undefined;
    if (memos !== undefined) for (const m of memos) if (m !== undefined) m.flags &= ~FRESH;
    // A binding that now reads nothing tracked joins its component's loose list.
    const outer = holder;
    holder = root;
    try {
      refreshAll(root);
    } finally {
      holder = outer;
    }
  },
  /** `own`: the root is its context's whole DOM (not markup built in another's), so its memos go too. */
  dispose(h: FineRoot | Component, own = true): void {
    const root = h as unknown as Holder;
    const ctx = root.$ctx;
    const memos = ctx.$memos as (Binding | undefined)[] | undefined;
    if (own && memos !== undefined) {
      for (const m of memos) m?.dispose();
      ctx.$memos = undefined;
    }
    disposeAll(root);
  },
  isMarkup,
  /** Brands `build` as markup made in `owner`'s context (else the one building now). */
  markup(build: (parent: Node) => void, owner: Component | undefined): Markup {
    (build as unknown as Record<symbol, Ctx | null>)[MARKUP] = owner ?? holder?.$ctx ?? null;
    return build as Markup;
  },
  handled(owner: Component, result: unknown): void {
    if (owner.$end !== undefined || (owner as unknown as Record<symbol, Ctx | undefined>)[FINE] !== undefined) afterHandler(owner, result);
  },
};
