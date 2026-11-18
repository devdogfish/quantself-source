import type { Subscription } from "@quantself/budgeting";

type Charge = { id: string; date: string; cents: number };
type OneOff = { id: string; name: string; kind: "subscription" | "bill" | "income"; date: string; cents: number };
type Read = { today: string; items: Subscription[]; paidKeys: string[]; charges?: Record<string, Charge[]>; oneOff?: OneOff[] };
type Changes = Omit<Subscription, "id" | "revision" | "commandId" | "planEntry">;
type Write = { revision: number; commandId: string; changes: Changes };
type Change = { id: string; before: Partial<Changes>; after: Partial<Changes>; order: number };
type Intent = { id: string; patch: Partial<Changes>; create?: Subscription; request?: Write; blocked?: boolean; history: Change };
export type RecurringSchedule = { item: Subscription; pending: boolean; created: boolean; commandId?: string };
type Snapshot = Required<Read> & {
  schedules: RecurringSchedule[]; refresh: number; settlementRefresh: number; writeError: string; loading: boolean; error: string; pending: string[]; retryable: string[]; canUndo: boolean; canRedo: boolean;
};

function changes({ id: _id, revision: _revision, commandId: _commandId, planEntry: _planEntry, ...fields }: Subscription): Changes {
  return fields;
}

function termIntent({ effectiveOn, startOn, amountCents, frequency, interval, currency }: Subscription["terms"][number]) {
  return [effectiveOn, startOn, amountCents, frequency, interval, currency ?? "CAD"];
}

function sameValue(key: string, left: unknown, right: unknown) {
  if (key === "terms" && Array.isArray(left) && Array.isArray(right)) {
    const signature = (terms: Subscription["terms"]) => JSON.stringify(terms.map(termIntent).sort());
    return signature(left) === signature(right);
  }
  return left === right;
}

function project(records: Map<string, Subscription>, intent: Intent) {
  const record = records.get(intent.id) ?? intent.create;
  if (record) records.set(intent.id, { ...record, ...intent.patch });
}

export class SubscriptionStore {
  private records = new Map<string, Subscription>();
  private queue: Intent[] = [];
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private running = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private created = new Set<string>();
  private touched = new Set<string>();
  private conflicts = new Set<string>();
  private settlementChanged = false;
  private loadPromise: Promise<void> | null = null;
  private snapshot: Snapshot = { today: "", items: [], paidKeys: [], charges: {}, oneOff: [], schedules: [], refresh: 0, settlementRefresh: 0, writeError: "", loading: true, error: "", pending: [], retryable: [], canUndo: false, canRedo: false };

  constructor(private transport: {
    read: () => Promise<Read>;
    write: (id: string, input: Write) => Promise<Subscription>;
    changed?: () => void;
  }) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private emit(update: Partial<Snapshot> = {}) {
    const projected = new Map(this.records);
    for (const intent of this.queue) project(projected, intent);
    const pending = new Set(this.queue.map(intent => intent.id));
    const recent = [...this.touched].reverse().filter(id => projected.has(id));
    const scheduleIds = [...recent.filter(id => pending.has(id)), ...recent.filter(id => !pending.has(id))].slice(0, 40);
    this.snapshot = {
      ...this.snapshot, ...update,
      items: [...projected.values()],
      schedules: scheduleIds.map(id => ({
        item: projected.get(id)!, pending: pending.has(id), created: this.created.has(id),
        commandId: this.queue.find(intent => intent.id === id)?.request?.commandId,
      })),
      pending: [...pending],
      retryable: this.queue.filter(intent => intent.blocked).map(intent => intent.id),
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
    };
    for (const listener of this.listeners) listener();
  }

