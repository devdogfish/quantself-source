export type LocationPreview = { lat: number; lon: number; label: string; locality: string };

const cache = new Map<string, { value: LocationPreview | null; expiresAt: number }>();
const ttl = 24 * 60 * 60 * 1000;
const limit = 100;

export function cachedLocationPreview(location: string): LocationPreview | null | undefined {
  const key = location.trim();
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key); cache.set(key, entry);
  return entry.value ? { ...entry.value } : null;
}

export function rememberLocationPreview(location: string, value: LocationPreview | null) {
  const key = location.trim();
  if (!key) return;
  cache.delete(key);
  cache.set(key, { value: value ? { ...value } : null, expiresAt: Date.now() + ttl });
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
