"use client";

import { createContext, useContext, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { Route } from "next";
import { Badge, Box, Button, CloseButton, DataList, Drawer, HStack, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { ArrowRight, Download, Eye, EyeOff } from "lucide-react";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { DataToolbar } from "@/components/shared/data-toolbar";
import { FilterSelect } from "@/components/shared/filter-select";
import { TablePagination } from "@/components/shared/table-pagination";
import { LoadState } from "../budget-controls";
import { documentKinds, documentScanProvenanceLabel } from "../receipts/document-format";
import { num } from "./kit";
import { useDrawerParam } from "./transactions";
import { Frame } from "./frame";
import {
  documentAmount, documentCadAmount, documentLinks, documentPageSize, documentShortDate, documentTitle,
  useDocument, useDocumentOriginal, useDocumentQuery, type BudgetDocument, type DocumentSegment,
} from "./use-documents";

const PdfPreview = dynamic(() => import("./document-pdf-preview"), {
  ssr: false,
  loading: () => <Text role="status">Loading preview…</Text>,
});

const columns = "minmax(11rem, 2fr) 7.5rem minmax(7rem, 1fr) 4.5rem 6.5rem minmax(8rem, 1fr)";
const suffix: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

type Doc = {
  id: string;
  kind: BudgetDocument["kind"];
  title: string;
  party: string;
  direction: "in" | "out" | null;
  date: string;
  cents: number | null;
  link?: { label: string; href: string };
  pages: number | null;
};
const DocumentPageContext = createContext<{ rows: BudgetDocument[]; revealed: boolean }>({ rows: [], revealed: false });

export function useDocuments(): Doc[] {
  const { rows, revealed } = useContext(DocumentPageContext);
  return useMemo(() => rows.map(doc => ({
    id: doc.id,
    kind: doc.kind,
    title: documentTitle(doc, revealed),
    party: revealed ? doc.merchant : "",
    direction: null,
    date: doc.date,
    cents: revealed ? documentCadAmount(doc) : null,
    link: revealed ? documentLinks(doc)[0] : undefined,
    pages: revealed && doc.mime?.startsWith("image/") ? 1 : null,
  })), [rows, revealed]);
}

function DocumentTable({ href, loaded }: { href: (id: string) => string; loaded: boolean }) {
  const docs = useDocuments();
  const { rows, revealed } = useContext(DocumentPageContext);
  const rawById = new Map(rows.map(doc => [doc.id, doc]));
  return <DataGrid label="Documents" columns={columns} minW="720px" empty={loaded ? "No documents match." : ""}
    headers={[{ label: "Document" }, { label: "Type" }, { label: "From / to" }, { label: "Date" }, { label: "Amount", align: "right" }, { label: "Linked to" }]}>
    {docs.map(doc => {
      const raw = rawById.get(doc.id);
      const amount = revealed && raw ? documentAmount(raw, "—") : "—";
      return <DataGridRow key={doc.id} columns={columns} href={href(doc.id)} prefetch={false}>
        <Text truncate fontWeight="medium">{doc.title}</Text>
        <Text truncate color="fg.muted">{documentKinds[doc.kind]}</Text>
        <Text truncate color="fg.muted">{doc.party || "—"}</Text>
        <Text color="fg.muted" {...num}>{documentShortDate(doc.date)}</Text>
        <Text textAlign="right" truncate {...num} title={amount}>{amount}</Text>
        <Text truncate textStyle="xs" color={doc.link ? "fg.muted" : "fg.subtle"}>{doc.link?.label ?? (revealed ? "Not linked" : "—")}</Text>
      </DataGridRow>;
    })}
  </DataGrid>;
}

export function BudgetDocuments() {
  const drawer = useDrawerParam();
  const [revealed, setRevealed] = useState(false);
  const [q, setQ] = useState("");
  const [seg, setSeg] = useState<DocumentSegment>("all");
  const [year, setYear] = useState("");
  const [linked, setLinked] = useState("");
  const [page, setPage] = useState(1);
  const data = useDocumentQuery({ revealed, q, seg, year, linked, page });
  const current = data.data;
  const reset = <T,>(f: (v: T) => void) => (v: T) => { f(v); setPage(1); };
  const toggle = () => {
    setPage(1);
    setYear("");
    if (revealed) {
      setQ("");
      setLinked("");
    }
    setRevealed(value => !value);
  };
  return (
    <Frame title="Documents" actions={<Button asChild size="sm" variant="outline"><Link href="/budgeting/receipts?upload=yes">Upload document</Link></Button>}>
      <DataPanel>
        <DataToolbar<DocumentSegment> query={q} onQuery={reset(setQ)} queryDisabled={!revealed} placeholder="Search title, company or amount"
          segments={[{ value: "all", label: "All" }, { value: "receipts", label: "Receipts" }, { value: "invoices", label: "Invoices" }, { value: "agreements", label: "Agreements" }]}
          value={seg} onValue={reset(setSeg)} count={data.total === null ? "" : `${data.total} documents`}
          exportsDisabled={data.exportsDisabled} copyLabel="Copy list as CSV" onCopy={() => data.exportCsv(true)}
          downloadLabel="Download list" onDownload={async () => { await data.exportCsv(false); }} />
        <HStack gap="2" px="2" py="1.5" borderBottomWidth="1px" wrap="wrap">
          <FilterSelect label="Year" w="32" value={year} onChange={reset(setYear)} items={[{ value: "", label: "Any year" }, ...Array.from(new Set([...(year ? [year] : []), ...data.years])).sort().reverse().map(value => ({ value, label: value }))]} />
          <FilterSelect label="Linked" w="44" value={linked} disabled={!revealed} onChange={reset(setLinked)} items={[{ value: "", label: "Linked or not" }, { value: "yes", label: "Linked to money" }, { value: "no", label: "Not linked" }]} />
          <Button size="xs" variant="outline" onClick={toggle}>{revealed ? <EyeOff /> : <Eye />}{revealed ? "Hide document details" : "Reveal document details"}</Button>
        </HStack>
        {data.exporting && <Text role="status" px="3" py="2">Preparing export…</Text>}
        {data.exportError && <Text role="alert" color="fg.error" px="3" py="2">{data.exportError}</Text>}
        {!current && <Box px="3" py="2"><LoadState error={data.error} retry={data.retry} /></Box>}
        <DocumentPageContext.Provider value={{ rows: current?.rows ?? [], revealed }}>
          <DocumentTable href={drawer.href} loaded={!!current} />
        </DocumentPageContext.Provider>
        {data.total !== null && <TablePagination count={data.total} pageSize={documentPageSize} page={page} onPageChange={setPage} />}
      </DataPanel>
      <Drawer.Root open={!!drawer.id} onOpenChange={(e) => !e.open && drawer.set(null)} size="md">
        <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content>
          {drawer.id && <DocDrawer key={drawer.id} id={drawer.id} summary={current?.rows.find(d => d.id === drawer.id)} />}
          <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
        </Drawer.Content></Drawer.Positioner></Portal>
      </Drawer.Root>
    </Frame>
  );
}

function DocDrawer({ id, summary }: { id: string; summary?: BudgetDocument }) {
  const [revealed, setRevealed] = useState(false);
  const data = useDocument(id, summary, revealed);
  const doc = data.document;
  const original = useDocumentOriginal(id, revealed && !!doc?.mime);
  const preview = original.result;
  return <>
    <Drawer.Header borderBottomWidth="1px"><Stack gap="1">
      <Drawer.Title>{doc ? documentTitle(doc, revealed) : "Document"}</Drawer.Title>
      {doc && <Badge alignSelf="start" variant="outline" size="sm">{documentKinds[doc.kind]}</Badge>}
    </Stack></Drawer.Header>
    <Drawer.Body py="5">
      <Stack gap="6">
        <Button alignSelf="start" size="sm" variant="outline" onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff /> : <Eye />}{revealed ? "Hide document" : "Reveal document"}</Button>
        {(!doc || data.error) && <LoadState error={data.error} retry={data.retry} />}
        {!revealed && doc && <Text textStyle="sm" color="fg.muted">Document content is hidden.</Text>}
        {revealed && doc && <RevealedDocument doc={doc} original={original} />}
      </Stack>
    </Drawer.Body>
    {revealed && doc && <Drawer.Footer borderTopWidth="1px">
      {preview ? <Button asChild size="sm" variant="outline"><a href={preview.url} download={`document.${suffix[preview.mime]}`}><Download />Download original</a></Button>
        : <Button size="sm" variant="outline" disabled><Download />Download original</Button>}
    </Drawer.Footer>}
  </>;
}

function RevealedDocument({ doc, original }: { doc: BudgetDocument; original: ReturnType<typeof useDocumentOriginal> }) {
  const [pages, setPages] = useState<number | null>(null);
  const [imageError, setImageError] = useState(false);
  const preview = original.result;
  const links = documentLinks(doc);
  const scanProvenance = documentScanProvenanceLabel(doc.scanProvenance);
  return <>
    <Box borderWidth="1px" rounded="l2" bg="bg.subtle" p="6" h="72" overflow="hidden" aria-label="Document preview">
      {!doc.mime ? <Text textStyle="sm" color="fg.muted">No original saved.</Text>
        : !preview ? <LoadState error={original.error} retry={original.retry} />
          : preview.mime === "application/pdf" ? <PdfPreview url={preview.url} onPages={setPages} />
            : imageError ? <Text role="alert">Could not display the image preview.</Text>
              : <chakra.img src={preview.url} alt="Original document" w="full" h="full" objectFit="contain" onError={() => setImageError(true)} />}
    </Box>
    <DataList.Root orientation="horizontal" size="sm">
      <DataList.Item><DataList.ItemLabel minW="28">Date</DataList.ItemLabel><DataList.ItemValue>{documentShortDate(doc.date)}, {doc.date.slice(0, 4)}</DataList.ItemValue></DataList.Item>
      <DataList.Item><DataList.ItemLabel minW="28">From</DataList.ItemLabel><DataList.ItemValue>{doc.merchant || "—"}</DataList.ItemValue></DataList.Item>
      <DataList.Item><DataList.ItemLabel minW="28">Amount</DataList.ItemLabel><DataList.ItemValue {...num}>{documentAmount(doc, "No amount")}</DataList.ItemValue></DataList.Item>
      <DataList.Item><DataList.ItemLabel minW="28">Pages</DataList.ItemLabel><DataList.ItemValue>{pages ?? (preview?.mime.startsWith("image/") ? 1 : "—")}</DataList.ItemValue></DataList.Item>
      {scanProvenance && <DataList.Item><DataList.ItemLabel minW="28">Scan</DataList.ItemLabel><DataList.ItemValue>{scanProvenance}</DataList.ItemValue></DataList.Item>}
    </DataList.Root>
    <Stack gap="2">
      <Text textStyle="xs" color="fg.muted" fontWeight="medium">Linked to</Text>
      {links.length ? links.map(link => <Button key={link.href} asChild size="sm" variant="outline" justifyContent="space-between"><Link href={link.href as Route}>{link.label}<ArrowRight /></Link></Button>)
        : <Text textStyle="sm" color="fg.muted">Nothing yet. Agreements usually stand on their own.</Text>}
    </Stack>
  </>;
}
