import { Component } from "@source-crafter/xzor-runtime";

/** The pages' common base: its members are usable as bare names in their templates. */
export abstract class PageBase extends Component {
  readonly siteName = "xzor demo";
  abstract get heading(): string;

  protected override onAfterRender(_firstRender: boolean): void {
    document.title = `${this.heading} · ${this.siteName}`;
  }

  /** The name `@attribute registered(...)` gave this page's class. */
  registeredAs(): string | undefined {
    for (const [name, type] of registry) if (type === this.constructor) return name;
    return undefined;
  }
}

export interface Describable {
  describe(): string;
}

/** Classes registered by `@attribute registered("name")`. */
export const registry = new Map<string, Function>();

export function registered(name: string) {
  return (target: Function, _context: ClassDecoratorContext): void => {
    registry.set(name, target);
  };
}
