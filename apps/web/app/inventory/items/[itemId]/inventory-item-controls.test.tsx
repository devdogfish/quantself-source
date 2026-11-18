import { ChakraTestWrapper } from "@/components/chakra/test-utils";
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
import { createRoot, type Root } from "react-dom/client";
import type {
  InventoryItemEditableViewModel,
  InventoryItemMutationAction,
} from "./inventory-item-controls";

const routerCalls = {
  push: [] as string[],
  refresh: 0,
};

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: () => {},
  usePathname: () => "/inventory/browse",
  useRouter: () => ({
    push: (href: string) => routerCalls.push.push(href),
    replace: () => {},
    refresh: () => {
      routerCalls.refresh += 1;
    },
  }),
  useSearchParams: () => new URLSearchParams(),
}));

let InventoryItemControls: typeof import("./inventory-item-controls").InventoryItemControls;

describe("inventory item controls", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventoryItemControls } = await import("./inventory-item-controls"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
    routerCalls.push = [];
    routerCalls.refresh = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  test("keeps editing hidden until Edit opens one complete form", async () => {
    await renderControls();

    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Delete");
    expect(document.body.textContent).not.toContain("Save changes");

    await clickButton("Edit");

    expect(document.body.textContent).toContain("Edit item");
    expect(document.body.textContent).toContain("Save changes");
    expect(document.body.textContent).toContain("Title");
    expect(document.body.textContent).toContain("Type");
    expect(document.body.textContent).toContain("Status");
    expect(document.body.textContent).toContain("Importance");
    expect(document.body.textContent).toContain("Category");
    expect(document.body.textContent).toContain("Acquisition source");
    expect(document.body.textContent).toContain("Estimated value (CAD)");
    expect(document.body.textContent).toContain("Tags");
    expect(document.body.textContent).toContain("Aliases");
    expect(document.body.textContent).toContain("Notes");
    expect(document.body.textContent).toContain("Capture text");
    expect(document.body.textContent).toContain(
      "Manage media in the Images and Media sections.",
    );
    expect(document.querySelector('input[name="assets"]')).toBeNull();
  });

  test("groups page actions for keyboard users and keeps Edit focusable", async () => {
    await renderControls({
      archiveAction: idleAction,
      restoreAction: idleAction,
    });

    const actions = container.querySelector<HTMLElement>(
      '[role="group"][aria-label="Item actions"]',
    );
    const editButton = findButtonByAccessibleText("Edit");

    expect(actions?.textContent).toContain("Edit");
    expect(actions?.textContent).toContain("Archive");
    expect(actions?.textContent).toContain("Delete");
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton?.focus();
    });

    expect(document.activeElement).toBe(editButton);
  });

  test("opens the editor from a workflow recovery deep link", async () => {
    await renderControls({ initialEditOpen: true });

    expect(document.body.textContent).toContain("Edit item");
    expect(document.body.textContent).toContain("Save changes");
  });

  test("does not warn when refreshed item values reach an open editor", async () => {
    const consoleErrors: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(
      (...values: unknown[]) => {
        consoleErrors.push(values.map(String).join(" "));
      },
    );

    try {
      await renderControls();
      await clickButton("Edit");
      await renderControls();

      expect(
        consoleErrors.filter((message) =>
          message.includes(
            "changing the default value state of an uncontrolled Select",
          ),
        ),
      ).toEqual([]);

      await renderControls({
        item: buildItem({ kind: "GROUP" }),
      });

      expect(
        consoleErrors.filter((message) =>
          message.includes(
            "changing the default value state of an uncontrolled Select",
          ),
        ),
      ).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("requires delete confirmation then returns to returnTo", async () => {
    const submissions: FormData[] = [];
    const deleteAction: InventoryItemMutationAction = async (
      _state,
      formData,
    ) => {
      submissions.push(formData);

      return { message: "Deleted.", status: "success" };
    };

    await renderControls({ deleteAction });
    await clickButton("Delete");

    expect(submissions).toHaveLength(0);
    expect(document.body.textContent).toContain("Delete item?");
    expect(document.body.textContent).toContain(
      "This permanently deletes the item and all attached files.",
    );

    await clickButton("Delete item");

    expect(submissions[0]?.get("itemId")).toBe("item-1");
    expect(routerCalls.push).toEqual([
      "/inventory/browse?containerId=container-1",
    ]);
    expect(routerCalls.refresh).toBe(1);
  });

  test("archives an active item and opens the low-visibility archive", async () => {
    const submissions: FormData[] = [];
    const archiveAction: InventoryItemMutationAction = async (
      _state,
      formData,
    ) => {
      submissions.push(formData);

      return { message: "Archived.", status: "success" };
    };

    await renderControls({
      archiveAction,
      restoreAction: idleAction,
    });

    expect(container.textContent).toContain("Archive");
    expect(container.textContent).not.toContain("Restore");

    await clickButton("Archive");

    expect(submissions[0]?.get("itemId")).toBe("item-1");
    expect(routerCalls.push).toEqual(["/inventory/archive"]);
    expect(routerCalls.refresh).toBe(1);
  });

  test("restores an archived item to its return target", async () => {
    const submissions: FormData[] = [];
    const restoreAction: InventoryItemMutationAction = async (
      _state,
      formData,
    ) => {
      submissions.push(formData);

      return { message: "Restored.", status: "success" };
    };

    await renderControls({
      archiveAction: idleAction,
      item: buildItem({ archivedAt: "2026-07-26T12:00:00.000Z" }),
      restoreAction,
    });

    expect(container.textContent).toContain("Restore");
    expect(container.textContent).not.toContain("Edit");

    await clickButton("Restore");

    expect(submissions[0]?.get("itemId")).toBe("item-1");
    expect(routerCalls.push).toEqual([
      "/inventory/browse?containerId=container-1",
    ]);
    expect(routerCalls.refresh).toBe(1);
  });

  async function renderControls({
    archiveAction,
    deleteAction = idleAction,
    initialEditOpen = false,
    item = buildItem(),
    restoreAction,
    updateAction = idleAction,
  }: {
    archiveAction?: InventoryItemMutationAction;
    deleteAction?: InventoryItemMutationAction;
    initialEditOpen?: boolean;
    item?: InventoryItemEditableViewModel;
    restoreAction?: InventoryItemMutationAction;
    updateAction?: InventoryItemMutationAction;
  } = {}) {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryItemControls
            archiveAction={archiveAction}
            containers={[
              { id: "container-1", label: "Travel pouch (BIN-0007)" },
            ]}
            deleteAction={deleteAction}
            initialEditOpen={initialEditOpen}
            item={item}
            restoreAction={restoreAction}
            returnTo="/inventory/browse?containerId=container-1"
            updateAction={updateAction}
          />
        </ChakraTestWrapper>,
      );
    });
  }
});

