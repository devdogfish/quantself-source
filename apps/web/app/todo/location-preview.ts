import { searchLocations } from "./location-search";
import { cachedLocationPreview, rememberLocationPreview, type LocationPreview } from "./location-preview-cache";
export type { LocationPreview } from "./location-preview-cache";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Flight = { controller: AbortController; promise: Promise<LocationPreview | null>; subscribers: number };
const flights = new Map<string, Flight>();

function boundedSearch(key: string, controller: AbortController, fetcher: Fetcher) {
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => rejectRequest(controller.signal.reason);
  let rejectRequest!: (reason: unknown) => void;
  const request = new Promise<Awaited<ReturnType<typeof searchLocations>>>((resolve, reject) => {
    rejectRequest = reject;
    controller.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => controller.abort(new Error("Map preview lookup timed out. Try again.")), 8000);
    void searchLocations(key, controller.signal, fetcher).then(resolve, reject);
  });
  return request.finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  });
}

/** Resolves only the requested location; selected Photon suggestions need no second request. */
export async function resolveLocationPreview(location: string, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<LocationPreview | null> {
  signal.throwIfAborted();
  const key = location.trim();
  if (key.length < 3) return null;
  const cached = cachedLocationPreview(key);
  if (cached !== undefined) return cached;
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const pending: Flight = { controller, subscribers: 0, promise: Promise.resolve(null) };
    pending.promise = boundedSearch(key, controller, fetcher).then(suggestions => {
      controller.signal.throwIfAborted();
      const suggestion = suggestions.find(item => item.coordinates);
      const value = suggestion?.coordinates ? { lon: suggestion.coordinates[0], lat: suggestion.coordinates[1], label: suggestion.label, locality: suggestion.locality ?? "" } : null;
      rememberLocationPreview(key, value);
      return value;
    }).finally(() => { if (flights.get(key) === pending) flights.delete(key); });
    flights.set(key, pending);
    flight = pending;
  }
  const current = flight;
  current.subscribers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener("abort", abort);
      current.subscribers--;
      if (!current.subscribers && flights.get(key) === current) {
        flights.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const abort = () => { if (release()) reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    current.promise.then(value => { if (release()) resolve(value ? { ...value } : null); }, error => { if (release()) reject(error); });
    if (signal.aborted) abort();
  });
}
