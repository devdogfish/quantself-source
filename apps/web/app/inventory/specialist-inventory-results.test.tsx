import "@/components/shared/dom-env";
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
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowserInventoryItem } from "@/lib/quantself-api-browser";

const observers: TestIntersectionObserver[] = [];
const originalFetch = globalThis.fetch;

mock.module("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let SpecialistInventoryResults: typeof import("./specialist-inventory-results").SpecialistInventoryResults;

describe("specialist inventory continuation", () => {
  let cleanup: (() => void) | undefined;
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    cleanup = registerDom();
    ({ SpecialistInventoryResults } =
      await import("./specialist-inventory-results"));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    observers.length = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    cleanup?.();
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  afterAll(() => mock.restore());

  test("appends a server-filtered continuation and preserves the first batch", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({
        items: [item("Second supplement", "supplement-2")],
        pageInfo: { nextCursor: null },
        total: 2,
      });
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <SpecialistInventoryResults
            category="supplement"
            emptyLabel="supplement"
            filterKey="/inventory/supplements"
            initialItems={[item("First supplement", "supplement-1")]}
            initialNextCursor="cursor-1"
            initialTotal={2}
            query=""
            returnTo="/inventory/supplements"
          />
        </ChakraTestWrapper>,
      );
    });
    const observer = observers.at(-1);
    if (!observer) throw new Error("Missing continuation observer");

    await act(async () => {
      observer.intersect();
      await Promise.resolve();
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("category=supplement");
    expect(requests[0]).toContain("cursor=cursor-1");
    expect(container.textContent).toContain("First supplement");
    expect(container.textContent).toContain("Second supplement");
    expect(container.textContent).toContain("2 items");
  });

  test("keeps specialist results visible when a later page fails and retries", async () => {
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      return requests === 1
        ? Response.json(
            { message: "Later supplements unavailable." },
            { status: 503 },
          )
        : Response.json({
            items: [item("Recovered supplement", "supplement-recovered")],
            pageInfo: { nextCursor: null },
            total: 2,
          });
    }) as unknown as typeof fetch;

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <SpecialistInventoryResults
            category="supplement"
            emptyLabel="supplement"
            filterKey="/inventory/supplements"
            initialItems={[item("First supplement", "supplement-1")]}
            initialNextCursor="cursor-1"
            initialTotal={2}
            query=""
            returnTo="/inventory/supplements"
          />
        </ChakraTestWrapper>,
      );
    });
    const observer = observers.at(-1);
    if (!observer) throw new Error("Missing continuation observer");
    await act(async () => {
      observer.intersect();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("First supplement");
    expect(container.textContent).toContain("Later supplements unavailable.");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    if (!retry) throw new Error("Missing continuation retry");
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(requests).toBe(2);
    expect(container.textContent).toContain("First supplement");
    expect(container.textContent).toContain("Recovered supplement");
  });

  test("restores compatible batches and scroll in Strict Mode without refetching", async () => {
    let fetchRequests = 0;
    globalThis.fetch = mock(async () => {
      fetchRequests += 1;
      return Response.json({
        items: [],
        pageInfo: { nextCursor: null },
        total: 0,
      });
    }) as unknown as typeof fetch;
    window.history.replaceState(
      {
        "quantself:inventory-specialist": {
          filterKey: "/inventory/supplements",
          items: [item("Restored supplement", "supplement-restored")],
          nextCursor: null,
          scrollY: 640,
          total: 1,
        },
      },
      "",
    );
    const scrollTo = mock(() => {});
    window.scrollTo = scrollTo;

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <StrictMode>
            <SpecialistInventoryResults
              category="supplement"
              emptyLabel="supplement"
              filterKey="/inventory/supplements"
              initialItems={[item("Initial supplement", "supplement-initial")]}
              initialNextCursor={null}
              initialTotal={1}
              query=""
              returnTo="/inventory/supplements"
            />
          </StrictMode>
        </ChakraTestWrapper>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Restored supplement");
    expect(container.textContent).not.toContain("Initial supplement");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 640 });
    expect(fetchRequests).toBe(0);
  });

  test("discards an in-flight continuation when filters change", async () => {
    const continuation = deferred<Response>();
    globalThis.fetch = mock(
      () => continuation.promise,
    ) as unknown as typeof fetch;

    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <SpecialistInventoryResults
            category="supplement"
            emptyLabel="supplement"
            filterKey="/inventory/supplements?q=old"
            initialItems={[item("Old result", "supplement-old")]}
            initialNextCursor="cursor-old"
            initialTotal={2}
            query="old"
            returnTo="/inventory/supplements?q=old"
          />
        </ChakraTestWrapper>,
      );
    });
    const observer = observers.at(-1);
    if (!observer) throw new Error("Missing continuation observer");

    await act(async () => observer.intersect());
    await act(async () => {
      root.render(
        <ChakraTestWrapper>
          <SpecialistInventoryResults
            category="supplement"
            emptyLabel="supplement"
            filterKey="/inventory/supplements?q=new"
            initialItems={[item("New result", "supplement-new")]}
            initialNextCursor={null}
            initialTotal={1}
            query="new"
            returnTo="/inventory/supplements?q=new"
          />
        </ChakraTestWrapper>,
      );
    });
    await act(async () => {
      continuation.resolve(
        Response.json({
          items: [item("Stale continuation", "supplement-stale")],
          pageInfo: { nextCursor: null },
          total: 2,
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("New result");
    expect(container.textContent).not.toContain("Old result");
    expect(container.textContent).not.toContain("Stale continuation");
  });
});

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "400px";
  readonly thresholds = [0];
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  disconnect() {}
  observe() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve() {}
  intersect() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this,
    );
  }
}

function registerDom() {
  const window = new Window({ url: "http://localhost/inventory/supplements" });
  const prior = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IntersectionObserver: globalThis.IntersectionObserver,
    Node: globalThis.Node,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: window.document,
    HTMLElement: window.HTMLElement,
    IntersectionObserver: TestIntersectionObserver,
    Node: window.Node,
    window,
  });
  return () => Object.assign(globalThis, prior);
}

function item(title: string, id: string): BrowserInventoryItem {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    captureText: null,
    capturedAt: "2026-08-02T09:00:00.000Z",
    category: "supplement" as const,
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
    placementSummary: "Total 1",
    placements: [],
    remedyProfile: null,
    processing: {
      currentStep: "Waiting",
      enrichment: {
        attempts: 0,
        failedAt: null,
        failureMessage: null,
        maxAttempts: 3,
        rationale: "",
        retryable: false,
        status: "NOT_STARTED",
        summary: "",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      evidence: [],
      history: [],
      nextAction: "Waiting",
      preprocessing: {
        attempts: 0,
        failedAt: null,
        failedSteps: [],
        failureMessage: null,
        maxAttempts: 3,
        mediaTexts: [],
        retryable: false,
        status: "CAPTURED",
        summary: "",
        textBundleAvailable: false,
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      proposal: {
        status: "NONE",
        summary: "",
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
      sourceLabel: "Inventory capture",
    },
    status: "KEEP",
    tags: [],
    title,
    totalQuantity: 1,
    where: "Unplaced",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
