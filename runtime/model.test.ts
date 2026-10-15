import { expect, spyOn, test } from "bun:test";
import { Ignore, Model, ModelChangeEvent, Persist, State, StateKey, Untracked, isLike } from "./model";

// Written the way the bundle rewrites a model class: every field becomes a `#private` slot with a
// getter and a setter on the prototype, a `$define` static block and a constructor (Task 2 emits these).

class Address extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #city = ""; get city(): string { Model.$reader?.(this, 0); return this.#city; } set city(v: string) { const p = this.#city; if (Model.same(p, v)) return; this.#city = v; this.$changed(0, p); }
  #zip = ""; get zip(): string { Model.$reader?.(this, 1); return this.#zip; } set zip(v: string) { const p = this.#zip; if (Model.same(p, v)) return; this.#zip = v; this.$changed(1, p); }
static { Model.$define(this, ["city", "zip"]); } }

class Worker extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #name = ""; get name(): string { Model.$reader?.(this, 0); return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(0, p); }
  #hours = 0; get hours(): number { Model.$reader?.(this, 1); return this.#hours; } set hours(v: number) { const p = this.#hours; if (Model.same(p, v)) return; this.#hours = v; this.$changed(1, p); }
  #hired: Date | null = null; get hired(): Date | null { Model.$reader?.(this, 2); return this.#hired; } set hired(v: Date | null) { const p = this.#hired; if (Model.same(p, v)) return; this.#hired = v; this.$changed(2, p); }
  #tags: string[] = []; get tags(): string[] { Model.$reader?.(this, 3); return this.#tags; } set tags(v: string[]) { const p = this.#tags; if (Model.same(p, v)) return; this.#tags = v; this.$changed(3, p); }
  #secret = ""; @Ignore get secret(): string { Model.$reader?.(this, 4); return this.#secret; } set secret(v: string) { const p = this.#secret; if (Model.same(p, v)) return; this.#secret = v; this.$changed(4, p); }
  #address = new Address(); get address(): Address { Model.$reader?.(this, 5); return this.#address; } set address(v: Address) { const p = this.#address; if (Model.same(p, v)) return; this.#address = v; this.$changed(5, p); }
  @Untracked note = "";

  @Persist get payment(): number {
    return this.hours * 10;
  }
static { Model.$define(this, ["name", "hours", "hired", "tags", "secret", "address"]); } }

// Fields named like `Object.prototype` members must not be confused with it.
class Odd extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #toString = ""; get toString(): string { Model.$reader?.(this, 0); return this.#toString; } set toString(v: string) { const p = this.#toString; if (Model.same(p, v)) return; this.#toString = v; this.$changed(0, p); }
  #hasOwnProperty = ""; get hasOwnProperty(): string { Model.$reader?.(this, 1); return this.#hasOwnProperty; } set hasOwnProperty(v: string) { const p = this.#hasOwnProperty; if (Model.same(p, v)) return; this.#hasOwnProperty = v; this.$changed(1, p); }
static { Model.$define(this, ["toString", "hasOwnProperty"]); } }

test("a model built without data is Detached and its first change makes it Added", () => {
  const worker = new Worker();
  expect(worker[StateKey]).toBe(State.Detached);
  expect(worker.hasChanges).toBe(false);

  worker.name = "Ada";
  expect(worker.name).toBe("Ada");
  expect(worker[StateKey]).toBe(State.Added);
  expect(worker.hasState(State.Added | State.Modified)).toBe(true);
  expect(worker.hasChanges).toBe(true);
});

test("a model built with data is Unchanged, keeps the data out of the changes, and its first change makes it Modified", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  expect(worker.name).toBe("Ada");
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(worker.changes).toBeNull();

  worker.hours = 3;
  expect(worker[StateKey]).toBe(State.Modified);
});

