import { expect, test } from "bun:test";
import {
  ComponentBase,
  type IApplication,
  type RenderFragment,
  type RenderTreeBuilder,
  Import,
  Run,
  Scoped,
  ServiceProvider,
  SharedInstance,
  Singleton,
  Transient,
  mount,
  polyfillDisposeSymbols,
} from "./index";

// `Symbol.dispose` is non-configurable where it exists, so the polyfill is tested on a stand-in.
test("polyfillDisposeSymbols fills missing dispose symbols and keeps native ones", () => {
  const bare: { dispose?: symbol; asyncDispose?: symbol } = {};
  polyfillDisposeSymbols(bare);
  expect(bare.dispose).toBe(Symbol.for("Symbol.dispose"));
  expect(bare.asyncDispose).toBe(Symbol.for("Symbol.asyncDispose"));

  const native = { dispose: Symbol("native"), asyncDispose: Symbol("nativeAsync") };
  const before = { ...native };
  polyfillDisposeSymbols(native);
  expect(native).toEqual(before);
  expect(typeof (Symbol as unknown as { dispose: unknown }).dispose).toBe("symbol");
});

// Written the way xzor emits components that take injected services.

class Hello extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("p");
    b.addText("hello");
    b.closeElement();
  }
}

class Needs extends ComponentBase {
  static readonly inject = ["dep"] as const;
  constructor(readonly dep: string) {
    super();
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("b");
    b.addContent(this.dep);
    b.closeElement();
  }
}

class Holder extends ComponentBase {
  declare slots: { default?: () => RenderFragment };
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("div");
    b.addContent(this.slots.default?.() ?? null);
    b.closeElement();
  }
}

class Middle extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addComponent(Needs, {});
  }
}

class Tree extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.addComponent(Middle, {});
    b.addComponent(Holder, {}, {
      default: () => ComponentBase.fragment((__b) => {
        __b.addComponent(Needs, {});
      }),
    });
  }
}

const host = () => document.createElement("div");
// Components keep an empty anchor comment after their nodes; compare markup without them.
const html = (el: Element) => el.innerHTML.replaceAll("<!---->", "");

test("mount accepts an element id", () => {
  const el = document.createElement("div");
  el.id = "app-by-id";
  document.body.append(el);
  mount(Hello, "app-by-id");
  expect(html(el)).toBe("<p>hello</p>");
  el.remove();
});

test("mount accepts a selector", () => {
  const root = document.createElement("div");
  root.id = "root";
  root.innerHTML = '<div class="slot"></div>';
  document.body.append(root);
  mount(Hello, "#root .slot");
  expect(html(root.querySelector(".slot")!)).toBe("<p>hello</p>");
  root.remove();
});

test("mount throws when the target is missing", () => {
  expect(() => mount(Hello, "nope")).toThrow('xzor: mount target "nope" not found');
});

test("app builds injected components, nested and in slots", () => {
  const app: IApplication = {
    createComponent: (type) => (type === Needs ? new Needs("svc") : undefined),
  };
  const el = host();
  mount(Tree, el, app);
  expect(Array.from(el.querySelectorAll("b"), (b) => b.textContent)).toEqual(["svc", "svc"]);
  expect(el.querySelector("div b")).not.toBeNull();
});

test("onStarted runs after the first render", () => {
  const seen: string[] = [];
  const el = host();
  const app: IApplication = { onStarted: () => void seen.push(html(el)) };
  mount(Hello, el, app);
  expect(seen).toEqual(["<p>hello</p>"]);
});

test("injected component without an app throws", () => {
  expect(() => mount(Needs, host())).toThrow("xzor: Needs needs injected services (dep) but has no application");
});

test("injected component the app does not create throws", () => {
  expect(() => mount(Needs, host(), { createComponent: () => undefined })).toThrow("xzor: Needs is not registered with the application");
  expect(() => mount(Needs, host(), {})).toThrow("xzor: Needs is not registered with the application");
});

test("components without inject are built without asking the app", () => {
  const asked: Function[] = [];
  const el = host();
  mount(Tree, el, { createComponent: (type) => (asked.push(type), type === Needs ? new Needs("svc") : undefined) });
  expect(asked).toEqual([Needs, Needs]);
});

