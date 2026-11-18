import { createTaskDrain } from "./task-drain";
import { originalFiles } from "./original-files";
import { originalsEnabled } from "./original-storage";

export function startOriginalFilesWorker() {
  // Legacy installations make no WebDAV/ledger requests. Keep credentials until all
  // OpenCloud references and queued deletions are migrated back before disabling.
  if (!originalsEnabled()) return () => {};
  const drain = createTaskDrain();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => drain.run(async () => {
    try { await originalFiles.reconcile(); } catch { /* Durable queue retries next tick; no credentials in logs. */ }
    if (!stopped) { timer = setTimeout(tick, 60_000); timer.unref(); }
  });
  timer = setTimeout(tick, 5_000); timer.unref();
  return () => { stopped = true; clearTimeout(timer); return drain.stop(); };
}
