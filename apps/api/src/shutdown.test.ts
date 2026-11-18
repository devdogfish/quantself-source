import { expect, test } from "bun:test";
import { createShutdown } from "./shutdown";
import { createTaskDrain } from "./task-drain";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve };
}

test("shutdown waits for an HTTP write and worker before cache drain and disconnect", async () => {
  const controller = new AbortController();
  const request = deferred(), entered = deferred(), worker = deferred();
  const jobs = createTaskDrain(), requests = createTaskDrain();
  const events: string[] = [];
  void jobs.run(async () => { await worker.promise; events.push("worker saved"); });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    return (await requests.run(async () => {
      entered.resolve(); await request.promise; events.push("request saved");
      return new Response("saved");
    })) ?? new Response("stopping", { status: 503 });
  } });
  const response = fetch(server.url).then(r => r.text());
  await entered.promise;
  const stop = createShutdown({ controller, stopServer: () => server.stop(),
    stopWorkers: [() => jobs.stop(), () => requests.stop()],
    stopFreshness: async () => { events.push("cache drained"); },
    disconnect: async () => { events.push("disconnected"); }, timeoutMs: 1000,
  });
  try {
    const completion = stop();
    expect(stop()).toBe(completion);
    expect(controller.signal.aborted).toBe(true);
    await jobs.run(async () => { events.push("unexpected job"); });
    request.resolve();
    expect(await response).toBe("saved");
    expect(events).toEqual(["request saved"]);
    worker.resolve(); await completion;
    expect(events).toEqual(["request saved", "worker saved", "cache drained", "disconnected"]);
  } finally { request.resolve(); worker.resolve(); await server.stop(true); }
});

test("a disconnected client cannot hide its unfinished write from the drain", async () => {
  const requests = createTaskDrain(), entered = deferred(), write = deferred();
  let saved = false, disconnected = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    return (await requests.run(async () => {
      entered.resolve(); await write.promise; saved = true; return new Response("saved");
    })) ?? new Response("stopping");
  } });
  const client = new AbortController();
  const response = fetch(server.url, { signal: client.signal }).catch(() => {});
  await entered.promise; client.abort(); await response;
  const stop = createShutdown({ controller: new AbortController(), stopServer: () => server.stop(),
    stopWorkers: [() => requests.stop()], stopFreshness: async () => {},
    disconnect: async () => { disconnected = true; }, timeoutMs: 1000 });
  const completion = stop();
  expect(saved).toBe(false); expect(disconnected).toBe(false);
  write.resolve(); await completion;
  expect(saved).toBe(true); expect(disconnected).toBe(true);
});

test("a stalled drain fails instead of claiming a valid backup boundary", async () => {
  const pending = deferred();
  let disconnected = false;
  const stop = createShutdown({ controller: new AbortController(), stopServer: () => pending.promise,
    stopWorkers: [], stopFreshness: async () => {},
    disconnect: async () => { disconnected = true; }, timeoutMs: 10 });
  await expect(stop()).rejects.toThrow("drain deadline exceeded");
  expect(disconnected).toBe(false);
  pending.resolve();
});

test("drain tracks all overlapping jobs and rejects new work after stop", async () => {
  const first = deferred(), second = deferred(), jobs = createTaskDrain();
  let stopped = false, ran = false;
  void jobs.run(() => first.promise); void jobs.run(() => second.promise);
  const stop = jobs.stop().then(() => { stopped = true; });
  first.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(stopped).toBe(false);
  await jobs.run(async () => { ran = true; }); expect(ran).toBe(false);
  second.resolve(); await stop; expect(stopped).toBe(true);
});
