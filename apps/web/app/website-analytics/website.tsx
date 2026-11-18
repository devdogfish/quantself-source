"use client";

// Website: "Is my reach growing? Where does traffic come from? Which projects matter? Did a post work? Did anyone
// reach out?" Filter bar (channel, project, device, date range; in the URL; channel and project rows filter on click)
// → needs-reply strip → headline + metric tabs with a Total / By channel chart (YouTube Studio overview + GA4) →
// channels → projects (Top / By channel heat table). One request per filter combination; the API applies them.
import { useState } from "react";
import { Chart, useChart } from "@chakra-ui/charts";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Box, Button, Flex, Grid, HStack, Icon, SegmentGroup, Stack, Text, chakra } from "@chakra-ui/react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { FilterSelect } from "@/components/shared/filter-select";
import { AnalyticsShell, FilterBar, ReportState, TableCard, TrackingLine, useReport, useUrlFilters } from "./analytics-shell";
import { websiteReportPath, type ChannelId, type InquiryStatus, type WebsiteReport } from "./contract";

export const channelLabel: Record<ChannelId, string> = {
  resume: "Résumé", linkedin: "LinkedIn", youtube: "YouTube", github: "GitHub", google: "Google", direct: "Direct", other: "Other",
};
const channelColor: Record<ChannelId, string> = {
  resume: "blue.solid", linkedin: "cyan.solid", youtube: "red.solid", github: "gray.solid", google: "green.solid", direct: "orange.solid", other: "purple.solid",
};
const channelIds = Object.keys(channelLabel) as ChannelId[];
const statusLabel: Record<InquiryStatus, string> = { new: "New", replied: "Replied", call_booked: "Call booked", won: "Won", lost: "Lost" };
const ranges = [{ value: "30", label: "Last 30 days" }, { value: "7", label: "Last 7 days" }, { value: "90", label: "Last 90 days" }];
const defaults = { range: "30", channel: "all", project: "all", device: "all" };
type Filters = typeof defaults;

const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const Dot = ({ id }: { id: ChannelId }) => <Box boxSize="2" rounded="full" bg={channelColor[id]} flexShrink={0} />;

function Change({ now, then, days }: { now: number; then: number | null; days: number }) {
  if (then === null) return null;
  if (then === 0) return <Text textStyle="xs" color="fg.muted">0 in previous {days} days</Text>;
  const pct = Math.round((100 * (now - then)) / then);
  return (
    <HStack gap="1" textStyle="xs" color={pct >= 0 ? "green.fg" : "red.fg"} justify="center">
      <Icon as={pct >= 0 ? ArrowUpRight : ArrowDownRight} boxSize="3.5" /><Text>{Math.abs(pct)}% vs previous {days} days</Text>
    </HStack>
  );
}

