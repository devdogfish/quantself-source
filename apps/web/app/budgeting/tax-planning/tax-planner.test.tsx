import { afterEach, expect, mock, test } from "bun:test";
import { createTestDom } from "@/components/shared/test-dom";
import { act } from "react";
import { sampleTaxPlan } from "./tax-plan.fixture";
import type { TaxYearPlan } from "./tax-model";

mock.module("next/navigation", () => ({ usePathname: () => "/budgeting/tax-planning" }));
mock.module("@/components/shared/filter-select", () => ({
  FilterSelect: ({ label, value, onChange, items }: {
    label: string; value: string; onChange: (year: string) => void;
    items: { value: string; label: string }[];
  }) => (
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ),
}));

const dom = createTestDom();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("loads one plan per year, keeps switches local and ignores an obsolete response", async () => {
  const calls: { path: string; signal?: AbortSignal | null; finish: (response: Response) => void }[] = [];
  globalThis.fetch = ((url: string, options?: RequestInit) =>
    new Promise<Response>(finish => calls.push({ path: url, signal: options?.signal, finish }))) as typeof fetch;
  const { TaxPlanner } = await import("./tax-planner");

  await dom.render(<TaxPlanner />);
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Tax year"]')!;
  const current = Number(select.value);
  const path = (year: number) => `/api/v1/budgeting/tax-planning?year=${year}`;
  const choose = (year: number) => act(async () => {
    select.value = String(year);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const finish = (index: number, response: Response) => act(async () => calls[index].finish(response));
  const displayed = () => dom.container.textContent;
  expect(calls.map(call => call.path)).toEqual([path(current)]);
  expect(displayed()).toContain("Loading tax plan");
  await finish(0, Response.json({ ...sampleTaxPlan, year: current }));
  expect(displayed()).toContain("Refund $1,285");
  expect(displayed()).toContain(`vs ${current - 1}`);

  await dom.click(dom.container.querySelector('[aria-label="Server hardware"]')!);
  expect(displayed()).toContain("Refund $574");
  expect(calls).toHaveLength(1);

  await choose(current - 1);
  expect(displayed()).toContain("Loading tax plan");
  await choose(current - 2);
  expect(calls.map(call => call.path)).toEqual([path(current), path(current - 1), path(current - 2)]);
  expect(calls[1].signal?.aborted).toBe(true);
  await finish(1, Response.json({ ...sampleTaxPlan, year: current - 1 }));
  expect(displayed()).toContain("Loading tax plan");
  await finish(2, Response.json({ message: "Service unavailable" }, { status: 503 }));
  expect(displayed()).toContain("Service unavailable");

  await dom.click([...dom.container.querySelectorAll("button")].find(button => button.textContent === "Retry")!);
  expect(calls.map(call => call.path)).toEqual([path(current), path(current - 1), path(current - 2), path(current - 2)]);
  expect(displayed()).toContain("Loading tax plan");
  const emptyPlan: TaxYearPlan = {
    year: current - 2, rules: sampleTaxPlan.rules, income: [], withheld: [], claims: [], items: [], documentsToGather: [],
  };
  await finish(3, Response.json(emptyPlan));
  expect(displayed()).toContain("No items match.");
  expect(displayed()).not.toContain("vs ");
});

test("links carry transaction filters and use real document, subscription, and inventory targets", async () => {
  const { linkHref } = await import("./tax-table");
  expect(linkHref({ kind: "transactions", label: "Hosting", search: "hosting & software" }, 2026))
    .toBe("/budgeting/transactions?q=hosting+%26+software&from=2026-01-01&to=2026-12-31");
  expect(linkHref({ kind: "document", label: "Receipt", id: "receipt/1" }, 2026)).toBe("/budgeting/documents?id=receipt%2F1");
  expect(linkHref({ kind: "subscription", label: "Hosting plan", id: "rate/1" }, 2026)).toBe("/budgeting/subscriptions?id=rate%2F1");
  expect(linkHref({ kind: "inventoryItem", label: "Server", id: "item/1" }, 2026)).toBe("/inventory/items/item%2F1");
  expect(linkHref({ kind: "inventoryItem", label: "Server" }, 2026)).toBe("/inventory/browse");
});

test("CSV export escapes API text in both tabs", async () => {
  const { TaxTable } = await import("./tax-table");
  const item = {
    ...sampleTaxPlan.items[0],
    title: 'Consulting, "March"\ncontract',
    links: [{ kind: "document" as const, label: 'Invoice "0042"' }],
  };
  const plan = {
    ...sampleTaxPlan,
    items: [item],
    documentsToGather: [{
      ...sampleTaxPlan.documentsToGather[0],
      itemId: item.id,
      name: 'Copy, "signed"',
      where: "=Archive",
    }],
  };
  const writeText = mock(async (_text: string) => {});
  const originalWriteText = navigator.clipboard.writeText;
  navigator.clipboard.writeText = writeText;
  try {
    await dom.render(<TaxTable plan={plan} on={new Set()} impact={() => 0} />);
    await dom.click(dom.container.querySelector('[aria-label="Copy"]')!);
    expect(writeText.mock.calls[0][0]).toBe(
      'Item,Type,Amount CAD,In plan,Linked\n"Consulting, ""March""\ncontract",Income,38400.00,,"Invoice ""0042"""',
    );
    const gatherTab = dom.container.querySelector('input[value="gather"]')!;
    await dom.click(gatherTab);
    await dom.click(dom.container.querySelector('[aria-label="Copied"]')!);
    expect(writeText.mock.calls[1][0]).toBe(
      'Document,For,Where,Needed by,Status\n"Copy, ""signed""","Consulting, ""March""\ncontract","\'=Archive",2026-12-31,To gather',
    );
  } finally {
    navigator.clipboard.writeText = originalWriteText;
  }
});
