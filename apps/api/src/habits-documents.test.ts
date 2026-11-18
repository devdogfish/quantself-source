import { expect, test } from "bun:test";
import { createHabitDocuments } from "./habits-documents";
import { HabitUnavailable } from "./habits-source";
test("documents coalesce, cache briefly, paginate bulk review index, retain stale and clear revoked text", async () => {
  let clock = 0,
    calls = 0,
    mode = "good";
  const paths = Array.from(
    { length: 45 },
    (_, i) => `reviews/2026-01-${String(i + 1).padStart(2, "0")}.md`,
  );
  const docs = createHabitDocuments(
    async (_sha, path, _tree) => {
      calls++;
      await Promise.resolve();
      if (mode === "error") throw Error();
      if (mode === "revoked") throw new HabitUnavailable(true);
      return {
        sha: "a",
        text:
          path === "reviews"
            ? JSON.stringify(paths)
            : "# Safe\n<script>bad()</script>",
      };
    },
    () => clock,
  );
  let start = performance.now();
  await Promise.all([docs.document("SYSTEM.md"), docs.document("SYSTEM.md")]);
  console.info(
    `Documents cold ${calls} reads ${(performance.now() - start).toFixed(2)}ms (fixture transport)`,
  );
  expect(calls).toBe(1);
  start = performance.now();
  await docs.document("SYSTEM.md");
  console.info(
    `Documents warm 0 reads ${(performance.now() - start).toFixed(2)}ms`,
  );
  expect(calls).toBe(1);
  const first = await docs.reviews();
  const second = await docs.reviews(first.next!);
  const third = await docs.reviews(second.next!);
  expect([...first.paths, ...second.paths, ...third.paths]).toEqual(paths);
  expect(calls).toBe(2);
  expect(third.next).toBeNull();
  expect(await docs.hasReview(paths.at(-1)!)).toBe(true);
  expect(await docs.hasReview("reviews/2026-02-01.md")).toBe(false);
  expect(calls).toBe(2);
  clock += 60001;
  mode = "error";
  expect((await docs.document("SYSTEM.md")).stale).toBe(true);
  expect((await docs.document("SYSTEM.md")).text).toContain("Safe");
  await expect(docs.hasReview(paths[0]!)).rejects.toThrow("Review index unavailable.");
  clock += 60001;
  mode = "revoked";
  expect((await docs.document("SYSTEM.md")).text).toBe("");
  await expect(docs.document("../secrets")).rejects.toThrow();
});
