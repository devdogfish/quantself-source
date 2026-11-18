/** Independent jobs own their locks; slow archive I/O must not hold the clock. */
export function phoneBackgroundTick(schedule: () => Promise<unknown>, archive: () => Promise<unknown>, report: (message: string) => void = console.error) {
  return () => Promise.all([
    schedule().catch(() => report("Phone Jarvis scheduling failed; retrying the delivery check")),
    archive().catch(() => report("Phone Jarvis archive reconciliation failed")),
  ]);
}
