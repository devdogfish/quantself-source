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
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { inventoryShellItems } from "../inventory-shell-data";

const routerReplaceCalls: string[] = [];
const intersectionObservers: TestIntersectionObserver[] = [];
const originalFetch = globalThis.fetch;
let currentSearchParams = new URLSearchParams();

mock.module("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirected to ${href}`);
  },
  usePathname: () => "/inventory/browse",
  useRouter: () => ({
    replace: (href: string) => {
      routerReplaceCalls.push(href);
    },
  }),
  useSearchParams: () => currentSearchParams,
}));

let InventoryBrowse: typeof import("./inventory-browse").InventoryBrowse;

describe("inventory browse search", () => {
  let cleanupGlobals: (() => void) | null = null;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanupGlobals = registerDomGlobals();
    ({ InventoryBrowse } = await import("./inventory-browse"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getActEnvironment().IS_REACT_ACT_ENVIRONMENT = true;
    currentSearchParams = new URLSearchParams();
    routerReplaceCalls.length = 0;
    intersectionObservers.length = 0;
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        items: [],
        pageInfo: { nextCursor: null },
        total: 0,
      }),
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    cleanupGlobals?.();
    cleanupGlobals = null;
    globalThis.fetch = originalFetch;
    delete getActEnvironment().IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => {
    mock.restore();
  });

  async function renderBrowse(
    nextCursor: string | null = "cursor-1",
    items = [inventoryShellItems[0]!],
  ) {
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <StrictMode>
            <InventoryBrowse
              containerOptions={[]}
              initialContainerId=""
              items={items}
              nextCursor={nextCursor}
              total={240}
            />
          </StrictMode>
        </ChakraTestWrapper>,
      );
    });
  }

  test("previews audio from the title and keyboard focus without playing on other cells", async () => {
    const fetch = mock(async () => Response.json({}));
    globalThis.fetch = mockFetch(fetch);
    await renderBrowse(null, [
      {
        ...inventoryShellItems[0]!,
        id: "audio-item",
        title: "Voice capture",
        images: [],
        videoId: null,
        evidence: [{ id: "voice-1", kind: "voice", label: "Voice", summary: "" }],
      },
    ]);
    const row = container.querySelector<HTMLTableRowElement>("tbody tr")!;
    const link = row.querySelector("a")!;
    const title = link.querySelector("span")!;
    const location = row.cells[1]!;
    const audio = container.querySelector("audio")!;
    let paused = true;
    const play = mock(async () => {
      paused = false;
    });
    const pause = mock(() => {
      paused = true;
    });
    Object.defineProperties(audio, {
      paused: { configurable: true, get: () => paused },
      play: { configurable: true, value: play },
      pause: { configurable: true, value: pause },
    });

    async function hover(target: Element, event: "mouseover" | "mouseout") {
      await act(async () => {
        target.dispatchEvent(
          new window.MouseEvent(event, {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
    }

    await hover(location, "mouseover");
    await hover(link, "mouseover");
    expect(play).not.toHaveBeenCalled();
    await hover(title, "mouseover");
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).toContain("/media/voice-1");
    await hover(title, "mouseout");
    expect(pause).toHaveBeenCalledTimes(1);

    await act(async () => link.focus());
    expect(play).toHaveBeenCalledTimes(2);
    await act(async () => link.blur());
    expect(pause).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exports the matching Browse filters in one click-only request without a page cursor", async () => {
    const writeText = mock(async (_value: string) => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText } });
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requests.push(String(input));
      return Response.json({ items: [{ id: "from-page-one" }, { id: "from-page-two" }] });
    });
    currentSearchParams = new URLSearchParams(
      "q=pouch&category=technology&status=KEEP&containerId=tote&page=2&cursor=second",
    );
    window.history.replaceState(null, "", `/inventory/browse?${currentSearchParams}`);
    await renderBrowse(null);
    expect(requests).toHaveLength(0);
    await click("Copy");
    expect(writeText).toHaveBeenCalledWith("from-page-one\nfrom-page-two");
    expect(requests).toHaveLength(1);
    const request = new URL(requests[0]!, "http://localhost");
    expect(request.pathname).toBe("/api/v1/inventory-items/export");
    expect(Object.fromEntries(request.searchParams)).toEqual({
      category: "technology", containerId: "tote", q: "pouch", status: "KEEP", includeUnready: "false",
    });
  });
  function button(label: string) {
    const result =
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      ) ??
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (el) => el.textContent === label,
      );
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  }
  async function click(label: string) {
    await act(async () => {
      button(label).click();
    });
  }
  function searchInput() {
    return container.querySelector<HTMLInputElement>(
      'input[aria-label="Search inventory"]',
    )!;
  }

  test("debounces rapid typing into one bounded URL-backed request", async () => {
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requests.push(String(input));
      return Response.json({
        items: [],
        pageInfo: { nextCursor: null },
        total: 0,
      });
    });
    await renderBrowse();
    expect(requests).toHaveLength(0);
    jest.useFakeTimers();
    for (const query of ["p", "pa", "passport"])
      await setSearchInput(searchInput(), query);
    expect(searchInput().value).toBe("passport");
    expect(requests).toHaveLength(0);
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    jest.useRealTimers();
    expect(window.location.search).toBe("?q=passport");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("q=passport");
    expect(requests[0]).not.toContain("limit=all");
  });

  test("uses one continuation read, URL cursor and return-to, without fetching unseen pages", async () => {
    const requests: string[] = [];
    let finish!: (response: Response) => void;
    globalThis.fetch = mockFetch(async (input) => {
      requests.push(String(input));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const mountStarted = performance.now();
    await renderBrowse();
    const mountMs = performance.now() - mountStarted;
    const table = container.querySelector('table[aria-label="Inventory items"]')!;
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(
      ["Item", "Location", "Status", "Evidence"],
    );
    expect(table.querySelector("tbody tr a")?.textContent).toBe(inventoryShellItems[0]!.title);
    expect(requests).toHaveLength(0);
    const pageStarted = performance.now();
    await click("Next page");
    const pendingRenderMs = performance.now() - pageStarted;
    expect(container.querySelector('button[aria-label="Next page"]')).toBeNull();
    expect(container.textContent).not.toContain(inventoryShellItems[0]!.title);
    expect(button("Copy").disabled).toBe(true);
    expect(button("Download").disabled).toBe(true);
    console.info(
      `Browse fixture: initial hydrated render ${mountMs.toFixed(1)} ms, 0 browser reads; warm page loading feedback ${pendingRenderMs.toFixed(1)} ms, 1 unresolved read.`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("cursor=cursor-1");
    expect(window.location.search).toBe("?page=2&cursor=cursor-1");
    expect(container.textContent?.includes("Loading items…")).toBe(true);
    await act(async () => {
      finish(
        Response.json({
          items: [apiInventoryItem("Page two", "page-two")],
          pageInfo: { nextCursor: "cursor-2" },
          total: 72,
        }),
      );
    });
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href*="page-two?returnTo="]',
    )!;
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain(
      "returnTo=/inventory/browse?page=2&cursor=cursor-1",
    );
    expect(container.textContent?.includes(inventoryShellItems[0]!.title)).toBe(
      false,
    );
    expect(requests).toHaveLength(1);
  });

  test("reloads a later page from its server result without a browser reread", async () => {
    currentSearchParams = new URLSearchParams(
      "q=travel&category=documents&page=7&cursor=shared-cursor",
    );
    window.history.replaceState(
      null,
      "",
      `/inventory/browse?${currentSearchParams}`,
    );
    window.sessionStorage.setItem(
      `quantself:inventory-panel:/inventory/browse?${currentSearchParams}`,
      JSON.stringify({
        filterKey: "q=travel&category=documents",
        scrollY: 480,
        cursors: [
          [1, null],
          [6, "previous-cursor"],
          [7, "shared-cursor"],
        ],
      }),
    );
    const scroll = mock(() => {});
    window.scrollTo = scroll;
    let reads = 0;
    globalThis.fetch = mockFetch(async () => {
      reads++;
      throw new Error("Unexpected reread");
    });
    await renderBrowse(null);
    expect(searchInput().value).toBe("travel");
    expect(
      container.querySelector('a[href*="returnTo="]')?.getAttribute("href"),
    ).toContain("page%3D7%26cursor%3Dshared-cursor");
    expect(reads).toBe(0);
    expect(scroll).toHaveBeenCalledWith({ top: 480, behavior: "auto" });
    expect(button("Previous page").disabled).toBe(false);
    expect(button("Next page").disabled).toBe(true);
  });

  test("back and forward reread exactly their URL cursor, not preceding pages", async () => {
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requests.push(String(input));
      const later = String(input).includes("cursor=cursor-1");
      return Response.json({
        items: [
          apiInventoryItem(later ? "Later page" : "First page", "result"),
        ],
        pageInfo: { nextCursor: later ? null : "cursor-1" },
        total: 48,
      });
    });
    await renderBrowse();
    await click("Next page");
    for (const direction of ["back", "forward"] as const) {
      await act(async () => {
        window.history[direction]();
        await wait(0);
      });
      expect(
        container.textContent?.includes(
          direction === "forward" ? "Later page" : "First page",
        ),
      ).toBe(true);
    }
    expect(requests).toHaveLength(3);
    expect(
      requests.map((url) =>
        new URL(url, "http://localhost").searchParams.get("cursor"),
      ),
    ).toEqual(["cursor-1", null, "cursor-1"]);
  });

  test("filter edits reset page/cursor and stale responses cannot replace later intent", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = mockFetch(
      async () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    currentSearchParams = new URLSearchParams("page=2&cursor=cursor-1");
    window.history.replaceState(
      null,
      "",
      `/inventory/browse?${currentSearchParams}`,
    );
    await renderBrowse();
    await setSearchInput(searchInput(), "first");
    await act(async () => {
      await wait(350);
    });
    expect(window.location.search).toBe("?q=first");
    await setSearchInput(searchInput(), "second");
    await act(async () => {
      await wait(350);
    });
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]!(
        Response.json({
          items: [apiInventoryItem("Current result", "current")],
          pageInfo: { nextCursor: null },
          total: 1,
        }),
      );
    });
    await act(async () => {
      resolvers[0]!(
        Response.json({
          items: [apiInventoryItem("Stale result", "stale")],
          pageInfo: { nextCursor: null },
          total: 1,
        }),
      );
    });
    expect(container.textContent?.includes("Current result")).toBe(true);
    expect(container.textContent?.includes("Stale result")).toBe(false);
  });

  test("failed page reads hide stale content and retry only that cursor", async () => {
    const requests: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requests.push(String(input));
      return requests.length === 1
        ? Response.json({ message: "Page unavailable." }, { status: 503 })
        : Response.json({
            items: [apiInventoryItem("Recovered", "recovered")],
            pageInfo: { nextCursor: null },
            total: 48,
          });
    });
    await renderBrowse();
    await click("Next page");
    expect(container.textContent).not.toContain(inventoryShellItems[0]!.title);
    expect(button("Copy").disabled).toBe(true);
    expect(button("Download").disabled).toBe(true);
    expect(container.textContent?.includes("Page unavailable.")).toBe(true);
    await click("Retry");
    expect(container.textContent?.includes("Recovered")).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
  });
});

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds = [0];

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.rootMargin = options?.rootMargin ?? "0px";
    intersectionObservers.push(this);
  }

  disconnect() {}

  intersect() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this,
    );
  }

  observe() {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve() {}
}

