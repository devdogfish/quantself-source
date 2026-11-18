/** Track complete jobs, including jobs that overlap between timer ticks. */
export function createTaskDrain() {
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  return {
    run<T>(work: () => Promise<T>): Promise<T | undefined> {
      if (stopped) return Promise.resolve(undefined);
      const task = Promise.resolve().then(work);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    async stop() {
      stopped = true;
      await Promise.allSettled([...pending]);
    },
  };
}
