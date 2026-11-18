import { rememberLocationPreview } from "./location-preview-cache";

export type LocationSuggestion = { id: string; label: string; coordinates?: [longitude: number, latitude: number]; locality?: string };

function featureCoordinates(feature: object): [number, number] | undefined {
  const geometry = (feature as { geometry?: { type?: unknown; coordinates?: unknown } }).geometry;
  if (!geometry || geometry.type !== "Point" || !Array.isArray(geometry.coordinates)) return;
  const [lon, lat] = geometry.coordinates;
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return;
  return [lon, lat];
}

/** Photon supports search-as-you-type. Public demo use is limited to reasonable traffic. */
export async function searchLocations(query: string, signal: AbortSignal, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<LocationSuggestion[]> {
  signal.throwIfAborted();
  const text = query.trim();
  if (text.length < 3) return [];
  const url = new URL(process.env.NEXT_PUBLIC_PHOTON_URL || "https://photon.komoot.io/api/");
  url.searchParams.set("q", text.slice(0, 200));
  url.searchParams.set("limit", "5");
  const response = await fetcher(url.toString(), { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("Location search unavailable. You can still enter a location.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { features?: unknown }).features)) throw new Error("Location search unavailable. You can still enter a location.");
  signal.throwIfAborted();
  const suggestions: LocationSuggestion[] = [];
  const seen = new Set<string>();
  for (const feature of (data as { features: unknown[] }).features) {
    if (!feature || typeof feature !== "object") continue;
    const properties = (feature as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object") continue;
    const p = properties as Record<string, unknown>;
    const str = (key: string) => typeof p[key] === "string" ? (p[key] as string).trim() : "";
    const street = [str("housenumber"), str("street")].filter(Boolean).join(" ");
    const label = [...new Set([str("name"), street, str("city") || str("town") || str("village") || str("county"), str("state"), str("postcode"), str("country")].filter(Boolean))].join(", ");
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const coordinates = featureCoordinates(feature);
    const locality = str("city") || str("town") || str("village") || str("county") || str("state") || str("country");
    const suggestion: LocationSuggestion = { id: `${String(p.osm_type ?? "place")}-${String(p.osm_id ?? suggestions.length)}`, label, ...(coordinates ? { coordinates, locality } : {}) };
    suggestions.push(suggestion);
    if (coordinates) rememberLocationPreview(label, { lon: coordinates[0], lat: coordinates[1], label, locality });
    if (suggestions.length === 5) break;
  }
  return suggestions;
}
