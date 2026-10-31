// The renderer: a component builds its DOM once, and each dynamic expression is a binding: it collects the
// tracked fields it reads while it runs, and re-runs through the change queue (once per microtask) when one of
// them changes. A binding is its own dep for the first source it reads.

import { $cascade, $release, $child, $childItem, $currentRoute, $dropChild, $inSvg as inSvg, $leave as leave, $recascade, $resolve, $router, Component, SVG, type CascadeRecord, type Child, type EventCallback, type Route, type RouteEntry, type RouteSection, type RenderFragment, type Router, type RouteTable } from "./index";
import { DEAD, FRESH, KIND, MEMO, QUEUED, bitOf, flush, keyName } from "./track";

const TEXT = 0;
const ATTR = 1;
const REGION = 2;
const LIST = 3;
/** A loop run in place whose passes keep their rows by key (`Keyed`). */
const KEYED = 5;
/** Runs `read` for what it does (`@await`'s request): never re-run after handlers, so never loose. */
const EFFECT = 6;
/** A child component before its end comment: `read` gives its props, `data` is its `Child`. */
const COMPONENT = 8;
/** A handler in a markup value: `read` is the handler, `slot` its modifiers; never run. A claim re-points it. */
const HANDLER = 9;
/** `@once(expr)` in a markup value: set when built, and again only by a claim. */
const ONCE = 10;
/** An element `@ref` in a markup value: `read` sets the target, `node` is the element; a claim sets the new target to it. */
const REF = 11;
/** `model` is a map of deps: the binding read more than one source. */
const MANY = 32;
/** In its component's `loose` list: its last run read nothing tracked. */
const LOOSE = 128;
/** A row's binding: `read` is shared by the list's rows and takes the row's item (`data.item`). */
const ITEM = 256;
/** An ATTR binding from `@attr:` on an enclosing element: disposing it takes its value back off (`data` is `Owned`). */
const OWNED = 512;
/** A REGION that is `@show:if`/`@show:switch` (`data` is `Show`). */
const SHOW = 2048;
/** A REGION that is `@pause { }`: what it holds stops while its show branch is hidden. */
const PAUSE = 4096;
/** Under a `@pause` of a hidden branch: changes only mark it STALE. */
const PAUSED = 8192;
const STALE = 16384;
/** A REGION that shows a value (`data` is `Content`): markup builds, else text; rebuilt only when the value is another. */
const CONTENT = 32768;
/** An ATTR that sets a bag (`@attributes`); `data` is its holder. */
const BAG = 65536;
/** A REGION that is a `@Routes` block (`data` is `Routes`). */
const ROUTES = 131072;
/** Made under a markup value: what it builds keeps its handlers and once-values as bindings, for a claim to re-point. */
const MARKED = 262144;
/** A REGION that is a `@{ }` block with markup statements (`data` is `Pieces`): a run claims last run's pieces. */
const PIECES = 524288;
/** Made by a markup statement reading the block's `let`s: they change only when the block runs again, so never loose. */
const LOCAL = 1048576;
/** The flags a claimed binding must share with the call that claims it. */
const SHAPE = KIND | ITEM | OWNED | SHOW | PAUSE | CONTENT | BAG | ROUTES | PIECES;

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
type Build = (parent: Node) => void;
/** What holds a run of sibling nodes: a row or a piece. */
type Span = Holder & { head: Node; tail: Node };
/** `value`: what it shows; `owner`: the context of what has none (text, a slot's fallback, markup made outside a build). `branch` is a slot's fallback. */
type Content = Region & { value: unknown; owner: Ctx };
/** The routed page: one child binding between two comments, kept (and moved) while its route family stays. */
type Page = Holder & { start: Comment; end: Comment; key: unknown; child: Child; placed: boolean };
/**
 * A `@Routes` block: its region shows `section` (rebuilt when the section, the failure or whether there is a page
 * changes), `markup` places the page. Its scope is the `route` cascade.
 */
type Routes = Region & { router: Router; table: RouteTable; sections: readonly RouteSection[]; route: Route; section: number; failed: boolean; paged: boolean; page: Page | undefined; markup: Markup };
/** A markup statement's nodes in a `@{ }` block, from markup literal `site`; `run` is the block's run that last took it. */
type Piece = { $bindings: Binding | undefined; $ctx: Ctx; $scope: unknown; head: Node; tail: Node; site: unknown; run: number };
/**
 * A `@{ }` block's region: last run's pieces (`old`, taken from `at` on) and this run's (`now`), the two arrays
 * swapped each run.
 */
type Pieces = Region & { old: Piece[]; now: Piece[]; run: number; at: number };

const MARKUP = Symbol("xzor.markup");
const SITE = Symbol("xzor.site");
/** Markup held as a value: builds its nodes into `parent`; its handlers run in the context it was made in. `SITE`: the literal it comes from. */
export type Markup = ((parent: Node) => void) & { readonly [MARKUP]: Ctx | null; readonly [SITE]: unknown };
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
/** The item of a row whose claim failed: one sweep of the list's map then forgets them all. */
const GONE = Symbol("xzor.dom.gone");

/** The element type of tag `K`. */
export type El<K extends string> = K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement;

/** What a parent sets on child `C`: its own members, never `Component`'s (the runtime's `$` fields, `slots`). */
export type Props<C> = Partial<Omit<C, keyof Component>>;

