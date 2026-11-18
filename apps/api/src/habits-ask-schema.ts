import { z } from "@hono/zod-openapi";
import { habitDate, habitSchema } from "./habits-definition";
export const feelingSchema = z.enum(["Tired", "Busy", "Low energy", "Anxious", "Bored", "Away from home", "Unmotivated", "Other"]);
export const askInputSchema = z.object({ habitId: habitSchema.shape.id, text: z.string().trim().min(1).max(2000) }).strict();
export const askAnswerSchema = z.object({ feeling: feelingSchema, lead: z.string().trim().min(1).max(240), step: z.string().trim().min(1).max(400), support: z.string().trim().max(400) }).strict();
export const askRecordSchema = z.object({ id: z.uuid(), habitId: z.string(), text: z.string(), feeling: feelingSchema, at: z.string(), date: habitDate,
  outcomeRevision: z.number().int().nonnegative().nullable(), outcome: z.enum(["did full", "did minimum", "skipped", "open"]), answer: askAnswerSchema.nullable() });
export const askListRecordSchema = askRecordSchema.omit({ text: true, answer: true });
export const askPageSchema = z.object({ rows: z.array(askListRecordSchema), next: z.string().nullable() });
export type HabitAskListRecord = z.infer<typeof askListRecordSchema>;
export type HabitAskRecord = z.infer<typeof askRecordSchema>;
export type HabitAskAnswer = z.infer<typeof askAnswerSchema>;
