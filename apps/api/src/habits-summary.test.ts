import { expect, test } from "bun:test";
import { computeHabitSummary, catalogTimeline, type CatalogRevision } from "./habits-summary-core";
import type { HabitProjection } from "./habits-definition";
import { shiftHabitDate, type Observation } from "./habits-insights-facts";
const today = "2026-11-13";
const projection = (): HabitProjection => ({ stacks: [{ id: "am", name: "Morning", days: "daily" }], habits: [{ id: "walk", name: "Walk", kind: "build", status: "building", tracked: true, order: 0, stack: "am", startDate: "2026-01-01" }], gate: { window: 14, required: 10 }, diagnostics: [] });
const observations = (n: number, status = "minimum", habitId = "walk"): Observation[] => Array.from({ length: n }, (_, i) => ({ habitId, date: shiftHabitDate(today, -n + i), status }));
const summary = (p = projection(), occurrences = observations(70), revisions: CatalogRevision[] = []) => computeHabitSummary({ projection: p, revisions, occurrences, today });

test("fixed health weights, bands, readiness and minimum equality; harder full/minimum text has no penalty", () => {
  const s = summary();
  expect(s.health).toEqual({ total: 70, parts: [
    expect.objectContaining({ key: "Showing up", score: 100, weight: 25 }),
    expect.objectContaining({ key: "Recovery", score: 100, weight: 25 }),
    expect.objectContaining({ key: "Gates", score: 100, weight: 20 }),
    expect.objectContaining({ key: "Autopilot", score: 0, weight: 15 }),
    expect.objectContaining({ key: "Review", score: 0, weight: 15 }),
  ] });
  expect(s.band.word).toBe("Strained"); expect(s.ready).toBe(true);
  expect(s.anchor).toEqual({ id: "walk", name: "Walk" });
  expect(s.healthPrev.total).toBe(70); expect(s.passing).toBe(1);
  expect(summary(projection(), observations(70, "done")).health).toEqual(s.health);
  const harder = projection(); harder.habits[0]!.full = "Run 20km"; harder.habits[0]!.minimum = "Run 2km";
  expect(summary(harder).health).toEqual(s.health);
  expect(JSON.stringify(s.findings)).not.toMatch(/consistency|declining|trend/i);
});

test("no habits and all-new habits are finite, cannot be ready, and do not invent history", () => {
  const p = projection(); p.habits = [];
  const s = summary(p, []); expect(s.health.total).toBe(0); expect(s.band.word).toBe("At risk");
  expect(s.ready).toBe(false); expect(s.anchor).toBeNull(); expect(s.slots).toEqual([]);
  expect(s.activity).toHaveLength(364); expect(s.load).toHaveLength(52);
  p.habits = [{ ...projection().habits[0]!, startDate: today }];
  const fresh = summary(p, []);
  expect(fresh.wait).toBe(28); expect(fresh.ready).toBe(false); expect(fresh.passing).toBe(0);
  expect(fresh.load.slice(0, -1).every(w => w.building === 0 && w.auto === 0)).toBe(true);
  expect(fresh.load.at(-1)).toMatchObject({ building: 1, auto: 0 });
  expect(fresh.activity.at(-1)).toMatchObject({ due: 1, open: true, reps: 0 });
});

test("production weekly-review completion uses check-ins; skips transparent for gates, recovery and doubles", () => {
  const p = projection(); p.habits[0] = { ...p.habits[0]!, id: "weekly-review", schedule: ["sunday"] };
  const rows = ["2026-10-18", "2026-10-25", "2026-11-01", "2026-11-08"].map(date => ({ habitId: "weekly-review", date, status: "minimum" }));
  const s = summary(p, rows); expect(s.health.parts.at(-1)?.score).toBe(100); expect(s.passing).toBe(1); expect(s.ready).toBe(true);
  expect(s.health.parts[0]?.score).toBe(0); // Reviews have their own weight.
  expect(s.activity.at(-1)?.due).toBe(0); expect(s.slots).toEqual([]); // Fewer than eight observations.
  expect(summary(p, []).health.parts.at(-1)?.score).toBe(0);
  const daily = summary(projection(), [
    { habitId: "walk", date: "2026-11-08", status: "open" },
    { habitId: "walk", date: "2026-11-09", status: "skipped" },
    { habitId: "walk", date: "2026-11-10", status: "open" },
    { habitId: "walk", date: "2026-11-11", status: "minimum" },
    { habitId: "walk", date: today, status: "open" },
  ]);
  expect(daily.doubles).toBe(1); expect(daily.rec).toEqual({ m: 2, r: 1 });
  expect(daily.checks[1]!.ok).toBe(false);
  expect(daily.activity.find(d => d.date === "2026-11-10")).toMatchObject({ misses: 1, doubles: 1, reps: 0 });
  expect(daily.activity.find(d => d.date === "2026-11-09")?.due).toBe(0);
});

