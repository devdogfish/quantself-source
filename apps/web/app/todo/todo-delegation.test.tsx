import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveTodo } from "./todo-live";

const cases = [
  {
    status: 200,
    result: {
      message: "Inspect runner progress",
      outcomes: { approval: "uncertain" },
      retryable: false,
    },
    expected: "approval: uncertain",
  },
  {
    status: 400,
    result: { success: false, error: { name: "ZodError" } },
    expected: "Approval rejected (HTTP 400). Refresh and review again.",
  },
  {
    status: 403,
    result: { message: "Missing todos:approve permission" },
    expected: "Missing todos:approve permission",
  },
  {
    status: 409,
    result: {
      code: "STALE_APPROVAL",
      message: "Task, brief or prerequisites changed. Review again.",
    },
    expected: "Task, brief or prerequisites changed. Review again.",
  },
];

test.each(cases)("delegation approval HTTP $status", async (scenario) => {
  const { status, result, expected } = scenario;
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
    names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]),
  );
  for (const name of names.filter((name) => name !== "fetch")) {
    let value: unknown;
    if (name === "window") value = window;
    else if (name === "IS_REACT_ACT_ENVIRONMENT") value = true;
    else value = Reflect.get(window, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const requests: any[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (path: string, init: RequestInit) => {
      requests.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(result, { status });
    },
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChakraTestWrapper } = await import("@/components/chakra/test-utils");
  const { TodoDelegation } = await import("./todo-delegation");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const todo: LiveTodo = {
    id: "one",
    databaseId: 1,
    number: 1,
    repository: "tasks/personal",
    url: "https://example.com/1",
    title: "Compare options",
    body: "No spending authorized",
    state: "open",
    closureReason: null,
    updatedAt: "now",
    fields: {},
    fieldValues: [],
    labels: ["task", "ready-for-agent"],
    start: null, end: null, allDay: false, fixed: false,
    scheduleError: null,
    readiness: "ready",
    blockedBy: [],
    approvalRevision: "a".repeat(64),
    comments: [
      {
        id: 2,
        body: "Agent Brief: compare options; save to issue; done when documented",
        url: "https://example.com/comment",
        updatedAt: "now",
      },
    ],
  };
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    )!;
    expect(button).toBeDefined();
    await act(async () => {
      button.click();
    });
  };
  try {
    await act(async () =>
      root.render(
        <ChakraTestWrapper><TodoDelegation
          todo={todo}
          canWrite={false}
          canApprove={true}
          disabled={false}
          onSaved={() => {}}
        /></ChakraTestWrapper>,
      ),
    );
    expect(requests).toHaveLength(0);
    await click("Review delegation approval");
    expect(container.textContent).toContain("No spending authorized");
    expect(container.textContent).toContain("Prerequisites: ready");
    expect(container.textContent).toContain("Agent Brief: compare options");
    expect(requests).toHaveLength(0);
    await click("Approve execution");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/v1/todos/1/approval",
      body: { revision: "a".repeat(64), intent: "execute", confirmed: true },
    });
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain("undefined");
    expect(requests).toHaveLength(1);
    expect(
      (container.querySelector("button") as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () =>
      root.render(
        <ChakraTestWrapper><TodoDelegation
          todo={{ ...todo, labels: ["ready-for-human"] }}
          canWrite={false}
          canApprove={false}
          disabled={false}
          onSaved={() => {}}
        /></ChakraTestWrapper>,
      ),
    );
    expect(container.textContent).toContain("Ready for human");
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.whenAsyncComplete();
    window.happyDOM.abort();
    for (const n of names) {
      const descriptor = previous.get(n);
      if (descriptor) Object.defineProperty(globalThis, n, descriptor);
      else Reflect.deleteProperty(globalThis, n);
    }
  }
});
