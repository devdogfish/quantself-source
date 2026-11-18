"use client";

// Budgeting (#175) — Transactions: every expense as raw data, in the reference crawl-table look
// (components/shared DataPanel + DataToolbar + FilterSelect row + DataGrid + TablePagination).
// Rows open a detail drawer addressed by ?id= so a transaction can be linked from anywhere.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Badge, Box, Button, CloseButton, DataList, Drawer, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import { Check, Eye, EyeOff, FileText, X } from "lucide-react";
import { Frame, to } from "./frame";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { copyExportText, DataToolbar, downloadText } from "@/components/shared/data-toolbar";
import { FilterSelect } from "@/components/shared/filter-select";
import { TablePagination } from "@/components/shared/table-pagination";
import { categories, money, short, useBudgetStore } from "./stub-store";
import { toaster } from "@/components/chakra/toaster";
import { errorMessage } from "../budgeting-client";
import { transactionPageSize, type Transaction, type TransactionFilters } from "./transaction-client";
import { useAvailableReceipts, useTransactionPage } from "./transaction-store";
import { originalAmount, AddExpenseButton, allowanceName, Amount, CategoryButton, num, ReceiptMark } from "./kit";

const columns = "6rem minmax(12rem, 2fr) 8rem 5rem 7rem 3rem 8rem";
const monthLabel = new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });
function monthOptions(today: string) {
  const end = new Date(today + "T00:00:00Z");
  return [{ value: "", label: "All dates" }, ...Array.from({ length: 12 }, (_, i) => {
    const month = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    return { value: month.toISOString().slice(0, 7), label: monthLabel.format(month) };
  })];
}
const sorts = [{ value: "new", label: "Newest first" }, { value: "old", label: "Oldest first" }, { value: "big", label: "Largest first" }, { value: "small", label: "Smallest first" }];
type Seg = "all" | "review" | "missing";

export function useDrawerParam() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const set = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("id", id); else next.delete("id");
    router.replace(`${pathname}?${next}` as Route, { scroll: false });
  };
  const href = (id: string) => { const next = new URLSearchParams(params); next.set("id", id); return `${pathname}?${next}`; };
  return { id: params.get("id"), set, href };
}

export function BudgetTransactions() {
  const params = useSearchParams();
  // Remount controls for a new drill-down, but not when the drawer's ID changes.
  const initial = ["from", "to", "cat", "seg", "q", "month", "subscriptionId", "spendingOnly"].map(key => params.get(key));
  return <TransactionTable key={JSON.stringify(initial)} />;
}

