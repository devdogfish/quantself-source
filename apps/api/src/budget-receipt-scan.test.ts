import { expect, test } from "bun:test";
import { parseReceiptDate, parseReceiptText, receiptTextFromTsv } from "./budget-receipt-scan";

test("joins Tesseract price columns across blocks using the word positions", () => {
  const tsv = [
    "5\t1\t1\t1\t1\t1\t20\t20\t70\t18\t95\tMarket",
    "5\t1\t1\t1\t2\t1\t20\t100\t60\t18\t95\tTOTAL",
    "5\t1\t2\t1\t1\t1\t400\t103\t60\t18\t95\t$23.74",
    "5\t1\t2\t1\t2\t1\t400\t131\t60\t18\t95\t$50.00",
  ].join("\n");
  const { text } = receiptTextFromTsv(tsv);
  expect(text).toBe("Market\nTOTAL $23.74\n$50.00");
  expect(parseReceiptText(text).totalCents).toBe(2374);
});

test("prefers the grand total, accepts decimal commas and skips labeled identifiers", () => {
  const result = parseReceiptText([
    "Market", "6 févr. 2026", "SUB-TOTAL 20,00 $", "TOTAL TAX 3,74 $",
    "CARD NUMBER **** 0123", "EMAIL example@example.com", "GRAND TOTAL 23,74 $", "BALANCE DUE 0,00 $",
  ].join("\n"));
  expect(result).toMatchObject({ merchant: "Market", date: "2026-02-06", totalCents: 2374 });
  expect(result.lines.map(line => line.text)).not.toContain("CARD NUMBER **** 0123");
  expect(result.lines.map(line => line.text)).not.toContain("EMAIL example@example.com");
});

test("returns no matching amount when equally ranked totals disagree", () => {
  expect(parseReceiptText("Market\nTOTAL 10.25\nTOTAL 19.50").totalCents).toBeNull();
});

test("accepts unambiguous printed dates and leaves ambiguous numeric dates blank", () => {
  expect(parseReceiptDate("2026-11-8")).toBe("2026-11-08");
  expect(parseReceiptDate("November 8, 2026")).toBe("2026-11-08");
  expect(parseReceiptDate("28/11/2026")).toBe("2026-11-28");
  expect(parseReceiptDate("11/28/26")).toBe("2026-11-28");
  expect(parseReceiptDate("11/08/26")).toBeNull();
  expect(parseReceiptDate("2026-02-29")).toBeNull();
});

test("preserves the currency printed next to the charged total", () => {
  expect(parseReceiptText("Market\nCurrency estimate CAD\nTOTAL USD 23.74"))
    .toMatchObject({ currency: "USD", totalCents: 2374 });
});

test("keeps detached subtotal, tax and payment amounts attached to their printed labels", () => {
  const result = parseReceiptText([
    "Market", "2026-11-08T17:45:00", "Bread 5.00", "SUBTOTAL", "5.00",
    "HST 14%", "0.70", "TOTAL", "CAD 5.70", "CASH", "10.00", "CHANGE", "4.30",
  ].join("\n"));
  expect(result).toMatchObject({ date: "2026-11-08", totalCents: 570, currency: "CAD" });
  expect(result.lines.slice(3)).toEqual([
    { text: "SUBTOTAL", amount: "5.00" }, { text: "HST 14%", amount: "0.70" },
    { text: "TOTAL", amount: "CAD 5.70" }, { text: "CASH", amount: "10.00" },
    { text: "CHANGE", amount: "4.30" },
  ]);
});
