import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { chooseOption } from "@/components/shared/test-select";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

const createCalls: Array<Record<string, unknown>> = [];
const deleteCalls: string[] = [];
const listCalls: Array<Record<string, unknown>> = [];
let pendingCreate: Promise<void> | undefined;

mock.module("@/lib/quantself-api-browser", () => ({
  createRemedyIntakeFromBrowser: async (input: Record<string, unknown>) => {
    createCalls.push(input);
    if (pendingCreate) await pendingCreate;

    return {
      id: "intake-created",
      note: input.note ?? null,
      occurredAt: String(input.occurredAt),
      potency: input.potency,
      itemArchivedAt: null,
      itemId: input.itemId,
      itemTitle:
        input.itemId === "item-ars" ? "Arsenicum album" : "Nux vomica",
    };
  },
  deleteRemedyIntakeFromBrowser: async (intakeId: string) => {
    deleteCalls.push(intakeId);
  },
  listRemedyIntakesFromBrowser: async (input: Record<string, unknown>) => {
    listCalls.push(input);
    return [];
  },
}));

let RemedyIntakePanel: typeof import("./remedy-intake-panel").RemedyIntakePanel;

describe("remedy intake panel", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;
  let previousTimeZone: string | undefined;

  beforeEach(async () => {
    previousTimeZone = process.env.TZ;
    process.env.TZ = "UTC";
    cleanupGlobals = registerDomGlobals();
    ({ RemedyIntakePanel } = await import("./remedy-intake-panel"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
    createCalls.length = 0;
    deleteCalls.length = 0;
    listCalls.length = 0;
    pendingCreate = undefined;
  });

  afterEach(async () => {
    try {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      cleanupGlobals?.();
      cleanupGlobals = null;
      delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimeZone;
      }
    }
  });

  afterAll(() => {
    mock.restore();
  });

  test("switches potency choices by remedy and records intake with immediate feedback", async () => {
    await renderPanel();

    const remedyTrigger = container.querySelector<HTMLElement>('button[aria-label="Remedy"]');
    const potencyTrigger = () => container.querySelector<HTMLElement>('button[aria-label="Potency"]');
    const noteInput = container.querySelector<HTMLInputElement>('input[name="note"]');
    const occurredAtInput = container.querySelector<HTMLInputElement>(
      'input[name="occurredAt"]',
    );
    const form = container.querySelector("form");

    if (!remedyTrigger || !potencyTrigger() || !noteInput || !occurredAtInput || !form) {
      throw new Error("Missing remedy intake form fields");
    }

    expect(remedyTrigger.textContent).toContain("Arsenicum album");
    expect(potencyTrigger()!.textContent).toContain("30C");

    await chooseOption(remedyTrigger, "Nux vomica");

    expect(potencyTrigger()!.textContent).toContain("6C");

    await chooseOption(potencyTrigger()!, "30C");

    await act(async () => {
      noteInput.value = "After dinner.";
      reactInputProps(noteInput).onChange({
        currentTarget: noteInput,
        target: noteInput,
      });
      occurredAtInput.value = "2026-08-03T21:45";
      reactInputProps(occurredAtInput).onChange({
        currentTarget: occurredAtInput,
        target: occurredAtInput,
      });
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createCalls).toEqual([
      {
        note: "After dinner.",
        occurredAt: "2026-08-03T21:45:00.000Z",
        potency: "30C",
        itemId: "item-nux",
      },
    ]);
    expect(container.textContent).toContain("Remedy intake recorded.");
    expect(container.textContent).toContain("2 intakes in range");
    expect(container.textContent).toContain("Nux vomica: 1");
    expect(container.textContent).toContain("Nux vomica");
    expect(container.textContent).toContain("After dinner.");
  });

  test("shows a pending intake without announcing success before confirmation", async () => {
    let confirm!: () => void;
    pendingCreate = new Promise((resolve) => {
      confirm = resolve;
    });
    await renderPanel();
    const form = container.querySelector("form")!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const note = form.querySelector<HTMLInputElement>('input[name="note"]')!;

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(createCalls).toHaveLength(1);
    expect(submit.disabled).toBe(true);
    expect(note.disabled).toBe(false);
    expect(container.textContent).not.toContain("Remedy intake recorded.");

    await act(async () => confirm());
    expect(submit.disabled).toBe(false);
    expect(container.textContent).toContain("Remedy intake recorded.");
  });

  test("requires explicit confirmation before deleting an intake", async () => {
    await renderPanel();

    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete",
    );
    if (!deleteButton) {
      throw new Error("Missing delete button");
    }

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Delete this intake?");

    const confirmButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm delete",
    );
    if (!confirmButton) {
      throw new Error("Missing confirm delete button");
    }

    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(deleteCalls).toEqual(["intake-1"]);
    expect(container.textContent).toContain("Remedy intake deleted.");
    expect(container.textContent).not.toContain("Before bed.");
  });

  test("uses the selected time zone for range boundaries", async () => {
    await renderPanel({
      initialIntakes: [
        {
          id: "intake-edge",
          note: null,
          occurredAt: "2026-07-28T14:00:00.000Z",
          potency: "30C",
          itemArchivedAt: null,
          itemId: "item-ars",
          itemTitle: "Arsenicum album",
        },
      ],
      nowIso: "2026-08-03T16:00:00.000Z",
      range: "7d",
      timeZone: "Asia/Tokyo",
    });

    expect(container.textContent).toContain("No remedy intakes in this range.");
    expect(container.textContent).not.toContain("1 intake in range");
  });

  test("keeps archived remedies and includes every month in all-time history", async () => {
    await renderPanel({
      initialIntakes: [
        {
          bucketDate: "2026-09-02",
          colorKey: "remedy-6",
          id: "intake-future",
          note: "Follow-up note.",
          occurredAt: "2026-09-02T14:00:00.000Z",
          potency: "200C",
          itemArchivedAt: "2026-08-20T10:00:00.000Z",
          itemId: "item-ars",
          itemTitle: "Arsenicum album",
        },
        {
          bucketDate: "2026-07-02",
          colorKey: "remedy-6",
          id: "intake-earliest",
          note: null,
          occurredAt: "2026-07-02T14:00:00.000Z",
          potency: "30C",
          itemArchivedAt: "2026-08-20T10:00:00.000Z",
          itemId: "item-ars",
          itemTitle: "Arsenicum album",
        },
      ],
      range: "all",
      timeZone: "UTC",
    });

    expect(container.textContent).toContain("Jul 2026 to Sep 2026");
    expect(container.textContent).toContain("Arsenicum album · archived");
    const marker = container.querySelector<HTMLSpanElement>(
      'span[title*="Follow-up note."]',
    );
    expect(marker?.getAttribute("aria-label")).toContain("Follow-up note.");
    expect(marker?.tabIndex).toBe(0);
    expect(marker?.title).toContain("Arsenicum album · 200C");
  });

  test("reloads the selected range for the browser IANA time zone", async () => {
    const browserOptions = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Toronto",
    }).resolvedOptions();
    const resolvedOptions = spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue(browserOptions);
    try {
      await renderPanel({ timeZone: undefined });
    } finally {
      resolvedOptions.mockRestore();
    }

    expect(listCalls).toEqual([
      { range: "7d", timeZone: "America/Toronto" },
    ]);
    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href=\"/inventory/remedies?q=ars&range=7d&timeZone=America%2FToronto\"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("No remedy intakes in this range.");
  });

  async function renderPanel(
    overrides: Partial<
      React.ComponentProps<typeof RemedyIntakePanel>
    > = {},
  ) {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <RemedyIntakePanel
            initialIntakes={
              overrides.initialIntakes ?? [
                {
                  id: "intake-1",
                  note: "Before bed.",
                  occurredAt: "2026-08-03T22:15:00.000Z",
                  potency: "200C",
                  itemArchivedAt: null,
                  itemId: "item-ars",
                  itemTitle: "Arsenicum album",
                },
              ]
            }
            nowIso={overrides.nowIso ?? "2026-08-03T23:00:00.000Z"}
            range={overrides.range ?? "7d"}
            remedies={
              overrides.remedies ?? [
                {
                  archivedAt: null,
                  id: "item-ars",
                  remedyProfile: {
                    createdAt: "2026-08-03T09:00:00.000Z",
                    externalReferences: [],
                    potencies: ["30C", "200C"],
                    itemId: "item-ars",
                    registeredByClientId: "research-client",
                    selectionSummary: null,
                    substanceId: "substance-ars",
                    updatedAt: "2026-08-03T09:00:00.000Z",
                  },
                  title: "Arsenicum album",
                },
                {
                  archivedAt: null,
                  id: "item-nux",
                  remedyProfile: {
                    createdAt: "2026-08-03T09:00:00.000Z",
                    externalReferences: [],
                    potencies: ["6C", "30C"],
                    itemId: "item-nux",
                    registeredByClientId: "research-client",
                    selectionSummary: null,
                    substanceId: "substance-nux",
                    updatedAt: "2026-08-03T09:00:00.000Z",
                  },
                  title: "Nux vomica",
                },
              ]
            }
            searchQuery={overrides.searchQuery ?? "ars"}
            timeZone={overrides.timeZone}
          />
        </ChakraTestWrapper>,
      );
    });
  }
});

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    MouseEvent: globalThis.MouseEvent,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    MouseEvent: window.MouseEvent,
    navigator: window.navigator,
    Node: window.Node,
    window,
  });

  return () => {
    Object.assign(globalThis, previous);
  };
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}

function reactInputProps(input: HTMLInputElement): {
  onChange: (event: {
    currentTarget: HTMLInputElement;
    target: HTMLInputElement;
  }) => void;
} {
  return reactProps(input) as {
    onChange: (event: {
      currentTarget: HTMLInputElement;
      target: HTMLInputElement;
    }) => void;
  };
}

function reactProps(element: Element): Record<string, unknown> {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );

  if (!propsKey) {
    throw new Error("Missing React props");
  }

  return (element as unknown as Record<string, Record<string, unknown>>)[propsKey]!;
}
