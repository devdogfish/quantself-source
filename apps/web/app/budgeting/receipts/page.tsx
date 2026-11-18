"use client";

import { FilterSelect } from "@/components/shared/filter-select";
import { Button, Checkbox, Field, chakra } from "@chakra-ui/react";

import { Suspense, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadState } from "../budget-controls";
import { budgetRequest, errorMessage, useBudget } from "../budgeting-client";
import { DataPanel, DataGrid, DataGridRow } from "@/components/shared/data-panel";
import { copyExportText, DataToolbar, downloadText } from "@/components/shared/data-toolbar";
import { PageHeader } from "@/components/shared/page-layout";
import { useUrlState } from "@/components/shared/url-state";
import { receiptLibraryState } from "./library-state";
import { ReceiptCameraScanner } from "./receipt-camera-scanner";
import { documentKinds, documentMoney, documentScanStatus, isPurchaseDocument, type DocumentKind, type ScanProvenance } from "./document-format";

function displayStatus(scanStatus: string, expenseStatus: "matched" | "cash" | null, scanProvenance: ScanProvenance) {
  return expenseStatus === "matched" ? "Matched to bank" : expenseStatus === "cash" ? "Cash expense" : documentScanStatus(scanStatus, scanProvenance);
}

function revealedTitle(row: { title: string | null; merchant: string; kind: DocumentKind }) {
  return row.title || row.merchant || `Untitled ${documentKinds[row.kind].toLowerCase()}`;
}

