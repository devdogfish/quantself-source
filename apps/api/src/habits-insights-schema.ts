import { z } from "@hono/zod-openapi";
import { habitDate } from "./habits-definition";

export const dayStateSchema = z.enum([
  "done",
  "minimum",
  "skipped",
  "missed",
  "open",
  "none",
]);
export const overviewHabitSchema = z.object({
  id: z.string(),
  name: z.string(),
  stackId: z.string(),
  stackName: z.string(),
  status: z.enum(["pending", "testing", "building", "established", "paused"]),
  identity: z.string().nullable(),
  cadence: z.enum(["daily", "weekly"]),
  days: z.array(z.object({ date: habitDate, state: dayStateSchema })),
  chain: z.number().int(),
  chainAtRisk: z.boolean(),
  bestChain: z.number().int(),
  lifetimeReps: z.number().int(),
  minimumRatio: z.number(),
  gate: z.object({
    reps: z.number().int(),
    required: z.number().int(),
    window: z.number().int(),
    eligible: z.number().int(),
    state: z.enum(["pass", "fail", "pending"]),
  }),
});
export const insightSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "missed-twice",
    "chain-at-risk",
    "gate-passed",
    "gate-failing",
    "too-big",
    "ready-to-ramp",
    "stack-break",
    "knock-on",
    "weekday",
    "skips-rising",
  ]),
  severity: z.enum(["attention", "info", "win"]),
  title: z.string(),
  detail: z.string(),
  habitIds: z.array(z.string()),
  prompt: z.string(),
});
const reviewStatusSchema = z.enum(["missing", "exists", "unavailable"]);
const recoverySchema = z.object({ misses: z.number().int(), recovered: z.number().int() });
export const catalogFactSchema = z.object({
  id: z.string(), date: habitDate, weekly: z.boolean(), today: dayStateSchema,
  rule: z.object({ window: z.number().int(), required: z.number().int() }),
  prior: z.object({
    reps: z.number().int(), eligible: z.number().int(), recentReps: z.number().int(), recentEligible: z.number().int(),
    lastDone: habitDate.nullable(), recovery: recoverySchema, previousResolved: dayStateSchema.nullable(),
  }),
  gateHistory: z.array(z.object({ date: habitDate, state: dayStateSchema })),
});
export type CatalogFact = z.infer<typeof catalogFactSchema>;
export const habitOverviewSchema = z.object({
  catalogFacts: z.array(catalogFactSchema).optional().describe("All Catalog habits, including untracked and break habits. Lifetime facts before today plus bounded gate context for optimistic projections; no per-habit reads."),
  asOf: habitDate,
  range: z.object({ from: habitDate, to: habitDate }),
  totals: z.object({
    votes: z.number().int(),
    votesThisWeek: z.number().int(),
    votesLastWeek: z.number().int(),
  }),
  habits: z.array(overviewHabitSchema),
  upcoming: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      startDate: habitDate.nullable(),
      waitingOn: z.string().nullable(),
    }),
  ),
  insights: z.array(insightSchema).max(6),
  reviewDue: z.object({
    date: habitDate,
    done: z.boolean().openapi({ description: "Legacy flag indicating a review document exists." }),
    status: reviewStatusSchema.optional(),
  }),
});
export type DayState = z.infer<typeof dayStateSchema>;
export type OverviewHabit = z.infer<typeof overviewHabitSchema>;
export type Insight = z.infer<typeof insightSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type HabitOverview = z.infer<typeof habitOverviewSchema>;
