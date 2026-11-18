"use client";

import { Button, Checkbox, CloseButton, Dialog, Field, Flex, Grid, Input, Portal, Stack, Textarea, chakra } from "@chakra-ui/react";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { FilterSelect } from "@/components/shared/filter-select";
import { currencies, currentTerm, decimalMoney, parseMoney, shiftDate, subscriptionPayments, type Currency, type Subscription } from "@quantself/budgeting";
import { budgetRequest } from "./budgeting-client";

const logoNames: Record<string, string> = {
  amazon: "Amazon Prime",
  openai: "ChatGPT",
  audible: "Audible",
  anthropic: "Claude",
  twilio: "Twilio",
  mapbox: "Mapbox",
  namecheap: "Namecheap",
  publicmobile: "Public Mobile",
};
export function SubscriptionEditor({
  item,
  today,
  onClose,
  onSave,
  defaultKind = "subscription",
  finalFocusEl,
}: {
  item: Subscription | null;
  today: string;
  onClose: () => void;
  onSave: (item: Subscription) => void;
  defaultKind?: NonNullable<Subscription["kind"]>;
  finalFocusEl?: () => HTMLElement | null;
}) {
  const term = item && currentTerm(item, today);
  const expected = item
    ? subscriptionPayments(
        { ...item, stopsOn: null, status: "active" },
        today,
        shiftDate(today, 366),
      )[0]?.date
    : undefined;
  const [kind, setKind] = useState(item?.kind ?? defaultKind);
  const [frequency, setFrequency] = useState(term?.frequency ?? "monthly");
  const [currency, setCurrency] = useState<Currency>(term?.currency ?? "CAD");
  const [converting, setConverting] = useState(false);
  const edits = useRef(0);
  const [status, setStatus] = useState(
    item?.status === "trial" ? "trial" : "active",
  );
  const [logo, setLogo] = useState(item?.logoKey ?? "none");
  const [error, setError] = useState("");
  const [historical, setHistorical] = useState(Boolean(item?.stopsOn));
  const closed = useRef(false);
  useLayoutEffect(() => {
    closed.current = false;
    return () => { closed.current = true; };
  }, []);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const version = edits.current;
    setConverting(true);
    setError("");
    try {
      const name = String(fields.get("name")).trim();
      const url = (key: string) => {
        const value = String(fields.get(key) ?? "").trim();
        if (!value) return null;
        if (new URL(value).protocol !== "https:")
          throw Error("Use HTTPS links.");
        return value;
      };
      const common = {
        id: item?.id ?? crypto.randomUUID(),
        revision: item?.revision ?? 0,
        commandId: item?.commandId ?? crypto.randomUUID(),
        name,
        kind,
        category: String(fields.get("category") ?? "").trim(),
        websiteUrl: url("website"),
        cancelUrl: url("cancel"),
        logoKey: logo === "none" ? null : logo,
        evidence: String(fields.get("evidence") ?? ""),
        sourceKey: item?.sourceKey ?? null,
      };
      if (historical) {
        const stopsOn = String(fields.get("stopsOn") ?? "");
        if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(stopsOn))
          throw Error("Enter a name and cancellation cutoff.");
        onSave({
          ...common,
          status: "active",
          terms: item?.terms ?? [],
          stopsOn,
          estimated: item?.estimated ?? false,
        });
        close();
        return;
      }
      const amountCents = parseMoney(String(fields.get("amount")), currency);
      const interval = Number(fields.get("interval"));
      const next = String(fields.get("next"));
      if (
        !name ||
        amountCents < 0 ||
        amountCents > 100_000_000 ||
        !Number.isInteger(interval) ||
        interval < 1 ||
        interval > 120
      )
        throw Error("Check the name, price, and billing interval.");

      const sameSchedule =
        term &&
        next === expected &&
        term.amountCents === amountCents &&
        (term.currency ?? "CAD") === currency &&
        term.frequency === frequency &&
        term.interval === interval;
      const conversion =
        !sameSchedule && currency !== "CAD"
          ? await budgetRequest<"convertBudgetCurrency">(
              `/currency/convert?${new URLSearchParams({ amountMinor: String(amountCents), currency, target: "CAD", date: today })}`,
            )
          : undefined;
      if (edits.current !== version) {
        setError(
          "Details changed while fetching the rate. Save again when ready.",
        );
        return;
      }
      const terms = sameSchedule
        ? item!.terms
        : [
            ...(item?.terms.filter((term) => term.effectiveOn < today) ?? []),
            {
              effectiveOn: today,
              startOn:
                term &&
                next === expected &&
                term.frequency === frequency &&
                term.interval === interval
                  ? term.startOn
                  : next,
              amountCents,
              frequency,
              interval,
              currency,
              ...(conversion
                ? {
                    cadAmountCents: conversion.converted.amountMinor,
                    conversion,
                  }
                : {}),
            },
          ];
      onSave({
        ...common,
        status: status as Subscription["status"],
        terms,
        stopsOn: item?.stopsOn ?? null,
        estimated: currency !== "CAD" || fields.has("estimated"),
      });
      close();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Check your subscription details.",
      );
    } finally {
      setConverting(false);
    }
  }
  return (
    <Dialog.Root
      open
      size="lg"
      placement="top"
      finalFocusEl={finalFocusEl}
      onOpenChange={({ open }) => {
        if (!open) close();
      }}
    >
      <Portal><Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content maxH="90dvh" overflowY="auto">
          <Dialog.Header>
            <Dialog.Title>{item ? item.name : "Add recurring"}</Dialog.Title>
            <Dialog.Description srOnly>
              Set the billing schedule and optional management links.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body pb="5">
          <chakra.form
            display="flex"
            flexDirection="column"
            gap="4"
            onSubmit={save}
            onChangeCapture={() => {
              edits.current++;
            }}
          >
            <Stack>
              <Field.Root>
                <Field.Label htmlFor="subscription-name">
                  Company / subscription
                </Field.Label>
                <Input
                  id="subscription-name"
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={item?.name}
                  autoFocus
                />
              </Field.Root>
              <Grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                <Field.Root>
                  <Field.Label htmlFor="subscription-kind">Type</Field.Label>
                  <FilterSelect id="subscription-kind" label="Type" size="md" w="full" highlightActive={false}
                    value={kind} onChange={value => setKind(value as typeof kind)}
                    items={[{ value: "subscription", label: "Subscription" }, { value: "bill", label: "Bill" }, { value: "income", label: "Income" }]} />
                </Field.Root>
                <Field.Root>
                  <Field.Label htmlFor="subscription-category">Category</Field.Label>
                  <Input id="subscription-category" name="category" maxLength={80} defaultValue={item?.category} />
                </Field.Root>
              </Grid>
              <Checkbox.Root
                checked={historical}
                disabled={Boolean(item?.stopsOn)}
                fontSize="sm"
                onCheckedChange={(event) => setHistorical(event.checked === true)}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>Canceled / historical subscription</Checkbox.Label>
              </Checkbox.Root>
              {historical ? (
                <Field.Root>
                  <Field.Label htmlFor="subscription-cutoff">
                    No charges on or after
                  </Field.Label>
                  <Input
                    id="subscription-cutoff"
                    name="stopsOn"
                    type="date"
                    required
                    defaultValue={item?.stopsOn ?? today}
                  />
                  <chakra.p fontSize="xs" color="fg.muted">
                    No schedule required. Keep known charges and service dates
                    in the notes; existing billing history is preserved.
                  </chakra.p>
                </Field.Root>
              ) : (
                <>
                  <Grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                    <Field.Root>
                      <Field.Label htmlFor="subscription-amount">
                        Charge ({currency})
                      </Field.Label>
                      <Input
                        id="subscription-amount"
                        name="amount"
                        inputMode="decimal"
                        required
                        defaultValue={
                          term
                            ? decimalMoney({
                                amountMinor: term.amountCents,
                                currency: term.currency ?? "CAD",
                              })
                            : ""
                        }
                      />
                    </Field.Root>
                    <Field.Root>
                      <Field.Label htmlFor="subscription-next">
                        Next payment
                      </Field.Label>
                      <Input
                        id="subscription-next"
                        name="next"
                        type="date"
                        min={today}
                        required
                        defaultValue={expected ?? today}
                      />
                    </Field.Root>
                  </Grid>
                  <Grid gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                    <Field.Root>
                      <Field.Label htmlFor="subscription-interval">
                        Every
                      </Field.Label>
                      <Input
                        id="subscription-interval"
                        name="interval"
                        type="number"
                        min={1}
                        max={120}
                        required
                        defaultValue={term?.interval ?? 1}
                      />
                    </Field.Root>
                    <Field.Root>
                      <Field.Label htmlFor="subscription-frequency">
                        Period
                      </Field.Label>
                      <FilterSelect
                        id="subscription-frequency"
                        label="Period"
                        size="md"
                        w="full"
                        highlightActive={false}
                        value={frequency}
                        onChange={(value) => setFrequency(value as typeof frequency)}
                        items={[
                          { value: "daily", label: "Days" },
                          { value: "weekly", label: "Weeks" },
                          { value: "monthly", label: "Months" },
                          { value: "yearly", label: "Years" },
                        ]}
                      />
                    </Field.Root>
                  </Grid>
                  <Field.Root>
                    <Field.Label htmlFor="subscription-currency">
                      Billing currency
                    </Field.Label>
                    <FilterSelect
                      id="subscription-currency"
                      label="Billing currency"
                      size="md"
                      w="full"
                      highlightActive={false}
                      value={currency}
                      onChange={(value) => setCurrency(value as Currency)}
                      items={currencies.map((code) => ({ value: code, label: code }))}
                    />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label htmlFor="subscription-status">
                      Status
                    </Field.Label>
                    <FilterSelect
                      id="subscription-status"
                      label="Status"
                      size="md"
                      w="full"
                      highlightActive={false}
                      value={status}
                      onChange={(value) => setStatus(value)}
                      items={[
                        { value: "active", label: "Active" },
                        { value: "trial", label: "Trial — first charge on next payment date" },
                      ]}
                    />
                  </Field.Root>
                  <Checkbox.Root
                    name="estimated"
                    defaultChecked={item?.estimated}
                    fontSize="sm"
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>Estimated CAD amount</Checkbox.Label>
                  </Checkbox.Root>
                </>
              )}
            </Stack>
            <chakra.details>
              <chakra.summary cursor="pointer" fontSize="sm">
                Links and logo
              </chakra.summary>
              <Stack mt="3">
                <Field.Root>
                  <Field.Label htmlFor="subscription-website">
                    Manage account URL
                  </Field.Label>
                  <Input
                    id="subscription-website"
                    name="website"
                    type="url"
                    placeholder="https://"
                    defaultValue={item?.websiteUrl ?? ""}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label htmlFor="subscription-cancel">
                    Cancellation URL
                  </Field.Label>
                  <Input
                    id="subscription-cancel"
                    name="cancel"
                    type="url"
                    placeholder="https://"
                    defaultValue={item?.cancelUrl ?? ""}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label htmlFor="subscription-logo">
                    Company logo
                  </Field.Label>
                  <FilterSelect
                    id="subscription-logo"
                    label="Logo"
                    size="md"
                    w="full"
                    highlightActive={false}
                    value={logo}
                    onChange={(value) => setLogo(value)}
                    items={[{ value: "none", label: "Initials" }, ...Object.entries(logoNames).map(([key, name]) => ({ value: key, label: name }))]}
                  />
                </Field.Root>
              </Stack>
            </chakra.details>
            <Field.Root>
              <Field.Label htmlFor="subscription-evidence">
                Notes and billing evidence
              </Field.Label>
              <Textarea
                id="subscription-evidence"
                name="evidence"
                maxLength={3000}
                defaultValue={item?.evidence ?? ""}
                rows={4}
              />
            </Field.Root>
            {item?.stopsOn && (
              <chakra.p fontSize="sm">
                Cancellation recorded: no charges from {item.stopsOn}. Editing
                keeps this cancellation.
              </chakra.p>
            )}
            {error && (
              <chakra.p role="alert" fontSize="sm" color="fg.error">
                {error}
              </chakra.p>
            )}
            <Flex justifyContent="flex-end" gap="2">
              <Button type="button" variant="outline" onClick={close}>
                Close
              </Button>
              <Button type="submit" disabled={converting}>
                {converting ? "Getting rate…" : "Save subscription"}
              </Button>
            </Flex>
          </chakra.form>
          </Dialog.Body>
          <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
        </Dialog.Content>
      </Dialog.Positioner></Portal>
    </Dialog.Root>
  );
}
