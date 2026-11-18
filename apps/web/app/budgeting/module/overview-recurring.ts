import { shiftDate, subscriptionPayments, type Subscription } from "@quantself/budgeting";
import type { RecurringSchedule } from "../subscription-store";
import type { ModuleOverview } from "./overview-client";

type RuleSnapshot = NonNullable<ModuleOverview["rules"]>[number];
type RuleEvent = RuleSnapshot["events"][number];
type Statement = ModuleOverview["statements"][number];
type CashContext = NonNullable<ModuleOverview["context"]>;
type RuleState = Pick<Subscription, "status" | "stopsOn">;
type EventChange = { ruleId: string; event: RuleEvent; added: boolean };

function scheduled(rule: RuleState, date: string) {
  return (rule.status === "active" || rule.status === "trial") && (!rule.stopsOn || date < rule.stopsOn);
}

function eventChanges(observed: RuleSnapshot[] | undefined, schedules: RecurringSchedule[], localEvents: (item: Subscription) => RuleEvent[]) {
  const byId = new Map(observed?.map(rule => [rule.id, rule]));
  return schedules.flatMap(({ item, pending, created, commandId }): EventChange[] => {
    const rule = byId.get(item.id);
    // Older queued revisions must not replace an external update already reflected by the API.
    if (rule && (rule.revision > item.revision && (!pending || rule.commandId !== commandId) ||
      !pending && rule.revision === item.revision)) return [];
    if (!rule && (!created || observed === undefined)) return [];
    return (rule?.events ?? localEvents(item)).flatMap(event => {
      const before = !!rule && scheduled(rule, event.date);
      const after = scheduled(item, event.date);
      return before === after ? [] : [{ ruleId: item.id, event, added: after }];
    });
  });
}

function localEvents(item: Subscription, from: string, through: string): RuleEvent[] {
  if (through < from || item.terms.some(term => term.currency && term.currency !== "CAD" && term.cadAmountCents === undefined)) return [];
  const kind = item.kind ?? "subscription";
  return subscriptionPayments({ ...item, status: "active", stopsOn: null }, from, through)
    .map(({ key, date, label, cents }) => ({ key, date, label, cents, kind, upcoming: false, uncertain: false }));
}

function projectStatement(statement: Statement, changes: EventChange[], today: string): Statement {
  const inside = changes.filter(({ event }) => event.date >= statement.start && event.date <= statement.end);
  if (!inside.length) return statement;
  const removed = new Set(inside.filter(change => !change.added).map(({ event }) => event.key));
  const income = statement.income.filter(line => line.done || !line.key || !removed.has(line.key));
  const bills = statement.bills.filter(line => line.done || !line.key || !removed.has(line.key));
  for (const { ruleId, event, added } of inside) {
    if (!added) continue;
    const target = event.kind === "income" ? income : bills;
    if (target.some(line => line.key === event.key)) continue;
    const { date, label, cents, key, uncertain } = event;
    target.push({ date, label, cents, key, ruleId, done: false, ...(uncertain ? { note: "Uncertain" } : {}) });
  }
  const totals = { ...statement.totals,
    bills: bills.reduce((sum, line) => sum + line.cents, 0),
    income: income.reduce((sum, line) => sum + (line.done || line.date > today && !line.note ? line.cents : 0), 0),
  };
  return { ...statement, totals,
    net: totals.income - totals.bills - totals.savings - totals.spending,
    income: income.sort((a, b) => a.date.localeCompare(b.date)),
    bills: bills.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function projectContext(context: CashContext, observed: RuleSnapshot[] | undefined, schedules: RecurringSchedule[], today: string) {
  const tomorrow = shiftDate(today, 1);
  const upcomingThrough = shiftDate(today, 30);
  const through = context.balance.at(-1)?.date ?? today;
  const changes = eventChanges(observed, schedules, item => localEvents(item, today, through > upcomingThrough ? through : upcomingThrough)
    .map(event => ({
      ...event,
      upcoming: event.date <= upcomingThrough,
      forecastDate: event.date <= through && (event.kind !== "income" || event.date > today)
        ? (event.date === today ? tomorrow : event.date) : undefined,
    })));
  if (!changes.length) return context;
  const upcoming = new Map(context.upcoming.map(event => [event.occurrenceKey ?? `${event.key}:${event.date}`, event]));
  const balanceChanges = new Map<string, number>();
  for (const { ruleId, event, added } of changes) {
    const { key, label, cents, date, kind, upcoming: show, uncertain, forecastDate } = event;
    if (show) {
      if (added) upcoming.set(key, { key: ruleId, occurrenceKey: key, ruleId, label, cents, date, kind, uncertain });
      else upcoming.delete(key);
    }
    if (forecastDate) {
      const signed = (added ? 1 : -1) * (kind === "income" ? cents : -cents);
      balanceChanges.set(forecastDate, (balanceChanges.get(forecastDate) ?? 0) + signed);
    }
  }
  let delta = 0;
  return {
    ...context,
    upcoming: [...upcoming.values()].sort((a, b) => a.date.localeCompare(b.date)),
    balance: context.balance.map(point => {
      if (point.past) return point;
      delta += balanceChanges.get(point.date) ?? 0;
      return { ...point, cents: point.cents + delta };
    }),
  };
}

export function projectRecurringOverview(
  overview: ModuleOverview, statementRules: ModuleOverview["rules"], contextRules: ModuleOverview["rules"], schedules: RecurringSchedule[],
): ModuleOverview {
  if (!schedules.length) return overview;
  const { today, statements, context } = overview;
  const start = statements.map(statement => statement.start).sort()[0];
  const end = statements.map(statement => statement.end).sort().at(-1);
  const changes = eventChanges(statementRules, schedules, item => start && end ? localEvents(item, start, end) : []);
  return {
    ...overview,
    statements: statements.map(statement => projectStatement(statement, changes, today)),
    context: context && projectContext(context, contextRules, schedules, today),
  };
}
