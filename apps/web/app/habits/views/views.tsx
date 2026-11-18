"use client";
import { useHabitsData } from "./habits-data";
// Habits views (#176). Layouts follow the agreed design pass; data comes from HabitsData (stub until the API is wired).
//   Today (log) → Habit (detail) · Ask (what do I do right now?). Summary and the habits table live in their own files.
import { Box, Button, Flex, Grid, HStack, Icon, SimpleGrid, Stack, Text, Textarea, chakra } from "@chakra-ui/react";
import { FilterSelect } from "@/components/shared/filter-select";
import { ArrowLeft, Clock, CornerDownLeft, MapPin, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { CalendarGrid, Cell, Eyebrow, Legend, Meter, Num, Panel, cellFill, stateLabel } from "./parts";
import {
  AUTOMATIC_K, DAYS, atRisk, automaticity, chain, counts, feelings, fmt, gate, recovery, weeklyVotes,
  lifetimeReps, missesByWeekday, recent, type Ask, type Habit, type State,
} from "./habit-metrics";

export type Hist = Record<string, State[]>;
export type Ctx = { hist: Hist; set: (id: string, i: number, s: State) => void; open: (habitId: string) => void; habitId: string; go: (variant: string) => void };
const T = DAYS - 1;
const clock = (a: string) => { if (!a) return "–"; const [h, m] = a.split(":").map(Number); return `${h! % 12 || 12}:${String(m).padStart(2, "0")} ${h! < 12 ? "am" : "pm"}`; };
const isDoubleMiss = (h: State[], i: number) => h[i] === "missed" && h.slice(0, i).reverse().find((s) => s !== "none" && s !== "skipped" && s !== "open") === "missed";
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function TodayControl({ habit, ctx, size = "xs" }: { habit: Habit; ctx: Ctx; size?: "xs" | "sm" }) {
  const s = ctx.hist[habit.id]![T]!;
  if (s === "none") return <Text textStyle="xs" color="fg.subtle">Not today</Text>;
  const opts: [State, string][] = [["done", "Done"], ["minimum", "Minimum"], ["skipped", "Skip"]];
  return (
    <HStack gap="0" borderWidth="1px" rounded="sm" overflow="hidden" flexShrink={0}>
      {opts.map(([k, label], i) => (
        <chakra.button key={k} type="button" aria-pressed={s === k} onClick={() => ctx.set(habit.id, T, s === k ? "open" : k)}
          px={size === "sm" ? "3" : "2"} h={size === "sm" ? "8" : "6"} textStyle="xs" fontWeight="medium" borderLeftWidth={i ? "1px" : 0}
          bg={s === k ? (k === "skipped" ? "bg.emphasized" : "brand.solid") : "bg"} color={s === k ? (k === "skipped" ? "fg" : "brand.contrast") : "fg.muted"}
          _hover={{ bg: s === k ? undefined : "bg.muted" }} cursor="pointer">{label}</chakra.button>
      ))}
    </HStack>
  );
}

function HabitLink({ id, ctx, children }: { id: string; ctx: Ctx; children: React.ReactNode }) {
  return <chakra.button type="button" onClick={() => ctx.open(id)} textAlign="left" cursor="pointer" _hover={{ textDecoration: "underline", textUnderlineOffset: "3px", textDecorationColor: "fg.subtle" }}>{children}</chakra.button>;
}

// Ring for "today" progress. Single accent, no gradient.
function Ring({ value, max, size = 96 }: { value: number; max: number; size?: number }) {
  const r = size / 2 - 6, c = 2 * Math.PI * r, f = max ? value / max : 0;
  return (
    <Box position="relative" boxSize={`${size}px`} flexShrink={0}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${max} logged`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chakra-colors-bg-emphasized)" strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chakra-colors-brand-solid)" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${c * f} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dasharray .3s" }} />
      </svg>
      <Flex position="absolute" inset="0" align="center" justify="center" direction="column">
        <Num textStyle="xl" fontWeight="semibold" lineHeight="1">{value}<Text as="span" color="fg.subtle" textStyle="sm">/{max}</Text></Num>
      </Flex>
    </Box>
  );
}

/* ================= TODAY: Structured-style timeline. Logging only. Names drill into the Habit page. ================= */
export function RoutineView({ ctx }: { ctx: Ctx }) {
  const { build, stacks, dates } = useHabitsData();
  const isSunday = dates[T]!.getDay() === 0;
  const todays = build.filter((h) => ctx.hist[h.id]![T] !== "none");
  const logged = todays.filter((h) => counts(ctx.hist[h.id]![T]!)).length;
  // This week (Mon → today): one cell per stack per day; full when every habit in the stack counted.
  const monday = T - ((dates[T]!.getDay() + 6) % 7);
  const week = Array.from({ length: 7 }, (_, j) => monday + j);
  const stackCell = (stackId: string, i: number): State => {
    if (i > T) return "none";
    const st = build.filter((h) => h.stack === stackId).map((h) => ctx.hist[h.id]![i]!).filter((s) => s !== "none");
    if (!st.length) return "none";
    if (i === T && st.some((s) => s === "open")) return st.some(counts) ? "minimum" : "open";
    if (st.every(counts)) return "done";
    return st.some(counts) ? "minimum" : st.every((s) => s === "skipped") ? "skipped" : "missed";
  };
  return (
    <Grid templateColumns={{ base: "1fr", lg: "minmax(0,1fr) 260px" }} gap="6" alignItems="start">
      <Stack gap="0">
        {stacks.map((st, si) => {
          const rows = build.filter((h) => h.stack === st.id);
          const done = rows.filter((h) => counts(ctx.hist[h.id]![T]!)).length;
          const off = rows.length > 0 && rows.every(h => ctx.hist[h.id]![T] === "none");
          return (
            <Grid key={st.id} templateColumns="64px 20px 1fr" columnGap="3" opacity={off ? 0.55 : 1}>
              <Num textStyle="xs" color="fg.muted" pt="3" textAlign="right">{clock(st.anchor)}</Num>
              <Flex direction="column" align="center">
                <Box mt="3.5" boxSize="2.5" rounded="full" borderWidth="2px" borderColor={done === rows.length && !off ? "brand.solid" : "border.emphasized"} bg={done === rows.length && !off ? "brand.solid" : "bg"} />
                {si < stacks.length - 1 && <Box flex="1" w="1px" bg="border" />}
              </Flex>
              <Panel mb="5">
                <HStack justify="space-between" px="4" py="3" borderBottomWidth="1px">
                  <Stack gap="0.5">
                    <Text textStyle="sm" fontWeight="semibold">{st.name}</Text>
                    <HStack gap="3" color="fg.muted" textStyle="xs"><HStack gap="1"><Icon as={Clock} boxSize="3" />{st.minutes} min</HStack><HStack gap="1"><Icon as={MapPin} boxSize="3" />{st.place}</HStack></HStack>
                  </Stack>
                  <Num textStyle="xs" color="fg.muted">{off ? (st.scheduleLabel ?? "Sundays") : `${done}/${rows.length}`}</Num>
                </HStack>
                <Stack gap="0" px="4" py="2">
                  <Text textStyle="xs" color="fg.subtle" py="1.5">{st.cue}</Text>
                  {rows.map((h, i) => {
                    const hs = ctx.hist[h.id]!, risk = atRisk(hs);
                    return (
                      <HStack key={h.id} gap="3" py="2" borderTopWidth={i ? "1px" : 0} borderStyle="dashed" align="center">
                        <Cell state={hs[T]!} size={14} />
                        <Stack gap="0" flex="1" minW="0">
                          <Text textStyle="sm" truncate><Text as="span" color="fg.muted">{i ? "then " : "I will "}</Text><HabitLink id={h.id} ctx={ctx}>{h.name.toLowerCase()}</HabitLink></Text>
                          <Text textStyle="xs" color={risk ? "orange.fg" : "fg.subtle"} truncate>{risk ? "Missed last time. Do the minimum: " + h.minimum.toLowerCase() : `${h.full} · or ${h.minimum.toLowerCase()}`}</Text>
                        </Stack>
                        {!off && <TodayControl habit={h} ctx={ctx} />}
                      </HStack>
                    );
                  })}
                </Stack>
              </Panel>
            </Grid>
          );
        })}
      </Stack>
      <Stack gap="4" position={{ lg: "sticky" }} top="4">
        <Panel>
          <HStack gap="4" p="4">
            <Ring value={logged} max={todays.length} />
            <Stack gap="2" flex="1">
              {stacks.filter((st) => build.some(h => h.stack === st.id && ctx.hist[h.id]![T] !== "none")).map((st) => {
                const rows = build.filter((h) => h.stack === st.id);
                return (
                  <Stack key={st.id} gap="1">
                    <HStack justify="space-between"><Text textStyle="xs" color="fg.muted">{st.name.split(" ")[0]}</Text><Num textStyle="xs" color="fg.muted">{rows.filter((h) => counts(ctx.hist[h.id]![T]!)).length}/{rows.length}</Num></HStack>
                    <HStack gap="1">{rows.map((h) => <Box key={h.id} flex="1" h="1.5" rounded="full" bg={counts(ctx.hist[h.id]![T]!) ? "brand.solid" : ctx.hist[h.id]![T] === "skipped" ? "fg.subtle" : "bg.emphasized"} />)}</HStack>
                  </Stack>
                );
              })}
            </Stack>
          </HStack>
        </Panel>
        <Panel>
          <Eyebrow>This week</Eyebrow>
          <Grid templateColumns="auto repeat(7, 1fr)" gap="2" p="4" alignItems="center">
            <Box />
            {week.map((i, j) => <Text key={i} textStyle="2xs" color={i === T ? "fg" : "fg.subtle"} fontWeight={i === T ? "semibold" : undefined} textAlign="center">{"MTWTFSS"[j]}</Text>)}
            {stacks.map((st) => [
              <Text key={st.id} textStyle="xs" color="fg.muted" pr="1">{st.name.split(" ")[0]}</Text>,
              ...week.map((i) => <Box key={st.id + i} display="grid" placeItems="center"><Cell state={stackCell(st.id, i)} size={14} label={i > T ? "Upcoming" : `${st.name} · ${fmt(dates[i]!, { weekday: "long" })} · ${stateLabel[stackCell(st.id, i)]}`} /></Box>),
            ])}
          </Grid>
        </Panel>
        <Button variant="outline" size="sm" onClick={() => ctx.go("ask")}><Icon as={Sparkles} boxSize="3.5" />Struggling with a habit?</Button>
      </Stack>
    </Grid>
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;
// Put each label above or below its dot; skip it (tooltip only) when both sides collide.
function placeLabels<P extends { label: string; cx: number; cy: number }>(pts: P[], W: number) {
  const boxes: { x1: number; x2: number; y1: number; y2: number }[] = pts.map((p) => ({ x1: p.cx - 5, x2: p.cx + 5, y1: p.cy - 5, y2: p.cy + 5 }));
  const hit = (b: { x1: number; x2: number; y1: number; y2: number }) => boxes.some((o) => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  return [...pts].sort((a, b) => a.cx - b.cx).map((p) => {
    const w = p.label.length * 5.6, right = p.cx + 8 + w < W - 4, lx = right ? p.cx + 8 : p.cx - 8, anchor: "start" | "end" = right ? "start" : "end";
    for (const dy of [-7, 15, -19, 27]) {
      const ly = r1(p.cy + dy), b = { x1: right ? lx : lx - w, x2: right ? lx + w : lx, y1: ly - 10, y2: ly + 2 };
      if (!hit(b)) { boxes.push(b); return { ...p, lx: r1(lx), ly, anchor }; }
    }
    return { ...p, lx: 0, ly: null as number | null, anchor };
  });
}

/* Learning curve (Clear, ch. 11: frequency, not time). x = reps, y = estimated automaticity. */
function LearningCurve({ points, height = 180, width = 520 }: { points: { id: string; label: string; reps: number; strong?: boolean }[]; height?: number; width?: number }) {
  const W = width, H = height, pad = { l: 28, r: 12, t: 12, b: 24 }, maxX = 120;
  const x = (r: number) => r1(pad.l + (Math.min(r, maxX) / maxX) * (W - pad.l - pad.r));
  const y = (a: number) => r1(pad.t + (1 - a) * (H - pad.t - pad.b));
  const path = Array.from({ length: 61 }, (_, i) => (i / 60) * maxX).map((r, i) => `${i ? "L" : "M"}${x(r).toFixed(1)} ${y(automaticity(r)).toFixed(1)}`).join(" ");
  const line = 0.9;
  return (
    <chakra.svg viewBox={`0 0 ${W} ${H}`} w="full" h="auto" role="img" aria-label="Estimated automaticity by repetitions">
      <line x1={pad.l} x2={W - pad.r} y1={y(line)} y2={y(line)} stroke="var(--chakra-colors-border-emphasized)" strokeDasharray="4 4" />
      <text x={W - pad.r} y={y(line) - 5} textAnchor="end" fontSize="10" fill="var(--chakra-colors-fg-muted)">Habit line (est.)</text>
      {[0, 30, 60, 90, 120].map((r) => <text key={r} x={x(r)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--chakra-colors-fg-subtle)">{r}</text>)}
      <text x={pad.l - 6} y={y(0) + 3} textAnchor="end" fontSize="10" fill="var(--chakra-colors-fg-subtle)">0</text>
      <path d={path} fill="none" stroke="var(--chakra-colors-fg-subtle)" strokeWidth="1.5" />
      {placeLabels(points.map((p) => ({ ...p, cx: r1(x(p.reps)), cy: r1(y(automaticity(p.reps))) })), W).map((p) => (
        <g key={p.id}>
          <title>{`${p.label}: ${p.reps} reps`}</title>
          <circle cx={p.cx} cy={p.cy} r={p.strong ? 5 : 4} fill="var(--chakra-colors-brand-solid)" stroke="var(--chakra-colors-bg)" strokeWidth="2" />
          {p.ly !== null && <text x={p.lx} y={p.ly} textAnchor={p.anchor} fontSize="10.5" fill="var(--chakra-colors-fg)">{p.label}</text>}
        </g>
      ))}
    </chakra.svg>
  );
}

// Weekly votes for an identity, 13 bars, oldest first. Last bar is the current (partial) week.
/* ================= HABIT: Linear issue page. Reached from Today; shows how this one habit is going. ================= */
export function HabitView({ ctx }: { ctx: Ctx }) {
  const { build, stacks, dates, facts } = useHabitsData();
  const h = build.find((x) => x.id === ctx.habitId)!, hs = ctx.hist[h.id]!, g = facts[h.id]?.gate ?? gate(h, hs), st = stacks.find((s) => s.id === h.stack)!;
  const all = recent(hs, DAYS), reps = facts[h.id]?.reps ?? lifetimeReps(hs), auto = automaticity(reps), votes = weeklyVotes(hs), rec = recovery(hs);
  const toLine = Math.max(0, Math.ceil(-AUTOMATIC_K * Math.log(0.1)) - reps);
  const props: [string, React.ReactNode][] = [
    ["Status", h.status[0]!.toUpperCase() + h.status.slice(1)], ["Stack", st.name], ["Cue", h.cue || st.cue], ["When", `${clock(st.anchor)} · ${st.place}`],
    ["Gate", `${h.gate.required} of ${h.gate.window} ${h.weekly ? "weeks" : "days"}`], ["Started", h.started],
  ];
  return (
    <Stack gap="3">
      {/* No outer card: sections sit directly on the page; quick stats live in the page header. */}
      <Grid templateColumns={{ base: "1fr", lg: "minmax(0,1fr) 300px" }} gap="5" alignItems="start">
        <Stack gap="5" minW="0">
          <Panel>
            <Eyebrow right={<Text textStyle="xs" color="fg.subtle">Last 26 weeks</Text>}>History</Eyebrow>
            <Stack gap="3" p="4">
              <CalendarGrid label={`${h.name} history`} days={hs.map((s, i) => ({
                date: dates[i]!, outline: s === "open", fill: cellFill(s, s === "missed" && isDoubleMiss(hs, i)),
                title: `${fmt(dates[i]!, { weekday: "short", month: "short", day: "numeric" })} · ${s === "missed" && isDoubleMiss(hs, i) ? "Missed twice in a row" : stateLabel[s]}`,
              })).slice(-182)} />
              <Legend />
            </Stack>
          </Panel>
          <Panel>
            <Eyebrow right={<Num textStyle="xs" color="fg.subtle">{reps} reps</Num>}>Becoming automatic</Eyebrow>
            <Box p="4"><LearningCurve points={[{ id: h.id, label: "You", reps, strong: true }]} height={160} width={640} /></Box>
            <Text px="4" pb="3" textStyle="xs" color="fg.subtle">{toLine ? `About ${toLine} more reps to the habit line.` : "Past the habit line."} Counts reps, not days.</Text>
          </Panel>
          <Panel>
            {[["Minimum version", h.minimum], ["Full version", h.full], ["If I miss", h.fallback ?? "No fallback yet"]].map(([l, val], i) => (
              <Grid key={l} templateColumns="140px minmax(0,1fr)" gap="4" px="4" py="3" borderTopWidth={i ? "1px" : 0}><Text textStyle="xs" color="fg.muted" pt="0.5">{l}</Text><Text textStyle="sm">{val}</Text></Grid>
            ))}
          </Panel>
        </Stack>
        <Panel position={{ lg: "sticky" }} top="4">
          <Stack gap="2" p="4" borderBottomWidth="1px">
            <Text textStyle="xs" color="fg.muted">Today</Text>
            <TodayControl habit={h} ctx={ctx} size="sm" />
            {atRisk(hs) && <Text textStyle="xs" color="orange.fg">Missed last time. The minimum is enough today.</Text>}
          </Stack>
          <Stack gap="0" p="2">
            {props.map(([l, val]) => <Grid key={l} templateColumns="88px minmax(0,1fr)" gap="2" px="2" py="2"><Text textStyle="xs" color="fg.muted">{l}</Text><Text textStyle="sm">{val}</Text></Grid>)}
          </Stack>
          <Stack gap="1" p="4" borderTopWidth="1px">
            <Text textStyle="xs" color="fg.muted">Gate</Text>
            <Meter value={g.reps} max={h.gate.required} />
            <Num textStyle="xs" color="fg.muted">{g.reps} of {h.gate.required} reps · {Math.max(0, g.left)} misses left</Num>
          </Stack>
        </Panel>
      </Grid>
    </Stack>
  );
}

/* ================= ASK: "I feel X and have to do Y. What now?" Answered by the LLM (Jarvis) from the habit's own system. Asking is the log. ================= */
export function AskView({ ctx }: { ctx: Ctx }) {
  const { habits, build, stacks, asks: savedAsks, ask: sendAsk, stub, asksLoading, asksError, retry } = useHabitsData();
  // Unstructured: pick the habit, type what's going on. The model (Jarvis) reads the feeling from the words; here a keyword match stands in.
  const [habitId, setHabitId] = useState<string>(build.find((h) => atRisk(ctx.hist[h.id]!))?.id ?? habits[0]?.id ?? "");
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<null | { feeling: string; habit: Habit; text: string; model?: { lead: string; step: string; support: string } }>(null);
  const [previewLog, setLog] = useState<Ask[]>(savedAsks);
  const log = stub ? previewLog : savedAsks;
  const [asking, setAsking] = useState(false), [askError, setAskError] = useState<string | null>(null);
  const submitting = useRef(false);
  const attempt = useRef<{ habitId: string; text: string; id: string } | null>(null);
  const infer = (t: string) => {
    const m = t.toLowerCase();
    const rules: [RegExp, string][] = [[/tired|exhausted|wiped|sleepy|late/, "Tired"], [/busy|no time|swamped|deadline|work/, "Busy"], [/anxious|stress|worried|nervous/, "Anxious"],
      [/bored|boring/, "Bored"], [/away|travel|trip|hotel|not home/, "Away from home"], [/energy|drained|sick|low/, "Low energy"], [/don't want|dont want|motivat|can't be bothered|meh/, "Unmotivated"]];
    return rules.find(([r]) => r.test(m))?.[1] ?? "Other";
  };
  const ask = async () => {
    if (submitting.current || !text.trim() || !habits.some(h => h.id === habitId)) return;
    const habit = habits.find((h) => h.id === habitId)!, moment = text.trim();
    if (stub) {
      const feeling = infer(moment);
      setAnswer({ feeling, habit, text: moment });
      setLog(previous => [{ day: "Today", feeling, habit: habitId, outcome: "unknown" }, ...previous]);
      setText(""); return;
    }
    if (attempt.current?.habitId !== habitId || attempt.current.text !== moment) attempt.current = { habitId, text: moment, id: crypto.randomUUID() };
    submitting.current = true; setAsking(true); setAskError(null);
    try {
      const result = await sendAsk({ habitId, text: moment }, attempt.current.id);
      if (!result.answer) throw Error("Jarvis did not return an answer. Retry the same ask.");
      setAnswer({ feeling: result.feeling, habit, text: moment, model: result.answer });
      setText(current => current.trim() === moment ? "" : current);
      attempt.current = null;
    } catch (e) { setAskError(e instanceof Error ? e.message : "Ask unavailable. Retry the same ask."); }
    finally { submitting.current = false; setAsking(false); }

  };
  const feelingCounts = [...feelings, "Other"].map((f) => ({ f, n: log.filter((a) => a.feeling === f).length, min: log.filter((a) => a.feeling === f && a.outcome === "did minimum").length, full: log.filter((a) => a.feeling === f && a.outcome === "did full").length })).filter((x) => x.n).sort((a, b) => b.n - a.n);
  const maxF = Math.max(...feelingCounts.map((x) => x.n), 1);
  const decided = log.filter((a) => a.outcome !== "unknown");
  const stillDid = decided.filter((a) => a.outcome !== "skipped").length;
  const past = answer ? log.slice(1).filter((a) => a.habit === answer.habit.id && a.feeling === answer.feeling && a.outcome === "did minimum").length : 0;
  const st = answer ? stacks.find((s) => s.id === answer.habit.stack)! : null;
  const habitItems = stacks.flatMap((stk) => habits.filter((h) => h.stack === stk.id).map((h) => ({ value: h.id, label: h.name })));
  const tracked = answer ? Boolean(ctx.hist[answer.habit.id]) : false;

  return (
    <Grid templateColumns={{ base: "1fr", lg: "minmax(0,1fr) 380px" }} gap="5" alignItems="start">
      <Stack gap="4">
        <Panel>
          <Stack gap="0">
            <HStack gap="3" px="4" py="2.5" borderBottomWidth="1px" bg="bg.subtle">
              <Text textStyle="xs" color="fg.muted" flexShrink={0}>Habit</Text>
              <FilterSelect label="Habit" size="sm" w="72" highlightActive={false} value={habitId} onChange={setHabitId} items={habitItems} />
            </HStack>
            <Textarea autoresize minH="24" border="0" rounded="0" px="4" py="3" textStyle="sm" resize="none" _focusVisible={{ outline: "none", boxShadow: "none" }}
              placeholder="What's going on? e.g. Wiped after a late shift and it's already 10:30." value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
            <HStack justify="space-between" px="4" py="2" borderTopWidth="1px">
              <Text textStyle="xs" color="fg.subtle">Enter to ask · Shift+Enter for a new line</Text>
              <Button size="xs" onClick={ask} loading={asking} disabled={!text.trim() || asking}>Ask<Icon as={CornerDownLeft} boxSize="3" /></Button>
            </HStack>
          </Stack>
        </Panel>
        {answer && st && (
          <Panel>
            <Eyebrow right={<Text textStyle="xs" color="fg.subtle">Read as: {answer.feeling.toLowerCase()}</Text>}>Answer · {answer.habit.name}</Eyebrow>
            <Stack gap="3" p="5" textStyle="sm">
              <Text color="fg.muted" truncate>&ldquo;{answer.text}&rdquo;</Text>
              {answer.habit.kind === "break" ? <>
                <Text>{answer.model?.lead ?? <>That&apos;s the moment the urge is strongest. Follow the protocol before deciding anything:</>}</Text>
                <Stack gap="1" borderLeftWidth="2px" borderColor="brand.solid" pl="3">{(answer.model ? [answer.model.step] : answer.habit.protocol ?? []).map((p, i) => <Text key={p}><Num color="fg.muted">{i + 1}.</Num> {p}</Text>)}</Stack>
                <Text color="fg.muted">{answer.model?.support ?? <>Then: {answer.habit.substitution?.toLowerCase()}.</>}</Text>
              </> : <>
                <Text>{answer.model?.lead ?? <>{answer.feeling === "Other" ? "Whatever the day looks like," : `Being ${answer.feeling.toLowerCase()} is a normal day for this habit, not a reason to skip it.`} Shrink it instead.</>}</Text>
                <Stack gap="1.5" borderLeftWidth="2px" borderColor="brand.solid" pl="3">
                  <Text fontWeight="medium">{answer.model?.step ?? (answer.habit.minimum ? `Do the minimum: ${answer.habit.minimum.toLowerCase()}.` : "Do the smallest version you can, even for one minute.")}</Text>
                  <Text color="fg.muted">{answer.model?.support ?? <>It counts as a rep. {answer.habit.fallback ?? `If the cue passes, do it at the next ${st.name.toLowerCase()} moment.`}</>}</Text>
                </Stack>
              </>}
              {past > 0 && <Text color="fg.muted">You were {answer.feeling.toLowerCase()} before {past} time{past > 1 ? "s" : ""} and still did the minimum.</Text>}
              <HStack gap="2" pt="1">
                {tracked && <Button size="xs" onClick={() => { if (!stub && ctx.hist[answer.habit.id]?.[T] === "none") { setAskError("This habit is not scheduled today."); return; } ctx.set(answer.habit.id, T, "minimum"); if (stub) setLog(([first, ...rest]) => [{ ...first!, outcome: "did minimum" }, ...rest]); setAnswer(null); }}>Log minimum</Button>}
                {tracked && <Button size="xs" variant="outline" onClick={() => ctx.open(answer.habit.id)}>Open habit</Button>}
                <Button size="xs" variant="ghost" onClick={() => setAnswer(null)}>Dismiss</Button>
              </HStack>
            </Stack>
          </Panel>
        )}
        {(!answer || askError || asksError) && <Text textStyle="xs" color={askError || asksError ? "red.fg" : "fg.subtle"} px="1" role={askError || asksError ? "alert" : undefined} tabIndex={asksError ? 0 : undefined} onKeyDown={asksError ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); retry(); } } : undefined} onClick={asksError ? retry : undefined}>{askError ?? (asksError ? `${asksError} Click to retry.` : asking ? "Asking Jarvis…" : asksLoading ? "Loading asks…" : stub ? <>In the app this goes to Jarvis with the habit&apos;s system and recent history. Here the answer is simulated.</> : "Jarvis uses this habit’s system and recent history.")}</Text>}
      </Stack>
      <Stack gap="4">
        <Panel>
          <SimpleGrid columns={2}>
            <Stack gap="0.5" p="4"><Text textStyle="xs" color="fg.muted">Asked, last 2 weeks</Text><Num textStyle="xl" fontWeight="semibold">{log.length}</Num></Stack>
            <Stack gap="0.5" p="4" borderLeftWidth="1px"><Text textStyle="xs" color="fg.muted">Still did it after asking</Text><Num textStyle="xl" fontWeight="semibold">{pct(stillDid, decided.length)}%</Num></Stack>
          </SimpleGrid>
        </Panel>
        <Panel>
          <Eyebrow right={<Text textStyle="xs" color="fg.subtle">Read from what you wrote</Text>}>What gets in the way</Eyebrow>
          <Stack gap="2.5" p="4">
            {feelingCounts.map((x) => (
              <Grid key={x.f} templateColumns="110px 1fr 24px" alignItems="center" gap="3">
                <Text textStyle="xs" truncate>{x.f}</Text>
                <HStack gap="0" h="2" rounded="full" overflow="hidden" bg="bg.emphasized">
                  <Box h="full" w={`${(x.full / maxF) * 100}%`} bg="brand.solid" /><Box h="full" w={`${(x.min / maxF) * 100}%`} bg="brand.300" /><Box h="full" w={`${((x.n - x.full - x.min) / maxF) * 100}%`} bg="fg.subtle" />
                </HStack>
                <Num textStyle="xs" color="fg.muted" textAlign="right">{x.n}</Num>
              </Grid>
            ))}
            <HStack gap="4" pt="1" wrap="wrap">{[["brand.solid", "Did full"], ["brand.300", "Did minimum"], ["fg.subtle", "Skipped or open"]].map(([c, l]) => <HStack key={l} gap="1.5"><Box boxSize="2" rounded="full" bg={c} /><Text textStyle="xs" color="fg.muted">{l}</Text></HStack>)}</HStack>
          </Stack>
        </Panel>
        <Panel>
          <Eyebrow>Recent</Eyebrow>
          {log.slice(0, 5).map((a, i) => (
            <Grid key={i} templateColumns="56px 1fr auto" gap="3" px="4" py="2" borderTopWidth={i ? "1px" : 0} alignItems="center">
              <Text textStyle="xs" color="fg.subtle">{a.day}</Text>
              <Text textStyle="xs" truncate><Text as="span" color="fg.muted">{a.feeling} · </Text>{habits.find((h) => h.id === a.habit)?.name ?? a.habit}</Text>
              <Text textStyle="xs" color="fg.muted">{a.outcome === "unknown" ? "–" : a.outcome}</Text>
            </Grid>
          ))}
        </Panel>
      </Stack>
    </Grid>
  );
}
