"use client";

import { FilterSelect } from "@/components/shared/filter-select";
import { PageHeader } from "@/components/shared/page-layout";
import { chakra, Button, Checkbox, Input, Grid } from "@chakra-ui/react";

import {
  currencies,
  formatMoney,
  parseMoney,
  type Currency,
} from "@quantself/budgeting";

import { useState } from "react";
import type { operations } from "@/lib/generated/quantself-api-schema";
import { budgetRequest, errorMessage } from "../budgeting-client";

type BankAccount = NonNullable<
  operations["importBudgetBank"]["requestBody"]
>["content"]["application/json"]["account"];
const accountLabels: Record<BankAccount, string> = {
  "rbc-chequing": "RBC Chequing",
  "rbc-ion-visa": "RBC ION+ Visa",
  "rbc-savings": "RBC Savings",
  bmo: "BMO",
  cua: "CUA",
  "account-1": "Account 1",
  "account-2": "Account 2",
};

type Flow = "expense" | "refund" | "deposit" | "transfer";
type BankRow = {
  date: string;
  merchant: string;
  totalCents: number;
  flow: Flow;
  reference?: string;
  food?: boolean;
};
const fields = ["date", "merchant", "amount", "credit", "reference"] as const;
type Field = (typeof fields)[number];
const aliases: Record<Field, RegExp> = {
  date: /^(date|posted date|posting date|transaction date)$/i,
  merchant:
    /^(description|merchant|payee|transaction description|details|name)$/i,
  amount: /^(amount|debit|debit amount|withdrawal|withdrawals)$/i,
  credit: /^(credit|credit amount|deposit|deposits)$/i,
  reference:
    /^(transaction id|reference|reference number|transaction number)$/i,
};
const labels = {
  date: "Date",
  merchant: "Merchant or description",
  amount: "Amount or debit",
  credit: "Credit (optional)",
  reference: "Bank transaction ID (optional)",
};
const transferPattern =
  /\b(?:transfer between accounts|internal transfer|credit card payment|payment received|payment thank you)\b/i;

function csvDate(value: string, order: string) {
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)) {
    const [year, month, day] = value.split(/[-/]/);
    return [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
  }
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match)
    throw Error(
      "Date format must be YYYY-MM-DD, YYYY/MM/DD, or a numeric date with a four-digit year.",
    );
  const [month, day] =
    order === "mdy" ? [match[1], match[2]] : [match[2], match[1]];
  return [match[3], month.padStart(2, "0"), day.padStart(2, "0")].join("-");
}

