"use client";
import { useEffect } from "react";
import NextLink from "next/link";
import { Link, Text, VisuallyHidden } from "@chakra-ui/react";
import { CreditCardIcon } from "lucide-react";
import { money, useBudget } from "../budgeting/budgeting-client";

export function useSubscriptionCalendar(from: string, through: string, enabled: boolean) {
  const result = useBudget<"getSubscriptionCalendar">(`/subscriptions/calendar?from=${from}&through=${through}`, enabled);
  useEffect(() => {
    window.addEventListener("budget-subscriptions-changed", result.reload);
    return () => window.removeEventListener("budget-subscriptions-changed", result.reload);
  }, [result.reload]);
  const days = new Map<string, NonNullable<typeof result.value>["payments"]>();
  for (const payment of result.value?.payments ?? []) days.set(payment.date, [...(days.get(payment.date) ?? []), payment]);
  return { ...result, days, enabled };
}
export function SubscriptionCalendarStatus({ value }: { value: ReturnType<typeof useSubscriptionCalendar> }) {
  if (!value.enabled) return null;
  if (value.error) return <Text as="span" role="alert" textStyle="xs" color="fg.error">Subscription payments unavailable. <Link as="button" type="button" textDecoration="underline" onClick={value.reload}>Retry</Link></Text>;
  if (!value.value) return <Text as="span" role="status" textStyle="xs" color="fg.muted">Loading subscription payments…</Text>;
  return null;
}
export function SubscriptionCalendarChips({ payments = [] }: { payments?: NonNullable<ReturnType<typeof useSubscriptionCalendar>["value"]>["payments"] }) {
  return payments.map(payment => <Link key={payment.key} asChild display="flex" minW="0" alignItems="center" gap="1" rounded="l1" borderWidth="1px" borderColor="border" bg="bg.muted" px="1.5" py="0.5" textStyle="xs" color="fg" textDecoration="none" _hover={{ bg: "bg.emphasized", textDecoration: "none" }}>
    <NextLink href={`/budgeting/subscriptions?subscription=${payment.id}`}
      onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} draggable={false}
      title={`${payment.label} · ${money(payment.cents)} · ${payment.paid ? "Paid" : "Expected payment"}`}>
      <CreditCardIcon size={12} style={{ flexShrink: 0 }} aria-hidden="true" /><Text as="span" truncate>{payment.label}</Text><Text as="span" ms="auto" flexShrink={0} fontVariantNumeric="tabular-nums">{money(payment.cents)}{payment.paid ? " ✓" : ""}</Text>
      <VisuallyHidden>{payment.paid ? "Paid" : "Expected payment"}</VisuallyHidden>
    </NextLink>
  </Link>);
}
