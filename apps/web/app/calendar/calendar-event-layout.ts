import type { Task } from "../todo/todo-projection";

type TimedTask = Pick<Task, "start" | "minutes" | "beforeMinutes" | "afterMinutes">;

// Reserve one 18px title line, 4px padding, and 4px gridline insets. Lane allocation uses these same
// visual bounds so adjacent tiny events cannot cover each other's labels.
export function calendarEventBounds(task: TimedTask, minuteHeight: number) {
  const [hour, minute] = task.start.split(":").map(Number);
  const start = hour * 60 + minute;
  const coreMinutes = Math.max(task.minutes, 26 / minuteHeight);
  return {
    start: start - (task.beforeMinutes ?? 0),
    end: start + coreMinutes + (task.afterMinutes ?? 0),
    coreMinutes,
  };
}

// Insets depend only on this card, never on a neighbor or drag preview.
// The scheduled bounds remain exact; the card clears each boundary consistently.
export function calendarEventVerticalLayout(start: number, minutes: number, minuteHeight: number) {
  const topInset = 2.5;
  return { top: start * minuteHeight + topInset, height: minutes * minuteHeight - topInset - 1.5 };
}

export function calendarEventLanes<Event extends { id: string; timing: TimedTask }>(events: Event[], minuteHeight: number) {
  const positioned = events.map(event => ({ ...event, ...calendarEventBounds(event.timing, minuteHeight), lane: 0, lanes: 1 }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  for (let first = 0; first < positioned.length;) {
    let next = first + 1;
    let clusterEnd = positioned[first].end;
    while (next < positioned.length && positioned[next].start < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, positioned[next].end);
      next++;
    }
    const laneEnds: number[] = [];
    for (let index = first; index < next; index++) {
      const item = positioned[index];
      const available = laneEnds.findIndex(end => end <= item.start);
      item.lane = available < 0 ? laneEnds.length : available;
      laneEnds[item.lane] = item.end;
    }
    for (let index = first; index < next; index++) positioned[index].lanes = laneEnds.length;
    first = next;
  }
  return positioned;
}
