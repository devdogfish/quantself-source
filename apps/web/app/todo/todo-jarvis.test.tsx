import { expect, jest, mock, test, afterAll } from "bun:test";
import { Window } from "happy-dom";
import type { JarvisCallbacks } from "./jarvis-connection";

// use-stick-to-bottom (live caption) observes size changes.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;
const notifications: string[] = [];
mock.module("@/components/chakra/toaster", () => ({
  Toaster: () => null,
  toaster: {
    create: ({ title }: { title: string }) => notifications.push(title),
  },
}));
let pathname = "/todo";
mock.module("next/navigation", () => ({
  usePathname: () => pathname, useRouter: () => ({ push() {} }) }));
mock.module("next/dynamic", () => ({
  default: () => (props: any) => <div data-aura-state={props.state} />,
}));
mock.module("next/link", () => ({ default: (props: any) => <a {...props} /> }));
afterAll(() => mock.restore());

test.each(["legacy", "queue"])("one sidebar click starts Jarvis despite unfinished %s recording recovery, without lifecycle toasts", async (format) => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = ["window", "document", "navigator", "HTMLElement", "Event", "Node", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? window : name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(window, name) });
  pathname = "/todo";
  notifications.length = 0;
  const old = { captureId: crypto.randomUUID(), conversationId: "old_conversation" };
  localStorage.setItem("quantself-jarvis-pending", JSON.stringify(format === "legacy" ? old : [old]));
  let oldReady = false, starts = 0, stops = 0;
  let handlers!: JarvisCallbacks;
  const activeIds: string[] = [];
  globalThis.fetch = (async (path: string) => Response.json(path.endsWith("/access") ? { signedUrl: "wss://example" } : path.endsWith("/commands") ? { commands: [] } : { status: oldReady && path.includes(old.captureId) ? "archived" : "pending" })) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoJarvis, JarvisNavActions, JarvisVoiceActivity, useJarvis } = await import("./todo-jarvis");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  let recover!: () => Promise<void>;
  function Controls() { recover = useJarvis()!.reconcile; return null; }
  const start = async (_url: string, id: string, callbacks: JarvisCallbacks) => {
    starts++; activeIds.push(id); handlers = callbacks; callbacks.connected(`conversation_${starts}`);
    return { endSession: async () => { stops++; }, setMicMuted() {} };
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = () => act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Jarvis")!.click(); });
  try {
    await act(async () => root.render(<ChakraTestWrapper><TodoJarvis start={start}><Controls /><JarvisVoiceActivity /><nav><JarvisNavActions /></nav></TodoJarvis></ChakraTestWrapper>));
    await click();
    expect(starts).toBe(1);
    expect(container.querySelector('[aria-label="Jarvis voice activity"]')).not.toBeNull();
    expect(notifications).toEqual([]);
    await act(async () => { handlers.mode(true); handlers.tool(true); });
    expect([...container.querySelectorAll("button")].find(button => button.textContent === "Jarvis")!.disabled).toBe(false);
    await click();
    expect(starts).toBe(1);
    expect(stops).toBe(1); // Manual stop interrupts speech and pending tools immediately.
    await act(async () => handlers.disconnected());
    expect(container.querySelector('[aria-label="Jarvis voice activity"]')).toBeNull();
    expect(notifications).toEqual([]);
    await click();
    expect(starts).toBe(2);
    expect(localStorage.getItem("quantself-jarvis-pending")).toContain(old.captureId);
    expect(localStorage.getItem("quantself-jarvis-pending")).toContain(activeIds[0]);
    expect(localStorage.getItem("quantself-jarvis-pending")).toContain(activeIds[1]);
    oldReady = true;
    await act(async () => recover());
    expect(localStorage.getItem("quantself-jarvis-pending")).not.toContain(old.captureId);
    expect(localStorage.getItem("quantself-jarvis-pending")).toContain(activeIds[1]);
    expect(container.querySelector('[aria-label="Jarvis voice activity"]')).not.toBeNull();
    expect(notifications).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

test("global Jarvis survives navigation, shows failures inline without toasts and keeps diagnostics out of pages", async () => {
  notifications.length = 0;
  const window = new Window({ url: "http://localhost/todo" });
  let now = 0;
  const originalNow = Date.now;
  jest.useFakeTimers();
  Date.now = () => now;
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "Node",
    "localStorage",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
  ];
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === "window"
          ? window
          : name === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : Reflect.get(window, name),
    });
  let denied = true,
    saving = true,
    resolved = false,
    ready = false,
    starts = 0,
    ends = 0,
    refreshes = 0;
  let callbacks!: JarvisCallbacks;
  let creates: any[] = [];
  const id = crypto.randomUUID();
  globalThis.fetch = (async (path: string) => {
    if (denied)
      return Response.json(
        { message: "Owner permission required" },
        { status: 403 },
      );
    if (path.endsWith("/commands"))
      return Response.json({
        commands: [
          {
            commandId: id,
            create: { commandId: id, title: "Voice task" },
            state: saving ? "pending" : "saved",
            number: saving ? null : 7,
            outcomes: saving
              ? { delivery: "uncertain" }
              : { issue: "saved", project: resolved ? "saved" : "failed" },
            retryable: true,
          },
        ],
      });
    return Response.json(
      path.endsWith("/access")
        ? {
            signedUrl: "wss://api.elevenlabs.io/private-transport-token",
            status: "connecting",
          }
        : { status: ready ? "archived" : "pending" },
    );
  }) as typeof fetch;
  const { act, useSyncExternalStore } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TodoJarvis, useJarvis, JarvisNavActions, JarvisVoiceActivity } = await import("./todo-jarvis");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoStoreProvider, useTodoStore } = await import("./todo-live");
  let sharedStore!: ReturnType<typeof useTodoStore>;
  function Page({ name }: { name: string }) {
    const jarvis = useJarvis()!;
    sharedStore = useTodoStore();
    const snapshot = useSyncExternalStore(
      sharedStore.subscribe,
      sharedStore.getSnapshot,
      sharedStore.getSnapshot,
    );
    return (
      <main>
        <h1>{name}</h1>
        <p>{snapshot.todos.map((todo) => todo.title).join(", ")}</p>
        <output>{jarvis.status}</output>
        <button onClick={() => void jarvis.begin()}>Start</button>
        <button onClick={() => void jarvis.reconcile()}>Recover</button>
        <button onClick={jarvis.openDebug}>Debug</button>
      </main>
    );
  }
  const start = async (
    _url: string,
    _capture: string,
    handlers: JarvisCallbacks,
  ) => {
    starts++;
    callbacks = handlers;
    handlers.connected("conv_1");
    return {
      async endSession() {
        ends++;
        handlers.disconnected();
      },
      setMicMuted() {},
    };
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (name: string) =>
    act(async () =>
      root.render(
        <ChakraTestWrapper><TodoStoreProvider>
          <TodoJarvis
            start={start}
            refreshTasks={async () => {
              refreshes++;
            }}
            onCreates={(rows) => {
              creates = rows;
              sharedStore.syncVoiceCreates(rows);
            }}
          >
            <JarvisVoiceActivity />
            <nav aria-label="Sidebar"><JarvisNavActions /></nav>
            <Page key={name} name={name} />
          </TodoJarvis>
        </TodoStoreProvider></ChakraTestWrapper>,
      ),
    );
  const click = async (name: string) =>
    act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === name)!
        .click(),
    );
  try {
    await render("Tasks");
    expect(
      container.querySelector('[aria-label="Jarvis voice controls"]'),
    ).toBeNull();
    await click("Start");
    expect(container.querySelector('[aria-label="Sidebar"] [role="status"]')?.textContent).toBe("Owner permission required");
    expect(notifications).toEqual([]);
    denied = false;
    await click("Start");
    expect(
      container
        .querySelector("[data-aura-state]")
        ?.getAttribute("data-aura-state"),
    ).toBe("listening");
    expect(container.querySelector('[aria-label="Jarvis voice activity"] [data-aura-state]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Sidebar"] [data-aura-state]')).toBeNull();
    expect(container.querySelector('[aria-label="End Jarvis"]')).toBeNull();
    expect(container.querySelector('[aria-label="Jarvis voice controls"]')).toBeNull();
    await render("Inventory");
    expect(starts).toBe(1);
    expect(ends).toBe(0);
    expect(container.textContent).toContain("Connected");
    await act(async () => {
      callbacks.message("user", "Private speech stays out of debug logs");
      callbacks.event?.("tool.request", "apply_task_command · tool_1");
      callbacks.tool(true);
    });
    expect(
      container
        .querySelector("[data-aura-state]")
        ?.getAttribute("data-aura-state"),
    ).toBe("thinking");
    expect(creates[0].state).toBe("pending");
    expect(sharedStore.getSnapshot().status).toBe("ready");
    await render("Home");
    expect(container.textContent).toContain("Voice task");
    expect(starts).toBe(1);
    expect(ends).toBe(0);
    expect(refreshes).toBe(0);
    saving = false;
    await act(async () => {
      callbacks.tool(false);
      callbacks.changed();
      callbacks.mode(true);
    });
    expect(
      container
        .querySelector("[data-aura-state]")
        ?.getAttribute("data-aura-state"),
    ).toBe("speaking");
    expect(creates[0].number).toBe(7);
    expect(refreshes).toBe(1);
    expect(container.querySelector('[aria-label="Sidebar"] [role="status"]')?.textContent).toBe("Some task changes failed or need review");
    expect(notifications).toEqual([]);
    expect(container.textContent).not.toContain("tool.request");
    await click("Review Jarvis status");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "tool.request",
    );
    expect(document.body.textContent).toContain("apply_task_command");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Private speech stays out");
    expect(container.querySelector('[aria-label="Live Jarvis transcript"]')?.textContent).toContain("You: Private speech stays out");
    await act(async () => {
      callbacks.message("agent", "Your task needs review.", 1);
      callbacks.message("agent", "Your task was saved.", 1);
    });
    const caption = container.querySelector('[aria-label="Live Jarvis transcript"]')!;
    expect(caption.textContent).toContain("Jarvis: Your task was saved.");
    expect(caption.textContent).not.toContain("needs review");
    expect(caption.getAttribute("aria-live")).toBe("polite");
    expect(localStorage.getItem("quantself-jarvis-pending")).not.toContain("Private speech");
    expect(container.textContent).not.toContain("private-transport-token");
    resolved = true;
    await act(async () => callbacks.changed());
    expect(container.querySelector('[aria-label="Sidebar"] [role="status"]')?.textContent ?? null).toBeNull();
    expect(notifications).toEqual([]);
    await act(async () => callbacks.disconnected());
    expect(localStorage.getItem("quantself-jarvis-pending")).toContain(
      "conv_1",
    );
    ready = true;
    await click("Recover");
    expect(localStorage.getItem("quantself-jarvis-pending")).toBeNull();
    expect(notifications).not.toContain("Conversation saved");
    expect(notifications).not.toContain("Jarvis connected");
    expect(notifications).not.toContain("Saving conversation…");
    await click("Start");
    expect(container.querySelector('[aria-label="Live Jarvis transcript"]')?.textContent).toBe("");
    await act(async () => callbacks.mode(true));
    now = 59000;
    await act(async () => callbacks.userActivity?.());
    now = 60001;
    await act(async () => { jest.advanceTimersByTime(1100); });
    expect(ends).toBe(0);
    now = 178999;
    await act(async () => { jest.advanceTimersByTime(1100); });
    expect(ends).toBe(0);
    now = 179000;
    await act(async () => { jest.advanceTimersByTime(1100); });
    expect(ends).toBe(1); // A stuck speaking/tool state cannot keep billing alive.
    expect(container.querySelector('[aria-label="Jarvis voice activity"]')).toBeNull();
    const beforeRestart = starts;
    await act(async () => { callbacks.disconnected("duration"); jest.advanceTimersByTime(20); });
    expect(starts).toBe(beforeRestart);
    await click("Start");
    await act(async () => window.dispatchEvent(new window.Event("pagehide")));
    expect(ends).toBe(2);
    await act(async () => window.dispatchEvent(new window.Event("pageshow")));
    expect(starts).toBe(beforeRestart + 1);
    await click("Start");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(ends).toBe(3);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(starts).toBe(beforeRestart + 2);
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    jest.useRealTimers();
    Date.now = originalNow;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 15000);
