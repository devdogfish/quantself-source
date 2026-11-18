import { expect, test } from "bun:test";
import { Window } from "happy-dom";

test("calendar date selection, stale recovery, and note edits preserve intent without per-keystroke saves", async () => {
  const window = new Window({ url: "http://localhost/calendar" });
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Event", "KeyboardEvent", "Node", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.filter((name) => name !== "fetch")) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true, value: name === "window" ? window : name === "IS_REACT_ACT_ENVIRONMENT" ? true : (window as any)[name],
  });
  const current = "2026-11-10";
  let stale = false;
  const reads: string[] = [];
  const writes: any[] = [];
  const resolveWrites: ((response: Response) => void)[] = [];
  const base = (date: string) => ({ habitId: "walk", date, definitionSha: "a", status: "open", note: "", revision: 0, missed: false });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (request: Request) => {
    if (request.method === "GET") {
      const date = new URL(request.url).searchParams.get("date")!;
      reads.push(date);
      return Response.json({ date, today: current, sha: "a", stale, error: stale ? "Catalog temporarily unavailable." : null,
        projection: { stacks: [{ id: "morning", name: "Morning", days: "daily", cue: "After waking" }], habits: [{ id: "walk", name: "Walk", stack: "morning", order: 1, kind: "build", tracked: true, status: "building", minimum: "Outside" }], gate: { window: 14, required: 10 }, diagnostics: [] }, occurrences: [base(date)] });
    }
    writes.push(await request.json());
    return new Promise<Response>((resolve) => resolveWrites.push(resolve));
  } });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { HabitTestProvider } = await import("@/app/habits/test-provider");
  const { Habits } = await import("./habits");
  const { habitStore } = await import("./habits-api");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) => [...host.querySelectorAll("button")].find((button) => button.textContent === name || button.getAttribute("aria-label") === name)!;
  const renderDate = (date: string) => act(async () => root.render(<HabitTestProvider><Habits key={date} initialDate={date} stackId="morning" /></HabitTestProvider>));
  try {
    await renderDate(current);
    expect(reads).toEqual([current]);
    await renderDate("2026-11-09");
    expect(reads).toEqual([current, "2026-11-09"]);
    expect(button("Skip").disabled).toBe(true);
    expect(host.textContent).toContain("Skips must be set on or before the day");
    await renderDate(current);
    expect(reads).toHaveLength(3);
    stale = true;
    await renderDate("2026-11-11");
    expect(button("Done").disabled).toBe(true);
    expect(host.textContent).toContain("Catalog temporarily unavailable.");
    expect(button("Retry")).toBeDefined();
    stale = false;
    await act(async () => button("Retry").click());
    expect(button("Done").disabled).toBe(true); // Future dates remain read-only except Skip.
    expect(button("Skip").disabled).toBe(false);
    await renderDate(current);
    const note = host.querySelector<HTMLInputElement>('[aria-label="walk note"]')!;
    host.querySelector("details")!.open = true;
    await act(async () => note.focus());
    for (const value of ["W", "Walk", "Walk after lunch"]) await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(note, value);
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(writes).toHaveLength(0);
    await act(async () => note.blur());
    expect(writes).toHaveLength(1);
    expect(writes[0].after.note).toBe("Walk after lunch");
    await act(async () => button("Done").click());
    expect(writes).toHaveLength(1); // Status is queued behind the deferred note save.
    expect(button("Done").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Undo").click());
    expect(button("Done").getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Undo").click());
    expect(note.value).toBe(""); // One Undo clears the entire note edit.
    await act(async () => button("Redo").click());
    expect(note.value).toBe("Walk after lunch");
    await act(async () => note.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(note, "A newer unsaved draft");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => resolveWrites.shift()!(Response.json({ ...base(current), note: "Walk after lunch", revision: 1 })));
    expect(note.value).toBe("A newer unsaved draft");
    const savesBeforeCancel = writes.length;
    await act(async () => note.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(note.value).toBe("Walk after lunch");
    expect(writes).toHaveLength(savesBeforeCancel);
    expect(habitStore.row(base(current) as any).note).toBe("Walk after lunch");
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await window.happyDOM.close();
  }
});
