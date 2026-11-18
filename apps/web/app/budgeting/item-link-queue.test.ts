import { expect, test } from "bun:test";
import { ItemLinkQueue } from "./item-link-queue";
const item = { id: "item", title: "Camera" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("deferred saves preserve later unlink, Undo and Redo intent", async () => {
  const releases: (() => void)[] = [];
  const writes: boolean[] = [];
  const queue = new ItemLinkQueue([], async change => { writes.push(change.linked); await new Promise<void>(resolve => releases.push(resolve)); }, () => {});
  queue.change(item, true); expect(queue.items).toEqual([item]);
  queue.change(item, false); expect(queue.items).toEqual([]);
  queue.undo(); expect(queue.items).toEqual([item]);
  queue.redo(); expect(queue.items).toEqual([]);
  for (let i = 0; i < 4; i++) { releases[i](); await tick(); expect(queue.items).toEqual([]); }
  expect(writes).toEqual([true, false, true, false]);
  expect(queue.saving).toBe(false);
});
test("uncertain saves retain intent and retry identical desired state before later commands", async () => {
  const writes: boolean[] = [];
  let fail = true;
  const queue = new ItemLinkQueue([], async change => { writes.push(change.linked); if (fail) throw Error("Network error"); }, () => {});
  queue.change(item, true); await tick();
  queue.change(item, false); expect(queue.items).toEqual([]);
  expect(queue.error).toContain("not confirmed");
  fail = false; queue.retry(); await tick();
  expect(writes).toEqual([true, true, false]); expect(queue.error).toBe(""); expect(queue.items).toEqual([]);
});
test("a rejected item rolls back narrowly and unrelated queued links still save", async () => {
  let release!: () => void;
  const other = { id: "other", title: "Lens" };
  const queue = new ItemLinkQueue([], async change => {
    if (change.item.id === item.id) { await new Promise<void>(resolve => { release = resolve; }); throw Object.assign(Error("Item deleted"), { status: 404 }); }
  }, () => {});
  queue.change(item, true); queue.change(other, true);
  release(); await tick();
  expect(queue.items).toEqual([other]); expect(queue.saving).toBe(false); expect(queue.blocked).toBe(false);
});
