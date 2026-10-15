// xzor models: plain classes whose fields track their own changes, revert and confirm them, and
// notify listeners as an `EventTarget`. A tracked field is a `#private` slot plus a getter and a
// setter on the prototype — what the bundle generates from a plain field, and what writing one by
// hand looks like:
//
//   class Worker extends Model { constructor(data?: object) { super(data); this.assign(data); }
//     #hours = 0; get hours() { return this.#hours; }
//     set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(0, p); }
//   static { Model.$define(this, ["hours"]); } }
//
// `same`/`isLike` and `changes` walk plain object graphs: cyclic ones are not supported.

export enum State {
  /** Created on the client and never sent. */
  Detached = 1,
  Unchanged = 2,
  Added = 4,
  Deleted = 8,
  Modified = 16,
}

const Changed = State.Added | State.Deleted | State.Modified;

export class ModelChangeEvent extends Event {
  readonly property: string;
  readonly value: unknown;
  readonly previous: unknown;

  constructor(property: string, value: unknown, previous: unknown) {
    super("change");
    this.property = property;
    this.value = value;
    this.previous = previous;
  }
}

/** What one class tracks; a subclass's fields come after its base's, so an index never moves. */
type Meta = {
  names: string[];
  tracked: Set<string>;
  persisted: string[];
  ignored: Set<string>;
  serialized?: string[];
};

/** One registration, kept only for `change` and `state` so a model knows whether it is watched. */
type Watch = {
  type: string;
  callback: EventListenerOrEventListenerObject;
  capture: boolean;
  wrapped?: EventListener;
};

const meta = Symbol("xzor.model.meta");
const empty: Meta = { names: [], tracked: new Set(), persisted: [], ignored: new Set(), serialized: [] };

// A class's member decorators all run before its `$define`, which takes these over.
let pendingPersist: string[] | undefined;
let pendingIgnored: string[] | undefined;

// Writes made by `assign`, `revertChanges` and `confirmChanges` are not changes.
let silent = 0;

function metaOf(model: Model): Meta {
  return (model.constructor as unknown as Record<symbol, Meta | undefined>)[meta] ?? empty;
}

/** The tracked fields and the persisted getters that are not ignored, in declaration order. */
function serialized(of: Meta): string[] {
  return (of.serialized ??= of.names.concat(of.persisted).filter((name) => !of.ignored.has(name)));
}

function captureOf(options: AddEventListenerOptions | EventListenerOptions | boolean | undefined): boolean {
  return typeof options === "object" && options !== null ? options.capture === true : options === true;
}

export abstract class Model extends EventTarget {
  #state: State;
  #originals: Record<string, unknown> | undefined;
  #watched: Watch[] | undefined;

  constructor(data?: object) {
    super();
    const state = (data as { state?: State } | undefined)?.state;
    this.#state = state ?? (data ? State.Unchanged : State.Detached);
  }

  /** @internal Records the tracked fields of a class, after the ones it inherits. */
  static $define(cls: Function, names: string[]): void {
    const base = (cls as unknown as Record<symbol, Meta | undefined>)[meta];
    const all = base ? base.names.concat(names) : names;
    const own: Meta = {
      names: all,
      tracked: new Set(all),
      persisted: base ? base.persisted.slice() : [],
      ignored: new Set(base?.ignored),
    };
    if (pendingPersist) {
      for (const name of pendingPersist) own.persisted.push(name);
      pendingPersist = undefined;
    }
    if (pendingIgnored) {
      for (const name of pendingIgnored) own.ignored.add(name);
      pendingIgnored = undefined;
    }
    Object.defineProperty(cls, meta, { value: own });
  }

