"use client";

import { budgetToday } from "../budget-date";

import { PageHeader } from "@/components/shared/page-layout";
import { chakra, Button, Input, Field, Stack, Grid } from "@chakra-ui/react";
import { useState, type FormEvent } from "react";
import { LoadState } from "../budget-controls";
import { money, parseDollars, useBudget } from "../budgeting-client";

export default function AffordabilityPage() {
  const today = budgetToday();
  const [query, setQuery] = useState(`?amount=0&date=${today}`);
  const [error, setError] = useState("");
  const result = useBudget<"previewBudgetPurchase">("/affordability" + query);
  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const amount = parseDollars(String(form.get("amount")));
      if (amount < 0 || amount > 100_000_000)
        throw Error("Enter an amount between $0 and $1,000,000.");
      setError("");
      setQuery(`?amount=${amount}&date=${form.get("date")}`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  const value = result.value;
  const fresh = value && query === `?amount=${value.amount}&date=${value.date}`;
  return (
    <>
      <PageHeader title="Can I afford this?" />
      <chakra.form onSubmit={preview}>
        <Stack flexDirection={{ sm: "row" }} alignItems={{ sm: "end" }}>
          <Field.Root>
            <Field.Label htmlFor="purchase-amount">
              Purchase amount (CAD)
            </Field.Label>
            <Input
              id="purchase-amount"
              name="amount"
              inputMode="decimal"
              defaultValue="0.00"
              required
            />
          </Field.Root>
          <Field.Root>
            <Field.Label htmlFor="purchase-date">Purchase date</Field.Label>
            <Input
              id="purchase-date"
              type="date"
              name="date"
              defaultValue={today}
              min={today}
              required
            />
          </Field.Root>
          <Button type="submit">Preview purchase</Button>
        </Stack>
      </chakra.form>
      {error && (
        <chakra.p role="alert" color="fg.error">
          {error}
        </chakra.p>
      )}
      {(!value || result.error) && (
        <LoadState error={result.error} retry={result.reload} />
      )}
      {value && !fresh && !result.error && (
        <chakra.p role="status">Updating preview…</chakra.p>
      )}
      {value && fresh && (
        <chakra.section
          display="flex"
          flexDirection="column"
          gap="5"
          aria-live="polite"
        >
          <chakra.p fontSize="sm" color="fg.muted">
            Preview only · no expense saved · $0 future food/leisure ·{" "}
            {money(value.reserveCents)} reserved for debt
          </chakra.p>
          {value.available === null ? (
            <chakra.p>Set your available cash in Budget plan first.</chakra.p>
          ) : (
            <>
              <Grid
                gap="6"
                borderRadius="lg"
                borderWidth="1px"
                p="5"
                gridTemplateColumns={{ sm: "repeat(3, minmax(0, 1fr))" }}
              >
                <chakra.div>
                  <chakra.p fontSize="sm" color="fg.muted">
                    Left after obligations · {value.through}
                  </chakra.p>
                  <chakra.p
                    fontSize="3xl"
                    fontWeight="semibold"
                    fontVariantNumeric="tabular-nums"
                  >
                    {value.leftoverAfter === null
                      ? "Set rent runway"
                      : money(value.leftoverAfter)}
                  </chakra.p>
                  {value.leftoverBefore !== null && (
                    <chakra.p fontSize="sm" color="fg.muted">
                      Before purchase: {money(value.leftoverBefore)}
                    </chakra.p>
                  )}
                </chakra.div>
                <chakra.div>
                  <chakra.p fontSize="sm" color="fg.muted">
                    Additional full rent months
                  </chakra.p>
                  <chakra.p
                    fontSize="3xl"
                    fontWeight="semibold"
                    fontVariantNumeric="tabular-nums"
                  >
                    {value.rentMonthsAfter ?? "—"}
                  </chakra.p>
                  <chakra.p fontSize="sm" color="fg.muted">
                    Before purchase: {value.rentMonthsBefore ?? "—"}
                  </chakra.p>
                </chakra.div>
                <chakra.div>
                  <chakra.p fontSize="sm" color="fg.muted">
                    First payment shortfall
                  </chakra.p>
                  <chakra.p fontSize="xl" fontWeight="semibold">
                    {value.shortfallAfter ?? "None in next year"}
                  </chakra.p>
                  <chakra.p fontSize="sm" color="fg.muted">
                    Before purchase:{" "}
                    {value.shortfallBefore ?? "None in next year"}
                  </chakra.p>
                </chakra.div>
              </Grid>
              <chakra.p>
                {value.shortfallAfter
                  ? "The forecast has a cash gap. Check scheduled payments before spending."
                  : "Scheduled obligations remain covered within this forecast."}
              </chakra.p>
              {value.date > value.through && (
                <chakra.p>
                  Purchase is after the leftover-balance date. It affects later
                  payment timing, not that balance.
                </chakra.p>
              )}
            </>
          )}
        </chakra.section>
      )}
    </>
  );
}
