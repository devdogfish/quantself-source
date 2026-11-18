import type { BudgetLogData, Transaction, TransactionCommand, TransactionFilters, TransactionPage, TransactionResult } from "./transaction-client";

type Change = { before: Transaction | null; after: Transaction | null };
export type Intent = { command: TransactionCommand; changes: Change[] };
type AcceptedIntent = Intent & { id: string; order: number; conflicts: string[] };
type Entry = AcceptedIntent & { blocked?: boolean; records: Set<string> };
type Committed = AcceptedIntent & { version: number };
export type TransactionSnapshot = { pending: (Intent & { id: string })[]; committed: Committed[]; version: number; refresh: number; error: string; retryable: boolean };

export function unappliedTransactionIntents(snapshot: TransactionSnapshot, version: number, applied?: string[]) {
  const acknowledged = new Set(applied);
  return [...snapshot.committed.filter(item => item.version > version), ...snapshot.pending]
    .filter(item => !acknowledged.has(item.id));
}

const idOf = ({ before, after }: Change) => (before ?? after)!.id;

function scopes(command: TransactionCommand) {
  switch (command.type) {
    case "add":
    case "remove": return [command.expense.id + ":*"];
    case "reviewAll": return [command.date + ":check-in", ...command.ids.map(id => id + ":review")];
    case "limit": return [command.week + ":" + command.allowance + ":limit"];
    case "skip": return [command.id + ":skip"];
    case "receipt": return [command.id + ":receipt", ...[command.before, command.after].flatMap(id => id ? [id + ":document-link"] : [])];
    default: return [command.id + ":" + command.type];
  }
}

function overlaps(a: string[], b: string[]) {
  const exact = new Set(a), rowWildcard = new Set(a.filter(s => s.endsWith(":*")).map(s => s.slice(0, -1)));
  const prefixes = new Set(a.map(s => s.slice(0, s.indexOf(":") + 1)));
  return b.some(s => exact.has(s) || rowWildcard.has(s.slice(0, s.indexOf(":") + 1)) || (s.endsWith(":*") && prefixes.has(s.slice(0, -1))));
}

export function reverseIntent({ command, changes }: Intent): Intent {
  let inverse: TransactionCommand;
  switch (command.type) {
    case "add": inverse = { ...command, type: "remove" }; break;
    case "remove": inverse = { ...command, type: "add" }; break;
    case "move": inverse = { ...command, before: { ...command.after, foodCents: changes[0].after!.foodCents }, after: command.before }; break;
    case "review":
    case "reviewAll":
    case "skip":
    case "limit": inverse = { ...command, before: command.after, after: command.before } as TransactionCommand; break;
    case "receipt": inverse = {
      ...command, before: command.after, after: command.before,
      beforeManualReceiptMatch: command.afterManualReceiptMatch, afterManualReceiptMatch: command.beforeManualReceiptMatch,
    }; break;
  }
  return { command: inverse, changes: changes.map(({ before, after }) => ({ before: after, after: before })) };
}

export class TransactionQueue {
  private listeners = new Set<() => void>();
  private entries: Entry[] = [];
  private running = new Set<Entry>();
  private nextOrder = 0;
  private snapshot: TransactionSnapshot = { pending: [], committed: [], version: 0, refresh: 0, error: "", retryable: false };

