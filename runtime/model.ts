// xzor models: plain classes whose fields track their own changes, revert and confirm them,
// and notify listeners as an `EventTarget`. The bundle turns a model's fields into the
// `@__track accessor` form below; writing them by hand does the same.

// Decorated classes read `Symbol.metadata`; Bun has none, and this runs before any of them is
// defined, since every model imports this module.
const wellKnown = Symbol as unknown as { metadata?: symbol };
wellKnown.metadata ??= Symbol.for("Symbol.metadata");
const metadataSymbol = wellKnown.metadata as symbol;

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

type Accessor = ClassAccessorDecoratorTarget<any, any>;

/** What the decorators of one class record; a subclass starts from a copy of its base's. */
type Meta = {
  tracked: string[];
  raw: Record<string, Accessor>;
  persisted: string[];
  ignored: Record<string, true>;
  serialized?: string[];
};

const meta = Symbol("xzor.model.meta");
const change = Symbol("xzor.model.change");
const empty: Meta = { tracked: [], raw: {}, persisted: [], ignored: {}, serialized: [] };

function metaFor(context: DecoratorMetadata): Meta {
  let own = (context as Record<symbol, Meta | undefined>)[meta];
  if (!Object.prototype.hasOwnProperty.call(context, meta)) {
    own = own
      ? {
          tracked: own.tracked.slice(),
          raw: Object.create(own.raw) as Record<string, Accessor>,
          persisted: own.persisted.slice(),
          ignored: Object.create(own.ignored) as Record<string, true>,
        }
      : { tracked: [], raw: {}, persisted: [], ignored: {} };
    (context as Record<symbol, Meta>)[meta] = own;
  }
  return own as Meta;
}

function metaOf(model: Model): Meta {
  const metadata = (model.constructor as unknown as Record<symbol, DecoratorMetadata | undefined>)[metadataSymbol];
  return (metadata && (metadata as Record<symbol, Meta | undefined>)[meta]) ?? empty;
}

/** The tracked fields and the persisted getters that are not ignored, in declaration order. */
function serialized(of: Meta): string[] {
  return (of.serialized ??= of.tracked.concat(of.persisted).filter((name) => !(name in of.ignored)));
}

export abstract class Model extends EventTarget {
  #state: State;
  #originals: Record<string, unknown> | undefined;
  #changeListeners = 0;
  #stateListeners = 0;

  constructor(data?: object) {
    super();
    const state = (data as { state?: State } | undefined)?.state;
    this.#state = state ?? (data ? State.Unchanged : State.Detached);
  }

  get state(): State {
    return this.#state;
  }

