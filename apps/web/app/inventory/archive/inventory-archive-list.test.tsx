import "@/components/shared/dom-env";
import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  jest,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";

const originalFetch = globalThis.fetch;
const routerCalls = {
  refresh: 0,
};

mock.module("next/link", () => ({
  default: ({
    children,
    href,
    prefetch: _prefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: () => {},
  usePathname: () => "/inventory/browse",
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {
      routerCalls.refresh += 1;
    },
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

let InventoryArchiveList: typeof import("./inventory-archive-list").InventoryArchiveList;

describe("inventory archive list", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventoryArchiveList } = await import("./inventory-archive-list"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
    routerCalls.refresh = 0;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({ items: [], pageInfo: { nextCursor: null }, total: 0 }),
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    globalThis.fetch = originalFetch;
    cleanupGlobals?.();
    cleanupGlobals = null;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  test("shows last container, submits archive search, opens detail, and restores", async () => {
    const submissions: FormData[] = [];

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={[
              {
                archivedAt: "2026-07-26T12:00:00.000Z",
                containerLabel: "Basement tote",
                containerReferenceId: "BIN-0007",
                id: "item-projector",
                title: "Projector",
              },
              {
                archivedAt: "2026-07-25T12:00:00.000Z",
                containerLabel: "Unplaced",
                containerReferenceId: null,
                id: "item-cable",
                title: "Cable",
              },
            ]}
            query="projector"
            returnTo="/inventory/archive?q=projector"
            restoreAction={async (_state, formData) => {
              submissions.push(formData);

              return { message: "Restored.", status: "success" };
            }}
          />
        </ChakraTestWrapper>,
      );
    });

    const table = container.querySelector('table[aria-label="Archived inventory"]')!;
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(
      ["Item", "Last container", "Archived", "Actions"],
    );
    const row = table.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Basement tote · BIN-0007");
    expect(row.querySelector('button[aria-label="Restore Projector"]')?.closest("a")).toBeNull();
    expect(
      container.querySelector(
        'a[href="/inventory/items/item-projector?returnTo=%2Finventory%2Farchive%3Fq%3Dprojector"]',
      )?.textContent,
    ).toBe("Projector");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Search archived inventory"]',
      )?.value,
    ).toBe("projector");

    await clickButton("Restore");

    expect(submissions[0]?.get("itemId")).toBe("item-projector");
    expect(container.textContent?.includes("Projector")).toBe(false);
    expect(routerCalls.refresh).toBe(0);
  });

  test("keeps navigation and other restores available while a restore waits, then shows rejection", async () => {
    let finish!: (state: { status: "error"; message: string }) => void;
    const pending = new Promise<{ status: "error"; message: string }>(
      (resolve) => {
        finish = resolve;
      },
    );
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={["Projector", "Cable"].map((title) => ({
              archivedAt: "2026-07-26T12:00:00.000Z",
              containerLabel: "Unplaced",
              containerReferenceId: null,
              id: title.toLowerCase(),
              title,
            }))}
            query=""
            returnTo="/inventory/archive"
            restoreAction={async () => pending}
          />
        </ChakraTestWrapper>,
      );
    });
    const restores = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((button) => button.textContent?.trim() === "Restore");
    await act(async () => {
      restores[0]!.click();
    });
    expect(container.textContent?.includes("Projector")).toBe(false);
    expect(restores[1]!.disabled).toBe(false);
    expect(
      container.querySelector('a[href*="/inventory/items/cable?returnTo="]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Search archived inventory"]',
      )!.disabled,
    ).toBe(false);
    await act(async () => {
      finish({ status: "error", message: "Restore rejected. Try again." });
    });
    expect(container.textContent?.includes("Projector")).toBe(true);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Restore rejected. Try again.",
    );
    expect(routerCalls.refresh).toBe(0);
  });

  test("exports all Archive matches except a row optimistically restored", async () => {
    const requests: string[] = [];
    const writeText = mock(async (_value: string) => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText } });
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return Response.json({
          items: [{ id: "projector" }, { id: "another-page" }],
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    let confirm!: (value: { status: "success"; message: string }) => void;
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={[{
              id: "projector", title: "Projector", archivedAt: "",
              containerLabel: "Unplaced", containerReferenceId: null,
            }]}
            query="projector"
            returnTo="/inventory/archive?q=projector"
            restoreAction={() => new Promise((resolve) => { confirm = resolve; })}
            archiveAction={async () => ({ status: "success", message: "" })}
          />
        </ChakraTestWrapper>,
      );
    });
    expect(requests).toHaveLength(0);
    await clickButton("Restore");
    const copy = () => container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy"], button[aria-label="Copied"]',
    )!;
    await act(async () => copy().click());
    expect(requests).toEqual(["/api/v1/inventory-items/export?archived=true&q=projector"]);
    expect(writeText).toHaveBeenCalledWith("another-page");
    await clickButton("Undo");
    expect(copy().disabled).toBe(true);
    await act(async () => confirm({ status: "success", message: "" }));
    expect(copy().disabled).toBe(false);
  });

  test("optimistic restores, Undo/Redo and newer intent survive deferred responses and narrow rejection", async () => {
    const finishes: Array<
      (state: { status: "success" | "error"; message: string }) => void
    > = [];
    const writes: string[] = [];
    const deferred =
      (kind: string) => async (_state: unknown, form: FormData) => {
        writes.push(`${kind}:${form.get("itemId")}`);
        return new Promise<{ status: "success" | "error"; message: string }>(
          (resolve) => finishes.push(resolve),
        );
      };
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={["Projector", "Cable"].map((title) => ({
              id: title.toLowerCase(),
              title,
              archivedAt: "",
              containerLabel: "Unplaced",
              containerReferenceId: null,
            }))}
            query=""
            returnTo="/inventory/archive"
            restoreAction={deferred("restore")}
            archiveAction={deferred("archive")}
          />
        </ChakraTestWrapper>,
      );
    });
    const restoreStarted = performance.now();
    await clickButton("Restore");
    const restoreRenderMs = performance.now() - restoreStarted;
    expect(container.textContent?.includes("Projector")).toBe(false);
    const undoStarted = performance.now();
    await clickButton("Undo");
    console.info(
      `Deferred archive interaction: restore render ${restoreRenderMs.toFixed(1)} ms; Undo render ${(performance.now() - undoStarted).toFixed(1)} ms; network still unresolved.`,
    );
    expect(container.textContent?.includes("Projector")).toBe(true);
    await clickButton("Redo");
    expect(container.textContent?.includes("Projector")).toBe(false);
    await clickButton("Restore");
    expect(container.textContent?.includes("Cable")).toBe(false);
    expect(writes).toEqual(["restore:projector", "restore:cable"]);
    await clickButton("Undo");
    expect(container.textContent?.includes("Cable")).toBe(true);
    await act(async () => {
      finishes[1]!({ status: "success", message: "" });
    });
    expect(writes).toEqual([
      "restore:projector",
      "restore:cable",
      "archive:cable",
    ]);
    expect(container.textContent?.includes("Cable")).toBe(true);
    await act(async () => {
      finishes[0]!({ status: "error", message: "Projector restore rejected." });
    });
    expect(container.textContent?.includes("Projector")).toBe(true);
    expect(container.textContent?.includes("Cable")).toBe(true);
    await act(async () => {
      finishes[2]!({ status: "success", message: "" });
    });
    expect(writes).toHaveLength(3);
    expect(routerCalls.refresh).toBe(0);
  });

  test("ambiguous delivery retains history and retries the identical write before later Undo", async () => {
    const forms: FormData[] = [];
    const writes: string[] = [];
    let reject!: (error: Error) => void;
    let confirm!: (state: { status: "success"; message: string }) => void;
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={[
              {
                id: "projector",
                title: "Projector",
                archivedAt: "",
                containerLabel: "Unplaced",
                containerReferenceId: null,
              },
            ]}
            query=""
            returnTo="/inventory/archive"
            restoreAction={async (_state, form) => {
              forms.push(form);
              writes.push("restore");
              if (forms.length === 1)
                return new Promise((_resolve, fail) => {
                  reject = fail;
                });
              return new Promise((resolve) => {
                confirm = resolve;
              });
            }}
            archiveAction={async () => {
              writes.push("archive");
              return { status: "success", message: "" };
            }}
          />
        </ChakraTestWrapper>,
      );
    });
    await clickButton("Restore");
    await clickButton("Undo");
    await clickButton("Redo");
    await act(async () => {
      reject(new Error("Response lost after commit"));
    });
    expect(container.textContent).not.toContain("Projector");
    expect(container.textContent).toContain("Save unconfirmed");
    await clickButton("Undo");
    expect(container.textContent).toContain("Projector");
    expect(writes).toEqual(["restore"]);
    await clickButton("Retry unconfirmed saves");
    expect(forms[1]).toBe(forms[0]);
    await clickButton("Redo");
    await clickButton("Undo");
    expect(container.textContent).toContain("Projector");
    await act(async () => {
      confirm({ status: "success", message: "" });
    });
    expect(writes).toEqual(["restore", "restore", "archive"]);
    expect(container.textContent).toContain("Projector");
    await clickButton("Redo");
    expect(container.textContent).not.toContain("Projector");
    await act(async () => {
      confirm({ status: "success", message: "" });
    });
    expect(writes).toHaveLength(4);
  });

  test("new archive page hides stale rows, restores and exports until successful retry", async () => {
    const finishes: Array<(response: Response) => void> = [];
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return new Promise<Response>((resolve) => finishes.push(resolve));
      },
      { preconnect: originalFetch.preconnect },
    );
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={[
              {
                id: "old",
                title: "Old row",
                archivedAt: "",
                containerLabel: "Unplaced",
                containerReferenceId: null,
              },
            ]}
            total={48}
            nextCursor="second"
            query=""
            returnTo="/inventory/archive"
            restoreAction={async () => ({ status: "success", message: "" })}
          />
        </ChakraTestWrapper>,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!
        .click();
    });
    function unavailable() {
      expect(container.textContent).not.toContain("Old row");
      expect(
        [...container.querySelectorAll("button")].some(
          (b) => b.textContent?.trim() === "Restore",
        ),
      ).toBe(false);
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!
          .disabled,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Download"]',
        )!.disabled,
      ).toBe(true);
    }
    unavailable();
    expect(container.textContent).toContain("Loading archived items");
    await act(async () => {
      finishes[0]!(Response.json({ message: "Unavailable" }, { status: 503 }));
    });
    unavailable();
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).not.toContain("Loading archived items");
    await clickButton("Retry");
    unavailable();
    await act(async () => {
      finishes[1]!(
        Response.json({
          items: [
            { id: "new", title: "New row", placements: [], archivedAt: "" },
          ],
          total: 48,
          pageInfo: { nextCursor: null },
        }),
      );
    });
    expect(container.textContent).toContain("New row");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!
        .disabled,
    ).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
  });

  test("archive reload, search/filter reset and back/forward stay URL-backed with one read per page", async () => {
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        requests.push(String(input));
        return Response.json({
          items: [
            {
              id: "result",
              title: "Fetched archive",
              placements: [],
              archivedAt: "",
            },
          ],
          pageInfo: { nextCursor: "next-cursor" },
          total: 240,
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    window.history.replaceState(
      null,
      "",
      "/inventory/archive?q=projector&category=technology&status=KEEP&page=5&cursor=reload-cursor",
    );
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <InventoryArchiveList
            items={[
              {
                id: "initial",
                title: "Reloaded archive",
                archivedAt: "",
                containerLabel: "Unplaced",
                containerReferenceId: null,
              },
            ]}
            query="projector"
            returnTo="/inventory/archive"
            total={240}
            nextCursor="next-cursor"
            restoreAction={async () => ({ status: "success", message: "" })}
          />
        </ChakraTestWrapper>,
      );
    });
    expect(requests).toHaveLength(0);
    expect(
      container.querySelector('a[href*="returnTo="]')?.getAttribute("href"),
    ).toContain("page%3D5%26cursor%3Dreload-cursor");
    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next page"]',
    )!;
    await act(async () => {
      next.click();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("archived=true");
    expect(requests[0]).toContain("cursor=next-cursor");
    expect(requests[0]).not.toContain("limit=all");
    for (const direction of ["back", "forward"] as const) {
      await act(async () => {
        window.history[direction]();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(requests).toHaveLength(3);
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search archived inventory"]',
    )!;
    jest.useFakeTimers();
    for (const value of ["c", "ca", "cable"]) {
      await act(async () => {
        const propsKey = Object.keys(input).find((key) =>
          key.startsWith("__reactProps$"),
        )!;
        (
          input as unknown as Record<
            string,
            { onChange: (event: unknown) => void }
          >
        )[propsKey]!.onChange({ target: { value } });
      });
    }
    expect(requests).toHaveLength(3);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    jest.useRealTimers();
    expect(requests).toHaveLength(4);
    expect(window.location.search).toBe(
      "?q=cable&category=technology&status=KEEP",
    );
    expect(requests[3]).toContain("category=technology");
    expect(requests[3]).toContain("status=KEEP");
    expect(requests[3]).not.toContain("cursor=");
  });

  async function clickButton(text: string) {
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.trim() === text);

    if (!button) {
      throw new Error(`Missing ${text} button`);
    }

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  }
});

function registerDomGlobals(): () => void {
  const window = new Window({
    url: "http://localhost/inventory/archive?q=projector",
  });
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    FormData: globalThis.FormData,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
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
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
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
