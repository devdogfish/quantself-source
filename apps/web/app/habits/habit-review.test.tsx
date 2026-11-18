import { expect, test } from "bun:test";
import { Window } from "happy-dom";
test("review acknowledges pending create, leaves unrelated tracking usable, reopens read-only document and copies complete context", async () => {
  const window = new Window({ url: "http://localhost/habits" });
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
  let resolve!: (r: Response) => void,
    copied = "";
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  const requests: string[] = [];
  const documentPaths: Array<string | null> = [];
  let incomplete = false;
  let documentUnavailable = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (req: Request) => {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path.endsWith("/review"))
        return new Promise<Response>((r) => {
          resolve = r;
        });
      if (path.endsWith("/document")) {
        expect(req.method).toBe("GET");
        documentPaths.push(new URL(req.url).searchParams.get("path"));
        if (documentUnavailable) return Promise.resolve(Response.json({}, { status: 503 }));
        return Promise.resolve(
          Response.json({
            text: "## What went well\n\nExisting answers",
            editUrl:
              "https://github.com/fixture/habits/edit/HEAD/reviews/2026-11-08.md",
            stale: false,
          }),
        );
      }
      if (path.endsWith("/context"))
        return Promise.resolve(
          Response.json({
            text: "Complete context",
            unavailable: incomplete ? ["playbook.md"] : [],
          }),
        );
      throw Error(path);
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HabitTestProvider } = await import("@/app/habits/test-provider");
  const { HabitReview } = await import("./habit-review");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  try {
    let edits = 0;
    await act(async () => {
      root.render(
        <HabitTestProvider><>
          <button onClick={() => edits++}>Track another habit</button>
          <HabitReview date="2026-11-04" />
        </></HabitTestProvider>,
      );
    });
    await act(async () => button("Start review").click());
    expect(host.textContent).toContain("Loading review…");
    await act(async () => button("Track another habit").click());
    expect(edits).toBe(1);
    await act(async () => {
      resolve(Response.json({ path: "reviews/2026-11-08.md" }));
    });
    expect(host.textContent).toContain("Review document exists");
    expect(host.textContent).toContain("Review document unavailable");
    expect(host.textContent).not.toContain("review is done");
    documentUnavailable = false;
    await act(async () => button("Open review").click());
    expect(host.textContent).toContain("Existing answers");
    expect(host.querySelector("a")?.href).toContain(
      "/edit/HEAD/reviews/2026-11-08.md",
    );
    expect(host.querySelector("textarea")).toBeNull();
    await act(async () => button("Copy as LLM context").click());
    expect(copied).toBe("Complete context");
    incomplete = true;
    copied = "";
    await act(async () => button("Copy as LLM context").click());
    expect(copied).toBe("");
    expect(host.textContent).toContain("Context incomplete: playbook.md");
    await act(async () => root.render(<HabitTestProvider><HabitReview key="existing" date="2026-11-15" status="exists" /></HabitTestProvider>));
    await act(async () => button("Open review").click());
    expect(documentPaths).toEqual(["reviews/2026-11-08.md", "reviews/2026-11-08.md", "reviews/2026-11-15.md"]);
    expect(requests.filter((p) => p.endsWith("/review"))).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
