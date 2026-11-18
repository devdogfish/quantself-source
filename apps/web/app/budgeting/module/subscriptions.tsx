"use client";

// Budgeting (#175) — Subscriptions: one row per recurring rule (the "class"), not per charge (the
// "instance", which lives in Transactions). Answers "what do I pay for, and how much in total?". Same crawl-table
// look as Transactions/Documents, single-line rows, totals strip on top, review/pause/cancel in a drawer with Undo.
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Alert, Badge, Box, Button, CloseButton, DataList, Drawer, Grid, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Check, CirclePause, CirclePlay, FileText, X } from "lucide-react";
import { DataGrid, DataGridRow, DataPanel } from "@/components/shared/data-panel";
import { copyExportText, DataToolbar, downloadText } from "@/components/shared/data-toolbar";
import { FilterSelect } from "@/components/shared/filter-select";
import { daysBetween, money, short, useBudgetStore } from "./stub-store";
import { SubscriptionEditor } from "../subscription-editor";
import { type RecurringRule as Rule } from "./subscriptions-data";
import { num } from "./kit";
import { useDrawerParam } from "./transactions";
import { Frame, to } from "./frame";
import { useRouter, useSearchParams } from "next/navigation";

type Seg = "subscription" | "bill" | "income" | "all";
const perYear = (r: Rule) => r.perYearCents ?? 0;
const perMonth = (r: Rule) => perYear(r) / 12;
const counts = (r: Rule) => r.status === "active";
const stale = (r: Rule, today: string) => !r.reviewed || daysBetween(r.reviewed, today) > 90;
const year = (iso: string, today: string) => iso.slice(0, 4) === today.slice(0, 4) ? short(iso) : `${short(iso)}, ${iso.slice(0, 4)}`;
const columns = "minmax(10rem, 2fr) 6rem 5.5rem 6.5rem 6.5rem 6.5rem 6.5rem 6.5rem";
const statusItems = [{ value: "live", label: "Active and paused" }, { value: "active", label: "Active" }, { value: "paused", label: "Paused" }, { value: "cancelled", label: "Cancelled" }, { value: "any", label: "Any status" }];
const sorts = [{ value: "year", label: "Most expensive first" }, { value: "next", label: "Next charge first" }, { value: "review", label: "Longest unreviewed first" }, { value: "name", label: "Name" }];
const csv = (rows: Rule[]) => ["Name,Type,Every,Next,Price CAD,Per month,Per year,Last reviewed,Status",
  ...rows.map((r) => [`"${r.name.replaceAll('"', '""')}"`, r.kind, r.every, r.next, (r.cents / 100).toFixed(2), (perMonth(r) / 100).toFixed(2), (perYear(r) / 100).toFixed(2), r.reviewed ?? "", r.status].join(","))].join("\n");

