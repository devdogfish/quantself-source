import { z } from "zod";
import { habitLoader, HabitUnavailable } from "./habits-source";
export const documentPath = z
  .string()
  .regex(/^(SYSTEM\.md|playbook\.md|reviews\/\d{4}-\d{2}-\d{2}\.md)$/);
export const documentSchema = z.object({
  path: z.string(),
  text: z.string(),
  sha: z.string().nullable(),
  editUrl: z.string(),
  stale: z.boolean(),
  error: z.string().nullable(),
});
export function createHabitDocuments(
  load: (
    sha: string | null,
    path?: string,
    tree?: boolean,
  ) => Promise<{ sha: string; text: string } | null> = habitLoader,
  now = Date.now,
) {
  const cache = new Map<
    string,
    {
      at: number;
      text: string;
      sha: string | null;
      stale: boolean;
      error: string | null;
    }
  >();
  const pending = new Map<string, Promise<ReturnType<typeof state>>>();
  function state(key: string) {
    return (
      cache.get(key) ?? {
        at: 0,
        text: "",
        sha: null,
        stale: true,
        error: "Document unavailable.",
      }
    );
  }
  async function read(key: string, tree = false) {
    if (pending.has(key)) return pending.get(key)!;
    if (cache.has(key) && now() - state(key).at < 60_000) return state(key);
    const promise = (async () => {
      const old = state(key);
      try {
        const result = await load(old.sha, key, tree);
        const next = {
          at: now(),
          text: result?.text ?? old.text,
          sha: result?.sha ?? old.sha,
          stale: false,
          error: null,
        };
        if (cache.size >= 32 && !cache.has(key))
          cache.delete(cache.keys().next().value!);
        cache.set(key, next);
      } catch (e) {
        if (e instanceof HabitUnavailable && e.revoked) cache.clear();
        if (cache.size >= 32 && !cache.has(key))
          cache.delete(cache.keys().next().value!);
        cache.set(key, {
          ...(e instanceof HabitUnavailable && e.revoked ? state(key) : old),
          at: now(),
          stale: true,
          error: "Document refresh failed. Retry shortly.",
        });
      } finally {
        pending.delete(key);
      }
      return state(key);
    })();
    pending.set(key, promise);
    return promise;
  }
  return {
    invalidate(path: string) {
      cache.delete(path);
      cache.delete("reviews");
    },
    async document(path: string) {
      documentPath.parse(path);
      const value = await read(path);
      return {
        path,
        text: value.text,
        sha: value.sha,
        stale: value.stale,
        error: value.error,
        editUrl: `https://github.com/${process.env.QUANTSELF_HABITS_REPOSITORY}/edit/HEAD/${path}`,
      };
    },
    async hasReview(path: string) {
      documentPath.parse(path);
      const value = await read("reviews", true);
      if (value.stale || value.error) throw new Error("Review index unavailable.");
      const paths: string[] = value.text ? JSON.parse(value.text) : [];
      return paths.includes(path);
    },
    async reviews(offset = 0) {
      const value = await read("reviews", true);
      const paths: string[] = value.text ? JSON.parse(value.text) : [];
      return {
        paths: paths.slice(offset, offset + 20),
        next: offset + 20 < paths.length ? offset + 20 : null,
        stale: value.stale,
        error: value.error,
      };
    },
  };
}
export const habitDocuments = createHabitDocuments();
