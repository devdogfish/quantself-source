export type RateLimit = { limit: number; windowMs: number };
export type RateLimiter = {
  /** Records a hit and returns 0 when allowed, otherwise the seconds until the next hit is allowed. */
  hit(key: string, now?: number): number;
};

/**
 * Fixed-memory sliding-window limiter for the single API process. Limits reset on
 * restart, which is acceptable for abuse damping; the per-email meeting cap is durable.
 */
export function createRateLimiter({ limit, windowMs }: RateLimit, maxKeys = 10_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter(at => at > now - windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      }
      recent.push(now);
      hits.delete(key);
      hits.set(key, recent);
      // Evict the least recently used key so a flood of distinct emails cannot grow memory.
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
      return 0;
    },
  };
}
