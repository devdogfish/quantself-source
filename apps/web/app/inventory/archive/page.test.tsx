import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";

let inventoryItemsStatus = 200;
let inventoryItemsResponse: {
  items: Array<{
    archivedAt: string | null;
    id: string;
    imageId: string | null;
    placements: Array<{
      label: string;
      quantity: number;
    }>;
    title: string;
    totalQuantity: number;
  }>;
} = {
  items: [],
};
const archivedInputs: unknown[] = [];
let lastArchivedQuery: string | null = null;

mock.module("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

mock.module("@/lib/quantself-api-client", () => ({
  getActiveInventoryCaptureSession: async () => null,
  isApiAuthenticationError: (error: unknown) =>
    Boolean(
      error &&
      typeof error === "object" &&
      "status" in error &&
      (error as { status: number }).status === 401,
    ),
  listActiveInventoryItems: async () => inventoryItemsResponse.items,
  listInventoryItemsPage: async (input: {
    query?: string | null;
    archived?: boolean;
    cursor?: string | null;
    category?: string | null;
    status?: string | null;
    limit?: string;
  }) => {
    lastArchivedQuery = input.query ?? null;
    archivedInputs.push(input);

    if (inventoryItemsStatus === 401) {
      const error = new Error("Authentication required.") as Error & {
        status: number;
      };
      error.status = 401;
      throw error;
    }

    return {
      ...inventoryItemsResponse,
      pageInfo: { nextCursor: "next-archive" },
      total: 72,
    };
  },
  listInventoryContainers: async () => [],
  listInventoryContainerVisuals: async () => ({
    editableVisuals: [],
    visualPresets: [],
  }),
  isApiNotFoundError: () => false,
  listInventoryItems: async () => inventoryItemsResponse.items,
  resolveInventoryContainerByReference: async () => ({ id: "container-1" }),
}));

mock.module("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  usePathname: () => "/inventory/archive",
  useRouter: () => ({
    push() {},
    replace() {},
    refresh() {},
  }),
  useSearchParams: () => new URLSearchParams("q=projector"),
}));

mock.module("../actions", () => ({
  archiveInventoryItemAction: async () => ({ message: "", status: "idle" }),
  restoreInventoryItemAction: async () => ({ message: "", status: "idle" }),
}));

afterEach(() => {
  inventoryItemsStatus = 200;
  inventoryItemsResponse = { items: [] };
  lastArchivedQuery = null;
  archivedInputs.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe("inventory archive page", () => {
  test("lists archived items through the API seam and preserves the search query", async () => {
    inventoryItemsResponse = {
      items: [
        {
          archivedAt: "2026-07-26T12:00:00.000Z",
          id: "item-projector",
          imageId: null,
          placements: [{ label: "Basement tote", quantity: 1 }],
          title: "Projector",
          totalQuantity: 1,
        },
      ],
    };

    const { default: InventoryArchivePage } = await import("./page");
    const html = await renderStream(
      InventoryArchivePage({
        searchParams: Promise.resolve({ q: "projector" }),
      }),
    );

    expect(lastArchivedQuery).toBe("projector");
    expect(archivedInputs).toEqual([
      {
        archived: true,
        query: "projector",
        category: null,
        status: null,
        cursor: null,
      },
    ]);
    expect(html).toContain('value="projector"');
    expect(html).toContain("Projector");
    expect(html).toContain("Basement tote");
    expect(html).toContain(
      'href="/inventory/items/item-projector?returnTo=%2Finventory%2Farchive%3Fq%3Dprojector"',
    );
  });

  test("loads only the requested archive cursor with server search and filters", async () => {
    const { default: InventoryArchivePage } = await import("./page");
    await renderStream(
      InventoryArchivePage({
        searchParams: Promise.resolve({
          q: "projector",
          category: "technology",
          status: "KEEP",
          page: "4",
          cursor: "archive-page-4",
        }),
      }),
    );
    expect(archivedInputs).toEqual([
      {
        archived: true,
        query: "projector",
        category: "technology",
        status: "KEEP",
        cursor: "archive-page-4",
      },
    ]);
  });

  test("propagates an unauthenticated archive response", async () => {
    inventoryItemsStatus = 401;

    const { default: InventoryArchivePage } = await import("./page");

    await expect(renderStream(InventoryArchivePage({}))).rejects.toThrow(
      "Authentication required.",
    );

  });
});

async function renderStream(node: ReactNode): Promise<string> {
  let renderError: unknown;
  const stream = await renderToReadableStream(
    <ChakraTestWrapper>{node}</ChakraTestWrapper>,
    {
      onError(error) {
        renderError ??= error;
      },
    },
  );
  await stream.allReady;
  if (renderError) {
    throw renderError;
  }

  return new Response(stream).text();
}