test("decorators are no-ops", () => {
  class Impl {}
  @ServiceProvider()
  @Run(Hello, "app")
  @Import(Impl)
  @Singleton(Impl)
  @Scoped("scoped", () => 1)
  @Transient("transient", async () => 2)
  class Providers {
    value = 7;
  }
  expect(new Providers().value).toBe(7);
  expect(typeof SharedInstance).toBe("symbol");
});

class Late extends ComponentBase {
  show = true;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("i");
    b.addText("before");
    b.closeElement();
    b.openRegion();
    if (this.show) b.addComponent(Needs, {});
    b.closeRegion();
    b.openElement("u");
    b.addText("after");
    b.closeElement();
  }
}

test("async component fills its place when it arrives", async () => {
  const arrival = Promise.resolve(new Needs("late"));
  const el = host();
  mount(Late, el, { createComponent: (type) => (type === Needs ? arrival : undefined) });
  expect(html(el)).toBe("<i>before</i><u>after</u>");
  await arrival;
  expect(html(el)).toBe("<i>before</i><b>late</b><u>after</u>");
});

test("async component removed before arrival is disposed", async () => {
  const log: string[] = [];
  class Tracked extends Needs {
    protected override dispose(): void {
      log.push("hook");
    }
    [Symbol.dispose](): void {
      log.push("dispose");
    }
  }
  let resolve!: (c: ComponentBase) => void;
  const arrival = new Promise<ComponentBase>((r) => (resolve = r));
  const el = host();
  const page = mount(Late, el, { createComponent: (type) => (type === Needs ? arrival : undefined) });
  page.show = false;
  page.stateHasChanged();
  resolve(new Tracked("gone"));
  await arrival;
  expect(log).toEqual(["hook", "dispose"]);
  expect(html(el)).toBe("<i>before</i><u>after</u>");
});

test("async component keeps the latest props and lifecycle when it arrives", async () => {
  const log: string[] = [];
  class Label extends ComponentBase {
    static readonly inject = ["dep"] as const;
    text = "";
    protected override onAfterRender(first: boolean): void {
      log.push(`after ${this.text} ${first}`);
    }
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addContent(this.text);
    }
  }
  class Outer extends ComponentBase {
    text = "one";
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addComponent(Label, { text: this.text });
    }
  }
  let resolve!: (c: ComponentBase) => void;
  const arrival = new Promise<ComponentBase>((r) => (resolve = r));
  const el = host();
  const outer = mount(Outer, el, { createComponent: (type) => (type === Label ? arrival : undefined) });
  outer.text = "two";
  outer.stateHasChanged();
  resolve(new Label());
  await arrival;
  expect(el.textContent).toBe("two");
  expect(log).toEqual(["after two true"]);
  outer.text = "three";
  outer.stateHasChanged();
  expect(el.textContent).toBe("three");
});

test("rejected async component leaves its place empty and surfaces the error", async () => {
  const failure = new Error("boom");
  const arrival = Promise.reject<ComponentBase>(failure);
  const el = host();
  // The runtime rethrows from a microtask; capture it instead of failing the test runner.
  const original = globalThis.queueMicrotask;
  const thrown: unknown[] = [];
  globalThis.queueMicrotask = (fn) =>
    original(() => {
      try {
        fn();
      } catch (err) {
        thrown.push(err);
      }
    });
  try {
    mount(Late, el, { createComponent: (type) => (type === Needs ? arrival : undefined) });
    await arrival.catch(() => {});
    await Promise.resolve();
  } finally {
    globalThis.queueMicrotask = original;
  }
  expect(thrown).toEqual([failure]);
  expect(html(el)).toBe("<i>before</i><u>after</u>");
});

