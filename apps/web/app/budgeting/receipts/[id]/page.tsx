"use client";

import { budgetToday } from "../../budget-date";

import { Button, Field, Input, chakra } from "@chakra-ui/react";

import { currencies, decimalMoney, parseMoney, type Currency } from "@quantself/budgeting";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-layout";
import { InventoryLinks } from "../../inventory-links";
import { InvoiceSummary } from "../invoice-summary";
import { ReceiptPaper } from "../receipt-paper";
import { amazonProductId, documentKinds, documentMoney, documentScanProvenanceLabel, documentScanStatus, isPurchaseDocument } from "../document-format";
import { ConfirmDelete, ExpenseForm, LoadState } from "../../budget-controls";
import { budgetPath, budgetRequest, errorMessage, money, useBudget, type Expense, type Receipt } from "../../budgeting-client";

export default function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <PrivateReceipt key={id} id={id} />;
}

function PrivateReceipt({ id }: { id: string }) {
  const [revealed, setRevealed] = useState(false);
  return <>
    <chakra.div><Button variant="outline" onClick={() => setRevealed(value => !value)}>
      {revealed ? <EyeOff /> : <Eye />}{revealed ? "Hide document" : "Reveal document"}
    </Button></chakra.div>
    <ReceiptContent key={String(revealed)} id={id} revealed={revealed} />
  </>;
}

function ReceiptContent({ id, revealed }: { id: string; revealed: boolean }) {
  const data = useBudget<"getBudgetReceipt">("/receipts/" + encodeURIComponent(id) + (revealed ? "?reveal=yes" : ""));
  useEffect(() => {
    if (!["pending", "processing"].includes(data.value?.scanStatus ?? "")) return;
    const timer = setTimeout(data.reload, 3000);
    return () => clearTimeout(timer);
  }, [data.value, data.reload]);
  if (!data.value || data.error) return <LoadState error={data.error} retry={data.reload} />;
  if (!revealed) return <chakra.p fontSize="sm" color="fg.muted">
    Original saved · {documentScanStatus(data.value.scanStatus, data.value.scanProvenance)}. Document content is hidden.
  </chakra.p>;
  return <ReceiptDetail receipt={data.value} setReceipt={data.setValue} />;
}

