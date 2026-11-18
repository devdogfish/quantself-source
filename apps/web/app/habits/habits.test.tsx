import { expect, test } from "bun:test";
import { Window } from "happy-dom";
test("calendar stack quick-log shares optimistic occurrence state and keeps Undo/Redo usable with deferred saves", async () => {
  const window = new Window({ url: "http://localhost/calendar" });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Event",
    "Node",
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
            : (window as any)[name],
    });
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Halifax",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const occurrence = {
    habitId: "stretch",
    date,
    definitionSha: "a",
    status: "open",
    note: "",
    revision: 0,
    missed: false,
  };
  let reads = 0;
  let synthesized = false;
  const requests: any[] = [];
  const resolves: ((response: Response) => void)[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (request: Request) => {
      if (request.method === "GET") {
        reads++;
        return Promise.resolve(
          Response.json({
            date,
            today: date,
            sha: "a",
            stale: false,
            error: null,
            projection: {
              stacks: [
                {
                  id: "morning",
                  name: "Morning",
                  days: "daily",
                  cue: "After waking",
                },
              ],
              habits: [
                {
                  id: synthesized ? "walk" : "stretch",
                  name: synthesized ? "Walk" : "Stretch",
                  stack: "morning",
                  order: 1,
                  kind: "build",
                  tracked: true,
                  status: "building",
                  minimum: "One stretch",
                  full: "Five stretches",
                },
              ],
              gate: { window: 14, required: 10 },
              diagnostics: [],
            },
            occurrences: synthesized ? [] : [occurrence],
          }),
        );
      }
      return request.json().then((body) => {
        requests.push(body);
        return new Promise<Response>((resolve) => resolves.push(resolve));
      });
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HabitTestProvider } = await import("@/app/habits/test-provider");
  const { Habits } = await import("./habits");
  const { habitStore } = await import("./habits-api");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let rootUnmounted = false;
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === name,
    )! as HTMLButtonElement;
  try {
    await act(async () => {
      root.render(<HabitTestProvider><Habits initialDate={date} stackId="morning" /></HabitTestProvider>);
    });
    expect(reads).toBe(1);
    expect(host.textContent).toContain("One stretch");
    expect(host.textContent).toContain("Five stretches");
    expect(host.textContent).toContain("0 of 1 logged");
    expect(host.textContent).toContain("Minimum: One stretch");
    expect(host.querySelector("details")?.textContent).toContain("Five stretches");
    expect(host.textContent).not.toContain("Weekly review");
    expect(host.textContent).not.toContain("Playbook & system");
    const started = performance.now();
    await act(async () => button("Done").click());
    expect(button("Done").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("1 of 1 logged");
    console.info(
      `Habit deferred interaction-to-render ${(performance.now() - started).toFixed(2)}ms; first save still pending.`,
    );
    await act(async () => button("Minimum").click());
    expect(button("Minimum").getAttribute("aria-pressed")).toBe("true");
    expect(habitStore.row(occurrence as any).status).toBe("minimum");
    expect(host.textContent).not.toContain("Start review");
    expect(requests).toHaveLength(1);
    await act(async () => button("Undo").click());
    expect(button("Done").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Redo").click());
    expect(button("Minimum").getAttribute("aria-pressed")).toBe("true");
    button("Minimum").focus();
    await act(async () =>
      resolves.shift()!(
        Response.json({ ...occurrence, status: "done", revision: 1 }),
      ),
    );
    expect(button("Minimum").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(button("Minimum"));
    expect(requests).toHaveLength(2);
    expect(requests[1].revision).toBe(1);
    await act(async () =>
      resolves.shift()!(
        Response.json(
          { message: "Conflict. Refresh and review." },
          { status: 409 },
        ),
      ),
    );
    expect(host.textContent).toContain("Conflict. Refresh and review.");
    expect(button("Done").getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.unmount());
    rootUnmounted = true;
    const embeddedRoot = createRoot(host);
    await act(async () => embeddedRoot.render(<HabitTestProvider><Habits initialDate={date} stackId="missing" /></HabitTestProvider>));
    expect(host.querySelector("main")).toBeNull();
    expect(host.querySelector('input[type="date"]')).toBeNull();
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(date);
    expect(host.textContent).toContain("No habits due in this routine on this date.");
    await act(async () => embeddedRoot.unmount());
    synthesized = true;
    const syntheticRoot = createRoot(host);
    await act(async () => syntheticRoot.render(<HabitTestProvider><Habits initialDate={date} stackId="morning" /></HabitTestProvider>));
    expect(host.textContent).toContain("0 of 1 logged");
    await act(async () => button("Done").click());
    expect(host.textContent).toContain("1 of 1 logged");
    await act(async () => syntheticRoot.unmount());
  } finally {
    if (!rootUnmounted) await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
