/** A successful return is the prerequisite for a consistent backup, not just SIGTERM. */
export function createShutdown(options: {
  controller: AbortController;
  stopServer: () => Promise<unknown>;
  stopWorkers: Array<() => Promise<unknown> | void>;
  stopFreshness: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  timeoutMs?: number;
}) {
  let result: Promise<void> | undefined;
  return () => result ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          options.controller.abort();
          await Promise.all([
            options.stopServer(),
            ...options.stopWorkers.map(stop => stop()),
          ]);
          // Request/worker readers can enqueue cache work until they finish.
          await options.stopFreshness();
          await options.disconnect();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("API drain deadline exceeded")), options.timeoutMs ?? 13 * 60_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  })();
}
