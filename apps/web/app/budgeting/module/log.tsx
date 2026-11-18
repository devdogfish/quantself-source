"use client";

// Budgeting (#175) — the Log: where data is recorded. Quick-add on top, then the daily check-in
// (Atomic Habits applied, laid out after Sunsama's daily shutdown: left rail of steps, one step at a time).
// Step 1 is Copilot's To Review list. The tracked habit is the 2-minute check, not the outcome.
// Ideas used: never miss twice, visible progress (day cells), labeled savings for skipped spending,
// own-history benchmark, Goldilocks next step. No badges, confetti or streak shaming.
import { useState } from "react";
import { Box, Button, Flex, Grid, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { Check, Circle } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";
import { addDays, daysBetween, money, money0, short, useBudgetNumbers, useBudgetStore } from "./stub-store";
import { Amount, CategoryButton, ExpenseForm, num, ReceiptMark } from "./kit";
import { Frame } from "./frame";
import type { BudgetLogData } from "./transaction-client";

const steps = [
  { key: "confirm", title: "Confirm today", hint: "2 minutes" },
  { key: "week", title: "How the week is going", hint: "Own history" },
  { key: "skipped", title: "Skipped spending", hint: "Buffer fund" },
  { key: "next", title: "Next week", hint: "One small step" },
] as const;

export function BudgetLog() {
  const { log: data, transaction: status } = useBudgetStore();
  const [step, setStep] = useState(0);
  const log = data.value;
  const n = useBudgetNumbers();
  const done = [log?.checkedInToday, true, log?.skipped.some((x) => x.date === log.today), false];
  return (
    <Frame title="Log"
      facts={[
        { label: "Left this week", value: n.logLeft == null ? "—" : money(n.logLeft) },
        { label: "Per day", value: n.logLeft == null ? "—" : money(n.logLeft / n.daysLeft) },
        { label: "Days to go", value: log ? String(n.daysLeft) : "—" },
        { label: "To review", value: log ? String(log.unreviewed.length) : "—" },
      ]}>
    <Stack gap="6">

      <Stack gap="2" borderWidth="1px" rounded="l3" bg="bg" p="3">
        <Text textStyle="xs" color="fg.muted" fontWeight="medium">Add expense</Text>
        <ExpenseForm autoFocus={false} />
      </Stack>

      {status.error && <HStack role="status" gap="2"><Text color="red.fg" textStyle="sm">{status.error}</Text>
        {status.retryable && <Button size="xs" onClick={status.retry}>Retry save</Button>}
      </HStack>}
      {data.error && <HStack role="status"><Text color="red.fg" textStyle="sm">{data.error}</Text><Button size="xs" onClick={data.reload}>Retry</Button></HStack>}
      {data.loading && <Text role="status" textStyle="sm">Loading check-in…</Text>}
      {log && <Box borderWidth="1px" rounded="l3" bg="bg" overflow="hidden">
      {/* The check-in record belongs to the check-in, so it heads this panel rather than the page. */}
      <CheckInBar log={log} />
      <Grid templateColumns={{ base: "1fr", md: "15rem minmax(0,1fr)" }} minH="96" borderTopWidth="1px">
        <Stack gap="0" borderRightWidth={{ md: "1px" }} bg="bg.subtle" py="2">
          {steps.map((s, i) => (
            <HStack key={s.key} as="button" gap="3" px="4" py="2.5" textAlign="left" cursor="pointer" onClick={() => setStep(i)}
              bg={step === i ? "bg" : undefined} borderLeftWidth="2px" borderColor={step === i ? "fg" : "transparent"}>
              <Box color={done[i] ? "green.fg" : "fg.subtle"}>{done[i] ? <Check size={16} /> : <Circle size={16} />}</Box>
              <Stack gap="0"><Text textStyle="sm" fontWeight={step === i ? "semibold" : "medium"}>{s.title}</Text><Text textStyle="xs" color="fg.muted">{s.hint}</Text></Stack>
            </HStack>
          ))}
        </Stack>
        <Stack p="5" gap="4" minW="0">
          {step === 0 && <Confirm log={log} next={() => setStep(1)} />}
          {step === 1 && <Week log={log} />}
          {step === 2 && <Skipped log={log} />}
          {step === 3 && <Next log={log} />}
        </Stack>
      </Grid>
      </Box>}
    </Stack>
    </Frame>
  );
}

// Paperclip strategy: one cell per day this month the transactions were confirmed. One line: title (and the
// never-miss-twice note when yesterday was missed) left, cells and count right.
function CheckInBar({ log }: { log: BudgetLogData }) {
  const month = log.today.slice(0, 7) + "-01";
  const nextMonth = addDays(month, 32).slice(0, 7) + "-01";
  const days = Array.from({ length: daysBetween(month, nextMonth) }, (_, i) => addDays(month, i));
  const yesterdayMissed = !log.loggedDays.includes(addDays(log.today, -1));
  return (
    <Flex justify="space-between" align="center" gap="4" wrap="wrap" px="4" py="3" bg="bg.subtle">
      <HStack gap="3" minW="0">
        <Text textStyle="sm" fontWeight="semibold">Daily check-in</Text>
        {yesterdayMissed && <Text textStyle="xs" color="orange.fg" truncate>Yesterday was missed. Checking in today keeps it to one.</Text>}
      </HStack>
      <HStack gap="3">
        <HStack gap="1">
          {days.map((d) => {
            const on = log.loggedDays.includes(d), future = d > log.today;
            return <Tooltip key={d} content={short(d)}><Box boxSize="2.5" rounded="2px" bg={on ? "fg" : future ? "bg.muted" : "bg.emphasized"} outline={d === log.today ? "1.5px solid" : undefined} outlineColor="fg.muted" outlineOffset="1px" /></Tooltip>;
          })}
        </HStack>
        <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap" {...num}><Text as="span" color="fg" fontWeight="medium">{log.loggedDays.filter(d => d >= month).length}</Text> of {days.filter((d) => d <= log.today).length} days</Text>
      </HStack>
    </Flex>
  );
}

function Confirm({ log, next }: { log: BudgetLogData; next: () => void }) {
  const { undoable } = useBudgetStore();
  return (
    <>
      <Stack gap="0.5"><Text fontWeight="semibold">Confirm {log.unreviewed.length || "no"} new transactions</Text>
        <Text textStyle="sm" color="fg.muted">Check the category and amount. Each one updates what is left this week.</Text></Stack>
      <Stack gap="0">
        {log.unreviewed.map((x) => (
          <Grid key={x.id} templateColumns="4.5rem minmax(0,1fr) auto 1.25rem 7rem auto" gap="3" alignItems="center" py="2" borderBottomWidth="1px" textStyle="sm">
            <Text color="fg.muted" {...num}>{short(x.date)}</Text><Text truncate fontWeight="medium">{x.merchant}</Text>
            <CategoryButton x={x} /><ReceiptMark has={x.receipt} /><Amount x={x} />
            <Button size="xs" variant="outline" onClick={() => undoable(`${x.merchant} confirmed`, { type: "review", expense: x, reviewed: true })}>Confirm</Button>
          </Grid>
        ))}
      </Stack>
      <HStack>
        {!log.checkedInToday || log.unreviewed.length > 0
          ? <Button size="sm" onClick={() => undoable("All confirmed · checked in today", { type: "reviewAll", log })}>Confirm all and check in</Button>
          : <Button size="sm" variant="outline" onClick={next}>Continue</Button>}
      </HStack>
    </>
  );
}

// Benchmark against own trailing weeks, never peers. Plain numbers, no grades.
function Week({ log }: { log: BudgetLogData }) {
  const n = useBudgetNumbers();
  const limit = log.foodLimit === null || log.otherLimit === null ? null : n.limit;
  const weeks = [...log.history.slice(-8), { start: log.weekStart, food: n.foodSpent, other: n.otherSpent, foodLimit: log.foodLimit, otherLimit: log.otherLimit }];
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.food + w.other, (w.foodLimit ?? 0) + (w.otherLimit ?? 0))));
  const onPlan = log.history.filter((w) => w.foodLimit !== null && w.otherLimit !== null && w.food + w.other <= w.foodLimit + w.otherLimit).length;
  const avg4 = log.history.slice(-4).reduce((t, w) => t + w.food + w.other, 0) / 4;
  return (
    <>
      <Stack gap="0.5"><Text fontWeight="semibold">{onPlan} of the last {log.history.length} weeks were on plan</Text>
        <Text textStyle="sm" color="fg.muted">Weekly flexible spending against the limit. Bills are excluded.</Text></Stack>
      <HStack align="end" gap="3" h="44" pt="4">
        {weeks.map((w, i) => {
          const total = w.food + w.other, lim = w.foodLimit === null || w.otherLimit === null ? null : w.foodLimit + w.otherLimit, current = i === weeks.length - 1;
          return (
            <Stack key={w.start} flex="1" gap="1.5" align="center" h="full" justify="end">
              <Text textStyle="2xs" color="fg.muted" {...num}>{money0(total)}</Text>
              <Box position="relative" w="full" maxW="10" h={`${(Math.max(0, total) / max) * 100}%`} bg={lim !== null && total > lim ? "red.solid" : current ? "fg.subtle" : "fg.muted"} rounded="sm" />
              <Text textStyle="2xs" color={current ? "fg" : "fg.muted"} fontWeight={current ? "semibold" : undefined}>{current ? "Now" : short(w.start)}</Text>
            </Stack>
          );
        })}
      </HStack>
      <Grid templateColumns="repeat(3, 1fr)" gap="4" borderTopWidth="1px" pt="4">
        <Fig k="This week so far" v={money(n.spent)} />
        <Fig k="Your 4-week average" v={money(avg4)} />
        <Fig k="Weekly limit" v={limit === null ? "—" : money(limit)} />
      </Grid>
    </>
  );
}

