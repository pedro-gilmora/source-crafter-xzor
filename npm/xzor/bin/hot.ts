// The dev-only client behind `xzor dev`'s hot reload. Hot bundles register their component classes here;
// an update patches the original class in place, so the diff keeps every instance and its state.

export type HotUpdate = {
  id: string;
  /** The module's JS without its imports, `export default class X` as `class X`, ending with `return X;`. */
  code: string;
  /** The value import locals the module needs; they must all be registered. */
  imports?: string[];
};

export type HotRegistry = {
  register(id: string, cls: Function, imports: () => Record<string, unknown>): void;
  /** Hands over the runtime's `$rebuild`: without it, an edit to a template reloads the page. */
  link(rebuild: (c: any) => boolean): void;
  apply(updates: HotUpdate[]): boolean;
};

// `templates`: the `const __tN = ...template(...)` lines of the last applied update; none until one is.
type Entry = { cls: Function; imports: () => Record<string, unknown>; templates?: string };
type Instance = { stateHasChanged(): void };
type Patch = { entry: Entry; cls: Function; fresh: Function; fields: string[]; template: boolean; templates: string };

// Static markup lives in module-level constants after the class, not in `render`'s source.
const TEMPLATES = /^const __t\d+ = .*$/gm;

// `#private` names are per class body: the new methods could not reach the live instances' fields.
const PRIVATE = /(^|[^\w$"'`])#[A-Za-z_$]/;
const WRAPPED = "__xzorHotWrapped";
const STATICS = new Set(["length", "name", "prototype"]);

const copyOwn = (from: object, to: object, skip: (key: string | symbol) => boolean): void => {
  // A member the edit deleted must go too, or e.g. a removed `shouldRender` keeps running.
  for (const key of Reflect.ownKeys(to)) if (!skip(key) && !Object.hasOwn(from, key)) delete (to as any)[key];
  for (const key of Reflect.ownKeys(from)) {
    if (skip(key)) continue;
    Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key)!);
  }
};

const construct = (cls: Function): Record<string, unknown> | undefined => {
  try {
    return new (cls as new () => Record<string, unknown>)();
  } catch {
    return undefined;
  }
};

export function installHot(target: { __xzorHot?: unknown; location?: { reload(): void } }): HotRegistry {
  const entries = new Map<string, Entry>();
  const live = new Set<Instance>();
  let rebuild: ((c: Instance) => boolean) | undefined;

  // The runtime calls the lifecycle through the prototype chain, so an own wrapper on a registered
  // prototype sees every instance. A patch may overwrite it; `observe` runs again after each one.
  const wrap = (proto: any, name: string, track: (c: Instance) => void): void => {
    const prev = proto[name];
    if (prev?.[WRAPPED]) return;
    const hook: any = function (this: Instance, ...args: unknown[]): unknown {
      track(this);
      return prev?.apply(this, args);
    };
    hook[WRAPPED] = true;
    proto[name] = hook;
  };
  const observe = (cls: Function): void => {
    wrap(cls.prototype, "onInitialized", (c) => live.add(c));
    wrap(cls.prototype, "dispose", (c) => live.delete(c));
  };

  const reload = (): false => {
    target.location?.reload();
    return false;
  };

  const evaluate = (update: HotUpdate): Patch | undefined => {
    const entry = entries.get(update.id);
    if (!entry || PRIVATE.test(update.code)) return undefined;
    try {
      const bindings = entry.imports();
      if (update.imports?.some((name) => !Object.hasOwn(bindings, name))) return undefined;
      const names = Object.keys(bindings);
      const fresh = new Function(...names, update.code)(...names.map((n) => bindings[n]));
      if (typeof fresh !== "function") return undefined;
      if (Object.getPrototypeOf(fresh) !== Object.getPrototypeOf(entry.cls)) return undefined;
      // The new field initializers; a component that needs constructor arguments contributes none.
      const probe = construct(fresh);
      // A template edit changes `render` or its template constants: its DOM is built again, not just re-run.
      // The first update has no earlier constants to compare with, so any template counts as edited.
      const templates = (update.code.match(TEMPLATES) ?? []).join("\n");
      const template = String(entry.cls.prototype.render) !== String(fresh.prototype.render) || (entry.templates ?? "") !== templates;
      return { entry, cls: entry.cls, fresh, fields: probe ? Object.keys(probe) : [], template, templates };
    } catch {
      return undefined;
    }
  };

  const apply = (updates: HotUpdate[]): boolean => {
    const patches: Patch[] = [];
    for (const update of updates) {
      const patch = evaluate(update);
      if (!patch) return reload();
      patches.push(patch);
    }
    try {
      for (const { entry, cls, fresh, templates } of patches) {
        entry.templates = templates;
        copyOwn(fresh.prototype, cls.prototype, (key) => key === "constructor");
        copyOwn(fresh, cls, (key) => typeof key === "string" && STATICS.has(key));
        observe(cls);
      }
      // A re-render mounts children, which registers them; the snapshot keeps this loop finite.
      for (const instance of [...live]) {
        // A rebuilt parent disposed it.
        if (!live.has(instance)) continue;
        let patched = false;
        let template = false;
        for (const patch of patches) {
          const { cls, fresh, fields } = patch;
          if (!(instance instanceof (cls as new () => Instance))) continue;
          patched = true;
          template ||= patch.template;
          const missing = fields.filter((key) => !(key in instance));
          // One probe per instance, so a new `items = []` is not shared between instances.
          const probe = missing.length ? construct(fresh) : undefined;
          if (probe) for (const key of missing) (instance as any)[key] = probe[key];
        }
        if (template) {
          if (!rebuild?.(instance)) return reload();
        } else if (patched) instance.stateHasChanged();
      }
    } catch {
      return reload();
    }
    return true;
  };

  const registry: HotRegistry = {
    register(id, cls, imports) {
      entries.set(id, { cls, imports });
      observe(cls);
    },
    apply,
    link(fn) {
      rebuild = fn;
    },
  };
  target.__xzorHot = registry;
  return registry;
}
