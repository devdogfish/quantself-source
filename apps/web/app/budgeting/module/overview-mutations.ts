import type { ModuleOverview } from "./overview-client";
import { unappliedTransactionIntents, type TransactionSnapshot } from "./transaction-queue";
import type { Transaction } from "./transaction-client";

type Statement = ModuleOverview["statements"][number];
type CashContext = NonNullable<ModuleOverview["context"]>;
type Snapshot<T> = { value: T; version: number; applied?: string[] };
export type OverviewSnapshot = Snapshot<ModuleOverview>;
export type CashSnapshot = Snapshot<CashContext> & { rules?: ModuleOverview["rules"] };

function projectStatement(statement: Statement, intents: ReturnType<typeof unappliedTransactionIntents>, today: string): Statement {
  if (!statement.spending || !intents.some(intent => intent.changes.length)) return statement;
  const spending = new Map(statement.spending.map(row => [row.id, row]));
  const inside = (row: Transaction) => !row.billKey && row.date >= statement.start && row.date <= statement.end && row.date <= today;
  for (const { command, changes } of intents) for (const { before, after } of changes) {
    if (command.type === "add" && after && inside(after)) {
      const { id, date, merchant, cents, foodCents, allowance, category, reviewed, receipt, original } = after;
      spending.set(id, { id, date, merchant, cents, foodCents, allowance, category, reviewed, receipt, original });
    } else if (command.type === "remove" && before) {
      spending.delete(before.id);
    } else if (after) {
      const row = spending.get(after.id);
      if (!row) continue;
      if (command.type === "move") {
        spending.set(row.id, { ...row, allowance: after.allowance, category: after.category, foodCents: after.foodCents });
      } else if (command.type === "review" || command.type === "reviewAll") {
        spending.set(row.id, { ...row, reviewed: after.reviewed });
      } else if (command.type === "receipt") {
        spending.set(row.id, { ...row, receipt: after.receipt });
      }
    }
  }
  const rows = [...spending.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const categories = new Map<string, Statement["cats"][number]>();
  for (const { category: name, allowance, cents } of rows) {
    const current = categories.get(name) ?? { name, allowance, cents: 0, count: 0 };
    current.cents += cents;
    current.count++;
    categories.set(name, current);
  }
  const spent = rows.reduce((sum, row) => sum + row.cents, 0);
  return { ...statement, spending: rows, cats: [...categories.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)),
    totals: { ...statement.totals, spending: spent }, net: statement.net + statement.totals.spending - spent };
}

function futureBurnChanges(context: CashContext, intents: ReturnType<typeof unappliedTransactionIntents>) {
  const changes = intents.flatMap(intent => intent.command.type === "limit" ? [intent.command] : []);
  if (!changes.length) return null;
  const original = context.futureLimits ?? [];
  const projected = new Map(original.map(limit => [`${limit.week}:${limit.allowance}`, limit]));
  for (const { week, allowance, after } of changes) {
    const key = `${week}:${allowance}`;
    if (after === null) projected.delete(key);
    else projected.set(key, { week, allowance, cents: after });
  }
  const weeks = [...new Set([...original, ...projected.values()].map(limit => limit.week))].sort();
  const before = { food: context.foodLimit ?? 0, other: context.otherLimit ?? 0 };
  const after = { ...before };
  const saved = new Map(original.map(limit => [`${limit.week}:${limit.allowance}`, limit.cents]));
  return weeks.map(week => {
    for (const allowance of ["food", "other"] as const) {
      const key = `${week}:${allowance}`;
      before[allowance] = saved.get(key) ?? before[allowance];
      after[allowance] = projected.get(key)?.cents ?? after[allowance];
    }
    return { week, before: before.food + before.other, after: after.food + after.other };
  });
}

function projectCash(snapshot: CashSnapshot, queue: TransactionSnapshot, today: string) {
  const context = snapshot.value;
  const checkpointDate = context.checkpointDate;
  if (context.cash === null || !checkpointDate) return context;
  const intents = unappliedTransactionIntents(queue, snapshot.version, snapshot.applied);
  const movements = new Map<string, number>();
  for (const { command } of intents) {
    if (command.type !== "add" && command.type !== "remove") continue;
    const { date, cents } = command.expense;
    // The form records a manual expense now, after any same-day recorded checkpoint.
    if (date > today || date < checkpointDate || date === checkpointDate && !context.checkpointRecordedAt) continue;
    movements.set(date, (movements.get(date) ?? 0) + (command.type === "add" ? -cents : cents));
  }
  const burnChanges = futureBurnChanges(context, intents);
  if (!movements.size && !burnChanges?.some(limit => limit.before !== limit.after)) return context;
  const movementDelta = (through: string) => [...movements].reduce((sum, [date, cents]) => date <= through ? sum + cents : sum, 0);
  const initialBurn = (context.foodLimit ?? 0) + (context.otherLimit ?? 0);
  let before = 0;
  let after = 0;
  let boundary = 0;
  const balance = context.balance.map(point => {
    if (!point.past && burnChanges) {
      while (boundary < burnChanges.length && burnChanges[boundary].week <= point.date) boundary++;
      const limit = burnChanges[boundary - 1];
      before += limit?.before ?? initialBurn;
      after += limit?.after ?? initialBurn;
    }
    // The server rounds each point after accumulating fractional daily allowances.
    const burnDelta = Math.round(-after / 7) - Math.round(-before / 7);
    return { ...point, cents: point.cents + movementDelta(point.date) + burnDelta };
  });
  return { ...context, ...projectThisWeek(context, intents), cash: context.cash + movementDelta(today), balance };
}

// Limits saved for this week (the weekly limits modal) change the current limits, this week's overrides and
// which kind of forecast is drawn, before the server answers.
function projectThisWeek(context: CashContext, intents: ReturnType<typeof unappliedTransactionIntents>) {
  const week = context.thisWeek?.week;
  if (!week) return {};
  const changes = intents.flatMap(intent => intent.command.type === "limit" && intent.command.week === week ? [intent.command] : []);
  if (!changes.length) return {};
  const thisWeek = { ...context.thisWeek! };
  const limits = { food: context.foodLimit ?? null, other: context.otherLimit ?? null };
  for (const { allowance, after } of changes) {
    thisWeek[allowance] = after;
    // Clearing this week's override falls back to an earlier limit the client can't see; keep the shown one.
    if (after !== null) limits[allowance] = after;
  }
  return { thisWeek, foodLimit: limits.food, otherLimit: limits.other,
    ...(context.forecast ? { forecast: limits.food === null && limits.other === null ? "scheduled" as const : "allowance" as const } : {}) };
}

export function projectOverview(snapshot: OverviewSnapshot, context: CashSnapshot | undefined, queue: TransactionSnapshot): ModuleOverview {
  const { value, version, applied } = snapshot;
  const intents = unappliedTransactionIntents(queue, version, applied);
  return { ...value, statements: value.statements.map(statement => projectStatement(statement, intents, value.today)),
    context: context && projectCash(context, queue, value.today) };
}
