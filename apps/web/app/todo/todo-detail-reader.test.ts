import { expect, test } from "bun:test";
import { readTodoDetail } from "./todo-detail-reader";

test("coalescing lasts only until settlement, separates revisions, and never retains denial", async () => {
  const original = globalThis.fetch;
  const pending: ((response: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => pending.push(resolve))) as unknown as typeof fetch;
  try {
    const first = readTodoDetail(9123, "r1"), shared = readTodoDetail(9123, "r1"), newer = readTodoDetail(9123, "r2");
    expect(first).toBe(shared); expect(pending).toHaveLength(2);
    pending[0](Response.json({ todo: { number: 9123, updatedAt: "r1" } })); await first;
    const fresh = readTodoDetail(9123, "r1"); expect(pending).toHaveLength(3);
    pending[1](Response.json({ todo: { number: 9123, updatedAt: "r2" } })); await newer;
    pending[2](Response.json({ message: "Denied" }, { status: 403 })); await expect(fresh).rejects.toMatchObject({ status: 403 });
    const retry = readTodoDetail(9123, "r1"); expect(pending).toHaveLength(4);
    pending[3](Response.json({ todo: { number: 9123, updatedAt: "r1" } })); await retry;
  } finally { globalThis.fetch = original; }
});
