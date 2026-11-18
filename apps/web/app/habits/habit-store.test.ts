import { expect, test } from "bun:test";
import { createHabitStore, type Occurrence } from "./habit-store";
const occurrence: Occurrence = {
  habitId: "stretch",
  date: "2026-11-04",
  definitionSha: "a",
  status: "open",
  note: "",
  revision: 0,
  missed: false,
};
test("later intent and Undo/Redo survive an older acknowledgement; dependent saves serialize", async () => {
  const requests: any[] = [];
  const resolvers: ((r: Occurrence) => void)[] = [];
  const store = createHabitStore((command) => {
    requests.push(command);
    return new Promise((resolve) => resolvers.push(resolve));
  });
  store.merge([occurrence]);
  store.edit(occurrence, { status: "done", note: "" });
  store.edit(occurrence, { status: "minimum", note: "" });
  expect(store.row(occurrence).status).toBe("minimum");
  expect(requests).toHaveLength(1);
  store.undo();
  expect(store.row(occurrence).status).toBe("done");
  store.redo();
  expect(store.row(occurrence).status).toBe("minimum");
  resolvers.shift()!({ ...occurrence, status: "done", revision: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.row(occurrence).status).toBe("minimum");
  expect(requests[1].revision).toBe(1);
  expect(requests[1].before.status).toBe("done");
});
test("uncertain delivery retains identical command for retry", async () => {
  const requests: any[] = [];
  const store = createHabitStore(async (command) => {
    requests.push(command);
    throw new Error("offline");
  });
  store.merge([occurrence]);
  store.edit(occurrence, { status: "done", note: "" });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.row(occurrence).status).toBe("done");
  store.retry();
  await Promise.resolve();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("rejection removes only dependent intent for that occurrence, preserving other edits", async () => {
  const { HabitSaveError } = await import("./habit-store");
  const rejectors = new Map<string, (reason: Error) => void>();
  const store = createHabitStore(
    (command) =>
      new Promise((_resolve, reject) => rejectors.set(command.habitId, reject)),
  );
  const second = { ...occurrence, habitId: "read" };
  store.merge([occurrence, second]);
  store.edit(occurrence, { status: "done", note: "" });
  store.edit(occurrence, { status: "minimum", note: "" });
  store.edit(second, { status: "done", note: "Unrelated" });
  rejectors.get("stretch")!(new HabitSaveError("Conflict", true));
  await Promise.resolve();
  await Promise.resolve();
  expect(store.row(occurrence).status).toBe("open");
  expect(store.row(second).status).toBe("done");
  expect(store.row(second).note).toBe("Unrelated");
  expect(store.canUndo()).toBe(true);
});

test("Undo never silently overwrites externally refreshed values", async () => {
  let requests = 0;
  const store = createHabitStore(async (command) => {
    requests++;
    return { ...occurrence, ...command.after, revision: 1 };
  });
  store.merge([occurrence]);
  store.edit(occurrence, { status: "done", note: "" });
  await Promise.resolve();
  await Promise.resolve();
  store.merge([{ ...occurrence, status: "minimum", revision: 2 }]);
  store.undo();
  expect(store.row(occurrence).status).toBe("minimum");
  expect(requests).toBe(1);
  expect(store.errors()[0]).toContain("changed outside");
});

test("editing a missed occurrence's note preserves its derived missed state while pending", () => {
  const store = createHabitStore(() => new Promise(() => {}));
  const past = { ...occurrence, date: "2000-01-01", missed: true };
  store.merge([past]);
  store.edit(past, { status: "open", note: "Correction" });
  expect(store.row(past).missed).toBe(true);
});