export function BudgetSubscriptions() {
  const { s, recurring } = useBudgetStore();
  const { rules } = s;
  const { today, oneOff, loading, error, retry, save } = recurring;
  const drawer = useDrawerParam();
  const params = useSearchParams();
  const router = useRouter();
  const legacyId = params.get("subscription");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const initialSegment = params.get("seg");
  const [seg, setSeg] = useState<Seg>(() =>
    initialSegment === "all" || initialSegment === "bill" || initialSegment === "income" ? initialSegment : "subscription");
  const [status, setStatus] = useState("live");
  const [sort, setSort] = useState("year");
  const [needsReview, setNeedsReview] = useState("");

  const rows = useMemo(() => {
    const out = rules.filter((r) => (seg === "all" || r.kind === seg)
      && (status === "any" || (status === "live" ? r.status !== "cancelled" : r.status === status))
      && (!needsReview || (stale(r, today) && r.status !== "cancelled"))
      && (!q || `${r.name} ${r.category}`.toLowerCase().includes(q.toLowerCase())));
    const by: Record<string, (a: Rule, b: Rule) => number> = {
      year: (a, b) => perMonth(b) - perMonth(a), next: (a, b) => a.next.localeCompare(b.next),
      review: (a, b) => (a.reviewed ?? "").localeCompare(b.reviewed ?? ""), name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...out].sort(by[sort]);
  }, [rules, q, seg, status, sort, needsReview, today]);

  // Totals strip: what the segment costs (or brings in) while active.
  const scope = rules.filter((r) => (seg === "all" ? r.kind !== "income" : r.kind === seg) && counts(r));
  const month = scope.reduce((t, r) => t + perMonth(r), 0);
  const next30 = scope.reduce((sum, rule) => sum + (rule.next30Cents ?? 0), 0);
  const toReview = rules.filter((r) => r.status !== "cancelled" && stale(r, today) && (seg === "all" || r.kind === seg)).length;
  const income = seg === "income";
  const openId = drawer.id ?? legacyId;
  const open = rules.find((r) => r.key === openId) ?? oneOff.find((r) => r.key === openId);
  const closeDrawer = () => {
    if (!legacyId) return drawer.set(null);
    const next = new URLSearchParams(params);
    next.delete("id");
    next.delete("subscription");
    router.replace(`/budgeting/subscriptions?${next}` as Route, { scroll: false });
  };

  return (
    <Frame title="Subscriptions" actions={<Button ref={addTrigger} size="sm" variant="outline" disabled={!today} onClick={() => setAdding(true)}>Add recurring</Button>}>
      <Stack gap="4">
      {loading && <Text role="status" textStyle="sm" color="fg.muted">Loading subscriptions…</Text>}
      {error && <Alert.Root status="error"><Alert.Indicator /><Alert.Title>{error}</Alert.Title>
        <Button variant="ghost" size="sm" onClick={retry}>Retry</Button></Alert.Root>}

      <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} borderWidth="1px" rounded="l3" bg="bg">
        <Fig k={income ? "Comes in per month" : "Per month"} v={today ? money(month) : "—"} />
        <Fig k={income ? "Per year" : "Per year"} v={today ? money(scope.reduce((sum, rule) => sum + perYear(rule), 0)) : "—"} />
        <Fig k="Next 30 days" v={today ? money(next30) : "—"} />
        <Fig k="Not reviewed in 90 days" v={today ? String(toReview) : "—"} action={toReview > 0 && !needsReview ? () => setNeedsReview("yes") : undefined} />
      </Grid>

      <DataPanel>
        <DataToolbar<Seg> query={q} onQuery={setQ} placeholder="Search name or category"
          segments={[{ value: "subscription", label: "Subscriptions" }, { value: "bill", label: "Bills" }, { value: "income", label: "Income" }, { value: "all", label: "All" }]}
          value={seg} onValue={setSeg} count={`${rows.length} ${rows.length === 1 ? "item" : "items"}`}
          copyLabel="Copy as CSV" onCopy={() => copyExportText(async () => csv(rows))}
          downloadLabel="Download CSV" onDownload={() => downloadText(csv(rows), "subscriptions.csv", "text/csv")} />
        <HStack gap="2" px="2" py="1.5" borderBottomWidth="1px" wrap="wrap">
          <FilterSelect label="Status" w="44" items={statusItems} value={status} onChange={setStatus} />
          <FilterSelect label="Review" w="48" items={[{ value: "", label: "Any review date" }, { value: "yes", label: "Not reviewed in 90 days" }]} value={needsReview} onChange={setNeedsReview} />
          <FilterSelect label="Sort" w="52" items={sorts} value={sort} onChange={setSort} />
        </HStack>
        <DataGrid label="Subscriptions" columns={columns} minW="820px" empty="Nothing matches these filters."
          headers={[{ label: "Name" }, { label: "Category" }, { label: "Every" }, { label: "Next" }, { label: "Price", align: "right" }, { label: "Per month", align: "right" }, { label: "Per year", align: "right" }, { label: "Status" }]}>
          {rows.map((r) => (
            <DataGridRow key={r.key} columns={columns} href={drawer.href(r.key)} linkProps={{ "aria-label": r.name }}>
              <HStack gap="2" minW="0"><Text truncate fontWeight="medium" color={r.status === "cancelled" ? "fg.muted" : undefined}>{r.name}</Text>{stale(r, today) && r.status !== "cancelled" && <Box boxSize="1.5" rounded="full" bg="orange.solid" flexShrink={0} title="Not reviewed in 90 days" />}</HStack>
              <Text truncate color="fg.muted">{r.category}</Text>
              <Text color="fg.muted">{r.every}</Text>
              <Text color={r.status === "active" && r.next && daysBetween(today, r.next) <= 7 ? "orange.fg" : "fg.muted"} {...num}>{r.status === "cancelled" || !r.next ? "—" : year(r.next, today)}</Text>
              <Text textAlign="right" color="fg.muted" {...num}>{r.original ? `${r.original.currency} ` : ""}{r.original ? (r.original.display ?? (r.original.cents / 100).toFixed(2)) : money(r.cents)}</Text>
              <Text textAlign="right" {...num}>{money(perMonth(r))}</Text>
              <Text textAlign="right" fontWeight="medium" {...num}>{money(perYear(r))}</Text>
              <Box><StatusBadge r={r} /></Box>
            </DataGridRow>
          ))}
        </DataGrid>
      </DataPanel>
      </Stack>
      <RuleDrawer r={open} today={today} onClose={closeDrawer} />
      {adding && <SubscriptionEditor item={null} today={today} defaultKind={seg === "all" ? "subscription" : seg}
        finalFocusEl={() => addTrigger.current} onClose={() => setAdding(false)} onSave={save} />}
    </Frame>
  );
}

function Fig({ k, v, action }: { k: string; v: string; action?: () => void }) {
  return (
    <Stack gap="1" p="4" borderRightWidth="1px" _last={{ borderRightWidth: 0 }}>
      <Text textStyle="xs" color="fg.muted">{k}</Text>
      <HStack gap="2" justify="space-between"><Text textStyle="xl" fontWeight="semibold" {...num}>{v}</Text>
        {action && <Button size="2xs" variant="ghost" onClick={action}>Show</Button>}</HStack>
    </Stack>
  );
}

