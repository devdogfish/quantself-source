import { expect, test, mock } from "bun:test";
import { Window } from "happy-dom";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
mock.module("../habits/habits", () => ({
  Habits: ({ initialDate, stackId }: any) => (
    <div>
      Quick-log {stackId} {initialDate}
    </div>
  ),
}));
test("calendar fetches one range, shows loading, renders read-only blocks and opens stack quick-log", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Event",
    "Node",
    "MutationObserver",
    "CustomEvent",
    "getComputedStyle",
    "HTMLInputElement",
    "NodeFilter",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const previous = new Map(
    names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]),
  );
  for (const name of names.filter((n) => n !== "fetch"))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === "window"
          ? window
          : name === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : typeof (window as any)[name] === "function" && name.endsWith("AnimationFrame")
              ? (window as any)[name].bind(window)
              : (window as any)[name],
    });
  let calls = 0,
    resolve!: (response: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (request: Request) => {
      calls++;
      const url = new URL(request.url);
      expect(url.searchParams.get("from")).toBe("2026-11-01");
      expect(url.searchParams.get("to")).toBe("2026-11-07");
      return new Promise<Response>((r) => {
        resolve = r;
      });
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HabitCalendarLayer } = await import("./habit-calendar-layer");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dates = Array.from({ length: 7 }, (_, i) => `2026-11-0${i + 1}`);
  let occupied: string[] = [];
  const onDatesChange = (value: string[]) => {
    occupied = value;
  };
  try {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <HabitCalendarLayer
            dates={dates}
            minuteHeight={1}
            gutter={40}
            onDatesChange={onDatesChange}
          />
        </ChakraTestWrapper>,
      );
    });
    expect(host.textContent).toContain("Loading habit calendar");
    expect(calls).toBe(1);
    await act(async () =>
      resolve(
        Response.json({
          blocks: [
            {
              stackId: "routine",
              name: "Routine",
              date: "2026-11-04",
              anchor: "08:00",
              durationMinutes: 30,
              url: "/habits",
            },
          ],
          stale: false,
          error: null,
        }),
      ),
    );
    const block = host.querySelector("button")!;
    expect(block.getAttribute("draggable")).toBe("false");
    expect(block.style.top).toBe("480px");
    expect(occupied).toEqual(["2026-11-04"]);
    await act(async () => block.click());
    expect(document.body.textContent).toContain("Quick-log routine 2026-11-04");
    expect(calls).toBe(1);
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