const Fig = ({ k, v }: { k: string; v: string }) => <Stack gap="0.5"><Text textStyle="xs" color="fg.muted">{k}</Text><Text fontWeight="semibold" {...num}>{v}</Text></Stack>;

// Labeled savings account: not spending becomes visible money in a named goal.
function Skipped({ log }: { log: BudgetLogData }) {
  const { undoable } = useBudgetStore();
  const [label, setLabel] = useState("");
  const [amt, setAmt] = useState("");
  const total = log.skipped.reduce((t, x) => t + x.cents, 0);
  const goal = 100000;
  return (
    <>
      <Stack gap="0.5"><Text fontWeight="semibold">{money(total)} moved to Buffer fund this month</Text>
        <Text textStyle="sm" color="fg.muted">When you skip a purchase, log it here and move the amount at your next transfer.</Text></Stack>
      <Stack gap="1.5">
        <Box h="2" bg="bg.emphasized" rounded="full"><Box h="full" w={`${(total / goal) * 100}%`} bg="green.solid" rounded="full" /></Box>
        <HStack justify="space-between" textStyle="xs" color="fg.muted" {...num}><Text>{money(total)} saved by skipping</Text><Text>Goal {money0(goal)}</Text></HStack>
      </Stack>
      <form onSubmit={(e) => { e.preventDefault(); const c = Math.round(parseFloat(amt) * 100); if (label.trim() && c > 0) { undoable(`Logged skipped ${label.toLowerCase()}`, { type: "skip", date: log.today, label, cents: c }); setLabel(""); setAmt(""); } }}>
        <HStack gap="2"><Input size="sm" placeholder="What did you skip?" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input size="sm" w="28" placeholder="Amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /><Button size="sm" type="submit">Log</Button></HStack>
      </form>
      <Stack gap="0">
        {[...log.skipped].reverse().map((x) => (
          <Grid key={x.id} templateColumns="4.5rem minmax(0,1fr) 7rem" gap="3" py="2" borderBottomWidth="1px" textStyle="sm">
            <Text color="fg.muted" {...num}>{short(x.date)}</Text><Text>{x.label}</Text><Text textAlign="right" color="green.fg" {...num}>+{money(x.cents)}</Text>
          </Grid>
        ))}
      </Stack>
    </>
  );
}

