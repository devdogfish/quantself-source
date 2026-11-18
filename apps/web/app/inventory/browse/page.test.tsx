import { ChakraTestWrapper } from "@/components/chakra/test-utils";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { renderToReadableStream } from "react-dom/server.edge";
import type { ReactNode } from "react";
import { mapInventoryShellItem } from "../inventory-shell-item-mapper";

mock.module("../inventory-shell-api-data", () => ({ mapInventoryShellItem }));

const inputs: unknown[] = [];
let containerReads = 0;
let unauthorized = false;
let search = "";
mock.module("@/lib/quantself-api-client", () => ({
  isApiAuthenticationError: (error: unknown) =>
    error instanceof Error && error.message === "Unauthorized",
  listInventoryItemsPage: async (input: unknown) => {
    inputs.push(input);
    if (unauthorized) throw new Error("Unauthorized");
    return {
      items: [],
      pageInfo: { nextCursor: "following-page" },
      total: 240,
    };
  },
  listInventoryContainers: async () => {
    containerReads++;
    return [];
  },
}));
mock.module("next/navigation", () => ({
  usePathname: () => "/inventory/browse",
  useSearchParams: () => new URLSearchParams(search),
  redirect: (href: string) => {
    throw new Error(`Redirect:${href}`);
  },
}));
mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
beforeEach(() => {
  inputs.length = 0;
  containerReads = 0;
  unauthorized = false;
  search = "";
});
afterAll(() => mock.restore());

async function render(params: Record<string, string> = {}) {
  search = new URLSearchParams(params).toString();
  const { default: Page } = await import("./page");
  const node = Page({ searchParams: Promise.resolve(params) });
  let failure: unknown;
  const stream = await renderToReadableStream(
    <ChakraTestWrapper>{node}</ChakraTestWrapper>,
    {
      onError: (cause) => {
        failure = cause;
      },
    },
  );
  await stream.allReady;
  if (failure) throw failure;
  return new Response(stream).text();
}

test("browse server reads only the requested page plus container options, independent of total/page", async () => {
  await render({
    q: "travel",
    category: "documents",
    status: "KEEP",
    page: "9",
    cursor: "page-nine",
  });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({
    query: "travel",
    category: "documents",
    status: "KEEP",
    cursor: "page-nine",
  });
  expect(inputs[0]).not.toHaveProperty("limit");
  expect(containerReads).toBe(1);
});

test("browse propagates an unauthenticated API response", async () => {
  unauthorized = true;
  await expect(
    render({ q: "travel", page: "2", cursor: "later" }),
  ).rejects.toThrow(
    "Unauthorized",
  );
  expect(inputs).toHaveLength(1);
  expect(containerReads).toBe(1);
});

test("retired history route still redirects to browse", async () => {
  const { default: History } = await import("../history/page");
  expect(() => History()).toThrow("Redirect:/inventory/browse");
});
