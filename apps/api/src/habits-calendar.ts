import { createHash } from "node:crypto";
import { z } from "zod";
import {
  eligible,
  scheduled,
  type Habit,
  type HabitProjection,
} from "./habits-definition";
import { wallTime } from "./notifications-plan";
export const habitBlockSchema = z.object({
  stackId: z.string(),
  name: z.string(),
  date: z.string(),
  anchor: z.string(),
  durationMinutes: z.number(),
  url: z.string(),
});
export function habitBlocks(p: HabitProjection, from: string, to: string) {
  const blocks: z.infer<typeof habitBlockSchema>[] = [];
  for (
    let date = from;
    date <= to;
    date = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10)
  ) {
    for (const stack of p.stacks) {
      if (!stack.anchor || !stack.durationMinutes) continue;
      const active = p.habits.some(
        (h) =>
          h.stack === stack.id &&
          h.kind === "build" &&
          ["testing", "building", "established"].includes(h.status) &&
          (!h.startDate || h.startDate <= date) &&
          scheduled(p, h, date),
      );
      if (active)
        blocks.push({
          stackId: stack.id,
          name: stack.name,
          date,
          anchor: stack.anchor,
          durationMinutes: stack.durationMinutes,
          url: "/habits",
        });
    }
  }
  return blocks;
}
// Display-only text fields from habits.yaml (passthrough keys such as `minimum`, `fallback`).
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function active(p: HabitProjection, h: Habit, date: string) {
  return (
    h.kind === "build" &&
    ["testing", "building", "established"].includes(h.status) &&
    (!h.startDate || h.startDate <= date) &&
    scheduled(p, h, date)
  );
}
// "Water → Outside (1 min at the door) → Movement (shoes on)": the reminder carries the
// whole routine with its worst-day versions, so the Owner never has to open the app to recall it.
export function stackChain(habits: Habit[]) {
  return habits
    .map((h) => (text(h.minimum) ? `${h.name} (${text(h.minimum)})` : h.name))
    .join(" → ");
}
export function planHabitAlerts(
  p: HabitProjection,
  date: string,
  rows: { habitId: string; status: string }[],
) {
  const logged = new Set(
    rows.filter((r) => r.status !== "open").map((r) => r.habitId),
  );
  const due = eligible(p, date);
  const anchorAlerts = p.stacks.flatMap((stack) => {
    if (!stack.anchor) return [];
    // Reminders exist to prompt action, not logging: untracked routines remind too.
    const members = p.habits.filter(
      (h) => h.stack === stack.id && active(p, h, date),
    );
    if (!members.length) return [];
    const tracked = due.filter((h) => h.stack === stack.id);
    // Once every tracked habit in the stack is resolved, stay quiet.
    if (tracked.length && tracked.every((h) => logged.has(h.id))) return [];
    if (
      stack.alert !== true &&
      !members.some((h) => h.alert === true && !logged.has(h.id))
    )
      return [];
    const fireAt = wallTime(date, stack.anchor, "America/Halifax");
    return [
      {
        key: createHash("sha256")
          .update(`habit:stack:${stack.id}:${date}:${stack.anchor}`)
          .digest("hex"),
        title: stack.name,
        body: stackChain(members),
        fireAt,
        expiresAt: fireAt + 3600000,
        url: "/habits",
      },
    ];
  });
  // Plan B: a tracked habit still open at its fallback time gets one nudge with its if-then plan.
  const fallbackAlerts = due
    .filter((h) => h.fallbackAt && !logged.has(h.id))
    .map((h) => {
      const fireAt = wallTime(date, h.fallbackAt!, "America/Halifax");
      return {
        key: createHash("sha256")
          .update(`habit-fallback:${h.id}:${date}`)
          .digest("hex"),
        title: `${h.name}: plan B`,
        body:
          text(h.fallback) ??
          (text(h.minimum)
            ? `The minimum still counts: ${text(h.minimum)}`
            : "The minimum still counts."),
        fireAt,
        expiresAt: fireAt + 3600000,
        url: "/habits",
      };
    });
  return [...anchorAlerts, ...fallbackAlerts];
}
