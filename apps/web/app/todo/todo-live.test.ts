import { expect, test } from "bun:test";
import {
  createTodoReadStore,
  TodoBrowserError,
  type LiveTodo,
} from "./todo-live";

test("old voice creation receipts cannot resurrect a task moved to trash", async () => {
  const store = createTodoReadStore(async () => ({ todos: [], readAt: "now" }));
  const commandId = crypto.randomUUID();
  const created = { commandId, create: { commandId, title: "Trashed task" }, number: 7, state: "saved" as const, outcomes: { issue: "saved" as const }, retryable: false };
  store.syncVoiceCreates([created]);
  expect(store.getSnapshot().todos).toHaveLength(1);
  store.syncVoiceCreates([created, { commandId: crypto.randomUUID(), number: 7, trash: true, state: "saved", outcomes: { trash: "saved" }, retryable: false }]);
  expect(store.getSnapshot().todos).toEqual([]);
  await store.refreshAfterWrite();
  store.syncVoiceCreates([created]);
  expect(store.getSnapshot().todos).toEqual([]);
});

test("a verified trash receipt removes visible tasks once and allows a subsequent external restoration", async () => {
  const task = { id: "I_trash", number: 7, title: "Recoverable task" } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [task], readAt: "now" }));
  await store.refresh();
  const receipt = { commandId: crypto.randomUUID(), number: 7, trash: true, state: "saved" as const, outcomes: { trash: "saved" as const }, retryable: false };
  store.syncVoiceCreates([receipt]);
  expect(store.getSnapshot().todos).toEqual([]);
  // A later authoritative read can reflect restoration from another Client.
  await store.refresh();
  store.syncVoiceCreates([receipt]);
  expect(store.getSnapshot().todos).toEqual([task]);
});

test("loaded records become stale on outage, recover, show empty and clear on denied access", async () => {
  const task = { id: "I_live", title: "Real task" } as LiveTodo;
  let result: { todos: LiveTodo[]; readAt: string } | Error = {
    todos: [task],
    readAt: "2026-10-26T12:00:00Z",
  };
  let calls = 0;
  const store = createTodoReadStore(async () => {
    calls++;
    if (result instanceof Error) throw result;
    return result;
  });
  await Promise.all([store.refresh(), store.refresh()]);
  expect(calls).toBe(1);
  expect(store.getSnapshot().status).toBe("ready");
  result = new TodoBrowserError("GitHub unavailable.", 503, 0);
  await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ status: "stale", todos: [task] });
  result = { todos: [task], readAt: "2026-10-26T12:01:00Z" };
  await store.refresh();
  expect(store.getSnapshot().status).toBe("ready");
  result = { todos: [], readAt: "2026-10-26T12:02:00Z" };
  await store.refresh();
  expect(store.getSnapshot().status).toBe("empty");
  result = new TodoBrowserError("Denied", 403, 0);
  await store.refresh();
  expect(store.getSnapshot()).toMatchObject({ status: "denied", todos: [] });
});

test("provider retry delay suppresses manual refreshes", async () => {
  let calls = 0;
  const store = createTodoReadStore(async () => {
    calls++;
    throw new TodoBrowserError("Rate limited", 503, 60);
  });
  await store.refresh();
  await store.refresh();
  expect(calls).toBe(1);
  expect(store.getSnapshot().status).toBe("unavailable");
});

test("tool refresh waits out an older in-flight read before fetching saved task state", async () => {
  let finish!: (value: { todos: LiveTodo[]; readAt: string }) => void;
  let calls = 0;
  const store = createTodoReadStore(async () => {
    if (++calls === 1)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {
      todos: [{ id: "I_live", title: "Voice edit" } as LiveTodo],
      readAt: "new",
    };
  });
  const earlier = store.refresh();
  const afterTool = store.refreshAfterWrite();
  finish({
    todos: [{ id: "I_live", title: "Old" } as LiveTodo],
    readAt: "old",
  });
  await Promise.all([earlier, afterTool]);
  expect(calls).toBe(2);
  expect(store.getSnapshot().todos[0].title).toBe("Voice edit");
});

