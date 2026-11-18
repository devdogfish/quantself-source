import { expect, test } from "bun:test";
import { reassignBeforeDeleting } from "./category-deletion";

test.each(["saved", "failed", "cancelled"])("category deletion waits for every task move: %s", async mode => {
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  let deleted = false;
  let current = true;
  const operation = reassignBeforeDeleting([1, 2], () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })), async () => { deleted = true; }, () => current);
  const outcome = operation.catch(() => "failed");
  expect(pending).toHaveLength(2);
  expect(deleted).toBe(false);
  pending[0].resolve();
  await Promise.resolve();
  expect(deleted).toBe(false);
  if (mode === "cancelled") current = false;
  if (mode === "failed") pending[1].reject(Error("Move rejected"));
  else pending[1].resolve();
  await outcome;
  expect(deleted).toBe(mode === "saved");
});
