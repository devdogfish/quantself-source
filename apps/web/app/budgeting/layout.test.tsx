import { expect, mock, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";
let pathname = "/budgeting/plan";
mock.module("next/navigation", () => ({ usePathname: () => pathname }));
const dom = createTestDom();

test("Existing Budgeting pages get the area tabs from the layout, with only the current page selected", async () => {
  const { default: Layout } = await import("./layout");
  for (const [path, current] of [
    ["/budgeting/plan", "/budgeting/plan"],
    ["/budgeting/receipts/123", "/budgeting/documents"],
  ] as const) {
    pathname = path;
    await dom.render(<Layout><p>Page content</p></Layout>);
    const nav = dom.container.querySelector('nav[aria-label="Budgeting"]')!;
    expect(nav.querySelectorAll("a")).toHaveLength(9);
    const selected = nav.querySelectorAll('[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.getAttribute("href")).toBe(current);
    expect(dom.container.textContent).toContain("Page content");
  }
});

test("Redesigned Budgeting pages render their own framed header, so the layout adds no tab row", async () => {
  const { default: Layout } = await import("./layout");
  for (const path of ["/budgeting", "/budgeting/log", "/budgeting/transactions", "/budgeting/subscriptions", "/budgeting/documents", "/budgeting/tax-planning"]) {
    pathname = path;
    await dom.render(<Layout><p>Page content</p></Layout>);
    expect(dom.container.querySelector('nav[aria-label="Budgeting"]')).toBeNull();
    expect(dom.container.textContent).toContain("Page content");
  }
});