  constructor(
    private readonly send: (id: string, command: TransactionCommand) => Promise<TransactionResult>,
    private readonly identify: () => string = () => crypto.randomUUID(),
  ) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  private emit(patch: Partial<TransactionSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch, pending: [...this.entries], retryable: this.entries.some(x => x.blocked) };
    for (const listener of this.listeners) listener();
  }

  enqueue(intent: Intent) {
    const { command } = intent;
    if (command.type === "receipt" && command.after) {
      // Persisted ownership is checked by the API. Reserve locally while saves are pending.
      const heldBy = projectReceiptLinks(this.entries).get(command.after);
      if (heldBy && heldBy !== command.id) return;
    }
    const conflicts = scopes(intent.command);
    const id = this.identify();
    this.entries.push({ ...intent, id, order: this.nextOrder++, conflicts, records: new Set(conflicts.map(key => key.slice(0, key.lastIndexOf(":")))) });
    this.emit();
    this.drain();
    return id;
  }

  canReverse = (id: string) => {
    const accepted = [...this.snapshot.committed, ...this.entries];
    const target = accepted.find(intent => intent.id === id);
    // Save acknowledgements can arrive out of order. Use the order of local intent.
    return !!target && !accepted.some(intent => intent.order > target.order && overlaps(target.conflicts, intent.conflicts));
  };

  waitForIdle = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!this.entries.length) return;
    const refresh = this.snapshot.refresh;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason);
      const check = () => {
        if (this.snapshot.retryable) finish(Error("Retry the pending save before exporting."));
        else if (this.snapshot.refresh !== refresh) finish(Error("A pending change failed. Refresh the list before exporting."));
        else if (!this.entries.length) finish();
      };
      const unsubscribe = this.subscribe(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  };

  retry = () => {
    for (const entry of this.entries) entry.blocked = false;
    this.emit({ error: "" });
    this.drain();
  };

  private drain() {
    for (let i = 0; i < this.entries.length && this.running.size < 4; i++) {
      const next = this.entries[i];
      if (next.blocked || this.running.has(next) || this.entries.slice(0, i).some(prev => [...next.records].some(key => prev.records.has(key)))) continue;
      this.running.add(next);
      void this.save(next);
    }
  }

  private async save(entry: Entry) {
    try {
      const result = await this.send(entry.id, entry.command);
      this.entries = this.entries.filter(item => item !== entry);
      const version = this.snapshot.version + 1;
      // Later intent keeps its own fields even when this response contains an older view of the row.
      const changes = !result.expense ? entry.changes : entry.changes.map(change => ({ ...change, after: result.expense! }));
      this.emit({ version, committed: [...this.snapshot.committed, { command: entry.command, changes, version, id: entry.id, order: entry.order, conflicts: entry.conflicts }] });
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      if (status && status < 500) {
        this.entries = this.entries.filter(item =>
          item !== entry && (this.running.has(item) || !overlaps(item.conflicts, entry.conflicts)),
        );
        this.emit({ error: cause instanceof Error ? cause.message : "The budget change was rejected.", refresh: this.snapshot.refresh + 1 });
      } else {
        entry.blocked = true;
        this.emit({ error: "Save could not be confirmed. Retry to finish saving." });
      }
    } finally {
      this.running.delete(entry);
      this.drain();
    }
  }
}

// null marks a receipt released by a local Undo; an expense ID marks a claimed receipt.
export function projectReceiptLinks(intents: Intent[]) {
  const links = new Map<string, string | null>();
  for (const { command } of intents) {
    if (command.type !== "receipt") continue;
    if (command.before) links.set(command.before, null);
    if (command.after) links.set(command.after, command.id);
  }
  return links;
}

function changeFields(current: Transaction | null, intent: Intent, change: Change): Transaction | null {
  if (intent.command.type === "add" || intent.command.type === "remove") return change.after;
  if (!current || !change.after) return current;
  const { allowance, category, foodCents, receiptId, receipt, manualReceiptMatch, reviewed } = change.after;
  switch (intent.command.type) {
    case "move": return { ...current, allowance, category, foodCents };
    case "receipt": return { ...current, receiptId, receipt, manualReceiptMatch };
    case "review":
    case "reviewAll": return { ...current, reviewed };
    default: return current;
  }
}

export function projectExpense(base: Transaction | null, id: string, intents: Intent[]) {
  let result = base;
  for (const intent of intents) {
    const change = intent.changes.find(change => idOf(change) === id);
    if (change) result = changeFields(result, intent, change);
  }
  return result;
}

function inFilter(x: Transaction | null, f: TransactionFilters): x is Transaction {
  return x !== null && (!f.from || x.date >= f.from) && (!f.to || x.date <= f.to) && (!f.month || x.date.startsWith(f.month)) &&
    (!f.spendingOnly || !x.billKey && !x.readOnly) && (!f.cat || f.cat === x.category) && (f.seg !== "review" || !x.reviewed) && (f.seg !== "missing" || !x.receipt) &&
    (!f.subscriptionId || x.subscriptionId === f.subscriptionId || x.billKey?.startsWith(f.subscriptionId + ":") === true) &&
    (!f.q || (x.merchant + " " + x.category + " " + (x.cents / 100).toFixed(2)).toLowerCase().includes(f.q.trim().toLowerCase()));
}