function csvField(value: string) {
  const safe = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export default function ReceiptLibraryPage() {
  return <Suspense fallback={<chakra.p role="status">Loading documents…</chakra.p>}><ReceiptLibraryView /></Suspense>;
}

function ReceiptLibraryView() {
  const params = useSearchParams();
  const hasLegacySearch = params.has("q");
  useEffect(() => {
    if (!hasLegacySearch) return;
    const location = new URL(window.location.href);
    if (!location.searchParams.has("q")) return;
    location.searchParams.delete("q");
    window.history.replaceState(null, "", location);
  }, [hasLegacySearch]);
  const uploadOnly = params.get("upload") === "yes";
  const subscriptionId = uploadOnly ? null : params.get("subscriptionId");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  return <>
    {!uploadOnly && <chakra.div><Button variant="outline" disabled={busy} onClick={() => setRevealed(value => !value)}>
      {revealed ? <EyeOff /> : <Eye />}{revealed ? "Hide document details" : "Reveal document details"}
    </Button></chakra.div>}
    <ReceiptLibrary key={JSON.stringify([subscriptionId, revealed, uploadOnly])} revealed={revealed && !uploadOnly} setBusy={setBusy} subscriptionId={subscriptionId} uploadOnly={uploadOnly} />
  </>;
}

function ReceiptLibrary({ revealed, setBusy, subscriptionId, uploadOnly }: { revealed: boolean; setBusy: (value: boolean) => void; subscriptionId: string | null; uploadOnly: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useUrlState({ kind: "", cursor: "", subscriptionId: "" });
  const [navigating, startNavigation] = useTransition();
  const exportRequest = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const navigate = (patch: Parameters<typeof setUrl>[0]) => {
    exportRequest.current?.abort();
    startNavigation(() => setUrl(patch));
  };
  const { cursor: urlCursor, kind: filter } = receiptLibraryState(new URLSearchParams(url));
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState({ q: "", cursor: "", filter });
  const { q } = search;
  const cursor = q ? search.cursor : urlCursor;
  if (search.filter !== filter) setSearch({ q, cursor: "", filter });

  function submitSearch() {
    const query = searchDraft.trim();
    setSearchDraft(query);
    setSearch({ q: query, cursor: "", filter });
    if (urlCursor) navigate({ cursor: "" });
  }

  function goToPage(cursor: string) {
    if (q) setSearch({ q, cursor, filter });
    else navigate({ cursor });
  }
  const [archiveOnly, setArchiveOnly] = useState(false);
  const [kind, setKind] = useState<DocumentKind>("receipt");
  const [upload, setUpload] = useState<{ id: string; photo?: File } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<{ total: number; processed: number; saved: number; incomplete: number; errors: string[] } | null>(null);
  const params = new URLSearchParams();
  if (revealed) params.set("reveal", "yes");
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  if (subscriptionId) params.set("subscriptionId", subscriptionId);
  if (subscriptionId || filter) params.set("kind", subscriptionId ? "invoice" : filter);
  const listPath = "/receipts" + (params.size ? "?" + params.toString() : "");
  const data = useBudget<"listBudgetReceipts">(listPath, !uploadOnly);
  useLayoutEffect(() => {
    setExporting(false);
    setExportError("");
    return () => {
      exportRequest.current?.abort();
      exportRequest.current = null;
    };
  }, [listPath]);
  const current = navigating ? null : data.currentValue;
  const loadError = navigating ? "" : data.currentError;
  useEffect(() => {
    if (!current?.receipts.some(row => ["pending", "processing"].includes(row.scanStatus))) return;
    const timer = setTimeout(data.reload, 3000);
    return () => clearTimeout(timer);
  }, [current, data.reload]);
  async function create(draft: { id: string; photo?: File }) {
    setUpload(draft); setPending(true); setBusy(true); setError("");
    const body = new FormData();
    body.set("id", draft.id);
    body.set("kind", "receipt");
    if (archiveOnly) body.set("scan", "no");
    if (draft.photo) body.set("photo", draft.photo);
    try {
      const receipt = await budgetRequest<"createBudgetReceipt">("/receipts", "POST", body);
      router.push(`/budgeting/receipts/${receipt.id}`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); setBusy(false); }
  }
  async function uploadDocument(file: File, documentKind: DocumentKind) {
    const form = new FormData();
    form.set("id", crypto.randomUUID());
    form.set("photo", file);
    form.set("kind", documentKind);
    if (archiveOnly) { form.set("scan", "no"); form.set("title", file.name.replace(/\.[^.]+$/, "").slice(0, 180)); }
    if (!isPurchaseDocument(documentKind)) form.set("title", file.name.replace(/\.[^.]+$/, "").slice(0, 180));
    return budgetRequest<"createBudgetReceipt">("/receipts", "POST", form);
  }
  async function importPhotos(files: File[]) {
    setPending(true); setBusy(true); setError(""); setUpload(null);
    const progress = { total: files.length, processed: 0, saved: 0, incomplete: 0, errors: [] as string[] };
    setBatch({ ...progress });
    try {
      // Save each original independently; the durable worker processes it later.
      for (const file of files) {
        try {
          const saved = await uploadDocument(file, kind);
          progress.saved++;
          if (saved.scanStatus === "failed") progress.errors.push(`${file.name}: saved, but OCR could not read it.`);

        } catch (cause) {
          progress.errors.push(`${file.name}: ${errorMessage(cause)}`);
        }
        progress.processed++;
        setBatch({ ...progress, errors: [...progress.errors] });
      }
    } finally {
      setPending(false); setBusy(false);
      data.reload();
    }
  }
  const rows = current?.receipts ?? [];
  const nextCursor = current?.next;
  let emptyMessage = "No receipts yet.";
  if (q || filter) emptyMessage = "No matching documents.";
  else if (subscriptionId) emptyMessage = "No invoices linked to this subscription.";
  const columns = "minmax(14rem, 2fr) 8rem 7rem 9rem 8rem";
  async function exportDocuments(format: "ids" | "csv") {
    if (!current || exportRequest.current) return false;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExportError("");
    setExporting(true);
    const query = new URLSearchParams(params);
    query.delete("cursor");
    query.set("format", format);
    async function load() {
      const result = await budgetRequest<"exportBudgetReceipts">(`/receipts/export?${query}`, "GET", undefined, controller.signal);
      controller.signal.throwIfAborted();
      return result;
    }
    try {
      if (format === "ids") {
        await copyExportText(async () => {
          const result = await load();
          if (!("ids" in result)) throw new Error("Could not copy receipt IDs.");
          return result.ids.join("\n");
        });
      } else {
        const result = await load();
        if (!("rows" in result)) throw new Error("Could not export receipts.");
        const values = [["ID", "Document", "Type", "Date", "Status", "Total"], ...result.rows.map(row => [
          row.id, revealedTitle(row), documentKinds[row.kind], row.date ?? row.createdAt.slice(0, 10), displayStatus(row.scanStatus, row.expenseStatus, row.scanProvenance),
          row.totalCents === null ? "" : documentMoney(row.totalCents, row.currency),
        ])];
        downloadText(values.map(row => row.map(csvField).join(",")).join("\r\n"), "receipts.csv", "text/csv");
      }
    } catch (cause) {
      if (!controller.signal.aborted) setExportError(errorMessage(cause));
      return false;
    } finally {
      if (exportRequest.current === controller) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
    if (controller.signal.aborted) return false;
  }
  return <>
    <PageHeader title={uploadOnly ? "Upload document" : subscriptionId ? "Subscription invoices" : "Receipts & documents"}
      description="Archive originals and link purchase documents to spending."
      actions={uploadOnly ? <Button asChild variant="outline"><Link href="/budgeting/documents">Back to documents</Link></Button> : subscriptionId ? <Button asChild variant="outline"><Link href="/budgeting/subscriptions">Back to subscriptions</Link></Button> : undefined} />
    {!subscriptionId && <chakra.section display="flex" flexDirection="column" gap="3" rounded="lg" borderWidth="1px" bg="bg.panel" p="4">
      <chakra.h2 fontSize="lg" fontWeight="semibold">Add documents</chakra.h2>
      <Field.Root maxW="xs" disabled={pending}><Field.Label>Document type</Field.Label>
        <FilterSelect
          label="Document type"
          size="md"
          w="full"
          highlightActive={false}
          disabled={pending}
          value={kind}
          onChange={(value) => setKind(value as DocumentKind)}
          items={Object.entries(documentKinds).map(([value, label]) => ({ value, label }))}
        />
      </Field.Root>
      <Checkbox.Root checked={archiveOnly} disabled={pending} onCheckedChange={event => setArchiveOnly(event.checked === true)}><Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>Archive originals only — no OCR</Checkbox.Label></Checkbox.Root>
      <chakra.div display="flex" flexWrap="wrap" gap="2">
        {kind === "receipt" && <Button asChild><chakra.label position="relative" cursor="pointer" _focusWithin={{ outline: "2px solid", outlineColor: "colorPalette.focusRing", outlineOffset: "2px" }}>
          {pending ? "Saving receipt…" : "Take photo"}
          <chakra.input aria-label="Take receipt photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={pending}
            onChange={e => { const photo = e.target.files?.[0]; e.target.value = ""; if (photo) void create({ id: crypto.randomUUID(), photo }); }} position="absolute" inset="0" cursor="pointer" opacity="0" />
        </chakra.label></Button>}
        <Button variant="outline" asChild><chakra.label position="relative" cursor="pointer" _focusWithin={{ outline: "2px solid", outlineColor: "colorPalette.focusRing", outlineOffset: "2px" }}>
          Upload documents
          <chakra.input aria-label="Upload documents" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" disabled={pending}
            onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void importPhotos(files); }} position="absolute" inset="0" cursor="pointer" opacity="0" />
        </chakra.label></Button>
        {kind === "receipt" && <Button variant="ghost" disabled={pending} onClick={() => void create({ id: crypto.randomUUID() })}>Create receipt manually</Button>}
      </chakra.div>
      {kind === "receipt" && !pending && <ReceiptCameraScanner autoSubmit onCapture={async file => {
        await uploadDocument(file, "receipt");
        data.reload();
      }} />}
      {batch && <chakra.div display="grid" gap="2" fontSize="sm">
        <chakra.p role="status">{batch.processed} of {batch.total} processed · {batch.saved} archived{batch.incomplete ? ` · ${batch.incomplete} with fields missing` : ""}</chakra.p>
        {pending && <chakra.progress max={batch.total} value={batch.processed} aria-label="Receipt batch progress" width="full" />}
        {batch.errors.length > 0 && <details><summary>{batch.errors.length} files need attention</summary><chakra.ul listStyleType="disc" pl="5">{batch.errors.map((message, index) => <chakra.li key={index}>{message}</chakra.li>)}</chakra.ul></details>}
      </chakra.div>}
      {error && <chakra.div display="flex" alignItems="center" gap="2"><chakra.p role="alert" color="fg.error">{error}</chakra.p>{upload && <Button variant="outline" onClick={() => void create(upload)}>Retry</Button>}</chakra.div>}
    </chakra.section>}
    {!uploadOnly && <DataPanel>
      {revealed && <chakra.form onSubmit={event => { event.preventDefault(); submitSearch(); }}>
        <DataToolbar query={searchDraft} onQuery={value => setSearchDraft(value.slice(0, 180))} placeholder="Search by merchant"
        segments={subscriptionId ? undefined : [{ value: "", label: "All types" }, ...Object.entries(documentKinds).map(([value, label]) => ({ value, label }))]}
        value={filter} onValue={kind => navigate({ kind, cursor: "" })}
        count={current ? `${rows.length} documents on this page` : ""} exportsDisabled={!current || exporting} copyLabel="Copy matching document IDs"
        onCopy={() => exportDocuments("ids")}
        downloadLabel="Download matching documents as CSV" onDownload={() => { void exportDocuments("csv"); }} />
        <Button type="submit" variant="outline" size="sm" m="2">Search</Button>
      </chakra.form>}
      {exporting && <chakra.p px="3" py="2" role="status">Preparing export…</chakra.p>}
      {exportError && <chakra.p px="3" py="2" role="alert" color="fg.error">{exportError}</chakra.p>}
      {!current && <LoadState error={loadError} retry={data.reload} />}
      {current && <DataGrid label="Receipts and documents" columns={columns} minW="800px" headers={[{ label: "Document" }, { label: "Type" }, { label: "Date" }, { label: "Status" }, { label: "Total", align: "right" }]}
          empty={emptyMessage}>
          {rows.map(receipt => {
            const date = receipt.date ?? receipt.createdAt.slice(0, 10);
            return <DataGridRow key={receipt.id} columns={columns} href={`/budgeting/receipts/${receipt.id}`} prefetch={false}>
              <chakra.span fontWeight="medium" overflowWrap="anywhere">{revealed ? revealedTitle(receipt) : `Private ${documentKinds[receipt.kind].toLowerCase()}`}</chakra.span>
              <span>{documentKinds[receipt.kind]}</span><time dateTime={date}>{date}</time>
              <span>{displayStatus(receipt.scanStatus, receipt.expense?.bankAccount ? "matched" : receipt.expense ? "cash" : null, receipt.scanProvenance)}</span>
              <chakra.span textAlign="right">{receipt.totalCents === null ? "—" : documentMoney(receipt.totalCents, receipt.currency)}</chakra.span>
            </DataGridRow>;
          })}
        </DataGrid>}
      {(current || (!navigating && cursor)) && (
        <chakra.nav aria-label="Document pages" display="flex" gap="2" p="3" borderTopWidth="1px">
          {cursor && <Button variant="ghost" onClick={() => goToPage("")}>First page</Button>}
          {nextCursor && <Button variant="outline" onClick={() => goToPage(nextCursor)}>Next page</Button>}
        </chakra.nav>
      )}
    </DataPanel>}
  </>;
}