  load = () => {
    if (this.loadPromise) return this.loadPromise;
    const before = new Map(this.records);
    const observedConflicts = new Set(this.conflicts);
    this.loadPromise = this.transport.read().then(value => {
      const fresh = new Map(value.items.map(item => [item.id, item]));
      for (const id of new Set([...before.keys(), ...fresh.keys(), ...this.records.keys()])) {
        // Keep local records that advanced during this read and in-flight commands' CAS bases.
        if (this.records.get(id) !== before.get(id) || this.queue.some(intent => intent.id === id) ||
          this.conflicts.has(id) && !observedConflicts.has(id)) continue;
        const row = fresh.get(id);
        const current = this.records.get(id);
        if (row && current && row.revision < current.revision) continue;
        if (row) this.records.set(id, row);
        else this.records.delete(id);
        this.conflicts.delete(id);
      }
      for (const id of observedConflicts) if (!fresh.has(id) && !this.records.has(id)) this.conflicts.delete(id);
      this.emit({ today: value.today, paidKeys: value.paidKeys, charges: value.charges ?? {}, oneOff: value.oneOff ?? [],
        error: observedConflicts.size || this.snapshot.retryable.length ? this.snapshot.writeError : "",
        writeError: observedConflicts.size || this.snapshot.retryable.length ? this.snapshot.writeError : "" });
    }).catch(error => {
      this.emit({ error: this.conflicts.size ? `${this.snapshot.error} Refresh failed: ${error.message}` : error.message });
    }).finally(() => {
      this.loadPromise = null;
      this.emit({ loading: false });
      // A conflict that arrived during an earlier refresh needs a read started after the conflict.
      if ([...this.conflicts].some(id => !observedConflicts.has(id))) void this.load();
    });
    this.emit({ loading: true });
    return this.loadPromise;
  };

  change = (after: Subscription) => {
    const current = this.snapshot.items.find(item => item.id === after.id);
    if (!current) {
      this.created.add(after.id);
      const change = { id: after.id, before: { status: "dismissed" as const }, after: { status: after.status }, order: this.version };
      this.record(change, { id: after.id, patch: {}, create: after, history: change });
      return change;
    }
    return this.patch(after.id, changes(after));
  };

  patch = (id: string, patch: Partial<Changes>, remember = true) => {
    if (this.conflicts.has(id)) return;
    const current = this.snapshot.items.find(item => item.id === id);
    if (!current) return;
    const entries = Object.entries(patch).filter(([key, value]) => !sameValue(key, current[key as keyof Changes], value));
    if (!entries.length) return;
    const after = Object.fromEntries(entries);
    const before = Object.fromEntries(entries.map(([key]) => [key, current[key as keyof Changes]]));
    const change = { id, before, after, order: this.version };
    const intent = { id, patch: after, history: change };
    if (remember) this.record(change, intent);
    else this.enqueue(intent);
    return change;
  };

  private applicable(change: Change, expected: Partial<Changes>, desired: Partial<Changes>) {
    const current = this.snapshot.items.find(item => item.id === change.id);
    if (!current || this.conflicts.has(change.id)) return {};
    return Object.fromEntries(Object.entries(desired).filter(([key]) =>
      sameValue(key, current[key as keyof Changes], expected[key as keyof Changes]) &&
      !this.undoStack.some(later => later.id === change.id && later.order > change.order && key in later.after)));
  }

  undo = (change = this.undoStack.at(-1)) => {
    if (!change || !this.undoStack.includes(change)) return false;
    this.undoStack = this.undoStack.filter(entry => entry !== change);
    const patch = this.applicable(change, change.after, change.before);
    if (!Object.keys(patch).length) { this.emit(); return false; }
    const redo = {
      id: change.id, before: patch, order: this.version,
      after: Object.fromEntries(Object.keys(patch).map(key => [key, change.after[key as keyof Changes]])),
    };
    this.redoStack.push(redo);
    this.enqueue({ id: change.id, patch, history: redo });
    return redo;
  };

  redo = (change = this.redoStack.at(-1)) => {
    if (!change || !this.redoStack.includes(change)) return;
    this.redoStack = this.redoStack.filter(entry => entry !== change);
    const patch = this.applicable(change, change.before, change.after);
    if (!Object.keys(patch).length) { this.emit(); return; }
    const redone = { ...change, after: patch, order: this.version,
      before: Object.fromEntries(Object.keys(patch).map(key => [key, change.before[key as keyof Changes]])) };
    this.record(redone, { id: redone.id, patch, history: redone }, false);
  };

