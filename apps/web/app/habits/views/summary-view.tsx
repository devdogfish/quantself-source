"use client";
import { useHabitsData } from "./habits-data";
// Habits Summary (#176): executive review of the system: health, readiness, activity, load, weak slots, decisions.
// No consistency trend: the Owner keeps raising difficulty (progressive overload), so a falling rate is not a failing system.
// Instead: what the system carries, how it recovers, and which slots and habits need a decision.
import { Box, Grid, HStack, SegmentGroup, SimpleGrid, Stack, Text, chakra } from "@chakra-ui/react";
import { useState } from "react";
import { DataGrid, DataGridRow } from "@/components/shared/data-panel";
import { Tooltip } from "@/components/chakra/tooltip";
import { CalendarGrid, Num, Panel } from "./parts";
import { fmt } from "./habit-metrics";
import type { Ctx } from "./views";

const v = (n: string) => `var(--chakra-colors-${n})`;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Section({ title, sub, right, children }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Panel>
      <HStack justify="space-between" gap="4" px="4" py="3" borderBottomWidth="1px">
        <Stack gap="0.5" minW="0"><Text textStyle="sm" fontWeight="semibold">{title}</Text>{sub && <Text textStyle="xs" color="fg.muted">{sub}</Text>}</Stack>
        {right}
      </HStack>
      {children}
    </Panel>
  );
}

/* GitHub contribution graph showing one dataset at a time: Completed (blue) or Missed (red). Never both at once. */
type Mode = "done" | "missed";
function ActivityGraph({ mode }: { mode: Mode }) {
  const { summary } = useHabitsData();
  const mix = (token: string, level: number) => `color-mix(in srgb, ${v(token)} ${level}%, ${v("bg-muted")})`;
  const days = summary!.activity.map(({ date, due, reps, misses, doubles, open }) => {
    const d = new Date(`${date}T12:00:00`);
    const f = due ? reps / due : 0;
    const fill = !due ? v("bg-muted")
      : mode === "done" ? (f === 0 ? v("bg-emphasized") : mix("brand-solid", f < 0.5 ? 25 : f < 0.75 ? 50 : f < 1 ? 75 : 100))
      : !misses ? v("bg-muted") : mix("red-500", doubles ? 100 : misses >= 3 ? 75 : misses === 2 ? 50 : 25);
    const when = fmt(d, { weekday: "short", month: "short", day: "numeric" });
    return { date: d, fill, outline: open,
      title: mode === "done" ? `${when}: ${reps} of ${due} done` : `${when}: ${misses} missed${doubles ? `, ${doubles} for the second time in a row` : ""}` };
  });
  const legend = mode === "done" ? { less: "Less", more: "More done", token: "brand-solid" } : { less: "1 miss", more: "Missed twice in a row", token: "red-500" };
  return (
    <Stack gap="3" px="4" py="4">
      <CalendarGrid days={days} label={`Daily ${mode === "done" ? "completed" : "missed"} habits`} />
      <HStack gap="1.5"><Text textStyle="xs" color="fg.muted">{legend.less}</Text>
        {[25, 50, 75, 100].map((l) => <Box key={l} boxSize="11px" rounded="2px" bg={mix(legend.token, l)} />)}
        <Text textStyle="xs" color="fg.muted">{legend.more}</Text></HStack>
    </Stack>
  );
}