function StatusBadge({ r }: { r: Rule }) {
  const map = { active: ["green", "Active"], paused: ["gray", "Paused"], cancelled: ["gray", "Cancelled"] } as const;
  const [palette, label] = map[r.status];
  return <Badge size="sm" variant={r.status === "active" ? "subtle" : "outline"} colorPalette={palette}>{label}</Badge>;
}

function RuleDrawer({ r, today, onClose }: { r?: Rule; today: string; onClose: () => void }) {
  const { undoable } = useBudgetStore();
  const charges = r?.charges ?? [];
  const set = (title: string, patch: Partial<Rule>) => r && undoable(title, { type: "rule", key: r.key, patch });
  return (
    <Drawer.Root open={!!r} onOpenChange={(e) => !e.open && onClose()} size="sm"
      persistentElements={[() => document.querySelector('[data-scope="toast"][data-part="group"]')]}>
      <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content>
        {r && <>
          <Drawer.Header borderBottomWidth="1px">
            <Stack gap="1"><HStack gap="2"><Drawer.Title>{r.name}</Drawer.Title>{!r.oneOff && <StatusBadge r={r} />}</HStack>
              <Text textStyle="2xl" fontWeight="semibold" {...num}>{money(r.oneOff ? r.cents : perYear(r))}{!r.oneOff && <Text as="span" textStyle="sm" color="fg.muted" fontWeight="normal"> per year</Text>}</Text></Stack>
          </Drawer.Header>
          <Drawer.Body py="5">
            <Stack gap="6">
              <DataList.Root orientation="horizontal" size="sm">
                <Item k="Price" v={r.oneOff ? money(r.cents) : r.every ? `${money(r.cents)} every ${r.every}` : "—"} />
                {r.original && <Item k="Billed as" v={`${r.original.currency} ${(r.original.display ?? (r.original.cents / 100).toFixed(2))} · conversion estimate`} />}
                {!r.oneOff && <Item k="Per month" v={money(perMonth(r))} />}
                <Item k="Next charge" v={r.status === "cancelled" || !r.next ? "None" : year(r.next, today)} />
                {!r.oneOff && <>
                  <Item k="Since" v={r.since ? year(r.since, today) : "—"} />
                  <Item k="Last reviewed" v={r.reviewed ? year(r.reviewed, today) : "Never"} />
                </>}
              </DataList.Root>
              <Stack gap="1.5">
                <Text textStyle="xs" color="fg.muted" fontWeight="medium">Recent charges</Text>
                {charges.length === 0 ? <Text textStyle="sm" color="fg.muted">None yet.</Text> : charges.map((charge) => (
                  <HStack key={charge.id} justify="space-between" textStyle="sm" py="1" borderBottomWidth="1px" borderColor="border.muted">
                    <Text color="fg.muted" {...num}>{year(charge.date, today)}</Text><Text {...num}>{charge.cents < 0 ? "+" : "−"}{money(Math.abs(charge.cents))}</Text>
                  </HStack>
                ))}
                <Button asChild size="xs" variant="ghost" alignSelf="start"><Link href={to("transactions", { subscriptionId: r.key }) as Route}>All charges in Transactions<ArrowRight /></Link></Button>
              </Stack>
              {r.doc && <Button asChild size="sm" variant="outline" justifyContent="start"><Link href={to("documents", { id: r.doc }) as Route}><FileText />Agreement</Link></Button>}
            </Stack>
          </Drawer.Body>
          {!r.oneOff && <Drawer.Footer borderTopWidth="1px" justifyContent="space-between">
            <HStack gap="2">
              {r.status === "active" && <Button size="sm" variant="outline" onClick={() => set(`${r.name} paused`, { status: "paused" })}><CirclePause />Pause</Button>}
              {r.status === "paused" && <Button size="sm" variant="outline" onClick={() => set(`${r.name} resumed`, { status: "active" })}><CirclePlay />Resume</Button>}
              {r.status !== "cancelled"
                ? <Button size="sm" variant="outline" colorPalette="red" onClick={() => set(`${r.name} marked cancelled`, { status: "cancelled" })}><X />Cancelled</Button>
                : <Button size="sm" variant="outline" onClick={() => set(`${r.name} reactivated`, { status: "active" })}>Reactivate</Button>}
            </HStack>
            {r.status !== "cancelled" && <Button size="sm" onClick={() => set(`${r.name} reviewed`, { reviewed: today })} disabled={r.reviewed === today}><Check />{r.reviewed === today ? "Reviewed" : "Still worth it"}</Button>}
          </Drawer.Footer>}
          <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
        </>}
      </Drawer.Content></Drawer.Positioner></Portal>
    </Drawer.Root>
  );
}

const Item = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <DataList.Item><DataList.ItemLabel minW="28">{k}</DataList.ItemLabel><DataList.ItemValue {...num}>{v}</DataList.ItemValue></DataList.Item>
);
