import { expect, spyOn, test } from "bun:test";
import { __track, Ignore, Model, ModelChangeEvent, Persist, State, Untracked, isLike } from "./model";

// Written the way the bundle rewrites a model class (Task 2 turns plain fields into these accessors).

class Address extends Model {
  @__track accessor city = "";
  @__track accessor zip = "";

  constructor(data?: Partial<Address>) {
    super(data);
    this.assign(data);
  }
}

class Worker extends Model {
  @__track accessor name = "";
  @__track accessor hours = 0;
  @__track accessor hired: Date | null = null;
  @__track accessor tags: string[] = [];
  @Ignore @__track accessor secret = "";
  @__track accessor address = new Address();
  @Untracked note = "";

  @Persist get payment(): number {
    return this.hours * 10;
  }

  constructor(data?: Partial<Worker>) {
    super(data);
    this.assign(data);
  }
}

test("a model built without data is Detached and its first change makes it Added", () => {
  const worker = new Worker();
  expect(worker.state).toBe(State.Detached);
  expect(worker.hasChanges).toBe(false);

  worker.name = "Ada";
  expect(worker.name).toBe("Ada");
  expect(worker.state).toBe(State.Added);
  expect(worker.hasState(State.Added | State.Modified)).toBe(true);
  expect(worker.hasChanges).toBe(true);
});

test("a model built with data is Unchanged, keeps the data out of the changes, and its first change makes it Modified", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  expect(worker.name).toBe("Ada");
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(worker.changes).toBeNull();

  worker.hours = 3;
  expect(worker.state).toBe(State.Modified);
});

test("the state comes from the data when it carries one", () => {
  expect(new Worker({ state: State.Added }).state).toBe(State.Added);
});

test("setting an equal value changes nothing and dispatches nothing", () => {
  const worker = new Worker({ name: "Ada", hired: new Date(1000), tags: ["a", "b"] });
  worker.addEventListener("change", () => {});
  const dispatch = spyOn(worker, "dispatchEvent");

  worker.name = "Ada";
  worker.hired = new Date(1000);
  worker.tags = ["a", "b"];

  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});

test("a model nobody listens to never dispatches an event", () => {
  const worker = new Worker({ name: "Ada" });
  const dispatch = spyOn(worker, "dispatchEvent");

  worker.name = "Grace";
  worker.markDeleted();

  expect(worker.state).toBe(State.Deleted);
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

test("the state event fires when the state moves", () => {
  const worker = new Worker({ name: "Ada" });
  let states = 0;
  worker.addEventListener("state", () => states++);

  worker.name = "Grace";
  worker.hours = 4;

  expect(states).toBe(1);
  expect(worker.state).toBe(State.Modified);
});

test("the mark methods move the state like the tracker does", () => {
  expect(new Worker().markDeleted().state).toBe(State.Detached);
  expect(new Worker({}).markDeleted().state).toBe(State.Deleted);
  expect(new Worker({}).markAdded().markModified().state).toBe(State.Added);
  expect(new Worker({}).markModified().state).toBe(State.Modified);
  expect(new Worker().markModified().markUnchanged().state).toBe(State.Unchanged);
  expect(new Worker({}).hasState(State.Detached | State.Deleted)).toBe(false);
});

test("an untracked field stays a plain field", () => {
  const worker = new Worker({ name: "Ada" });
  worker.note = "nothing to see";
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.changes).toBeNull();
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
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
  expect(reverted.sort()).toEqual(["hours", "name"]);
});

test("revertChanges on a new model detaches it again", () => {
  const worker = new Worker();
  worker.name = "Ada";
  expect(worker.state).toBe(State.Added);

  worker.revertChanges();
  expect(worker.name).toBe("");
  expect(worker.state).toBe(State.Detached);
});

test("revertChanges reverts the nested models that changed", () => {
  const worker = new Worker({ name: "Ada", address: new Address({ city: "Paris", zip: "75" }) });
  worker.address.city = "Rome";
  expect(worker.hasChanges).toBe(true);

  worker.revertChanges();
  expect(worker.address.city).toBe("Paris");
  expect(worker.address.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
});

test("confirmChanges clears the originals and makes Added and Modified Unchanged", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  worker.hours = 8;

  expect(worker.confirmChanges()).toBe(worker);
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);

  worker.revertChanges();
  expect(worker.hours).toBe(8);
});

test("confirmChanges applies the server values without tracking them", () => {
  const worker = new Worker();
  worker.name = "Ada";
  expect(worker.state).toBe(State.Added);

  worker.confirmChanges({ name: "Ada Lovelace", hours: 7, address: { city: "London" } });

  expect(worker.name).toBe("Ada Lovelace");
  expect(worker.hours).toBe(7);
  expect(worker.address.city).toBe("London");
  expect(worker.state).toBe(State.Unchanged);
  expect(worker.hasChanges).toBe(false);
});

test("changes lists the primitives and the changed nested models, and skips the ignored fields", () => {
  const worker = new Worker({ name: "Ada", hours: 2, hired: new Date(1000) });
  worker.hours = 3;
  worker.secret = "hidden";
  worker.address.city = "Paris";

  expect(worker.changes).toEqual({
    state: State.Modified,
    name: "Ada",
    hours: 3,
    hired: new Date(1000),
    payment: 30,
    address: { state: State.Added, city: "Paris", zip: "" },
  });
});

test("toJSON keeps the persisted getters and drops the ignored fields", () => {
  const worker = new Worker({ name: "Ada", hours: 2 });
  worker.secret = "hidden";

  expect(JSON.parse(JSON.stringify(worker))).toEqual({
    state: State.Modified,
    name: "Ada",
    hours: 2,
    hired: null,
    tags: [],
    payment: 20,
    address: { state: State.Detached, city: "", zip: "" },
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

  const address = new Address({ city: "Paris" });
  expect(isLike(address, address)).toBe(true);
  expect(isLike(address, new Address({ city: "Paris" }))).toBe(false);
});

test("a subclass tracks its own fields and the inherited ones", () => {
  class Manager extends Worker {
    @__track accessor reports = 0;
  }

  const manager = new Manager({ name: "Ada" });
  manager.reports = 3;
  expect(manager.state).toBe(State.Modified);
  expect(manager.changes).toMatchObject({ name: "Ada", reports: 3, payment: 0 });

  manager.revertChanges();
  expect(manager.reports).toBe(0);
  expect(manager.state).toBe(State.Unchanged);
});