let collecting: Binding | undefined;
let holder: Holder | undefined;
/** Building under a markup value: handlers and once-values are kept as bindings (`MARKED`). */
let marking = false;
/** Claim mode: the old bindings not taken yet, in creation order; `failed` once a call didn't match. */
let claiming = false;
let cursor: Binding | undefined;
let failed = false;
/** The keyed loop running now claims the rows it keeps. */
let reclaim = false;
/** The `@{ }` block running now: where `dom.piece` takes its pieces. */
let pieces: Pieces | undefined;
/** The last `@{ }` block run's number: unique across blocks, so a site's scan cursor can't be mistaken for another run's. */
let runs = 0;
/** Building or claiming a markup statement that reads the block's `let`s: what it binds is `LOCAL`. */
let local = false;
/** What a claimed build appends to, and the node `el`/`anchor` give it: nothing is built during a claim. */
const CLAIM_PARENT = { appendChild: (n: Node): Node => n } as unknown as Node;

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
    /** TEXT: its Text; ATTR: its element; REGION and LIST: the comment that ends them. */
    public node: Node,
    /** TEXT and ATTR: the value; REGION: builds into its argument; LIST: the items. */
    public read: (a?: any, b?: any) => unknown,
    /** TEXT: its holder; ATTR: its name (ITEM: its row; BAG: its holder); REGION: its `Region`; LIST: its `ListState`. */
    public data: any,
  ) {}

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
    if ((this.flags & (LOOSE | DEAD | PAUSE | LOCAL)) !== 0 || kind === EFFECT || kind === MEMO) return;
    this.flags |= LOOSE;
    (ctxOf(this).$loose ??= []).push(this);
  }

  #run(parent?: Node): unknown {
    const prev = collecting;
    const reader = Component.$reader;
    collecting = this;
    Component.$reader = collect as unknown as typeof Component.$reader;
    this.#reset();
    try {
      if ((this.flags & BAG) !== 0) return runBag(this);
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
    if ((flags & PIECES) !== 0) return this.#pieces();
    switch (flags & KIND) {
      case TEXT: {
        const value = this.#run();
        if (isMarkup(value)) return this.#becomeContent(value);
        const text = textOf(value);
        const node = this.node as Text;
        if (node.data !== text) node.data = text;
        return;
      }
      case ATTR:
        if ((flags & BAG) !== 0) return void this.#run();
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
        return this.#rebuild();
      }
      case LIST:
        return reconcile(this, this.#run() as Iterable<unknown>);
      case KEYED: {
        const keyed = this.data as Keyed;
        const was = marking;
        marking = (flags & MARKED) !== 0;
        try {
          keyed.order = this.#run() as Row[];
        } finally {
          marking = was;
        }
        return;
      }
      case EFFECT:
        this.#run();
        return;
      case MEMO:
        return;
      case COMPONENT:
        return $child(this.data as Child, this.#run() as Record<string, unknown>);
    }
  }

  // A region builds anew: its branch, else its read.
  #rebuild(): void {
    const region = this.data as Region;
    const branch = region.branch;
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
    within(region, () => (branch !== undefined ? untracked(() => branch(frag)) : this.#run(frag)), (this.flags & MARKED) !== 0);
    parent.insertBefore(frag, end);
  }

  // A `@{ }` block runs: each `dom.piece` claims last run's next piece of its site, else builds one; the pieces
  // not taken go, and the run's are put in order.
  #pieces(): void {
    const s = this.data as Pieces;
    const old = s.now;
    s.now = s.old;
    s.old = old;
    s.run = ++runs;
    s.at = 0;
    const prev = pieces;
    const outer = holder;
    const was = marking;
    pieces = s;
    holder = s;
    marking = true;
    try {
      this.#run(CLAIM_PARENT);
    } finally {
      // A throw in the block's code or a piece's binding: the globals and the pieces are set right whatever it does.
      pieces = prev;
      holder = outer;
      marking = was;
      for (let i = 0; i < old.length; i++) if (old[i]!.run !== s.run) dropRow(old[i]!);
      place(this.node, old, s.now);
      old.length = 0;
    }
  }

  /** @internal After a claim re-pointed it: runs once; a region, list or loop claims what it holds the same way. */
  $repoint(): void {
    const flags = this.flags;
    if ((flags & DEAD) !== 0) return;
    if ((flags & SHOW) !== 0) return this.#claimShow();
    if ((flags & CONTENT) !== 0) return this.#claimContent();
    // A block's run claims its pieces itself.
    if ((flags & PIECES) !== 0) return this.#pieces();
    switch (flags & KIND) {
      case REGION:
        return this.#claimRegion();
      case LIST:
        return this.#claimList();
      case KEYED: {
        const prev = reclaim;
        reclaim = true;
        try {
          this.stateHasChanged();
        } finally {
          reclaim = prev;
        }
        return;
      }
      case EFFECT:
        // An `@await` call's request (no state) goes again only when its arguments change.
        if (this.data !== undefined) this.stateHasChanged();
        return;
      case HANDLER:
      case ONCE:
      case REF:
        return;
      default:
        this.stateHasChanged();
    }
  }

  // The same branch keeps its DOM and claims its bindings; another builds anew, as does a failed claim.
  #claimRegion(): void {
    const region = this.data as Region;
    const branch = region.branch;
    if (branch !== undefined) {
      const index = this.#run() as number;
      if (index === region.index && reclaimed(region, branch, undefined)) return;
      region.index = index;
    } else if (this.#claimRun(region)) return rerun(region);
    this.#rebuild();
  }

  // A region's build runs tracked, as when it builds, in claim mode.
  #claimRun(region: Region): boolean {
    const outer = claimBegin(region);
    let ok = false;
    try {
      this.#run(CLAIM_PARENT);
      ok = true;
    } finally {
      ok = claimEnd(region, outer) && ok;
    }
    return ok;
  }

  // Every row claims its bindings with the new build and reads; then the new items reconcile as usual.
  #claimList(): void {
    const state = this.data as ListState;
    const order = state.order;
    let gone = false;
    for (let i = 0; i < order.length; i++) {
      const row = order[i]!;
      const empty = row.item === EMPTY;
      const build = empty ? state.empty : state.build;
      if (!empty) row.reads = state.reads;
      if (build === undefined || !reclaimed(row, build, row.item)) {
        dropRow(row);
        row.item = GONE;
        gone = true;
      }
    }
    // A row whose claim failed goes; the reconcile after builds it anew.
    if (gone) for (const [key, r] of state.rows) if (r.item === GONE) state.rows.delete(key);
    reconcile(this, this.#run() as Iterable<unknown>);
  }

  // ponytail: hidden branches close over the old value, so a block that built more than the shown one builds anew.
  #claimShow(): void {
    const show = this.data as Show;
    const index = this.#run() as number;
    const branches = show.branches;
    const kept = index === show.index ? branches[index] : undefined;
    let alone = kept !== undefined;
    for (let i = 0; i < branches.length; i++) if (branches[i] !== undefined && branches[i] !== kept) alone = false;
    if (alone && reclaimed(kept!, show.build, undefined)) return;
    for (const branch of branches) if (branch !== undefined) disposeAll(branch);
    for (let node = show.start.nextSibling!; node !== this.node; ) {
      const next = node.nextSibling!;
      leave(node);
      node = next;
    }
    branches.length = 0;
    show.index = -1;
    this.#show();
  }

  // A same-site value claims (`#fill`); a kept fallback is the new one, claimed the same way.
  #claimContent(): void {
    const c = this.data as Content;
    const index = c.index;
    this.stateHasChanged();
    if (c.index !== index || shows(c.value) !== 2 || c.branch === undefined || reclaimed(c, c.branch, undefined)) return;
    this.#fill(c, c.value);
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
    within(branch, () => untracked(() => show.build(frag)), (this.flags & MARKED) !== 0);
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
    const prev = c.value;
    const text = kind === 0 && c.index !== -1 && shows(prev) === 0;
    c.value = value;
    if (text) {
      const node = end.previousSibling as Text;
      const data = textOf(value);
      if (node.data !== data) node.data = data;
      return;
    }
    // A new index: `refreshAll` leaves what was just built alone.
    c.index++;
    // Another owner's value (an instance of the same class) builds anew: what it holds is bound to its owner.
    if (kind === 1 && isMarkup(prev) && prev[SITE] !== undefined && prev[SITE] === (value as Markup)[SITE] && prev[MARKUP] === (value as Markup)[MARKUP] && claim(c, value as Markup)) return;
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
      if (build !== undefined) buildMarkup(c, build, frag, kind === 1 || (this.flags & MARKED) !== 0);
    }
    end.parentNode!.insertBefore(frag, end);
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
    else if ((this.flags & PIECES) !== 0) for (const piece of (this.data as Pieces).now) disposeAll(piece);
    else if (kind === REGION) disposeAll(this.data as Region);
    else if (kind === LIST || kind === KEYED) for (const row of (this.data as ListState | Keyed).order) disposeAll(row);
    else if (kind === COMPONENT) $dropChild(this.data as Child);
    else if ((this.flags & OWNED) !== 0) undoAttr(this.node as Element, this.data as Owned);
    // Dead first, so dropping its sources does not make it loose.
    this.flags |= DEAD;
    this.#reset();
    this.#sweep();
    this.flags = DEAD;
  }
}