test("shared optimistic creates survive stale refreshes, reconcile by command, and roll back failures independently", async () => {
  let todos: LiveTodo[] = [];
  const store = createTodoReadStore(async () => ({ todos, readAt: "now" }));
  await store.refresh();
  // Pending tasks sort by stable identity; keep this fixture deterministic.
  const first = { commandId: "00000000-0000-4000-8000-000000000001", title: "First pending task" };
  const second = {
    commandId: "00000000-0000-4000-8000-000000000002",
    title: "Second pending task",
  };
  store.creation.start(first);
  store.creation.start(second);
  expect(store.getSnapshot().message).toBe("Saving new tasks…");
  expect(store.getSnapshot().todos.map((t) => t.title)).toEqual([
    first.title,
    second.title,
  ]);
  await store.refresh();
  expect(store.getSnapshot().todos).toHaveLength(2);
  store.creation.fail(first.commandId, "GitHub rejected creation.");
  expect(store.getSnapshot().todos.map((t) => t.title)).toEqual([second.title]);
  expect(store.getSnapshot().writeError).toContain("GitHub rejected");
  const saved = {
    ...store.getSnapshot().todos[0],
    id: "I_saved",
    number: 12,
    optimistic: false,
  };
  store.creation.finish(second.commandId, {
    commandId: second.commandId,
    todo: saved,
    outcomes: { issue: "saved" },
    message: "Saved",
    retryable: false,
  });
  expect(store.getSnapshot().todos).toEqual([saved]);
  todos = [saved];
  await store.refresh();
  expect(store.getSnapshot().todos).toHaveLength(1);
});

test("a read started before a successful create cannot erase its confirmed task", async () => {
  let finish!: (value: { todos: LiveTodo[]; readAt: string }) => void;
  let calls = 0;
  const store = createTodoReadStore(async () => {
    if (++calls === 2)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return { todos: [], readAt: "old" };
  });
  await store.refresh();
  const old = store.refresh();
  const command = {
    commandId: crypto.randomUUID(),
    title: "Saved while reading",
  };
  store.creation.start(command);
  const saved = {
    ...store.getSnapshot().todos[0],
    id: "I_saved",
    number: 7,
    optimistic: false,
  };
  store.creation.finish(command.commandId, {
    commandId: command.commandId,
    todo: saved,
    outcomes: { issue: "saved" },
    message: "Saved",
    retryable: false,
  });
  finish({ todos: [], readAt: "old" });
  await old;
  expect(store.getSnapshot().todos).toEqual([saved]);
});

test("voice receipts project a pending create immediately and roll back a rejected write", async () => {
  const store = createTodoReadStore(async () => ({ todos: [], readAt: "now" }));
  await store.refresh();
  const create = {
    commandId: crypto.randomUUID(),
    title: "Voice optimistic task",
  };
  store.syncVoiceCreates([
    {
      commandId: create.commandId,
      create,
      state: "pending",
      number: null,
      outcomes: { delivery: "uncertain" },
      retryable: true,
    },
  ]);
  expect(store.getSnapshot().todos[0]).toMatchObject({
    title: create.title,
    optimistic: true,
  });
  store.syncVoiceCreates([
    {
      commandId: create.commandId,
      create,
      state: "failed",
      message: "Creation rejected",
      number: null,
      outcomes: { delivery: "failed" },
      retryable: true,
    },
  ]);
  expect(store.getSnapshot().todos).toEqual([]);
  await store.refresh();
  expect(store.getSnapshot().writeError).toBe("Creation rejected");
});

test("timing moves publish immediately, survive stale reads, and commit without a collection reload", async () => {
  const original = { id: "move", number: 7, start: "2026-10-26T12:00:00Z", end: "2026-10-26T13:00:00Z", allDay: false, fixed: false, updatedAt: "old" } as LiveTodo;
  let calls = 0;
  let release!: (value: { todos: LiveTodo[]; readAt: string }) => void;
  const store = createTodoReadStore(async () => {
    calls++;
    if (calls === 1) return { todos: [original], readAt: "now" };
    return new Promise(resolve => { release = resolve; });
  });
  await store.refresh();
  const oldRead = store.refresh();
  const after = { start: "2026-10-26T14:00:00Z", end: "2026-10-26T15:00:00Z", allDay: false, fixed: false };
  store.timing.start("command", 7, after);
  expect(store.getSnapshot().todos[0]).toMatchObject(after);
  release({ todos: [original], readAt: "stale" });
  await oldRead;
  expect(store.getSnapshot().todos[0]).toMatchObject(after);
  store.timing.finish("command", { todo: { ...original, ...after, updatedAt: "new" }, outcomes: { timing: "saved" }, retryable: false, message: "Saved" } as any);
  expect(store.getSnapshot().todos[0]).toMatchObject({ ...after, updatedAt: "new" });
  expect(calls).toBe(2); // No post-save full-list request.
});

