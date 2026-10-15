import { expect, test } from "bun:test";
import {
  Model,
  Persist,
  State,
  Validate,
  email,
  isValidPhone,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nonZero,
  phone,
  required,
  requiredIdValue,
  type Validator,
} from "./model";

// Written the way the bundle rewrites a model class (see model.test.ts); `@Validate` sits on the getter.

const validNumber: Validator = (v, model) => model.state === State.Detached || v > 0 || "Field should be > 0";

class Worker extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #name = ""; get name(): string { return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(0, p); }
  #hours = 0; @Validate(validNumber) get hours(): number { return this.#hours; } set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(1, p); }
  #tax = 0; @Validate(validNumber) get tax(): number { return this.#tax; } set tax(v: number) { const p = this.#tax; if (Model.same(p, v)) return; this.#tax = v; this.$changed(2, p); }

  @Persist get payment(): number {
    return this.hours * this.tax;
  }
static { Model.$define(this, ["name", "hours", "tax"]); } }

class Order extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #worker = new Worker(); get worker(): Worker { return this.#worker; } set worker(v: Worker) { const p = this.#worker; if (Model.same(p, v)) return; this.#worker = v; this.$changed(0, p); }
  #crew: Worker[] = []; get crew(): Worker[] { return this.#crew; } set crew(v: Worker[]) { const p = this.#crew; if (Model.same(p, v)) return; this.#crew = v; this.$changed(1, p); }
  #dates: Record<string, Date> = {}; get dates(): Record<string, Date> { return this.#dates; } set dates(v: Record<string, Date>) { const p = this.#dates; if (Model.same(p, v)) return; this.#dates = v; this.$changed(2, p); }
static { Model.$define(this, ["worker", "crew", "dates"]); } }

// Decorators on one getter run bottom to top, so `maxValue` reports before `minValue`.
class Gauge extends Model { constructor(data?: object) { super(data); if (new.target === Gauge) this.assign(data); }
  #level = 0; @Validate(minValue(5)) @Validate(maxValue(3)) get level(): number { return this.#level; } set level(v: number) { const p = this.#level; if (Model.same(p, v)) return; this.#level = v; this.$changed(0, p); }
static { Model.$define(this, ["level"]); } }

class Strict extends Gauge { constructor(data?: object) { super(data); if (new.target === Strict) this.assign(data); }
  #label = ""; @Validate(required) get label(): string { return this.#label; } set label(v: string) { const p = this.#label; if (Model.same(p, v)) return; this.#label = v; this.$changed(1, p); }
static { Model.$define(this, ["label"]); } }

test("a Detached model has no errors, even with invalid values", () => {
  const worker = new Worker();
  expect(worker.hours).toBe(0);
  expect(worker.hasErrors).toBe(false);
  expect(worker.errors).toEqual({});
  expect(worker.hasValidChanges).toBe(false);
});

test("a model reports errors, but lists them only once it changed", () => {
  const worker = new Worker({ name: "Ada", hours: 0, tax: 2 });
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasErrors).toBe(true);
  expect(worker.errors).toEqual({});

  worker.name = "Grace";
  expect(worker.errors).toEqual({ hours: ["Field should be > 0"], tax: [] });
  expect(Object.getPrototypeOf(worker.errors)).toBeNull();

  worker.hours = 3;
  expect(worker.hasErrors).toBe(false);
  expect(worker.errors).toEqual({ hours: [], tax: [] });
});

test("the errors of a model whose changes were confirmed or reverted are empty again", () => {
  const worker = new Worker({ hours: 0, tax: 2 });
  worker.tax = 3;
  expect(worker.errors.hours).toEqual(["Field should be > 0"]);
  worker.revertChanges();
  expect(worker.errors).toEqual({});
  worker.tax = 3;
  worker.confirmChanges();
  expect(worker.errors).toEqual({});
});

test("an Added model lists its errors, a Deleted one has none", () => {
  const worker = new Worker({ state: State.Added, hours: 0 });
  expect(worker.hasErrors).toBe(true);
  expect(worker.errors.hours).toEqual(["Field should be > 0"]);
  worker.markDeleted();
  expect(worker.hasErrors).toBe(false);
  expect(worker.errors).toEqual({});
});

