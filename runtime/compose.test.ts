import { expect, test } from "bun:test";
import { ComponentBase, type EventCallback, type RenderFragment, type RenderTreeBuilder, mount } from "./index";

// Written the way zor emits slots, callbacks and @bind.

class Panel extends ComponentBase {
  declare slots: { default?: () => RenderFragment; header?: (n: number) => RenderFragment };
  onPing?: EventCallback<number>;
  protected override buildRenderTree(b: RenderTreeBuilder): void {
    b.openElement("section");
    b.addContent(this.slots.header?.(7) ?? ComponentBase.fragment((__b) => { __b.addText("no header"); }));
    b.addContent(this.slots.default?.() ?? null);
    b.openElement("button");
    b.addEventHandler("click", () => this.onPing?.(1));
    b.closeElement();
    b.closeElement();
  }
}

class Page extends ComponentBase {
  pings = 0;
  name = "a";
  age = 1;
  ok = false;
  protected override buildRenderTree(__b: RenderTreeBuilder): void {
    __b.addComponent(
      Panel,
      { onPing: __b.callback((n) => (this.pings += n)) },
      {
        default: () => ComponentBase.fragment((__b) => {
          __b.openElement("p");
          __b.addContent(this.pings);
          __b.closeElement();
        }),
      },
    );
    __b.addComponent(Panel, {}, { header: (n) => ComponentBase.fragment((__b) => { __b.addContent(n * 2); }) });
    __b.openElement("input");
    __b.addAttribute("value", this.name);
    __b.addEventHandler("change", (__e) => { this.name = ComponentBase.bindValue(__e, this.name); });
    __b.closeElement();
    __b.openElement("input");
    __b.addAttribute("value", this.age);
    __b.addEventHandler("input", (__e) => { this.age = ComponentBase.bindValue(__e, this.age); });
    __b.closeElement();
    __b.openElement("input");
    __b.addAttribute("type", "checkbox");
    __b.addAttribute("checked", this.ok);
    __b.addEventHandler("change", (__e) => { this.ok = ComponentBase.bindValue(__e, this.ok); });
    __b.closeElement();
  }
}

test("slots render with parameters and fall back to their default content", () => {
  const host = document.createElement("div");
  const page = mount(Page, host);
  const [first, second] = Array.from(host.querySelectorAll("section"));
  expect(first!.textContent).toBe("no header0");
  expect(second!.textContent).toBe("14");
  const p = first!.querySelector("p")!;
  first!.querySelector("button")!.dispatchEvent(new MouseEvent("click"));
  expect(page.pings).toBe(1);
  expect(first!.querySelector("p")).toBe(p);
  expect(p.textContent).toBe("1");
});

test("@bind writes typed values back and keeps the DOM property in sync", () => {
  const host = document.createElement("div");
  const page = mount(Page, host);
  const [name, age, ok] = Array.from(host.querySelectorAll("input"));
  expect(name!.value).toBe("a");

  name!.value = "bob";
  name!.dispatchEvent(new Event("change"));
  expect(page.name).toBe("bob");

  age!.value = "42";
  age!.dispatchEvent(new Event("input"));
  expect(page.age).toBe(42);

  ok!.checked = true;
  ok!.dispatchEvent(new Event("change"));
  expect(page.ok).toBe(true);

  page.name = "set in code";
  page.ok = false;
  page.stateHasChanged();
  expect(name!.value).toBe("set in code");
  expect(ok!.checked).toBe(false);
});