// Goldilocks: suggest a limit just below recent behaviour, not a drastic cut.
function Next({ log }: { log: BudgetLogData }) {
  const { undoable } = useBudgetStore();
  const rows = (["food", "other"] as const).map((a) => {
    const avg = log.history.slice(-4).reduce((t, w) => t + w[a], 0) / 4;
    const limit = a === "food" ? log.nextFoodLimit : log.nextOtherLimit;
    const suggest = Math.max(0, Math.round((avg * 0.96) / 500) * 500);
    return { a, avg, limit, suggest };
  });
  return (
    <>
      <Stack gap="0.5"><Text fontWeight="semibold">One small step for next week</Text>
        <Text textStyle="sm" color="fg.muted">Suggested limits are about 4% under your last four weeks, rounded to $5.</Text></Stack>
      <Stack gap="0">
        <Grid templateColumns="6rem repeat(3, minmax(0,1fr)) auto" gap="3" py="2" borderBottomWidth="1px" textStyle="xs" color="fg.muted" fontWeight="medium">
          <Text>Allowance</Text><Text textAlign="right">4-week average</Text><Text textAlign="right">Current limit</Text><Text textAlign="right">Suggested</Text><Text />
        </Grid>
        {rows.map((r) => (
          <Grid key={r.a} templateColumns="6rem repeat(3, minmax(0,1fr)) auto" gap="3" py="2.5" borderBottomWidth="1px" alignItems="center" textStyle="sm" {...num}>
            <Text fontWeight="medium">{r.a === "food" ? "Food" : "Other"}</Text>
            <Text textAlign="right" color="fg.muted">{money(r.avg)}</Text><Text textAlign="right">{r.limit === null ? "—" : money(r.limit)}</Text>
            <Text textAlign="right" fontWeight="semibold">{money(r.suggest)}</Text>
            <Button size="xs" variant="outline" disabled={r.suggest === r.limit} onClick={() => undoable(`${r.a === "food" ? "Food" : "Other"} limit set to ${money(r.suggest)} from Monday`, { type: "limit", log, allowance: r.a, cents: r.suggest })}>{r.suggest === r.limit ? "Applied" : "Apply"}</Button>
          </Grid>
        ))}
      </Stack>
    </>
  );
}