/* What the system carries each week: habits on autopilot vs habits being built. Growth here is the goal; it doesn't punish harder habits. */
function LoadChart({ weeks }: { weeks: { label: string; auto: number; building: number }[] }) {
  const W = 560, H = 150, pl = 24, pb = 18, pt = 8, bw = (W - pl) / weeks.length;
  const max = Math.max(...weeks.map((w) => w.auto + w.building), 1);
  const y = (n: number) => Math.round((pt + (1 - n / max) * (H - pt - pb)) * 10) / 10;
  return (
    <chakra.svg viewBox={`0 0 ${W} ${H}`} w="full" h="auto" role="img" aria-label="Habits carried per week">
      {[0, Math.round(max / 2), max].map((g, i) => <g key={i}><line x1={pl} x2={W} y1={y(g)} y2={y(g)} stroke={v("border")} /><text x={pl - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill={v("fg-subtle")}>{g}</text></g>)}
      {weeks.map((w, i) => {
        const x = Math.round(pl + i * bw + 2), bwi = Math.round(bw - 4);
        return (
          <g key={i}>
            <title>{`${w.label}: ${w.auto} on autopilot, ${w.building} being built`}</title>
            <rect x={x} y={y(w.auto)} width={bwi} height={y(0) - y(w.auto)} fill={v("brand-solid")} />
            <rect x={x} y={y(w.auto + w.building)} width={bwi} height={y(w.auto) - y(w.auto + w.building)} fill={v("brand-300")} />
          </g>
        );
      })}
      <text x={pl} y={H - 4} fontSize="10" fill={v("fg-subtle")}>{weeks[0]?.label}</text>
      <text x={W} y={H - 4} textAnchor="end" fontSize="10" fill={v("fg-subtle")}>This week</text>
    </chakra.svg>
  );
}

/* Semicircle gauge, 0–100. One colour for the band; no gradient. */
function Gauge({ value, color }: { value: number; color: string }) {
  const R = 52, C = Math.PI * R, f = Math.max(0, Math.min(100, value)) / 100;
  const col = `var(--chakra-colors-${color.replace(".", "-")})`;
  return (
    <Box position="relative" w="140px" h="80px">
      <svg width="140" height="80" viewBox="0 0 140 80" role="img" aria-label={`System health ${value} of 100`}>
        <path d="M18 72 A52 52 0 0 1 122 72" fill="none" stroke={v("bg-emphasized")} strokeWidth="10" strokeLinecap="round" />
        <path d="M18 72 A52 52 0 0 1 122 72" fill="none" stroke={col} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(C * f).toFixed(1)} ${C.toFixed(1)}`} />
      </svg>
      <Num position="absolute" left="0" right="0" bottom="0" textAlign="center" textStyle="3xl" fontWeight="semibold" lineHeight="1">{value}</Num>
    </Box>
  );
}

export function SummaryView({ ctx }: { ctx: Ctx }) {
  const { summary } = useHabitsData();
  const [mode, setMode] = useState<Mode>("done");
  const { nWeeks, rec, doubles, passing, gateCount, checks, ready, wait, anchor, load, autoNow, autoThen, health, healthPrev, band, weakest, slots, maxRate, findings } = summary!;
  const tone = { risk: "red.solid", warn: "orange.solid", win: "green.solid" };
  const fcols = "8px minmax(160px,1fr) minmax(200px,1.3fr) minmax(220px,1.4fr)";

  const tiles: { label: string; value: React.ReactNode; sub: React.ReactNode }[] = [
    { label: "On autopilot", value: autoNow, sub: <><Num color="green.fg">+{autoNow - autoThen}</Num> in {nWeeks} weeks</> },
    { label: "Back the next time after a miss", value: `${pct(rec.r, rec.m)}%`, sub: `${rec.r} of ${rec.m} misses` },
    { label: "Missed twice in a row", value: doubles, sub: "Last 4 weeks" },
    { label: "Passing their gate", value: `${passing} of ${gateCount}`, sub: "Habits being built" },
  ];

  return (
    <Stack gap="5">
      <Grid templateColumns={{ base: "1fr", lg: "minmax(0,1.5fr) minmax(0,1fr)" }} gap="5" alignItems="stretch">
        <Panel>
          <Grid templateColumns={{ base: "1fr", md: "200px minmax(0,1fr)" }} h="full">
            <Stack gap="1" p="5" align="center" justify="center" borderRightWidth={{ md: "1px" }} borderBottomWidth={{ base: "1px", md: 0 }}>
              <Text textStyle="xs" color="fg.muted" alignSelf="start">System health</Text>
              <Gauge value={health.total} color={band.color} />
              <Text textStyle="sm" fontWeight="semibold">{band.word}</Text>
              <Text textStyle="xs" color="fg.subtle">{health.total === healthPrev.total ? "Same as 4 weeks ago" : <><Num color={health.total > healthPrev.total ? "green.fg" : "red.fg"}>{health.total > healthPrev.total ? "▲" : "▼"} {Math.abs(health.total - healthPrev.total)}</Num> vs 4 weeks ago</>}</Text>
            </Stack>
            <Stack gap="0" justify="center" py="2">
              {health.parts.map((x) => (
                <Tooltip key={x.key} content={`${x.hint} Weight ${x.weight}%.`} openDelay={150}>
                  <Grid templateColumns="88px minmax(0,1fr) 28px" gap="3" alignItems="center" px="4" h="9">
                    <Text textStyle="sm" color={x.key === weakest.key ? "fg" : "fg.muted"} fontWeight={x.key === weakest.key ? "medium" : undefined} truncate>{x.key}</Text>
                    <Box h="1.5" bg="bg.emphasized" rounded="full" overflow="hidden"><Box h="full" w={`${x.score}%`} rounded="full" bg={x.key === weakest.key ? "orange.solid" : "fg.subtle"} /></Box>
                    <Num textStyle="sm" textAlign="right" color={x.key === weakest.key ? "orange.fg" : "fg.muted"}>{x.score}</Num>
                  </Grid>
                </Tooltip>
              ))}
              <Text px="4" pt="1" textStyle="xs" color="fg.subtle" truncate>Weakest: {weakest.key.toLowerCase()}. {weakest.hint}</Text>
            </Stack>
          </Grid>
        </Panel>
        <Panel>
          <Stack gap="1" px="5" pt="5" pb="3">
            <Text textStyle="xs" color="fg.muted">Ready for a new habit?</Text>
            <HStack gap="2.5"><Box boxSize="2.5" rounded="full" bg={ready ? "green.solid" : "orange.solid"} /><Text textStyle="2xl" fontWeight="semibold" letterSpacing="-0.01em">{ready ? "Yes" : "Not yet"}</Text></HStack>
            <Text textStyle="xs" color="fg.subtle" truncate>{ready ? `Stack it after ${anchor?.name.toLowerCase() ?? "–"}` : checks.filter((c) => !c.ok).length === 1 && wait ? `Earliest in about ${wait} days` : `${checks.filter((c) => c.ok).length} of ${checks.length} conditions met`}</Text>
          </Stack>
          {checks.map((c) => (
            <Tooltip key={c.label} content={c.detail} openDelay={150}>
              <Grid templateColumns="10px minmax(0,1fr)" gap="3" alignItems="center" px="5" h="9" borderTopWidth="1px">
                <Box boxSize="2" rounded="full" bg={c.ok ? "green.solid" : "orange.solid"} />
                <Text textStyle="sm" truncate>{c.label}</Text>
              </Grid>
            </Tooltip>
          ))}
        </Panel>
      </Grid>

      <Panel>
        <SimpleGrid columns={{ base: 2, md: 4 }}>
          {tiles.map((t, i) => (
            <Stack key={t.label} gap="1" p="4" borderLeftWidth={{ base: i % 2 ? "1px" : 0, md: i ? "1px" : 0 }} borderTopWidth={{ base: i > 1 ? "1px" : 0, md: 0 }}>
              <Text textStyle="xs" color="fg.muted" truncate>{t.label}</Text>
              <Num textStyle="2xl" fontWeight="semibold" letterSpacing="-0.01em">{t.value}</Num>
              <Text textStyle="xs" color="fg.subtle" truncate>{t.sub}</Text>
            </Stack>
          ))}
        </SimpleGrid>
      </Panel>

      <Section title="Activity" right={
        <SegmentGroup.Root size="xs" value={mode} onValueChange={(e) => setMode(e.value as Mode)}>
          <SegmentGroup.Indicator /><SegmentGroup.Items items={[{ value: "done", label: "Completed" }, { value: "missed", label: "Missed" }]} />
        </SegmentGroup.Root>}>
        <ActivityGraph mode={mode} />
      </Section>

      <Grid templateColumns={{ base: "1fr", lg: "1.25fr 1fr" }} gap="5" alignItems="start">
        <Section title="What the system carries" sub="Habits per week. Harder or new habits add to this; they never count against you.">
          <Box p="4"><LoadChart weeks={load} /></Box>
          <HStack gap="4" px="4" pb="3">
            <HStack gap="1.5"><Box boxSize="2.5" rounded="2px" bg="brand.solid" /><Text textStyle="xs" color="fg.muted">On autopilot</Text></HStack>
            <HStack gap="1.5"><Box boxSize="2.5" rounded="2px" bg="brand.300" /><Text textStyle="xs" color="fg.muted">Being built</Text></HStack>
          </HStack>
        </Section>
        <Section title="Weakest slots" sub="Stack and weekday with the highest miss rate.">
          {slots.slice(0, 6).map((s, i) => (
            <Grid key={`${s.st.id}${s.d}`} templateColumns="minmax(0,1fr) 120px 44px" gap="3" alignItems="center" px="4" h="10" borderTopWidth={i ? "1px" : 0}>
              <Text textStyle="sm" truncate>{s.st.name} <Text as="span" color="fg.muted">· {weekdays[s.d]}</Text></Text>
              <Box h="1.5" bg="bg.emphasized" rounded="full" overflow="hidden"><Box h="full" w={`${(s.rate / maxRate) * 100}%`} bg={i === 0 ? "red.500" : "fg.subtle"} rounded="full" /></Box>
              <Num textStyle="sm" textAlign="right" color={i === 0 ? "red.fg" : "fg.muted"}>{s.rate}%</Num>
            </Grid>
          ))}
        </Section>
      </Grid>

      <Section title="Needs a decision" sub="Worst first.">
        <DataGrid label="Needs a decision" columns={fcols} minW="720px" headers={[{ label: "" }, { label: "What" }, { label: "Finding" }, { label: "Consider" }]}>
          {findings.map((f, i) => (
            <DataGridRow key={i} columns={fcols} href={f.habit ? `/habits/${f.habit}` : undefined}>
              <Box boxSize="2" rounded="full" bg={tone[f.tone]} />
              <Text truncate fontWeight="medium">{f.what}</Text>
              <Text truncate color="fg.muted">{f.why}</Text>
              <Text truncate>{f.change}</Text>
            </DataGridRow>
          ))}
        </DataGrid>
      </Section>

    </Stack>
  );
}