/** The component `b` was built in, from its data: the same wherever it re-runs. */
function ctxOf(b: Binding): Ctx {
  const flags = b.flags;
  if ((flags & CONTENT) !== 0) return (b.data as Content).owner;
  if ((flags & SHOW) !== 0) return (b.data as Show).ctx;
  switch (flags & KIND) {
    case LIST:
      return (b.data as ListState).ctx;
    case KEYED:
      return (b.data as Keyed).at.$ctx;
    case COMPONENT:
      return (b.data as Child).ctx;
    case ATTR:
      if ((flags & BAG) !== 0) return (b.data as Bag).at.$ctx;
      if ((flags & ITEM) !== 0) return (b.data as Holder).$ctx;
      if ((flags & OWNED) !== 0) return (b.data as Owned).ctx;
      return ((b.node as Target)[HOLDER] as Holder).$ctx;
    // TEXT: its holder; REGION: its region.
    default:
      return (b.data as Holder).$ctx;
  }
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

// What the handler changed shows before it returns.
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

function within(h: Holder, run: () => void, mark = marking): void {
  const prev = holder;
  const was = marking;
  holder = h;
  marking = mark;
  try {
    run();
  } finally {
    holder = prev;
    marking = was;
  }
}

function track(b: Binding): void {
  const h = holder!;
  if (marking) b.flags |= MARKED;
  if (local) b.flags |= LOCAL;
  b.next = h.$bindings as Binding | undefined;
  h.$bindings = b;
  b.stateHasChanged();
}

// Builds `c`'s markup (or fallback) untracked, with `c` holding what it binds.
function buildMarkup(c: Content, build: Build, parent: Node, mark: boolean): void {
  const prev = collecting;
  const reader = Component.$reader;
  collecting = undefined;
  Component.$reader = undefined;
  try {
    within(c, () => build(parent), mark);
  } finally {
    collecting = prev;
    Component.$reader = reader;
  }
}

/**
 * Runs `value` (from the site `c` shows) against `c`'s old bindings: each `dom.*` call takes the next one and
 * re-points it; then they all run once, and equal values touch nothing. False when a call didn't match.
 */
function claim(c: Content, value: Markup): boolean {
  if (!claimBuild(c, value, undefined)) return false;
  rerun(c);
  return true;
}

// Claim mode for `h`: its bindings, prepended as made, reversed into creation order for the calls to take.
function claimBegin(h: Holder): Holder | undefined {
  let first: Binding | undefined;
  for (let b = h.$bindings as Binding | undefined; b !== undefined; ) {
    const next = b.next;
    b.next = first;
    first = b;
    b = next;
  }
  h.$bindings = undefined;
  const outer = holder;
  holder = h;
  claiming = true;
  cursor = first;
  failed = false;
  return outer;
}

// Whether every call matched; what wasn't taken goes back too, for a rebuild to dispose.
function claimEnd(h: Holder, outer: Holder | undefined): boolean {
  const ok = !failed && cursor === undefined;
  for (let b = cursor; b !== undefined; ) {
    const next = b.next;
    b.next = h.$bindings as Binding | undefined;
    h.$bindings = b;
    b = next;
  }
  claiming = false;
  cursor = undefined;
  holder = outer;
  return ok;
}

/** Runs `build` (untracked) in claim mode against `h`'s bindings. */
function claimBuild(h: Holder, build: (parent: Node, item?: any) => unknown, item: unknown): boolean {
  const prev = collecting;
  const reader = Component.$reader;
  collecting = undefined;
  Component.$reader = undefined;
  const outer = claimBegin(h);
  let ok = false;
  try {
    build(CLAIM_PARENT, item);
    ok = true;
  } finally {
    ok = claimEnd(h, outer) && ok;
    collecting = prev;
    Component.$reader = reader;
  }
  return ok;
}

/** After a claim: each re-pointed binding of `h` runs once; what holds bindings claims them in turn. */
function rerun(h: Holder): void {
  const prev = collecting;
  const reader = Component.$reader;
  collecting = undefined;
  Component.$reader = undefined;
  try {
    for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) b.$repoint();
  } finally {
    collecting = prev;
    Component.$reader = reader;
  }
}

// A claimed row or branch: run again on success.
function reclaimed(h: Holder, build: (parent: Node, item?: any) => unknown, item: unknown): boolean {
  if (!claimBuild(h, build, item)) return false;
  rerun(h);
  return true;
}

/** The next old binding, when its shape is `shape` (or `alt`); else the claim fails. */
function take(shape: number, alt = shape): Binding | undefined {
  const b = cursor;
  const s = b === undefined ? -1 : b.flags & SHAPE;
  if (failed || b === undefined || (s !== shape && s !== alt)) {
    failed = true;
    return undefined;
  }
  cursor = b.next;
  const h = holder!;
  b.next = h.$bindings as Binding | undefined;
  h.$bindings = b;
  return b;
}

function claimRead(shape: number, read: (a?: any, b?: any) => unknown, alt = shape): void {
  const b = take(shape, alt);
  if (b !== undefined) b.read = read;
}

// ponytail: `@Routes` in a markup value can't be claimed: the claim fails and the value rebuilds.
function unclaimable(): boolean {
  if (claiming) failed = true;
  return claiming;
}

/**
 * A value `@once` sets: in a markup value it is kept as a binding (`data` the value), whose node a claim writes
 * when the value is another. `undefined`: write `node`; a binding: write its node, then give it the value; `null`: nothing.
 */
function once(node: Node, value: unknown): Binding | null | undefined {
  if (claiming) {
    const b = take(ONCE);
    return b === undefined || Object.is(b.data, value) ? null : b;
  }
  if (marking) track(new Binding(ONCE, node, noop, value));
  return undefined;
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
  // A `@cascade` effect gives its consumers the value and, ahead of its region, owes them the notice.
  let owed: CascadeRecord | undefined;
  for (let b = h.$bindings as Binding | undefined; b !== undefined; b = b.next) {
    const due = owed;
    owed = undefined;
    const kind = b.flags & KIND;
    const kept = kind === REGION ? (b.data as Region).index : -1;
    if (kind === EFFECT) {
      refreshing = b.data;
      try {
        b.stateHasChanged();
      } finally {
        refreshing = undefined;
      }
      if (b.data !== undefined && (b.data as CascadeRecord).held) owed = b.data as CascadeRecord;
    } else b.stateHasChanged();
    if ((b.flags & SHOW) !== 0) for (const branch of (b.data as Show).branches) branch !== undefined && refreshAll(branch);
    else if (kind === LIST || kind === KEYED) for (const row of (b.data as ListState | Keyed).order) refreshAll(row);
    else if (kept !== -1 && kept === (b.data as Region).index) refreshAll(b.data as Region);
    if (due !== undefined) $release(due);
  }
}

