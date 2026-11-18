import { expect, test } from "bun:test";
import { act } from "react";
import { chooseOption } from "@/components/shared/test-select";
import { Window } from "happy-dom";

test("foreign price waits for quote and retains edits made during a deferred conversion", async () => {
  const dom = new Window({ url: "http://localhost/budgeting/subscriptions" });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "DocumentFragment",
    "Element",
    "Node",
    "NodeFilter",
    "Event",
    "CustomEvent",
    "MutationObserver",
    "ResizeObserver",
    "FormData",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
    "fetch",
  ];
  const before = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let resolve!: (value: Response) => void;
  let requests = 0;
  for (const name of names) {
    const value =
      name === "window"
        ? dom
        : name === "IS_REACT_ACT_ENVIRONMENT"
          ? true
          : name === "fetch"
            ? (url: string) => {
                requests++;
                expect(url).toContain("currency=USD");
                return new Promise<Response>((r) => (resolve = r));
              }
            : (dom as any)[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        typeof value === "function" &&
        [
          "getComputedStyle",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ].includes(name)
          ? value.bind(dom)
          : value,
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const { SubscriptionEditor } = await import("./subscription-editor");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const root = createRoot(host);
  const saved: any[] = [];
  let closes = 0;
  const quote = () =>
    Response.json({
      original: { amountMinor: 1000, currency: "USD" },
      converted: { amountMinor: 1400, currency: "CAD" },
      estimated: true,
      quote: {
        base: "USD",
        quote: "CAD",
        rate: "1.4",
        requestedDate: "2026-11-08",
        rateDate: "2026-11-06",
        fetchedAt: "2026-11-08T12:00:00Z",
        source: "frankfurter-v2",
        provider: "ecb",
      },
    });
  function fill(id: string, value: string) {
    const element = document.getElementById(id) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  try {
    await act(async () =>
      root.render(
        <ChakraTestWrapper>
          <SubscriptionEditor
            item={null}
            today="2026-11-08"
            onClose={() => { closes++; }}
            onSave={(item) => saved.push(item)}
          />
        </ChakraTestWrapper>,
      ),
    );
    await act(async () => {
      fill("subscription-name", "Example");
      fill("subscription-amount", "10.00");
    });
    await chooseOption(document.getElementById("subscription-currency")!, "USD");
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(requests).toBe(1);
    expect(saved).toHaveLength(0);
    expect(document.body.textContent).toContain("Getting rate");
    await act(async () => {
      fill("subscription-name", "Latest intent");
      resolve(quote());
    });
    expect(saved).toHaveLength(0);
    expect(
      (document.getElementById("subscription-name") as HTMLInputElement).value,
    ).toBe("Latest intent");
    expect(document.body.textContent).toContain(
      "Details changed while fetching the rate",
    );
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    // Back can unmount the editor while a confirmed save is still getting its quote.
    await act(async () => root.render(null));
    await act(async () => resolve(quote()));
    expect(saved).toHaveLength(1);
    expect(closes).toBe(0);
    expect(saved[0]).toMatchObject({
      name: "Latest intent",
      estimated: true,
      terms: [{ amountCents: 1000, currency: "USD", cadAmountCents: 1400 }],
    });
  } finally {
    await act(async () => {
      root.unmount();
      await Bun.sleep(5);
    });
    dom.happyDOM.abort();
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
