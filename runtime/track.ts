// The reactivity core components and models share: the change queue, the bit layout of a dep's mask, and
// the equality a tracked field uses. Internal: only `index.ts`, `dom.ts` and `model.ts` import it.

/** On a model class: what it tracks (`Model.$define`). */
export const META = Symbol("xzor.model.meta");
/** On `Model.prototype`: `same` compares models by identity. */
export const MODEL = Symbol("xzor.model");

// Fields from the 30th on share bit 30: they notify each other's readers, nobody else's. Bit 31 is `state` (-1).
export const bitOf = (index: number): number => (index === -1 ? 1 << 31 : index < 30 ? 1 << index : 1 << 30);

// What `Binding.flags` holds that the queue reads; the other flags live in dom.ts.
export const KIND = 15;
/** A cached getter: a change only marks it stale, it is never queued. */
export const MEMO = 7;
/** Queued: the queue holds it until the next flush. A MEMO always has it, so the queue skips it. */
export const QUEUED = 16;
export const DEAD = 64;
/** A MEMO's value is current. */
export const FRESH = 1024;

/** What the queue runs. A binding is its own dep for the first source it reads; later sources get `{ mask, owner }`. */
type Binding = { flags: number; mask: number; owner?: Binding; stateHasChanged(): void };

let queued: Binding[] = [];
let spare: Binding[] | undefined;

/** Queues `dep`'s binding when `index` is in its mask. */
export function changed(dep: object, index: number): void {
  const d = dep as Binding;
  if ((d.mask & bitOf(index)) === 0) return;
  const b = d.owner ?? d;
  const flags = b.flags;
  if ((flags & (QUEUED | DEAD)) !== 0) {
    // Stale as soon as what it read changes, so no binding run in the same flush reads the old value.
    if ((flags & (DEAD | KIND)) === MEMO) b.flags = flags & ~FRESH;
    return;
  }
  b.flags = flags | QUEUED;
  queued.push(b);
  if (queued.length === 1) queueMicrotask(flush);
}

/** Runs what is queued now instead of in a microtask. What the runs change is queued again, for the next flush. */
export function flush(): void {
  const run = queued;
  if (run.length === 0) return;
  queued = spare ?? [];
  spare = undefined;
  for (let i = 0; i < run.length; i++) {
    const b = run[i]!;
    b.flags &= ~QUEUED;
    try {
      b.stateHasChanged();
    } catch (err) {
      // Reported, not thrown: the rest of the queue still runs.
      queueMicrotask(() => {
        throw err;
      });
    }
  }
  run.length = 0;
  spare = run;
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
