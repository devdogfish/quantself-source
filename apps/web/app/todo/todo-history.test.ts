import { expect, test } from "bun:test";
import { createTodoHistory, type HistoryCommand, type HistoryItem } from "./todo-history";
const saved = (outcomes: Record<string, "saved" | "conflict" | "uncertain"> = { title: "saved" }) => ({ commandId: "receipt", todo: null, outcomes, message: "Result", retryable: false });
const title = (before: string, after: string): HistoryCommand => ({ commandId: crypto.randomUUID(), title: { before, after } });
test("undo/redo invert saved edits; a new edit clears redo", async () => {
  const history = createTodoHistory();
  history.record(1, title("A", "B"), saved());
  let applied: HistoryCommand | undefined;
  const execute = async (item: HistoryItem) => { applied = item.execution; return saved(); };
  await history.replay("undo", execute);
  expect(applied?.title).toEqual({ before: "B", after: "A" });
  expect(history.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
  await history.replay("redo", execute);
  expect(applied?.title).toEqual({ before: "A", after: "B" });
  await history.replay("undo", execute);
  history.record(2, title("C", "D"), saved());
  expect(history.getSnapshot().canRedo).toBe(false);
});
test("field batches undo as one operation; completion and notes share chronological history", async () => {
  const history = createTodoHistory();
  for (const number of [1, 2]) history.record(number, { commandId: crypto.randomUUID(), fields: { Rank: { before: number, after: 3 - number } } }, saved({ Rank: "saved" }), undefined, "reorder");
  history.record(1, { commandId: crypto.randomUUID(), description: { before: "old", after: "new" }, closure: { before: { outcome: "open" }, after: { outcome: "completed" } } }, saved({ description: "saved", closure: "saved" }));
  const applied: HistoryCommand[] = [];
  await history.replay("undo", async item => { applied.push(item.execution!); return saved({ description: "saved", closure: "saved" }); });
  expect(applied[0].description).toEqual({ before: "new", after: "old" });
  expect(applied[0].closure?.after).toEqual({ outcome: "open" });
  await history.replay("undo", async item => { applied.push(item.execution!); return saved({ Rank: "saved" }); });
  expect(applied.slice(1).map(command => command.fields?.Rank)).toEqual([{ before: 1, after: 2 }, { before: 2, after: 1 }]);
  expect(history.getSnapshot().canUndo).toBe(false);
});
test("uncertain replay retries identical command and blocks concurrent edits", async () => {
  const history = createTodoHistory();
  history.record(1, title("A", "B"), saved());
  let first: HistoryCommand | undefined;
  await expect(history.replay("undo", async item => {
    first = item.execution;
    expect(() => history.beginWrite()).toThrow("Wait");
    throw Error("network");
  })).rejects.toThrow("network");
  expect(history.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, busy: false });
  await history.replay("undo", async item => { expect(item.execution).toEqual(first); return saved(); });
  expect(history.getSnapshot().canRedo).toBe(true);
});
test("partial saves and replay conflicts never undo unsaved fields or lose successful compensation", async () => {
  const history = createTodoHistory();
  const command: HistoryCommand = { commandId: crypto.randomUUID(), fields: { Category: { before: "Home", after: "Work" }, Client: { before: null, after: "Example" } } };
  history.record(1, command, saved({ Category: "saved", Client: "conflict" }));
  history.record(1, command, saved({ Category: "saved", Client: "saved" }));
  await expect(history.replay("undo", async item => saved(Object.fromEntries(Object.keys(item.command.fields ?? {}).map(key => [key, key === "Client" ? "saved" : "conflict"]))))).rejects.toThrow();
  expect(history.getSnapshot()).toMatchObject({ canUndo: true, canRedo: true });
  await history.replay("redo", async item => { expect(item.command.fields).toEqual({ Client: { before: null, after: "Example" } }); return saved({ Client: "saved" }); });
});

test("location undo and redo preserve null clearing independently of description", async () => {
  const history = createTodoHistory();
  history.record(1, { commandId: crypto.randomUUID(), fields: { Location: { before: "Office", after: null } }, description: { before: "A", after: "B" } }, saved({ Location: "saved", description: "conflict" }));
  await history.replay("undo", async item => {
    expect(item.execution?.fields?.Location).toEqual({ before: null, after: "Office" });
    expect(item.execution?.description).toBeUndefined();
    return saved({ Location: "saved" });
  });
  await history.replay("redo", async item => {
    expect(item.execution?.fields?.Location).toEqual({ before: "Office", after: null });
    return saved({ Location: "saved" });
  });
});
