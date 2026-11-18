import type { BudgetPlan } from "../budgeting-client";

export type PendingMoney = NonNullable<BudgetPlan["plan"]["pendingMoney"]>[number];
type Change = { id: string; before: PendingMoney | null; after: PendingMoney | null };
type QueuedChange = { change: Change; blocked?: boolean };
type Snapshot = {
  items: PendingMoney[];
  saving: boolean;
  retryable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error: string;
};

export class PendingMoneyStore {
  private queue: QueuedChange[] = [];
  private past: Change[] = [];
  private future: Change[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private error = "";
  private snapshot: Snapshot;

  constructor(private confirmed: BudgetPlan, private save: (change: Change) => Promise<BudgetPlan>, private refresh: () => void) {
    this.snapshot = this.project();
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  sync = (plan: BudgetPlan) => {
    if (plan.revision <= this.confirmed.revision) return;
    this.confirmed = plan;
    this.emit();
  };

  change(id: string, after: PendingMoney | null, before = this.snapshot.items.find(item => item.id === id) ?? null) {
    const change = { id, before, after };
    this.past.push(change);
    this.future = [];
    this.enqueue(change);
  }

  undo = () => {
    const change = this.past.pop();
    if (!change) return;
    this.future.push(change);
    this.enqueue({ id: change.id, before: change.after, after: change.before });
  };

  redo = () => {
    const change = this.future.pop();
    if (!change) return;
    this.past.push(change);
    this.enqueue(change);
  };

  retry = () => {
    this.error = "";
    for (const item of this.queue) item.blocked = false;
    this.emit();
    void this.drain();
  };

  private project(): Snapshot {
    const items = new Map(this.confirmed.plan.pendingMoney?.map(item => [item.id, item]));
    const blocked = new Set(this.queue.filter(item => item.blocked).map(item => item.change.id));
    for (const { change } of this.queue) {
      if (change.after) items.set(change.id, change.after);
      else items.delete(change.id);
    }
    return {
      items: [...items.values()],
      saving: this.queue.some(item => !blocked.has(item.change.id)),
      retryable: blocked.size > 0,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      error: this.error,
    };
  }

  private emit() {
    this.snapshot = this.project();
    for (const listener of this.listeners) listener();
  }

  private enqueue(change: Change) {
    this.queue.push({ change });
    this.emit();
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    const seen = new Set<string>();
    const next = this.queue.find(item => {
      const id = item.change.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return !item.blocked;
    });
    if (!next) return;
    this.running = true;
    const { id, before, after } = next.change;
    const label = after?.label ?? before?.label;
    try {
      const plan = await this.save(next.change);
      if (plan.revision > this.confirmed.revision) this.confirmed = plan;
      this.queue = this.queue.filter(item => item !== next);
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status && failure.status < 500) {
        this.queue = this.queue.filter(item => item.change.id !== id);
        this.past = this.past.filter(item => item.id !== id);
        this.future = this.future.filter(item => item.id !== id);
        this.error = `${label}: ${failure.message}`;
        if (failure.status === 409) this.refresh();
      } else {
        next.blocked = true;
        this.error = `${label}: save could not be confirmed. Retry to finish saving.`;
      }
    } finally {
      this.running = false;
      this.emit();
      void this.drain();
    }
  }
}
