import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("weather hides stale coordinates and ignores late responses", async () => {
  const dom = new Window({ url: "http://localhost/todo" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests: { resolve(response: Response): void; signal: AbortSignal }[] = [];
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? dom : key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "fetch" ? (_url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ resolve, signal: init.signal as AbortSignal })) : (dom as any)[key] });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoLocationWeather } = await import("./todo-location-weather");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const response = (high: number) => Response.json({ current: { weather_code: 0 }, daily: { temperature_2m_max: [high], temperature_2m_min: [4] } });
  try {
    await act(async () => root.render(<TodoLocationWeather lat={48.858} lon={2.294} />));
    expect(requests).toHaveLength(1);
    await act(async () => root.render(<TodoLocationWeather lat={40.689} lon={-74.045} />));
    expect(requests[0]!.signal.aborted).toBe(true);
    await act(async () => requests[0]!.resolve(response(99)));
    expect(host.textContent).toBe("");
    await act(async () => requests[1]!.resolve(response(16)));
    expect(host.textContent).toBe("H:16° L:4°");
    expect(host.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain("Today's weather: Clear, high 16 degrees Celsius");
    await act(async () => root.render(<TodoLocationWeather lat={35.658} lon={139.745} />));
    expect(host.textContent).toBe("");
    await act(async () => requests[2]!.resolve(new Response(null, { status: 503 })));
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount()); host.remove(); await dom.happyDOM.cancelAsync();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
