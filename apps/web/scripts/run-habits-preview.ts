// Read-only, loopback-only UI preview. --live reads production; default is synthetic.
import { runNextPreview } from "./preview-process";
import type { operations } from "../lib/generated/quantself-api-schema";
import { bucketDays } from "../../api/src/habits-insights-facts";
import { createHabitSnapshotPreview, createLiveHabitPreview, type HabitPreviewSnapshot } from "./habits-live-preview";

type ResponseBody<K extends keyof operations> =
  operations[K] extends { responses: { 200: { content: { "application/json": infer Body } } } }
    ? Body
    : never;
type Day = ResponseBody<"getHabitDay">;
type Overview = ResponseBody<"getHabitOverview">;
type HabitState = Overview["habits"][number]["days"][number]["state"];

const previewPort = 3112;
const stubPort = 3113;
const origin = `http://127.0.0.1:${previewPort}`;
const liveWrite = process.argv.includes("--live-write");
const live = process.argv.includes("--live") || liveWrite;
const snapshotArg = process.argv.indexOf("--snapshot");
const snapshotPath = snapshotArg < 0 ? undefined : process.argv[snapshotArg + 1];
if (snapshotArg >= 0 && !snapshotPath) throw Error("Pass a JSON snapshot path after --snapshot.");
if (process.argv.includes("--live") && liveWrite) throw Error("Choose --live or --live-write, not both.");
if (live && snapshotPath) throw Error("Choose --live or --snapshot, not both.");
const snapshot: HabitPreviewSnapshot | null = snapshotPath ? await Bun.file(snapshotPath).json() : null;
const snapshotRead = snapshot ? createHabitSnapshotPreview(snapshot, origin) : null;
const liveRead = live ? await createLiveHabitPreview({ apiKey: process.env.QUANTSELF_HABITS_PREVIEW_API_KEY ?? process.env.QUANTSELF_API_KEY, previewOrigin: origin, writable: liveWrite }) : null;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format();
const shift = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const sunday = shift(today, (7 - new Date(today).getUTCDay()) % 7);
const validDate = (date: string | null): date is string =>
  !!date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date));
const sha = "sample-habit-catalog";
const projection: NonNullable<Day["projection"]> = {
  stacks: [
    { id: "morning", name: "Morning launch", anchor: "07:30", durationMinutes: 25, cue: "After putting the kettle on", days: "daily" },
    { id: "evening", name: "Evening landing", anchor: "21:30", durationMinutes: 20, cue: "After brushing my teeth", days: "daily" },
    { id: "sunday", name: "Sunday reset", anchor: "16:00", durationMinutes: 15, cue: "After putting the groceries away", days: ["sunday"] },
  ],
  habits: [
    { id: "outside", name: "Get outside", stack: "morning", order: 1, kind: "build", tracked: true, status: "building", startDate: shift(today, -140), minimum: "Stand at the door for one minute", full: "Take a ten-minute walk", identity: "I start my day outside.", fallback: "If I miss the morning, I step out after lunch." },
    { id: "move", name: "Move a little", stack: "morning", order: 2, kind: "build", tracked: true, status: "testing", startDate: shift(today, -40), minimum: "Put on my walking shoes", full: "Walk around the block", identity: "I move every day.", cue: "After stepping outside" },
    { id: "coffee", name: "Make coffee", stack: "morning", order: 3, kind: "build", tracked: false, status: "established" },
    { id: "park", name: "Park phone", stack: "evening", order: 1, kind: "build", tracked: true, status: "building", startDate: shift(today, -76), minimum: "Put the phone on its charger", full: "Leave the phone outside the bedroom", identity: "I protect my sleep.", fallback: "If I bring it upstairs, I return it before getting into bed." },
    { id: "read", name: "Read a page", stack: "evening", order: 2, kind: "build", tracked: true, status: "pending", minimum: "Read one paragraph", full: "Read for ten minutes" },
    { id: "scroll", name: "Late-night scrolling", stack: "evening", order: 3, kind: "break", tracked: false, status: "building", triggers: ["Tired", "Bored", "Avoiding bedtime"], protocol: "Put the phone on its charger and take three slow breaths.", substitution: "Open the paperback on the nightstand." },
    { id: "review", name: "Review the week", stack: "sunday", order: 1, kind: "build", tracked: true, status: "testing", minimum: "Name one thing that helped", full: "Pick one adjustment for next week", identity: "I learn from what I actually did.", gate: { window: 4, required: 3 } },
    { id: "reset", name: "Put shoes by the door", stack: "sunday", order: 2, kind: "build", tracked: false, status: "established" },
  ],
  gate: { window: 14, required: 10 },
  diagnostics: [],
};
const tracked = projection.habits.filter((habit) => habit.tracked && habit.status !== "pending");
const sampleStates: HabitState[] = [
  "done", "done", "minimum", "done", "missed", "done", "skipped",
  "done", "done", "minimum", "done", "missed", "minimum", "done",
];
const dateState = (date: string, index: number): HabitState => {
  const startDate = tracked[index]?.startDate;
  if (date > today || (startDate && date < startDate)) return "none";
  if (tracked[index]?.stack === "sunday") {
    if (new Date(date).getUTCDay() !== 0) return "none";
    if (date === today) return "open";
    return date === shift(sunday, -14) ? "missed" : "done";
  }
  if (date === today) return index === 0 ? "done" : index === 1 ? "minimum" : "open";
  const distance = (Date.parse(today) - Date.parse(date)) / 86_400_000;
  if (distance > 28 && (distance + index * 3) % 19 === 0) return "none";
  if (index === 2 && distance === 1) return "missed";
  return sampleStates[(distance + index * 4) % sampleStates.length]!;
};
function dayData(date: string): Day {
  return {
    date, today, sha, stale: false, error: null, projection,
    occurrences: tracked.flatMap((habit, index) => {
      const state = dateState(date, index);
      if (state === "none") return [];
      return [{
        habitId: habit.id, date, definitionSha: sha, definitionRevision: 1,
        status: state === "missed" ? "open" : state,
        note: "", revision: state === "open" ? 0 : 1, missed: state === "missed",
      }];
    }),
  };
}

