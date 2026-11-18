export type LinkedItem = { id: string; title: string | null };
type Change = { item: LinkedItem; linked: boolean };
/** Serial desired-state writes. An uncertain response pauses delivery, not editing. */
export class ItemLinkQueue {
  private confirmed: LinkedItem[];
  private pending: Change[] = [];
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private running = false;
  private paused = false;
  error = "";
  constructor(items: LinkedItem[], private write: (change: Change) => Promise<void>, private notify: () => void) { this.confirmed = items; }
  get items() {
    const items = new Map(this.confirmed.map(item => [item.id, item]));
    for (const change of this.pending) { if (change.linked) items.set(change.item.id, change.item); else items.delete(change.item.id); }
    return [...items.values()];
  }
  get blocked() { return this.paused; }
  get saving() { return this.pending.length > 0; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  change(item: LinkedItem, linked: boolean) {
    this.undoStack.push({ item, linked: this.items.some(row => row.id === item.id) });
    this.redoStack = []; this.enqueue({ item, linked });
  }
  undo() {
    const change = this.undoStack.pop(); if (!change) return;
    this.redoStack.push({ item: change.item, linked: this.items.some(row => row.id === change.item.id) });
    this.enqueue(change);
  }
  redo() {
    const change = this.redoStack.pop(); if (!change) return;
    this.undoStack.push({ item: change.item, linked: this.items.some(row => row.id === change.item.id) });
    this.enqueue(change);
  }
  retry() { this.error = ""; this.paused = false; void this.flush(); }
  private enqueue(change: Change) { this.pending.push(change); this.notify(); if (!this.paused) void this.flush(); }
  private async flush() {
    if (this.running) return;
    this.running = true;
    while (this.pending.length) {
      const next = this.pending[0];
      try {
        await this.write(next);
        this.confirmed = this.confirmed.filter(item => item.id !== next.item.id);
        if (next.linked) this.confirmed.push(next.item);
        this.pending.shift();
      } catch (cause) {
        const status = (cause as { status?: number }).status;
        if (status && [400, 403, 404, 409].includes(status)) {
          this.pending = this.pending.filter(change => change.item.id !== next.item.id);
          this.undoStack = this.undoStack.filter(change => change.item.id !== next.item.id);
          this.redoStack = this.redoStack.filter(change => change.item.id !== next.item.id);
          this.error = `${next.item.title || "Item"}: ${(cause as Error).message} Link changes for this item were reverted.`;
          this.notify();
          continue;
        }
        this.error = (cause as Error).message + " Changes are not confirmed saved. Retry to reconcile.";
        this.paused = true;
        break;
      }
      this.notify();
    }
    this.running = false; this.notify();
  }
}
