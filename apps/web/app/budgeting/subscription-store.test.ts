import { expect, test } from "bun:test";
import { SubscriptionStore } from "./subscription-store";
import type { Subscription } from "@quantself/budgeting";
const item = (id: string): Subscription => ({ id, name: id, revision: 1, commandId: "initial", status: "active", stopsOn: null, terms: [], sourceKey: null, evidence: "", logoKey: null, websiteUrl: null, cancelUrl: null, estimated: false });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test("delayed saves preserve later intent and immediate undo/redo without collection refetches", async () => {
  const initial = item("one");
  const writes: { input: any; resolve: (row: Subscription) => void }[] = [];
  let reads = 0;
  const store = new SubscriptionStore({ read: async () => { reads++; return { today: "2026-11-08", items: [initial], paidKeys: [] }; }, write: (_id, input) => new Promise(resolve => writes.push({ input, resolve })) });
  await store.load();
  store.change({ ...initial, stopsOn: "2026-11-08" });
  store.undo(); expect(store.getSnapshot().items[0].stopsOn).toBeNull();
  store.redo(); expect(store.getSnapshot().items[0].stopsOn).toBe("2026-11-08");
  expect(writes).toHaveLength(1);
  writes[0].resolve({ ...initial, ...writes[0].input.changes, revision: 2 }); await flush();
  expect(store.getSnapshot().items[0].stopsOn).toBe("2026-11-08");
  expect(writes[1].input.revision).toBe(2);
  writes[1].resolve({ ...initial, ...writes[1].input.changes, revision: 3 }); await flush();
  writes[2].resolve({ ...initial, ...writes[2].input.changes, revision: 4 }); await flush();
  expect(store.getSnapshot().pending).toEqual([]); expect(reads).toBe(1);
});
test("uncertain delivery retries identical command; unrelated records can still save", async () => {
  const one = item("one"), two = item("two"); const sent: any[] = []; let fail = true;
  const store = new SubscriptionStore({ read: async () => ({ today: "2026-11-08", items: [one, two], paidKeys: [] }), write: async (id, input) => {
    sent.push({ id, input }); if (id === "one" && fail) throw Error("Network error"); return { ...item(id), ...input.changes, revision: 2 };
  } });
  await store.load(); store.change({ ...one, stopsOn: "2026-11-08" }); await flush();
  store.change({ ...two, stopsOn: "2026-11-09" }); await flush();
  expect(store.getSnapshot().retryable).toEqual(["one"]);
  expect(store.getSnapshot().pending).toEqual(["one"]);
  fail = false; store.retry(); await flush();
  expect(sent[0].input).toEqual(sent[2].input); expect(store.getSnapshot().pending).toEqual([]);
});
test("a rejected record rolls back narrowly without losing another edit", async () => {
  const one = item("one"), two = item("two");
  const store = new SubscriptionStore({ read: async () => ({ today: "2026-11-08", items: [one, two], paidKeys: [] }), write: async (id, input) => {
    if (id === "one") throw Object.assign(Error("Conflict"), { status: 409 }); return { ...two, ...input.changes, revision: 2 };
  } });
  await store.load(); store.change({ ...one, name: "changed" }); store.change({ ...two, name: "saved" }); await flush();
  expect(store.getSnapshot().items.map(row => row.name)).toEqual(["one", "saved"]);
  expect(store.getSnapshot().error).toContain("Conflict");
});

