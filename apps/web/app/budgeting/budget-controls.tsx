"use client";

import { FilterSelect } from "@/components/shared/filter-select";
import {
  chakra,
  Button,
  Input,
  Field,
  Stack,
  Dialog,
  Flex,
} from "@chakra-ui/react";

import {
  currencies,
  decimalMoney,
  parseMoney,
  type Currency,
} from "@quantself/budgeting";
import { useId, useRef, useState, type FormEvent } from "react";
import { errorMessage, type Expense } from "./budgeting-client";

export function ConfirmDelete({
  title,
  description,
  onDelete,
}: {
  title: string;
  description: string;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setError("");
    setPending(true);
    try {
      await onDelete();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={({ open: next }) => {
        if (!pending) {
          setError("");
          setOpen(next);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button colorPalette="red">Delete</Button>
      </Dialog.Trigger>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content p="6">
          <Dialog.Header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description>{description}</Dialog.Description>
          </Dialog.Header>
          {error && (
            <chakra.p role="alert" color="fg.error">
              {error}
            </chakra.p>
          )}
          <Dialog.Footer>
            <Button disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {pending ? "Deleting…" : "Delete permanently"}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

export function ExpenseForm({
  initial,
  today,
  submit,
  onSaved,
  label = "Save expense",
}: {
  initial: Partial<Expense>;
  today: string;
  submit: (expense: Expense) => Promise<void>;
  onSaved?: () => void;
  label?: string;
}) {
  const key = useId();
  const edits = useRef(0);
  const [merchant, setMerchant] = useState(initial.merchant ?? "");
  const [date, setDate] = useState(initial.date ?? today);
  const [currency, setCurrency] = useState<Currency>(
    initial.originalCurrency ?? initial.currency ?? "CAD",
  );
  const [amount, setAmount] = useState(
    initial.totalCents === undefined
      ? ""
      : decimalMoney({
          amountMinor: initial.originalAmountMinor ?? initial.totalCents,
          currency: initial.originalCurrency ?? initial.currency ?? "CAD",
        }),
  );
  const [food, setFood] = useState(
    initial.foodCents === undefined
      ? ""
      : decimalMoney({
          amountMinor: initial.originalFoodMinor ?? initial.foodCents,
          currency: initial.originalCurrency ?? initial.currency ?? "CAD",
        }),
  );
  const [category, setCategory] = useState(
    initial.foodCents && initial.foodCents !== initial.totalCents
      ? "split"
      : initial.foodCents
        ? "food"
        : "other",
  );
  const [id, setId] = useState(initial.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    const expenseId = id ?? crypto.randomUUID();
    setId(expenseId);
    const submittedVersion = edits.current;
    setError("");
    setPending(true);
    try {
      const totalCents = parseMoney(amount, currency);
      const foodCents =
        category === "food"
          ? totalCents
          : category === "split"
            ? parseMoney(food, currency)
            : 0;
      if (!merchant.trim() || !date || date > today)
        throw Error("Check the merchant and purchase date.");
      if (
        Math.abs(foodCents) > Math.abs(totalCents) ||
        (foodCents !== 0 && Math.sign(foodCents) !== Math.sign(totalCents))
      )
        throw Error("Food allocation must fit the total.");
      await submit({
        id: expenseId,
        merchant: merchant.trim(),
        date,
        totalCents,
        foodCents,
        currency,
        billKey: initial.billKey ?? null,
        receiptId: initial.receiptId ?? null,
      });
      if (edits.current === submittedVersion) onSaved?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <chakra.form
      onSubmit={save}
      onChangeCapture={() => {
        edits.current++;
      }}
      display="flex"
      flexDirection="column"
      gap="4"
    >
      <Stack
        display="grid"
        gap="3"
        gridTemplateColumns={{ sm: "repeat(2, minmax(0, 1fr))" }}
      >
        <Field.Root>
          <Field.Label htmlFor={key + "merchant"}>
            Merchant or description
          </Field.Label>
          <Input
            id={key + "merchant"}
            required
            maxLength={180}
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label htmlFor={key + "date"}>Date</Field.Label>
          <Input
            id={key + "date"}
            required
            type="date"
            max={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label htmlFor={key + "amount"}>Total ({currency})</Field.Label>
          <Input
            id={key + "amount"}
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label htmlFor={key + "currency"}>Currency</Field.Label>
          <FilterSelect
            id={key + "currency"}
            label="Currency"
            size="md"
            w="full"
            highlightActive={false}
            value={currency}
            onChange={(value) => setCurrency(value as Currency)}
            items={currencies.map((code) => ({ value: code, label: code }))}
          />
        </Field.Root>
        <Field.Root>
          <Field.Label htmlFor={key + "category"}>Category</Field.Label>
          <FilterSelect
            id={key + "category"}
            label="Category"
            size="md"
            w="full"
            highlightActive={false}
            value={category}
            onChange={(value) => setCategory(value)}
            items={[
              { value: "other", label: "Other" },
              { value: "food", label: "Food" },
              { value: "split", label: "Split Food and Other" },
            ]}
          />
        </Field.Root>
        {category === "split" && (
          <Field.Root>
            <Field.Label htmlFor={key + "food"}>
              Food portion ({currency})
            </Field.Label>
            <Input
              id={key + "food"}
              required
              inputMode="decimal"
              value={food}
              onChange={(e) => setFood(e.target.value)}
            />
          </Field.Root>
        )}
      </Stack>
      {currency !== "CAD" && (
        <chakra.p fontSize="sm" color="fg.muted">
          CAD estimate uses the purchase-date reference rate. Original{" "}
          {currency} amount stays saved.
        </chakra.p>
      )}
      {error && (
        <chakra.p role="alert" color="fg.error">
          {error}
        </chakra.p>
      )}
      <chakra.div>
        <Button disabled={pending} type="submit">
          {pending ? "Saving…" : label}
        </Button>
      </chakra.div>
    </chakra.form>
  );
}

export function LoadState({
  error,
  retry,
}: {
  error: string;
  retry: () => void;
}) {
  return error ? (
    <Flex alignItems="center" gap="3">
      <chakra.p role="alert" color="fg.error">
        {error}
      </chakra.p>
      <Button variant="outline" onClick={retry}>
        Retry
      </Button>
    </Flex>
  ) : (
    <p role="status" style={{ color: "var(--chakra-colors-fg-muted)" }}>
      Loading budget data…
    </p>
  );
}
