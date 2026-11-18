export type DragModifiers = { shiftKey: boolean; metaKey: boolean };
export type CalendarInterval = { start: number; end: number };

/** Snap actual times, never the minimum visual height used by short cards. */
export function snapCalendarStart(raw: number, duration: number, neighbors: CalendarInterval[], modifiers: DragModifiers) {
  const max = Math.max(0, 1440 - duration);
  const clamp = (value: number) => Math.max(0, Math.min(max, value));
  const step = modifiers.shiftKey ? 1 : modifiers.metaKey ? 5 : 15;
  const grid = clamp(Math.round(raw / step) * step);
  if (modifiers.shiftKey) return grid;
  // A boundary within half a step wins over the grid. Never magnetize into
  // another event, even when several neighboring boundaries compete.
  const candidates = neighbors.flatMap(({ start, end }) => [end, start - duration])
    .filter(value => value >= 0 && value <= max && Math.abs(value - raw) <= step / 2)
    .filter(value => !neighbors.some(other => value < other.end && value + duration > other.start));
  candidates.sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw) || a - b);
  return candidates[0] ?? grid;
}

/** Resize one endpoint while keeping the opposite endpoint anchored. */
export function snapCalendarEdge(raw: number, edge: "start" | "end", anchor: number, neighbors: CalendarInterval[], modifiers: DragModifiers, limits = { min: 0, max: 1440 }) {
  // The pointer can cross the anchor; endpoint names follow chronological order.
  const side = raw < anchor ? "start" : raw > anchor ? "end" : edge;
  const min = side === "start" ? limits.min : anchor + 1;
  const max = side === "start" ? anchor - 1 : limits.max;
  // At midnight only the side inside this day is available.
  if (min > limits.max) return limits.max - 1;
  if (max < limits.min) return limits.min + 1;
  const step = modifiers.shiftKey ? 1 : modifiers.metaKey ? 5 : 15;
  const grid = Math.max(min, Math.min(max, Math.round(raw / step) * step));
  if (modifiers.shiftKey) return grid;
  const candidates = neighbors.map(other => side === "start" ? other.end : other.start)
    .filter(value => value >= min && value <= max && Math.abs(value - raw) <= step / 2)
    .filter(value => !neighbors.some(other => (side === "start" ? value : anchor) < other.end && (side === "end" ? value : anchor) > other.start));
  candidates.sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw) || a - b);
  return candidates[0] ?? grid;
}