test("timing failures roll back only confirmed rejection; failed refresh cannot commit a preview", async () => {
  const original = { id: "move", number: 7, start: "old", end: "old-end", allDay: false, fixed: false } as LiveTodo;
  let offline = false;
  const store = createTodoReadStore(async () => { if (offline) throw Error("Offline"); return { todos: [original], readAt: "now" }; });
  await store.refresh();
  const after = { start: "new", end: "new-end", allDay: false, fixed: false };
  store.timing.start("command", 7, after);
  store.timing.fail("command", "Delivery uncertain");
  expect(store.getSnapshot().todos[0]).toMatchObject(after);
  offline = true;
  await store.refresh();
  expect(store.getSnapshot().todos[0]).toMatchObject(after);
  store.timing.fail("command", "Conflict", true);
  expect(store.getSnapshot().todos[0]).toMatchObject(original);
});

test("trashed records stay out of the workspace after reads and write results; restoration stays visible", async () => {
  const task = { id: "I_hidden", number: 8, title: "Trashed task", trashed: true } as LiveTodo;
  let records = [task];
  const store = createTodoReadStore(async () => ({ todos: records, readAt: "now" }));
  await store.refresh();
  expect(store.getSnapshot().todos).toEqual([]);
  expect(store.getSnapshot().status).toBe("empty");
  store.creation.finish("receipt", { todo: task, outcomes: {} } as any);
  expect(store.getSnapshot().todos).toEqual([]);
  records = [{ ...task, trashed: false }];
  await store.refresh();
  expect(store.getSnapshot().todos).toEqual(records);
});

test("facts project across views, preserve newer intent on acknowledgement, and roll back only rejection", async () => {
  const todo = { id: "facts", number: 1, title: "Old", description: "Old notes", state: "open", closureReason: null, fields: { Rank: 2 }, start: null, end: null, fixed: false, allDay: false } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [todo], readAt: "now" }));
  await store.refresh();
  store.edits.start("a", 1, { commandId: "a", title: { before: "Old", after: "First" }, fields: { Rank: { before: 2, after: 1 } } });
  store.edits.start("b", 1, { commandId: "b", title: { before: "First", after: "Latest" }, description: { before: "Old notes", after: "New notes" }, closure: { before: { outcome: "open" }, after: { outcome: "completed" } } });
  expect(store.getSnapshot().todos[0]).toMatchObject({ title: "Latest", description: "New notes", state: "closed", closureReason: "completed", fields: { Rank: 1 } });
  store.edits.finish("a", { todo: { ...todo, title: "First", fields: { Rank: 1 } }, outcomes: { title: "saved", Rank: "saved" }, retryable: false } as any);
  expect(store.getSnapshot().todos[0].title).toBe("Latest");
  store.edits.fail("b", "uncertain");
  expect(store.getSnapshot().todos[0].title).toBe("Latest");
  store.edits.fail("b", "conflict", true);
  expect(store.getSnapshot().todos[0]).toMatchObject({ title: "First", state: "open", fields: { Rank: 1 } });
  store.edits.start("trash", 1, { commandId: "trash", trash: { before: false, after: true } });
  expect(store.getSnapshot().todos).toEqual([]);
  store.edits.start("restore", 1, { commandId: "restore", trash: { before: true, after: false } });
  expect(store.getSnapshot().todos[0].title).toBe("First");
});


