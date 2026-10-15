import { expect, test } from "bun:test";
import { EntitySet, Model, ModelChangeEvent, State, Validate, required } from "./model";

// Written the way the bundle rewrites a model class (see model.test.ts), and importing only the
// package entry, so a cycle between `model.ts` and `entity-set.ts` would break these tests.

class Task extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #title = ""; @Validate(required) get title(): string { return this.#title; } set title(v: string) { const p = this.#title; if (Model.same(p, v)) return; this.#title = v; this.$changed(0, p); }
static { Model.$define(this, ["title"]); } }

class Board extends Model { constructor(data?: object) { super(data); this.assign(data); }
  #name = ""; get name(): string { return this.#name; } set name(v: string) { const p = this.#name; if (Model.same(p, v)) return; this.#name = v; this.$changed(0, p); }
  #items = new EntitySet<Task>(); get items(): EntitySet<Task> { return this.#items; } set items(v: EntitySet<Task>) { const p = this.#items; if (Model.same(p, v)) return; this.#items = v; this.$changed(1, p); }
static { Model.$define(this, ["name", "items"]); } }

test("a tracked set holds the server items unchanged", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }]);

  expect(set.length).toBe(2);
  expect(set[0]).toBeInstanceOf(Task);
  expect(set[0]!.state).toBe(State.Unchanged);
  expect(set.hasChanges).toBe(false);
  expect(set.changes).toEqual([]);
});

test("delete removes Added items, marks the others Deleted and leaves Detached ones alone", () => {
  const set = EntitySet.track(Task, [{ title: "a" }]);
  const added = new Task();
  added.title = "new";
  const detached = new Task();
  set.push(added, detached);

  set.delete(added);
  expect(set.length).toBe(2);
  expect(set).not.toContain(added);

  set.delete(detached);
  expect(set.length).toBe(2);
  expect(detached.state).toBe(State.Detached);

  set.delete(set[0]!);
  expect(set.length).toBe(2);
  expect(set[0]!.state).toBe(State.Deleted);
});

test("view leaves out the deleted items", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }]);
  set.delete(set[1]!);

  expect(set.view.map((item) => item.title)).toEqual(["a"]);
  expect(set.view).not.toBeInstanceOf(EntitySet);
});

test("map and filter give plain arrays", () => {
  const set = EntitySet.track(Task, [{ title: "a" }]);

  expect(set.filter(() => true)).not.toBeInstanceOf(EntitySet);
  expect(Array.isArray(set.map((item) => item.title))).toBe(true);
  expect(set.slice()).not.toBeInstanceOf(EntitySet);
});

test("a mutated set has changes, and lists only the items that changed", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }]);
  expect(set.hasChanges).toBe(false);

  set[0]!.title = "A";
  expect(set.hasChanges).toBe(true);
  expect(set.changes).toEqual([{ state: State.Modified, title: "A" }]);

  const other = EntitySet.track(Task, [{ title: "a" }]);
  other.push(new Task({ title: "b" }));
  expect(other.hasChanges).toBe(true);
});

test("revertChanges puts the list and the items back", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }]);
  const added = new Task();
  added.title = "c";

  set.push(added);
  set[0]!.title = "A";
  set.splice(1, 1);
  expect(set.map((item) => item.title)).toEqual(["A", "c"]);

  set.revertChanges();
  expect(set.map((item) => item.title)).toEqual(["a", "b"]);
  expect(set[0]!.state).toBe(State.Unchanged);
  expect(set.hasChanges).toBe(false);
});

test("a set put back by hand before reading it has no changes", () => {
  const set = EntitySet.track(Task, [{ title: "a" }]);
  const extra = new Task({ title: "b" });

  set.push(extra);
  set.splice(set.indexOf(extra), 1);

  expect(set.hasChanges).toBe(false);
});

test("confirmChanges drops the deleted items and the ones the server sent as null", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }, { title: "c" }]);
  set[0]!.title = "A";
  set.delete(set[2]!);

  set.confirmChanges([{ title: "A!" }, null, { title: "c" }]);

  expect(set.map((item) => item.title)).toEqual(["A!"]);
  expect(set[0]!.state).toBe(State.Unchanged);
  expect(set.hasChanges).toBe(false);
});