test("components implementing Disposable are disposed on removal", () => {
  const log: string[] = [];
  class Both extends ComponentBase {
    protected override dispose(): void {
      log.push("hook");
    }
    [Symbol.dispose](): void {
      log.push("dispose");
    }
    [Symbol.asyncDispose](): Promise<void> {
      log.push("asyncDispose");
      return Promise.resolve();
    }
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addText("x");
    }
  }
  class Switch extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(Both, {});
      b.closeRegion();
    }
  }
  const page = mount(Switch, host());
  page.show = false;
  page.stateHasChanged();
  expect(log).toEqual(["hook", "dispose", "asyncDispose"]);
  page.stateHasChanged();
  expect(log).toHaveLength(3);
});

// The runtime rethrows unhandled promise errors from a microtask; capture them instead of failing the runner.
async function thrownFrom(run: () => unknown): Promise<unknown[]> {
  const original = globalThis.queueMicrotask;
  const thrown: unknown[] = [];
  globalThis.queueMicrotask = (fn) =>
    original(() => {
      try {
        fn();
      } catch (err) {
        thrown.push(err);
      }
    });
  try {
    await run();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.queueMicrotask = original;
  }
  return thrown;
}

function deferred() {
  let resolve!: (c: ComponentBase) => void;
  const promise = new Promise<ComponentBase>((r) => (resolve = r));
  return { promise, resolve };
}

const trackedNeeds = (log: string[]) =>
  class extends Needs {
    protected override dispose(): void {
      log.push("hook");
    }
    [Symbol.dispose](): void {
      log.push("dispose");
    }
    [Symbol.asyncDispose](): Promise<void> {
      log.push("asyncDispose");
      return Promise.resolve();
    }
  };

class Shell extends ComponentBase {
  show = true;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openRegion();
    if (this.show) b.addComponent(Wrapper, {});
    b.closeRegion();
  }
}

class Wrapper extends ComponentBase {
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("section");
    b.addComponent(Needs, {});
    b.closeElement();
  }
}

