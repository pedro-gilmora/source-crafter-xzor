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

export { EntitySet } from "./entity-set";

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
  validators: [string, Validator[]][];
  serialized?: string[];
};

/** `true` when the value is valid, otherwise the message. */
export type Validator = (value: any, model: any) => true | string;

/** One registration, kept only for `change` and `state` so a model knows whether it is watched. */
type Watch = {
  type: string;
  callback: EventListenerOrEventListenerObject;
  capture: boolean;
  wrapped?: EventListener;
};

const meta = Symbol("xzor.model.meta");
const empty: Meta = { names: [], tracked: new Set(), persisted: [], ignored: new Set(), validators: [], serialized: [] };

// A class's member decorators all run before its `$define`, which takes these over.
let pendingPersist: string[] | undefined;
let pendingIgnored: string[] | undefined;
let pendingValidators: [string, Validator[]][] | undefined;

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
      validators: base ? base.validators.map(([name, list]) => [name, list.slice()]) : [],
    };
    if (pendingValidators) {
      for (const [name, list] of pendingValidators) {
        const known = own.validators.find((entry) => entry[0] === name);
        if (known) known[1].push(...list);
        else own.validators.push([name, list]);
      }
      pendingValidators = undefined;
    }
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

  /** False while Detached or Deleted; otherwise whether a validator fails here or in a nested model or set. */
  get hasErrors(): boolean {
    if ((this.#state & (State.Detached | State.Deleted)) !== 0) return false;
    const own = metaOf(this);
    const values = this as unknown as Record<string, unknown>;
    for (let i = 0; i < own.validators.length; i++) {
      const [name, list] = own.validators[i];
      for (const validate of list) if (typeof validate(values[name], this) === "string") return true;
    }
    for (const name of own.names) if (valueHasErrors(values[name])) return true;
    return false;
  }

  /** The failures of every validated field, but only once this model changed: a fresh one shows none. */
  get errors(): Record<string, string[]> {
    const result = Object.create(null) as Record<string, string[]>;
    if ((this.#state & (State.Detached | State.Deleted)) !== 0) return result;
    if (this.#originals === undefined && (this.#state & (State.Added | State.Modified)) === 0) return result;
    const values = this as unknown as Record<string, unknown>;
    const validators = metaOf(this).validators;
    for (let i = 0; i < validators.length; i++) {
      const [name, list] = validators[i];
      const messages = (result[name] = [] as string[]);
      for (const validate of list) {
        const message = validate(values[name], this);
        if (typeof message === "string") messages.push(message);
      }
    }
    return result;
  }

  get hasValidChanges(): boolean {
    return this.hasChanges && !this.hasErrors;
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
          this.#emit(name, value, previous);
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
          this.#emit(name, value, current);
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
    const names = metaOf(this).names;
    const target = this as unknown as Record<string, unknown>;
    if (data) {
      const tracked = metaOf(this).tracked;
      const source = data as Record<string, unknown>;
      silent++;
      try {
        for (const name in source) if (tracked.has(name)) target[name] = source[name];
      } finally {
        silent--;
      }
    }
    for (let i = 0; i < names.length; i++) attach(target[names[i]!], this, i);
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
    const value = (this as unknown as Record<string, unknown>)[name];
    attach(value, this, index);
    this.#emit(name, value, previous);
  }

  /** @internal A set on a tracked field was mutated: it keeps its own state, the model only tells its listeners. */
  $touched(index: number): void {
    const name = metaOf(this).names[index]!;
    const value = (this as unknown as Record<string, unknown>)[name];
    this.#emit(name, value, value);
  }

  // Listeners run outside silent mode, so their own writes are tracked.
  #emit(name: string, value: unknown, previous: unknown): void {
    if (!this.#listens("change")) return;
    const depth = silent;
    silent = 0;
    try {
      this.dispatchEvent(new ModelChangeEvent(name, value, previous));
    } finally {
      silent = depth;
    }
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

/** Checks the field with these validators; several `@Validate` on one field add up. */
export function Validate(
  ...validators: Validator[]
): (_member: unknown, context: ClassGetterDecoratorContext | ClassFieldDecoratorContext) => void {
  return (_member, context) => {
    (pendingValidators ??= []).push([context.name as string, validators]);
  };
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

// A set on a tracked field learns which model and property hold it.
function attach(value: unknown, owner: Model, index: number): void {
  if (value !== null && typeof value === "object") {
    const set = value as { $own?: (owner: Model, index: number) => void };
    if (typeof set.$own === "function") set.$own(owner, index);
  }
}

// Models and sets answer `hasChanges`, `changes`, `revertChanges` and `confirmChanges` themselves.
function valueHasChanges(value: unknown): boolean {
  if (value === null || typeof value !== "object" || value instanceof Date) return false;
  const changes = (value as { hasChanges?: unknown }).hasChanges;
  if (typeof changes === "boolean") return changes;
  if (Array.isArray(value)) return value.some(valueHasChanges);
  return Object.values(value).some(valueHasChanges);
}

function valueHasErrors(value: unknown): boolean {
  if (value === null || typeof value !== "object" || value instanceof Date) return false;
  const errors = (value as { hasErrors?: unknown }).hasErrors;
  if (typeof errors === "boolean") return errors;
  if (Array.isArray(value)) return value.some(valueHasErrors);
  return Object.values(value).some(valueHasErrors);
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

export const required = (value: any): true | string =>
  value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "") ? true : "Field is required";

// The original e-mail pattern, minus `.` inside domain labels so it cannot backtrack exponentially.
const emailTest = /^((([a-z]|\d|[!#$%&'*+\-\/=?^_`{|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#$%&'*+\-\/=?^_`{|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)(((([\x20\x09])*(\x0d\x0a))?([\x20\x09])+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*((([\x20\x09])*(\x0d\x0a))?([\x20\x09])+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?$/i;

export const email: Validator = (value) =>
  (value ?? "").length <= 254 && emailTest.test(value ?? "") ? true : "Field should be a valid e-mail";

// Written so each digit has one way to match, to avoid backtracking.
const phoneTest = /^(\+\s?)?((?<!\+.*)\(\+?\d+([\s\-.]?\d+)?\)|\d)(?:\d|[\s\-.]\d|[\s\-.]?\(\d+(?:[\s\-.]?\d+)?\))*(\s?(x|ext\.?)\s?\d+)?$/i;

/** A missing phone is valid: pair it with `required`. */
export function isValidPhone(value: string | null | undefined): boolean {
  return value == null || phoneTest.test(value);
}

export const phone: Validator = (value) => (isValidPhone(value ?? null) ? true : "Field should be a valid phone");

export const maxLength = (length: number): Validator => (value) =>
  `${value}`.length <= length ? true : `Field length is limited to ${length}`;

export const minLength = (length: number): Validator => (value) =>
  `${value}`.length >= length ? true : `Field min length is ${length} characters`;

export const requiredIdValue: Validator = (value) => (required(value) === true && value > 0 ? true : "Field is required");

export const nonZero: Validator = (value) => (value > 0 ? true : "Value must be greater than 0");

export const minValue = (min: number, inclusive = true): Validator => (value) =>
  (inclusive ? value >= min : value > min) ? true : `Field must be greater than ${inclusive ? "or equal to" : ""} ${min}`;

export const maxValue = (max: number, inclusive = true): Validator => (value) =>
  (inclusive ? value <= max : value < max) ? true : `Field must be less than ${inclusive ? "or equal to" : ""} ${max}`;