test("confirmChanges without server items keeps the list and clears the changes", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }]);
  set.push(new Task({ title: "c" }));
  set[0]!.title = "A";

  set.confirmChanges();

  expect(set.map((item) => item.title)).toEqual(["A", "b", "c"]);
  expect(set.hasChanges).toBe(false);
});

test("a set on a model field reports its changes and its errors through the model", () => {
  const board = new Board({ name: "work" });
  board.items.push(new Task({ title: "a" }), new Task({ title: "b" }));
  board.items[1]!.title = "B";

  // A mutated set does not move the model's own state: the items track theirs.
  expect(board.hasChanges).toBe(true);
  expect(board.changes).toEqual({
    state: State.Unchanged,
    name: "work",
    items: [{ state: State.Modified, title: "B" }],
  });

  expect(board.hasErrors).toBe(false);
  board.items[0]!.title = "";
  expect(board.items.hasErrors).toBe(true);
  expect(board.hasErrors).toBe(true);
});

test("reverting the model reverts the sets it holds", () => {
  const board = new Board({ name: "work" });
  board.items.push(new Task({ title: "a" }));
  board.items[0]!.title = "A";

  board.revertChanges();

  expect(board.items.length).toBe(0);
  expect(board.hasChanges).toBe(false);
});

test("mutating a set tells the model that holds it", () => {
  const board = new Board();
  const seen: string[] = [];
  board.addEventListener("change", (event) => seen.push((event as ModelChangeEvent).property));

  board.items.push(new Task());
  board.items.pop();
  board.items.unshift(new Task({ title: "a" }));
  board.items.delete(board.items[0]!);
  board.items.reverse();

  expect(seen).toEqual(["items", "items", "items", "items", "items"]);
});

test("a set assigned to a model field reports to it too", () => {
  const board = new Board({ name: "work" });
  const seen: string[] = [];
  board.addEventListener("change", (event) => seen.push((event as ModelChangeEvent).property));

  board.items = EntitySet.track(Task, [{ title: "a" }]);
  board.items.push(new Task());

  expect(seen).toEqual(["items", "items"]);
});

test("an untouched set tells nothing", () => {
  const board = new Board();
  const seen: string[] = [];
  board.addEventListener("change", (event) => seen.push((event as ModelChangeEvent).property));

  board.items.push();
  board.items.pop();
  board.items.delete(new Task());
  board.items.revertChanges();
  board.items.confirmChanges();

  expect(seen).toEqual([]);
});

test("confirmChanges handles 10k items with 1k nulls", () => {
  const set = EntitySet.track(Task, Array.from({ length: 10000 }, (_, i) => ({ title: `t${i}` })));
  set[1]!.title = "x";
  const server = set.map((_, i) => (i % 10 === 0 ? null : { title: `s${i}` }));

  set.confirmChanges(server);

  expect(set.length).toBe(9000);
  expect(set[0]!.title).toBe("s1");
  expect(set[8999]!.title).toBe("s9999");
  expect(set.hasChanges).toBe(false);
});

test("confirmChanges leaves the items past a shorter server list as they are", () => {
  const set = EntitySet.track(Task, [{ title: "a" }, { title: "b" }, { title: "c" }]);
  set.delete(set[2]!);

  set.confirmChanges([{ title: "A" }]);

  expect(set.map((item) => item.title)).toEqual(["A", "b", "c"]);
  expect(set[2]!.state).toBe(State.Deleted);
});

test("push takes one item or many, and track builds the set without a snapshot", () => {
  const set = EntitySet.track(Task, [{ title: "a" }]);
  expect(set.push(new Task())).toBe(2);
  expect(set.push(new Task(), new Task())).toBe(4);
  set.revertChanges();
  expect(set.length).toBe(1);
});

test("splice that removes and inserts nothing tells nobody", () => {
  const board = new Board();
  board.items.push(new Task({ title: "a" }));
  const seen: string[] = [];
  board.addEventListener("change", (event) => seen.push((event as ModelChangeEvent).property));

  expect(board.items.splice(1)).toEqual([]);
  expect(board.items.splice(0, 0)).toEqual([]);
  expect(seen).toEqual([]);
  expect(board.items.splice(0, 1).length).toBe(1);
  expect(seen).toEqual(["items"]);
});
