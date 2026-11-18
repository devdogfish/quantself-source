import { expect, test } from "bun:test";
import { parseBudgetInvoiceText } from "./budget-document-scan";
import { isCadBudgetDocument, printedBudgetCurrency } from "./budgeting";

test("reconstructs an invoice from the printed date, final total column and single ASIN", () => {
  const invoice = parseBudgetInvoiceText([
    "Invoice / Facture",
    "amazon.ca",
    "Order date / Date de commande:        1 November 2026",
    "Shipment date / Date d'expédition:     2 November 2026",
    "Due date: 2026-11-25",
    "Invoice # / # de facture TEST-01",
    "Description   Quantity   Unit Price   Discount   Item subtotal",
    "Sample product   1   $50.00   $0.00   $50.00",
    "ASIN: B000000001",
    "Total   $50.00   $7.50   $57.50",
    "Amount due   $0.00",
  ].join("\n"));

  expect(invoice).toMatchObject({
    merchant: "Amazon", date: "2026-11-02", dueDate: "2026-11-25", invoiceNumber: "TEST-01",
    amazonAsin: "B000000001", currency: null, totalCents: 5750,
  });
  expect(invoice.lines[0]).toEqual({ text: "Sample product   1", amount: "$50.00" });
});

test("leaves contradictory totals and multiple product identifiers unresolved", () => {
  const invoice = parseBudgetInvoiceText([
    "Invoice", "amazon.ca", "ASIN: B000000001", "ASIN: B000000002",
    "Total $50.00", "Total $57.50", "Amount due $0.00",
  ].join("\n"));
  expect(invoice.amazonAsin).toBeNull();
  expect(invoice.totalCents).toBeNull();
});

test("only CAD financial documents and legacy receipts are eligible for CAD settlement", () => {
  expect(printedBudgetCurrency("TOTAL US$57.50")).toBe("USD");
  expect(printedBudgetCurrency("TOTAL CA$57.50")).toBe("CAD");
  expect(printedBudgetCurrency("TOTAL A$57.50 AUD")).toBe("AUD");
  expect(isCadBudgetDocument("receipt", null)).toBe(true);
  expect(isCadBudgetDocument("invoice", null)).toBe(false);
  expect(isCadBudgetDocument("invoice", "CAD")).toBe(true);
  expect(isCadBudgetDocument("invoice", "USD")).toBe(false);
  expect(isCadBudgetDocument("msa", "CAD")).toBe(false);
});
