import { expect, test } from "bun:test";
import { resolveLocationWeather, weatherCondition } from "./location-weather";

const payload = { current: { weather_code: 2 }, daily: { temperature_2m_max: [16.3], temperature_2m_min: [4.1] } };

test("weather coalesces concurrent requests, rounds coordinates, and caches warm reads", async () => {
  let count = 0; let url = ""; let respond!: (response: Response) => void;
  const fetcher = (input: string) => { count++; url = input; return new Promise<Response>(resolve => { respond = resolve; }); };
  const first = resolveLocationWeather(44.650123, -63.570123, new AbortController().signal, fetcher);
  const second = resolveLocationWeather(44.650124, -63.570124, new AbortController().signal, fetcher);
  await Promise.resolve();
  expect(count).toBe(1);
  expect(url).toContain("latitude=44.650&longitude=-63.570");
  expect(url).toContain("forecast_days=1");
  respond(Response.json(payload));
  expect(await first).toEqual({ code: 2, high: 16, low: 4 });
  expect(await second).toEqual(await first);
  await resolveLocationWeather(44.650123, -63.570123, new AbortController().signal, fetcher);
  expect(count).toBe(1);
});

test("last subscriber aborts the request; a late response cannot seed cache", async () => {
  let signal!: AbortSignal; let respond!: (response: Response) => void; let count = 0;
  const fetcher = (_url: string, init: RequestInit) => { count++; signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { respond = resolve; }); };
  const controller = new AbortController();
  const old = resolveLocationWeather(51.501, -0.142, controller.signal, fetcher).catch(() => null);
  await Promise.resolve(); controller.abort();
  expect(signal.aborted).toBe(true);
  respond(Response.json(payload)); await old; await new Promise(resolve => setTimeout(resolve, 0));
  const fresh = resolveLocationWeather(51.501, -0.142, new AbortController().signal, fetcher);
  await Promise.resolve(); expect(count).toBe(2);
  respond(Response.json(payload)); await fresh;
});

test("invalid coordinates and malformed or failed weather disappear", async () => {
  const signal = new AbortController().signal;
  expect(await resolveLocationWeather(NaN, 0, signal, () => { throw Error("unexpected"); })).toBeNull();
  expect(await resolveLocationWeather(0, 181, signal)).toBeNull();
  expect(await resolveLocationWeather(40, -70, signal, async () => Response.json({ ...payload, daily: { temperature_2m_max: [null], temperature_2m_min: [0] } }))).toBeNull();
  expect(await resolveLocationWeather(41, -70, signal, async () => { throw Error("offline"); })).toBeNull();
  expect(weatherCondition(999)).toBeNull();
  expect(weatherCondition(95)?.icon).toBe("storm");
});
