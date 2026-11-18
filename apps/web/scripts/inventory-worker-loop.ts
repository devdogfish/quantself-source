// The backup coordinator stops these workers before stopping their API.
export async function runInventoryWorkerLoop(
  runBatch: () => Promise<number>,
  options: { pollIntervalMs: number; runOnce: boolean },
) {
  const stop = new AbortController();
  let wake = () => {};
  const onSignal = () => {
    stop.abort();
    wake();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    while (!stop.signal.aborted) {
      const claimed = await runBatch();
      if (options.runOnce) break;
      if (claimed === 0 && !stop.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = () => {};
      }
    }
    if (stop.signal.aborted) console.info("Inventory worker drain complete");
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