const pastReview = `reviews/${shift(sunday, -7)}.md`;
const documents: Record<string, string> = {
  "SYSTEM.md": "# The habit system\n\n**Make the next step small.** The smallest honest version counts.\n\n## Build through cues\n\nUse a cue you already encounter. Stabilize the stack before expanding it.\n\n## Learn from the log\n\nReview what helped, what got in the way, and one adjustment worth trying.",
  "playbook.md": "# When an urge arrives\n\n1. Put the phone down.\n2. Take three slow breaths.\n3. Open the paperback on the nightstand.\n\nIf you slipped, reset at the next cue and log what happened if it helps.",
  [pastReview]: "# Last week's review\n\n**What helped?** Keeping shoes at the door.\n\n**What got in the way?** Late work made the evening cue easy to miss.\n\n**One adjustment** Move the charger to the hall.",
};
function overviewForWeeks(weeks: number): Overview {
  const days = Array.from({ length: weeks * 7 }, (_, index) => shift(today, index + 1 - weeks * 7));
  return {
    asOf: today, range: { from: days[0]!, to: today },
    totals: { votes: 63, votesThisWeek: 13, votesLastWeek: 11 },
    habits: tracked.map((habit, index) => ({
      id: habit.id, name: habit.name, stackId: habit.stack,
      stackName: projection.stacks.find((stack) => stack.id === habit.stack)!.name,
      status: habit.status, identity: String(habit.identity), cadence: habit.stack === "sunday" ? "weekly" : "daily",
      days: bucketDays(days.map((date) => ({ date, state: dateState(date, index) })), habit.stack === "sunday"),
      chain: [9, 4, 2, 2][index]!, chainAtRisk: index === 2, bestChain: index === 3 ? 3 : 12,
      lifetimeReps: [25, 21, 17, 3][index]!, minimumRatio: [0.2, 0.4, 0.4, 0][index]!,
      gate: habit.stack === "sunday"
        ? { reps: 3, required: 3, window: 4, eligible: 4, state: "pass" }
        : { reps: [11, 8, 9][index]!, required: 10, window: 14, eligible: index === 1 ? 11 : 14, state: index === 0 ? "pass" : index === 1 ? "pending" : "fail" },
    })),
    upcoming: [{ id: "read", name: "Read a page", startDate: null, waitingOn: "Park phone" }],
    insights: [
      { id: "evening-fallback", kind: "chain-at-risk", severity: "attention", title: "Park phone is at risk.", detail: "The last evening occurrence was missed.", habitIds: ["park"], prompt: "Help me make parking my phone easier after brushing my teeth." },
      { id: "outside-gate", kind: "gate-passed", severity: "win", title: "Get outside passed its gate.", detail: "11 of 14 eligible days counted.", habitIds: ["outside"], prompt: "Should I keep my morning outside habit steady for another week?" },
    ],
    reviewDue: { date: sunday, done: false, status: "missing" },
  };
}

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: stubPort,
  fetch(request) {
    if (snapshotRead) return snapshotRead(request);
    if (liveRead) return liveRead(request);
    const { pathname, searchParams } = new URL(request.url);
    if (request.method !== "GET") {
      return Response.json({ message: "Sample baseline is read-only. Use the prototype to try edits." }, { status: 405 });
    }
    switch (pathname) {
      case "/api/v1/access-context":
        return Response.json({
          owner: { id: "preview-owner", name: "Sample Owner" },
          client: { id: "quantself-web", kind: "web", name: "Preview Web Client" },
          permissions: ["habits:read"],
        });
      case "/api/v1/todos":
        return Response.json({ todos: [], readAt: new Date().toISOString() });
      case "/api/v1/todos/live":
        return new Response(null, { status: 204 });
      case "/api/v1/habits/day": {
        const date = searchParams.get("date");
        return Response.json(dayData(validDate(date) ? date : today));
      }
      case "/api/v1/habits/definitions":
        return Response.json({ projection, revision: 1 });
      case "/api/v1/habits/system":
        return Response.json({ projection, revision: 1, history: [] });
      case "/api/v1/habits/overview": {
        const weeks = Number(searchParams.get("weeks") ?? 4);
        if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
          return Response.json({ message: "Invalid range." }, { status: 400 });
        }
        return Response.json(overviewForWeeks(weeks));
      }
      case "/api/v1/habits/document": {
        const path = searchParams.get("path") ?? "";
        if (!Object.hasOwn(documents, path)) {
          return Response.json({ message: "No sample document for this path." }, { status: 404 });
        }
        return Response.json({ path, text: documents[path], editUrl: "/habits", stale: false, error: null });
      }
      case "/api/v1/habits/reviews":
        return Response.json({ paths: [pastReview], next: null, stale: false, error: null });
      case "/api/v1/habits/context":
        return Response.json({ text: Object.values(documents).join("\n\n"), unavailable: [] });
      case "/api/v1/habits/slips":
        return Response.json({
          slips: [{
            id: "c9844134-5044-4bd3-8406-ebc1dd96e08a",
            habitId: "scroll", occurredAt: `${shift(today, -1)}T23:30:00.000Z`, outcome: "resisted",
            trigger: "Tired", note: "Opened the paperback instead.", definitionSha: sha,
          }],
          next: null,
        });
      case "/api/v1/habits/calendar": {
        const from = searchParams.get("from");
        const to = searchParams.get("to");
        if (!validDate(from) || !validDate(to)) {
          return Response.json({ message: "Choose a valid date range." }, { status: 400 });
        }
        const length = Math.min(31, (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1);
        const blocks = Array.from({ length }, (_, index) => shift(from, index)).flatMap((date) =>
          projection.stacks.filter((stack) => stack.days === "daily" || new Date(date).getUTCDay() === 0).map((stack) => ({
            stackId: stack.id, name: stack.name, date, anchor: stack.anchor,
            durationMinutes: stack.durationMinutes, url: "/habits",
          })),
        );
        return Response.json({ blocks, stale: false, error: null });
      }
      default:
        return Response.json({ message: "No sample API response for this request." }, { status: 404 });
    }
  },
});

process.exitCode = await runNextPreview({
  kind: "habits",
  port: previewPort,
  server: stub,
  env: {
    ...process.env,
    QUANTSELF_API_KEY: undefined,
    QUANTSELF_HABITS_PREVIEW_API_KEY: undefined,
    QUANTSELF_HABITS_PREVIEW: "1",
    NEXT_PUBLIC_QUANTSELF_HABITS_FIXTURE: live || snapshot ? undefined : "1",
    NEXT_PUBLIC_QUANTSELF_HABITS_PREVIEW_MODE: snapshot ? "snapshot" : liveWrite ? "live-write" : live ? "live" : "sample",
    NEXT_PUBLIC_QUANTSELF_HABITS_SNAPSHOT_AT: snapshot?.capturedAt,
    QUANTSELF_API_INTERNAL_URL: `http://127.0.0.1:${stub.port}`,
  },
  message: `\nToday: ${origin}/habits\n${snapshot ? `Production snapshot from ${snapshot.capturedAt}; read-only.` : liveWrite ? `Production read/write. Connect at ${origin}/api/v1/habits/preview-setup` : live ? "Production data; read-only." : "Sample data only."} Ctrl-C stops the preview.\n`,
});
