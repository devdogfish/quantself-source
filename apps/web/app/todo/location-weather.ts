export type LocationWeather = { code: number; high: number; low: number };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Flight = { controller: AbortController; promise: Promise<LocationWeather | null>; users: number };
const cache = new Map<string, { value: LocationWeather | null; until: number }>();
const flights = new Map<string, Flight>();
const TTL = 15 * 60 * 1000;

export function weatherCondition(code: number): { icon: "sun" | "cloud" | "rain" | "snow" | "storm"; label: string } | null {
  if (code === 0) return { icon: "sun", label: "Clear" };
  if ([1, 2, 3, 45, 48].includes(code)) return { icon: "cloud", label: code >= 45 ? "Fog" : "Cloudy" };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { icon: "rain", label: "Rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: "snow", label: "Snow" };
  if ([95, 96, 99].includes(code)) return { icon: "storm", label: "Thunderstorms" };
  return null;
}

/** Today's local weather only. Rounded coordinates avoid transmitting unnecessary precision. */
export async function resolveLocationWeather(lat: number, lon: number, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<LocationWeather | null> {
  signal.throwIfAborted();
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const pending: Flight = { controller, users: 0, promise: Promise.resolve(null) };
    const timer = setTimeout(() => controller.abort(), 8000);
    const [latitude, longitude] = key.split(",");
    const params = new URLSearchParams({ latitude: latitude!, longitude: longitude!, current: "weather_code", daily: "temperature_2m_max,temperature_2m_min", forecast_days: "1", timezone: "auto" });
    pending.promise = Promise.resolve().then(() => fetcher(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" })).then(async response => {
      if (!response.ok) return null;
      const data = await response.json();
      const code = data?.current?.weather_code;
      const high = data?.daily?.temperature_2m_max?.[0];
      const low = data?.daily?.temperature_2m_min?.[0];
      return typeof code === "number" && weatherCondition(code) && typeof high === "number" && Number.isFinite(high) && typeof low === "number" && Number.isFinite(low) && high >= low ? { code, high: Math.round(high), low: Math.round(low) } : null;
    }).catch(() => null).then(value => {
      if (!controller.signal.aborted) {
        cache.delete(key);
        cache.set(key, { value, until: Date.now() + TTL });
        if (cache.size > 100) cache.delete(cache.keys().next().value!);
      }
      return controller.signal.aborted ? null : value;
    }).finally(() => { clearTimeout(timer); if (flights.get(key) === pending) flights.delete(key); });
    flights.set(key, pending);
    flight = pending;
  }
  const current = flight;
  current.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true; signal.removeEventListener("abort", abort); current.users--;
      if (!current.users && flights.get(key) === current) { flights.delete(key); current.controller.abort(); }
      return true;
    };
    const abort = () => { if (release()) reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    current.promise.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
    if (signal.aborted) abort();
  });
}