test("review, cancel and reactivate queue behind a held pause, and Undo preserves review", async () => {
  const initial = item("one");
  const writes: { input: Parameters<ConstructorParameters<typeof SubscriptionStore>[0]["write"]>[1]; resolve: (row: Subscription) => void }[] = [];
  const store = new SubscriptionStore({
    read: async () => ({ today: "2026-11-13", items: [initial], paidKeys: [] }),
    write: (_id, input) => new Promise(resolve => writes.push({ input, resolve })),
  });
  await store.load();
  const pause = store.patch("one", { status: "paused" })!;
  const review = store.patch("one", { lastReviewed: "2026-11-13" })!;
  const cancel = store.patch("one", { status: "cancelled" })!;
  const resume = store.patch("one", { status: "active" })!;
  expect(writes).toHaveLength(1);
  expect(store.getSnapshot().items[0]).toMatchObject({ status: "active", lastReviewed: "2026-11-13" });
  expect(store.undo(pause)).toBe(false);
  expect(store.undo(resume)).toBeTruthy();
  expect(store.getSnapshot().items[0].status).toBe("cancelled");
  expect(store.undo(cancel)).toBeTruthy();
  expect(store.getSnapshot().items[0]).toMatchObject({ status: "paused", lastReviewed: "2026-11-13" });
  expect(store.undo(review)).toBeTruthy();
  expect(store.getSnapshot().items[0].lastReviewed).toBeUndefined();
  store.redo();
  let persisted = initial;
  for (let index = 0; index < 8; index++) {
    const { input, resolve } = writes[index];
    expect(input.revision).toBe(persisted.revision);
    persisted = { ...persisted, ...input.changes, commandId: input.commandId, revision: persisted.revision + 1 };
    resolve(persisted);
    await flush();
    expect(store.getSnapshot().items[0]).toMatchObject({ status: "paused", lastReviewed: "2026-11-13" });
  }
  expect(store.getSnapshot().pending).toEqual([]);
});

test("conflict reloads its rule while an independent deferred save stays optimistic", async () => {
  const a = item("a"), b = item("b");
  let reads = 0;
  let resolve!: (item: Subscription) => void;
  const store = new SubscriptionStore({
    read: async () => ({ today: "2026-11-08", paidKeys: [], items: ++reads === 1 ? [a, b] : [{ ...a, status: "cancelled", revision: 2 }, b] }),
    write: async (id) => {
      if (id === a.id) throw Object.assign(Error("Changed elsewhere"), { status: 409 });
      return new Promise<Subscription>(finish => { resolve = finish; });
    },
  });
  await store.load();
  store.patch(a.id, { status: "paused" });
  store.patch(b.id, { status: "paused" });
  await flush();
  expect(reads).toBe(2);
  expect(store.getSnapshot().items).toMatchObject([{ id: a.id, status: "cancelled", revision: 2 }, { id: b.id, status: "paused" }]);
  expect(store.getSnapshot().pending).toEqual([b.id]);
  resolve({ ...b, status: "paused", revision: 2 });
  await flush();
  expect(store.getSnapshot().pending).toEqual([]);
});

test("redo only replays fields still matching the undone intent", async () => {
  const initial = { ...item("row"), lastReviewed: null };
  let server: Subscription = initial;
  let writes = 0;
  const store = new SubscriptionStore({
    read: async () => ({ today: "2026-11-08", paidKeys: [], items: [server] }),
    write: async (_id, input) => {
      writes++;
      server = { ...server, ...input.changes, revision: server.revision + 1 };
      return server;
    },
  });
  await store.load();
  const changed = store.patch(initial.id, { status: "paused", lastReviewed: "2026-11-08" });
  await flush();
  const redo = store.undo(changed);
  await flush();
  expect(redo).toBeTruthy();
  server = { ...server, status: "cancelled", revision: server.revision + 1 };
  await store.load();
  if (redo) store.redo(redo);
  await flush();
  expect(writes).toBe(3);
  expect(store.getSnapshot().items[0]).toMatchObject({ status: "cancelled", lastReviewed: "2026-11-08" });
});

test("a refreshed FX estimate is logically the same dated term", async () => {
  const term = { effectiveOn: "2026-11-08", startOn: "2026-11-08", frequency: "monthly" as const, interval: 1, amountCents: 100, currency: "USD" as const, cadAmountCents: 140 };
  const initial = { ...item("row"), terms: [term] };
  let writes = 0;
  const store = new SubscriptionStore({
    read: async () => ({ today: "2026-11-08", paidKeys: [], items: [initial] }),
    write: async () => { writes++; return initial; },
  });
  await store.load();
  expect(store.patch(initial.id, { terms: [{ ...term, cadAmountCents: 150 }] })).toBeUndefined();
  expect(writes).toBe(0);
});
