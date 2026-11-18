import { expect, test } from "bun:test";
import { calendarEventBounds, calendarEventVerticalLayout } from "./calendar-event-layout";

test("tiny events reserve a readable title row in both calendar scales", () => {
  for (const minuteHeight of [80 / 60, 90 / 60]) {
    for (const minutes of [1, 5, 10, 15]) {
      const task = { start: "09:00", minutes, prep: 0, travel: 0, returnTravel: 0 };
      const layout = calendarEventBounds(task, minuteHeight);
      expect(layout.start).toBe(540);
      expect((layout.end - layout.start) * minuteHeight - 4).toBeGreaterThanOrEqual(22 - 1e-9);
      // A following event shares a lane only once the visible title has ended.
      expect(layout.end).toBeGreaterThan(541);
      expect(task.minutes).toBe(minutes);
    }
  }
});

test("ordinary durations keep actual bounds", () => {
  expect(calendarEventBounds({ start: "09:00", minutes: 60 }, 1.5)).toEqual({ start: 540, end: 600, coreMinutes: 60 });
});


test("cards keep identical insets at isolated and back-to-back boundaries", () => {
  for (const scale of [80 / 60, 90 / 60]) {
    for (const start of [17 * 60 + 15, 17 * 60 + 30]) {
      const first = calendarEventVerticalLayout(start, 30, scale);
      const second = calendarEventVerticalLayout(start + 30, 60, scale);
      const third = calendarEventVerticalLayout(start + 90, 30, scale);
      expect(second.top - first.top - first.height).toBeCloseTo(4);
      expect(third.top - second.top - second.height).toBeCloseTo(4);
      expect(start * scale + 2.5).toBeCloseTo(first.top);
      expect((start + 120) * scale - third.top - third.height).toBeCloseTo(1.5);
    }
  }
});

test("lane bounds reserve prep on both sides without extending core duration", () => {
  expect(calendarEventBounds({ start: "14:00", minutes: 60, beforeMinutes: 10, afterMinutes: 15 }, 1)).toEqual({ start: 830, end: 915, coreMinutes: 60 });
});

test("the time grid anchors events and keeps date and all-day rows sticky", async () => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  try {
    const { document } = dom;
    const style = document.createElement("style");
    style.textContent = await Bun.file(new URL("../todo/todo-workspace.module.css", import.meta.url)).text();
    document.head.append(style);
    document.body.innerHTML = '<div class="dateHeaders"></div><div class="allDayRow"></div><div class="calendarTimeArea"></div>';
    for (const header of document.querySelectorAll(".dateHeaders, .allDayRow")) {
      expect(dom.getComputedStyle(header).display).toBe("grid");
      expect(dom.getComputedStyle(header).position).toBe("sticky");
    }
    expect(dom.getComputedStyle(document.querySelector(".calendarTimeArea")!).position).toBe("relative");
  } finally {
    await dom.happyDOM.cancelAsync();
  }
});

test("drag geometry updates synchronously so resizing the top cannot animate the bottom", async () => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  try {
    const style = dom.document.createElement("style");
    style.textContent = await Bun.file(new URL("../todo/todo-workspace.module.css", import.meta.url)).text();
    dom.document.head.append(style);
    const event = dom.document.createElement("div");
    event.className = "calendarEvent dragging";
    dom.document.body.append(event);
    const transition = dom.getComputedStyle(event).transition;
    // Independently animating top while height changes immediately moves the fixed bottom edge.
    expect(transition).not.toMatch(/(?:all|top|height)\s+(?!0(?:s|ms)\b)[\d.]+m?s/);
  } finally {
    await dom.happyDOM.cancelAsync();
  }
});

test("selected timed and compact events stay opaque when focus moves into a portaled editor", async () => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  try {
    const style = dom.document.createElement("style");
    style.textContent = await Bun.file(new URL("../todo/todo-workspace.module.css", import.meta.url)).text();
    dom.document.head.append(style);
    for (const mode of ["timed", "all-day", "month"] as const) {
      const event = dom.document.createElement("div");
      event.className = mode === "timed" ? "calendarEvent" : "compactEvent";
      event.dataset.unfinished = "true";
      const button = dom.document.createElement("button");
      button.className = mode === "timed" ? "timelineBlock" : mode === "all-day" ? "allDayEvent" : "monthEvent";
      event.append(button); dom.document.body.append(event);
      const selectedElement = event;
      const editor = dom.document.createElement("input"); dom.document.body.append(editor); editor.focus();
      expect(Number(dom.getComputedStyle(event).opacity)).toBe(0.65);
      selectedElement.dataset.selected = "true";
      expect(Number(dom.getComputedStyle(event).opacity)).toBe(1);
      selectedElement.dataset.selected = "false";
      expect(Number(dom.getComputedStyle(event).opacity)).toBe(0.65);
      event.remove(); editor.remove();
    }
  } finally { await dom.happyDOM.cancelAsync(); }
});