const idleAction: InventoryItemMutationAction = async () => ({
  message: "",
  status: "idle",
});

function buildItem(
  overrides: Partial<InventoryItemEditableViewModel> = {},
): InventoryItemEditableViewModel {
  return {
    acquisitionSource: "gift",
    aliases: ["travel pouch"],
    assets: [
      {
        key: "image:image-1",
        kind: "image",
        mimeType: "image/jpeg",
        name: "front.jpg",
        sizeBytes: 1024,
        url: "/api/v1/inventory-items/item-1/media/image-1",
      },
      {
        key: "audio:audio-1",
        kind: "audio",
        mimeType: "audio/mp4",
        name: "note.m4a",
        sizeBytes: 2048,
        url: "/api/v1/inventory-items/item-1/media/audio-1",
      },
    ],
    captureText: "Black travel pouch",
    category: "documents",
    containerId: "container-1",
    costCents: 1250,
    costCurrency: "CAD",
    id: "item-1",
    importance: "LOW",
    kind: "ITEM",
    note: "Needs sort",
    status: "KEEP",
    tags: ["travel"],
    title: "Travel pouch",
    ...overrides,
  };
}

async function clickButton(text: string) {
  const button = findButtonByAccessibleText(text);

  if (!button) {
    throw new Error(`Missing ${text} button`);
  }

  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function findButtonByAccessibleText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.getAttribute("aria-label") === text ||
        button.textContent?.trim() === text,
    ) ?? null
  );
}

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    NodeFilter: globalThis.NodeFilter,
    CustomEvent: globalThis.CustomEvent,
    DocumentFragment: globalThis.DocumentFragment,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    File: globalThis.File,
    FormData: globalThis.FormData,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLFormElement: globalThis.HTMLFormElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    MouseEvent: globalThis.MouseEvent,
    MutationObserver: globalThis.MutationObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    document: window.document,
    HTMLSelectElement: window.HTMLSelectElement,
    NodeFilter: window.NodeFilter,
    CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    File: window.File,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    navigator: window.navigator,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
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