test("pending component inside a removed ancestor is disposed once and nothing is inserted", async () => {
  const log: string[] = [];
  const late = deferred();
  const el = host();
  const page = mount(Shell, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  page.show = false;
  page.stateHasChanged();
  late.resolve(new (trackedNeeds(log))("gone"));
  await late.promise;
  expect(log).toEqual(["hook", "dispose", "asyncDispose"]);
  expect(html(el)).toBe("");
});

test("[Symbol.asyncDispose] runs once for a component removed before arrival", async () => {
  const log: string[] = [];
  const late = deferred();
  const el = host();
  const page = mount(Late, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  page.show = false;
  page.stateHasChanged();
  late.resolve(new (trackedNeeds(log))("gone"));
  await late.promise;
  expect(log.filter((entry) => entry === "asyncDispose")).toHaveLength(1);
});

test("pending component moved by a keyed diff arrives in its new position", async () => {
  class Keyed extends ComponentBase {
    flip = false;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      const item = () => {
        b.openElement("i");
        b.setKey(2);
        b.addText("x");
        b.closeElement();
      };
      if (this.flip) {
        item();
        b.addComponent(Needs, {}, undefined, { key: 1 });
      } else {
        b.addComponent(Needs, {}, undefined, { key: 1 });
        item();
      }
    }
  }
  const late = deferred();
  const el = host();
  const page = mount(Keyed, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  page.flip = true;
  page.stateHasChanged();
  late.resolve(new Needs("late"));
  await late.promise;
  expect(html(el)).toBe("<i>x</i><b>late</b>");
});

test("a component arriving after its anchor was detached is disposed", async () => {
  const log: string[] = [];
  const late = deferred();
  const el = host();
  mount(Late, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  mount(Hello, el);
  const thrown = await thrownFrom(async () => {
    late.resolve(new (trackedNeeds(log))("orphan"));
    await late.promise;
  });
  expect(thrown).toEqual([]);
  expect(log).toEqual(["hook", "dispose", "asyncDispose"]);
  expect(html(el)).toBe("<p>hello</p>");
});

test("a component that throws while mounting on arrival surfaces the error and leaves its place empty", async () => {
  const boom = new Error("init failed");
  class Broken extends Needs {
    protected override onInitialized(): void {
      throw boom;
    }
  }
  const late = deferred();
  const el = host();
  const page = mount(Late, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  const thrown = await thrownFrom(async () => {
    late.resolve(new Broken("x"));
    await late.promise;
  });
  expect(thrown).toEqual([boom]);
  expect(html(el)).toBe("<i>before</i><u>after</u>");
  page.stateHasChanged();
  expect(html(el)).toBe("<i>before</i><u>after</u>");
});

test("an arriving component whose onAfterRender throws stays mounted and is removed and disposed later", async () => {
  const boom = new Error("after failed");
  const log: string[] = [];
  class Noisy extends trackedNeeds(log) {
    protected override onAfterRender(): void {
      throw boom;
    }
  }
  const late = deferred();
  const el = host();
  const page = mount(Late, el, { createComponent: (type) => (type === Needs ? late.promise : undefined) });
  const thrown = await thrownFrom(async () => {
    late.resolve(new Noisy("live"));
    await late.promise;
  });
  expect(thrown).toEqual([boom]);
  expect(html(el)).toBe("<i>before</i><b>live</b><u>after</u>");
  page.show = false;
  page.stateHasChanged();
  expect(html(el)).toBe("<i>before</i><u>after</u>");
  expect(log).toEqual(["hook", "dispose", "asyncDispose"]);
});

test("a throwing dispose hook while discarding the partial tree does not lose the original error", async () => {
  const boom = new Error("child failed");
  class Fragile extends Hello {
    protected override dispose(): void {
      throw new Error("dispose failed");
    }
  }
  class Faulty extends Hello {
    protected override onInitialized(): void {
      throw boom;
    }
  }
  class Parent extends ComponentBase {
    static readonly inject = ["dep"] as const;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addComponent(Fragile, {});
      b.addComponent(Faulty, {});
    }
  }
  class Host extends ComponentBase {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addComponent(Parent, {});
    }
  }
  const late = deferred();
  mount(Host, host(), { createComponent: (type) => (type === Parent ? late.promise : undefined) });
  const thrown = await thrownFrom(async () => {
    late.resolve(new Parent());
    await late.promise;
  });
  expect(thrown).toHaveLength(2);
  expect(thrown[0]).toBe(boom);
});

test("an arriving component whose child throws can be removed and disposes the children built before the throw", async () => {
  const boom = new Error("child failed");
  const log: string[] = [];
  class Sound extends Hello {
    protected override dispose(): void {
      log.push("sound");
    }
  }
  class Faulty extends Hello {
    protected override onInitialized(): void {
      throw boom;
    }
  }
  class Parent extends ComponentBase {
    static readonly inject = ["dep"] as const;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addComponent(Sound, {});
      b.addComponent(Faulty, {});
    }
  }
  class Host extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(Parent, {});
      b.closeRegion();
    }
  }
  const late = deferred();
  const el = host();
  const page = mount(Host, el, { createComponent: (type) => (type === Parent ? late.promise : undefined) });
  const thrown = await thrownFrom(async () => {
    late.resolve(new Parent());
    await late.promise;
  });
  expect(thrown).toEqual([boom]);
  expect(log).toEqual(["sound"]);
  expect(html(el)).toBe("");
  page.show = false;
  expect(() => page.stateHasChanged()).not.toThrow();
  expect(html(el)).toBe("");
});

test("a rejected onStarted surfaces the error", async () => {
  const failure = new Error("start failed");
  const thrown = await thrownFrom(() => mount(Hello, host(), { onStarted: () => Promise.reject(failure) }));
  expect(thrown).toEqual([failure]);
});

test("a rejected [Symbol.asyncDispose] surfaces the error", async () => {
  const failure = new Error("dispose failed");
  class Failing extends Hello {
    [Symbol.asyncDispose](): Promise<void> {
      return Promise.reject(failure);
    }
  }
  class Switch extends ComponentBase {
    show = true;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openRegion();
      if (this.show) b.addComponent(Failing, {});
      b.closeRegion();
    }
  }
  const page = mount(Switch, host());
  const thrown = await thrownFrom(() => {
    page.show = false;
    page.stateHasChanged();
  });
  expect(thrown).toEqual([failure]);
});