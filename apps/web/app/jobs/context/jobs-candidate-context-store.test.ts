import { expect, test } from "bun:test";
import { CandidateContextRequestError, type CandidateContext, type CandidateContextPatch } from "./jobs-candidate-context-api";
import { createCandidateContextStore } from "./jobs-candidate-context-store";

function fixture() {
  let current = { markdown: "Initial", version: 1 };
  let reads = 0;
  const commands: CandidateContextPatch[] = [];
  const saves: ReturnType<typeof Promise.withResolvers<CandidateContext>>[] = [];
  const store = createCandidateContextStore({
    get: async () => { reads++; return current; },
    patch: (command) => {
      commands.push(command);
      const deferred = Promise.withResolvers<CandidateContext>();
      saves.push(deferred);
      return deferred.promise;
    },
  });
  return { store, commands, saves, setCurrent: (value: CandidateContext) => { current = value; }, get reads() { return reads; } };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const conflict = () => new CandidateContextRequestError(409, "Version conflict");

test("pending saves never block edits, Undo or Redo; older acknowledgements preserve the latest text", async () => {
  const { store, commands, saves } = fixture();
  await store.load();
  store.edit("First");
  store.edit("Second");
  expect(store.getSnapshot()).toMatchObject({ markdown: "Second", saving: true });
  store.undo();
  expect(store.getSnapshot()).toMatchObject({ markdown: "First", canRedo: true });
  store.undo();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Initial", canRedo: true });
  store.redo();
  store.redo();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Second", canRedo: false });
  expect(commands).toEqual([{ markdown: "First", expectedVersion: 1 }]);

  saves[0].resolve({ markdown: "First", version: 2 });
  await tick();
  expect(store.getSnapshot().markdown).toBe("Second");
  expect(commands[1]).toEqual({ markdown: "Second", expectedVersion: 2 });
  saves[1].resolve({ markdown: "Second", version: 3 });
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Second", saving: false, canUndo: true });
  expect(commands).toHaveLength(2);
});

test("an uncertain write retries the same version and text, then drains the newer draft", async () => {
  const f = fixture();
  const { store, commands, saves, setCurrent } = f;
  await store.load();
  store.edit("First");
  store.edit("Later");
  saves[0].reject(new Error("Connection dropped"));
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Later", saving: false, error: expect.any(String) });
  const retry = store.retry();
  expect(commands[1]).toBe(commands[0]);
  setCurrent({ markdown: "First", version: 2 });
  saves[1].reject(conflict());
  await retry;
  expect(f.reads).toBe(2);
  expect(commands[2]).toEqual({ markdown: "Later", expectedVersion: 2 });
  saves[2].resolve({ markdown: "Later", version: 3 });
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Later", saving: false });
  expect(store.getSnapshot().conflict).toBeUndefined();
});

test("an external edit pauses saves and preserves later edits until the Owner resolves the conflict", async () => {
  const { store, commands, saves, setCurrent } = fixture();
  await store.load();
  store.edit("First");
  store.edit("Later");
  setCurrent({ markdown: "External edit", version: 3 });
  saves[0].reject(conflict());
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Later", conflict: { markdown: "External edit", version: 3 } });
  store.edit("Merged");
  expect(commands).toHaveLength(1);
  store.resolve("draft");
  expect(commands[1]).toEqual({ markdown: "Merged", expectedVersion: 3 });
  saves[1].resolve({ markdown: "Merged", version: 4 });
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Merged", conflict: undefined, saving: false });
});

test("a rejected save leaves a correctable draft and lets the next edit save against the original version", async () => {
  const { store, commands, saves } = fixture();
  await store.load();
  store.edit("Rejected");
  saves[0].reject(new CandidateContextRequestError(400, "Use masked references."));
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Rejected", error: "Use masked references." });
  store.edit("Corrected");
  expect(commands[1]).toEqual({ markdown: "Corrected", expectedVersion: 1 });
  saves[1].resolve({ markdown: "Corrected", version: 2 });
  await tick();
  expect(store.getSnapshot()).toMatchObject({ markdown: "Corrected", saving: false, error: undefined });
});
