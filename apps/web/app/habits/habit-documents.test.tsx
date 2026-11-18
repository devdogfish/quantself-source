import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("system documents request only selected documents and retry review failures", async () => {
  const window = new Window({ url: "http://localhost/habits" });
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Event", "Node", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const name of names.filter((n) => n !== "fetch"))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? window : name === "IS_REACT_ACT_ENVIRONMENT" ? true : (window as any)[name] });
  const requests: string[] = [];
  let reviewsFailed = false;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (request: Request) => {
    requests.push(request.url);
    if (request.url.includes("/document")) return Response.json({ path: new URL(request.url).searchParams.get("path"), text: `# ${new URL(request.url).searchParams.get("path") === "playbook.md" ? "Playbook reference" : "System reference"}\n\n| Choice | Action |\n| --- | --- |\n| Wait | Replace |\n<script>window.bad=true</script>\n[unsafe](javascript:alert(1))`, editUrl: "https://github.com/example", stale: false, error: null });
    if (request.url.includes("/reviews")) {
      if (!reviewsFailed) { reviewsFailed = true; return Response.json({ message: "Unavailable" }, { status: 503 }); }
      return Response.json({ paths: ["reviews/2026.md"], next: null, stale: false, error: null });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  } });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HabitTestProvider } = await import("@/app/habits/test-provider");
  const { HabitDocuments } = await import("./habit-documents");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    const referenceStart = performance.now();
    await act(async () => root.render(<HabitTestProvider><HabitDocuments /></HabitTestProvider>));
    console.info(`Reference load ${(performance.now() - referenceStart).toFixed(2)}ms; requests: ${requests.length}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("path=SYSTEM.md");
    expect(host.textContent).toContain("System reference");
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("article script")).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.textContent).not.toContain("Log an urge");
    expect(host.textContent).not.toContain("Recent urges");
    await act(async () => button("Playbook").click());
    expect(host.textContent).toContain("Playbook reference");
    await act(async () => button("Past reviews").click());
    expect(button("Past reviews").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).not.toContain("Playbook reference");
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain("/reviews");
    expect(host.textContent).toContain("Retry reviews");
    await act(async () => button("Retry reviews").click());
    expect(requests).toHaveLength(4);
    expect(host.textContent).toContain("2026");
    await act(async () => button("2026").click());
    expect(requests).toHaveLength(5);
    expect(requests[4]).toContain("reviews%2F2026.md");
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
