// zor runtime: the RenderTreeBuilder that generated components call into, and a DOM
// renderer that re-renders one component at a time and patches only what changed.

type Handler = (e: Event) => unknown;

export type VText = { kind: "text"; text: string; dom?: Text };

export type VElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  events: Record<string, Handler>;
  children: VNode[];
  dom?: Element;
};

/** Output of one `@if`/`@for`/`@switch`; its contents are diffed in isolation. */
export type VRegion = { kind: "region"; children: VNode[]; anchor?: Comment };

export type VComponent = {
  kind: "component";
  instance: ComponentBase;
  /** False when the parent passed the same props, so the child can skip re-rendering. */
  changed: boolean;
  mounted?: Mounted;
};

export type VNode = VText | VElement | VRegion | VComponent;

type Ctor<C extends ComponentBase> = new () => C;
type Mounted = { tree: VNode[]; anchor: Comment };

const childInstances = new WeakMap<ComponentBase, ComponentBase[]>();
const mountedComponents = new WeakMap<ComponentBase, Mounted>();
const elementHandlers = new WeakMap<Element, { owner: ComponentBase; events: Record<string, Handler>; listening: Set<string> }>();

const FRAGMENT: unique symbol = Symbol("zor.fragment");

/** Markup held as a value (Blazor's RenderFragment); render it with `@member`. */
export type RenderFragment = ((builder: RenderTreeBuilder) => void) & { readonly [FRAGMENT]: true };
export type Renderer = RenderFragment;

function isFragment(value: unknown): value is RenderFragment {
  return typeof value === "function" && FRAGMENT in value;
}

export abstract class ComponentBase {
  /** Wraps builder calls as a RenderFragment; zor emits this for markup inside `@code`. */
  static fragment(build: (builder: RenderTreeBuilder) => void): RenderFragment {
    return Object.assign(build, { [FRAGMENT]: true as const });
  }

  protected abstract buildRenderTree(builder: RenderTreeBuilder): void;

  /** Re-renders this component. Event handlers it owns do this automatically. */
  stateHasChanged(): void {
    update(this);
  }
}

export class RenderTreeBuilder {
  readonly #root: VNode[] = [];
  readonly #open: (VElement | VRegion)[] = [];
  #childIndex = 0;

  constructor(private readonly owner: ComponentBase) {}

  get nodes(): VNode[] {
    return this.#root;
  }

  #append(node: VNode): void {
    (this.#open.at(-1)?.children ?? this.#root).push(node);
  }

  #current(): VElement {
    const el = this.#open.at(-1);
    if (el?.kind !== "element") throw new Error("zor: attribute outside of an element");
    return el;
  }

  openElement(tag: string): void {
    const el: VElement = { kind: "element", tag, attrs: {}, events: {}, children: [] };
    this.#append(el);
    this.#open.push(el);
  }

  closeElement(): void {
    this.#open.pop();
  }

  openRegion(): void {
    const region: VRegion = { kind: "region", children: [] };
    this.#append(region);
    this.#open.push(region);
  }

  closeRegion(): void {
    this.#open.pop();
  }

  addAttribute(name: string, value: unknown): void {
    if (value === false || value == null) return;
    this.#current().attrs[name] = value === true ? "" : String(value);
  }

  addEventHandler<K extends keyof HTMLElementEventMap>(
    event: K,
    handler: (e: HTMLElementEventMap[K]) => unknown,
  ): void;
  addEventHandler(event: string, handler: Handler): void;
  addEventHandler(event: string, handler: (e: never) => unknown): void {
    this.#current().events[event] = handler as Handler;
  }

  addText(text: string): void {
    this.#append({ kind: "text", text });
  }

  addContent(value: unknown): void {
    if (isFragment(value)) {
      this.openRegion();
      value(this);
      this.closeRegion();
      return;
    }
    // An empty text node keeps the slot, so siblings stay aligned when content comes and goes.
    if (value === false || value == null) value = "";
    this.#append({ kind: "text", text: String(value) });
  }

  addComponent<C extends ComponentBase>(type: Ctor<C>, props: Partial<C>): void {
    const children = childInstances.get(this.owner) ?? [];
    childInstances.set(this.owner, children);
    const index = this.#childIndex++;
    let instance = children[index];
    let changed = false;
    if (!(instance instanceof type)) {
      instance = new type();
      children[index] = instance;
      changed = true;
    }
    const current = instance as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      // Like Blazor, objects may have been mutated, so they always count as changed.
      if (!Object.is(current[key], value) || (typeof value === "object" && value !== null)) changed = true;
    }
    Object.assign(instance, props);
    this.#append({ kind: "component", instance, changed });
  }
}

