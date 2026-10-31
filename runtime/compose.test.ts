import { expect, test } from "bun:test";
import { Component, type El, type EventCallback, type RenderFragment, dom, mount } from "./index";

// Written the way xzor emits slots, callbacks and @bind.

// Handlers run from one listener on the document, so a host must be in it.
const attached = () => document.body.appendChild(document.createElement("div"));

class Panel extends Component {
  declare slots: { default?: () => RenderFragment; header?: (n: number) => RenderFragment };
  onPing?: EventCallback<number>;
  protected override render(__p: Node): void {
    const _e0 = __t0() as El<"section">;
    const _e1 = _e0.firstChild!.nextSibling! as Comment;
    const _e2 = _e1.nextSibling!.nextSibling! as Comment;
    const _e3 = _e2.nextSibling! as El<"button">;
    dom.slotAt(_e1, () => this.slots.header, () => [7], (__p) => dom.t(__p, "no header"));
    dom.slotAt(_e2, () => this.slots.default);
    dom.on(_e3, "click", () => this.onPing?.(1));
    __p.appendChild(_e0);
  }
}

const __t0 = dom.template([["section", 0, null, null, null, null, ["button", 0]]]);
const __t1 = dom.template([["p", 0, ""]]);

class Page extends Component {
  pings = 0;
  name = "a";
  age = 1;
  ok = false;
  protected override render(__p: Node): void {
    const _e0 = __t2();
    const _e1 = _e0.firstChild! as Comment;
    const _e2 = _e1.nextSibling! as Comment;
    const _e3 = _e2.nextSibling! as El<"input">;
    const _e4 = _e3.nextSibling! as El<"input">;
    const _e5 = _e4.nextSibling! as El<"input">;
    dom.component(_e1, Panel, (): Partial<Panel> => ({}), { onPing: dom.callback(this, (n: number) => (this.pings += n)) }, {
      default: () => Component.$fragment((__p) => {
        const _e6 = __t1() as El<"p">;
        dom.textAt(_e6.firstChild as Text, () => this.pings);
        __p.appendChild(_e6);
      }, this),
    });
    dom.component(_e2, Panel, (): Partial<Panel> => ({}), undefined, {
      header: (n: number) => Component.$fragment((__p) => dom.text(__p, () => n * 2), this),
    });
    dom.attr(_e3, "value", () => this.name);
    dom.on(_e3, "change", (__e) => { this.name = Component.bindValue(__e, this.name); });
    dom.attr(_e4, "value", () => this.age);
    dom.on(_e4, "input", (__e) => { this.age = Component.bindValue(__e, this.age); });
    dom.attr(_e5, "checked", () => this.ok);
    dom.on(_e5, "change", (__e) => { this.ok = Component.bindValue(__e, this.ok); });
    __p.appendChild(_e0);
  }
}

const __t2 = dom.template([null, null, ["input", 0], ["input", 0], ["input", ["type", "checkbox"]]]);

test("slots render with parameters and fall back to their default content", () => {
  const host = attached();
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
  const host = attached();
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
