"use client";

// Budgeting (#175) — the read-only Overview. Insights only: nothing here edits data; every
// number drills down to the page that holds its rows (Transactions, Subscriptions). Statement after Simplifi's Spending Plan (with a week/month
// period filter), cash card after Mercury's balance chart.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Accordion, Box, Button, CloseButton, Collapsible, Dialog, Field, Flex, Grid, HStack, IconButton, Input, InputGroup, Portal, SegmentGroup, Stack, Text } from "@chakra-ui/react";
import { Chart, useChart } from "@chakra-ui/charts";
import { Area, ComposedChart, CartesianGrid, Line as RLine, ReferenceDot, ReferenceLine, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { Delta, MoreLink } from "@/components/shared/dashboard";
import { SegBar } from "@/components/shared/dashboard-charts";
import { asRoute } from "@/components/shared/dashboard-types";
import { addDays, daysBetween, money, money0, short, TODAY, useBudgetNumbers, useBudgetStore, weekday } from "./stub-store";
import { balanceSeries, period, statement, type Line, type Mode } from "./ledger";
import { AddExpenseButton, num } from "./kit";
import { Frame, to } from "./frame";

export function BudgetOverview() {
  const { s, setPeriod, loading, error, retry } = useBudgetStore();
  const [mode, setMode] = useState<Mode>("month");
  const [offset, setOffset] = useState(0);
  useEffect(() => setPeriod(mode, offset), [mode, offset, setPeriod]);
  const p = period(mode, offset);
  // Current period is compared to the previous one up to the same day (Copilot's "same point last month").
  const full = period(mode, offset - 1);
  const comparisonEnd = addDays(full.start, daysBetween(p.start, TODAY));
  const prev = p.current ? { ...full, end: comparisonEnd < full.end ? comparisonEnd : full.end } : full;
  const st = useMemo(() => statement(s, p), [s, p.start, p.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const before = useMemo(() => statement(s, prev), [s, prev.start, prev.end]); // eslint-disable-line react-hooks/exhaustive-deps
  // Income, bills and savings include planned items, so they compare to the whole previous period.
  const beforeFull = useMemo(() => statement(s, full), [s, full.start, full.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const fullName = mode === "week" ? (p.current ? "last week" : "the week before") : full.label.split(" ")[0];
  const prevName = p.current ? `${short(prev.start)}–${short(prev.end).replace(/^\D+/, "")}` : mode === "week" ? "the week before" : full.label.split(" ")[0];

  const statementReady = [p, prev, full].every(range => s.overview?.statements.some(x => x.start === range.start && x.end === range.end));
  const range = { from: p.start, to: p.end > TODAY ? TODAY : p.end };
  const [open, setOpen] = useState(false);
  return (
    <Frame title="Overview"
      actions={<><Button asChild size="sm" variant="ghost"><Link href={asRoute(to("log"))}><PenLine />Check in</Link></Button><AddExpenseButton /></>}>
      <Stack gap="6">
        {/* Period filter: the one control on this page. It drives every number below. */}
        <HStack gap="2" wrap="wrap">
          <SegmentGroup.Root size="sm" value={mode} onValueChange={(e) => { setMode(e.value as Mode); setOffset(0); }}>
            <SegmentGroup.Indicator />
            <SegmentGroup.Items items={[{ value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
          </SegmentGroup.Root>
          <HStack gap="0.5">
            <IconButton size="sm" variant="ghost" aria-label={`Previous ${mode}`} onClick={() => setOffset((o) => o - 1)}><ChevronLeft /></IconButton>
            <Text fontWeight="semibold" minW="36" textAlign="center" {...num}>{p.label}</Text>
            <IconButton size="sm" variant="ghost" aria-label={`Next ${mode}`} onClick={() => setOffset((o) => o + 1)} disabled={offset >= 0}><ChevronRight /></IconButton>
          </HStack>
          {offset !== 0 && <Button size="xs" variant="ghost" onClick={() => setOffset(0)}>This {mode}</Button>}
        </HStack>

        {loading && <Text role="status">Loading budget…</Text>}
        {error && <Text role="alert">{error} <Button size="xs" variant="ghost" onClick={retry}>Retry</Button></Text>}
        {s.overview && <>
        {/* One panel: the headline is the trigger; the four sections slide open beneath it. The old
            "Available to spend" footer row is gone because the headline already says it. */}
        {statementReady && <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)} borderWidth="1px" rounded="l3" bg="bg" overflow="hidden">
          <Collapsible.Trigger display="block" w="full" textAlign="left" cursor="pointer" _hover={{ bg: "bg.subtle" }} transition="background .15s">
            <Headline st={st} before={before} mode={mode} current={p.current} prevName={prevName} />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <Box borderTopWidth="1px">
              <Accordion.Root multiple collapsible variant="plain">
                <Section value="income" title="Income" lines={st.income} total={st.totals.income} was={beforeFull.totals.income} good="up" sign={1} prevName={fullName}
                  more={{ href: to("subscriptions", { seg: "income" }), where: "Subscriptions" }} />
                <Section value="bills" title="Bills and subscriptions" lines={st.bills} total={st.totals.bills} was={beforeFull.totals.bills} good="down" sign={-1} prevName={fullName}
                  more={{ href: to("subscriptions", { seg: "all" }), where: "Subscriptions" }} />
                <Section value="savings" title="Savings" lines={st.savings} total={st.totals.savings} was={beforeFull.totals.savings} good="up" sign={-1} prevName={fullName} />
                <Accordion.Item value="spending">
                  <Trigger title="Spending" meta={`${st.spending.length} transactions`} total={-st.totals.spending} now={st.totals.spending} was={before.totals.spending} good="down" prevName={prevName} />
                  <Accordion.ItemContent><Accordion.ItemBody p="0">
                    {st.cats.map((c) => (
                      <Grid asChild key={c.name} templateColumns="9rem minmax(0,1fr) 3rem 7rem 1rem" gap="3" px="4" pl="10" py="2" borderTopWidth="1px" borderColor="border.muted" alignItems="center" textStyle="sm" _hover={{ bg: "bg.subtle" }}>
                        <Link href={asRoute(to("transactions", { ...range, cat: c.name, spendingOnly: "yes" }))} aria-label={`${c.name} transactions`}>
                          <Text>{c.name}</Text>
                          <Box h="1.5" bg="bg.emphasized" rounded="full"><Box h="full" w={`${(c.cents / st.totals.spending) * 100}%`} bg="fg.muted" rounded="full" /></Box>
                          <Text textAlign="right" textStyle="xs" color="fg.muted" {...num}>{c.count}×</Text>
                          <Text textAlign="right" {...num}>{money(-c.cents)}</Text>
                          <Box color="fg.subtle"><ChevronRight size={14} /></Box>
                        </Link>
                      </Grid>
                    ))}
                    <More href={to("transactions", { ...range, spendingOnly: "yes" })} where="Transactions" />
                  </Accordion.ItemBody></Accordion.ItemContent>
                </Accordion.Item>
              </Accordion.Root>
            </Box>
          </Collapsible.Content>
        </Collapsible.Root>}

        <CashCard st={st} ready={statementReady} failed={!!error} label={p.label} href={to("transactions", range)} />

        {p.current && <Upcoming />}
        </>}
      </Stack>
    </Frame>
  );
}

// Last row of an opened section: the drill-down to the page that holds these rows. It sits in the rows'
// first column at row height, so it reads as part of the list, not as a total or a footer button.
function More({ href, where }: { href: string; where: string }) {
  return (
    <Box px="4" pl="10" py="2" borderTopWidth="1px" borderColor="border.muted">
      <HStack asChild gap="1" textStyle="xs" fontWeight="medium" color="fg.muted" _hover={{ color: "fg" }} w="fit-content">
        <Link href={asRoute(href)}>View more in {where}<ChevronRight size={12} /></Link>
      </HStack>
    </Box>
  );
}

type St = ReturnType<typeof statement>;

function Headline({ st, before, mode, current, prevName }: { st: St; before: St; mode: Mode; current: boolean; prevName: string }) {
  const week = mode === "week";
  const left = st.allowance - st.totals.spending;
  const food = st.spending.reduce((t, x) => t + (x.foodCents ?? (x.allowance === "food" ? x.cents : 0)), 0);
  const value = week ? left : st.net;
  const label = week ? (current ? "Left in this week's allowance" : "Left in that week's allowance") : current ? "Available to spend" : "Left over";
  return (
    <Box p="5">
      <Flex justify="space-between" align="start" wrap="wrap" gap="4">
        <Stack gap="1">
          <Text textStyle="sm" color="fg.muted">{label}</Text>
          <Text textStyle="4xl" fontWeight="semibold" lineHeight="1" color={value < 0 ? "red.fg" : undefined} {...num}>{money(value)}</Text>
          <Text textStyle="sm" color="fg.muted">
            {current && st.daysLeft > 0
              ? <>about <Text as="span" color="fg" fontWeight="medium" {...num}>{money(Math.max(0, value) / st.daysLeft)}</Text> a day for {st.daysLeft} {st.daysLeft === 1 ? "day" : "days"}</>
              : week ? `of a ${money0(st.allowance)} allowance` : `after ${money0(st.totals.savings)} moved to savings`}
          </Text>
        </Stack>
        <HStack gap="2" textStyle="sm" whiteSpace="nowrap">
          <Text color="fg.muted">Spending</Text>
          <Text fontWeight="medium" {...num}>{money(st.totals.spending)}</Text>
          <Delta now={st.totals.spending} then={before.totals.spending} goodWhen="down" fmt={(x) => money0(x)} label={`vs ${prevName}`} />
        </HStack>
      </Flex>
      <Box mt="5">
        <SegBar h="3" format={(v) => money(v)} parts={week ? [
          { name: "Food", value: food, color: "orange.solid" },
          { name: "Other", value: st.totals.spending - food, color: "purple.solid" },
          { name: "Left", value: Math.max(0, left), color: "green.solid" },
        ] : [
          { name: "Bills and subscriptions", value: st.totals.bills, color: "fg.muted" },
          { name: "Savings", value: st.totals.savings, color: "brand.solid" },
          { name: "Spending", value: st.totals.spending, color: "orange.solid" },
          { name: current ? "Available" : "Left over", value: Math.max(0, st.net), color: "green.solid" },
        ]} />
        <HStack gap="5" mt="2" textStyle="xs" color="fg.muted" wrap="wrap">
          {(week ? [["orange.solid", "Food"], ["purple.solid", "Other"], ["green.solid", "Left"]] : [["fg.muted", "Bills"], ["brand.solid", "Savings"], ["orange.solid", "Spending"], ["green.solid", current ? "Available" : "Left over"]]).map(([c, l]) => (
            <HStack key={l} gap="1.5"><Box boxSize="2" rounded="sm" bg={c} />{l}</HStack>
          ))}
        </HStack>
      </Box>
    </Box>
  );
}

// Exported so other pages (the tax planner prototype) reuse the same section row. `fmt` defaults to cents-precision money.
export function Trigger({ title, meta, total, now, was, good, prevName, fmt = money, fmtDelta = money0 }: { title: string; meta: string; total: number; now: number; was?: number; good: "up" | "down"; prevName: string; fmt?: (cents: number) => string; fmtDelta?: (cents: number) => string }) {
  return (
    <Accordion.ItemTrigger px="4" py="3" cursor="pointer" _hover={{ bg: "bg.muted" }} gap="2" rounded="0" _focusVisible={{ outline: "2px solid", outlineColor: "colorPalette.focusRing", outlineOffset: "-2px" }}>
      <Accordion.ItemIndicator transform="rotate(-90deg)" _open={{ transform: "rotate(0deg)" }} />
      <Text fontWeight="medium">{title}</Text>
      <Text textStyle="xs" color="fg.muted" flex="1">{meta}</Text>
      {was !== undefined && <Box display={{ base: "none", md: "block" }}><Delta now={now} then={was} goodWhen={good} fmt={fmtDelta} label={`vs ${prevName}`} /></Box>}
      <Text w="32" textAlign="right" fontWeight="medium" {...num}>{total > 0 ? "+" : ""}{fmt(total)}</Text>
    </Accordion.ItemTrigger>
  );
}

function Section({ value, title, lines, total, was, good, sign, prevName, more }: { value: string; title: string; lines: Line[]; total: number; was: number; good: "up" | "down"; sign: 1 | -1; prevName: string; more?: { href: string; where: string } }) {
  const planned = lines.filter((l) => !l.done).length;
  return (
    <Accordion.Item value={value} borderBottomWidth="1px">
      <Trigger title={title} meta={`${lines.length} ${lines.length === 1 ? "item" : "items"}${planned ? ` · ${planned} planned` : ""}`} total={sign * total} now={total} was={was} good={good} prevName={prevName} />
      <Accordion.ItemContent><Accordion.ItemBody p="0">
        {lines.length === 0 && <Text px="4" pl="10" py="2.5" textStyle="sm" color="fg.muted" borderTopWidth="1px" borderColor="border.muted">Nothing in this period.</Text>}
        {lines.map((l, k) => (
          <Grid key={k} templateColumns="5rem minmax(0,1fr) 7rem 8rem" gap="3" px="4" pl="10" py="2" borderTopWidth="1px" borderColor="border.muted" textStyle="sm" alignItems="center">
            <Text color="fg.muted" {...num}>{short(l.date)}</Text>
            <Text truncate>{l.label}</Text>
            <Text textStyle="xs" color={l.note === "Uncertain" ? "fg.subtle" : l.done ? "fg.subtle" : "orange.fg"}>{l.note === "Uncertain" ? "Uncertain, not counted" : l.done ? "Posted" : "Planned"}</Text>
            <Text textAlign="right" color={l.done ? undefined : "fg.muted"} {...num}>{sign > 0 ? "+" : ""}{money(sign * l.cents)}</Text>
          </Grid>
        ))}
        {more && <More href={more.href} where={more.where} />}
      </Accordion.ItemBody></Accordion.ItemContent>
    </Accordion.Item>
  );
}

// After Mercury: balance headline, balance over time (actual solid, forecast dashed, today marked), money in / out.
// Y-axis labels: plain dollars while every value is under $1k (so ~$118 isn't five "$0.1k" ticks), thousands above.
export function axisMoney(max: number) {
  return (v: number) => max < 1000 ? `$${Math.round(v)}` : `$${(v / 1000).toFixed(max < 10000 ? 1 : 0)}k`;
}

// A range is greyed out when neither the history nor the forecast reaches past the next-shorter range.
const RANGES = ["1", "3", "6"];
export function rangeItems(all: { past: boolean }[]) {
  const past = all.filter((x) => x.past).length, ahead = all.length - past;
  return RANGES.map((m, i) => {
    const shorter = i === 0 ? 0 : Number(RANGES[i - 1]) * 30;
    return { value: m, label: `${m}M`, disabled: i > 0 && past <= shorter && ahead <= shorter };
  });
}

function CashCard({ st, ready, failed, label, href }: { st: St; ready: boolean; failed: boolean; label: string; href: string }) {
  const { s } = useBudgetStore();
  const [range, setRange] = useState("3");
  const [limitsOpen, setLimitsOpen] = useState(false);
  const months = Number(range);
  const all = s.overview?.context?.balance ?? [];
  const items = rangeItems(all);
  const series = useMemo(() => balanceSeries(s, months * 30, months * 30), [s, months]);
  const future = series.filter((x) => !x.past);
  const low = future.reduce((a, b) => (b.cents < a.cents ? b : a), future[0] ?? { date: TODAY, cents: s.cash });
  const data = series.map((x) => ({ date: x.date, label: short(x.date), actual: x.past ? x.cents / 100 : null, forecast: x.date >= TODAY ? x.cents / 100 : null }));
  const chart = useChart({ data, series: [{ name: "actual", color: "brand.solid", label: "Balance" }, { name: "forecast", color: "fg.muted", label: "Forecast" }] });
  const out = st.totals.bills + st.totals.savings + st.totals.spending;
  const maxAbs = Math.max(0, ...series.map((x) => Math.abs(x.cents / 100)));
  const scheduledOnly = s.overview?.context?.forecast === "scheduled";
  const limitsLink = <Button variant="plain" size="xs" h="auto" p="0" minW="0" textStyle="xs" color="fg.muted" textDecoration="underline" textUnderlineOffset="2px"
    _hover={{ color: "fg" }} onClick={() => setLimitsOpen(true)}>{scheduledOnly ? "Set weekly limits" : "Weekly limits"}</Button>;
  return (
    <Box borderWidth="1px" rounded="l3" bg="bg">
      <Grid templateColumns={{ base: "1fr", md: "minmax(0,1fr) 14rem" }}>
        <Stack p="5" gap="4" borderRightWidth={{ md: "1px" }} minW="0">
          <Flex justify="space-between" align="start" gap="3" wrap="wrap">
            <Stack gap="1">
              <Text textStyle="sm" color="fg.muted">Cash balance</Text>
              <Text textStyle="3xl" fontWeight="semibold" lineHeight="1" {...num}>{s.overview?.context?.cash === null ? "—" : money(s.cash)}</Text>
              {series.length === 0 ? <Text textStyle="xs" color="fg.muted">Set a cash checkpoint in Plan to see the balance.</Text>
                : <HStack gap="1.5" textStyle="xs" color="fg.muted" wrap="wrap">
                    {future.length > 0 && <Text>Lowest ahead <Text as="span" color="fg" fontWeight="medium" {...num}>{money0(low.cents)}</Text> on {short(low.date)}</Text>}
                    {future.length > 0 && <Text aria-hidden>·</Text>}
                    {limitsLink}
                  </HStack>}
            </Stack>
            <SegmentGroup.Root size="xs" value={range} onValueChange={(e) => setRange(e.value as string)}>
              <SegmentGroup.Indicator />
              <SegmentGroup.Items items={items} />
            </SegmentGroup.Root>
          </Flex>
          <HStack gap="5" textStyle="xs" color="fg.muted">
            <HStack gap="1.5"><Box w="4" h="2px" bg="brand.solid" />Balance</HStack>
            <HStack gap="1.5"><Box w="4" borderTopWidth="2px" borderStyle="dashed" borderColor="fg.muted" />{scheduledOnly ? "Forecast: bills and income only" : "Forecast at allowance pace"}</HStack>
          </HStack>
          <Chart.Root chart={chart} h="56">
            <ComposedChart responsive data={chart.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs><Chart.Gradient id="cash" stops={[{ offset: "0%", color: "brand.solid", opacity: 0.18 }, { offset: "100%", color: "brand.solid", opacity: 0.01 }]} /></defs>
              <CartesianGrid stroke={chart.color("border.muted")} vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke={chart.color("fg.muted")} interval="preserveStartEnd" minTickGap={48} />
              <YAxis width={48} tickLine={false} axisLine={false} fontSize={11} stroke={chart.color("fg.muted")} allowDecimals={false} tickFormatter={axisMoney(maxAbs)} />
              <RTooltip animationDuration={0} content={<Chart.Tooltip formatter={(v) => money(Number(v) * 100)} />} />
              <ReferenceLine x={short(TODAY)} stroke={chart.color("border.emphasized")} label={{ value: "Today", position: "insideTopLeft", fontSize: 11, fill: chart.color("fg.muted") }} />
              <Area isAnimationActive={false} type="stepAfter" dataKey="actual" stroke={chart.color("brand.solid")} strokeWidth={1.75} fill="url(#cash)" connectNulls={false} />
              <RLine isAnimationActive={false} type="stepAfter" dataKey="forecast" stroke={chart.color("fg.muted")} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
              {future.length > 0 && <ReferenceDot x={short(low.date)} y={low.cents / 100} r={4} fill={chart.color("bg")} stroke={chart.color("red.solid")} strokeWidth={2} />}
            </ComposedChart>
          </Chart.Root>
        </Stack>
        <Stack p="5" gap="5">
          {ready ? <>
          <Text textStyle="sm" fontWeight="medium">{label}</Text>
          <Stack gap="1"><Text textStyle="xs" color="fg.muted">Money in</Text><Text textStyle="xl" fontWeight="semibold" color="green.fg" {...num}>+{money0(st.totals.income)}</Text></Stack>
          <Stack gap="1"><Text textStyle="xs" color="fg.muted">Money out</Text><Text textStyle="xl" fontWeight="semibold" {...num}>−{money0(out)}</Text>
            <Text textStyle="xs" color="fg.muted">Bills, savings and spending</Text></Stack>
          <Stack gap="1"><Text textStyle="xs" color="fg.muted">Net</Text><Text textStyle="xl" fontWeight="semibold" color={st.net < 0 ? "red.fg" : undefined} {...num}>{money0(st.net)}</Text></Stack>
          <MoreLink href={href}>Transactions in {label}</MoreLink>
          </> : <Text role="status" textStyle="sm" color="fg.muted">{failed ? "Statement unavailable." : "Loading statement…"}</Text>}
        </Stack>
      </Grid>
      <LimitsDialog open={limitsOpen} onClose={() => setLimitsOpen(false)} />
    </Box>
  );
}

// Weekly limits modal: Food and Other per week, applied from this Monday and carried forward. Each changed
// allowance is one optimistic limit command with its own Undo; the forecast redraws before the save returns.
function LimitsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { s, undoable } = useBudgetStore();
  const context = s.overview?.context;
  const thisWeek = context?.thisWeek;
  const current = { food: context?.foodLimit ?? null, other: context?.otherLimit ?? null };
  const dollars = (cents: number | null) => (cents === null ? "" : String(cents / 100));
  const [draft, setDraft] = useState({ food: "", other: "" });
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) { setDraft({ food: dollars(current.food), other: dollars(current.other) }); setError(""); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!thisWeek) return;
    const parsed = { food: draft.food.trim(), other: draft.other.trim() };
    const cents = (v: string) => (v === "" ? null : Math.round(Number(v) * 100));
    const next = { food: cents(parsed.food), other: cents(parsed.other) };
    if ([next.food, next.other].some((v) => v !== null && (!Number.isFinite(v) || v < 0 || v > 100_000_000))) {
      setError("Enter amounts between $0 and $1,000,000, or leave a field empty.");
      return;
    }
    for (const allowance of ["food", "other"] as const) {
      if (next[allowance] === current[allowance]) continue;
      const name = allowance === "food" ? "Food" : "Other";
      undoable(next[allowance] === null ? `${name} limit cleared` : `${name} limit set to ${money(next[allowance]!)} a week`,
        { type: "weekLimit", week: thisWeek.week, allowance, before: thisWeek[allowance], cents: next[allowance] });
    }
    onClose();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="sm" placement="center">
      <Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content asChild>
        <form onSubmit={save}>
          <Dialog.Header><Dialog.Title>Weekly limits</Dialog.Title></Dialog.Header>
          <Dialog.Body>
            <Stack gap="4">
              {(["food", "other"] as const).map((a) => (
                <Field.Root key={a}>
                  <Field.Label>{a === "food" ? "Food" : "Other"} per week</Field.Label>
                  <InputGroup startElement="$">
                    <Input inputMode="decimal" placeholder="No limit" value={draft[a]} autoFocus={a === "food"}
                      onChange={(e) => setDraft((d) => ({ ...d, [a]: e.target.value }))} {...num} />
                  </InputGroup>
                </Field.Root>
              ))}
              <Text textStyle="xs" color="fg.muted">Applies from this week{thisWeek ? ` (from ${weekday(thisWeek.week)}, ${short(thisWeek.week)})` : ""} and carries forward. The forecast subtracts these every day.</Text>
              {error && <Text role="alert" textStyle="sm" color="red.fg">{error}</Text>}
            </Stack>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="outline" size="sm" type="button" onClick={onClose}>Cancel</Button>
            <Button size="sm" type="submit" disabled={!thisWeek}>Save limits</Button>
          </Dialog.Footer>
          <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
        </form>
      </Dialog.Content></Dialog.Positioner></Portal>
    </Dialog.Root>
  );
}

const BELT_TARGET = 39; // px per second wanted; the actual speed is the nearest one that moves smoothly

// Moves a track left forever by exactly one device pixel every N frames. Whole pixels keep text sharp
// (sub-pixel offsets made it flicker between sharp and blurred); a fixed N keeps the rhythm even (a
// time-based 26px/s gave 4-and-5-frame gaps, which stutters). N is picked from the measured refresh
// rate so the speed lands as close to BELT_TARGET as possible: 40px/s at 120Hz, 30px/s at 60Hz (1x).
// The track holds two copies and wraps after one copy's width (+ gap). Pauses while hovered or focused;
// stays still with reduced motion.
function useBelt(gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dpr = window.devicePixelRatio || 1;
    let px = 0, frame = 0, count = 0, every = 0, paused = false, last = 0;
    const deltas: number[] = [];
    const pause = () => { paused = true; }, play = () => { paused = el.matches(":hover, :focus-within"); };
    const tick = (now: number) => {
      if (!every) {
        // Measure the display's refresh rate over the first frames (median frame time).
        if (last) deltas.push(now - last);
        last = now;
        if (deltas.length >= 20) {
          const ms = [...deltas].sort((x, y) => x - y)[10];
          every = Math.max(1, Math.round(1000 / ms / (BELT_TARGET * dpr)));
          el.dataset.beltPxPerSecond = String(Math.round(1000 / ms / every / dpr));
        }
      } else if (!paused && ++count >= every) {
        count = 0;
        const loop = Math.round(((el.scrollWidth + gap) / 2) * dpr);
        px = (px + 1) % loop;
        el.style.transform = `translate3d(${-px / dpr}px, 0, 0)`;
      }
      frame = requestAnimationFrame(tick);
    };
    el.addEventListener("pointerenter", pause); el.addEventListener("focusin", pause);
    el.addEventListener("pointerleave", play); el.addEventListener("focusout", play);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerenter", pause); el.removeEventListener("focusin", pause);
      el.removeEventListener("pointerleave", play); el.removeEventListener("focusout", play);
    };
  }, [gap]);
  return ref;
}

// After Copilot's Upcoming strip, moved to the bottom and run as a conveyor belt ("Fließband"): the list is
// rendered twice and slides left forever; hovering or focusing a card pauses it, the edges fade, there is
// no scrollbar. With reduced motion it stays still and scrolls by hand (scrollbar still hidden).
function Upcoming() {
  const n = useBudgetNumbers();
  const track = useBelt(12);
  const card = (u: (typeof n.upcoming)[number], i: number, copy: boolean) => {
    const d = daysBetween(TODAY, u.date);
    return (
      <Stack asChild key={`${copy ? "b" : "a"}${i}`} gap="1" minW="36" borderWidth="1px" rounded="l2" p="3" flexShrink={0} bg="bg" _hover={{ borderColor: "border.emphasized" }}>
        <Link href={asRoute(to("subscriptions", { seg: "all", id: u.key }))} tabIndex={copy ? -1 : undefined} aria-hidden={copy || undefined}>
          <Text textStyle="xs" color={d <= 3 ? "orange.fg" : "fg.muted"}>{d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${weekday(u.date)}, ${short(u.date)}`}</Text>
          <Text textStyle="sm" fontWeight="medium" truncate>{u.label}</Text>
          <Text textStyle="sm" color={u.kind === "income" ? "green.fg" : undefined} {...num}>{u.kind === "income" ? "+" + money(u.cents) : money(-u.cents)}{u.uncertain && <Text as="span" color="fg.subtle"> · maybe</Text>}</Text>
        </Link>
      </Stack>
    );
  };
  return (
    <Stack gap="2">
      <HStack justify="space-between"><Text textStyle="sm" fontWeight="semibold">Coming up · next 30 days</Text><MoreLink href={to("subscriptions", { seg: "all" })}>All subscriptions</MoreLink></HStack>
      <Box overflow="hidden" css={{
        maskImage: "linear-gradient(to right, transparent, black 32px, black calc(100% - 32px), transparent)",
        scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" },
        "@media (prefers-reduced-motion: reduce)": { overflowX: "auto" },
      }}>
        <Flex ref={track} gap="3" w="max-content" py="0.5" willChange="transform">
          {n.upcoming.length === 0 && <Text textStyle="sm" color="fg.muted">Nothing coming up.</Text>}
          {n.upcoming.map((u, i) => card(u, i, false))}
          {n.upcoming.map((u, i) => card(u, i, true))}
        </Flex>
      </Box>
    </Stack>
  );
}