test("prep edits and undo remain visible while older saves arrive", async () => {
  const { createTodoHistory } = await import("./todo-history");
  const { taskTiming } = await import("./todo-timing");
  const original = { id: "prep", number: 1, start: "2026-10-27T17:00:00Z", end: "2026-10-27T18:00:00Z", allDay: false, fixed: false, fields: {} } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [original], readAt: "now" }));
  await store.refresh();
  const history = createTodoHistory();
  const command = { commandId: "prep-edit", ...taskTiming(original), beforeMinutes: 10, afterMinutes: 5 };
  history.recordChanges([{ number: 1, command, expectedTiming: taskTiming(original) }]);
  store.edits.start(command.commandId, 1, command);
  expect(store.getSnapshot().todos[0]).toMatchObject({ beforeMinutes: 10, afterMinutes: 5, start: original.start, end: original.end });
  let undoId = "";
  history.replayTiming("undo", items => { for (const item of items) { undoId = item.command.commandId; store.edits.start(undoId, 1, item.command); } });
  expect(store.getSnapshot().todos[0].beforeMinutes ?? 0).toBe(0);
  store.edits.finish(command.commandId, { todo: { ...original, beforeMinutes: 10, afterMinutes: 5 }, outcomes: { timing: "saved" } } as any);
  expect(store.getSnapshot().todos[0].beforeMinutes ?? 0).toBe(0);
  history.replayTiming("redo", items => { for (const item of items) store.edits.start(item.command.commandId, 1, item.command); });
  store.edits.finish(undoId, { todo: { ...original, beforeMinutes: 0, afterMinutes: 0 }, outcomes: { timing: "saved" } } as any);
  expect(store.getSnapshot().todos[0]).toMatchObject({ beforeMinutes: 10, afterMinutes: 5, start: original.start, end: original.end });
});


test("Jarvis prep previews pending receipts, survives stale reads, rolls back conflicts and ignores historical saves", async () => {
  const task = { id: "voice-prep", number: 9, fields: {}, start: "2026-10-27T17:00:00Z", end: "2026-10-27T18:00:00Z", beforeMinutes: 0 } as LiveTodo;
  let data = task;
  const store = createTodoReadStore(async () => ({ todos: [data], readAt: "now" }));
  await store.refresh();
  const pending = { commandId: "voice-prep", number: 9, prep: { beforeMinutes: 10 }, state: "pending" as const, outcomes: { delivery: "uncertain" as const }, retryable: true };
  store.syncVoiceCreates([pending]);
  expect(store.getSnapshot().todos[0]).toMatchObject({ beforeMinutes: 10, start: task.start, end: task.end });
  await store.refresh();
  expect(store.getSnapshot().todos[0].beforeMinutes).toBe(10);
  store.edits.start("later-manual", 9, { commandId: "later-manual", beforeMinutes: 20 });
  store.syncVoiceCreates([{ ...pending, state: "saved", outcomes: { timing: "saved" }, retryable: false }]);
  data = { ...task, beforeMinutes: 10 };
  await store.refreshAfterWrite();
  expect(store.getSnapshot().todos[0].beforeMinutes).toBe(20);
  store.edits.finish("later-manual", { todo: { ...task, beforeMinutes: 20 }, outcomes: { timing: "saved" }, retryable: false } as any);
  store.syncVoiceCreates([{ ...pending, commandId: "old-receipt", state: "saved", outcomes: { timing: "saved" }, retryable: false }]);
  expect(store.getSnapshot().todos[0].beforeMinutes).toBe(20);
  store.syncVoiceCreates([{ ...pending, commandId: "rejected", prep: { afterMinutes: 5 } }]);
  store.syncVoiceCreates([{ ...pending, commandId: "rejected", prep: { afterMinutes: 5 }, state: "saved", outcomes: { timing: "conflict" }, retryable: false }]);
  expect(store.getSnapshot().todos[0].afterMinutes ?? 0).toBe(0);
  expect(store.getSnapshot().writeError).toContain("rejected");
});

test("SSE deltas preserve pending intent and cannot regress acknowledged writes at the same timestamp", async () => {
  const task = { id: "I_push", number: 91, title: "Before", fields: {}, updatedAt: "2026-10-28T01:00:00Z" } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [task], readAt: "now" }));
  await store.refresh();
  store.edits.start("edit", 91, { commandId: "edit", title: { before: "Before", after: "Owner edit" } });
  store.applyRemote({ generation: 1, upserts: [{ ...task, title: "External old" }], readAt: "now" });
  expect(store.getSnapshot().todos[0].title).toBe("Owner edit");
  store.edits.finish("edit", { commandId: "edit", todo: { ...task, title: "Owner edit" }, outcomes: { title: "saved" }, retryable: false, message: "Saved", cacheGeneration: 4 });
  store.applyRemote({ generation: 2, upserts: [{ ...task, title: "Delayed old" }], readAt: "now" });
  expect(store.getSnapshot().todos[0].title).toBe("Owner edit");
  store.applyRemote({ generation: 4, upserts: [{ ...task, title: "Owner edit" }], readAt: "now" });
  store.applyRemote({ generation: 5, upserts: [{ ...task, title: "Later external" }], readAt: "now" });
  expect(store.getSnapshot().todos[0].title).toBe("Later external");
  store.applyRemote({ generation: 3, upserts: [task], readAt: "now" });
  expect(store.getSnapshot().todos[0].title).toBe("Later external");
});

