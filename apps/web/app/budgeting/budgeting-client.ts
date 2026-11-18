"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { operations } from "@/lib/generated/quantself-api-schema";

type BudgetOperation = keyof operations;
type Result<K extends BudgetOperation> = operations[K] extends { responses: { 200: { content: { "application/json": infer R } } } } ? R : never;

export type Overview = Result<"getBudgetOverview">;
export type BudgetPlan = Result<"getBudgetPlan">;
export type Receipt = Result<"getBudgetReceipt">;
export type ReceiptList = Result<"listBudgetReceipts">;
export type Expense = Result<"saveBudgetExpense">;

export const budgetPath = "/api/v1/budgeting";
export async function budgetRequest<K extends BudgetOperation>(path: string, method = "GET", payload?: unknown, signal?: AbortSignal): Promise<Result<K>> {
  const multipart = payload instanceof FormData;
  const response = await fetch(budgetPath + path, {
    method, signal, cache: "no-store",
    headers: payload !== undefined && !multipart ? { "Content-Type": "application/json" } : undefined,
    body: payload === undefined ? undefined : multipart ? payload : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(Error(data?.message ?? `Budgeting request failed (${response.status}).`), { status: response.status });
  return data;
}

export function useBudget<K extends BudgetOperation>(path: string, enabled = true) {
  const [response, setResponse] = useState<{ value: Result<K>; path: string | null } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const generation = useRef(0);
  const setValue = useCallback((next: Result<K>) => {
    generation.current++;
    setResponse({ value: next, path });
    setFailure(null);
  }, [path]);
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh(count => count + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const requestGeneration = ++generation.current;
    setFailure(null);
    // A return to an earlier URL still needs a response for that navigation.
    setResponse(previous => previous && previous.path !== null && previous.path !== path
      ? { ...previous, path: null }
      : previous);
    budgetRequest<K>(path, "GET", undefined, controller.signal).then(
      result => {
        if (controller.signal.aborted || requestGeneration !== generation.current) return;
        setResponse({ value: result, path });
      },
      cause => {
        if (controller.signal.aborted || requestGeneration !== generation.current) return;
        setFailure({ path, message: errorMessage(cause) });
        setResponse(previous => previous ? { ...previous, path: null } : previous);
      },
    );
    return () => controller.abort();
  }, [path, refresh, enabled]);
  return {
    value: response?.value ?? null,
    error: failure?.message ?? "",
    currentValue: enabled && response?.path === path && failure?.path !== path ? response.value : null,
    currentError: failure?.path === path ? failure.message : "",
    setValue,
    reload,
  };
}

const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
export const money = (cents: number) => cad.format(cents / 100);
export const dollars = (cents: number) => (cents / 100).toFixed(2);
export function parseDollars(value: string) {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw Error("Enter a dollar amount with up to two decimal places.");
  return Math.round(Number(value) * 100);
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Budgeting request failed.";
