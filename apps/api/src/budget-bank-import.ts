import { currencyCode, type CurrencyConverter } from "./budget-fx";
import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { date, financialDocumentKinds, shiftDate } from "./budgeting";
import type { Prisma } from "@quantself/db/generated/prisma/client";

const cents = z.number().int().min(-100_000_000).max(100_000_000);
export const bankImportInput = z.object({
  account: z.enum(["account-1", "account-2", "rbc-chequing", "rbc-ion-visa", "rbc-savings", "bmo", "cua"]),
  rows: z.array(z.object({
    date, merchant: z.string().trim().max(180), totalCents: cents, currency: currencyCode.optional(),
    flow: z.enum(["expense", "refund", "deposit", "transfer"]),
    reference: z.string().trim().max(180).optional(),
    food: z.boolean().optional(),
  }).strict().refine(row => row.totalCents !== 0 && (
    row.flow === "transfer" || (row.flow === "expense" ? row.totalCents > 0 : row.totalCents < 0)
  ) && (!row.food || row.flow === "expense" || row.flow === "refund"), "Check the amount and transaction type.")).min(1).max(5000),
}).strict();

type BankImport = z.infer<typeof bankImportInput>;
type MatchRecord = { id: string; merchant: string; date: string; totalCents: number };

export function identifyBankRows(ownerId: string, input: BankImport) {
  const occurrences = new Map<string, number>();
  return input.rows.map(row => {
    const sourceSignature = row.reference ? ["reference", row.reference] : [row.date, row.merchant, row.totalCents];
    const signature = JSON.stringify(row.currency && row.currency !== "CAD" ? [...sourceSignature, row.currency] : sourceSignature);
    const position = occurrences.get(signature) ?? 0;
    occurrences.set(signature, position + 1);
    // Duplicate rows without a bank ID retain their multiplicity within an export.
    const digest = createHash("sha256").update(JSON.stringify([ownerId, input.account, signature, row.reference ? 0 : position])).digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    return { ownerId, id, date: row.date, merchant: row.merchant || "Bank transaction", totalCents: row.totalCents,
      foodCents: row.food ? row.totalCents : 0, sourceCurrency: row.currency ?? "CAD", bankAccount: input.account, bankFlow: row.flow };
  });
}

export async function prepareBankRows(ownerId: string, imports: BankImport[], fx: CurrencyConverter) {
  const rows = imports.flatMap(input => identifyBankRows(ownerId, input));
  const conversions = await fx.convertMany(rows.map(row => ({ money: { amountMinor: row.totalCents, currency: row.sourceCurrency }, target: "CAD", date: row.date })));
  return rows.map(({ sourceCurrency, ...row }, i) => sourceCurrency === "CAD" ? row : {
    ...row, totalCents: conversions[i].converted.amountMinor, foodCents: row.foodCents ? conversions[i].converted.amountMinor : 0,
    originalAmountMinor: row.totalCents, originalFoodMinor: row.foodCents, originalCurrency: sourceCurrency, conversion: conversions[i],
  });
}
export async function importBankRows(tx: Prisma.TransactionClient, ownerId: string, imports: BankImport[], prepared?: Awaited<ReturnType<typeof prepareBankRows>>) {
  if (!prepared && imports.some(input => input.rows.some(row => row.currency && row.currency !== "CAD"))) throw Error("Prepare foreign bank rows with the currency converter before importing.");
  const rows = prepared ?? imports.flatMap(input => identifyBankRows(ownerId, input)).map(({ sourceCurrency: _, ...row }) => row);
  const { count } = await tx.budgetExpense.createMany({ data: rows, skipDuplicates: true });
  await reconcileBankReceipts(tx, ownerId, rows.filter(row => row.bankFlow === "expense" || row.bankFlow === "refund").map(row => row.totalCents));
  return { inserted: count, existing: rows.length - count };
}

function merchantKey(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{Mark}/gu, "")
    .replace(/\b(?:debit|visa|mastercard|purchase|pos|interac|payment)\b/g, " ")
    .replace(/[^a-z]/g, "");
}

export function matchReceiptRecords(bank: MatchRecord[], receipts: MatchRecord[]) {
  const byAmount = new Map<number, MatchRecord[]>();
  for (const receipt of receipts) {
    const rows = byAmount.get(receipt.totalCents) ?? [];
    rows.push(receipt);
    byAmount.set(receipt.totalCents, rows);
  }
  const candidates = new Map<string, MatchRecord[]>();
  const contenders = new Map<string, number>();
  for (const row of bank) {
    const from = shiftDate(row.date, -3);
    const through = shiftDate(row.date, 3);
    const matches = (byAmount.get(row.totalCents) ?? []).filter(receipt => receipt.date >= from && receipt.date <= through);
    candidates.set(row.id, matches);
    for (const match of matches) contenders.set(match.id, (contenders.get(match.id) ?? 0) + 1);
  }
  return bank.map(row => {
    const matches = candidates.get(row.id)!;
    const match = matches.length === 1 ? matches[0] : undefined;
    const left = merchantKey(row.merchant);
    const right = match ? merchantKey(match.merchant) : "";
    const strong = row.merchant !== "Bank transaction" && Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left));
    return { id: row.id, receiptId: match && strong && contenders.get(match.id) === 1 ? match.id : null };
  });
}

export async function reconcileBankReceipts(tx: Prisma.TransactionClient, ownerId: string, amounts: number[]) {
  const totals = [...new Set(amounts.filter(cents => cents !== 0))];
  if (totals.length === 0) return;
  const [bank, documents] = await Promise.all([
    tx.budgetExpense.findMany({
      where: { ownerId, bankFlow: { in: ["expense", "refund"] }, manualReceiptMatch: false, originalCurrency: null, totalCents: { in: totals } },
      select: { id: true, merchant: true, date: true, totalCents: true, receiptId: true },
    }),
    tx.budgetReceipt.findMany({
      where: { ownerId, totalCents: { in: totals }, date: { not: null }, AND: [
        { OR: [{ kind: { in: financialDocumentKinds }, currency: "CAD" }, { kind: "receipt", currency: null }] },
        { OR: [{ expense: null }, { expense: { bankAccount: { not: null }, manualReceiptMatch: false } }] },
      ] },
      select: { id: true, merchant: true, date: true, totalCents: true },
    }),
  ]);
  const current = new Map(bank.map(row => [row.id, row.receiptId]));
  const links = matchReceiptRecords(bank, documents.flatMap(row => row.date && row.totalCents !== null ? [{ ...row, date: row.date, totalCents: row.totalCents }] : []))
    .filter(row => current.get(row.id) !== row.receiptId);
  if (!links.length) return;
  // Clear first so two existing links can swap without tripping the unique constraint.
  await tx.budgetExpense.updateMany({ where: { ownerId, id: { in: links.map(row => row.id) } }, data: { receiptId: null } });
  await tx.$executeRaw`
    UPDATE "budget_expense" AS expense SET "receiptId" = links."receiptId"
    FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb) AS links(id text, "receiptId" text)
    WHERE expense."ownerId" = ${ownerId} AND expense.id = links.id AND links."receiptId" IS NOT NULL
  `;
}
