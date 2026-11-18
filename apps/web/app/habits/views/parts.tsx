"use client";
// Habits shared cell colours and small pieces (#176).
import { Box, HStack, Text, chakra } from "@chakra-ui/react";
import { Tooltip } from "@/components/chakra/tooltip";
import type { State } from "./habit-metrics";

const v = (n: string) => `var(--chakra-colors-${n})`;
export const stateLabel: Record<State, string> = { done: "Done", minimum: "Minimum version", skipped: "Skipped (excluded)", missed: "Missed", none: "Not scheduled", open: "Open" };

// One cell, GitHub-style: solid squares, no glyphs. Blue = reps (dark done, light minimum), red = missed
// (pale first miss, solid second in a row), grey = skipped, faint = not scheduled. Labels/tooltips carry the state in words.
export const cellFill = (state: State, escalate?: boolean) => ({
  done: v("brand-solid"), minimum: v("brand-300"), skipped: v("bg-emphasized"),
  missed: escalate ? v("red-500") : `color-mix(in srgb, ${v("red-500")} 30%, ${v("bg-muted")})`,
  none: v("bg-muted"), open: "none",
})[state];
export function Cell({ state, size = 12, escalate, label }: { state: State; size?: number; escalate?: boolean; label?: string }) {
  const s = size, r = Math.max(2, s / 5);
  const body = state === "open"
    ? <rect x={0.75} y={0.75} width={s - 1.5} height={s - 1.5} rx={r} fill="none" stroke={v("fg-muted")} strokeWidth="1.25" />
    : <rect x={0.5} y={0.5} width={s - 1} height={s - 1} rx={r} fill={cellFill(state, escalate)} />;
  const text = label ?? (escalate ? "Missed twice in a row" : stateLabel[state]);
  const svg = <chakra.svg viewBox={`0 0 ${s} ${s}`} w={`${s}px`} h={`${s}px`} flexShrink={0} role="img" aria-label={text}>{body}</chakra.svg>;
  return label ? <Tooltip content={label} openDelay={150}><Box as="span" display="inline-flex">{svg}</Box></Tooltip> : svg;
}

export function Legend() {
  const items: [State, string, boolean?][] = [["done", "Done"], ["minimum", "Minimum"], ["missed", "Missed"], ["missed", "Missed twice in a row", true], ["skipped", "Skipped"]];
  return (
    <HStack gap="4" wrap="wrap">
      {items.map(([s, l, e]) => <HStack key={l} gap="1.5"><Cell state={s} size={10} escalate={e} /><Text textStyle="xs" color="fg.muted">{l}</Text></HStack>)}
    </HStack>
  );
}

// Section label in the Linear/Stripe style: small, muted, sentence case.
export function Eyebrow({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <HStack justify="space-between" px="4" h="9" borderBottomWidth="1px" bg="bg.subtle">
      <Text textStyle="xs" fontWeight="medium" color="fg.muted">{children}</Text>
      {right}
    </HStack>
  );
}

export const Num = (p: React.ComponentProps<typeof Text>) => <Text as="span" fontVariantNumeric="tabular-nums" {...p} />;

export function Panel({ children, ...rest }: React.ComponentProps<typeof Box>) {
  return <Box borderWidth="1px" rounded="md" bg="bg" overflow="hidden" {...rest}>{children}</Box>;
}

// Thin meter for gates/budgets. No gradients.
export function Meter({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "neutral" | "red" | "orange" }) {
  const color = tone === "brand" ? "brand.solid" : tone === "red" ? "red.500" : tone === "orange" ? "orange.500" : "fg.subtle";
  return (
    <Box h="1.5" w="full" bg="bg.emphasized" rounded="full" overflow="hidden">
      <Box h="full" w={`${Math.max(0, Math.min(1, value / max)) * 100}%`} bg={color} rounded="full" />
    </Box>
  );
}

export function StatusText({ state }: { state: "pass" | "pending" | "fail" | "risk" }) {
  const map = { pass: ["Passing", "green.solid"], pending: ["Collecting", "fg.subtle"], fail: ["Below gate", "red.solid"], risk: ["Never miss twice", "orange.solid"] } as const;
  const [label, color] = map[state];
  return <HStack gap="1.5"><Box boxSize="1.5" rounded="full" bg={color} /><Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">{label}</Text></HStack>;
}

// Consistency as a 5-step rating with a word, instead of a bare percentage. Exact % on hover.
export function ConsistencyRating({ pct }: { pct: number | null }) {
  if (pct === null) return <Text color="fg.subtle">–</Text>;
  const steps = pct >= 95 ? 5 : pct >= 85 ? 4 : pct >= 75 ? 3 : pct >= 60 ? 2 : 1;
  const word = steps >= 4 ? "Solid" : steps === 3 ? "Steady" : "Shaky";
  return (
    <Tooltip content={`${pct}% of scheduled days, last 4 weeks`} openDelay={150}>
      <HStack gap="2" w="fit-content">
        <HStack gap="2px">{[1, 2, 3, 4, 5].map((n) => <Box key={n} w="2" h="3" rounded="1px" bg={n <= steps ? (steps <= 2 ? "orange.solid" : "brand.solid") : "bg.emphasized"} />)}</HStack>
        <Text textStyle="sm" color="fg.muted">{word}</Text>
      </HStack>
    </Tooltip>
  );
}

// GitHub-style calendar that fills its container: weeks as columns, Monday-first rows, month labels on top.
export type CalendarDay = { date: Date; fill: string; title: string; outline?: boolean };
export function CalendarGrid({ days, label }: { days: CalendarDay[]; label: string }) {
  const lead = (days[0]!.date.getDay() + 6) % 7;
  const cells: (CalendarDay | null)[] = [...Array(lead).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const S = 13, G = 3, top = 16, left = 30;
  const W = left + weeks * (S + G), H = top + 7 * (S + G);
  return (
    <chakra.svg viewBox={`0 0 ${W} ${H}`} w="full" h="auto" display="block" role="img" aria-label={label}>
      {Array.from({ length: weeks }, (_, w) => {
        const f = cells.slice(w * 7, w * 7 + 7).find(Boolean);
        return f && f.date.getDate() <= 7 ? <text key={w} x={left + w * (S + G)} y={10} fontSize="9" fill={v("fg-muted")}>{f.date.toLocaleDateString("en-CA", { month: "short" })}</text> : null;
      })}
      {["Mon", "", "Wed", "", "Fri", "", ""].map((l, r) => <text key={r} x={0} y={top + r * (S + G) + 10} fontSize="9" fill={v("fg-subtle")}>{l}</text>)}
      {cells.map((c, k) => c && (
        <rect key={k} x={left + Math.floor(k / 7) * (S + G) + 0.5} y={top + (k % 7) * (S + G) + 0.5} width={S - 1} height={S - 1} rx={2.5}
          fill={c.outline ? "none" : c.fill} stroke={c.outline ? v("fg-muted") : "none"}><title>{c.title}</title></rect>
      ))}
    </chakra.svg>
  );
}
