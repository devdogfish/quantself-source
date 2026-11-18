"use client";

// Tax planning: a what-if refund planner, not a filing tool. Every possible claim has a switch (and each certainty
// group has one); the refund, the where-it-comes-from bar and the maths all recompute instantly in the browser.
// Data comes from `useTaxPlan`; the switches are local what-if state and are not saved.
import { useMemo, useState } from "react";
import { Alert, Box, Button, Grid, HStack, SegmentGroup, Stack, Switch, Text } from "@chakra-ui/react";
import { FilterSelect } from "@/components/shared/filter-select";
import { Frame } from "../module/frame";
import { num } from "../module/kit";
import { calc, claimIds, defaultOn, levels, withClaim } from "./tax-calc";
import { money, signed } from "./tax-format";
import type { Certainty, TaxYearPlan } from "./tax-model";
import { TaxStatement } from "./tax-statement";
import { TaxTable } from "./tax-table";
import { useTaxPlan } from "./use-tax-plan";

const groups: { certainty: Certainty; title: string; sub: string }[] = [
  { certainty: "confirmed", title: "Confirmed", sub: "You have the documents" },
  { certainty: "likely", title: "Likely", sub: "One detail missing" },
  { certainty: "uncertain", title: "Uncertain", sub: "Depends on someone else or on CRA rules" },
];
const palette = ["blue.solid", "teal.solid", "cyan.solid", "purple.solid", "orange.solid", "pink.solid"];
const claimCols = "minmax(0, 1.2fr) minmax(0, 1.6fr) 5.5rem 2.75rem";
const currentYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric" }).format(new Date()));

export function TaxPlanner() {
  const [year, setYear] = useState(currentYear);
  const { plan, error, retry } = useTaxPlan(year);
  return (
    <Frame title="Tax planning" actions={
      <FilterSelect label="Tax year" w="28" highlightActive={false} value={String(year)} onChange={(v) => setYear(Number(v))}
        items={[currentYear, currentYear - 1, currentYear - 2].map((y) => ({ value: String(y), label: String(y) }))} />
    }>
      {plan ? <Planner key={plan.year} plan={plan} />
        : error ? <Alert.Root status="error"><Alert.Indicator /><Alert.Title>{error}</Alert.Title><Button variant="ghost" size="sm" onClick={retry}>Retry</Button></Alert.Root>
          : <Text role="status" textStyle="sm" color="fg.muted">Loading tax plan…</Text>}
    </Frame>
  );
}

function Planner({ plan }: { plan: TaxYearPlan }) {
  const [on, setOn] = useState(() => defaultOn(plan));
  const now = useMemo(() => calc(plan, on), [plan, on]);
  const preset = (certainties: Certainty[]) => setOn(claimIds(plan, certainties));
  const level = levels.find((l) => { const t = claimIds(plan, l.certainties); return t.size === on.size && [...t].every((id) => on.has(id)); })?.value ?? "";
  const impacts = new Map<string, number>();
  const impact = (id: string) => {
    const cached = impacts.get(id);
    if (cached !== undefined) return cached;
    const other = calc(plan, withClaim(on, id, !on.has(id))).refund;
    const value = on.has(id) ? now.refund - other : other - now.refund;
    impacts.set(id, value);
    return value;
  };
  const refundsByLevel = useMemo(() => levels.map(l => calc(plan, claimIds(plan, l.certainties)).refund), [plan]);
  const low = refundsByLevel[0];
  const high = refundsByLevel[2];
  const colorOf = (id: string) => palette[plan.claims.findIndex((c) => c.id === id) % palette.length];

  return (
    <Stack gap="8">
      <TaxStatement plan={plan} on={on} now={now} low={low} high={high} colorOf={colorOf} />

      <Box borderWidth="1px" rounded="l3" bg="bg" overflow="hidden">
        <HStack justify="space-between" wrap="wrap" gap="2" px="4" py="3">
          <Text fontWeight="semibold">What if I can claim…</Text>
          <SegmentGroup.Root size="xs" value={level} onValueChange={(e) => preset(levels.find((l) => l.value === e.value)!.certainties)}>
            <SegmentGroup.Indicator />
            <SegmentGroup.Items items={levels.map((l, index) => ({ value: l.value, label: `${l.label} · ${money(refundsByLevel[index])}` }))} />
          </SegmentGroup.Root>
        </HStack>
        {groups.map((g) => {
          const rows = plan.claims.filter((c) => c.certainty === g.certainty);
          if (!rows.length) return null;
          const all = rows.every((c) => on.has(c.id));
          const total = rows.filter((c) => on.has(c.id)).reduce((s, c) => s + Math.round(impact(c.id) / 100) * 100, 0); // sum of the displayed whole-dollar rows
          return (
            <Box key={g.certainty}>
              <Grid templateColumns={claimCols} gap="4" alignItems="center" px="4" py="2" bg="bg.subtle" borderTopWidth="1px">
                <Text textStyle="sm" fontWeight="medium">{g.title}</Text>
                <Text textStyle="xs" color="fg.muted" truncate>{g.sub}</Text>
                <Text textAlign="right" textStyle="sm" color="fg.muted" {...num}>{total ? signed(total) : "—"}</Text>
                <Box justifySelf="end"><Toggle label={`Toggle all ${g.title}`} checked={all} onChange={(v) => setOn((cur) => rows.reduce((s, c) => withClaim(s, c.id, v), cur))} /></Box>
              </Grid>
              {rows.map((c) => {
                const active = on.has(c.id);
                return (
                  <Grid key={c.id} templateColumns={claimCols} gap="4" alignItems="center" px="4" py="3" borderTopWidth="1px" borderColor="border.muted">
                    <HStack gap="2.5" minW="0">
                      <Box boxSize="2.5" rounded="sm" bg={active ? colorOf(c.id) : "bg.emphasized"} flexShrink={0} />
                      <Text truncate color={active ? undefined : "fg.muted"}>{c.title}</Text>
                    </HStack>
                    <Text textStyle="sm" color="fg.muted" truncate>{c.note}</Text>
                    <Text textAlign="right" fontWeight={active ? "semibold" : "normal"} color={active ? "green.fg" : "fg.subtle"} {...num}>{signed(impact(c.id))}</Text>
                    <Box justifySelf="end"><Toggle label={c.title} checked={active} onChange={(v) => setOn((cur) => withClaim(cur, c.id, v))} /></Box>
                  </Grid>
                );
              })}
            </Box>
          );
        })}
      </Box>

      <TaxTable plan={plan} on={on} impact={impact} />
    </Stack>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Switch.Root size="sm" checked={checked} onCheckedChange={(e) => onChange(e.checked)}>
      <Switch.HiddenInput aria-label={label} /><Switch.Control />
    </Switch.Root>
  );
}