  set state(value: State) {
    if (value === this.#state) return;
    this.#state = value;
    if (this.#stateListeners) this.dispatchEvent(new Event("state"));
  }

  hasState(flags: number): boolean {
    return (this.#state & flags) !== 0;
  }

  get hasChanges(): boolean {
    if ((this.#state & Changed) !== 0) return true;
    for (const name of metaOf(this).tracked)
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
    if (originals) {
      this.#originals = undefined;
      for (const name in originals) {
        const accessor = own.raw[name]!;
        const previous = accessor.get.call(this);
        const value = originals[name];
        accessor.set.call(this, value);
        if (this.#changeListeners) this.dispatchEvent(new ModelChangeEvent(name, value, previous));
      }
    }
    const values = this as unknown as Record<string, unknown>;
    for (const name of own.tracked) revertValue(values[name]);
    if (this.#state === State.Added) this.state = State.Detached;
    else if (this.#state > State.Added) this.state = State.Unchanged;
    return this;
  }

  /** Takes the values the server confirmed as the new originals; nested models and sets confirm theirs. */
  confirmChanges(values?: object): this {
    const own = metaOf(this);
    const data = values as Record<string, unknown> | undefined;
    this.#originals = undefined;
    for (const name of own.tracked) {
      const accessor = own.raw[name]!;
      const current = accessor.get.call(this) as { confirmChanges?: (values?: object) => unknown } | null;
      if (current !== null && typeof current === "object" && typeof current.confirmChanges === "function") {
        current.confirmChanges(data?.[name] as object | undefined);
      } else if (data && name in data) {
        const value = data[name];
        if (isLike(current, value)) continue;
        accessor.set.call(this, value);
        if (this.#changeListeners) this.dispatchEvent(new ModelChangeEvent(name, value, current));
      }
    }
    if ((this.#state & (State.Added | State.Modified)) !== 0) this.state = State.Unchanged;
    return this;
  }

  markAdded(): this {
    this.state = State.Added;
    return this;
  }

  markModified(): this {
    if (this.#state !== State.Added) this.state = State.Modified;
    return this;
  }

  markUnchanged(): this {
    this.state = State.Unchanged;
    return this;
  }

  markDeleted(): this {
    if (this.#state !== State.Detached) this.state = State.Deleted;
    return this;
  }

  /**
   * Writes construction data without tracking it. Call it last in the most derived constructor:
   * the fields a subclass declares are only initialized once its own initializers have run.
   */
  protected assign(data?: object): this {
    if (!data) return this;
    const own = metaOf(this);
    for (const [name, value] of Object.entries(data)) {
      if (name === "state") continue;
      const accessor = own.raw[name];
      if (accessor) accessor.set.call(this, value);
      else if (!own.persisted.includes(name)) (this as unknown as Record<string, unknown>)[name] = value;
    }
    return this;
  }

  // Counted so that a model nobody watches never allocates an event.
  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (callback) {
      if (type === "change") this.#changeListeners++;
      else if (type === "state") this.#stateListeners++;
    }
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (callback) {
      if (type === "change" && this.#changeListeners > 0) this.#changeListeners--;
      else if (type === "state" && this.#stateListeners > 0) this.#stateListeners--;
    }
    super.removeEventListener(type, callback, options);
  }

  /** @internal What a tracked setter reports once it has stored a different value. */
  [change](name: string, value: unknown, previous: unknown): void {
    const originals = (this.#originals ??= {});
    if (!(name in originals)) originals[name] = previous;
    if (this.#state === State.Detached) this.state = State.Added;
    else if (this.#state === State.Unchanged) this.state = State.Modified;
    if (this.#changeListeners) this.dispatchEvent(new ModelChangeEvent(name, value, previous));
  }
}

/** @internal The tracking accessor decorator the bundle emits on every field of a model. */
export function __track<T extends Model, V>(
  target: ClassAccessorDecoratorTarget<T, V>,
  context: ClassAccessorDecoratorContext<T, V>,
): ClassAccessorDecoratorResult<T, V> {
  const name = context.name as string;
  const own = metaFor(context.metadata);
  own.tracked.push(name);
  own.raw[name] = target as Accessor;
  return {
    set(this: T, value: V) {
      const previous = target.get.call(this);
      if (isLike(previous, value)) return;
      target.set.call(this, value);
      this[change](name, value, previous);
    },
  };
}

/** Serializes a computed getter with the model's own fields. */
export function Persist<T extends Model, V>(_getter: () => V, context: ClassGetterDecoratorContext<T, V>): void {
  metaFor(context.metadata).persisted.push(context.name as string);
}

/** Keeps a member out of `changes` and `toJSON`. */
export function Ignore(
  _member: unknown,
  context: ClassAccessorDecoratorContext | ClassFieldDecoratorContext | ClassGetterDecoratorContext,
): void {
  metaFor(context.metadata).ignored[context.name as string] = true;
}

/** Leaves a field plain: the bundle does not turn it into a tracked accessor. */
export function Untracked(_value: undefined, _context: ClassFieldDecoratorContext): void {}

/** Values a tracked field considers the same: dates by time, arrays and plain objects deeply, models by identity. */
export function isLike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof Model || b instanceof Model) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => isLike(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const names = Object.keys(left);
  if (names.length !== Object.keys(right).length) return false;
  return names.every((name) => isLike(left[name], right[name]));
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
