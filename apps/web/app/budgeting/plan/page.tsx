"use client";

import { budgetToday } from "../budget-date";

import { PageHeader } from "@/components/shared/page-layout";
import { chakra, Button, Input, Flex, Grid } from "@chakra-ui/react";

import { useState, type FormEvent } from "react";
import { BudgetNoteEditor } from "../budget-note-editor";
import { PendingMoneyPanel } from "./pending-money-panel";
import { LoadState } from "../budget-controls";
import {
  budgetRequest,
  dollars,
  errorMessage,
  money,
  parseDollars,
  useBudget,
  type BudgetPlan,
} from "../budgeting-client";

export default function BudgetPlanPage() {
  const data = useBudget<"getBudgetPlan">("/plan");
  const forecast = useBudget<"getBudgetOverview">("");
  function refreshPlan() {
    data.reload();
    forecast.reload();
  }
  return (
    <>
      <PageHeader
        title="Budget plan"
        description="See what’s coming in, what’s due, and whether your cash covers it."
      />
      <chakra.section
        borderRadius="lg"
        borderWidth="1px"
        background="bg.panel"
        p={{ base: "4", sm: "5" }}
        aria-labelledby="plan-forecast"
      >
        <chakra.h2 id="plan-forecast" fontSize="lg" fontWeight="semibold">
          Cash forecast
        </chakra.h2>
        {forecast.value && (
          <Grid mt="2" gap="3">
            <chakra.p fontSize="xl" fontWeight="semibold">
              {forecast.value.shortfall
                ? `First projected shortfall on ${forecast.value.shortfall}`
                : forecast.value.months.length
                  ? "No projected shortfall in the next 12 months"
                  : forecast.value.available === null
                    ? "Set your available cash to start the forecast"
                    : "Set weekly Food and Other limits to see your runway"}
            </chakra.p>
            {forecast.value.available !== null && (
              <chakra.p fontSize="sm" color="fg.muted">
                {money(forecast.value.available)} estimated available
              </chakra.p>
            )}
            {forecast.value.months.length > 0 && (
              <chakra.ol
                aria-label="Projected month-end balances"
                display="flex"
                gap="5"
                overflowX="auto"
                borderTopWidth="1px"
                pt="3"
              >
                {forecast.value.months.map((month) => (
                  <chakra.li key={month.month} minWidth="24">
                    <chakra.p fontSize="xs" color="fg.muted">
                      {month.month}
                    </chakra.p>
                    <chakra.p
                      fontFamily="mono"
                      color={month.cents < 0 ? "fg.error" : undefined}
                    >
                      {money(month.cents)}
                    </chakra.p>
                  </chakra.li>
                ))}
              </chakra.ol>
            )}
          </Grid>
        )}
        {(!forecast.value || forecast.error) && (
          <LoadState error={forecast.error} retry={forecast.reload} />
        )}
      </chakra.section>
      {data.value && data.error && (
        <LoadState error={data.error} retry={data.reload} />
      )}
      {data.value && (
        <PendingMoneyPanel
          plan={data.value}
          onSave={data.setValue}
          reload={data.reload}
        />
      )}
      {data.value ? (
        <PlanEditor
          value={data.value}
          onChange={(next) => {
            data.setValue(next);
            forecast.reload();
          }}
          reload={refreshPlan}
        />
      ) : (
        <LoadState error={data.error} retry={data.reload} />
      )}
    </>
  );
}

