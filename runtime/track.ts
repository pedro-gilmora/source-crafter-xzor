// The reactivity core components and models share: the change queue, the bit layout of a dep's mask, and
// the equality a tracked field uses. Internal: only `index.ts`, `dom.ts` and `model.ts` import it.

/** On a model class: what it tracks (`Model.$define`). */
export const META = Symbol("xzor.model.meta");
/** On `Model.prototype`: `same` compares models by identity. */
export const MODEL = Symbol("xzor.model");

// Fields from the 30th on share bit 30: they notify each other's readers, nobody else's. Bit 31 is `state` (-1).
export const bitOf = (index: number): number => (index === -1 ? 1 << 31 : index < 30 ? 1 << index : 1 << 30);

/** What the queue runs: a binding, or a component the model tracker saw render. */
type Owner = { at: number; renders: number; component: { stateHasChanged(): void } };
type Dep = { mask: number; owner: Owner };

const queued: Owner[] = [];

/** Queues `dep`'s owner when `index` is in its mask. */
export function changed(dep: object, index: number): void {
  const d = dep as Dep;
  if ((d.mask & bitOf(index)) === 0) return;
  const own = d.owner;
  if (own.at < 0) {
    queued.push(own);
    if (queued.length === 1) queueMicrotask(flush);
  }
  // Marking again moves the render this change waits for past one that already happened.
  own.at = own.renders;
}

/** Runs what is queued now instead of in a microtask; an owner that ran since it was queued (its own handler did it) is skipped. */
export function flush(): void {
  for (const own of queued.splice(0)) {
    const at = own.at;
    own.at = -1;
    if (own.renders === at) own.component.stateHasChanged();
  }
}

/** Values a tracked field considers the same: dates by time, arrays and plain objects deeply, models by identity. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (MODEL in a || MODEL in b || "$own" in a || "$own" in b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => same(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) return false;
  return names.every((name) => same(left[name], right[name]));
}

/** The `@Key` member of `item`'s class, from the class's tracked-field record. */
export const keyName = (item: unknown): string | undefined =>
  ((item as object | null | undefined)?.constructor as Record<symbol, { key?: string } | undefined> | undefined)?.[META]?.key;
