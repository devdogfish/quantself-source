"use client";
import NextLink from "next/link";
import { Link, Text } from "@chakra-ui/react";
import { money, useBudget } from "../budgeting/budgeting-client";
export function useBudgetCommitments(from: string, through: string, enabled: boolean) {
  const data = useBudget<"getBudgetCommitments">(`/commitments?from=${from}&through=${through}`, enabled);
  const days = new Map<string, NonNullable<typeof data.value>["events"]>();
  for (const event of data.value?.events ?? []) days.set(event.date, [...(days.get(event.date) ?? []), event]);
  return { ...data, days, enabled };
}
export function BudgetCommitmentsStatus({ value }: { value: ReturnType<typeof useBudgetCommitments> }) {
  if (!value.enabled) return null;
  return value.error ? <Text as="span" role="alert" textStyle="xs" color="fg.error">Bills/income unavailable. <Link as="button" type="button" textDecoration="underline" onClick={value.reload}>Retry</Link></Text>
    : !value.value ? <Text as="span" role="status" textStyle="xs" color="fg.muted">Loading bills/income…</Text> : null;
}
export function BudgetCommitmentChips({ events = [] }: { events?: NonNullable<ReturnType<typeof useBudgetCommitments>["value"]>["events"] }) {
  return events.map(event => <Link key={event.key} asChild display="flex" minW="0" alignItems="center" gap="1" rounded="l1" borderWidth="1px" borderColor="border" bg="bg.muted" px="1.5" py="0.5" textStyle="xs" color="fg" textDecoration="none" _hover={{ bg: "bg.emphasized", textDecoration: "none" }}>
    <NextLink href="/budgeting/plan" draggable={false}
      onDoubleClick={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}
      title={`${event.label} · ${event.kind === "bill" ? event.paid ? "Paid" : "Expected payment" : event.kind === "income" ? "Expected income" : "Uncertain income"}`}>
      <Text as="span" truncate>{event.label}</Text><Text as="span" ms="auto" flexShrink={0} fontVariantNumeric="tabular-nums">{event.kind !== "bill" ? "+" : ""}{money(event.cents)}{event.paid ? " ✓" : ""}</Text>
    </NextLink>
  </Link>);
}
