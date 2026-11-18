import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test.each([false, true])(
  "Owner reviews, edits, applies and dismisses advice; uncertain=%s survives refresh",
  async (uncertain) => {
    const window = new Window({ url: "http://localhost/todo" });
    const names = [
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "getComputedStyle",
      "MutationObserver",
      "DocumentFragment",
      "CustomEvent",
      "HTMLSelectElement",
      "Element",
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "Event",
      "Node",
      "sessionStorage",
      "IS_REACT_ACT_ENVIRONMENT",
      "fetch",
    ];
    const previous = new Map(
      names.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    for (const name of names.filter((name) => name !== "fetch"))
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
    const first = {
      number: 1,
      revision: "r1",
      reason: "Unblocks the important client commitment",
      command: {
        commandId: crypto.randomUUID(),
        fields: { Estimate: { before: 30, after: 45 } },
      },
    };
    const second = {
      ...first,
      number: 2,
      reason: "Prepare prerequisite first",
      command: { ...first.command, commandId: crypto.randomUUID() },
    };
    const dismissed = new Set<string>(),
      requests: { path: string; method?: string; body: any }[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (path: string, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path, method: init.method, body });
        if (path.endsWith("/dismiss")) {
          dismissed.add(body.commandId);
          return Response.json({ suggestions: [] });
        }
        if (path.endsWith("/review"))
          return Response.json({ proposal: body, stale: false });
        if (init.method === "PATCH")
          return Response.json({
            commandId: body.commandId,
            todo: null,
            outcomes: {
              Estimate:
                uncertain &&
                requests.filter((request) => request.method === "PATCH")
                  .length === 1
                  ? "uncertain"
                  : "saved",
            },
            retryable: false,
            message: "Saved",
          });
        return Response.json({
          suggestions: [first, second].map((proposal) => ({
            proposal,
            dismissed: dismissed.has(proposal.command.commandId),
          })),
        });
      },
    });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TodoSuggestions } = await import("./todo-suggestions");
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container),
      refreshes = 0;
    const render = async () => {
      await act(async () =>
        root.render(
          <ChakraTestWrapper><TodoSuggestions
            writable
            refreshTasks={async () => {
              refreshes++;
            }}
            editTask={() => {}}
          /></ChakraTestWrapper>,
        ),
      );
    };
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      )!;
      expect(button).toBeDefined();
      await act(async () => button.click());
    };
    try {
      await render();
      await click("Planning suggestions");
      expect(requests).toHaveLength(0);
      if (
        ![...container.querySelectorAll("button")].some(
          (b) => b.textContent === "Refresh suggestions",
        )
      )
        await click("Planning suggestions");
      await click("Refresh suggestions");
      const review = sessionStorage.getItem("todo-suggestion-review");
      expect(container.textContent).toContain(first.reason);
      expect(
        requests.filter((request) => request.method === "PATCH"),
      ).toHaveLength(0);
      const input = container.querySelector(
        'input[aria-label="Proposed Estimate for task 1"]',
      ) as HTMLInputElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "50");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await click("Apply suggestion");
      expect(
        requests.find((request) => request.method === "PATCH"),
      ).toMatchObject({
        path: "/api/v1/todos/1",
        body: {
          commandId: first.command.commandId,
          fields: { Estimate: { before: 30, after: 50 } },
        },
      });
      expect(refreshes).toBe(1);
      if (uncertain) {
        expect(container.textContent).toContain("Estimate: uncertain");
        await act(async () => root.unmount());
        root = createRoot(container);
        await render();
        if (
          ![...container.querySelectorAll("button")].some(
            (b) => b.textContent === "Refresh suggestions",
          )
        )
          await click("Planning suggestions");
        await click("Refresh suggestions");
        expect(
          (
            container.querySelector(
              'input[aria-label="Proposed Estimate for task 1"]',
            ) as HTMLInputElement
          ).value,
        ).toBe("50");
        await click("Reconcile application");
        const writes = requests.filter((request) => request.method === "PATCH");
        expect(writes[1].body).toEqual(writes[0].body);
      }
      expect(container.textContent).toContain("Estimate: saved");
      await click("Dismiss suggestion");
      expect(
        requests.filter((request) => request.method === "PATCH"),
      ).toHaveLength(uncertain ? 2 : 1);
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      expect(sessionStorage.getItem("todo-suggestion-review")).toBe(review);
      if (
        ![...container.querySelectorAll("button")].some(
          (b) => b.textContent === "Refresh suggestions",
        )
      )
        await click("Planning suggestions");
      await click("Refresh suggestions");
      expect(container.textContent).not.toContain(first.reason);
      expect(container.textContent).not.toContain(second.reason);
      expect(container.textContent).toContain("No suggestions");
    } finally {
      await act(async () => root.unmount());
      window.happyDOM.abort();
      for (const name of names) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  },
);
