# 0038 — Preserve source money and separate CAD valuation

Status: Accepted (Owner approved 2026-11-08)

## Context

Budgeting reports CAD, but invoices, foreign accounts, and subscriptions use USD, EUR, CHF and GBP too. A reference FX rate cannot reproduce a card settlement that includes spreads, fees or different dates. Converting original records in place would destroy evidence and make repeated imports unstable.

## Decision

Store original money separately from CAD expense totals. A saved conversion carries its rate/date/source snapshot; historical expenses never revalue on dashboard reads. Linking a foreign invoice to a CAD bank expense preserves both amounts, counting only the expense once. Forecast subscription prices may use current reference estimates independently of recorded actual payments.

One currency module owns decimal rounding, minor units, provider requests, cache policy, batching and error semantics. Frankfurter v2 is the initial provider: public daily reference rates, no credentials, no account data. Cache public quotes in the existing database; no worker, separate service or VM needed. Fetch time-series batches for imports rather than per-row requests. There is no silent fallback to today's rate for a historical expense, and missing data is an explicit error rather than zero.

The existing CAD expense columns remain reporting amounts to preserve existing forecast and matching contracts. Native money and conversion evidence are additive. Existing source amounts are not rewritten by migration. Currency participates in foreign import identity so currencies cannot collide; existing CAD identities remain unchanged.

## Consequences

Reference estimates are usable for budgets but distinct from settlement/tax evidence. Paid foreign charges require explicit matching unless trustworthy native-value evidence exists; approximate FX closeness alone is not sufficient. Current subscriptions can refresh estimated reporting values, while actual payments and original terms remain stable. Provider outages stop new conversions without damaging saved records. Additional supported fiat codes can be added with explicit minor-unit metadata and tests.
