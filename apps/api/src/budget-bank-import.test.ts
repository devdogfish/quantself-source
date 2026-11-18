import { expect, test } from "bun:test";
import { identifyBankRows, matchReceiptRecords } from "./budget-bank-import";

const charge = { id: "charge", date: "2026-11-06", totalCents: 2500, merchant: "POS PURCHASE MARKET CORNER 103" };
const receipt = { id: "receipt", date: "2026-11-05", totalCents: 2500, merchant: "Market Corner" };

test("matching waits for both sides and depends on the complete candidate set", () => {
  expect(matchReceiptRecords([charge], [])).toEqual([{ id: "charge", receiptId: null }]);
  expect(matchReceiptRecords([], [receipt])).toEqual([]);
  expect(matchReceiptRecords([charge], [receipt])).toEqual([{ id: "charge", receiptId: "receipt" }]);
  expect(matchReceiptRecords([charge, { ...charge, id: "second" }], [receipt]))
    .toEqual([{ id: "charge", receiptId: null }, { id: "second", receiptId: null }]);
  expect(matchReceiptRecords([charge], [{ ...receipt, id: "other" }, receipt]))
    .toEqual([{ id: "charge", receiptId: null }]);
  expect(matchReceiptRecords([{ ...charge, merchant: "Bank transaction" }], [receipt]))
    .toEqual([{ id: "charge", receiptId: null }]);
});

test("repeat imports are stable and account slots and identical purchases stay distinct", () => {
  const row = { merchant: receipt.merchant, date: receipt.date, totalCents: receipt.totalCents, flow: "expense" as const };
  const first = identifyBankRows("owner", { account: "account-1", rows: [row, row] });
  const second = identifyBankRows("owner", { account: "account-2", rows: [row] });
  expect(new Set([...first, ...second].map(item => item.id)).size).toBe(3);
  expect(identifyBankRows("owner", { account: "account-1", rows: [row, row] })).toEqual(first);
  const fromBank = { ...row, reference: "stable-reference" };
  expect(identifyBankRows("owner", { account: "account-1", rows: [fromBank] })[0].id)
    .toBe(identifyBankRows("owner", { account: "account-1", rows: [{ ...fromBank, merchant: "changed description" }] })[0].id);
});
