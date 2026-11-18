// STUB DATA (#176). Sample stacks, habits and history so the redesigned Habits pages render before the API is wired.
// Served through HabitsData (habits-data.tsx); see the Habits follow-up issues. The metric helpers below are real logic and stay.
import { fmt, type State, type Stack, type Habit, type Ask } from "./habit-metrics";
export const stacks: Stack[] = [
  { id: "morning", name: "Morning launch", cue: "After I put the kettle on", anchor: "07:30", minutes: 25, place: "Kitchen" },
  { id: "evening", name: "Evening landing", cue: "After I brush my teeth", anchor: "21:30", minutes: 20, place: "Bathroom → bedroom" },
  { id: "sunday", name: "Sunday reset", cue: "After I put the groceries away", anchor: "16:00", minutes: 15, place: "Desk" },
];

export const habits: Habit[] = [
  { id: "outside", name: "Get outside", stack: "morning", kind: "build", status: "building", identity: "I start my day outside.", minimum: "Stand at the door for one minute", full: "Ten-minute walk", fallback: "If I miss the morning, I step out after lunch.", started: "Jan 12", gate: { window: 14, required: 10 } },
  { id: "move", name: "Move a little", stack: "morning", kind: "build", status: "testing", identity: "I move every day.", minimum: "Put on walking shoes", full: "Walk around the block", started: "Mar 2", gate: { window: 14, required: 10 } },
  { id: "plan", name: "Write tomorrow's first task", stack: "morning", kind: "build", status: "testing", identity: "I decide before I start.", minimum: "Write one line", full: "Plan the first two hours", started: "Oct 20", gate: { window: 14, required: 10 } },
  { id: "park", name: "Park phone", stack: "evening", kind: "build", status: "building", identity: "I protect my sleep.", minimum: "Put the phone on its charger", full: "Leave the phone outside the bedroom", fallback: "If I bring it upstairs, I return it before getting into bed.", started: "Aug 29", gate: { window: 14, required: 10 } },
  { id: "read", name: "Read a page", stack: "evening", kind: "build", status: "building", identity: "I am a reader.", minimum: "Read one paragraph", full: "Read for ten minutes", started: "Sep 15", gate: { window: 14, required: 10 } },
  { id: "review", name: "Review the week", stack: "sunday", kind: "build", status: "testing", identity: "I learn from what I actually did.", minimum: "Name one thing that helped", full: "Pick one adjustment for next week", started: "Sep 7", gate: { window: 4, required: 3 }, weekly: true },
  { id: "scroll", name: "Late-night scrolling", stack: "evening", kind: "break", status: "building", identity: "I end the day offline.", minimum: "", full: "", started: "Sep 1", gate: { window: 14, required: 10 },
    triggers: ["Tired", "Bored", "Avoiding bedtime", "Notification", "After an argument"],
    protocol: ["Put the phone on its charger", "Take three slow breaths", "Open the paperback on the nightstand"],
    substitution: "Read the paperback" },
  // Established or parked habits that are no longer logged daily (they fill out the catalog table).
  ...([
    ["coffee", "Make coffee", "morning", "established", "Jan 4"], ["water", "Drink a glass of water", "morning", "established", "Feb 2"],
    ["bed", "Make the bed", "morning", "established", "Mar 9"], ["vitamins", "Take vitamins", "morning", "established", "Apr 1"],
    ["stretch", "Stretch for two minutes", "morning", "pending", "Not started"], ["journal", "One-line journal", "evening", "established", "May 3"],
    ["lights", "Dim the lights at nine", "evening", "established", "Jun 12"], ["clothes", "Lay out tomorrow's clothes", "evening", "pending", "Not started"],
    ["floss", "Floss one tooth", "evening", "established", "Feb 20"], ["groceries", "Plan next week's meals", "sunday", "established", "Mar 15"],
    ["shoes", "Put shoes by the door", "sunday", "established", "Apr 19"], ["inbox", "Clear the downloads folder", "sunday", "pending", "Not started"],
    ["call", "Call a friend", "sunday", "established", "May 24"],
  ] as const).map(([id, name, stack, status, started]): Habit => ({ id, name, stack, status, started, kind: "build", identity: "", minimum: "", full: "", gate: { window: 14, required: 10 }, untracked: true })),
];

export const build = habits.filter((h) => h.kind === "build" && !h.untracked);
export const TODAY = new Date(2026, 10, 13); // Fri 13 Nov 2026
export const DAYS = 364;
export const dates = Array.from({ length: DAYS }, (_, i) => new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - (DAYS - 1 - i)));


