/** Never delete category metadata before every reassignment is confirmed. */
export async function reassignBeforeDeleting<T>(tasks: T[], move: (task: T) => Promise<void>, remove: () => Promise<unknown>, isCurrent: () => boolean) {
  await Promise.all(tasks.map(move));
  if (isCurrent()) await remove();
}
