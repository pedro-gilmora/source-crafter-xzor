import { expect, test } from "bun:test";
import { Component, ComponentBase } from "./index";

test("ComponentBase stays importable as a deprecated alias of Component", () => {
  expect(ComponentBase).toBe(Component);
  class Legacy extends ComponentBase {
    protected override render(): void {}
  }
  const legacy: ComponentBase = new Legacy();
  expect(legacy).toBeInstanceOf(Component);
  const modern: Component = legacy;
  expect(modern).toBe(legacy);
});