function ReceiptDetail({ receipt, setReceipt }: { receipt: Receipt; setReceipt: (value: Receipt) => void }) {
  const router = useRouter();
  const path = "/receipts/" + receipt.id;
  const kindLabel = documentKinds[receipt.kind];
  const purchase = isPurchaseDocument(receipt.kind);
  const scanProvenance = documentScanProvenanceLabel(receipt.scanProvenance) ??
    (receipt.scanStatus === "archived" ? "Scan history unavailable" : null);
  const pdf = receipt.mime === "application/pdf";
  const receiptEdits = useRef(0);
  const [scanning, setScanning] = useState(false);
  const scanRefresh = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => scanRefresh.current?.abort(), []);
  const [editing, setEditing] = useState(false);
  const [original, setOriginal] = useState(false);
  const [lines, setLines] = useState(receipt.lines);
  function toggleEditor() {
    if (!editing) setLines(receipt.lines);
    setEditing(!editing);
  }
  const [editExpense, setEditExpense] = useState(false);
  const [candidates, setCandidates] = useState<Expense[] | null>(null);
  const [matching, setMatching] = useState(false);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  async function findCandidates(cursor?: string) {
    setMatching(true); setError("");
    try {
      const result = await budgetRequest<"listBudgetReceiptCandidates">(path + "/candidates" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
      setCandidates(current => cursor ? [...(current ?? []), ...result.candidates.filter(row => !current?.some(prior => prior.id === row.id))] : result.candidates);
      setCandidateCursor(result.next ?? null);
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setMatching(false); }
  }
  async function match(expenseId: string | null) {
    setMatching(true); setError("");
    try {
      setReceipt(await budgetRequest<"matchBudgetReceipt">(path + "/match", "PUT", { expenseId }));
      setCandidates(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setMatching(false); }
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const today = budgetToday();
  async function scan() {
    const refresh = new AbortController();
    scanRefresh.current = refresh;
    setScanning(true); setError("");
    try {
      await budgetRequest<"extractBudgetReceipt">(path + "/scan", "POST");
      refresh.signal.throwIfAborted();
      const updated = await budgetRequest<"getBudgetReceipt">(path + "?reveal=yes", "GET", undefined, refresh.signal);
      refresh.signal.throwIfAborted();
      setReceipt(updated);
    } catch (cause) {
      if (!refresh.signal.aborted) setError(errorMessage(cause));
    } finally {
      scanRefresh.current = null;
      if (!refresh.signal.aborted) setScanning(false);
    }
  }


  async function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setSaving(true);
    const submittedVersion = receiptEdits.current;
    const values = new FormData(event.currentTarget);
    const amount = String(values.get("amount") ?? "").trim();
    try {
      const printedCurrency = String(values.get("currency") ?? "").trim().toUpperCase() || null;
      if (printedCurrency && !currencies.includes(printedCurrency as Currency)) throw Error("Choose a supported currency code.");
      setReceipt(await budgetRequest<"editBudgetReceipt">(path, "PUT", {
        title: String(values.get("title") ?? "").trim() || null,
        merchant: purchase ? String(values.get("merchant") ?? "") : receipt.merchant,
        date: purchase ? values.get("date") || null : receipt.date,
        totalCents: purchase ? (amount ? parseMoney(amount, (printedCurrency ?? "CAD") as Currency) : null) : receipt.totalCents,
        currency: purchase ? printedCurrency : receipt.currency,
        ...(receipt.kind === "invoice" ? {
          invoiceNumber: String(values.get("invoiceNumber") ?? "").trim() || null,
          dueDate: values.get("dueDate") || null,
          amazonAsin: amazonProductId(String(values.get("amazonAsin") ?? "")),
        } : {}),
        lines,
      }));
      if (receiptEdits.current === submittedVersion) setEditing(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function saveExpense(expense: Expense) {
    setEditExpense(true);
    const saved = await budgetRequest<"saveBudgetExpense">("/expenses/" + expense.id, "PUT", expense);
    setReceipt({ ...receipt, ...(!receipt.expense ? { merchant: saved.merchant, date: saved.date, totalCents: saved.totalCents } : {}), expense: saved, scanStatus: "confirmed" });
  }
  let expenseDescription = "Archived";
  if (receipt.expense?.bankAccount) {
    expenseDescription = `Bank transaction linked · ${money(receipt.expense.totalCents)}`;
  } else if (receipt.expense) {
    expenseDescription = `Cash expense · ${money(receipt.expense.totalCents)}`;
  }
  return <>
    <PageHeader title={kindLabel}
      facts={[{ label: "Merchant", value: receipt.merchant || "—" }, { label: "Date", value: receipt.date || "—" },
        { label: "Total", value: receipt.totalCents === null ? "—" : documentMoney(receipt.totalCents, receipt.currency) }]}
      description={expenseDescription}
      actions={
      <chakra.div display="flex" flexWrap="wrap" gap="2">
        {receipt.mime && (pdf
          ? <Button asChild variant="outline"><a href={budgetPath + path + "/original"} target="_blank" rel="noreferrer">Download original PDF</a></Button>
          : <Button variant="outline" aria-pressed={original} onClick={() => setOriginal(!original)}>{original ? "Hide original" : "Show original"}</Button>)}
        <Button variant="outline" disabled={scanning} onClick={toggleEditor}>{editing ? "Close editor" : "Edit details"}</Button>
        <ConfirmDelete title="Delete this document?" description={`${receipt.title || receipt.merchant || "Untitled document"}${receipt.expense && !receipt.expense.bankAccount ? ` and its ${money(receipt.expense.totalCents)} expense` : ""} will be permanently deleted.${receipt.expense?.billKey && !receipt.expense.bankAccount ? " Its planned bill will reopen." : ""}`}
          onDelete={async () => { await budgetRequest<"deleteBudgetReceipt">(path, "DELETE"); router.replace("/budgeting/receipts"); }} />
      </chakra.div>
    } />
    {scanProvenance && <chakra.p fontSize="sm" color="fg.muted">{scanProvenance}</chakra.p>}
    {purchase && receipt.scanStatus === "archived" && receipt.scanProvenance === "ocr_completed" && (!receipt.date || receipt.totalCents === null) &&
      <chakra.p fontSize="sm" color="fg.muted">Some fields could not be read. You can keep the original as-is or edit its details.</chakra.p>}
    {receipt.kind === "invoice" && !receipt.currency && receipt.totalCents !== null &&
      <chakra.p fontSize="sm" color="fg.muted">Currency wasn’t detected. Set it in Edit details before recording cash. You can still link the actual bank transaction.</chakra.p>}
    {(scanning || ["pending", "processing"].includes(receipt.scanStatus)) && <chakra.p role="status" color="fg.muted">Original saved. Reading the receipt…</chakra.p>}
    {purchase && (receipt.scanStatus === "failed" || (error && receipt.scanStatus === "pending")) && <chakra.div display="flex" flexWrap="wrap" alignItems="center" gap="3">
      <chakra.p color="fg.muted">Couldn’t read this document. The original is saved.</chakra.p><Button variant="outline" disabled={scanning} onClick={() => void scan()}>Retry scan</Button>
    </chakra.div>}
    {error && <chakra.p role="alert" color="fg.error">{error}</chakra.p>}
    {purchase && <InventoryLinks type="receipt" id={receipt.id} />}
    <chakra.div display="grid" alignItems="start" gap="4" gridTemplateColumns={{ base: "1fr", md: original ? "repeat(2, minmax(0, 1fr))" : "1fr" }}>
      {receipt.kind === "invoice" ? <InvoiceSummary invoice={receipt} /> : receipt.kind === "receipt" ? <ReceiptPaper receipt={receipt} /> :
        <chakra.article display="grid" gap="2" rounded="lg" borderWidth="1px" bg="bg.panel" p="5">
          <chakra.h2 fontSize="xl" fontWeight="semibold">{receipt.title || kindLabel}</chakra.h2>
          <chakra.p fontSize="sm" color="fg.muted">Original archived · {receipt.createdAt.slice(0, 10)}</chakra.p>
        </chakra.article>}
      {original && !pdf && <chakra.figure mx="auto" display="grid" width="full" maxW="md" gap="2">
        <chakra.figcaption fontSize="sm" fontWeight="medium">Original scan</chakra.figcaption>
        {/* The authenticated endpoint serves the source image directly. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <chakra.img src={budgetPath + path + "/original"} alt="Original receipt scan" width="full" rounded="sm" borderWidth="1px" />
        <chakra.a href={budgetPath + path + "/original"} color="colorPalette.fg" textDecoration="underline" target="_blank" rel="noreferrer">Open full size</chakra.a>
      </chakra.figure>}
    </chakra.div>
    {editing && <chakra.form onSubmit={edit} onChangeCapture={() => { receiptEdits.current++; }} display="flex" flexDirection="column" gap="3" rounded="lg" borderWidth="1px" p="4">
      <chakra.h2 fontSize="lg" fontWeight="semibold">Edit document details</chakra.h2>
      <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Title</Field.Label><Input name="title" maxLength={180} defaultValue={receipt.title ?? ""} /></Field.Root>
      {purchase && <chakra.div display="grid" gap="3" gridTemplateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }}>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Merchant</Field.Label><Input name="merchant" maxLength={180} defaultValue={receipt.merchant} /></Field.Root>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Printed date</Field.Label><Input type="date" name="date" defaultValue={receipt.date ?? ""} /></Field.Root>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Printed total</Field.Label><Input inputMode="decimal" name="amount" defaultValue={receipt.totalCents === null ? "" : decimalMoney({ amountMinor: receipt.totalCents, currency: (receipt.currency ?? "CAD") as Currency })} /></Field.Root>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Currency</Field.Label><Input name="currency" maxLength={3} placeholder="CAD" defaultValue={receipt.currency ?? ""} /></Field.Root>
      </chakra.div>}
      {receipt.kind === "invoice" && <chakra.div display="grid" gap="3" gridTemplateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))" }}>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Invoice number</Field.Label><Input name="invoiceNumber" maxLength={80} defaultValue={receipt.invoiceNumber ?? ""} /></Field.Root>
        <Field.Root display="grid" gap="1" fontSize="sm"><Field.Label>Due date</Field.Label><Input type="date" name="dueDate" defaultValue={receipt.dueDate ?? ""} /></Field.Root>
        <Field.Root display="grid" gap="1" fontSize="sm" gridColumn={{ base: "auto", sm: "span 2" }}><Field.Label>Amazon product link or ASIN</Field.Label><Input name="amazonAsin" defaultValue={receipt.amazonAsin ?? ""} /></Field.Root>
      </chakra.div>}
      {purchase && <chakra.fieldset display="grid" gap="2">
        <chakra.legend mb="2" fontSize="sm" fontWeight="medium">Printed lines</chakra.legend>
        {lines.map((line, index) => <chakra.div key={index} display="grid" gridTemplateColumns="minmax(0,1fr) minmax(4rem,7rem) auto" gap="2">
          <Input aria-label={`Line ${index + 1} text`} maxLength={300} value={line.text}
            onChange={e => setLines(rows => rows.map((row, at) => at === index ? { ...row, text: e.target.value } : row))} />
          <Input aria-label={`Line ${index + 1} amount`} maxLength={30} value={line.amount ?? ""}
            onChange={e => setLines(rows => rows.map((row, at) => at === index ? { ...row, amount: e.target.value || null } : row))} />
          <Button type="button" variant="ghost" aria-label={`Remove line ${index + 1}`}
            onClick={() => { receiptEdits.current++; setLines(rows => rows.filter((_, at) => at !== index)); }}>Remove</Button>
        </chakra.div>)}
        <chakra.div><Button type="button" variant="outline" disabled={lines.length >= 250} onClick={() => { receiptEdits.current++; setLines(rows => [...rows, { text: "", amount: null }]); }}>Add line</Button></chakra.div>
      </chakra.fieldset>}
      <chakra.div><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save details"}</Button></chakra.div>
    </chakra.form>}
    {purchase && !scanning && !editing && !receipt.expense && <chakra.section display="flex" flexWrap="wrap" gap="2">
      <Button variant="outline" disabled={matching || !receipt.date || receipt.totalCents === null} onClick={() => void findCandidates()}>Find bank matches</Button>
      <Button variant="outline" disabled={receipt.kind === "invoice" && !receipt.currency} onClick={() => setEditExpense(!editExpense)}>{editExpense ? "Cancel cash entry" : "Mark as cash"}</Button>
    </chakra.section>}
    {candidates && <chakra.section aria-label="Possible bank matches" display="grid" gap="2">
      {receipt.currency && receipt.currency !== "CAD" && <chakra.p fontSize="sm" color="fg.muted">Confirm the merchant and date. The bank’s CAD charge is the budget amount; the original invoice stays in {receipt.currency}.</chakra.p>}
      {candidates.length === 0 && <chakra.p>No available bank transactions nearby. Check the document date and bank imports.</chakra.p>}
      {candidates.map(candidate => <chakra.div key={candidate.id} display="flex" flexWrap="wrap" alignItems="center" justifyContent="space-between" gap="2" rounded="sm" borderWidth="1px" p="3">
        <span>{candidate.merchant} · {candidate.date} · {money(candidate.totalCents)} · {candidate.bankAccount}</span>
        <Button variant="outline" disabled={matching} onClick={() => void match(candidate.id)}>Link transaction</Button>
      </chakra.div>)}
      {candidateCursor && <Button variant="outline" disabled={matching} onClick={() => void findCandidates(candidateCursor)}>More transactions</Button>}
    </chakra.section>}
    {receipt.expense && <chakra.p fontSize="sm" color="fg.muted">Budget amount: {money(receipt.expense.totalCents)} CAD{receipt.expense.conversion?.estimated ? ` · Reference estimate (${receipt.expense.conversion.quote?.rateDate})` : receipt.expense.bankAccount ? " · Bank-posted amount" : ""}</chakra.p>}
    {receipt.expense?.bankAccount && <chakra.div><Button variant="outline" disabled={matching} onClick={() => void match(null)}>Unlink bank transaction</Button></chakra.div>}
    {!scanning && !editing && editExpense && !receipt.expense?.bankAccount && <chakra.section rounded="lg" borderWidth="1px" p="4">
      <chakra.h2 mb="3" fontSize="lg" fontWeight="semibold">{receipt.expense ? "Correct the cash expense" : "Record cash expense"}</chakra.h2>
      <ExpenseForm key={receipt.id} today={today} initial={receipt.expense ?? {
        receiptId: receipt.id, merchant: receipt.merchant, date: receipt.date ?? today, totalCents: receipt.totalCents ?? undefined, currency: receipt.currency as Expense["currency"],
      }} submit={saveExpense} onSaved={() => setEditExpense(false)} label={receipt.expense ? "Save expense" : "Record cash expense"} />
    </chakra.section>}
    {receipt.expense && !receipt.expense.bankAccount && !editExpense && <chakra.div><Button variant="outline" onClick={() => setEditExpense(true)}>Edit linked expense</Button></chakra.div>}
  </>;
}