test("the state comes from the data when it carries one", () => {
  expect(new Worker({ $$: State.Added })[StateKey]).toBe(State.Added);
  expect(new Worker({ $$: State.Added, name: "Ada" }).name).toBe("Ada");
  expect(new Worker({ state: State.Added })[StateKey]).toBe(State.Unchanged);
});

test("the state is not an own property: keys, spreads and JSON.stringify differ", () => {
  const worker = new Worker({ name: "Ada" });
  expect(Object.keys(worker)).not.toContain("state");
  expect(Object.getOwnPropertySymbols(worker)).not.toContain(StateKey);
  expect(Object.keys({ ...worker })).toEqual(["note"]);
  expect("state" in worker).toBe(false);
  expect(JSON.parse(JSON.stringify(worker)).$$).toBe(State.Unchanged);
});

test("setting an equal value changes nothing and dispatches nothing", () => {
  const worker = new Worker({ name: "Ada", hired: new Date(1000), tags: ["a", "b"] });
  worker.addEventListener("change", () => {});
  const dispatch = spyOn(worker, "dispatchEvent");

  worker.name = "Ada";
  worker.hired = new Date(1000);
  worker.tags = ["a", "b"];

  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});

test("a model nobody listens to never dispatches an event", () => {
  const worker = new Worker({ name: "Ada" });
  const dispatch = spyOn(worker, "dispatchEvent");

  worker.name = "Grace";
  worker.markDeleted();

  expect(worker[StateKey]).toBe(State.Deleted);
  expect(dispatch).not.toHaveBeenCalled();
});

test("a change listener receives the property, the value and the previous value", () => {
  const worker = new Worker({ name: "Ada" });
  const seen: ModelChangeEvent[] = [];
  const listener = (e: Event) => seen.push(e as ModelChangeEvent);
  worker.addEventListener("change", listener);

  worker.name = "Grace";
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeInstanceOf(ModelChangeEvent);
  expect(seen[0]!.type).toBe("change");
  expect(seen[0]!.property).toBe("name");
  expect(seen[0]!.value).toBe("Grace");
  expect(seen[0]!.previous).toBe("Ada");

  worker.removeEventListener("change", listener);
  const dispatch = spyOn(worker, "dispatchEvent");
  worker.name = "Hedy";
  expect(dispatch).not.toHaveBeenCalled();
});

test("adding the same listener twice counts it once", () => {
  const worker = new Worker({ name: "Ada" });
  let seen = 0;
  const listener = () => seen++;
  worker.addEventListener("change", listener);
  worker.addEventListener("change", listener);

  worker.name = "Grace";
  expect(seen).toBe(1);

  worker.removeEventListener("change", listener);
  const dispatch = spyOn(worker, "dispatchEvent");
  worker.name = "Hedy";
  expect(dispatch).not.toHaveBeenCalled();
});

test("removing a listener that was never added changes nothing", () => {
  const worker = new Worker({ name: "Ada" });
  let seen = 0;
  const listener = () => seen++;
  worker.addEventListener("change", listener);

  worker.removeEventListener("change", () => {});
  worker.removeEventListener("state", listener);

  worker.name = "Grace";
  expect(seen).toBe(1);
});

