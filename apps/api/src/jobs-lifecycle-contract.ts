import { z } from "@hono/zod-openapi";
import { jobReviewRow } from "./jobs-review-contract";
import { prepMinutesSchema } from "./todos-schedule";

export const nextJobStatus = z.enum(["interviewing", "offer", "rejected", "withdrawn"]);
export const jobSourceReply = z.strictObject({
  folder: z.string().trim().min(1).max(160).refine(value => !/\p{Cc}/u.test(value)),
  uid: z.number().int().min(1).max(4_294_967_295),
}).openapi("JobSourceReply");

export const jobLifecycleInput = z.strictObject({
  status: nextJobStatus,
  expectedRevision: z.number().int().min(0).max(2_147_483_645).describe("Lifecycle revision, separate from the résumé revision."),
  sourceReply: jobSourceReply.nullable().optional(),
}).openapi("JobLifecycleChange");

const instant = z.iso.datetime({ offset: true });
const interviewTimes = { start: instant, end: instant };
function endFollowsStart({ start, end }: { start: string; end: string }) {
  return Date.parse(end) > Date.parse(start);
}
const interviewTimeError = { path: ["end"], message: "End must follow start." };
export const jobInterviewInput = z.strictObject(interviewTimes)
  .refine(endFollowsStart, interviewTimeError)
  .openapi("JobInterviewInput");
export const scheduleJobInterviewInput = z.strictObject({
  ...interviewTimes, expectedRevision: jobLifecycleInput.shape.expectedRevision,
}).refine(endFollowsStart, interviewTimeError).openapi("ScheduleJobInterviewInput");

const interviewIdentity = { id: z.uuid(), start: z.iso.datetime(), end: z.iso.datetime() };
const nativeInterview = z.object({
  ...interviewIdentity, source: z.literal("native"), revision: z.number().int().positive(),
  cancelledAt: z.iso.datetime().nullable(),
});
export const jobInterviewOutput = z.discriminatedUnion("source", [
  z.object({ ...interviewIdentity, source: z.literal("github"), todoNumber: z.number().int().positive() }),
  nativeInterview,
]).openapi("JobInterview");

export const scheduleJobInterviewOutput = z.object({
  appointment: jobInterviewOutput, auditId: z.uuid().optional(),
}).openapi("ScheduleJobInterviewResult");

export const nativeJobInterviewDetail = nativeInterview.extend({
  applicationId: z.uuid(), title: z.string(), fixed: z.literal(true), allDay: z.literal(false), category: z.literal("Job search"),
  beforeMinutes: prepMinutesSchema, afterMinutes: prepMinutesSchema,
  alertMinutes: z.number().int().min(1).max(10080).nullable(),
}).openapi("NativeJobInterviewAppointment");

const appointmentRevision = z.number().int().min(1).max(2_147_483_646);
export const nativeJobInterviewCommand = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("update"), expectedRevision: appointmentRevision,
    start: instant.optional(), end: instant.optional(),
    beforeMinutes: prepMinutesSchema.optional(), afterMinutes: prepMinutesSchema.optional(),
    alertMinutes: nativeJobInterviewDetail.shape.alertMinutes.optional(),
  }).superRefine(({ start, end, beforeMinutes, afterMinutes, alertMinutes }, context) => {
    if ((start === undefined) !== (end === undefined)) {
      context.addIssue({ code: "custom", path: [start === undefined ? "start" : "end"], message: "Supply both start and end." });
    } else if (start !== undefined && end !== undefined && !endFollowsStart({ start, end })) {
      context.addIssue({ code: "custom", ...interviewTimeError });
    } else if (start === undefined && beforeMinutes === undefined && afterMinutes === undefined && alertMinutes === undefined) {
      context.addIssue({ code: "custom", message: "Supply at least one field to update." });
    }
  }),
  z.strictObject({ action: z.literal("cancel"), expectedRevision: appointmentRevision }),
]).openapi("NativeJobInterviewCommand");

const appointmentCursor = z.object({ afterStart: instant, afterId: z.uuid() });
export const nativeJobInterviewRange = z.object({
  from: instant, to: instant, limit: z.coerce.number().int().min(1).max(200).default(100),
  afterStart: instant.optional(), afterId: z.uuid().optional(),
})
  .refine(({ from, to }) => Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(from) <= 370 * 86_400_000,
    { path: ["to"], message: "Supply an exclusive end after the start and within 370 days." })
  .refine(({ afterStart, afterId }) => !!afterStart === !!afterId,
    { path: ["afterId"], message: "Supply both pagination cursor fields." });
export const nativeJobInterviewListOutput = z.object({
  appointments: z.array(nativeJobInterviewDetail), nextCursor: appointmentCursor.nullable(),
}).openapi("NativeJobInterviewAppointments");

export const jobLifecycleOutput = z.object({
  application: jobReviewRow,
  revision: z.number().int().nonnegative(),
  changedAt: z.iso.datetime().nullable(),
  transitions: z.array(nextJobStatus),
  sourceReplyLinked: z.boolean(),
  sourceReplyUrl: z.url().nullable(),
  verifiedOriginalReplyAvailable: z.boolean().optional().describe("The lifecycle read found a saved Owner confirmation. Opening the reply checks it again."),
  verifiedOriginalReplies: z.array(z.object({
    id: z.uuid(), confirmedAt: z.iso.datetime(),
  })).optional().describe("Owner-confirmed reply identities. The original is verified again when opened."),
  verifiedOriginalRepliesBefore: z.uuid().nullable().optional(),
  canConfirmOriginalReply: z.boolean().optional(),
  appointments: z.array(jobInterviewOutput),
  auditId: z.uuid().optional(),
}).openapi("JobLifecycle");

export type JobLifecycleChange = z.output<typeof jobLifecycleInput>;
export type JobInterviewInput = z.output<typeof jobInterviewInput>;
export type JobInterviewResult = z.output<typeof jobInterviewOutput>;
export type ScheduleJobInterviewResult = z.output<typeof scheduleJobInterviewOutput>;
export type JobSourceReply = z.output<typeof jobSourceReply>;

export type NativeJobInterviewDetail = z.output<typeof nativeJobInterviewDetail>;
export type NativeJobInterviewRange = z.output<typeof nativeJobInterviewRange>;
export type NativeJobInterviewCommand = z.output<typeof nativeJobInterviewCommand>;
