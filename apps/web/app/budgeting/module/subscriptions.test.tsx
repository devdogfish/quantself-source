import { expect, mock, test } from "bun:test";
import { act } from "react";
import type { Subscription } from "@quantself/budgeting";
import { createTestDom } from "@/components/shared/test-dom";

const id = "cc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
const oneOffId = "fc4e401d-74a1-4ec7-8b23-b1e97dbc0642";
let pathname = "/budgeting/subscriptions";
let query = `seg=bill&id=${id}`;
mock.module("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(query),
  useRouter: () => ({ replace: (href: string) => { query = new URL(href, "http://localhost").search; } }),
}));
const dom = createTestDom();

test("drawer reads one real rule list, keeps later actions and Undo visible during writes, and adds a rule", async () => {
  const { BudgetSubscriptions } = await import("./subscriptions");
  const { Toaster } = await import("@/components/chakra/toaster");
  const { BudgetingStubStore } = await import("./stub-store");
  const { BudgetTransactionProvider } = await import("./transaction-store");
  const screen = () => <BudgetTransactionProvider><BudgetingStubStore><BudgetSubscriptions /><Toaster /></BudgetingStubStore></BudgetTransactionProvider>;
  const item: Subscription = {
    id, name: "Rent", kind: "bill", category: "Housing", revision: 1, commandId: crypto.randomUUID(),
    status: "active", stopsOn: null, websiteUrl: null, cancelUrl: null, logoKey: null, estimated: false,
    terms: [{ startOn: "2026-11-15", effectiveOn: "2026-11-13", frequency: "monthly", interval: 1, amountCents: 100000 }],
    lastReviewed: null, documentId: id, sourceKey: null, evidence: "",
  };
  const previousFetch = globalThis.fetch;
  const previousFormData = globalThis.FormData;
  globalThis.FormData = window.FormData;
  let reads = 0;
  const writes: { id: string; input: { commandId: string; changes: Partial<Subscription>; revision: number }; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = mock(async (path: string, options?: RequestInit) => {
    if (options?.method === "PUT") {
      return new Promise<Response>(resolve => writes.push({ id: path.split("/").at(-1)!, input: JSON.parse(String(options.body)), resolve }));
    }
    expect(path).toBe("/api/v1/budgeting/subscriptions");
    reads++;
    return Response.json({
      today: "2026-11-13", items: [item], paidKeys: [],
      charges: { [id]: [{ id, date: "2026-11-01", cents: 112000 }] },
      oneOff: [{ id: oneOffId, name: "One-time power bill", date: "2026-11-25", kind: "bill", cents: 3000 }],
    });
  }) as unknown as typeof fetch;
  const button = (label: string) => Array.from(document.body.querySelectorAll("button")).find(node => node.textContent?.trim() === label)!;
  const settle = async (index: number) => {
    const { input, id: savedId, resolve } = writes[index];
    await act(async () => {
      resolve(Response.json({ ...item, ...input.changes, id: savedId, commandId: input.commandId, revision: input.revision + 1 }));
      await Bun.sleep(0);
    });
  };

  try {
    await dom.render(screen());
    expect(reads).toBe(1);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Rent");
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("$1,120.00");
    expect(document.body.querySelector(`a[href="/budgeting/documents?id=${id}"]`)).not.toBeNull();
    expect(document.body.querySelector(`a[href="/budgeting/transactions?subscriptionId=${id}"]`)).not.toBeNull();
    await dom.click(button("Pause"));
    expect(button("Resume")).toBeDefined();
    await dom.click(button("Still worth it"));
    expect(button("Reviewed")).toBeDefined();
    await dom.click(button("Cancelled"));
    expect(button("Reactivate")).toBeDefined();
    expect(writes).toHaveLength(1);
    const cancellationToast = Array.from(document.body.querySelectorAll("[data-part='root']"))
      .find(node => node.querySelector("[data-part='title']")?.textContent === "Rent marked cancelled");
    await dom.click(cancellationToast!.querySelector("button")!);
    expect(button("Resume")).toBeDefined();
    expect(button("Reviewed")).toBeDefined();
    for (let index = 0; index < 4; index++) await settle(index);
    expect(writes.map(write => write.input.revision)).toEqual([1, 2, 3, 4]);
    expect(button("Resume")).toBeDefined();
    expect(button("Reviewed")).toBeDefined();
    expect(reads).toBe(1);

    query = "seg=bill";
    await dom.render(screen());
    await dom.click(button("Add recurring"));
    await dom.type(document.getElementById("subscription-name") as HTMLInputElement, "Water");
    await dom.type(document.getElementById("subscription-amount") as HTMLInputElement, "25");
    await act(async () => {
      document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(writes[4].input.changes).toMatchObject({ name: "Water", kind: "bill", terms: [{ amountCents: 2500 }] });
    expect(dom.container.textContent).toContain("Water");
    await settle(4);
    query = `seg=all&id=${oneOffId}`;
    await dom.render(screen());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("One-time power bill");
    expect(dom.container.textContent).not.toContain("One-time power bill");
    expect(button("Still worth it")).toBeUndefined();
    expect(reads).toBe(1);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.FormData = previousFormData;
  }
});

test("Pause and Undo project unpaid commitments on Overview and refresh one settled match", async () => {
  const { BudgetSubscriptions } = await import("./subscriptions");
  const { BudgetingStubStore, addDays, useBudgetStore } = await import("./stub-store");
  const { BudgetTransactionProvider, budgetToday } = await import("./transaction-store");
  const { Toaster } = await import("@/components/chakra/toaster");
  const id = "6a282c67-0202-4116-a5a9-3226f8692968";
  const today = budgetToday();
  const date = addDays(today, 1);
  const item: Subscription = {
    id, name: "Internet", revision: 1, commandId: crypto.randomUUID(), kind: "bill", category: "Utilities",
    status: "active", stopsOn: null, terms: [{ effectiveOn: today, startOn: date, amountCents: 900, frequency: "monthly", interval: 1 }],
    sourceKey: "public-mobile", evidence: "", logoKey: null, websiteUrl: null, cancelUrl: null, estimated: false, lastReviewed: null,
  };
  const scheduled = { key: id + ":" + date, date, label: item.name, cents: 900, ruleId: id, done: false };
  const paid = { date: today, label: "Prior charge", cents: 1100, done: true };
  const reads: string[] = [];
  const writes: { commandId: string; changes: Partial<Subscription>; revision: number; finish: (r: Response) => void }[] = [];
  let saved = item;
  let matched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((request: Request | string, init?: RequestInit) => {
    const url = new URL(typeof request === "string" ? request : request.url, window.location.origin);
    if (init?.method === "PUT") {
      const input = JSON.parse(String(init.body));
      return new Promise<Response>(finish => writes.push({ ...input, finish }));
    }
    reads.push(url.pathname);
    if (url.pathname.endsWith("/subscriptions")) return Promise.resolve(Response.json({ today, items: [item], paidKeys: [], charges: {} }));
    expect(url.searchParams.get("ruleIds")).toBe(id);
    const active = saved.status === "active";
    const unpaid = active && !matched;
    const posted = matched ? [paid, { date, label: "Matched payment", cents: 950, done: true }] : [paid];
    const bills = unpaid ? [...posted, scheduled] : posted;
    const billTotal = bills.reduce((sum, line) => sum + line.cents, 0);
    return Promise.resolve(Response.json({
      today, statements: [{ start: today, end: date, income: [], bills,
        spending: [], savings: [], cats: [], totals: { income: 0, bills: billTotal, savings: 0, spending: 0 },
        net: -billTotal, allowance: 0, daysLeft: 2 }],
      context: { cash: 10000, checkpointDate: today, foodLimit: 0, otherLimit: 0, balance: [
        { date: today, cents: 10000, past: true }, { date, cents: unpaid ? 9100 : 10000, past: false },
      ], upcoming: unpaid ? [{ ...scheduled, key: id, occurrenceKey: scheduled.key, kind: "bill", uncertain: false }] : [] },
      rules: [{ id, revision: saved.revision, commandId: saved.commandId, status: saved.status, stopsOn: null,
        events: matched ? [] : [{ ...scheduled, kind: "bill", upcoming: true, uncertain: false, forecastDate: date }] }],
    }));
  }) as typeof fetch;

  let store!: ReturnType<typeof useBudgetStore>;
  function Screen() {
    store = useBudgetStore();
    return <><Toaster />{pathname === "/budgeting/subscriptions" ? <BudgetSubscriptions /> : <output>
      {store.s.overview?.statements[0]?.totals.bills}:{store.s.overview?.context?.balance.at(-1)?.cents}
    </output>}</>;
  }
  const render = () => dom.render(<BudgetTransactionProvider><BudgetingStubStore><Screen /></BudgetingStubStore></BudgetTransactionProvider>);
  const button = (label: string) => Array.from(document.body.querySelectorAll("button")).find(node => node.textContent?.trim() === label)!;
  try {
    query = `seg=bill&id=${id}`;
    await render();
    await dom.click(button("Pause"));
    expect(button("Resume")).toBeDefined();
    expect(writes[0].changes.status).toBe("paused");
    pathname = "/budgeting";
    await render();
    expect(reads).toEqual(["/api/v1/budgeting/subscriptions", "/api/v1/budgeting/module/overview"]);
    expect(dom.container.querySelector("output")?.textContent).toBe("1100:10000");
    expect(store.s.overview?.statements[0]?.bills).toEqual([paid]);
    expect(store.s.overview?.context?.upcoming).toEqual([]);
    expect(store.s.cash).toBe(10000);

    // The server may already show a committed pause even while the response remains held.
    saved = { ...item, status: "paused", revision: 2, commandId: writes[0].commandId };
    await act(async () => store.retry());
    expect(dom.container.querySelector("output")?.textContent).toBe("1100:10000");
    await dom.click(button("Undo"));
    expect(dom.container.querySelector("output")?.textContent).toBe("2000:9100");
    expect(store.s.overview?.context?.upcoming[0]).toMatchObject({ key: id, occurrenceKey: scheduled.key });
    expect(writes).toHaveLength(1);
    await act(async () => writes[0].finish(Response.json(saved)));
    expect(writes[1]).toMatchObject({ revision: 2, changes: { status: "active" } });
    expect(dom.container.querySelector("output")?.textContent).toBe("2000:9100");
    matched = true;
    saved = { ...item, revision: 3 };
    await act(async () => writes[1].finish(Response.json(saved)));
    expect(reads).toEqual(["/api/v1/budgeting/subscriptions", ...Array(3).fill("/api/v1/budgeting/module/overview")]);
    expect(dom.container.querySelector("output")?.textContent).toBe("2050:10000");
    expect(store.s.overview?.context?.upcoming).toEqual([]);
    expect(store.s.overview?.statements[0]?.bills).toEqual([paid, { date, label: "Matched payment", cents: 950, done: true }]);
  } finally {
    pathname = "/budgeting/subscriptions";
    globalThis.fetch = originalFetch;
  }
});