test("a once listener stops counting after it has fired", () => {
  const worker = new Worker({ name: "Ada" });
  let seen = 0;
  worker.addEventListener("change", () => seen++, { once: true });

  worker.name = "Grace";
  expect(seen).toBe(1);

  const dispatch = spyOn(worker, "dispatchEvent");
  worker.name = "Hedy";
  expect(seen).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test("an aborted signal stops the listener counting", () => {
  const worker = new Worker({ name: "Ada" });
  const controller = new AbortController();
  let seen = 0;
  worker.addEventListener("change", () => seen++, { signal: controller.signal });

  worker.name = "Grace";
  expect(seen).toBe(1);
  controller.abort();

  const dispatch = spyOn(worker, "dispatchEvent");
  worker.name = "Hedy";
  expect(seen).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test("a listener added with an already aborted signal is not counted", () => {
  const worker = new Worker({ name: "Ada" });
  worker.addEventListener("change", () => {}, { signal: AbortSignal.abort() });

  const dispatch = spyOn(worker, "dispatchEvent");
  worker.name = "Grace";
  expect(dispatch).not.toHaveBeenCalled();
});

test("the state event fires when the state moves", () => {
  const worker = new Worker({ name: "Ada" });
  let states = 0;
  worker.addEventListener("state", () => states++);

  worker.name = "Grace";
  worker.hours = 4;

  expect(states).toBe(1);
  expect(worker[StateKey]).toBe(State.Modified);
});

test("the mark methods move the state like the tracker does", () => {
  expect(new Worker().markDeleted()[StateKey]).toBe(State.Detached);
  expect(new Worker({}).markDeleted()[StateKey]).toBe(State.Deleted);
  expect(new Worker({}).markAdded().markModified()[StateKey]).toBe(State.Added);
  expect(new Worker({}).markModified()[StateKey]).toBe(State.Modified);
  expect(new Worker().markModified().markUnchanged()[StateKey]).toBe(State.Unchanged);
  expect(new Worker({}).hasState(State.Detached | State.Deleted)).toBe(false);
});

test("an untracked field stays a plain field", () => {
  const worker = new Worker({ name: "Ada" });
  worker.note = "nothing to see";
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.changes).toBeNull();
});

test("assign only takes the tracked fields of the class", () => {
  const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"note":"x","name":"Ada"}');
  const worker = new Worker(data);

  expect(worker.name).toBe("Ada");
  expect(worker.note).toBe("");
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect((Worker as unknown as Record<string, unknown>).polluted).toBeUndefined();
});

test("fields named like Object.prototype members are tracked and serialized", () => {
  const odd = new Odd({ toString: "a", hasOwnProperty: "b" });
  odd.toString = "c";

  expect(odd[StateKey]).toBe(State.Modified);
  expect(odd.toJSON()).toEqual({ $$: State.Modified, toString: "c", hasOwnProperty: "b" });
  expect(odd.changes).toEqual({ $$: State.Modified, toString: "c", hasOwnProperty: "b" });

  odd.revertChanges();
  expect(odd.toJSON()).toEqual({ $$: State.Unchanged, toString: "a", hasOwnProperty: "b" });
});

test("revertChanges restores the values and the state", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  worker.name = "Grace";
  worker.hours = 8;
  worker.name = "Hedy";

  const reverted: string[] = [];
  worker.addEventListener("change", (e) => reverted.push((e as ModelChangeEvent).property));
  expect(worker.revertChanges()).toBe(worker);

  expect(worker.name).toBe("Ada");
  expect(worker.hours).toBe(2);
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(reverted.sort()).toEqual(["hours", "name"]);
});

test("writes made by a listener while reverting are tracked", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  const other = new Worker({ name: "Log", hours: 0 });
  worker.name = "Grace";
  worker.addEventListener("change", () => (other.hours += 1));
  worker.revertChanges();
  expect(other.hours).toBe(1);
  expect(other[StateKey]).toBe(State.Modified);
});

test("revertChanges on a new model detaches it again", () => {
  const worker = new Worker();
  worker.name = "Ada";
  expect(worker[StateKey]).toBe(State.Added);

  worker.revertChanges();
  expect(worker.name).toBe("");
  expect(worker[StateKey]).toBe(State.Detached);
});

test("revertChanges reverts the nested models that changed", () => {
  const worker = new Worker({ name: "Ada", address: new Address({ city: "Paris", zip: "75" }) });
  worker.address.city = "Rome";
  expect(worker.hasChanges).toBe(true);

  worker.revertChanges();
  expect(worker.address.city).toBe("Paris");
  expect(worker.address[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
});

test("confirmChanges clears the originals and makes Added and Modified Unchanged", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  worker.hours = 8;

  expect(worker.confirmChanges()).toBe(worker);
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);

  worker.revertChanges();
  expect(worker.hours).toBe(8);
});

