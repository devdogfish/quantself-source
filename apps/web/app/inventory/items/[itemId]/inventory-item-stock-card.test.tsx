import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InventoryStockMutationAction } from "./inventory-item-stock-card";

const routerCalls = { refresh: 0 };

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {
      routerCalls.refresh += 1;
    },
  }),
}));

let InventoryItemStockCard: typeof import("./inventory-item-stock-card").InventoryItemStockCard;

describe("inventory Item stock card", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventoryItemStockCard } = await import("./inventory-item-stock-card"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    routerCalls.refresh = 0;
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => mock.restore());

  test("shows total quantity and every retrieval context in Stock", async () => {
    await renderCard();

    expect(container.textContent).toContain("Stock");
    expect(container.textContent).toContain("Total quantity");
    expect(container.querySelector("strong")?.textContent).toBe("4");
    expect(container.textContent).toContain("Travel pouch (BIN-0007)");
    expect(container.textContent).not.toContain(
      "Placement ID: placement-container-1",
    );
    expect(container.textContent).toContain("Qty 2");
    expect(container.textContent).toContain("Wardrobe");
    expect(container.textContent).toContain("Note: Upper rail");
    expect(container.textContent).toContain("Qty 1");
    expect(container.textContent).toContain("Unplaced");
    expect(container.textContent).toContain("Qty 1");
    expect(container.textContent).toContain("Legacy Where: Garage overflow");
    expect(container.textContent).toContain("Add units");
    expect(container.textContent).toContain("Move units");
    expect(container.textContent).toContain("Remove units");
    expect(container.textContent).not.toContain("Merge");
  });

  test("adds a positive quantity to a selected Inventory Location", async () => {
    const submissions: FormData[] = [];
    await renderCard({
      addAction: successfulAction(submissions, "Added 3 · Total 5"),
    });

    await clickButton("Add units");
    await setInputValue('input[name="quantity"]', "3");
    await setSelectValue(
      'select[name="destination"]',
      "location:location-wardrobe",
    );
    await clickButton("Add units");

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.get("itemId")).toBe("item-1");
    expect(submissions[0]?.get("quantity")).toBe("3");
    expect(submissions[0]?.get("containerId")).toBeNull();
    expect(submissions[0]?.get("locationId")).toBe("location-wardrobe");
    expect(container.textContent).toContain("Added 3 · Total 5");
    expect(routerCalls.refresh).toBe(1);
  });

  test("shows pending stock work and refreshes after confirmation", async () => {
    const save =
      Promise.withResolvers<
        Awaited<ReturnType<InventoryStockMutationAction>>
      >();
    await renderCard({ addAction: () => save.promise });

    await clickButton("Add units");
    await clickButton("Add units");

    const submit = document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(submit?.getAttribute("aria-busy")).toBe("true");
    expect(submit?.disabled).toBe(true);
    expect(container.querySelector("strong")?.textContent).toBe("4");
    expect(routerCalls.refresh).toBe(0);

    await act(async () =>
      save.resolve({ message: "Added 1 · Total 5", status: "success" }),
    );

    expect(container.textContent).toContain("Added 1 · Total 5");
    expect(routerCalls.refresh).toBe(1);
  });

  test("prevents moving units to their current Placement", async () => {
    const submissions: FormData[] = [];
    await renderCard({ moveAction: successfulAction(submissions, "Moved") });

    await clickButton("Move units");
    await setSelectValue('select[name="destination"]', "container:container-1");

    expect(document.body.textContent).toContain(
      "Choose a destination different from the source.",
    );
    expect(findButton("Move units")?.disabled).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  test("caps removal at the source quantity and supports unplaced stock", async () => {
    const submissions: FormData[] = [];
    await renderCard({
      removeAction: successfulAction(submissions, "Removed 2 · Archived"),
    });

    await clickButton("Remove units");
    await setSelectValue('select[name="source"]', "unplaced");

    const quantity = document.querySelector<HTMLInputElement>(
      'input[name="quantity"]',
    );
    expect(quantity?.max).toBe("1");
    expect(document.body.textContent).toContain(
      "Removing the final unit archives this Item.",
    );

    await setInputValue('input[name="quantity"]', "1");
    await clickButton("Remove units");

    expect(submissions[0]?.get("containerId")).toBeNull();
    expect(submissions[0]?.get("locationId")).toBeNull();
    expect(submissions[0]?.get("quantity")).toBe("1");
    expect(routerCalls.refresh).toBe(1);
  });

  async function renderCard({
    addAction = idleAction,
    moveAction = idleAction,
    removeAction = idleAction,
  }: {
    addAction?: InventoryStockMutationAction;
    moveAction?: InventoryStockMutationAction;
    removeAction?: InventoryStockMutationAction;
  } = {}) {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryItemStockCard
            addAction={addAction}
            containers={[
              { id: "container-1", label: "Travel pouch (BIN-0007)" },
              { id: "container-2", label: "Office shelf (BIN-0012)" },
            ]}
            locations={[
              { id: "location-wardrobe", label: "Wardrobe" },
              { id: "location-pantry", label: "Pantry" },
            ]}
            moveAction={moveAction}
            placements={[
              {
                containerId: "container-1",
                label: "Travel pouch (BIN-0007)",
                locationId: null,
                note: null,
                placementId: "placement-container-1",
                quantity: 2,
              },
              {
                containerId: null,
                label: "Wardrobe",
                locationId: "location-wardrobe",
                note: "Upper rail",
                placementId: "placement-location-wardrobe",
                quantity: 1,
              },
              {
                containerId: null,
                label: "Unplaced",
                locationId: null,
                note: null,
                placementId: "placement-unplaced",
                quantity: 1,
              },
            ]}
            itemId="item-1"
            legacyWhere="Garage overflow"
            removeAction={removeAction}
            totalQuantity={4}
          />
        </ChakraTestWrapper>,
      );
    });
  }
});

const idleAction: InventoryStockMutationAction = async () => ({
  message: "",
  status: "idle",
});

function successfulAction(
  submissions: FormData[],
  message: string,
): InventoryStockMutationAction {
  return async (_state, formData) => {
    submissions.push(formData);
    return { message, status: "success" };
  };
}

async function clickButton(text: string) {
  const button = findButton(text);
  if (!button) throw new Error(`Missing ${text} button`);

  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function findButton(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.trim() === text)
      .at(-1) ?? null
  );
}

async function setInputValue(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing ${selector}`);

  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setSelectValue(selector: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(selector);
  if (!select) throw new Error(`Missing ${selector}`);

  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function registerDomGlobals(): () => void {
  const window = new Window();
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
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
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    navigator: window.navigator,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    window,
  });

  return () => Object.assign(globalThis, previous);
}

function getActEnvironment(): typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} {
  return globalThis;
}