/** Calls `f` with each holder right under `b`: a region's, a list's rows, a show block's built branches, a child component. */
function under(b: Binding, f: (h: Holder) => void): void {
  const kind = b.flags & KIND;
  if ((b.flags & SHOW) !== 0) for (const branch of (b.data as Show).branches) branch !== undefined && f(branch);
  else if ((b.flags & PIECES) !== 0) for (const piece of (b.data as Pieces).now) f(piece);
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
type Owned = { name: string; text: string | undefined; prev: string | null | undefined; added: string[]; ctx: Ctx };
/** An `@attributes` binding's state: `read` gives the bag; `prev` is the last one. */
type Bag = { at: Holder; prev: Record<string, unknown> | null | undefined; skip: readonly string[] | undefined; pre: BagPre | undefined };

function runBag(b: Binding): unknown {
  const s = b.data as Bag;
  const bag = b.read() as Record<string, unknown> | null | undefined;
  writeBag(b.node as Element, s.prev, bag, s.skip, s.pre);
  s.prev = bag;
  return bag;
}

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

/** `skip` names are written after the bag (they win); `pre` is `name, value | read, ...` written before it (the bag wins while it has the key). `class:x` entries are toggles, applied after everything. */
type BagPre = readonly (string | boolean | (() => unknown))[];

const valueOf = (v: unknown): unknown => (typeof v === "function" ? v() : v);

const hasPre = (pre: BagPre, name: string): boolean => {
  for (let i = 0; i < pre.length; i += 2) if (pre[i] === name) return true;
  return false;
};

// ponytail: the same bag object, mutated and given again, can't show which keys it lost.
// Runs inside the binding's read, so what `pre` reads is tracked with the bag.
function writeBag(el: Element, prev: Record<string, unknown> | null | undefined, bag: Record<string, unknown> | null | undefined, skip: readonly string[] | undefined, pre: BagPre | undefined): void {
  if (prev != null)
    for (const name in prev) if ((bag == null || !(name in bag)) && !skip?.includes(name) && !(pre !== undefined && hasPre(pre, name))) setAttr(el, name, null);
  if (pre !== undefined)
    for (let i = 0; i < pre.length; i += 2) {
      const name = pre[i] as string;
      if (name.startsWith("class:")) continue;
      const value = valueOf(pre[i + 1]);
      if (skip?.includes(name) || (bag != null && name in bag)) continue;
      if (typeof pre[i + 1] === "function" || (prev != null && name in prev)) setAttr(el, name, value);
    }
  if (bag != null) for (const name in bag) if (!skip?.includes(name)) setAttr(el, name, bag[name]);
  if (pre !== undefined)
    for (let i = 0; i < pre.length; i += 2) if ((pre[i] as string).startsWith("class:")) setAttr(el, pre[i] as string, valueOf(pre[i + 1]));
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
function newRow(ctx: Ctx, scope: unknown, item: unknown, reads: Reads | undefined, build: (parent: Node, item: any) => void, mark: boolean): Row {
  const frag = document.createDocumentFragment();
  const row: Row = { $bindings: undefined, $ctx: ctx, $scope: scope, head: frag, tail: frag, item, reads, set: undefined };
  within(row, () => build(frag, item), mark);
  seal(row, frag);
  return row;
}

// ponytail: a fragment per row, not one per run: in happy-dom a shared one costs heap and saves no time; recheck in a real browser.
/** Gives `row` its fragment's nodes; at least one, so it always has a place. */
function seal(row: Span, frag: DocumentFragment): void {
  if (frag.firstChild === null) frag.appendChild(document.createComment(""));
  row.head = frag.firstChild!;
  row.tail = frag.lastChild!;
}

function dropRow(row: Span): void {
  disposeAll(row);
  removeRange(row.head, row.tail);
}

// Kept rows keep their nodes and bindings, and only move when out of place; new ones come out of their fragment.
function place(end: Node, old: readonly Span[], order: readonly Span[]): void {
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
  const mark = (list.flags & MARKED) !== 0;
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    let row = rows.get(keys[i]);
    if (row === undefined) {
      row = item === EMPTY ? newRow(state.ctx, state.scope, item, undefined, state.empty!, mark) : newRow(state.ctx, state.scope, item, state.reads, state.build, mark);
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
// row there and then, while the loop's state is the pass's own, into the node `pass` returns. Under a claim
// (`reclaim`), a kept row's pass builds in claim mode against its bindings.
function runKeyed(s: Keyed, end: Node, run: (pass: Pass) => void): Row[] {
  const claim = reclaim;
  reclaim = false;
  const order: Row[] = [];
  const seen = new Set<unknown>();
  const outer = holder;
  let building: Row | undefined;
  let claimed: Row | undefined;
  let claimedKey: unknown;
  let again = false;
  const finish = (): void => {
    if (claimed !== undefined) {
      const row = claimed;
      claimed = undefined;
      if (claimEnd(row, outer)) return rerun(row);
      dropRow(row);
      s.rows!.delete(claimedKey);
      order.pop();
      again = true;
      return;
    }
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
        if (!claim) return undefined;
        claimed = row;
        claimedKey = key;
        claimBegin(row);
        return CLAIM_PARENT;
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
    if (claimed !== undefined) claimEnd(claimed, outer);
    holder = outer;
  }
  // A kept row that didn't claim went: the loop runs again to build it.
  if (again) return runKeyed(s, end, run);
  if (order.length === 0 && s.empty !== undefined) {
    const rows = (s.rows ??= new Map());
    let row = rows.get(EMPTY);
    if (row !== undefined && claim && !reclaimed(row, s.empty, undefined)) {
      dropRow(row);
      row = undefined;
    }
    if (row === undefined) rows.set(EMPTY, (row = newRow(s.at.$ctx, s.at.$scope, EMPTY, undefined, s.empty, marking)));
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

// A replaced global document (a test registering a new window) has none of the listeners.
let listening: Document | undefined;

function keyOf(type: string): symbol {
  if (listening !== document) {
    listening = document;
    keys.clear();
  }
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
  Object.defineProperty(e, "currentTarget", { configurable: true, value: node });
  if (handler instanceof Binding) {
    runHandler(handler, e);
    return e.cancelBubble;
  }
  const h = node[HOLDER] as Holder & Partial<Row>;
  // A number: the index of the row's read that gives the handler, read now so a claim's new reads count.
  if (typeof handler === "number") afterHandler(h.$ctx, h.reads![handler]!(h.item)(e));
  else afterHandler(h.$ctx, h.reads !== undefined ? handler(h.item)(e) : handler(e));
  return e.cancelBubble;
}

// A handler kept as a binding: what it runs is what the last claim gave it.
function runHandler(b: Binding, e: Event): void {
  const mods = b.slot;
  const run = b.read as ((e: Event) => unknown) | undefined;
  if (run === undefined && mods === 0) return;
  if ((mods & 1) !== 0) e.preventDefault();
  if ((mods & 2) !== 0) e.stopPropagation();
  afterHandler((b.data as Holder).$ctx, run?.(e));
}

/** Calls the handlers from the target up, as bubbling would; a row's handler comes from its item. */
function dispatch(e: Event): void {
  for (let node = e.target as Target | null; node !== null && !fire(node, e); node = node.parentNode as Target | null);
}

function dispatchAtTarget(e: Event): void {
  if (!e.bubbles && e.target !== null) fire(e.target as Target, e);
}

function on(el: Element, event: string, handler: ((e: any) => unknown) | number, h: Holder): void {
  if (DELEGATED.has(event)) {
    const target = el as unknown as Record<symbol, unknown>;
    target[keyOf(event)] = handler;
    target[HOLDER] = h;
  } else el.addEventListener(event, (e) => afterHandler(h.$ctx, (handler as (e: any) => unknown)(e)));
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

const anchor = (parent: Node): Comment => (claiming ? (CLAIM_PARENT as Comment) : parent.appendChild(document.createComment("")));

/** An `@await`'s state; the arms, the read (`awaitAt`) or the call and its arguments (`awaitCallAt`) are fields, so a claim re-points them. */
type Await = {
  phase: number;
  value: unknown;
  seq: number;
  pending: Build | undefined;
  then: ((parent: Node, value: any) => void) | undefined;
  fail: ((parent: Node, error: unknown) => void) | undefined;
  read: (() => unknown) | undefined;
  args: (() => unknown[]) | undefined;
  call: ((...args: unknown[]) => unknown) | undefined;
  last: unknown[] | undefined;
};

function arms(s: Await, pending: Await["pending"], then: Await["then"], fail: Await["fail"]): Await {
  s.pending = pending;
  s.then = then;
  s.fail = fail;
  return s;
}

/** `@await`'s view before `end`; the function it gives shows what a request returned, a promise once it settles. */
function awaiting(end: Comment, s: Await): (result: unknown) => void {
  const view = new Binding(REGION, end, (p: Node) => {
    if (s.phase === 0) s.pending?.(p);
    else if (s.phase === 1) s.then?.(p, s.value);
    else s.fail?.(p, s.value);
  }, { $bindings: undefined, $ctx: holder!.$ctx, $scope: holder!.$scope, start: end.previousSibling as Comment, item: undefined, branch: undefined, index: -1 } satisfies Region);
  const show = (phase: number, value: unknown): void => {
    if ((view.flags & DEAD) !== 0) return;
    s.phase = phase;
    s.value = value;
    view.stateHasChanged();
  };
  track(view);
  return (result) => {
    const seq = ++s.seq;
    if (typeof (result as PromiseLike<unknown> | null)?.then !== "function") return show(1, result);
    if (s.phase !== 0) show(0, undefined);
    (result as PromiseLike<unknown>).then(
      (value) => seq === s.seq && show(1, value),
      (error) => {
        if (seq !== s.seq) return;
        show(2, error);
        if (s.fail === undefined) queueMicrotask(() => { throw error; });
      },
    );
  };
}

/** A `@slot`'s region: the fill and arguments it was given, and the markup they made last. */
type Slot = Content & { fill: () => ((...args: unknown[]) => unknown) | null | undefined; args: (() => unknown[]) | undefined; last: unknown; lastArgs: readonly unknown[]; markup: unknown };

function slotRead(s: Slot): unknown {
  const f = s.fill();
  const a = s.args === undefined ? NO_ARGS : s.args();
  if (f === s.last && sameValues(a, s.lastArgs)) return s.markup;
  s.last = f;
  s.lastArgs = a;
  return (s.markup = f?.(...a));
}

// Untracked: what the consumers' hooks read is theirs, not the provider's.
const provide = (record: CascadeRecord, value: () => unknown) => (): void => {
  const v = value();
  untracked(() => $cascade(record, v, refreshing === record));
};

/** A claimed child binding with the same type and key: its props are `props` now; another type or key fails the claim. */
function claimChild(shape: number, type: Function, props: (a?: any) => unknown, key: unknown): Child | undefined {
  const b = take(shape);
  if (b === undefined) return undefined;
  const child = b.data as Child;
  if (child.type !== type || child.key !== key) {
    failed = true;
    return undefined;
  }
  b.read = props;
  return child;
}

// A row's region or branch, claimed: the row's new read, and its item.
function claimItemRegion(row: Row, i: number, flags = 0): void {
  const b = take(REGION | ITEM | flags);
  if (b === undefined) return;
  b.read = row.reads![i]!;
  (b.data as Region).item = row.item;
}

function pieced(start: Comment, end: Comment, build: (a?: any, b?: any) => unknown, item: unknown, flags: number): void {
  const h = holder!;
  const s: Pieces = { $bindings: undefined, $ctx: h.$ctx, $scope: h.$scope, start, item, branch: undefined, index: -1, old: [], now: [], run: 0, at: 0 };
  track(new Binding(REGION | PIECES | flags, end, build, s));
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
      // A claim navigates the master, never inserted nor changed.
      if (claiming) return (node ??= build());
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
    if (claiming) return CLAIM_PARENT as El<K>;
    return parent.appendChild(inSvg(parent) ? document.createElementNS(SVG, tag) : document.createElement(tag)) as El<K>;
  },

  /** `@ref` on an element: `set` gives the target the element. In a markup value a claim gives the new target the element it kept. */
  ref<E extends Element>(el: E, set: (el: E) => void): void {
    if (claiming) {
      const b = take(REF);
      if (b === undefined) return;
      b.read = set as Binding["read"];
      set(b.node as E);
      return;
    }
    if (marking) track(new Binding(REF, el, set as Binding["read"], holder!));
    set(el);
  },

  /** A handler; afterwards the component re-runs its bindings that read nothing tracked. `mods`: 1 preventDefault, 2 stopPropagation. */
  on(el: Element, event: string, handler: ((e: any) => unknown) | undefined, mods = 0): void {
    // In a markup value: kept as a binding, so a claim gives it the new handler.
    if (claiming) {
      const b = take(HANDLER);
      if (b !== undefined) {
        b.read = handler as Binding["read"];
        b.slot = mods;
      }
      return;
    }
    const h = holder!;
    if (marking) {
      const b = new Binding(HANDLER, el, handler as Binding["read"], h);
      b.slot = mods;
      track(b);
      if (DELEGATED.has(event)) {
        const target = el as unknown as Record<symbol, unknown>;
        target[keyOf(event)] = b;
        target[HOLDER] = h;
      } else el.addEventListener(event, (e) => runHandler(b, e));
      return;
    }
    if (mods !== 0) handler = modified(handler, mods);
    else if (handler === undefined) return;
    const run = handler;
    // The dispatcher asks a row with shared reads for the handler of its item.
    on(el, event, (h as Partial<Row>).reads !== undefined && DELEGATED.has(event) ? () => run : run, h);
  },

  /** A row's handler: `reads[i](item)` gives it, read when the event comes; `mods` as `on`'s. */
  onItem(el: Element, event: string, i: number, mods = 0): void {
    if (claiming) return;
    const row = holder as Row;
    if (mods === 0) {
      if (DELEGATED.has(event)) on(el, event, i, row);
      else el.addEventListener(event, (e) => afterHandler(row.$ctx, row.reads![i]!(row.item)(e)));
      return;
    }
    // Built once per element: the modifiers apply in it, not in a closure made per event.
    const run = (e: Event): unknown => {
      if ((mods & 1) !== 0) e.preventDefault();
      if ((mods & 2) !== 0) e.stopPropagation();
      return row.reads![i]!(row.item)?.(e);
    };
    if (DELEGATED.has(event)) on(el, event, () => run, row);
    else el.addEventListener(event, (e) => afterHandler(row.$ctx, run(e)));
  },

  /** A callback passed to a child: runs `handler` (with `owner` as `this`), then `owner`'s after-handler pass (else the context building it). */
  callback<T = void>(owner: Component | undefined, handler: (arg: T) => unknown): EventCallback<T> {
    const ctx = owner ?? holder!.$ctx;
    return (arg: T) => {
      const result = handler.call(owner, arg);
      afterHandler(ctx, result);
      return result;
    };
  },

  /** Static text. */
  t(parent: Node, text: string): void {
    if (claiming) return;
    parent.appendChild(document.createTextNode(text));
  },

  /** Text that follows `read()`; markup (a `RenderFragment`) renders as markup. */
  text(parent: Node, read: () => unknown): void {
    if (claiming) return claimRead(TEXT, read, REGION | CONTENT);
    dom.textAt(parent.appendChild(document.createTextNode("")), read);
  },

  textAt(node: Text, read: () => unknown): void {
    if (claiming) return claimRead(TEXT, read, REGION | CONTENT);
    track(new Binding(TEXT, node, read, holder!));
  },

  textItem(node: Text, i: number): void {
    const row = holder as Row;
    if (claiming) return claimRead(TEXT | ITEM, row.reads![i]!, REGION | CONTENT | ITEM);
    track(new Binding(TEXT | ITEM, node, row.reads![i]!, row));
  },

  /** Attribute `name` of `el` that follows `read()`; `false`/`null`/`undefined` remove it. */
  attr(el: Element, name: string, read: () => unknown): void {
    if (claiming) return claimRead(ATTR, read);
    // Its element remembers the holder, so the binding finds its component wherever it re-runs.
    (el as unknown as Target)[HOLDER] = holder!;
    track(new Binding(ATTR, el, read, name));
  },

  attrItem(el: Element, name: string, i: number): void {
    const row = holder as Row;
    const read = row.reads![i]! as Reads[number] & Named;
    read.$n = name;
    if (claiming) return claimRead(ATTR | ITEM, read);
    track(new Binding(ATTR | ITEM, el, read, row));
  },

  /** `@attributes="bag"` on `el`: the bag's values set as `attr`'s; keys the next bag lacks are removed. `skip` names the attributes written after it, which win; `pre` the ones written before it as `name, value | read` pairs (restored when the bag drops the key), plus every `class:x` as `"class:x", on | read`. */
  attrs(el: Element, read: () => Record<string, unknown> | null | undefined, skip?: readonly string[], pre?: BagPre): void {
    if (claiming) {
      const b = take(ATTR | BAG);
      if (b === undefined) return;
      b.read = read;
      const s = b.data as Bag;
      s.skip = skip;
      s.pre = pre;
      return;
    }
    track(new Binding(ATTR | BAG, el, read, { at: holder!, prev: undefined, skip, pre } satisfies Bag));
  },

  /** `@attributes` inside `@once`: the bag set once, then the `class:x` toggles of `pre`. */
  setAttrs(el: Element, bag: Record<string, unknown> | null | undefined, skip?: readonly string[], pre?: BagPre): void {
    const b = once(el, bag);
    if (b === null) return;
    writeBag(b === undefined ? el : (b.node as Element), b === undefined ? undefined : (b.data as typeof bag), bag, skip, pre);
    if (b !== undefined) b.data = bag;
  },

  /** `@attr:name` on the enclosing `el`, taken back off when the region or row holding it goes. */
  attrOf(el: Element, name: string, read: () => unknown): void {
    if (claiming) {
      const b = take(ATTR | OWNED);
      if (b === undefined) return;
      b.read = read;
      (b.data as Owned).ctx = holder!.$ctx;
      return;
    }
    track(new Binding(ATTR | OWNED, el, read, { name, text: undefined, prev: undefined, added: [], ctx: holder!.$ctx } satisfies Owned));
  },

  /** `@if`, `@switch`, a `@for` that is not a plain list, `@{ }`: rebuilt whenever what `build` read changes. */
  region(parent: Node, build: Build): void {
    if (claiming) return claimRead(REGION, build);
    region(anchor(parent), anchor(parent), build, undefined, 0);
  },

  /** A region between `end` and the comment before it. */
  regionAt(end: Comment, build: Build): void {
    if (claiming) return claimRead(REGION, build);
    region(end.previousSibling as Comment, end, build, undefined, 0);
  },

  /** A `@{ }` block with markup statements before `end`: re-run when what `build` read changes, its pieces kept (`piece`). */
  piecesAt(end: Comment, build: Build): void {
    if (claiming) return claimRead(REGION | PIECES, build);
    pieced(end.previousSibling as Comment, end, build, undefined, 0);
  },

  /** A row's `@{ }` block with markup statements: `reads[i](item, parent)` runs it; see `piecesAt`. */
  piecesItem(end: Comment, i: number): void {
    const row = holder as Row;
    if (claiming) return claimItemRegion(row, i, PIECES);
    pieced(end.previousSibling as Comment, end, row.reads![i]!, row.item, ITEM);
  },

  /**
   * A markup statement from markup literal `site`, in the block running now: `build` builds its nodes. Last run's
   * next piece of the same site, not taken yet, is claimed (`build` runs against its bindings, which then run
   * again); else, or when the claim doesn't match, a new piece builds into a fragment. Either way it is done when
   * this returns, so it reads the block's locals as the statement sees them. `own`: it reads the block's `let`s.
   */
  piece(site: unknown, build: Build, own = false): void {
    const s = pieces;
    // A statement run after its block's run (a timer's callback) builds into a fragment nothing shows.
    if (s === undefined) return build(document.createDocumentFragment());
    const was = local;
    local = own;
    try {
      const old = s.old;
      const run = s.run;
      // Where this site's scan stopped in this run (run numbers are unique across blocks), so no piece is scanned twice.
      const k = site as { $r?: number; $i?: number };
      let i = k.$r === run && k.$i! > s.at ? k.$i! : s.at;
      while (i < old.length && (old[i]!.site !== site || old[i]!.run === run)) i++;
      k.$r = run;
      k.$i = i + 1;
      if (i < old.length) {
        const p = old[i]!;
        p.run = run;
        if (i === s.at) while (++s.at < old.length && old[s.at]!.run === run);
        s.now.push(p);
        claimBegin(p);
        let ok = false;
        try {
          build(CLAIM_PARENT);
          ok = true;
        } finally {
          ok = claimEnd(p, s) && ok;
        }
        if (ok) return rerun(p);
        // Another shape: this piece builds anew, the others keep theirs.
        dropRow(p);
        s.now.pop();
      }
      const frag = document.createDocumentFragment();
      const p: Piece = { $bindings: undefined, $ctx: s.$ctx, $scope: s.$scope, head: frag, tail: frag, site, run };
      s.now.push(p);
      holder = p;
      try {
        build(frag);
      } finally {
        seal(p, frag);
        holder = s;
      }
    } finally {
      local = was;
    }
  },

  /** `@if`/`@switch` before `end`: `run()` gives the branch's index, `run(parent)` builds it; rebuilt only when the index changes. */
  branchAt(end: Comment, run: (parent?: Node) => number): void {
    if (claiming) {
      const b = take(REGION);
      if (b !== undefined) b.read = (b.data as Region).branch = run as Build;
      return;
    }
    region(end.previousSibling as Comment, end, run, undefined, 0, run as Build);
  },

  /** `@show:if`/`@show:switch` before `end`: `run()` picks a branch, `run(parent)` builds the one picked; see `#show`. */
  showAt(end: Comment, run: (parent?: Node) => number): void {
    if (claiming) {
      const b = take(REGION | SHOW);
      if (b !== undefined) b.read = (b.data as Show).build = run;
      return;
    }
    const show: Show = { ctx: holder!.$ctx, scope: holder!.$scope, start: end.previousSibling as Comment, index: -1, build: run, branches: [] };
    track(new Binding(REGION | SHOW, end, run, show));
  },

  /** `@pause { }` in a show branch, before `end`: built once; what it holds stops while the branch is hidden. */
  pauseAt(end: Comment, build: Build): void {
    if (claiming) {
      const b = take(REGION | PAUSE);
      if (b !== undefined) (b.data as Region).branch = build;
      return;
    }
    region(end.previousSibling as Comment, end, zero, undefined, PAUSE, build);
  },

  /** `@once(expr)`: `read()` once, untracked, into `node`; in a markup value, again when a claim gives a new `read`. */
  textOnce(node: Text, read: () => unknown): void {
    if (claiming) {
      const b = take(ONCE);
      if (b === undefined) return;
      b.read = read;
      node = b.node as Text;
    } else if (marking) track(new Binding(ONCE, node, read, holder!));
    const text = textOf(untracked(read));
    if (node.data !== text) node.data = text;
  },

  /**
   * `@once { }`: `build` once, untracked, before `end`; its values are set, not bound (in a markup value, set again
   * by a claim). `plain`: its structure is plain control flow, which a claim can't match: the claim fails first.
   */
  onceAt(end: Comment, build: Build, plain = false): void {
    if (claiming) {
      if (plain) failed = true;
      else untracked(() => build(CLAIM_PARENT));
      return;
    }
    const frag = document.createDocumentFragment();
    untracked(() => build(frag));
    end.parentNode!.insertBefore(frag, end);
  },

  /** An attribute set once, inside `@once`. */
  set(el: Element, name: string, value: unknown): void {
    const b = once(el, value);
    if (b === null) return;
    setAttr(b === undefined ? el : (b.node as Element), name, value);
    if (b !== undefined) b.data = value;
  },

  /** Text set once, inside `@once`. */
  setText(node: Text, value: unknown): void {
    const b = once(node, value);
    if (b === null) return;
    (b === undefined ? node : (b.node as Text)).data = textOf(value);
    if (b !== undefined) b.data = value;
  },

  /** A comment appended to `parent`: where a lone list or keyed loop goes. */
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
    if (claiming) {
      take(REGION);
      const e = take(EFFECT);
      if (e !== undefined) arms(e.data as Await, pending, then, fail).read = read;
      return;
    }
    const s: Await = { phase: 0, value: undefined, seq: 0, pending, then, fail, read, args: undefined, call: undefined, last: undefined };
    const show = awaiting(end, s);
    track(new Binding(EFFECT, end, () => show(s.read!()), s));
  },

  /**
   * `@await (f(a, b))`: as `awaitAt`, but `f` is called again only when an argument changes (`Object.is`) or
   * what `f` itself reads does, not on every change to what the arguments read.
   */
  awaitCallAt<A extends unknown[], R>(end: Comment, args: () => [...A], call: (...args: A) => R, pending: Build | undefined, then: ((parent: Node, value: Awaited<R>) => void) | undefined, fail: ((parent: Node, error: unknown) => void) | undefined): void {
    if (claiming) {
      take(REGION);
      const e = take(EFFECT);
      take(EFFECT);
      if (e === undefined) return;
      const s = arms(e.data as Await, pending, then, fail);
      s.args = args;
      s.call = call as Await["call"];
      return;
    }
    const s: Await = { phase: 0, value: undefined, seq: 0, pending, then, fail, read: undefined, args, call: call as Await["call"], last: undefined };
    const show = awaiting(end, s);
    const request = new Binding(EFFECT, end, () => show(s.call!(...s.last!)), undefined);
    track(new Binding(EFFECT, end, () => {
      const next = s.args!();
      const last = s.last;
      if (last !== undefined && next.every((v, i) => Object.is(v, last[i]))) return;
      s.last = next;
      if (last !== undefined) request.stateHasChanged();
    }, s));
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
    if (claiming) return claimItemRegion(row, i);
    region(end.previousSibling as Comment, end, row.reads![i]!, row.item, ITEM);
  },

  /** A row's `@if`/`@switch`: `reads[i](item)` picks the branch, `reads[i](item, parent)` builds it; see `branchAt`. */
  branchItem(end: Comment, i: number): void {
    const row = holder as Row;
    if (claiming) return claimItemRegion(row, i);
    const state: Region = { $bindings: undefined, $ctx: row.$ctx, $scope: row.$scope, start: end.previousSibling as Comment, item: row.item, branch: undefined, index: -1 };
    const b = new Binding(REGION | ITEM, end, row.reads![i]!, state);
    // Through the binding, so a claim's new read builds too.
    state.branch = (p) => b.read(state.item, p);
    track(b);
  },

  /** `@for (const item of items)`: one row per item, matched by identity; a row is built once. */
  list<T>(parent: Node, items: () => Iterable<T>, build: (parent: Node, item: T) => void): void {
    if (claiming) {
      const b = take(LIST);
      if (b === undefined) return;
      b.read = items;
      (b.data as ListState).build = build;
      return;
    }
    list(anchor(parent), items, undefined, build);
  },

  /** A list before `end`; its rows' bindings use `reads`, shared by the rows. `empty` builds its `else`; `key` matches rows. */
  listAt<T>(end: Comment, items: () => Iterable<T>, reads: readonly ((item: T, x?: any) => any)[], build: (parent: Node, item: T) => void, empty?: Build, key?: (item: T) => unknown): void {
    if (claiming) {
      const b = take(LIST);
      if (b === undefined) return;
      b.read = items;
      const s = b.data as ListState;
      s.reads = reads;
      s.build = build;
      s.empty = empty;
      s.key = key;
      return;
    }
    list(end, items, reads, build, empty, key);
  },

  /** A loop before `end` run in place: `run` calls `pass` once per pass; `empty` builds its `else`. */
  keyedAt(end: Comment, run: (pass: Pass) => void, empty?: Build): void {
    if (claiming) {
      const b = take(KEYED);
      if (b === undefined) return;
      const state = b.data as Keyed;
      const at = b.node;
      b.read = () => runKeyed(state, at, run);
      state.empty = empty;
      return;
    }
    const state: Keyed = { at: holder!, rows: undefined, order: NO_ROWS, empty };
    track(new Binding(KEYED, end, () => runKeyed(state, end, run), state));
  },

  /**
   * A child component before `end` (its end comment): `props` gives its value props, diffed against the last ones;
   * `statics` (callbacks) and `slots` are assigned once. `key` keys a `@cached` one; `onError` is `@catch`'s.
   * Claimed with the same type and key, the instance stays and takes the new statics and slots.
   */
  component<C extends Component>(end: Comment, type: new (...args: any[]) => C, props: () => Props<C>, statics?: Props<C>, slots?: C["slots"], ref?: (c: C) => void, key?: unknown, onError?: (err: unknown, nav: number) => void): void {
    if (claiming) {
      const child = claimChild(COMPONENT, type, props, key);
      if (child === undefined) return;
      child.statics = statics as Child["statics"];
      child.slots = slots;
      child.ref = ref as Child["ref"];
      child.onError = onError;
      const c = child.instance;
      if (c !== undefined) {
        if (statics !== undefined) Object.assign(c, statics);
        if (slots !== undefined) c.slots = slots;
      }
      return;
    }
    const h = holder!;
    const child: Child = { type: type as Child["type"], end, ctx: h.$ctx, scope: h.$scope as Child["scope"], props: undefined, statics: statics as Child["statics"], slots, ref: ref as Child["ref"], key, onError, nav: undefined, instance: undefined, phase: 0, item: undefined };
    track(new Binding(COMPONENT, end, props as () => Record<string, unknown>, child));
  },

  /**
   * A list row's child component: `reads[i](item)` gives its props; `reads[statics](item)` its callbacks and
   * `reads[slots](item)` its slot fills, given again when the row's item is replaced under the same key.
   */
  componentItem<C extends Component>(end: Comment, type: new (...args: any[]) => C, i: number, statics?: number, slots?: number, ref?: (c: C) => void, key?: unknown, onError?: (err: unknown, nav: number) => void): void {
    const row = holder as Row;
    const reads = row.reads!;
    if (claiming) {
      const child = claimChild(COMPONENT | ITEM, type, reads[i]!, key);
      if (child === undefined) return;
      child.statics = statics === undefined ? undefined : reads[statics];
      child.slots = slots === undefined ? undefined : reads[slots];
      child.ref = ref as Child["ref"];
      child.onError = onError;
      return $childItem(child, row.item);
    }
    const child: Child = { type: type as Child["type"], end, ctx: row.$ctx, scope: row.$scope as Child["scope"], props: undefined, statics: statics === undefined ? undefined : reads[statics], slots: slots === undefined ? undefined : reads[slots], ref: ref as Child["ref"], key, onError, nav: undefined, instance: undefined, phase: 0, item: row.item };
    track(new Binding(COMPONENT | ITEM, end, reads[i]!, child));
  },

  /**
   * `@slot` before `end` (and the comment before it): builds `fill()?.(...args())`, or `fallback` when there is no
   * fill. Called again when what they read changes and on the component's passes; rebuilt only when the fill or an
   * argument (`Object.is`) changed.
   */
  slotAt<A extends unknown[]>(end: Comment, fill: () => ((...args: A) => RenderFragment | null | undefined) | null | undefined, args?: () => [...A], fallback?: Build): void {
    if (claiming) {
      const b = take(REGION | CONTENT);
      if (b === undefined) return;
      const s = b.data as Slot;
      s.fill = fill as Slot["fill"];
      s.args = args;
      s.branch = fallback;
      return;
    }
    const ctx = holder!.$ctx;
    const s: Slot = { $bindings: undefined, $ctx: ctx, $scope: holder!.$scope, start: end.previousSibling as Comment, item: undefined, branch: fallback, index: -1, value: undefined, owner: ctx, fill: fill as Slot["fill"], args, last: undefined, lastArgs: NO_ARGS, markup: undefined };
    track(new Binding(REGION | CONTENT, end, () => slotRead(s), s));
  },

  /**
   * `@cascade:name(value[, fixed])` before `end` (and the comment before it): `build` once, its components given
   * `value()` under `name`. A change reaches them (assigned, `onParametersSet`, a pass); `fixed` keeps the first value.
   */
  cascadeAt(end: Comment, name: string, value: () => unknown, fixed: boolean, build: Build): void {
    if (claiming) {
      // The effect was moved ahead of the region: the region comes first in creation order.
      const r = take(REGION);
      if (r === undefined) return;
      const region = r.data as Region;
      const record = region.$scope as CascadeRecord;
      if (record.fixed !== fixed || record.name !== name) {
        failed = true;
        return;
      }
      region.branch = build;
      if (fixed) return;
      const e = take(EFFECT);
      if (e !== undefined) e.read = provide(record, value);
      return;
    }
    const h = holder!;
    const record: CascadeRecord = { name, value: undefined, fixed, consumers: undefined, parent: h.$scope as CascadeRecord | undefined, held: false };
    if (fixed) record.value = untracked(value);
    else track(new Binding(EFFECT, end, provide(record, value), record));
    const region: Region = { $bindings: undefined, $ctx: h.$ctx, $scope: record, start: end.previousSibling as Comment, item: undefined, branch: build, index: -1 };
    track(new Binding(REGION, end, zero, region));
    if (!fixed) {
      // A whole pass runs the effect first: the region's consumers are assigned before it re-runs them.
      const r = h.$bindings as Binding;
      const e = r.next!;
      r.next = e.next;
      e.next = r;
      h.$bindings = e;
    }
  },

  /**
   * `@Routes` before `end` (and the comment before it): the section matching the current navigation, with the page
   * as a child keyed by its route family; `route` is cascaded. A section is kept while it stays the matching one.
   */
  routesAt(end: Comment, table: RouteTable, sections: readonly RouteSection[]): void {
    if (unclaimable()) return;
    const h = holder!;
    const ctx = h.$ctx;
    const record: CascadeRecord = { name: "route", value: undefined, fixed: false, consumers: undefined, parent: h.$scope as CascadeRecord | undefined, held: false };
    const s = { $bindings: undefined, $ctx: ctx, $scope: record, start: end.previousSibling as Comment, item: undefined, branch: undefined, index: -1, table, sections, section: -1, failed: false, paged: false, page: undefined } as unknown as Routes;
    const b = new Binding(REGION | ROUTES, end, noop, s);
    s.router = $router(sections, () => b.stateHasChanged());
    s.route = $currentRoute(s.router);
    s.markup = markup((parent) => placePage(s, parent), ctx);
    track(b);
  },
};

/** The `@cascade` record whose effect `refreshAll` is running: its consumers wait for the region's pass. */
let refreshing: unknown;
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
  const child: Child = { type: entry.component as Child["type"], end: page.end, ctx: s.$ctx, scope: s.$scope as Child["scope"], props: undefined, statics: undefined, slots: undefined, ref: undefined, key: page.key, onError: r.onError, nav: r.id, instance: undefined, phase: 0, item: undefined };
  page.child = child;
  within(page, () => track(new Binding(COMPONENT, page.end, () => r.params, child)));
}

/** @internal Brands `build` as markup made in `owner`'s context (else the one building now), from markup literal `site`. */
export function markup(build: (parent: Node) => void, owner: Component | undefined, site?: unknown): Markup {
  const m = build as unknown as Record<symbol, unknown>;
  m[MARKUP] = owner ?? holder?.$ctx ?? null;
  m[SITE] = site;
  return build as Markup;
}

/** @internal Runs `c.render` into `parent`, untracked, with `c` holding its bindings. */
export function renderInto(c: Component, parent: Node): void {
  const prev = collecting;
  const reader = Component.$reader;
  const outer = holder;
  const was = marking;
  const own = local;
  collecting = undefined;
  Component.$reader = undefined;
  holder = c;
  // A child first built under a markup value is not markup: its handlers are plain, its bindings may be loose.
  marking = false;
  local = false;
  try {
    (c as unknown as { render(parent: Node): void }).render(parent);
  } finally {
    collecting = prev;
    Component.$reader = reader;
    holder = outer;
    marking = was;
    local = own;
  }
}

/** @internal A whole-component pass: re-runs every binding of `c`, for changes nothing tracks. */
export function refreshPass(c: Component): void {
  // Recomputes the cached getters too: what changed may be untracked.
  const memos = c.$memos as (Binding | undefined)[] | undefined;
  if (memos !== undefined) for (const m of memos) if (m !== undefined) m.flags &= ~FRESH;
  // A binding that now reads nothing tracked joins its component's loose list.
  const outer = holder;
  holder = c;
  try {
    refreshAll(c);
  } finally {
    holder = outer;
  }
}

/** @internal Disposes the bindings and cached getters of `c`. */
export function releaseDom(c: Component): void {
  const memos = c.$memos as (Binding | undefined)[] | undefined;
  if (memos !== undefined) {
    for (const m of memos) m?.dispose();
    c.$memos = undefined;
  }
  disposeAll(c);
}
