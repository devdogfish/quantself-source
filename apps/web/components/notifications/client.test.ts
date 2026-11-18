import { test, expect } from "bun:test";
import { optimisticSetting } from "./client";
test("notification intent, Undo and Redo remain available under deferred saves and older responses", async () => {
  const original = globalThis.fetch;
  const replies: (() => void)[] = [];
  const writes: unknown[] = [];
  globalThis.fetch = (async (_url, options) => {
    if (!options?.method) return Response.json({ minutes: 10 });
    writes.push(JSON.parse(String(options.body)));
    await new Promise<void>(resolve => replies.push(resolve));
    return Response.json({});
  }) as typeof fetch;
  try {
    const setting = optimisticSetting<{ minutes: number }>("tasks/1");
    await setting.load();
    setting.set({ minutes: 20 });
    setting.set({ minutes: 30 });
    setting.undo();
    expect(setting.snapshot().value).toEqual({ minutes: 20 });
    setting.redo();
    expect(setting.snapshot().value).toEqual({ minutes: 30 });
    for (let i=0; i<4; i++) { replies[i]!(); await new Promise(resolve => setTimeout(resolve, 0)); expect(setting.snapshot().value).toEqual({ minutes: 30 }); }
    expect(writes).toEqual([{ minutes: 20 }, { minutes: 30 }, { minutes: 20 }, { minutes: 30 }]);
    expect(setting.snapshot().pending).toBe(false);
  } finally { globalThis.fetch = original; }
});
test("rejected save keeps later intent and retries in order", async () => {
  const original = globalThis.fetch;
  let reject = true;
  const writes: unknown[] = [];
  globalThis.fetch = (async (_url, options) => {
    if (!options?.method) return Response.json({ minutes: 10 });
    writes.push(JSON.parse(String(options.body)));
    return reject ? Response.json({ message: "Offline" }, { status: 503 }) : Response.json({});
  }) as typeof fetch;
  try {
    const setting = optimisticSetting<{ minutes: number }>("tasks/1");
    await setting.load(); setting.set({ minutes: 25 });
    await new Promise(resolve => setTimeout(resolve,0));
    expect(setting.snapshot().error).toContain("kept");
    expect(setting.snapshot().value).toEqual({ minutes: 25 });
    reject = false; setting.retry();
    await new Promise(resolve => setTimeout(resolve,0));
    expect(writes).toEqual([{ minutes: 25 }, { minutes: 25 }]);
    expect(setting.snapshot().error).toBe("");
  } finally { globalThis.fetch = original; }
});
