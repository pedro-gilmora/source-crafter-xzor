// A tracked list of models: the items keep their own state, and the set keeps the list it started
// from, so it can put it back. On a tracked field it tells its model when it is mutated, without
// touching the model's own state. `set[i] = x` and `set.length = n` are not observed; the methods
// below are. `map`, `filter` and `slice` give plain arrays. A set assigned to two models notifies
// only the last one. `new EntitySet(n)` (holes) is not supported: use `EntitySet.track`. Its membership is
// tracked like a field: `view` and `for...of` report a read, every mutation above notifies those readers.

import { Model, State } from "./model";
import { changed } from "./track";

export class EntitySet<T extends Model> extends Array<T> {
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** Builds a set from server data: `Array.of` and `Array.from` keep their own meaning. */
  static track<T extends Model>(type: new (data?: object) => T, items?: Iterable<object>): EntitySet<T> {
    const set = new EntitySet<T>();
    if (items) for (const item of items) Array.prototype.push.call(set, new type(item));
    return set;
  }

  // The items the list held before its first mutation: references only, taken lazily.
  #original: T[] | undefined;
  #owner: Model | undefined;
  #index = 0;
  /** Renders and fine bindings that read the membership, as the model tracker's deps. */
  #subs: object[] | undefined;

  /** @internal The model this set belongs to, and the index of the field holding it. */
  $own(owner: Model, index: number): void {
    this.#owner = owner;
    this.#index = index;
  }

  /** @internal */
  $watch(dep: object): void {
    const subs = (this.#subs ??= []);
    (dep as { slot: number }).slot = subs.length;
    subs.push(dep);
  }

  /** @internal */
  $unwatch(dep: object): void {
    const subs = this.#subs;
    if (subs === undefined || subs.length === 0) return;
    const last = subs.pop() as { slot: number };
    if (last !== dep) {
      const slot = (dep as { slot: number }).slot;
      subs[slot] = last;
      last.slot = slot;
    }
  }

  override [Symbol.iterator](): ArrayIterator<T> {
    Model.$reader?.(this as unknown as Model, 0);
    return super[Symbol.iterator]();
  }

  /** The items to show: everything but the deleted ones. */
  get view(): T[] {
    Model.$reader?.(this as unknown as Model, 0);
    return this.filter((item) => !item.hasState(State.Deleted));
  }

  get hasChanges(): boolean {
    Model.$reader?.(this as unknown as Model, 0);
    if (this.#moved()) return true;
    for (let i = 0; i < this.length; i++) if (this[i]!.hasChanges) return true;
    return false;
  }

  get hasErrors(): boolean {
    Model.$reader?.(this as unknown as Model, 0);
    for (let i = 0; i < this.length; i++) if (this[i]!.hasErrors) return true;
    return false;
  }

  /** What to send to the server: only the items that changed, each as its own `changes`. */
  get changes(): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (let i = 0; i < this.length; i++) {
      const changes = this[i]!.changes;
      if (changes) result.push(changes);
    }
    return result;
  }

  /** Added items leave the set, the others are marked Deleted; a Detached one is left alone. */
  delete(...items: T[]): this {
    let touched = false;
    for (const item of items) {
      if (item.hasState(State.Added)) {
        const at = this.indexOf(item);
        if (at >= 0) {
          this.#snapshot();
          super.splice(at, 1);
          touched = true;
        }
      } else if (!item.hasState(State.Detached)) {
        item.markDeleted();
        touched = true;
      }
    }
    if (touched) this.#notify();
    return this;
  }

  revertChanges(): this {
    const original = this.#original;
    let touched = original !== undefined;
    if (original !== undefined) {
      this.#original = undefined;
      super.splice(0, this.length, ...original);
    }
    for (let i = 0; i < this.length; i++)
      if (this[i]!.hasChanges) {
        this[i]!.revertChanges();
        touched = true;
      }
    if (touched) this.#notify();
    return this;
  }

  /**
   * Takes the list the server confirmed: a `null` at an index drops that item, as do the deleted ones.
   * Items past the end of a shorter server list are left exactly as they are.
   */
  confirmChanges(items?: readonly (object | null)[]): this {
    let touched = this.#original !== undefined;
    const length = this.length;
    const limit = items ? Math.min(items.length, length) : length;
    let w = 0;
    for (let r = 0; r < length; r++) {
      const item = this[r]!;
      if (r < limit) {
        const confirmed = items?.[r];
        if (confirmed === null || item.hasState(State.Deleted)) continue;
        item.confirmChanges(confirmed);
      }
      this[w++] = item;
    }
    if (w !== length) {
      this.length = w;
      touched = true;
    }
    this.#original = undefined;
    if (touched) this.#notify();
    return this;
  }

  override push(...items: T[]): number;
  override push(item?: T): number {
    const count = arguments.length;
    if (count !== 0) {
      this.#snapshot();
      if (count === 1) super.push(item!);
      else super.push(...(Array.prototype.slice.call(arguments) as T[]));
      this.#notify();
    }
    return this.length;
  }

  override unshift(...items: T[]): number {
    if (items.length !== 0) {
      this.#snapshot();
      super.unshift(...items);
      this.#notify();
    }
    return this.length;
  }

  override pop(): T | undefined {
    if (this.length === 0) return undefined;
    this.#snapshot();
    const item = super.pop();
    this.#notify();
    return item;
  }

  override shift(): T | undefined {
    if (this.length === 0) return undefined;
    this.#snapshot();
    const item = super.shift();
    this.#notify();
    return item;
  }

  override splice(start: number, deleteCount?: number, ...items: T[]): T[] {
    if (items.length === 0) {
      const length = this.length;
      const from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
      if (from >= length || (deleteCount !== undefined && deleteCount <= 0)) return [];
    }
    this.#snapshot();
    const removed =
      deleteCount === undefined && items.length === 0 ? super.splice(start) : super.splice(start, deleteCount!, ...items);
    this.#notify();
    return removed;
  }

  override sort(compare?: (a: T, b: T) => number): this {
    this.#snapshot();
    super.sort(compare);
    this.#notify();
    return this;
  }

  override reverse(): T[] {
    this.#snapshot();
    super.reverse();
    this.#notify();
    return this;
  }

  #snapshot(): void {
    this.#original ??= this.slice();
  }

  #moved(): boolean {
    const original = this.#original;
    if (original === undefined) return false;
    if (original.length !== this.length) return true;
    for (let i = 0; i < original.length; i++) if (original[i] !== this[i]) return true;
    return false;
  }

  #notify(): void {
    this.#owner?.$touched(this.#index);
    const subs = this.#subs;
    if (subs !== undefined) for (let i = 0; i < subs.length; i++) changed(subs[i]!, 0);
  }
}