function NeedsReply({ report, onReplied, errors }: {
  report: WebsiteReport;
  onReplied: (id: string) => void;
  errors: ReadonlySet<string>;
}) {
  const waiting = report.inquiries.filter((i) => i.status === "new");
  if (!waiting.length) return null;
  return (
    <Box borderWidth="1px" borderColor="colorPalette.muted" bg="colorPalette.subtle" rounded="l2" px="4" py="3" role="region" aria-label="Inquiries needing a reply">
      <Stack gap="2">
        <Text textStyle="sm" fontWeight="semibold">{waiting.length} {waiting.length > 1 ? "inquiries need" : "inquiry needs"} a reply</Text>
        {waiting.map((i) => (
          <Stack key={i.id} gap="1">
            <HStack gap="4" flexWrap="wrap" textStyle="sm">
              <Text fontWeight="medium">{i.name}</Text>
              <Text color="fg.muted" flex="1" truncate>{i.topic}</Text>
              <HStack gap="1.5" color="fg.muted"><Dot id={i.channel} />{channelLabel[i.channel]}</HStack>
              <Text color="fg.muted">{date.format(new Date(i.receivedAt))}</Text>
              {i.email && <Button asChild size="xs" variant="solid"><a href={`mailto:${i.email}?subject=${encodeURIComponent(`Re: ${i.topic}`)}`}>Reply</a></Button>}
              <Button size="xs" variant="outline" onClick={() => onReplied(i.id)}>Mark replied</Button>
            </HStack>
            {errors.has(i.id) && <Text role="alert" textStyle="sm" color="fg.error">Couldn’t save the inquiry status. Try again.</Text>}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

type MetricKey = "visitors" | "avgActiveSeconds" | "contactClicks";
const prevKey = { visitors: "previousVisitors", avgActiveSeconds: "previousAvgActiveSeconds", contactClicks: "previousContactClicks" } as const;

function TrafficChart({ report }: { report: WebsiteReport }) {
  const [key, setKey] = useState<MetricKey>("visitors");
  const [split, setSplit] = useState("total");
  const days = report.range.days;
  const t = report.totals;
  const metrics = [
    { key: "visitors" as const, label: "Visitors", now: t.visitors, then: t.previousVisitors, fmt: (n: number) => n.toLocaleString("en") },
    { key: "avgActiveSeconds" as const, label: "Avg. active time", now: t.avgActiveSeconds, then: t.previousAvgActiveSeconds, fmt: clock },
    { key: "contactClicks" as const, label: "Contact clicks", now: t.contactClicks, then: t.previousContactClicks, fmt: (n: number) => String(n) },
  ];
  const shown = report.channels.map((c) => c.id);
  const byChannel = key === "visitors" && split === "channel";
  const hasPrevious = report.previousPeriod !== "unavailable";
  const previousLabel = report.previousPeriod === "partial" ? "Retained previous days" : `Previous ${days} days`;
  const rows = report.daily.map((d) => ({ ...d, ...(Object.fromEntries(channelIds.map((c) => [c, d.byChannel[c] ?? 0])) as Record<ChannelId, number>) }));
  const chart = useChart({
    data: rows,
    series: byChannel
      ? shown.map((c) => ({ name: c, label: channelLabel[c], color: channelColor[c], stackId: "a" }))
      : [{ name: key, label: "This period", color: "colorPalette.solid" }, ...(hasPrevious ? [{ name: prevKey[key], label: previousLabel, color: "gray.400" }] : [])],
  });
  const axis = { tick: { fontSize: 11, fill: chart.color("fg.muted") }, axisLine: false, tickLine: false } as const;
  const dayTick = (d: string) => { const t = Date.parse(d); return Number.isFinite(t) ? date.format(t) : String(d ?? ""); };
  return (
    <Box borderWidth="1px" rounded="l2" overflow="hidden">
      <Grid templateColumns="repeat(3, minmax(0,1fr))" borderBottomWidth="1px" role="tablist" aria-label="Chart metric">
        {metrics.map((x, i) => {
          const current = x.key === key;
          return (
            <chakra.button key={x.key} type="button" role="tab" aria-selected={current} onClick={() => setKey(x.key)} textAlign="center" px="4" py="4" cursor="pointer"
              borderLeftWidth={i ? "1px" : 0} bg={current ? "bg" : "bg.subtle"} position="relative" _hover={{ bg: "bg" }}
              _after={current ? { content: '""', position: "absolute", left: 0, right: 0, top: 0, h: "2px", bg: "colorPalette.solid" } : undefined}>
              <Text textStyle="xs" color="fg.muted">{x.label}</Text>
              <Text textStyle="2xl" fontWeight="semibold" fontVariantNumeric="tabular-nums" my="1">{x.fmt(x.now)}</Text>
              <Change now={x.now} then={x.then} days={days} />
            </chakra.button>
          );
        })}
      </Grid>
      <Box p="4">
        <Flex justify="space-between" align="center" mb="3" minH="8" gap="3" wrap="wrap">
          {byChannel ? <HStack gap="3" wrap="wrap">{shown.map((c) => <HStack key={c} gap="1.5" textStyle="xs"><Dot id={c} />{channelLabel[c]}</HStack>)}</HStack>
            : <HStack gap="4" textStyle="xs" color="fg.muted">
                <HStack gap="1.5"><Box w="4" h="0.5" bg="colorPalette.solid" />This period</HStack>
                {hasPrevious && <HStack gap="1.5"><Box w="4" borderTopWidth="1.5px" borderStyle="dashed" borderColor="gray.400" />{previousLabel}</HStack>}
              </HStack>}
          {key === "visitors" && <SegmentGroup.Root size="xs" value={split} onValueChange={(e) => setSplit(e.value ?? "total")}>
            <SegmentGroup.Indicator />
            <SegmentGroup.Items items={[{ value: "total", label: "Total" }, { value: "channel", label: "By channel" }]} />
          </SegmentGroup.Root>}
        </Flex>
        {report.previousPeriod !== "complete" && <Text textStyle="xs" color="fg.muted" mb="2">
          {report.previousPeriod === "partial" ? "Only part of the previous period is within 90-day retention." : "No complete previous days are within 90-day retention."}
        </Text>}
        <Chart.Root chart={chart} h="64" aria-label="Daily traffic">
          <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 900, height: 256 }}>
            {byChannel ? (
              <BarChart data={chart.data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={chart.color("border.muted")} />
                <XAxis dataKey="day" tickFormatter={dayTick} minTickGap={36} {...axis} />
                <YAxis width={28} allowDecimals={false} {...axis} />
                <Tooltip cursor={{ fill: chart.color("bg.muted") }} content={<Chart.Tooltip />} />
                {chart.series.map((s) => <Bar key={String(s.name)} dataKey={String(s.name)} stackId="a" fill={chart.color(s.color)} isAnimationActive={false} />)}
              </BarChart>
            ) : (
              <LineChart data={chart.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={chart.color("border.muted")} />
                <XAxis dataKey="day" tickFormatter={dayTick} minTickGap={36} {...axis} />
                <YAxis width={32} allowDecimals={false} tickFormatter={key === "avgActiveSeconds" ? clock : undefined} {...axis} />
                <Tooltip content={<Chart.Tooltip />} />
                {hasPrevious && <Line dataKey={prevKey[key]} stroke={chart.color("gray.400")} strokeDasharray="4 4" strokeWidth={1.5} dot={report.previousPeriod === "partial"} isAnimationActive={false} />}
                <Line dataKey={key} stroke={chart.color("colorPalette.solid")} strokeWidth={2.5} dot={false} isAnimationActive={false} type={key === "contactClicks" ? "step" : "linear"} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </Chart.Root>
      </Box>
    </Box>
  );
}

function Channels({ report, f, onPick }: { report: WebsiteReport; f: Filters; onPick: (c: ChannelId) => void }) {
  const cols = "minmax(120px,1fr) minmax(160px,1.4fr) 100px 100px 90px";
  const total = report.channels.reduce((s, c) => s + c.visitors, 0);
  const max = Math.max(1, ...report.channels.map((c) => c.visitors));
  return (
    <TableCard title="Where visitors come from" help="Click a channel to filter the page by it.">
      <Box overflowX="auto"><Box minW="620px">
        <Grid templateColumns={cols} gap="4" px="5" py="2" textStyle="xs" color="fg.muted" borderBottomWidth="1px">
          <Text>Channel</Text><Text>Visitors</Text><Text textAlign="right">Avg. active</Text><Text textAlign="right">Contact clicks</Text><Text textAlign="right">Inquiries</Text>
        </Grid>
        {report.channels.map((c) => (
          <chakra.button key={c.id} type="button" onClick={() => onPick(c.id)} aria-pressed={f.channel === c.id} display="grid" w="full" textAlign="left" gridTemplateColumns={cols} gap="4" px="5" py="2.5" alignItems="center"
            textStyle="sm" fontVariantNumeric="tabular-nums" borderBottomWidth="1px" borderColor="border.muted" _last={{ borderBottomWidth: 0 }} cursor="pointer" _hover={{ bg: "bg.subtle" }}
            bg={f.channel === c.id ? "bg.muted" : undefined}>
            <HStack gap="2"><Dot id={c.id} /><Text fontWeight="medium">{channelLabel[c.id]}</Text></HStack>
            <HStack gap="3">
              <Box flex="1" h="2" bg="bg.subtle" rounded="full" overflow="hidden"><Box h="full" w={`${(100 * c.visitors) / max}%`} bg={channelColor[c.id]} /></Box>
              <Text w="16" textAlign="right">{c.visitors} <Text as="span" color="fg.muted">{Math.round((100 * c.visitors) / Math.max(1, total))}%</Text></Text>
            </HStack>
            <Text textAlign="right">{clock(c.avgActiveSeconds)}</Text>
            <Text textAlign="right">{c.contactClicks}</Text>
            <Text textAlign="right" color={c.inquiries ? "fg" : "fg.subtle"}>{c.inquiries || "—"}</Text>
          </chakra.button>
        ))}
        {!report.channels.length && <Text p="5" textStyle="sm" color="fg.muted">No visitors match these filters.</Text>}
      </Box></Box>
    </TableCard>
  );
}

function Projects({ report, f, onPick }: { report: WebsiteReport; f: Filters; onPick: (path: string) => void }) {
  const [view, setView] = useState("top");
  const list = report.projects;
  const shown = report.channels.map((c) => c.id);
  const maxViews = Math.max(1, ...list.map((p) => p.views));
  const maxCell = Math.max(1, ...list.flatMap((p) => shown.map((c) => p.byChannel[c] ?? 0)));
  const topCols = "28px minmax(0,1fr) 90px 90px 180px";
  return (
    <TableCard title="Projects" help="Top: views and how far people read. By channel: views per channel; darker cells mean more. Click a project to filter the page by it."
      action={<SegmentGroup.Root size="xs" value={view} onValueChange={(e) => setView(e.value ?? "top")}>
        <SegmentGroup.Indicator /><SegmentGroup.Items items={[{ value: "top", label: "Top" }, { value: "channel", label: "By channel" }]} />
      </SegmentGroup.Root>}>
      {!list.length ? <Text p="5" textStyle="sm" color="fg.muted">No project views match these filters.</Text> : view === "top" ? <>
        <Grid templateColumns={topCols} gap="3" px="5" py="2" textStyle="xs" color="fg.muted" borderBottomWidth="1px">
          <Text /><Text>Project</Text><Text textAlign="right">Avg. active</Text><Text textAlign="right">Read to 75%</Text><Text textAlign="right">Views</Text>
        </Grid>
        {list.map((p, i) => (
          <chakra.button key={p.path} type="button" onClick={() => onPick(p.path)} aria-pressed={f.project === p.path} display="grid" w="full" textAlign="left" gridTemplateColumns={topCols} gap="3" px="5" py="2.5" alignItems="center"
            textStyle="sm" borderBottomWidth="1px" borderColor="border.muted" _last={{ borderBottomWidth: 0 }} fontVariantNumeric="tabular-nums" cursor="pointer" _hover={{ bg: "bg.subtle" }}
            bg={f.project === p.path ? "bg.muted" : undefined}>
            <Text color="fg.muted">{i + 1}</Text>
            <Text truncate fontWeight="medium">{p.title}</Text>
            <Text textAlign="right">{clock(p.avgActiveSeconds)}</Text>
            <Text textAlign="right" color={p.readTo75Percent === null ? "fg.subtle" : "fg"}>{p.readTo75Percent === null ? "—" : `${p.readTo75Percent}%`}</Text>
            <HStack gap="2" justify="end">
              <Box w="24" h="1.5" bg="bg.subtle" rounded="full" overflow="hidden"><Box h="full" w={`${(100 * p.views) / maxViews}%`} bg="colorPalette.solid" /></Box>
              <Text w="8" textAlign="right">{p.views}</Text>
            </HStack>
          </chakra.button>
        ))}
      </> : <Box overflowX="auto">
        <Grid templateColumns={`minmax(160px,1.4fr) repeat(${shown.length}, minmax(72px,1fr))`} minW={`${200 + shown.length * 80}px`} textStyle="sm" fontVariantNumeric="tabular-nums" role="table" aria-label="Project views by channel">
          <Text px="5" py="2" textStyle="xs" color="fg.muted" borderBottomWidth="1px">Project</Text>
          {shown.map((c) => <Text key={c} py="2" px="2" textAlign="center" textStyle="xs" color="fg.muted" borderBottomWidth="1px">{channelLabel[c]}</Text>)}
          {list.map((p) => (
            <Box key={p.path} display="contents">
              <Text px="5" py="2.5" truncate fontWeight="medium" borderBottomWidth="1px" borderColor="border.muted">{p.title}</Text>
              {shown.map((c) => {
                const v = p.byChannel[c] ?? 0, t = v / maxCell;
                return (
                  <Box key={c} p="1" borderBottomWidth="1px" borderColor="border.muted">
                    <Box minH="8" rounded="l1" display="flex" alignItems="center" justifyContent="center" position="relative" overflow="hidden">
                      <Box position="absolute" inset="0" bg="colorPalette.solid" opacity={0.06 + t * 0.84} />
                      <Text position="relative" color={t > 0.45 ? "white" : "fg"}>{v}</Text>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          ))}
        </Grid>
      </Box>}
    </TableCard>
  );
}

export function Website() {
  const { values: f, set, active, clear } = useUrlFilters(defaults, ["range"]);
  const query = new URLSearchParams({ range: f.range });
  for (const k of ["channel", "project", "device"] as const) if (f[k] !== "all") query.set(k, f[k]);
  const report = useReport<WebsiteReport>(`${websiteReportPath}?${query}`);
  const [replied, setReplied] = useState<ReadonlySet<string>>(() => new Set());
  const [inquiryErrors, setInquiryErrors] = useState<ReadonlySet<string>>(() => new Set());
  async function markReplied(id: string) {
    setReplied(current => new Set(current).add(id));
    setInquiryErrors(current => new Set([...current].filter(value => value !== id)));
    try {
      const response = await fetch(`/api/v1/website-analytics/inquiries/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "replied" }),
      });
      if (!response.ok) throw new Error("Inquiry status update failed");
    } catch {
      setReplied(current => new Set([...current].filter(value => value !== id)));
      setInquiryErrors(current => new Set(current).add(id));
    }
  }
  const r = report.data && {
    ...report.data,
    inquiries: report.data.inquiries.map(inquiry => replied.has(inquiry.id) ? { ...inquiry, status: "replied" as const } : inquiry),
  };
  const project = r?.projects.find((p) => p.path === f.project);
  const who = [f.channel !== "all" && `from ${channelLabel[f.channel as ChannelId] ?? f.channel}`, f.device !== "all" && `on ${f.device}`, f.project !== "all" && `who viewed ${project?.title ?? f.project}`].filter(Boolean).join(" ");
  const open = r?.inquiries.filter((i) => i.status === "new" || i.status === "replied" || i.status === "call_booked") ?? [];
  return (
    <AnalyticsShell facts={r ? [
      { label: "Contact rate", value: `${((100 * r.totals.contactClicks) / Math.max(1, r.totals.visitors)).toFixed(1)}%` },
      { label: "Inquiries", value: r.inquiries.length },
      { label: "Open inquiries", value: <HStack gap="2">{open.length}{open.some((i) => i.status === "new") && <Badge size="sm" colorPalette="blue">{open.filter((i) => i.status === "new").length} new</Badge>}</HStack> },
      { label: "Won", value: r.inquiries.filter((i) => i.status === "won").length },
    ] : undefined}>
      <FilterBar active={active} onClear={clear}
        range={<FilterSelect label="Date range" value={f.range} onChange={(v) => set({ range: v })} items={ranges} highlightActive={false} size="sm" w="40" />}>
        <FilterSelect label="Channel" value={f.channel} onChange={(v) => set({ channel: v })} size="sm" w="36"
          items={[{ value: "all", label: "All channels" }, ...channelIds.map((c) => ({ value: c, label: channelLabel[c] }))]} />
        <FilterSelect label="Project" value={f.project} onChange={(v) => set({ project: v })} size="sm" w="44"
          items={[{ value: "all", label: "All projects" }, ...(r?.projects ?? []).map((p) => ({ value: p.path, label: p.title }))]} />
        <FilterSelect label="Device" value={f.device} onChange={(v) => set({ device: v })} size="sm" w="32"
          items={[{ value: "all", label: "All devices" }, { value: "desktop", label: "Desktop" }, { value: "mobile", label: "Mobile" }]} />
      </FilterBar>
      {!r ? <ReportState {...report} /> : <Box opacity={report.loading ? 0.6 : 1} transition="opacity 150ms" aria-busy={report.loading}>
        <Stack gap="5">
          {report.error && <ReportState loading={false} error={report.error} retry={report.retry} />}
          <NeedsReply report={r} onReplied={markReplied} errors={inquiryErrors} />
          <Text as="p" textStyle="2xl" fontWeight="semibold">{r.totals.visitors.toLocaleString("en")} visitors {who ? `${who} ` : ""}in the last {r.range.days} days</Text>
          <TrafficChart report={r} />
          <Channels report={r} f={f} onPick={(c) => set({ channel: f.channel === c ? "all" : c })} />
          <Projects report={r} f={f} onPick={(path) => set({ project: f.project === path ? "all" : path })} />
          <TrackingLine status={r} />
        </Stack>
      </Box>}
    </AnalyticsShell>
  );
}
