import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";

let params = new URLSearchParams();
mock.module("next/navigation", () => ({
  usePathname: () => "/budgeting/documents",
  useSearchParams: () => params,
  useRouter: () => ({ replace: () => {} }),
}));

const dom = createTestDom();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const receipt = {
  id: "38906710-6507-44be-8ed0-187fd11c77fe",
  kind: "invoice", date: "2026-03-14", mime: "image/png", title: "Private title",
  merchant: "Private merchant", currency: "USD", totalCents: 1000,
  transaction: { id: "transaction-id", date: "2026-03-15", totalCents: 1400, estimated: true },
  subscriptions: [{ id: "subscription-id", label: "Phone plan" }],
};
const metadata = {
  ...receipt, title: null, merchant: "", currency: null, totalCents: null, transaction: null, subscriptions: [],
};

function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(result).toBeDefined();
  return result!;
}

test("list and pagination use one request per action and hide private columns until reveal", async () => {
  params = new URLSearchParams();
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string) => {
    requests.push(input);
    return Response.json({
      documents: { rows: input.includes("page=2") ? [] : [input.includes("reveal=yes") ? receipt : metadata], total: 21, years: ["2026", "2024"] },
    });
  }) as unknown as typeof fetch;
  const { BudgetDocuments } = await import("./documents");
  await dom.render(<BudgetDocuments />);
  expect(requests).toEqual(["/api/v1/budgeting/receipts?page=1&years=yes"]);
  expect(dom.container.textContent).toContain("Private invoice");
  expect(dom.container.textContent).not.toContain("Private title");
  expect(dom.container.querySelector('a[href="/budgeting/receipts?upload=yes"]')).not.toBeNull();
  await dom.click(button("Reveal document details"));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("reveal=yes");
  expect(dom.container.textContent).toContain("Private title");
  expect(dom.container.textContent).toContain("≈CAD 14.00 · USD 10.00");
  await dom.click(button("Next page"));
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContain("page=2");
  expect(dom.container.textContent).toContain("No documents match.");
});

test("deep-linked drawer aborts a delayed reveal; completed reveal loads one original shared by preview and download", async () => {
  params = new URLSearchParams({ id: receipt.id });
  const requests: { url: string; signal: AbortSignal }[] = [];
  let finishReveal: (response: Response) => void = () => {};
  globalThis.fetch = mock((url: string, { signal }: { signal: AbortSignal }) => {
    requests.push({ url, signal });
    if (url.endsWith("/original")) return Promise.resolve(new Response(new Blob(["original"], { type: "image/png" })));
    if (url.includes("view=documents")) {
      if (url.includes("reveal=yes")) return new Promise<Response>(resolve => { finishReveal = resolve; });
      return Promise.resolve(Response.json({ document: metadata }));
    }
    return Promise.resolve(Response.json({ documents: { rows: [], total: 0, years: [] } }));
  }) as unknown as typeof fetch;
  const { BudgetDocuments } = await import("./documents");
  await dom.render(<BudgetDocuments />);
  expect(requests).toHaveLength(2);
  expect(document.body.textContent).toContain("Document content is hidden.");
  await dom.click(button("Reveal document"));
  const deferred = requests.find(request => request.url.includes("reveal=yes"))!;
  await dom.click(button("Hide document"));
  expect(deferred.signal.aborted).toBe(true);
  await act(async () => finishReveal(Response.json({ document: receipt })));
  expect(document.body.textContent).not.toContain("Private title");
  expect(requests.some(request => request.url.endsWith("/original"))).toBe(false);

  await dom.click(button("Reveal document"));
  await act(async () => finishReveal(Response.json({ document: receipt })));
  expect(requests.filter(request => request.url.endsWith("/original"))).toHaveLength(1);
  expect(document.querySelector('a[href="/budgeting/transactions?id=transaction-id"]')).not.toBeNull();
  expect(document.querySelector('a[href="/budgeting/subscriptions?id=subscription-id"]')).not.toBeNull();
  const preview = document.querySelector('img[alt="Original document"]');
  const download = document.querySelector('a[download="document.png"]');
  expect(preview?.getAttribute("src")).toStartWith("blob:");
  expect(download?.getAttribute("href")).toBe(preview?.getAttribute("src"));
  await dom.click(button("Hide document"));
  expect(document.querySelector('a[download="document.png"]')).toBeNull();
  expect(document.querySelector('img[alt="Original document"]')).toBeNull();
});

test("debounces search, exports the active filter, and aborts that export on hide", async () => {
  params = new URLSearchParams();
  const requests: string[] = [];
  let finishExport!: (response: Response) => void;
  let exportSignal: AbortSignal | null | undefined;
  globalThis.fetch = mock(async (url: string, options: RequestInit) => {
    requests.push(url);
    if (url.includes("/export?")) {
      exportSignal = options.signal;
      return new Promise<Response>(resolve => { finishExport = resolve; });
    }
    return Response.json({ documents: { rows: [metadata], total: 21, years: ["2026"] } });
  }) as unknown as typeof fetch;
  const { BudgetDocuments } = await import("./documents");
  await dom.render(<BudgetDocuments />);
  await dom.click(button("Reveal document details"));
  await dom.click(button("Next page"));
  const search = dom.container.querySelector<HTMLInputElement>('input[aria-label="Search title, company or amount"]')!;
  await dom.type(search, "sh");
  await dom.type(search, "shop");
  expect(requests).toHaveLength(3);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 270)); });
  expect(requests).toHaveLength(4);
  expect(requests[3]).toContain("q=shop&page=1");
  await dom.click(button("Download"));
  expect(requests).toHaveLength(5);
  expect(requests[4]).toBe("/api/v1/budgeting/receipts/export?reveal=yes&q=shop&format=documents");
  await dom.click(button("Hide document details"));
  expect(exportSignal?.aborted).toBe(true);
  expect(requests[5]).toBe("/api/v1/budgeting/receipts?page=1&years=yes");
  const createObjectURL = URL.createObjectURL;
  const download = mock(() => "blob:unexpected");
  URL.createObjectURL = download;
  try {
    await act(async () => finishExport(Response.json({ documents: [receipt] })));
    expect(download).not.toHaveBeenCalled();
  } finally {
    URL.createObjectURL = createObjectURL;
  }
});