function TransactionTable() {
  const drawer = useDrawerParam();
  const params = useSearchParams();
  const [range, setRange] = useState(() => ({ from: params.get("from") ?? "", to: params.get("to") ?? "" }));
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [seg, setSeg] = useState<Seg>(() => params.get("seg") === "review" ? "review" : params.get("seg") === "missing" ? "missing" : "all");
  const [month, setMonth] = useState(() => params.get("month") ?? "");
  const [cat, setCat] = useState(() => params.get("cat") ?? "");
  const [spendingOnly, setSpendingOnly] = useState(() => params.get("spendingOnly") === "yes");
  const [subscriptionId, setSubscriptionId] = useState(() => params.get("subscriptionId") ?? "");
  const [sort, setSort] = useState("new");
  const [page, setPage] = useState(1);
  const filters: TransactionFilters = { ...range, q, seg, month, cat, sort: sort as TransactionFilters["sort"], page, subscriptionId, spendingOnly: spendingOnly ? "yes" : undefined };
  const { transaction: status } = useBudgetStore();
  const data = useTransactionPage(filters, drawer.id, status);
  const reset = <T,>(f: (v: T) => void) => (v: T) => { f(v); setPage(1); };
  const lastPage = Math.max(1, Math.ceil(data.count / transactionPageSize));
  useEffect(() => {
    if (!data.loading && !data.error && page > lastPage) setPage(lastPage);
  }, [data.loading, data.error, page, lastPage]);
  const [exporting, setExporting] = useState(false);
  const exportRequest = useRef<AbortController | null>(null);
  const exportKey = JSON.stringify(filters);
  useLayoutEffect(() => {
    setExporting(false);
    return () => {
      exportRequest.current?.abort();
      exportRequest.current = null;
    };
  }, [exportKey]);
  async function exportCsv(copy: boolean) {
    if (exportRequest.current) return false;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    const load = () => data.csv(controller.signal);
    try {
      if (copy) await copyExportText(load);
      else downloadText(await load(), "transactions.csv", "text/csv");
    } catch (error) {
      if (!controller.signal.aborted) toaster.create({ title: errorMessage(error), type: "error" });
      return false;
    } finally {
      if (exportRequest.current === controller) {
        exportRequest.current = null;
        setExporting(false);
      }
    }
    if (controller.signal.aborted) return false;
  }
  return (
    <Frame title="Transactions" actions={<AddExpenseButton />}>
      <DataPanel>
        <DataToolbar<Seg> query={q} onQuery={reset(setQ)} placeholder="Search merchant, category or amount"
          segments={[{ value: "all", label: "All" }, { value: "review", label: "To review" }, { value: "missing", label: "Missing receipt" }]}
          value={seg} onValue={reset(setSeg)}
          count={data.loading ? "Loading transactions…" : `${data.count} transactions · ${money(-data.totalCents)}`}
          exportsDisabled={exporting || data.loading || !!data.error}
          copyLabel="Copy as CSV" onCopy={() => exportCsv(true)}
          downloadLabel="Download CSV" onDownload={async () => { await exportCsv(false); }} />
        {exporting && <Text role="status" px="3" py="2">Preparing export…</Text>}
        <HStack gap="2" px="2" py="1.5" borderBottomWidth="1px" wrap="wrap">
          <FilterSelect label="Date" w="44" items={monthOptions(data.today)} value={month} onChange={(value) => { setMonth(value); setRange({ from: "", to: "" }); setPage(1); }} />
          <FilterSelect label="Category" w="40" value={cat} onChange={reset(setCat)}
            items={[{ value: "", label: "All categories" }, { value: "Food", label: "Food" }, { value: "Other", label: "Other" }, ...Object.entries(categories).flatMap(([a, cs]) => cs.map((c) => ({ value: c, label: c, hint: allowanceName[a as "food"] })))]} />
          <FilterSelect label="Sort" w="36" items={sorts} value={sort} onChange={reset(setSort)} />
          {(range.from || range.to) && <Button size="xs" variant="outline" borderColor="border.emphasized" onClick={() => { setRange({ from: "", to: "" }); setPage(1); }}>{range.from ? short(range.from) : "Any start"} – {range.to ? short(range.to) : "Today"}<X /></Button>}
          {(month || cat || q || seg !== "all" || range.from || range.to || subscriptionId || spendingOnly) && <Button size="xs" variant="ghost" onClick={() => { setQ(""); setSeg("all"); setMonth(""); setCat(""); setSubscriptionId(""); setSpendingOnly(false); setRange({ from: "", to: "" }); setPage(1); }}>Clear filters</Button>}
        </HStack>
        <DataGrid label="Transactions" columns={columns} minW="760px" empty={data.error || (data.loading ? "Loading transactions…" : "No transactions match these filters.")}
          headers={[{ label: "Date" }, { label: "Merchant" }, { label: "Category" }, { label: "Allowance" }, { label: "Status" }, { label: "Receipt" }, { label: "Amount", align: "right" }]}>
          {data.rows.map((x) => (
            <DataGridRow key={x.id} columns={columns} href={drawer.href(x.id)} linkProps={{ "aria-label": `${x.merchant} ${short(x.date)}` }}>
              <Text color="fg.muted" {...num}>{short(x.date)}</Text>
              <Text truncate fontWeight="medium">{x.merchant}</Text>
              <Text truncate color="fg.muted">{x.category}</Text>
              <Text color="fg.muted">{allowanceName[x.allowance]}</Text>
              <Box>{x.readOnly ? <Text textStyle="xs" color="fg.subtle">—</Text> : x.reviewed ? <Text textStyle="xs" color="fg.subtle">Reviewed</Text> : <Badge size="sm" colorPalette="orange" variant="subtle">To review</Badge>}</Box>
              <ReceiptMark has={x.receipt} />
              <Amount x={x} />
            </DataGridRow>
          ))}
        </DataGrid>
        <TablePagination count={data.count} pageSize={transactionPageSize} page={page} onPageChange={setPage} />
        {data.error && <Button size="xs" onClick={data.reload}>Retry</Button>}
      </DataPanel>
      {status.error && <HStack role="status" gap="2"><Text color="red.fg" textStyle="sm">{status.error}</Text>
        {status.retryable && <Button size="xs" onClick={status.retry}>Retry save</Button>}
      </HStack>}
      <TransactionDrawer key={drawer.id} x={data.open} open={!!drawer.id} loading={data.detailLoading} error={data.detailError} retry={data.reloadDetail} onClose={() => drawer.set(null)} />
    </Frame>
  );
}

