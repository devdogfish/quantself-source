import { TodoReadError } from "./todos-github";
import { TodoWriteError } from "./todos-write";

const budgetMs = 20_000;
/** Retry once through the receipt-backed writer, using the exact same command.
 * Never bypass validation, authorization, conflicts or the writer's uncertainty receipts.
 * The budget limits starting more work; it does not cancel an in-flight write.
 */
export async function reconcilePhoneJarvisWrite<T extends { retryable: boolean }>(
  write: () => Promise<T>,
  now = Date.now,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  const started = now();
  let result: T;
  try {
    result = await write();
  } catch (error) {
    const unavailable = error instanceof TodoReadError && error.code === "TODO_UNAVAILABLE";
    const transient = unavailable || error instanceof TodoWriteError && error.status === 503 || error instanceof TypeError && /fetch|network|connection/i.test(error.message);
    const delay = unavailable ? Math.max(0, error.retryAfter * 1000) : 0;
    if (!transient || !Number.isFinite(delay) || now() - started + delay >= budgetMs) throw error;
    if (delay) await wait(delay);
    if (now() - started >= budgetMs) throw error;
    return write();
  }
  if (result.retryable && now() - started < budgetMs) {
    try { return await write(); }
    catch { return result; } // Retain the first per-field outcomes if reconciliation fails.
  }
  return result;
}