function registerDomGlobals(): () => void {
  const window = new Window({
    url: "http://localhost/inventory/browse",
  });
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    NodeFilter: globalThis.NodeFilter,
    MutationObserver: globalThis.MutationObserver,
    CustomEvent: globalThis.CustomEvent,
    DocumentFragment: globalThis.DocumentFragment,
    Element: globalThis.Element,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    IntersectionObserver: globalThis.IntersectionObserver,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    window: globalThis.window,
  };

  Object.assign(globalThis, {
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    HTMLSelectElement: window.HTMLSelectElement,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment,
    Element: window.Element,
    Event: window.Event,
    EventTarget: window.EventTarget,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    IntersectionObserver: TestIntersectionObserver,
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
    nativeEvent: { defaultPrevented: boolean };
    target: HTMLInputElement;
  }) => void;
} {
  return reactProps(input) as {
    onChange: (event: {
      currentTarget: HTMLInputElement;
      nativeEvent: { defaultPrevented: boolean };
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

  return (element as unknown as Record<string, Record<string, unknown>>)[
    propsKey
  ]!;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setSearchInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    reactInputProps(input).onChange({
      currentTarget: input,
      nativeEvent: { defaultPrevented: false },
      target: input,
    });
  });
}

function apiInventoryItem(title: string, id: string) {
  const timestamp = "2026-08-04T10:00:00.000Z";
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    captureText: null,
    capturedAt: timestamp,
    category: null,
    clothingProfile: null,
    containerId: null,
    containerLabel: null,
    costCents: null,
    costCurrency: "CAD",
    id,
    imageId: null,
    importance: "MEDIUM",
    kind: "ITEM",
    note: null,
    placementSummary: "Unplaced",
    placements: [],
    processing: {
      currentStep: "Complete",
      enrichment: {
        rationale: "Applied.",
        status: "APPLIED",
        summary: "Applied.",
        updatedAt: timestamp,
      },
      evidence: [],
      nextAction: "No action required",
      preprocessing: {
        failedSteps: [],
        mediaTexts: [],
        status: "COMPLETE",
        summary: "Complete.",
        textBundleAvailable: true,
        updatedAt: timestamp,
      },
      proposal: {
        status: "APPROVED",
        summary: "Approved.",
        updatedAt: timestamp,
      },
      sourceLabel: "Inventory capture",
    },
    remedyProfile: null,
    status: "KEEP",
    tags: [],
    title,
    totalQuantity: 1,
    where: "Unplaced",
  };
}

function mockFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}
