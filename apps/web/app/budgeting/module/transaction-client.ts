import type { components, operations } from "@/lib/generated/quantself-api-schema";
import { budgetRequest } from "../budgeting-client";

export type Transaction = components["schemas"]["BudgetTransaction"];
export type BudgetLogData = components["schemas"]["BudgetLog"];
export type TransactionCommand = components["schemas"]["BudgetTransactionCommand"];
export type TransactionResult = operations["applyBudgetTransactionCommand"]["responses"][200]["content"]["application/json"];
export type TransactionPage = operations["listBudgetTransactions"]["responses"][200]["content"]["application/json"];
export type TransactionFilters = Omit<NonNullable<operations["listBudgetTransactions"]["parameters"]["query"]>, "session">;
export type Allowance = Transaction["allowance"];
export type Skipped = BudgetLogData["skipped"][number];

export const transactionPageSize = 25;

export function transactionQuery(filters: TransactionFilters & { session?: string }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.size ? "?" + query : "";
}

export const readTransactionPage = (query: string, signal?: AbortSignal) =>
  budgetRequest<"listBudgetTransactions">("/transactions" + query, "GET", undefined, signal);
export const readTransaction = (id: string, signal?: AbortSignal) =>
  budgetRequest<"getBudgetTransaction">("/transactions/" + encodeURIComponent(id), "GET", undefined, signal);
export const readBudgetLog = (query: string, signal?: AbortSignal) =>
  budgetRequest<"getBudgetLog">("/log" + query, "GET", undefined, signal);
export const readTransactionCsv = async ({ page: _page, ...filters }: TransactionFilters, signal?: AbortSignal) =>
  (await budgetRequest<"exportBudgetTransactions">("/transactions/export" + transactionQuery(filters), "GET", undefined, signal)).csv;
export const writeTransaction = (id: string, command: TransactionCommand, session: string) =>
  budgetRequest<"applyBudgetTransactionCommand">("/transaction-commands/" + id + transactionQuery({ session }), "PUT", command);
