import { expect, test } from "bun:test";
import { Component, type RenderTreeBuilder, mount } from "./index";

// Written the way xzor emits lifecycle overrides, @key and @ref.

const log: string[] = [];

class Child extends Component {
  label = "";
  clicks = 0;
  protected override onInitialized(): void {
    log.push(`init ${this.label}`);
  }
  protected override onParametersSet(): void {
    log.push(`params ${this.label}`);
  }
  protected override onAfterRender(first: boolean): void {
    log.push(`after ${this.label} ${first}`);
  }
  protected override dispose(): void {
    log.push(`dispose ${this.label}`);
  }
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    log.push(`render ${this.label}`);
    b.openElement("i");
    b.addContent(`${this.label}:${this.clicks}`);
    b.closeElement();
  }
}

class Parent extends Component {
  show = true;
  label = "a";
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openRegion();
    if (this.show) b.addComponent(Child, { label: "x" });
    b.closeRegion();
    b.addComponent(Child, { label: this.label });
  }
}

test("lifecycle runs in Blazor order and disposes removed children", () => {
  log.length = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const p = mount(Parent, host);
  expect(log).toEqual([
    "init x", "params x", "render x",
    "init a", "params a", "render a",
    "after x true", "after a true",
  ]);

  log.length = 0;
  p.stateHasChanged();
  expect(log).toEqual([]);

  p.label = "b";
  p.stateHasChanged();
  expect(log).toEqual(["params b", "render b", "after b false"]);

  log.length = 0;
  p.show = false;
  p.stateHasChanged();
  expect(log).toEqual(["dispose x"]);
  expect(host.textContent).toBe("b:0");
  host.remove();
});

test("component identity follows position, so an @if before a sibling keeps its state", () => {
  const host = document.createElement("div");
  const p = mount(Parent, host);
  let refs: Child[] = [];
  class Probe extends Parent {
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      refs = [];
      b.openRegion();
      if (this.show) b.addComponent(Child, { label: "x" }, undefined, { ref: (c) => refs.push(c) });
      b.closeRegion();
      b.addComponent(Child, { label: "y" }, undefined, { ref: (c) => refs.push(c) });
    }
  }
  const probe = mount(Probe, host);
  const y = refs[1]!;
  y.clicks = 5;
  y.stateHasChanged();
  probe.show = false;
  probe.stateHasChanged();
  expect(refs).toEqual([y]);
  probe.show = true;
  probe.stateHasChanged();
  expect(refs[1]).toBe(y);
  expect(host.textContent).toBe("x:0y:5");
  void p;
});

test("async lifecycle methods re-render when they settle; shouldRender can veto", async () => {
  class Loader extends Component {
    data = "loading";
    frozen = false;
    protected override async onInitializedAsync(): Promise<void> {
      await Promise.resolve();
      this.data = "loaded";
    }
    protected override shouldRender(): boolean {
      return !this.frozen;
    }
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.addContent(this.data);
    }
  }
  const host = document.createElement("div");
  const c = mount(Loader, host);
  expect(host.textContent).toBe("loading");
  await new Promise((r) => setTimeout(r, 0));
  expect(host.textContent).toBe("loaded");
  c.frozen = true;
  c.data = "changed";
  c.stateHasChanged();
  expect(host.textContent).toBe("loaded");
});

test("@key moves keyed DOM nodes and component state instead of rewriting them", () => {
  class Rows extends Component {
    items = ["a", "b", "c"];
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("ul");
      b.openRegion();
      for (const item of this.items) {
        b.openElement("li");
        b.setKey(item);
        b.addContent(item);
        b.closeElement();
      }
      b.closeRegion();
      b.closeElement();
      b.openRegion();
      for (const item of this.items) b.addComponent(Child, { label: item }, undefined, { key: item });
      b.closeRegion();
    }
  }
  const host = document.createElement("div");
  const rows = mount(Rows, host);
  const [a, b, c] = Array.from(host.querySelectorAll("li"));
  rows.items = ["c", "a"];
  rows.stateHasChanged();
  const lis = Array.from(host.querySelectorAll("li"));
  expect(lis.map((li) => li.textContent)).toEqual(["c", "a"]);
  expect(lis[0]).toBe(c!);
  expect(lis[1]).toBe(a!);
  expect(b!.isConnected).toBe(false);
  expect(Array.from(host.querySelectorAll("i"), (i) => i.textContent)).toEqual(["c:0", "a:0"]);
});

test("@ref assigns elements and component instances", () => {
  class Form extends Component {
    input?: HTMLInputElement;
    child?: Child;
    protected override buildRenderTree(b: RenderTreeBuilder): void {
      b.openElement("input");
      b.setRef("input", (e) => { this.input = e; });
      b.closeElement();
      b.addComponent(Child, { label: "r" }, undefined, { ref: (c) => { this.child = c; } });
    }
  }
  const host = document.createElement("div");
  const f = mount(Form, host);
  expect(f.input).toBe(host.querySelector("input")!);
  expect(f.child).toBeInstanceOf(Child);
  expect(f.child!.label).toBe("r");
});
