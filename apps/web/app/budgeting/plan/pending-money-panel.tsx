"use client";

import { chakra, Button, Input, Flex } from "@chakra-ui/react";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  budgetRequest,
  dollars,
  errorMessage,
  money,
  parseDollars,
  type BudgetPlan,
} from "../budgeting-client";
import { PendingMoneyStore, type PendingMoney } from "./pending-money-store";

export function PendingMoneyPanel({
  plan,
  onSave,
  reload,
}: {
  plan: BudgetPlan;
  onSave: (plan: BudgetPlan) => void;
  reload: () => void;
}) {
  const [store] = useState(
    () =>
      new PendingMoneyStore(
        plan,
        async (change) => {
          const saved = await budgetRequest<"savePendingBudgetMoney">(
            "/pending-money",
            "PUT",
            change,
          );
          onSave(saved);
          return saved;
        },
        reload,
      ),
  );
  useEffect(() => store.sync(plan), [plan, store]);
  const { items, saving, retryable, canUndo, canRedo, error } =
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [editing, setEditing] = useState<PendingMoney | null>(null);
  const [formError, setFormError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      const label = String(fields.get("source")).trim();
      const cents = parseDollars(String(fields.get("amount")));
      if (!label) throw Error("Enter the source of the payment.");
      if (cents < 1 || cents > 100_000_000)
        throw Error("Enter an amount between $0.01 and $1,000,000.");
      if (!editing && items.length >= 100)
        throw Error("Track up to 100 pending payments.");
      const id = editing?.id ?? crypto.randomUUID();
      store.change(
        id,
        { id, label, cents, date: String(fields.get("date")) || null },
        editing,
      );
      form.reset();
      setEditing(null);
      setFormError("");
    } catch (cause) {
      setFormError(errorMessage(cause));
    }
  }

  function closeItem(id: string) {
    store.change(id, null);
    if (editing?.id === id) {
      setEditing(null);
      setFormError("");
    }
  }

  return (
    <chakra.section
      display="grid"
      gap="3"
      borderRadius="lg"
      borderWidth="1px"
      p={{ base: "4", sm: "5" }}
      aria-labelledby="pending-money"
    >
      <chakra.div>
        <chakra.h2 id="pending-money" fontSize="lg" fontWeight="semibold">
          Money pending
        </chakra.h2>
        <chakra.p fontSize="sm" color="fg.muted">
          Track payments you might receive. These stay outside your cash and
          forecasts. When one arrives, record the actual payment in your budget
          and mark it received here.
        </chakra.p>
      </chakra.div>
      <chakra.p fontWeight="medium">
        {money(items.reduce((total, item) => total + item.cents, 0))} CAD
        pending
      </chakra.p>
      {items.length > 0 && (
        <chakra.ul display="grid" gap="2">
          {items.map((item) => (
            <chakra.li
              key={item.id}
              display="flex"
              flexWrap="wrap"
              alignItems="center"
              justifyContent="space-between"
              gap="2"
              borderBottomWidth="1px"
              pb="2"
              fontSize="sm"
            >
              <chakra.span>
                <chakra.strong>{item.label}</chakra.strong> ·{" "}
                {money(item.cents)} ·{" "}
                {item.date ? `Estimated ${item.date}` : "Date unknown"}
              </chakra.span>
              <Flex flexWrap="wrap" gap="1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit ${item.label}`}
                  onClick={() => {
                    setEditing(item);
                    setFormError("");
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Mark ${item.label} received`}
                  onClick={() => closeItem(item.id)}
                >
                  Mark received
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${item.label}`}
                  onClick={() => closeItem(item.id)}
                >
                  Remove
                </Button>
              </Flex>
            </chakra.li>
          ))}
        </chakra.ul>
      )}
      <chakra.form
        key={editing?.id ?? "new"}
        display="flex"
        flexWrap="wrap"
        alignItems="end"
        gap="3"
        onSubmit={submit}
      >
        <chakra.label display="grid" gap="1" fontSize="sm">
          Source
          <Input
            required
            name="source"
            maxLength={120}
            defaultValue={editing?.label}
          />
        </chakra.label>
        <chakra.label display="grid" gap="1" fontSize="sm">
          Amount (CAD)
          <Input
            required
            name="amount"
            inputMode="decimal"
            defaultValue={editing ? dollars(editing.cents) : ""}
          />
        </chakra.label>
        <chakra.label display="grid" gap="1" fontSize="sm">
          Estimated date (optional)
          <Input name="date" type="date" defaultValue={editing?.date ?? ""} />
        </chakra.label>
        <Button type="submit">
          {editing ? "Save changes" : "Add pending money"}
        </Button>
        {editing && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setEditing(null);
              setFormError("");
            }}
          >
            Cancel edit
          </Button>
        )}
      </chakra.form>
      <Flex flexWrap="wrap" alignItems="center" gap="2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canUndo}
          onClick={store.undo}
        >
          Undo
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canRedo}
          onClick={store.redo}
        >
          Redo
        </Button>
        {saving && (
          <chakra.span role="status" fontSize="sm" color="fg.muted">
            Saving…
          </chakra.span>
        )}
        {retryable && (
          <Button size="sm" variant="outline" onClick={store.retry}>
            Retry save
          </Button>
        )}
      </Flex>
      {formError && (
        <chakra.p role="alert" fontSize="sm" color="fg.error">
          {formError}
        </chakra.p>
      )}
      {error && (
        <chakra.p role="alert" fontSize="sm" color="fg.error">
          {error}
        </chakra.p>
      )}
    </chakra.section>
  );
}
