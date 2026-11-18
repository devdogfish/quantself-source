import { z } from "@hono/zod-openapi";
import { habitDate } from "./habits-definition";
const part = z.object({ key: z.string(), score: z.number(), weight: z.number(), hint: z.string() });
export const habitSummarySchema = z.object({
  asOf: habitDate, logged: z.number(), due: z.number(), nWeeks: z.number(),
  health: z.object({ parts: z.array(part), total: z.number().min(0).max(100) }),
  healthPrev: z.object({ total: z.number() }), band: z.object({ word: z.string(), color: z.string() }), weakest: part,
  rec: z.object({ m: z.number(), r: z.number() }), doubles: z.number(), passing: z.number(), gateCount: z.number(),
  checks: z.array(z.object({ ok: z.boolean(), label: z.string(), detail: z.string() })), ready: z.boolean(), wait: z.number(),
  anchor: z.object({ id: z.string(), name: z.string() }).nullable(),
  load: z.array(z.object({ label: z.string(), auto: z.number(), building: z.number() })), autoNow: z.number(), autoThen: z.number(),
  activity: z.array(z.object({ date: habitDate, due: z.number(), reps: z.number(), misses: z.number(), doubles: z.number(), open: z.boolean() })),
  slots: z.array(z.object({ st: z.object({ id: z.string(), name: z.string() }), d: z.number(), m: z.number(), due: z.number(), rate: z.number() })), maxRate: z.number(),
  findings: z.array(z.object({ tone: z.enum(["risk", "warn", "win"]), what: z.string(), why: z.string(), change: z.string(), habit: z.string().optional() })),
  autopilotDates: z.record(z.string(), habitDate),
});
