import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/components/shared/test-dom";
import { chooseOption } from "@/components/shared/test-select";

const writes: { path: string; method: string; body: unknown }[] = [];
mock.module("../budgeting-client", () => ({
  budgetRequest: async (path: string, method: string, body: unknown) => {
    writes.push({ path, method, body });
    return { inserted: 2, existing: 0 };
  },
  errorMessage: (error: Error) => error.message,
}));
const dom = createTestDom();

test("CSV import retains column detection, transaction edits, native currency and confirmation", async () => {
  const { default: ImportPage } = await import("./page");
  await dom.render(<ImportPage />);
  await chooseOption(dom.container.querySelector<HTMLElement>('[aria-label="Bank account"]')!, "RBC Chequing");
  await chooseOption(dom.container.querySelector<HTMLElement>('[aria-label="Account currency"]')!, "USD");
  await act(async () => {
    const input = dom.container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        {
          size: 100,
          text: async () =>
            "Date,Description,Amount\n2026-11-01,Groceries,-10.00\n2026-11-02,Transfer between accounts,-20.00",
        },
      ],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (label: string) =>
    [...dom.container.querySelectorAll("button")].find(
      (el) => el.textContent === label,
    )!;
  // Parsing lazy-loads csv-parse; act alone does not await that module import.
  for (let attempt = 0; !button("Preview transactions") && attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(button("Preview transactions")).toBeDefined();
  await dom.click(button("Preview transactions"));
  expect(dom.container.textContent).toContain("2 transactions.");
  expect(dom.container.textContent).toContain("US$10.00");
  const type = dom.container.querySelector<HTMLElement>(
    '[aria-label="Transaction 2 type"]',
  )!;
  expect(type.textContent).toContain("Transfer");
  await dom.click(
    dom.container.querySelector('[aria-label="Transaction 1 is food"]')!,
  );
  await dom.click(button("Import to RBC Chequing"));
  expect(writes).toEqual([
    {
      path: "/bank/import",
      method: "POST",
      body: {
        account: "rbc-chequing",
        rows: [
          {
            date: "2026-11-01",
            merchant: "Groceries",
            totalCents: 1000,
            flow: "expense",
            food: true,
            currency: "USD",
            reference: undefined,
          },
          {
            date: "2026-11-02",
            merchant: "Transfer between accounts",
            totalCents: 2000,
            flow: "transfer",
            currency: "USD",
            reference: undefined,
          },
        ],
      },
    },
  ]);
  expect(dom.container.querySelector('[role="status"]')?.textContent).toBe(
    "Imported 2. Already present: 0.",
  );
});