  retry = () => {
    for (const intent of this.queue) intent.blocked = false;
    this.emit({ error: "", writeError: "" });
    this.drain();
  };

  private record(change: Change, intent: Intent, clearRedo = true) {
    this.undoStack.push(change);
    if (clearRedo) this.redoStack = [];
    this.enqueue(intent);
  }

  private enqueue(intent: Intent) {
    this.version++;
    this.touched.delete(intent.id);
    this.touched.add(intent.id);
    this.queue.push(intent);
    this.emit();
    this.drain();
  }

  private drain() {
    const waiting = new Set(this.running);
    for (const intent of this.queue) {
      if (this.running.size >= 4) break;
      if (waiting.has(intent.id)) continue;
      waiting.add(intent.id);
      if (intent.blocked) continue;
      this.running.add(intent.id);
      void this.save(intent);
    }
  }

  private async save(intent: Intent) {
    const id = intent.id;
    const prior = this.records.get(id);
    const row = prior ?? intent.create;
    if (!row) {
      this.queue = this.queue.filter(entry => entry !== intent);
      this.running.delete(id);
      this.emit();
      return;
    }
    const desired = { ...row, ...intent.patch };
    if (!intent.request) {
      intent.request = { revision: prior?.revision ?? 0, commandId: crypto.randomUUID(), changes: changes(desired) };
      this.emit();
    }
    try {
      const saved = await this.transport.write(id, intent.request);
      const verified = { ...saved, terms: saved.terms.map((term, index) => {
        const displayed = desired.terms[index];
        if (!displayed || !displayed.conversion || (displayed.conversion.quote?.requestedDate ?? "") <= (term.conversion?.quote?.requestedDate ?? "")) return term;
        return sameValue("terms", [term], [displayed])
          ? { ...term, conversion: displayed.conversion, cadAmountCents: displayed.cadAmountCents } : term;
      }) };
      this.records.set(id, verified);
      this.queue = this.queue.filter(entry => entry !== intent);
      // The API may match existing bank rows when a priced rule becomes billable again.
      // Refresh the charge facts only after the last relevant queued write settles.
      if (!saved.planEntry && saved.sourceKey && saved.kind !== "income" && ["active", "trial"].includes(saved.status) &&
        (!prior || prior.sourceKey !== saved.sourceKey || prior.status !== saved.status || prior.stopsOn !== saved.stopsOn ||
          prior.kind !== saved.kind || !sameValue("terms", prior.terms, saved.terms))) this.settlementChanged = true;
      this.transport.changed?.();
    } catch (error) {
      const failure = error as Error & { status?: number };
      if (failure.status && failure.status < 500) {
        const dependent = !prior || failure.status === 409 || failure.status === 404;
        this.queue = this.queue.filter(entry => entry !== intent && (!dependent || entry.id !== id));
        const valid = (change: Change) => change !== intent.history && (!dependent || change.id !== id);
        this.undoStack = this.undoStack.filter(valid);
        this.redoStack = this.redoStack.filter(valid);
        const conflict = failure.status === 409 || failure.status === 404;
        if (conflict) this.conflicts.add(id);
        const message = `${desired.name}: ${failure.message}`;
        this.emit({ error: message, writeError: message, refresh: this.snapshot.refresh + (conflict ? 1 : 0) });
        if (conflict) queueMicrotask(() => { void this.load(); });
      } else {
        intent.blocked = true;
        const message = `${desired.name}: save unconfirmed. Retry to confirm your change.`;
        this.emit({ error: message, writeError: message });
      }
    } finally {
      this.running.delete(id);
      if (this.settlementChanged && !this.running.size && !this.queue.some(entry => !entry.blocked)) {
        this.settlementChanged = false;
        this.emit({ refresh: this.snapshot.refresh + 1, settlementRefresh: this.snapshot.settlementRefresh + 1 });
      } else this.emit();
      this.drain();
    }
  }
}
