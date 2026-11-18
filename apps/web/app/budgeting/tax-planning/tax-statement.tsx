"use client";

// The Budgeting statement panel, reused: headline + hoverable bar on top, expandable sections underneath.
// Bar = the tax bill with no claims. Grey is what you still owe; each coloured chunk is tax a claim erases.
// The line is what you already paid; the gap between the grey part and the line is your refund.
import { useState } from "react";
import { Accordion, Box, Collapsible, Grid, HStack, Stack, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";
import { SegBar } from "@/components/shared/dashboard-charts";
import { Delta } from "@/components/shared/dashboard";
import { Trigger } from "../module/overview";
import { num } from "../module/kit";
import { calc, creditBase, totalIncome, totalWithheld, withClaim, type Calc } from "./tax-calc";
import { money } from "./tax-format";
import type { TaxYearPlan } from "./tax-model";

export function TaxStatement({ plan, on, now, low, high, colorOf }: {
  plan: TaxYearPlan; on: Set<string>; now: Calc; low: number; high: number; colorOf: (claimId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const income = totalIncome(plan), withheld = totalWithheld(plan);
  const none = calc(plan, new Set());
  const scale = Math.max(none.owed, withheld, 1);
  const pos = (v: number) => (v / scale) * 100;
  const prev = String(plan.year - 1);
  let before = none.owed;
  const chunks = plan.claims.filter((c) => on.has(c.id)).map((c, i, all) => {
    const after = calc(plan, new Set(all.slice(0, i + 1).map((x) => x.id))).owed;
    const saved = before - after; before = after;
    return { c, saved };
  });
  const refund = now.refund >= 0;
  const gapFrom = Math.min(now.owed, withheld), gapTo = Math.max(now.owed, withheld);
  const line = (key: string | number, label: string, note: string, cents: number, active: boolean, sign: 1 | -1) => (
    <Grid key={key} templateColumns="minmax(0,1fr) 12rem 8rem" gap="3" px="4" pl="10" py="2" borderTopWidth="1px" borderColor="border.muted" textStyle="sm" alignItems="center">
      <Text truncate color={active ? undefined : "fg.muted"}>{label}</Text>
      <Text textStyle="xs" color="fg.subtle" truncate>{note}</Text>
      <Text textAlign="right" color={active ? undefined : "fg.subtle"} {...num}>{sign > 0 ? "+" : "−"}{money(cents)}</Text>
    </Grid>
  );
  const deductions = plan.claims.filter((c) => c.treatment === "deduction");
  const credits = plan.claims.filter((c) => c.treatment !== "deduction");
  const ratePct = `${(plan.rules.creditRate * 100).toFixed(2)}%`;
  return (
    <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)} borderWidth="1px" rounded="l3" bg="bg" overflow="hidden">
      <Collapsible.Trigger display="block" w="full" textAlign="left" cursor="pointer" _hover={{ bg: "bg.subtle" }} transition="background .15s">
        <Box p={{ base: "5", md: "6" }}>
          <HStack justify="space-between" align="start" wrap="wrap" gap="4">
            <Stack gap="1">
              <Text textStyle="sm" color="fg.muted">{refund ? "Estimated refund" : "Estimated balance owing"}</Text>
              <Text fontSize={{ base: "4xl", md: "5xl" }} lineHeight="1" fontWeight="semibold" letterSpacing="tight" color={refund ? undefined : "orange.fg"} {...num}>{money(Math.abs(now.refund))}</Text>
              <Text textStyle="sm" color="fg.muted" {...num}>Could land between {money(Math.max(0, low))} and {money(Math.max(0, high))}, depending on which claims are accepted</Text>
            </Stack>
            <HStack gap="2" textStyle="sm" whiteSpace="nowrap">
              <Text color="fg.muted">Tax you owe</Text>
              <Text fontWeight="medium" {...num}>{money(now.owed)}</Text>
              {plan.prior && <Delta now={now.owed} then={plan.prior.taxOwedCents} goodWhen="down" fmt={money} label={`vs ${prev}`} />}
            </HStack>
          </HStack>

          <Box mt="6" position="relative" style={{ height: 78 }}>
            <Text position="absolute" textStyle="xs" color="fg.muted" whiteSpace="nowrap" style={{ top: 0, left: `${pos(withheld)}%`, transform: "translateX(-100%)", paddingRight: 6 }} {...num}>Already paid {money(withheld)}</Text>
            <Box position="absolute" w="full" style={{ top: 20 }}>
              <SegBar h="5" format={money} parts={[
                { name: "Tax you still owe", value: now.owed, color: "fg.muted" },
                ...chunks.map(({ c, saved }) => ({ name: `${c.title}, tax it erases`, value: saved, color: colorOf(c.id) })),
              ]} />
            </Box>
            <Box position="absolute" w="2px" bg="fg" pointerEvents="none" style={{ top: 14, height: 32, left: `calc(${pos(withheld)}% - 1px)` }} />
            <Box position="absolute" h="1.5" rounded="full" bg={refund ? "green.solid" : "orange.solid"} style={{ top: 52, left: `${pos(gapFrom)}%`, width: `${pos(gapTo) - pos(gapFrom)}%`, transition: "left .25s, width .25s" }} />
            <Text position="absolute" textStyle="xs" fontWeight="semibold" whiteSpace="nowrap" color={refund ? "green.fg" : "orange.fg"} style={{ top: 62, left: `${pos(gapFrom)}%`, transition: "left .25s" }} {...num}>
              {refund ? `Refund ${money(now.refund)}` : `You owe ${money(-now.refund)}`}
            </Text>
          </Box>

          <HStack justify="space-between" align="end" mt="2" gap="4" wrap="wrap">
            <HStack gap="5" textStyle="xs" color="fg.muted" wrap="wrap">
              <HStack gap="1.5"><Box boxSize="2" rounded="sm" bg="fg.muted" />Tax you still owe</HStack>
              {chunks.map(({ c }) => <HStack key={c.id} gap="1.5"><Box boxSize="2" rounded="sm" bg={colorOf(c.id)} />{c.title}</HStack>)}
            </HStack>
            <HStack gap="1" textStyle="xs" color="fg.muted"><Text>{open ? "Hide the maths" : "Show the maths"}</Text><Box transform={open ? "rotate(180deg)" : undefined} transition="transform .15s"><ChevronDown size={14} /></Box></HStack>
          </HStack>
        </Box>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <Box borderTopWidth="1px">
          <Accordion.Root multiple collapsible variant="plain">
            <Accordion.Item value="income" borderBottomWidth="1px">
              <Trigger title="Income" meta={`${plan.income.length} ${plan.income.length === 1 ? "item" : "items"}`} total={income} now={income} was={plan.prior?.incomeCents} good="up" prevName={prev} fmt={money} fmtDelta={money} />
              <Accordion.ItemContent><Accordion.ItemBody p="0">
                {plan.income.map((l, index) => line(index, l.label, l.note, l.cents, true, 1))}
              </Accordion.ItemBody></Accordion.ItemContent>
            </Accordion.Item>
            <Accordion.Item value="deductions" borderBottomWidth="1px">
              <Trigger title="Deductions" meta={`${deductions.filter((c) => on.has(c.id)).length} of ${deductions.length} on`} total={-now.deductions} now={now.deductions} was={plan.prior?.deductionsCents} good="up" prevName={prev} fmt={money} fmtDelta={money} />
              <Accordion.ItemContent><Accordion.ItemBody p="0">
                {deductions.map((c) => line(c.id, c.title, on.has(c.id) ? "Subtracted before tax" : "Off, not counted", c.amountCents, on.has(c.id), -1))}
              </Accordion.ItemBody></Accordion.ItemContent>
            </Accordion.Item>
            <Accordion.Item value="credits" borderBottomWidth="1px">
              <Trigger title="Credits" meta="discounts on the tax" total={-now.credits} now={now.credits} was={plan.prior?.creditsCents} good="up" prevName={prev} fmt={money} fmtDelta={money} />
              <Accordion.ItemContent><Accordion.ItemBody p="0">
                {line(0, "Basic amounts, CPP and EI", "Always applied", plan.rules.baselineCreditsCents, true, -1)}
                {credits.map((c) => {
                  const active = on.has(c.id);
                  const cents = Math.round(creditBase(plan, c, calc(plan, withClaim(on, c.id, active)).taxable) * plan.rules.creditRate);
                  const note = !active ? "Off, not counted" : c.treatment === "medicalCredit" ? `Only the part above ${plan.rules.medical.floorRate * 100}% of income` : `${ratePct} of ${money(c.amountCents)}`;
                  return line(c.id, c.title, note, cents, active, -1);
                })}
              </Accordion.ItemBody></Accordion.ItemContent>
            </Accordion.Item>
            <Accordion.Item value="paid">
              <Trigger title="Already paid" meta={`${plan.withheld.length} ${plan.withheld.length === 1 ? "item" : "items"}`} total={withheld} now={withheld} was={plan.prior?.withheldCents} good="up" prevName={prev} fmt={money} fmtDelta={money} />
              <Accordion.ItemContent><Accordion.ItemBody p="0">
                {plan.withheld.map((l, index) => line(index, l.label, l.note, l.cents, true, 1))}
              </Accordion.ItemBody></Accordion.ItemContent>
            </Accordion.Item>
          </Accordion.Root>
        </Box>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