function PlanEditor({
  value,
  onChange,
  reload,
}: {
  value: BudgetPlan;
  onChange: (value: BudgetPlan) => void;
  reload: () => void;
}) {
  const [noteOpened, setNoteOpened] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const note = draft ?? value.note;
  const dirty = note !== value.note;
  const today = budgetToday();
  async function save(
    action: "saveBudgetNote" | "resetBudgetCheckpoint" | "decideBudgetProposal",
    path: string,
    payload: object,
    success: string,
  ) {
    setPending(action);
    setError("");
    setNotice("");
    try {
      const next = await budgetRequest<typeof action>(
        path,
        action === "decideBudgetProposal" ? "POST" : "PUT",
        { ...payload, revision: value.revision },
      );
      onChange(next);
      if (action === "saveBudgetNote")
        setDraft((current) => (current === note ? null : current));
      setNotice(success);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending("");
    }
  }
  function resetCash(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    try {
      const cents = parseDollars(String(fields.get("cash")));
      if (cents < 0) throw Error("Enter the cash currently available.");
      void save(
        "resetBudgetCheckpoint",
        "/checkpoint",
        { checkpoint: { cents, date: fields.get("date") } },
        "Cash balance reset.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const proposal = value.proposal;
  const limit = (cents: number | null) =>
    cents === null ? "unset" : money(cents);
  return (
    <>
      <chakra.section
        borderRadius="lg"
        borderWidth="1px"
        p={{ base: "4", sm: "5" }}
      >
        <chakra.h2 mb="3" fontSize="lg" fontWeight="semibold">
          Cash balance checkpoint
        </chakra.h2>
        <chakra.p mb="3" fontSize="sm" color="fg.muted">
          {value.plan.checkpoint
            ? `${money(value.plan.checkpoint.cents)} as of ${value.plan.checkpoint.date}${value.plan.checkpoint.recordedAt ? "" : " (end of day)"}`
            : "Enter your cash now, or the end-of-day balance for a past date."}
        </chakra.p>
        <chakra.form
          key={value.plan.checkpoint?.date + ":" + value.plan.checkpoint?.cents}
          display="flex"
          flexWrap="wrap"
          alignItems="end"
          gap="3"
          onSubmit={resetCash}
        >
          <chakra.label display="grid" gap="1" fontSize="sm">
            Available cash (CAD)
            <Input
              required
              name="cash"
              inputMode="decimal"
              defaultValue={
                value.plan.checkpoint
                  ? dollars(value.plan.checkpoint.cents)
                  : ""
              }
            />
          </chakra.label>
          <chakra.label display="grid" gap="1" fontSize="sm">
            As of
            <Input
              required
              name="date"
              type="date"
              defaultValue={today}
              max={today}
            />
          </chakra.label>
          <Button type="submit" disabled={!!pending}>
            {pending === "resetBudgetCheckpoint" ? "Saving…" : "Reset balance"}
          </Button>
        </chakra.form>
      </chakra.section>
      <chakra.section display="grid" gap="3" aria-labelledby="current-plan">
        <Flex
          flexWrap="wrap"
          alignItems="center"
          justifyContent="space-between"
          gap="2"
        >
          <chakra.h2 id="current-plan" fontSize="lg" fontWeight="semibold">
            Current plan
          </chakra.h2>
          <Button variant="outline" disabled={!!pending} onClick={reload}>
            Refresh plan and proposals
          </Button>
        </Flex>
        <chakra.p fontSize="sm">
          Weekly Food {limit(value.plan.foodCents)} · Other{" "}
          {limit(value.plan.otherCents)}
        </chakra.p>
        {value.plan.entries.length > 0 ? (
          <chakra.ul display="grid" gap="2">
            {[...value.plan.entries]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((item) => (
                <chakra.li
                  key={item.id}
                  display="flex"
                  flexWrap="wrap"
                  alignItems="baseline"
                  justifyContent="space-between"
                  columnGap="4"
                  rowGap="1"
                  borderBottomWidth="1px"
                  py="2"
                  fontSize="sm"
                >
                  <chakra.span>
                    <chakra.span fontWeight="medium">{item.label}</chakra.span>{" "}
                    ·{" "}
                    <chakra.span color="fg.muted">
                      {item.kind === "bill"
                        ? "Bill"
                        : item.kind === "income"
                          ? "Income"
                          : "Uncertain income"}
                    </chakra.span>
                  </chakra.span>
                  <chakra.span>
                    {money(item.cents)} ·{" "}
                    {item.frequency === "monthly"
                      ? `Monthly from ${item.date}`
                      : item.date}
                  </chakra.span>
                </chakra.li>
              ))}
          </chakra.ul>
        ) : (
          <chakra.p fontSize="sm" color="fg.muted">
            Ask Codex directly to propose bills, paydays, and spending limits.
          </chakra.p>
        )}
      </chakra.section>
      {notice && (
        <chakra.p role="status" fontSize="sm" color="fg.muted">
          {notice}
        </chakra.p>
      )}
      {error && (
        <chakra.p role="alert" color="fg.error">
          {error}
        </chakra.p>
      )}
      {proposal && (
        <chakra.section
          display="flex"
          flexDirection="column"
          gap="3"
          borderRadius="lg"
          borderWidth="1px"
          p="4"
        >
          <chakra.h2 fontSize="lg" fontWeight="semibold">
            Review proposed changes
          </chakra.h2>
          <chakra.ul display="grid" gap="2" fontSize="sm">
            {proposal.checkpoint && (
              <chakra.li>
                Cash checkpoint → {money(proposal.checkpoint.cents)} on{" "}
                {proposal.checkpoint.date}
              </chakra.li>
            )}
            {proposal.rentRunway && (
              <chakra.li>
                Rent runway through {proposal.rentRunway.through} ·{" "}
                {money(proposal.rentRunway.reserveCents)} debt reserve · Rent
                entry{" "}
                {proposal.upsert?.find(
                  (entry) => entry.id === proposal.rentRunway?.rentEntryId,
                )?.label ??
                  value.plan.entries.find(
                    (entry) => entry.id === proposal.rentRunway?.rentEntryId,
                  )?.label ??
                  proposal.rentRunway.rentEntryId}
              </chakra.li>
            )}
            {proposal.foodCents !== undefined && (
              <chakra.li>
                Weekly Food {limit(value.plan.foodCents)} →{" "}
                {money(proposal.foodCents)}
              </chakra.li>
            )}
            {proposal.otherCents !== undefined && (
              <chakra.li>
                Weekly Other {limit(value.plan.otherCents)} →{" "}
                {money(proposal.otherCents)}
              </chakra.li>
            )}
            {proposal.upsert?.map((item) => {
              const old = value.plan.entries.find(
                (entry) => entry.id === item.id,
              );
              return (
                <chakra.li key={item.id}>
                  {old
                    ? `Change ${old.label} (${money(old.cents)}, ${old.date}, ${old.frequency}) →`
                    : "Add"}{" "}
                  {item.label} · {item.kind} · {money(item.cents)} · {item.date}{" "}
                  · {item.frequency}
                </chakra.li>
              );
            })}
            {proposal.remove?.map((id) => (
              <chakra.li key={id}>
                Remove{" "}
                {value.plan.entries.find((entry) => entry.id === id)?.label ??
                  id}
              </chakra.li>
            ))}
          </chakra.ul>
          <Flex flexWrap="wrap" gap="2">
            <Button
              disabled={dirty || !!pending}
              onClick={() =>
                void save(
                  "decideBudgetProposal",
                  "/proposal/decision",
                  { action: "apply" },
                  "Budget updated.",
                )
              }
            >
              Apply changes
            </Button>
            <Button
              variant="outline"
              disabled={!!pending}
              onClick={() =>
                void save(
                  "decideBudgetProposal",
                  "/proposal/decision",
                  { action: "dismiss" },
                  "Proposal dismissed.",
                )
              }
            >
              Dismiss
            </Button>
          </Flex>
          {dirty && (
            <chakra.p fontSize="sm" color="fg.muted">
              Save your planning context, then refresh your proposal.
            </chakra.p>
          )}
        </chakra.section>
      )}
      <chakra.details
        borderRadius="lg"
        borderWidth="1px"
        p="4"
        onToggle={(event) => {
          if (event.currentTarget.open) setNoteOpened(true);
        }}
      >
        <chakra.summary cursor="pointer" fontWeight="medium">
          Planning context{dirty ? " · Unsaved changes" : ""}
        </chakra.summary>
        <Grid mt="3" gap="3">
          <chakra.p fontSize="sm" color="fg.muted">
            Optional notes about the assumptions and goals behind your plan.
          </chakra.p>
          {noteOpened && <BudgetNoteEditor value={note} onChange={setDraft} />}
          <chakra.div>
            <Button
              disabled={!dirty || !!pending}
              onClick={() =>
                void save(
                  "saveBudgetNote",
                  "/note",
                  { note },
                  "Planning context saved.",
                )
              }
            >
              {pending === "saveBudgetNote"
                ? "Saving…"
                : "Save planning context"}
            </Button>
          </chakra.div>
        </Grid>
      </chakra.details>
    </>
  );
}