test("live snapshots retain Trash for browsing and revoked streams clear both projections", async () => {
  const task = { id: "I_trash_live", number: 92, title: "Trash", trashed: true, fields: {} } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [], readAt: "now" }));
  store.applyRemote({ generation: 1, todos: [task], readAt: "now" });
  expect(store.getSnapshot().todos).toEqual([]);
  expect(store.getSnapshot().trashTodos).toEqual([task]);
  store.applyRemote({ generation: 2, revoked: true, readAt: null });
  expect(store.getSnapshot()).toMatchObject({ status: "denied", todos: [], trashTodos: [] });
});

test("a stale SSE snapshot cannot remove a newly acknowledged create", () => {
  const task = { id: "I_created_push", number: 93, title: "Created", fields: {} } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [], readAt: "now" }));
  store.creation.start({ commandId: "create", title: "Created" });
  store.creation.finish("create", { commandId: "create", todo: task, outcomes: { issue: "saved" }, message: "Saved", retryable: false, cacheGeneration: 2 });
  store.applyRemote({ generation: 1, todos: [], readAt: "now" });
  expect(store.getSnapshot().todos).toEqual([task]);
  store.applyRemote({ generation: 2, upserts: [task], readAt: "now" });
  expect(store.getSnapshot().todos).toEqual([task]);
});

test("partial timing previews preserve the opposite bound or seed an unscheduled task", async () => {
  const { previewTodoEdit } = await import("./todo-live");
  const task = { id: "I_seed", number: 94, title: "Timing", fields: {}, start: null, end: null } as LiveTodo;
  const seeded = previewTodoEdit(task, { commandId: "seed", end: "2026-10-28T15:00:00Z" });
  expect(seeded.start).toBe("2026-10-28T14:30:00.000Z");
  expect(seeded.end).toBe("2026-10-28T15:00:00Z");
  const adjusted = previewTodoEdit(seeded, { commandId: "adjust", start: "2026-10-28T14:45:00Z" });
  expect(adjusted.end).toBe(seeded.end);
  const cleared = previewTodoEdit(adjusted, { commandId: "clear", start: null, end: null });
  expect(cleared).toMatchObject({ start: null, end: null });
});

test("SSE denial fences pending reads, writes and queued events until a fresh authorized read", async () => {
  const task = { id: "I_denied", number: 8, title: "Protected", fields: {} } as LiveTodo;
  let resolve!: (value: { todos: LiveTodo[]; readAt: string }) => void;
  const store = createTodoReadStore(() => new Promise(r => { resolve = r; }));
  const pending = store.refresh(); store.denyAccess(); resolve({ todos: [task], readAt: "old" }); await pending;
  store.creation.finish("old-write", { commandId: "old-write", todo: task, outcomes: { issue: "saved" }, retryable: false, message: "Saved" });
  store.edits.finish("old-edit", { commandId: "old-edit", todo: task, outcomes: { title: "saved" }, retryable: false, message: "Saved" });
  store.applyRemote({ generation: 12, todos: [task], readAt: "old" });
  expect(store.getSnapshot()).toMatchObject({ status: "denied", todos: [], trashTodos: [] });
  const reauthorized = store.refresh(); resolve({ todos: [task], readAt: "new" }); await reauthorized;
  expect(store.getSnapshot()).toMatchObject({ status: "ready", todos: [task] });
});

test("late HTTP writes and older HTTP snapshots cannot replace a newer SSE generation", async () => {
  const task = { id: "I_order", number: 9, title: "Newer", fields: {} } as LiveTodo;
  const store = createTodoReadStore(async () => ({ todos: [{ ...task, title: "Old HTTP snapshot" }], readAt: "old", generation: 3 }));
  store.applyRemote({ generation: 5, todos: [task], readAt: "new" });
  store.edits.start("older-write", 9, { commandId: "older-write", title: { before: "Before", after: "Older" } });
  store.edits.finish("older-write", { commandId: "older-write", todo: { ...task, title: "Older" }, outcomes: { title: "saved" }, retryable: false, message: "Saved", cacheGeneration: 4 });
  expect(store.getSnapshot().todos[0].title).toBe("Newer");
  await store.refresh(); expect(store.getSnapshot().todos[0].title).toBe("Newer");
});