test("load uses recorded status dates, including archive/reactivation, not age or the current status", () => {
  const p = projection(); p.habits[0]!.status = "established";
  const revisions: CatalogRevision[] = [
    { at: "2026-01-01T12:00:00Z", changes: [{ type: "upsertHabit", ...p.habits[0]!, kind: "build", status: "building", tracked: true, order: 0, details: {} }] },
    { at: "2026-10-02T02:00:00Z", changes: [{ type: "setStatus", habitId: "walk", status: "established" }] },
    { at: "2026-10-15T12:00:00Z", changes: [{ type: "archive", target: "stack", id: "am" }] },
    { at: "2026-11-01T12:00:00Z", changes: [{ type: "setStatus", habitId: "walk", status: "established" }] },
  ];
  const timeline = catalogTimeline(p, revisions, today);
  expect(timeline.at("2026-09-30")[0]!.status).toBe("building");
  expect(timeline.at("2026-10-01")[0]!.status).toBe("established");
  expect(timeline.at("2026-10-16")).toEqual([]);
  const s = summary(p, observations(70), revisions);
  expect(s.autopilotDates.walk).toBe("2026-10-01"); expect(s.autoNow).toBe(1); expect(s.autoThen).toBe(0);
  expect(summary(p).autopilotDates.walk).toBe(today); // No invented established date.
});

test("slots rank adequate samples; decisions include minimum, graduation and gate/double warnings", () => {
  const rows = observations(70).map(r => ({ ...r, status: new Date(`${r.date}T12:00Z`).getUTCDay() === 1 ? "open" : "minimum" }));
  const s = summary(projection(), rows);
  expect(s.slots[0]).toMatchObject({ d: 1, due: 10, m: 10, rate: 100 });
  expect(s.findings.some(f => f.why.includes("minimum"))).toBe(true);
  const graduate = computeHabitSummary({ projection: projection(), revisions: [], occurrences: rows, today, lifetimeReps: { walk: 300 } });
  expect(graduate.findings.some(f => f.tone === "win")).toBe(true);
  const fail = summary(projection(), observations(70, "open"));
  expect(fail.findings.some(f => f.why.startsWith("Below gate"))).toBe(true);
  expect(fail.findings.some(f => f.why.startsWith("Missed twice"))).toBe(true);
});

test("service uses four bulk owner-scoped reads for 55 habits, bounded raw payload and aggregate lifetime counts", async () => {
  const { createHabitSummary } = await import("./habits-summary");
  const calls: string[] = []; const p = projection();
  p.habits = Array.from({ length: 55 }, (_, i) => ({ ...p.habits[0]!, id: `h${i}` }));
  const service = createHabitSummary({
    habitDefinitionRevision: { findMany: async (q: any) => { expect(q.where.ownerId).toBe("owner"); calls.push("history"); return []; } },
    habitOccurrence: { groupBy: async (q: any) => { expect(q.where.ownerId).toBe("owner"); calls.push("totals"); return []; } },
    $queryRaw: async (sql: TemplateStringsArray, ...params: unknown[]) => { calls.push("observations"); expect(params).toContain("owner"); expect(sql.join("")).toContain("eligible_rank <="); expect(params).toContain(15); return []; },
  } as any, { current: async owner => { expect(owner).toBe("owner"); calls.push("catalog"); return { projection: p, revision: 1 }; } });
  const t = performance.now(); const s = await service.read("owner", new Date(`${today}T16:00Z`));
  expect(calls).toHaveLength(4); expect(s.gateCount).toBe(55);
  console.info(JSON.stringify({ summaryDbReads: calls.length, habits: 55, computeMs: performance.now() - t, responseBytes: JSON.stringify(s).length }));
});

test("Summary requires read permission, scopes owner and reports loader failure without source details", async () => {
  const { OpenAPIHono } = await import("@hono/zod-openapi");
  const { registerHabitSummaryRoutes } = await import("./habits-summary-route");
  const app = new OpenAPIHono<any>(); let access: any = null, calls = 0, fail = false;
  app.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  registerHabitSummaryRoutes(app, { read: async owner => { calls++; expect(owner).toBe("owner"); if (fail) throw Error("private database error"); return summary(); } });
  expect((await app.request("/api/v1/habits/summary")).status).toBe(401);
  access = { owner: { id: "owner" }, permissions: ["habits:write"] };
  expect((await app.request("/api/v1/habits/summary")).status).toBe(403); expect(calls).toBe(0);
  access.permissions = ["habits:read"];
  const response = await app.request("/api/v1/habits/summary"); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  fail = true; const error = await app.request("/api/v1/habits/summary"); expect(error.status).toBe(503); expect(await error.text()).not.toContain("private");
});