function render(component: ComponentBase): VNode[] {
  const builder = new RenderTreeBuilder(component);
  (component as unknown as { buildRenderTree(b: RenderTreeBuilder): void }).buildRenderTree(builder);
  return builder.nodes;
}

function update(component: ComponentBase): void {
  const m = mountedComponents.get(component);
  const parent = m?.anchor.parentNode;
  if (!m || !parent) return;
  const next = render(component);
  patchList(parent, m.tree, next, m.anchor, component);
  m.tree = next;
}

function mountComponent(component: ComponentBase): { nodes: Node[]; mounted: Mounted } {
  const tree = render(component);
  const mounted: Mounted = { tree, anchor: document.createComment("") };
  mountedComponents.set(component, mounted);
  const nodes = tree.flatMap((v) => create(v, component));
  return { nodes: [...nodes, mounted.anchor], mounted };
}

function listen(el: Element, event: string): void {
  elementHandlers.get(el)!.listening.add(event);
  el.addEventListener(event, (e) => {
    const record = elementHandlers.get(el);
    const handler = record?.events[event];
    if (!record || !handler) return;
    const result = handler(e);
    update(record.owner);
    if (result instanceof Promise) void result.then(() => update(record.owner));
  });
}

function create(v: VNode, owner: ComponentBase): Node[] {
  switch (v.kind) {
    case "text":
      v.dom = document.createTextNode(v.text);
      return [v.dom];
    case "element": {
      const el = document.createElement(v.tag);
      for (const [name, value] of Object.entries(v.attrs)) el.setAttribute(name, value);
      elementHandlers.set(el, { owner, events: v.events, listening: new Set() });
      for (const event of Object.keys(v.events)) listen(el, event);
      for (const child of v.children) el.append(...create(child, owner));
      v.dom = el;
      return [el];
    }
    case "region":
      v.anchor = document.createComment("");
      return [...v.children.flatMap((c) => create(c, owner)), v.anchor];
    case "component": {
      const { nodes, mounted } = mountComponent(v.instance);
      v.mounted = mounted;
      return nodes;
    }
  }
}

function nodesOf(v: VNode): Node[] {
  switch (v.kind) {
    case "text":
    case "element":
      return [v.dom!];
    case "region":
      return [...v.children.flatMap(nodesOf), v.anchor!];
    case "component":
      return [...v.mounted!.tree.flatMap(nodesOf), v.mounted!.anchor];
  }
}

function same(o: VNode, n: VNode): boolean {
  if (o.kind !== n.kind) return false;
  if (o.kind === "element") return o.tag === (n as VElement).tag;
  if (o.kind === "component") return o.instance === (n as VComponent).instance;
  return true;
}

function patch(o: VNode, n: VNode, owner: ComponentBase): void {
  switch (n.kind) {
    case "text": {
      const dom = (n.dom = (o as VText).dom!);
      if (dom.data !== n.text) dom.data = n.text;
      return;
    }
    case "element": {
      const old = o as VElement;
      const el = (n.dom = old.dom!);
      for (const name of Object.keys(old.attrs)) if (!(name in n.attrs)) el.removeAttribute(name);
      for (const [name, value] of Object.entries(n.attrs)) if (old.attrs[name] !== value) el.setAttribute(name, value);
      const record = elementHandlers.get(el)!;
      record.events = n.events;
      for (const event of Object.keys(n.events)) if (!record.listening.has(event)) listen(el, event);
      patchList(el, old.children, n.children, null, owner);
      return;
    }
    case "region": {
      const anchor = (n.anchor = (o as VRegion).anchor!);
      patchList(anchor.parentNode!, (o as VRegion).children, n.children, anchor, owner);
      return;
    }
    case "component":
      n.mounted = (o as VComponent).mounted;
      if (n.changed) update(n.instance);
      return;
  }
}

/** Positional diff; regions keep variable-length blocks from misaligning their siblings. */
function patchList(parent: Node, old: VNode[], next: VNode[], end: Node | null, owner: ComponentBase): void {
  for (let i = 0; i < next.length; i++) {
    const n = next[i]!;
    const o = old[i];
    if (o && same(o, n)) {
      patch(o, n, owner);
      continue;
    }
    const ref = o ? nodesOf(o)[0]! : end;
    for (const node of create(n, owner)) parent.insertBefore(node, ref);
    if (o) for (const node of nodesOf(o)) parent.removeChild(node);
  }
  for (const o of old.slice(next.length)) for (const node of nodesOf(o)) parent.removeChild(node);
}

export function mount<C extends ComponentBase>(type: Ctor<C>, host: Element): C {
  const root = new type();
  host.replaceChildren(...mountComponent(root).nodes);
  return root;
}