function compare(f: TransactionFilters, a: Transaction, b: Transaction) {
  const descending = () => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  switch (f.sort) {
    case "old": return -descending();
    case "big": return b.cents - a.cents || descending();
    case "small": return a.cents - b.cents || descending();
    default: return descending();
  }
}

export function projectTransactionPage(base: TransactionPage, f: TransactionFilters, intents: Intent[]) {
  const rows = new Map(base.rows.map(row => [row.id, row]));
  const touched = new Map<string, Transaction | null>();
  const boundary = base.rows.at(-1);
  let { count, totalCents } = base;
  for (const intent of intents) for (const change of intent.changes) {
    const id = idOf(change);
    const visible = rows.has(id);
    const previous = touched.has(id) ? touched.get(id)! : rows.get(id) ?? change.before;
    const next = changeFields(previous, intent, change);
    touched.set(id, next);
    if (inFilter(previous, f)) { count--; totalCents -= previous.cents; }
    if (inFilter(next, f)) {
      count++; totalCents += next.cents;
      if (visible || ((f.page ?? 1) === 1 && (!boundary || base.rows.length < 25 || compare(f, next, boundary) < 0))) rows.set(id, next);
    } else rows.delete(id);
  }
  return { ...base, rows: [...rows.values()].sort((a, b) => compare(f, a, b)).slice(0, 25), count: Math.max(0, count), totalCents };
}

export function projectBudgetLog(base: BudgetLogData, intents: Intent[]): BudgetLogData {
  const unreviewed = new Map(base.unreviewed.map(row => [row.id, row]));
  const expenses = new Map<string, Transaction | null>();
  const week = base.week.map(day => ({ ...day }));
  const history = base.history.map(period => ({ ...period }));
  const skipped = new Map(base.skipped.map(row => [row.id, row]));
  const loggedDays = new Set(base.loggedDays);
  const nextLimitOverrides = { ...base.nextLimitOverrides };
  const adjust = (expense: Transaction | null, direction: number) => {
    if (!expense || expense.billKey) return;
    const bucket = week.find(x => x.date === expense.date) ?? history.find((x, i) => x.start <= expense.date && expense.date < (history[i + 1]?.start ?? base.weekStart));
    if (!bucket) return;
    bucket.food += direction * expense.foodCents;
    bucket.other += direction * (expense.cents - expense.foodCents);
  };
  for (const intent of intents) {
    const { command } = intent;
    for (const change of intent.changes) {
      const id = idOf(change);
      const previous = expenses.has(id) ? expenses.get(id)! : unreviewed.get(id) ?? change.before;
      const next = changeFields(previous, intent, change);
      expenses.set(id, next);
      if (command.type === "add" || command.type === "remove" || command.type === "move") { adjust(previous, -1); adjust(next, 1); }
      if (next && !next.reviewed) unreviewed.set(id, next);
      else unreviewed.delete(id);
    }
    if (command.type === "skip") {
      if (command.after) skipped.set(command.id, command.after);
      else skipped.delete(command.id);
    }
    if (command.type === "reviewAll") {
      if (command.after.checkedIn) loggedDays.add(command.date);
      else loggedDays.delete(command.date);
    }
    if (command.type === "limit" && command.week === base.nextLimitWeek) nextLimitOverrides[command.allowance] = command.after;
  }
  return {
    ...base, week, history, unreviewed: [...unreviewed.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    skipped: [...skipped.values()].sort((a, b) => a.date.localeCompare(b.date)),
    loggedDays: [...loggedDays].sort(), checkedInToday: loggedDays.has(base.today), nextLimitOverrides,
    nextFoodLimit: nextLimitOverrides.food ?? base.foodLimit, nextOtherLimit: nextLimitOverrides.other ?? base.otherLimit,
  };
}