function amount(value: string, currency: Currency) {
  const cleaned = value
    .replace(/[$,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1")
    .replace(/^\+/, "");
  return cleaned ? parseMoney(cleaned, currency) : 0;
}

export default function BudgetImportPage() {
  const [currency, setCurrency] = useState<Currency>("CAD");
  const [account, setAccount] = useState<BankAccount | "">("");
  const [records, setRecords] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<Field, number>>({
    date: -1,
    merchant: -1,
    amount: -1,
    credit: -1,
    reference: -1,
  });
  const [header, setHeader] = useState(true);
  const [order, setOrder] = useState("mdy");
  const [negative, setNegative] = useState(true);
  const [preview, setPreview] = useState<BankRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const columns = records[0] ?? [];

  async function load(file: File) {
    setError("");
    setNotice("");
    setPreview([]);
    setRecords([]);
    try {
      if (file.size > 4_000_000) throw Error("Choose a CSV under 4 MB.");
      const { parse } = await import("csv-parse/browser/esm/sync");
      const rows: string[][] = parse(await file.text(), {
        bom: true,
        trim: true,
        skip_empty_lines: true,
      });
      if (!rows.length || rows.length > 5001)
        throw Error("Choose a CSV with up to 5,000 transactions.");
      setRecords(rows);
      const hasHeaders = rows[0].some((column) =>
        fields.some((field) => aliases[field].test(column)),
      );
      setHeader(hasHeaders);
      setMapping(
        Object.fromEntries(
          fields.map((field) => [
            field,
            hasHeaders
              ? rows[0].findIndex((column) => aliases[field].test(column))
              : -1,
          ]),
        ) as Record<Field, number>,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function buildPreview() {
    setError("");
    setNotice("");
    setPreview([]);
    try {
      if (mapping.date < 0 || mapping.amount < 0)
        throw Error("Select the date and amount or debit columns.");
      const selected = Object.values(mapping).filter((index) => index >= 0);
      if (new Set(selected).size !== selected.length)
        throw Error("Select a different CSV column for each field.");
      const start = header ? 1 : 0;
      const rows = records.slice(start).flatMap((row, index): BankRow[] => {
        try {
          const date = csvDate(row[mapping.date], order);
          if (new Date(date + "T00:00:00Z").toJSON()?.slice(0, 10) !== date)
            throw Error("Invalid transaction date.");
          const merchant = row[mapping.merchant] || "";
          const debit = amount(row[mapping.amount] || "", currency);
          const credit = amount(row[mapping.credit] || "", currency);
          if (mapping.credit >= 0 && debit && credit)
            throw Error("Both debit and credit are populated.");
          let totalCents = debit;
          if (mapping.credit >= 0) {
            totalCents = Math.abs(debit) - Math.abs(credit);
          } else if (negative) {
            totalCents = -debit;
          }
          if (!totalCents) return [];

          let flow: Flow;
          if (transferPattern.test(merchant)) {
            flow = "transfer";
          } else if (totalCents > 0) {
            flow = "expense";
          } else if (/\brefund\b/i.test(merchant)) {
            flow = "refund";
          } else {
            flow = "deposit";
          }
          return [
            {
              date,
              merchant,
              totalCents,
              flow,
              reference: row[mapping.reference] || undefined,
            },
          ];
        } catch (cause) {
          throw Error(`CSV row ${index + start + 1}: ${errorMessage(cause)}`);
        }
      });
      if (!rows.length)
        throw Error("There are no nonzero transactions to import.");
      setPreview(rows);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function save() {
    if (!account) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await budgetRequest<"importBudgetBank">(
        "/bank/import",
        "POST",
        { account, rows: preview.map((row) => ({ ...row, currency })) },
      );
      setNotice(
        `Imported ${result.inserted}. Already present: ${result.existing}.`,
      );
      setPreview([]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Import bank CSV"
        description="Use the same account slot every time you import an export from that account. CSV column selection happens in your browser."
      />
      <chakra.section
        display="grid"
        gap="4"
        borderRadius="lg"
        borderWidth="1px"
        p="4"
      >
        <Grid gap="3" gridTemplateColumns={{ sm: "repeat(2, minmax(0, 1fr))" }}>
          <chakra.label display="grid" gap="1" fontSize="sm">
            Bank account
            <FilterSelect
              label="Bank account"
              size="md"
              w="full"
              highlightActive={false}
              value={account}
              disabled={pending}
              onChange={(value) => setAccount(value as BankAccount | "")}
              items={[{ value: "", label: "Choose account" }, ...Object.entries(accountLabels).map(([id, label]) => ({ value: id, label }))]}
            />
          </chakra.label>
          <chakra.label display="grid" gap="1" fontSize="sm">
            Account currency
            <FilterSelect
              label="Account currency"
              size="md"
              w="full"
              highlightActive={false}
              value={currency}
              disabled={pending}
              onChange={(value) => {
                setCurrency(value as Currency);
                setPreview([]);
              }}
              items={currencies.map((code) => ({ value: code, label: code }))}
            />
          </chakra.label>
          <chakra.label display="grid" gap="1" fontSize="sm">
            Posted transactions CSV
            <Input
              type="file"
              accept=".csv,text/csv"
              disabled={pending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void load(file);
              }}
            />
          </chakra.label>
        </Grid>
        {columns.length > 0 && (
          <>
            <Checkbox.Root
              checked={header}
              disabled={pending}
              fontSize="sm"
              onCheckedChange={(e) => {
                setHeader(e.checked === true);
                setPreview([]);
              }}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label>First row is a header</Checkbox.Label>
            </Checkbox.Root>
            <Grid
              gap="3"
              gridTemplateColumns={{ sm: "repeat(3, minmax(0, 1fr))" }}
            >
              {fields.map((field) => (
                <chakra.label key={field} display="grid" gap="1" fontSize="sm">
                  {labels[field]}
                  <FilterSelect
                    label={labels[field]}
                    size="md"
                    w="full"
                    highlightActive={false}
                    disabled={pending}
                    value={String(mapping[field])}
                    onChange={(value) => {
                      setMapping({
                        ...mapping,
                        [field]: Number(value),
                      });
                      setPreview([]);
                    }}
                    items={[
                      { value: "-1", label: "Choose column" },
                      ...columns.map((column, index) => ({
                        value: String(index),
                        label: header ? column : `Column ${index + 1} · ${column}`,
                      })),
                    ]}
                  />
                </chakra.label>
              ))}
              <chakra.label display="grid" gap="1" fontSize="sm">
                Date order when year is last
                <FilterSelect
                  label="Date order when year is last"
                  size="md"
                  w="full"
                  highlightActive={false}
                  disabled={pending}
                  value={order}
                  onChange={(value) => {
                    setOrder(value as typeof order);
                    setPreview([]);
                  }}
                  items={[
                    { value: "mdy", label: "Month / Day / Year" },
                    { value: "dmy", label: "Day / Month / Year" },
                  ]}
                />
              </chakra.label>
            </Grid>
            {mapping.credit < 0 && (
              <Checkbox.Root
                checked={negative}
                disabled={pending}
                fontSize="sm"
                onCheckedChange={(e) => {
                  setNegative(e.checked === true);
                  setPreview([]);
                }}
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
                <Checkbox.Label>Debits are negative in this CSV</Checkbox.Label>
              </Checkbox.Root>
            )}
            <chakra.div>
              <Button
                variant="outline"
                disabled={pending}
                onClick={buildPreview}
              >
                Preview transactions
              </Button>
            </chakra.div>
          </>
        )}
      </chakra.section>
      {error && (
        <chakra.p role="alert" color="fg.error">
          {error}
        </chakra.p>
      )}
      {notice && <chakra.p role="status">{notice}</chakra.p>}
      {currency !== "CAD" && (
        <chakra.p fontSize="sm" color="fg.muted">
          Import the account’s native currency. CAD reporting uses dated
          reference estimates; original amounts remain saved. For a CAD account,
          keep CAD even when purchases were made abroad.
        </chakra.p>
      )}
      {preview.length > 0 && (
        <chakra.section display="grid" gap="3">
          <chakra.p fontSize="sm" color="fg.muted">
            {preview.length} transactions. Mark transfers and credit card
            payments as transfers so they stay out of spending totals. Deposits
            are retained separately from planned income.
          </chakra.p>
          <chakra.div
            maxHeight="96"
            overflow="auto"
            borderRadius="sm"
            borderWidth="1px"
          >
            <chakra.table width="full" fontSize="sm">
              <chakra.thead>
                <chakra.tr textAlign="left">
                  <chakra.th p="2">Date</chakra.th>
                  <chakra.th>Description</chakra.th>
                  <chakra.th>Amount</chakra.th>
                  <chakra.th>Type</chakra.th>
                  <chakra.th>Food</chakra.th>
                </chakra.tr>
              </chakra.thead>
              <chakra.tbody>
                {preview.map((row, index) => (
                  <chakra.tr borderTopWidth="1px" key={index}>
                    <chakra.td whiteSpace="nowrap" p="2">
                      {row.date}
                    </chakra.td>
                    <chakra.td>{row.merchant || "—"}</chakra.td>
                    <chakra.td whiteSpace="nowrap">
                      {formatMoney({ amountMinor: row.totalCents, currency })}
                    </chakra.td>
                    <chakra.td>
                      <FilterSelect
                        label={`Transaction ${index + 1} type`}
                        size="sm"
                        w="full"
                        highlightActive={false}
                        disabled={pending}
                        value={row.flow}
                        onChange={(value) => {
                          const flow = value as Flow;
                          setPreview((rows) =>
                            rows.map((entry, i) =>
                              i === index
                                ? {
                                    ...entry,
                                    flow,
                                    food:
                                      (flow === "expense" ||
                                        flow === "refund") &&
                                      entry.food,
                                  }
                                : entry,
                            ),
                          );
                        }}
                        items={[
                          ...(row.totalCents > 0
                            ? [{ value: "expense", label: "Expense" }]
                            : [
                                { value: "deposit", label: "Deposit" },
                                { value: "refund", label: "Refund" },
                              ]),
                          { value: "transfer", label: "Transfer" },
                        ]}
                      />
                    </chakra.td>
                    <chakra.td>
                      <Checkbox.Root
                        checked={row.food ?? false}
                        disabled={
                          pending ||
                          (row.flow !== "expense" && row.flow !== "refund")
                        }
                        onCheckedChange={(e) => {
                          const food = e.checked === true;
                          setPreview((rows) =>
                            rows.map((entry, i) =>
                              i === index ? { ...entry, food } : entry,
                            ),
                          );
                        }}
                      >
                        <Checkbox.HiddenInput aria-label={`Transaction ${index + 1} is food`} />
                        <Checkbox.Control />
                      </Checkbox.Root>
                    </chakra.td>
                  </chakra.tr>
                ))}
              </chakra.tbody>
            </chakra.table>
          </chakra.div>
          <chakra.div>
            <Button disabled={pending || !account} onClick={() => void save()}>
              {pending
                ? "Importing…"
                : account
                  ? `Import to ${accountLabels[account]}`
                  : "Choose a bank account"}
            </Button>
          </chakra.div>
        </chakra.section>
      )}
    </>
  );
}
