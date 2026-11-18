import { z } from "zod";
export const habitDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v;
  });
const id = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(100);
const days = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const schedule = z.union([z.enum(["daily", "weekdays"]), z.array(days).min(1)]);
const gate = z
  .object({
    window: z.number().int().positive().max(366),
    required: z.number().int().nonnegative(),
  })
  .passthrough()
  .refine((g) => g.required <= g.window);
export const gateDefaultsSchema = z.union([
  z.object({ daily: gate, weekly: gate })
    .passthrough()
    .transform((value) => ({
      ...value,
      window: value.daily.window,
      required: value.daily.required,
    })),
  gate,
]);
export const stackSchema = z
  .object({
    id,
    name: z.string().min(1),
    cue: z.string().optional(),
    anchor: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    durationMinutes: z.number().int().positive().optional(),
    days: schedule.default("daily"),
    alert: z.boolean().optional(),
  })
  .passthrough();
export const habitSchema = z
  .object({
    id,
    name: z.string().min(1),
    stack: id,
    order: z.number().int().default(0),
    kind: z.enum(["build", "break"]).default("build"),
    tracked: z.boolean().default(false),
    alert: z.boolean().optional(),
    // Plan-B reminder: if this tracked habit is still open at this local time, push its fallback.
    fallbackAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    triggers: z.array(z.string().min(1).max(500)).max(100).optional(),
    status: z
      .enum(["pending", "testing", "building", "established", "paused"])
      .default("pending"),
    startDate: habitDate.optional(),
    schedule: schedule.optional(),
    gate: gate.optional(),
  })
  .passthrough();
export type Habit = z.infer<typeof habitSchema>;
export type HabitProjection = {
  stacks: z.infer<typeof stackSchema>[];
  habits: Habit[];
  gate: z.infer<typeof gate> & {
    daily?: z.infer<typeof gate>;
    weekly?: z.infer<typeof gate>;
  };
  diagnostics: string[];
};
export function parseHabits(source: string): HabitProjection {
  const root = z
    .object({
      stacks: z.array(z.unknown()),
      habits: z.array(z.unknown()),
      gate: gateDefaultsSchema.default({ window: 14, required: 10 }),
    })
    .passthrough()
    .parse(Bun.YAML.parse(source));
  const diagnostics: string[] = [];
  function entries<T extends { id: string }>(
    values: unknown[],
    schema: z.ZodType<T>,
    label: string,
  ): T[] {
    const duplicates = new Set<string>();
    const seen = new Set<string>();
    for (const value of values) {
      const key = (value as { id?: unknown } | null)?.id;
      if (typeof key === "string") {
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
      }
    }
    return values.flatMap((v, i) => {
      const p = schema.safeParse(v);
      if (!p.success || duplicates.has(p.data.id)) {
        diagnostics.push(
          `${label}[${i}]: ${p.success ? "duplicate id" : p.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
        );
        return [];
      }
      return [p.data];
    });
  }
  const stacks = entries(root.stacks, stackSchema, "stacks");
  const habits = entries(root.habits, habitSchema, "habits")
    .filter((h) => {
      if (stacks.some((s) => s.id === h.stack)) return true;
      diagnostics.push(`${h.id}: unknown stack ${h.stack}`);
      return false;
    })
    .sort((a, b) => a.order - b.order);
  return { stacks, habits, gate: root.gate, diagnostics };
}
const habitDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Halifax",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function localHabitDate(now = new Date()) {
  return habitDateFormatter.format(now);
}
export function scheduled(projection: HabitProjection, h: Habit, date: string) {
  const s =
    h.schedule ??
    projection.stacks.find((s) => s.id === h.stack)?.days ??
    "daily";
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return (
    s === "daily" ||
    (s === "weekdays"
      ? day > 0 && day < 6
      : s.includes(
          (
            [
              "sunday",
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday",
              "saturday",
            ] as const
          )[day],
        ))
  );
}
export function eligible(p: HabitProjection, date: string) {
  return p.habits.filter(
    (h) =>
      h.kind === "build" &&
      h.tracked &&
      ["testing", "building", "established"].includes(h.status) &&
      (!h.startDate || h.startDate <= date) &&
      scheduled(p, h, date),
  );
}