// Deterministic, plausible history per habit (index 0 = oldest, last = today).
const seeds: Record<string, string> = {
  outside: "ddmdxdsdddmdddxddsdmdxddddmddx",
  move: "dmdxdmddmxddmdddmdmxxdmdddmdmd",
  plan: "ddxdmdsddxdmdxdmddxxddmdsdxdmd",
  park: "dddxdddmddxddddddmxddddxdmdddx",
  read: "mddmdxdmmdxdxmddmsdmdxddmxddmd",
};
const map: Record<string, State> = { d: "done", m: "minimum", s: "skipped", x: "missed" };
export function initialHistory(): Record<string, State[]> {
  const out: Record<string, State[]> = {};
  for (const h of build) {
    const start = dates.findIndex((d) => fmt(d, { month: "short", day: "numeric" }) === h.started);
    out[h.id] = dates.map((d, i) => {
      if (start > 0 && i < start) return "none";
      if (h.weekly) return d.getDay() !== 0 ? "none" : i % 21 === 6 ? "missed" : "done";
      if (i === DAYS - 1) return h.id === "outside" ? "done" : h.id === "move" ? "minimum" : "open";
      const s = seeds[h.id]!;
      const raw = map[s[(i * 7 + h.id.length) % s.length]!]!;
      // Habits get easier: early on the minimum is common, later the full version takes over.
      const age = start > 0 ? (i - start) / (DAYS - start) : i / DAYS;
      if (raw === "done" && (i * 13 + h.id.length * 7) % 10 < (1 - age) * 7) return "minimum";
      if (raw === "minimum" && age > 0.6 && i % 3 === 0) return "done";
      return raw;
    });
  }
  // A recent miss on Park phone so "never miss twice" shows.
  out.park![DAYS - 2] = "missed";
  return out;
}

export type Urge = { at: string; day: string; hour: number; trigger: string; outcome: "resisted" | "slipped"; note?: string };
export const urges: Urge[] = [
  { at: "23:40", day: "Thu 12", hour: 23, trigger: "Tired", outcome: "resisted", note: "Opened the paperback instead." },
  { at: "22:15", day: "Wed 11", hour: 22, trigger: "Notification", outcome: "resisted" },
  { at: "00:30", day: "Tue 10", hour: 0, trigger: "Avoiding bedtime", outcome: "slipped", note: "Twenty minutes of video. Charger was upstairs." },
  { at: "21:50", day: "Mon 9", hour: 21, trigger: "Bored", outcome: "resisted" },
  { at: "23:05", day: "Sun 8", hour: 23, trigger: "Tired", outcome: "resisted" },
  { at: "22:40", day: "Sat 7", hour: 22, trigger: "After an argument", outcome: "slipped" },
  { at: "23:20", day: "Fri 6", hour: 23, trigger: "Tired", outcome: "resisted" },
  { at: "22:00", day: "Thu 5", hour: 22, trigger: "Bored", outcome: "resisted" },
  { at: "23:55", day: "Wed 4", hour: 23, trigger: "Avoiding bedtime", outcome: "resisted" },
  { at: "21:30", day: "Tue 3", hour: 21, trigger: "Notification", outcome: "resisted" },
];

export const asks: Ask[] = [
  { day: "Thu 12", feeling: "Tired", habit: "park", outcome: "did minimum" },
  { day: "Wed 11", feeling: "Busy", habit: "plan", outcome: "did minimum" },
  { day: "Tue 10", feeling: "Tired", habit: "read", outcome: "skipped" },
  { day: "Mon 9", feeling: "Low energy", habit: "move", outcome: "did minimum" },
  { day: "Sun 8", feeling: "Unmotivated", habit: "review", outcome: "did full" },
  { day: "Fri 6", feeling: "Tired", habit: "park", outcome: "did minimum" },
  { day: "Thu 5", feeling: "Away from home", habit: "outside", outcome: "did full" },
  { day: "Tue 3", feeling: "Tired", habit: "read", outcome: "did minimum" },
  { day: "Sun 1", feeling: "Anxious", habit: "move", outcome: "did full" },
  { day: "Oct 30", feeling: "Busy", habit: "outside", outcome: "did minimum" },
];

// Preview-only adapter; production Summary is computed by the API.
import { computeHabitSummary } from "../../../../api/src/habits-summary-core";
import type { HabitProjection } from "../../../../api/src/habits-definition";
export function summaryFor(hist: Record<string, State[]>) {
  const projection: HabitProjection = {
    stacks: stacks.map(s => ({ ...s, days: s.id === "sunday" ? ["sunday"] : "daily" })),
    habits: habits.map((h, order) => ({ ...h, order, tracked: !h.untracked, startDate: h.started === "Not started" ? undefined : fmt(new Date(`${h.started} 2026`), { year: "numeric", month: "2-digit", day: "2-digit" }) })),
    gate: { window: 14, required: 10 }, diagnostics: [],
  };
  return computeHabitSummary({ projection, revisions: projection.habits.filter(h => h.status === "established").map(h => ({
    at: `${h.startDate}T12:00:00Z`, changes: [{ type: "upsertHabit" as const, ...h, details: {} }],
  })), occurrences: Object.entries(hist).flatMap(([habitId, states]) => states.flatMap((state, i) => state === "none" ? [] : [{ habitId, date: fmt(dates[i]!, { year: "numeric", month: "2-digit", day: "2-digit" }), status: state === "missed" ? "open" : state }])), today: fmt(TODAY, { year: "numeric", month: "2-digit", day: "2-digit" }) });
}