function TransactionDrawer({ x, open, loading, error, retry, onClose }: {
  x?: Transaction | null; open: boolean; loading: boolean; error: string; retry: () => void; onClose: () => void;
}) {
  const { undoable } = useBudgetStore();
  const [receiptsRevealed, setReceiptsRevealed] = useState(false);
  return (
    <Drawer.Root open={open} persistentElements={[() => document.querySelector('[data-scope="toast"][data-part="group"]')]} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content>
        {!x && <><Drawer.Header><Drawer.Title>Transaction</Drawer.Title></Drawer.Header>
          <Drawer.Body>{loading ? "Loading transaction…" : error || "Transaction not found."}
            {error && <Button ml="2" size="xs" onClick={retry}>Retry</Button>}
          </Drawer.Body>
        </>}
        {x && <>
          <Drawer.Header borderBottomWidth="1px">
            <Stack gap="1"><Drawer.Title>{x.merchant}</Drawer.Title><Text textStyle="2xl" fontWeight="semibold" {...num}>{money(-x.cents)}</Text></Stack>
          </Drawer.Header>
          <Drawer.Body py="5">
            <Stack gap="6">
              <DataList.Root orientation="horizontal" size="sm">
                <Item k="Date" v={short(x.date) + ", " + x.date.slice(0, 4)} />
                <Item k="Category" v={x.readOnly ? x.category : <CategoryButton x={x} />} />
                <Item k="Allowance" v={allowanceName[x.allowance]} />
                <Item k="Status" v={x.readOnly ? "—" : x.reviewed ? "Reviewed" : "To review"} />
                {x.original && <Item k="Original amount" v={`${originalAmount(x.original)} · conversion estimate`} />}
              </DataList.Root>
              <Stack gap="2">
                <Text textStyle="xs" color="fg.muted" fontWeight="medium">Receipt</Text>
                {x.receiptId
                  ? <Button asChild size="sm" variant="outline" justifyContent="start"><Link href={to("documents", { id: x.receiptId }) as Route}><FileText />{x.merchant} receipt</Link></Button>
                  : x.readOnly ? <Text textStyle="sm" color="fg.muted">—</Text>
                  : <Button size="sm" variant="outline" justifyContent="start" aria-expanded={receiptsRevealed}
                      onClick={() => setReceiptsRevealed(revealed => !revealed)}>
                    {receiptsRevealed ? <EyeOff /> : <Eye />}{receiptsRevealed ? "Hide receipts" : "Reveal receipts to attach"}
                  </Button>}
                {open && receiptsRevealed && !x.receiptId && <ReceiptPicker onSelect={receiptId => {
                  undoable(`Receipt attached to ${x.merchant}`, { type: "receipt", expense: x, receiptId });
                  setReceiptsRevealed(false);
                }} />}
              </Stack>
            </Stack>
          </Drawer.Body>
          <Drawer.Footer borderTopWidth="1px">
            {!x.readOnly && !x.reviewed && <Button size="sm" onClick={() => undoable(`${x.merchant} confirmed`, { type: "review", expense: x, reviewed: true })}><Check />Confirm</Button>}
          </Drawer.Footer>
        </>}
        <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
      </Drawer.Content></Drawer.Positioner></Portal>
    </Drawer.Root>
  );
}

function ReceiptPicker({ onSelect }: { onSelect: (id: string) => void }) {
  const receipts = useAvailableReceipts();
  return <Stack gap="1" maxH="52" overflowY="auto">
    {receipts.available.map(receipt => <Button key={receipt.id} size="xs" variant="ghost" justifyContent="start"
      onClick={() => onSelect(receipt.id)}>{receipt.title || receipt.merchant || "Receipt"}{receipt.date && ` · ${short(receipt.date)}`}</Button>)}
    {receipts.loading && <Text role="status" textStyle="xs">Loading receipts…</Text>}
    {receipts.error && <HStack><Text textStyle="xs" color="red.fg">{receipts.error}</Text><Button size="xs" onClick={receipts.retry}>Retry</Button></HStack>}
    {!receipts.loading && !receipts.error && !receipts.available.length && !receipts.next && <Text textStyle="xs">No unlinked receipts.</Text>}
    {receipts.next && <Button size="xs" variant="ghost" onClick={receipts.more}>More receipts</Button>}
  </Stack>;
}

const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <DataList.Item><DataList.ItemLabel minW="28">{k}</DataList.ItemLabel><DataList.ItemValue {...num}>{v}</DataList.ItemValue></DataList.Item>
);
