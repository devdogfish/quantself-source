"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { decimalMoney, type Currency } from "@quantself/budgeting";
import type { operations } from "@/lib/generated/quantself-api-schema";
import { budgetPath, budgetRequest, errorMessage, useBudget } from "../budgeting-client";
import { documentKinds, documentMoney } from "../receipts/document-format";
import { copyExportText, downloadText } from "@/components/shared/data-toolbar";
import { to } from "./frame";

type ListQuery = NonNullable<operations["listBudgetReceipts"]["parameters"]["query"]>;
type DocumentPage = NonNullable<operations["listBudgetReceipts"]["responses"][200]["content"]["application/json"]["documents"]>;
export type BudgetDocument = DocumentPage["rows"][number];
export type DocumentSegment = "all" | NonNullable<ListQuery["segment"]>;
export const documentPageSize = 20;

const shortDate = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
export const documentShortDate = (date: string) => shortDate.format(new Date(date + "T00:00:00Z"));

export function documentTitle(doc: BudgetDocument, revealed: boolean) {
  const kind = documentKinds[doc.kind].toLowerCase();
  return revealed ? doc.title || doc.merchant || `Untitled ${kind}` : `Private ${kind}`;
}

export function documentCadAmount(doc: BudgetDocument) {
  if (doc.totalCents === null) return null;
  if (doc.currency === "CAD" || (doc.currency === null && doc.kind === "receipt")) return doc.totalCents;
  return doc.transaction?.totalCents ?? null;
}

export function documentAmount(doc: BudgetDocument, empty: string) {
  if (doc.totalCents === null) return empty;
  const cad = documentCadAmount(doc);
  if (!doc.currency || doc.currency === "CAD") return documentMoney(doc.totalCents, doc.currency);
  const original = `${doc.currency} ${decimalMoney({ currency: doc.currency as Currency, amountMinor: doc.totalCents })}`;
  if (cad === null) return original;
  const amount = decimalMoney({ currency: "CAD", amountMinor: cad });
  return `${doc.transaction?.estimated ? "≈" : ""}CAD ${amount} · ${original}`;
}

export function documentLinks(doc: BudgetDocument) {
  const transaction = doc.transaction ? [{
    label: `Transaction · ${documentShortDate(doc.transaction.date)}`,
    href: to("transactions", { id: doc.transaction.id }),
  }] : [];
  return [...transaction, ...doc.subscriptions.map(subscription => ({
    label: `Subscription · ${subscription.label}`,
    href: to("subscriptions", { id: subscription.id }),
  }))];
}

function documentCsv(rows: BudgetDocument[]) {
  const field = (value: string) => {
    const safe = /^\s*[=+@\-]|^[\t\r\n]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return ["Date,Title,Kind,Party,Amount CAD,Linked to", ...rows.map(doc => {
    const cad = documentCadAmount(doc);
    return [
      doc.date, field(documentTitle(doc, true)), documentKinds[doc.kind], field(doc.merchant),
      cad === null ? "" : decimalMoney({ currency: "CAD", amountMinor: cad }),
      field(documentLinks(doc).map(link => link.label).join(" · ")),
    ].join(",");
  })].join("\r\n");
}

export function useDocumentQuery({ revealed, q, seg, year, linked, page }: {
  revealed: boolean; q: string; seg: DocumentSegment; year: string; linked: string; page: number;
}) {
  const trimmed = revealed ? q.trim().slice(0, 180) : "";
  const [search, setSearch] = useState(trimmed);
  useEffect(() => {
    if (search === trimmed) return;
    const timer = setTimeout(() => setSearch(trimmed), 250);
    return () => clearTimeout(timer);
  }, [search, trimmed]);

  const filters = new URLSearchParams();
  if (revealed) {
    filters.set("reveal", "yes");
    if (search) filters.set("q", search);
    if (linked) filters.set("linked", linked);
  }
  if (seg !== "all") filters.set("segment", seg);
  if (year) filters.set("year", year);

  const searchPending = revealed && trimmed !== search;
  const filterKey = filters.toString();
  const path = new URLSearchParams(filters);
  path.set("page", String(page));
  path.set("years", "yes");
  const data = useBudget<"listBudgetReceipts">(`/receipts?${path}`, !searchPending);
  const current = data.currentValue?.documents;
  const [metadata, setMetadata] = useState<{ filterKey: string; revealed: boolean; total: number; years: string[] } | null>(null);
  const years = current?.years ?? (metadata?.revealed === revealed ? metadata.years : []);
  const total = current?.total ?? (!searchPending && metadata?.filterKey === filterKey ? metadata.total : null);
  useEffect(() => {
    if (current) setMetadata({ filterKey, revealed, total: current.total, years: current.years });
  }, [current, filterKey, revealed]);
  const request = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportPath = `/receipts/export?${filters}&format=documents`;
  useLayoutEffect(() => {
    setExporting(false);
    setExportError("");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [exportPath, trimmed]);

  async function exportCsv(copy: boolean) {
    if (!revealed || !current || request.current || trimmed !== search) return false;
    const controller = new AbortController();
    request.current = controller;
    setExportError("");
    setExporting(true);
    async function load() {
      const result = await budgetRequest<"exportBudgetReceipts">(exportPath, "GET", undefined, controller.signal);
      controller.signal.throwIfAborted();
      if (!("documents" in result)) throw Error("Could not export documents.");
      return documentCsv(result.documents);
    }
    try {
      if (copy) await copyExportText(load);
      else downloadText(await load(), "documents.csv", "text/csv");
    } catch (error) {
      if (!controller.signal.aborted) setExportError(errorMessage(error));
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setExporting(false);
      }
    }
    if (controller.signal.aborted) return false;
  }

  return {
    data: current, years, total, error: searchPending ? "" : data.currentError, retry: data.reload,
    exportCsv, exporting, exportError,
    exportsDisabled: !revealed || !current || exporting || trimmed !== search,
  };
}

export function useDocument(id: string, summary?: BudgetDocument, revealed = false) {
  const query = revealed ? "view=documents&reveal=yes" : "view=documents";
  const data = useBudget<"getBudgetReceipt">(`/receipts/${encodeURIComponent(id)}?${query}`, revealed || !summary);
  return {
    document: data.currentValue?.document ?? (!revealed ? summary : undefined),
    error: data.currentError,
    retry: data.reload,
  };
}

export function useDocumentOriginal(id: string, enabled: boolean) {
  const [result, setResult] = useState<{ url: string; mime: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setResult(null);
    setError("");
    if (!enabled) return;
    const controller = new AbortController();
    let url: string | undefined;
    fetch(`${budgetPath}/receipts/${encodeURIComponent(id)}/original`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw Error("Could not load the original document.");
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(blob.type)) {
          throw Error("This original cannot be previewed.");
        }
        url = URL.createObjectURL(blob);
        setResult({ url, mime: blob.type });
      })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, enabled, id]);

  return { result, error, retry: () => setAttempt(value => value + 1) };
}