test("confirmChanges applies the server values without tracking them", () => {
  const worker = new Worker();
  worker.name = "Ada";
  expect(worker[StateKey]).toBe(State.Added);

  worker.confirmChanges({ name: "Ada Lovelace", hours: 7, address: { city: "London" } });

  expect(worker.name).toBe("Ada Lovelace");
  expect(worker.hours).toBe(7);
  expect(worker.address.city).toBe("London");
  expect(worker[StateKey]).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
});

test("changes lists the primitives and the changed nested models, and skips the ignored fields", () => {
  const worker = new Worker({ name: "Ada", hours: 2, hired: new Date(1000) });
  worker.hours = 3;
  worker.secret = "hidden";
  worker.address.city = "Paris";

  expect(worker.changes).toEqual({
    $$: State.Modified,
    name: "Ada",
    hours: 3,
    hired: new Date(1000),
    payment: 30,
    address: { $$: State.Added, city: "Paris", zip: "" },
  });
});

test("toJSON keeps the persisted getters and drops the ignored fields", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  worker.secret = "hidden";

  expect(JSON.parse(JSON.stringify(worker))).toEqual({
    $$: State.Modified,
    name: "Ada",
    hours: 2,
    hired: null,
    tags: [],
    payment: 20,
    address: { $$: State.Detached, city: "", zip: "" },
  });
});

test("isLike compares primitives, dates, arrays, plain objects and models", () => {
  expect(isLike(1, 1)).toBe(true);
  expect(isLike("a", "b")).toBe(false);
  expect(isLike(null, undefined)).toBe(false);
  expect(isLike(new Date(5), new Date(5))).toBe(true);
  expect(isLike(new Date(5), new Date(6))).toBe(false);
  expect(isLike([1, [2]], [1, [2]])).toBe(true);
  expect(isLike([1, 2], [1, 2, 3])).toBe(false);
  expect(isLike({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
  expect(isLike({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(Model.same(1, 1)).toBe(true);

  const address = new Address({ city: "Paris" });
  expect(isLike(address, address)).toBe(true);
  expect(isLike(address, new Address({ city: "Paris" }))).toBe(false);
});

test("a subclass tracks its own fields and the inherited ones", () => {
  class Manager extends Worker { constructor(data?: object) { super(data); this.assign(data); }
    #reports = 0; get reports(): number { Model.$reader?.(this, 6); return this.#reports; } set reports(v: number) { const p = this.#reports; if (Model.same(p, v)) return; this.#reports = v; this.$changed(6, p); }
  static { Model.$define(this, ["reports"]); } }

  const manager = new Manager({ name: "Ada" });
  manager.reports = 3;
  expect(manager[StateKey]).toBe(State.Modified);
  expect(manager.changes).toMatchObject({ name: "Ada", reports: 3, payment: 0 });

  manager.revertChanges();
  expect(manager.reports).toBe(0);
  expect(manager[StateKey]).toBe(State.Unchanged);
});

test("an unguarded base constructor does not throw before the subclass fields exist", () => {
  class Manager extends Worker { constructor(data?: object) { super(data); this.assign(data); }
    #reports = 0; get reports(): number { Model.$reader?.(this, 6); return this.#reports; } set reports(v: number) { const p = this.#reports; if (Model.same(p, v)) return; this.#reports = v; this.$changed(6, p); }
  static { Model.$define(this, ["reports"]); } }

  const manager = new Manager({ name: "Ada", hours: 4, reports: 3 });
  expect(manager.name).toBe("Ada");
  expect(manager.hours).toBe(4);
  expect(manager.reports).toBe(3);
  expect(manager[StateKey]).toBe(State.Unchanged);
});
