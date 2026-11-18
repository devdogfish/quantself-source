import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("the drawer uses lifecycle availability without a confirmation request and keeps legacy history separate", async () => {
  const dom = new Window({ url: "http://localhost/jobs/applications" });
  const requests: string[] = [];
  const submissions: unknown[] = [];
  const confirmation = Promise.withResolvers<Response>();
  const fetchConfirmation = async (path: string, init?: RequestInit) => {
    requests.push(path);
    if (init?.method === "PUT") {
      submissions.push(JSON.parse(init.body as string));
      return confirmation.promise;
    }
    return Response.json({ replies: [{ id: "reply-older", confirmedAt: "2026-11-17T14:00:00.000Z" }], before: null });
  };
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    Element: dom.Element, Node: dom.Node, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchConfirmation,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { JobOriginalReplies, JobOriginalReply } = await import("./job-original-reply");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let refreshes = 0;
  const render = (id: string, legacyLinked: boolean, verifiedAvailable: boolean,
    replies?: { id: string; confirmedAt: string }[], before?: string) => root.render(
    <ChakraTestWrapper>
      <JobOriginalReply applicationId={id} legacyLinked={legacyLinked} verifiedAvailable={verifiedAvailable} />
      <JobOriginalReplies applicationId={id} replies={replies} before={before} canConfirm={!!replies}
        onConfirmed={() => refreshes++} />
    </ChakraTestWrapper>,
  );
  const href = (id: string) => `/api/owner/jobs/applications/${id}/original-reply`;
  try {
    await act(async () => render("first", true, false));
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Reply linked. Verified original unavailable.");
    await act(async () => render("second", false, true));
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe(href("second"));
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    await act(async () => render("third", false, false, [
      { id: "reply-one", confirmedAt: "2026-11-17T14:00:00.000Z" },
      { id: "reply-two", confirmedAt: "2026-11-17T14:00:00.000Z" },
    ], "reply-two"));
    const links = Array.from(host.querySelectorAll("li a"));
    expect(links.map(item => item.getAttribute("href"))).toEqual([
      "/api/owner/jobs/applications/third/replies/reply-one/original",
      "/api/owner/jobs/applications/third/replies/reply-two/original",
    ]);
    expect(links.map(item => item.textContent)).toEqual(["Open original for Reply 1", "Open original for Reply 2"]);
    expect(links.map(item => item.getAttribute("aria-label"))).toEqual([
      "Open original for Reply 1 in Roundcube", "Open original for Reply 2 in Roundcube",
    ]);
    expect(requests).toEqual([]);
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Older replies")!.click());
    expect(host.querySelector("li a")?.getAttribute("href")).toBe("/api/owner/jobs/applications/third/replies/reply-older/original");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "<synthetic@example.test>");
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", {
      bubbles: true, cancelable: true,
    }) as unknown as Event));
    expect(submissions).toEqual([{ messageId: "<synthetic@example.test>" }]);
    expect(refreshes).toBe(0);
    expect(host.querySelector("li a")?.getAttribute("href")).toContain("reply-older");
    expect(host.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
    await act(async () => confirmation.resolve(Response.json({ id: "reply-new" })));
    expect(requests).toEqual([
      "/api/owner/jobs/applications/third/replies?before=reply-two",
      "/api/owner/jobs/applications/third/replies/confirmation",
    ]);
    expect(refreshes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
