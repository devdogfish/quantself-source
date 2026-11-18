import { expect, test } from "bun:test";
import { Window } from "happy-dom";
test("task provenance opens retained source and pending issue links", async () => {
  const window = new Window({ url: "http://localhost/todo" });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Event",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
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
            : (window as any)[name],
    });
  const paths: string[] = [];
  globalThis.fetch = (async (path: string, options?: RequestInit) => {
    paths.push(path);
    if (options?.method === "DELETE")
      return Response.json({
        capture: null,
        deleted: true,
        audio: null,
        links: [],
      });
    return Response.json({
      deleted: false,
      audio: {
        mime: "audio/ogg",
        size: 10,
        sha256: "hash",
        key: "original.audio",
      },
      capture: {
        source: "text",
        capturedAt: "2026-10-26T12:00:00Z",
        transcript: "Original words",
      },
      links: [
        { commandId: "one", number: 7, status: "linked" },
        { commandId: "two", number: null, status: "pending" },
      ],
    });
  }) as any;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoCaptureReview } = await import("./todo-capture-review");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChakraTestWrapper>
          <TodoCaptureReview id="5d72f10e-99cc-4d46-8bf8-d09f420ba453" />
        </ChakraTestWrapper>,
      ),
    );
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(paths).toEqual([
      "/api/v1/todo-captures/5d72f10e-99cc-4d46-8bf8-d09f420ba453",
    ]);
    expect(container.textContent).toContain("Original words");
    expect(container.textContent).toContain("Task #7 · linked");
    expect(container.textContent).toContain(
      "Task not yet identified · pending",
    );
    expect(container.querySelector("audio")?.getAttribute("src")).toContain(
      "/audio",
    );
    expect(container.querySelector("a")?.textContent).toBe(
      "Download original audio",
    );
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === text,
      )!;
    await act(async () => button("Delete retained source").click());
    expect(paths).toHaveLength(1);
    await act(async () => button("Permanently delete source").click());
    expect(container.textContent).toContain("Source deleted by Owner");
    expect(container.textContent).not.toContain("Original words");
    expect(container.querySelector("audio")).toBeNull();
    expect(paths).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
