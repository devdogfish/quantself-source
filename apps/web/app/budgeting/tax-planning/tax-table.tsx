"use client";

// The one table. Tab 1: every tax item, linking to what already exists in the app (Transactions, Documents,
// Subscriptions, Inventory) instead of re-entering it. Tab 2: documents still to gather before filing.
// Read-only: data entry happens elsewhere, so there are no forms or logging here.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Box, HStack, Text } from "@chakra-ui/react";
import { FileText, Package, Receipt, Repeat } from "lucide-react";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { copyExportText, DataToolbar, downloadText } from "@/components/shared/data-toolbar";
import { asRoute } from "@/components/shared/dashboard-types";
import { to } from "../module/frame";
import { num } from "../module/kit";
import { money, short } from "./tax-format";
import type { AppLink, TaxYearPlan } from "./tax-model";

type Tab = "items" | "gather";

const icon = { transactions: Receipt, document: FileText, subscription: Repeat, inventoryItem: Package } as const;
const typeColor = { Income: "blue", Deduction: "purple", Credit: "teal", Payment: "gray" } as const;
const itemCols = "minmax(12rem, 1.5fr) 6rem 6rem 5rem 6.5rem minmax(14rem, 2fr)";
const gatherCols = "minmax(12rem, 1.6fr) minmax(9rem, 1.1fr) minmax(10rem, 1.1fr) 6.5rem 5.5rem 7.5rem";

function csvField(value: string) {
  const safe = /^\s*[=+@\-]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function linkHref(link: AppLink, year: number) {
  switch (link.kind) {
    case "transactions": return to("transactions", { q: link.search, from: `${year}-01-01`, to: `${year}-12-31` });
    case "document": return to("documents", { id: link.id });
    case "subscription": return to("subscriptions", { id: link.id });
    case "inventoryItem": return link.id ? `/inventory/items/${encodeURIComponent(link.id)}` : "/inventory/browse";
  }
}

export function TaxTable({ plan, on, impact }: { plan: TaxYearPlan; on: Set<string>; impact: (claimId: string) => number }) {
  const [tab, setTab] = useState<Tab>("items");
  const [q, setQ] = useState("");
  const titles = useMemo(() => new Map(plan.items.map(item => [item.id, item.title])), [plan.items]);
  const titleOf = (itemId: string) => titles.get(itemId) ?? "";
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const itemRows = useMemo(() => plan.items.filter((i) => match(`${i.title} ${i.type} ${i.links.map((l) => l.label).join(" ")}`)), [plan, q]);
  const gatherRows = useMemo(() => plan.documentsToGather.filter((d) => match(`${d.name} ${titleOf(d.itemId)} ${d.where}`)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)), [plan, q]);
  const csv = () => tab === "items"
    ? ["Item,Type,Amount CAD,In plan,Linked", ...itemRows.map((i) => [
      csvField(i.title), i.type, (i.amountCents / 100).toFixed(2),
      i.claimId ? (on.has(i.claimId) ? "yes" : "no") : "",
      csvField(i.links.map((l) => l.label).join("; ")),
    ].join(","))].join("\n")
    : ["Document,For,Where,Needed by,Status", ...gatherRows.map((d) => [
      csvField(d.name), csvField(titleOf(d.itemId)), csvField(d.where), d.dueDate, d.status,
    ].join(","))].join("\n");

  return (
    <DataPanel>
      <DataToolbar<Tab> query={q} onQuery={setQ} placeholder="Search items and documents"
        segments={[{ value: "items", label: `Tax items ${plan.items.length}` }, { value: "gather", label: `To gather ${plan.documentsToGather.length}` }]}
        value={tab} onValue={setTab} count={tab === "items" ? `${itemRows.length} items` : `${gatherRows.length} documents`}
        copyLabel="Copy as CSV" onCopy={() => copyExportText(async () => csv())}
        downloadLabel="Download CSV" onDownload={() => downloadText(csv(), tab === "items" ? "tax-items.csv" : "documents-to-gather.csv", "text/csv")} />
      {tab === "items" ? (
        <DataGrid label="Tax items" columns={itemCols} minW="820px" empty="No items match."
          headers={[{ label: "Item" }, { label: "Type" }, { label: "Amount", align: "right" }, { label: "In plan" }, { label: "Refund effect", align: "right" }, { label: "Linked in the app" }]}>
          {itemRows.map((i) => {
            const active = i.claimId ? on.has(i.claimId) : undefined;
            return (
              <DataGridRow key={i.id} columns={itemCols}>
                <Text truncate fontWeight="medium">{i.title}</Text>
                <Box><Badge size="sm" variant="subtle" colorPalette={typeColor[i.type]}>{i.type}</Badge></Box>
                <Text textAlign="right" {...num}>{money(i.amountCents)}</Text>
                <Text color="fg.muted">{active === undefined ? "n/a" : active ? "On" : "Off"}</Text>
                <Text textAlign="right" color={active ? "green.fg" : "fg.muted"} {...num}>{i.claimId && active ? `+${money(impact(i.claimId))}` : "—"}</Text>
                <HStack gap="3" minW="0" overflow="hidden">
                  {i.links.map((l, index) => {
                    const Icon = icon[l.kind];
                    return (
                      <Link key={index} href={asRoute(linkHref(l, plan.year))} prefetch={false} style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                        <Icon size={13} /><Text as="span" textDecoration="underline" textUnderlineOffset="2px" textDecorationColor="var(--chakra-colors-border-emphasized)" _hover={{ textDecorationColor: "currentColor" }}>{l.label}</Text>
                      </Link>
                    );
                  })}
                </HStack>
              </DataGridRow>
            );
          })}
        </DataGrid>
      ) : (
        <DataGrid label="Documents to gather" columns={gatherCols} minW="820px" empty="Nothing left to gather."
          headers={[{ label: "Document" }, { label: "For" }, { label: "Where to get it" }, { label: "Needed by" }, { label: "Status" }, { label: "" }]}>
          {gatherRows.map((d, i) => (
            <DataGridRow key={d.id} columns={gatherCols}>
              <Text truncate fontWeight="medium">{d.name}</Text>
              <Text truncate color="fg.muted">{titleOf(d.itemId)}</Text>
              <Text truncate color="fg.muted">{d.where}</Text>
              <Text color={i === 0 ? "orange.fg" : "fg.muted"} {...num}>{short(d.dueDate)}, {d.dueDate.slice(0, 4)}</Text>
              <Box><Badge size="sm" variant={d.status === "Requested" ? "subtle" : "outline"} colorPalette={d.status === "Requested" ? "orange" : "gray"}>{d.status}</Badge></Box>
              <Link href={asRoute(to("documents"))} prefetch={false} style={{ whiteSpace: "nowrap" }}><Text as="span" textStyle="xs" textDecoration="underline" textUnderlineOffset="2px">Open Documents</Text></Link>
            </DataGridRow>
          ))}
        </DataGrid>
      )}
    </DataPanel>
  );
}