  /** Values a tracked field considers the same: dates by time, arrays and plain objects deeply, models by identity. */
  static same(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (a instanceof Date || b instanceof Date)
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof Model || b instanceof Model) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((value, i) => Model.same(value, b[i]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const names = Object.keys(left);
    if (names.length !== Object.keys(right).length) return false;
    return names.every((name) => Model.same(left[name], right[name]));
  }

  get state(): State {
    return this.#state;
  }

  set state(value: State) {
    if (value === this.#state) return;
    this.#state = value;
    if (this.#listens("state")) this.dispatchEvent(new Event("state"));
  }

  hasState(flags: number): boolean {
    return (this.#state & flags) !== 0;
  }

  get hasChanges(): boolean {
    if ((this.#state & Changed) !== 0) return true;
    for (const name of metaOf(this).names)
      if (valueHasChanges((this as unknown as Record<string, unknown>)[name])) return true;
    return false;
  }

  /** What to send to the server: every primitive plus the nested models and sets that changed, or `null`. */
  get changes(): Record<string, unknown> | null {
    if (!this.hasChanges) return null;
    const values = this as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = { state: this.#state };
    for (const name of serialized(metaOf(this))) {
      const value = values[name];
      if (isSerializable(value)) result[name] = changesOf(value);
    }
    return result;
  }

  toJSON(): Record<string, unknown> {
    const values = this as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = { state: this.#state };
    for (const name of serialized(metaOf(this))) result[name] = values[name];
    return result;
  }

  revertChanges(): this {
    const own = metaOf(this);
    const originals = this.#originals;
    const values = this as unknown as Record<string, unknown>;
    if (originals) {
      this.#originals = undefined;
      silent++;
      try {
        for (const name in originals) {
          const previous = values[name];
          const value = originals[name];
          values[name] = value;
          if (this.#listens("change")) this.dispatchEvent(new ModelChangeEvent(name, value, previous));
        }
      } finally {
        silent--;
      }
    }
    for (const name of own.names) revertValue(values[name]);
    if ((this.#state & State.Added) !== 0) this.state = State.Detached;
    else if ((this.#state & (State.Deleted | State.Modified)) !== 0) this.state = State.Unchanged;
    return this;
  }

  /** Takes the values the server confirmed as the new originals; nested models and sets confirm theirs. */
  confirmChanges(values?: object): this {
    const own = metaOf(this);
    const data = values as Record<string, unknown> | undefined;
    const target = this as unknown as Record<string, unknown>;
    this.#originals = undefined;
    silent++;
    try {
      for (const name of own.names) {
        const current = target[name] as { confirmChanges?: (values?: object) => unknown } | null;
        const given = data !== undefined && Object.hasOwn(data, name);
        if (current !== null && typeof current === "object" && typeof current.confirmChanges === "function") {
          current.confirmChanges(given ? (data![name] as object) : undefined);
        } else if (given) {
          const value = data![name];
          if (Model.same(current, value)) continue;
          target[name] = value;
          if (this.#listens("change")) this.dispatchEvent(new ModelChangeEvent(name, value, current));
        }
      }
    } finally {
      silent--;
    }
    if ((this.#state & (State.Added | State.Modified)) !== 0) this.state = State.Unchanged;
    return this;
  }

  markAdded(): this {
    this.state = State.Added;
    return this;
  }

  markModified(): this {
    if ((this.#state & State.Added) === 0) this.state = State.Modified;
    return this;
  }

  markUnchanged(): this {
    this.state = State.Unchanged;
    return this;
  }

  markDeleted(): this {
    if ((this.#state & State.Detached) === 0) this.state = State.Deleted;
    return this;
  }

  /**
   * Writes construction data without tracking it, taking only the tracked fields of the class.
   * Call it last in the most derived constructor: the fields a subclass declares are only
   * initialized once its own initializers have run.
   */
  protected assign(data?: object): this {
    if (!data) return this;
    const tracked = metaOf(this).tracked;
    const source = data as Record<string, unknown>;
    const target = this as unknown as Record<string, unknown>;
    silent++;
    try {
      for (const name in source) if (tracked.has(name)) target[name] = source[name];
    } finally {
      silent--;
    }
    return this;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (!callback || (type !== "change" && type !== "state")) {
      super.addEventListener(type, callback, options);
      return;
    }
    const settings = typeof options === "object" && options !== null ? options : undefined;
    if (settings?.signal?.aborted) return;
    const capture = captureOf(options);
    const watched = (this.#watched ??= []);
    for (const known of watched)
      if (known.type === type && known.callback === callback && known.capture === capture) return;
    const watch: Watch = { type, callback, capture };
    watched.push(watch);
    if (settings?.once)
      watch.wrapped = (event) => {
        this.#forget(watch);
        if (typeof callback === "function") callback.call(this, event);
        else callback.handleEvent(event);
      };
    super.addEventListener(type, watch.wrapped ?? callback, options);
    settings?.signal?.addEventListener("abort", () => this.#forget(watch), { once: true });
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    let target = callback;
    const watched = this.#watched;
    if (callback && watched) {
      const capture = captureOf(options);
      for (let i = 0; i < watched.length; i++) {
        const watch = watched[i]!;
        if (watch.type === type && watch.callback === callback && watch.capture === capture) {
          watched.splice(i, 1);
          target = watch.wrapped ?? callback;
          break;
        }
      }
    }
    super.removeEventListener(type, target, options);
  }

  /** @internal What a tracked setter reports once it has stored a different value. */
  protected $changed(index: number, previous: unknown): void {
    if (silent !== 0) return;
    const name = metaOf(this).names[index]!;
    const originals = (this.#originals ??= Object.create(null) as Record<string, unknown>);
    if (!(name in originals)) originals[name] = previous;
    if ((this.#state & State.Detached) !== 0) this.state = State.Added;
    else if ((this.#state & State.Unchanged) !== 0) this.state = State.Modified;
    if (this.#listens("change"))
      this.dispatchEvent(
        new ModelChangeEvent(name, (this as unknown as Record<string, unknown>)[name], previous),
      );
  }

  // A model nobody watches never allocates an event.
  #listens(type: string): boolean {
    const watched = this.#watched;
    if (watched === undefined) return false;
    for (let i = 0; i < watched.length; i++) if (watched[i]!.type === type) return true;
    return false;
  }

  #forget(watch: Watch): void {
    const watched = this.#watched;
    if (!watched) return;
    const i = watched.indexOf(watch);
    if (i >= 0) watched.splice(i, 1);
  }
}

/** Serializes a computed getter with the model's own fields. */
export function Persist<T extends Model, V>(_getter: () => V, context: ClassGetterDecoratorContext<T, V>): void {
  (pendingPersist ??= []).push(context.name as string);
}

/** Keeps a member out of `changes` and `toJSON`. */
export function Ignore(
  _member: unknown,
  context: ClassGetterDecoratorContext | ClassFieldDecoratorContext,
): void {
  (pendingIgnored ??= []).push(context.name as string);
}

/** Leaves a field plain: the bundle does not turn it into a tracked field. */
export function Untracked(_value: undefined, _context: ClassFieldDecoratorContext): void {}

/** @see Model.same */
export function isLike(a: unknown, b: unknown): boolean {
  return Model.same(a, b);
}

// Models and sets answer `hasChanges`, `changes`, `revertChanges` and `confirmChanges` themselves.
function valueHasChanges(value: unknown): boolean {
  if (value === null || typeof value !== "object" || value instanceof Date) return false;
  const changes = (value as { hasChanges?: unknown }).hasChanges;
  if (typeof changes === "boolean") return changes;
  if (Array.isArray(value)) return value.some(valueHasChanges);
  return Object.values(value).some(valueHasChanges);
}

function isSerializable(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  return value instanceof Date || valueHasChanges(value);
}

function changesOf(value: unknown): unknown {
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const owner = value as { hasChanges?: unknown; changes?: unknown };
  if (typeof owner.hasChanges === "boolean") return owner.changes;
  if (Array.isArray(value)) return value.filter(valueHasChanges).map(changesOf);
  const result: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(value)) if (isSerializable(nested)) result[name] = changesOf(nested);
  return result;
}

function revertValue(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const owner = value as { hasChanges?: unknown; revertChanges?: () => void };
  if (typeof owner.revertChanges === "function") {
    if (owner.hasChanges) owner.revertChanges();
  } else if (Array.isArray(value)) value.forEach(revertValue);
}