test("a validator receives the value and the model", () => {
  const seen: unknown[][] = [];
  const spy: Validator = (v, m) => (seen.push([v, m]), true);
  class Spy extends Model { constructor(data?: object) { super(data); this.assign(data); }
    #x = 7; @Validate(spy) get x(): number { return this.#x; } set x(v: number) { const p = this.#x; if (Model.same(p, v)) return; this.#x = v; this.$changed(0, p); }
  static { Model.$define(this, ["x"]); } }
  const model = new Spy({});
  void model.hasErrors;
  expect(seen).toEqual([[7, model]]);
});

test("errors of nested models, sets and plain graphs bubble into hasErrors", () => {
  const invalid = () => new Worker({ hours: 0 });
  const valid = () => new Worker({ hours: 1, tax: 1 });

  expect(new Order({ worker: valid() }).hasErrors).toBe(false);
  expect(new Order({ worker: invalid() }).hasErrors).toBe(true);
  expect(new Order({ crew: [valid(), invalid()] }).hasErrors).toBe(true);
  expect(new Order({ dates: { a: new Date(0) } }).hasErrors).toBe(false);

  const set = { hasErrors: true };
  expect(new Order({ crew: set }).hasErrors).toBe(true);
  expect(new Order({ crew: { hasErrors: false } }).hasErrors).toBe(false);

  const order = new Order({ worker: invalid() });
  order.markDeleted();
  expect(order.hasErrors).toBe(false);
});

test("decorators on one field accumulate", () => {
  const gauge = new Gauge({ level: 4 });
  gauge.level = 4.5;
  expect(gauge.errors).toEqual({
    level: ["Field must be less than or equal to 3", "Field must be greater than or equal to 5"],
  });
  gauge.level = 3;
  expect(gauge.errors).toEqual({ level: ["Field must be greater than or equal to 5"] });
});

test("a subclass keeps the validators of its base and adds its own", () => {
  const strict = new Strict({ level: 3, label: "" });
  strict.level = 4;
  expect(strict.errors).toEqual({
    level: ["Field must be less than or equal to 3", "Field must be greater than or equal to 5"],
    label: ["Field is required"],
  });
  expect(new Gauge({ level: 0 }).hasErrors).toBe(true);
  expect(new Gauge({ level: 3 }).errors).toEqual({});
});

test("hasValidChanges needs changes and no errors", () => {
  const worker = new Worker({ hours: 1, tax: 1 });
  expect(worker.hasValidChanges).toBe(false);
  worker.hours = 2;
  expect(worker.hasValidChanges).toBe(true);
  worker.hours = 0;
  expect(worker.hasChanges).toBe(true);
  expect(worker.hasValidChanges).toBe(false);
});

test("the validators say pass with true and fail with the message", () => {
  expect(required("a")).toBe(true);
  expect(required(0)).toBe(true);
  for (const v of [undefined, null, "", "  "]) expect(required(v)).toBe("Field is required");

  expect(email("ada@example.com")).toBe(true);
  expect(email("ada@")).toBe("Field should be a valid e-mail");
  expect(email(null)).toBe("Field should be a valid e-mail");

  expect(phone(null)).toBe(true);
  expect(phone("+1 (809) 555-1234")).toBe(true);
  expect(phone("809-555-1234 ext. 12")).toBe(true);
  expect(phone("call me")).toBe("Field should be a valid phone");
  expect(isValidPhone(undefined as never)).toBe(true);

  expect(maxLength(3)("abc")).toBe(true);
  expect(maxLength(3)("abcd")).toBe("Field length is limited to 3");
  expect(minLength(2)("ab")).toBe(true);
  expect(minLength(2)("a")).toBe("Field min length is 2 characters");

  expect(requiredIdValue(1)).toBe(true);
  for (const v of [0, null, undefined, "", " "]) expect(requiredIdValue(v)).toBe("Field is required");

  expect(nonZero(1)).toBe(true);
  expect(nonZero(0)).toBe("Value must be greater than 0");

  expect(minValue(5)(5)).toBe(true);
  expect(minValue(5)(4)).toBe("Field must be greater than or equal to 5");
  expect(minValue(5, false)(5)).toBe("Field must be greater than  5");
  expect(minValue(5, false)(6)).toBe(true);

  expect(maxValue(5)(5)).toBe(true);
  expect(maxValue(5)(6)).toBe("Field must be less than or equal to 5");
  expect(maxValue(5, false)(5)).toBe("Field must be less than  5");
  expect(maxValue(5, false)(4)).toBe(true);
});
