"use client";

// Budgeting (#175) — small shared pieces: expense form + "Add expense" button, category menu, amount, receipt mark.
import { decimalMoney, type Currency } from "@quantself/budgeting";
import { useState } from "react";
import { Button, CloseButton, Dialog, Grid, HStack, Input, Menu, Portal, Stack, Text, chakra } from "@chakra-ui/react";
import { Check, ChevronDown, Paperclip, Plus, Receipt } from "lucide-react";
import { Tooltip } from "@/components/chakra/tooltip";
import { categories, money, short, useBudgetStore, type Allowance, type Expense } from "./stub-store";
import type { Transaction } from "./transaction-client";
import { budgetToday } from "./transaction-store";

export const num = { fontVariantNumeric: "tabular-nums" } as const;
export const allowanceName: Record<Allowance, string> = { food: "Food", other: "Other" };
type Cat = { allowance: Allowance; category: string };

function CategoryItems({ current, onPick }: { current: string; onPick: (c: Cat) => void }) {
  return <>
    {(Object.keys(categories) as Allowance[]).map((a) => (
      <Menu.ItemGroup key={a}>
        <Menu.ItemGroupLabel>{allowanceName[a]} allowance</Menu.ItemGroupLabel>
        {categories[a].map((c) => (
          <Menu.Item key={c} value={c} onSelect={() => onPick({ allowance: a, category: c })}>
            <Text flex="1">{c}</Text>{current === c && <Check size={14} />}
          </Menu.Item>
        ))}
      </Menu.ItemGroup>
    ))}
  </>;
}

// Category picker (Chakra menu, never a native select). Changing it is optimistic with Undo.
export function CategoryButton({ x, size = "xs" }: { x: Transaction; size?: "xs" | "sm" }) {
  const { undoable } = useBudgetStore();
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }} lazyMount unmountOnExit>
      <Menu.Trigger asChild><Button size={size} variant="outline" fontWeight="normal" color="fg.muted">{x.category}</Button></Menu.Trigger>
      <Portal><Menu.Positioner><Menu.Content minW="48">
        <CategoryItems current={x.category} onPick={(c) => c.category !== x.category && undoable(`Moved to ${c.category}`, { type: "move", expense: x, ...c })} />
      </Menu.Content></Menu.Positioner></Portal>
    </Menu.Root>
  );
}

// Amount first, then where, then category. Used inline on the Log and inside the Add expense dialog.
export function ExpenseForm({ onDone, autoFocus = true }: { onDone?: () => void; autoFocus?: boolean }) {
  const { undoable } = useBudgetStore();
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [cat, setCat] = useState<Cat>({ allowance: "food", category: "Groceries" });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount) * 100);
    if (!merchant.trim() || !(cents > 0)) return;
    const x = { id: crypto.randomUUID(), date: budgetToday(), merchant, cents, ...cat };
    undoable(`Logged ${money(cents)} at ${merchant}`, { type: "add", expense: x });
    setAmount(""); setMerchant("");
    onDone?.();
  };
  return (
    <chakra.form onSubmit={submit}>
      <Grid templateColumns={{ base: "1fr 1fr", md: "8rem minmax(0,1fr) auto auto auto" }} gap="2" alignItems="center">
        <Input size="sm" autoFocus={autoFocus} placeholder="$0.00" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" {...num} />
        <Input size="sm" placeholder="Where?" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Merchant" />
        <Menu.Root positioning={{ placement: "bottom-start" }} lazyMount unmountOnExit>
          <Menu.Trigger asChild><Button size="sm" variant="outline" fontWeight="normal">{cat.category}<Text as="span" color="fg.subtle">· {allowanceName[cat.allowance]}</Text><ChevronDown /></Button></Menu.Trigger>
          <Portal><Menu.Positioner zIndex="popover"><Menu.Content minW="48"><CategoryItems current={cat.category} onPick={setCat} /></Menu.Content></Menu.Positioner></Portal>
        </Menu.Root>
        <Text textStyle="sm" color="fg.muted" px="1">Today</Text>
        <Button size="sm" type="submit"><Plus />Add</Button>
      </Grid>
    </chakra.form>
  );
}

// The round-1 "Add expense" button the Owner liked: outline, small, receipt icon. Opens the same form.
export function AddExpenseButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(e) => setOpen(e.open)} size="lg" placement="top">
      <Dialog.Trigger asChild><Button size="sm" variant="outline"><Receipt />Add expense</Button></Dialog.Trigger>
      <Portal><Dialog.Backdrop /><Dialog.Positioner><Dialog.Content>
        <Dialog.Header><Dialog.Title>Add expense</Dialog.Title></Dialog.Header>
        <Dialog.Body pb="5"><Stack gap="3"><ExpenseForm onDone={() => setOpen(false)} /></Stack></Dialog.Body>
        <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
      </Dialog.Content></Dialog.Positioner></Portal>
    </Dialog.Root>
  );
}

export function ReceiptMark({ has }: { has: boolean }) {
  return (
    <Tooltip content={has ? "Receipt attached" : "No receipt"}>
      <chakra.span color={has ? "fg.muted" : "fg.subtle"} opacity={has ? 1 : 0.35} display="inline-flex"><Paperclip size={13} /></chakra.span>
    </Tooltip>
  );
}

export const originalAmount = (amount: NonNullable<Transaction["original"]>) =>
  amount.currency + " " + decimalMoney({ currency: amount.currency as Currency, amountMinor: amount.cents });

export function Amount({ x }: { x: Expense }) {
  return (
    <HStack gap="2" justify="flex-end" {...num}>
      {x.original && <Tooltip content={`Conversion estimate from ${originalAmount(x.original)}`}><Text textStyle="xs" color="fg.subtle">{x.original.currency}</Text></Tooltip>}
      <Text fontWeight="medium">{money(-x.cents)}</Text>
    </HStack>
  );
}

export const dateCell = (iso: string) => <Text color="fg.muted" whiteSpace="nowrap" {...num}>{short(iso)}</Text>;
