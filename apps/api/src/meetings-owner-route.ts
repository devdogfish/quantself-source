import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, authorizationFailureStatus, type AccessContext } from "@quantself/auth";
import { createMiddleware } from "hono/factory";
import { weeklyHoursSchema } from "./meetings-availability";
import { meetingJitsiOrigin } from "./meetings-email";
import { prismaOwnerMeetingStore, type OwnerMeetingStore } from "./meetings-owner-store";
import { meetingsPath } from "./meetings-route";

type Env = { Variables: { accessContext: AccessContext | null } };

export type OwnerMeetingRouteOptions = {
  store?: OwnerMeetingStore;
  jitsiOrigin?: () => string | null;
  now?: () => number;
  /** Called after the Owner cancels, so the guest's cancellation email goes out without waiting for the worker tick. */
  onChange?: () => void;
};

// Week view loads three weeks around the visible one; leave room for a month.
const maxRangeMs = 62 * 86_400_000;
const instant = z.iso.datetime({ offset: true });
const iso = (date: Date) => date.toISOString().replace(".000Z", "Z");
const errorSchema = z.object({ code: z.string(), message: z.string() });
const meetingSchema = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  guestName: z.string(),
  guestEmail: z.string(),
  note: z.string().nullable(),
  jitsiUrl: z.string().nullable().describe("Public Jitsi room; null until QUANTSELF_MEETINGS_JITSI_ORIGIN is set."),
}).openapi("OwnerMeeting");
const meetingListSchema = z.object({ meetings: z.array(meetingSchema) }).openapi("OwnerMeetingList");
const receiptSchema = z.object({ id: z.string(), start: z.string(), end: z.string() });
const timeZone = z.string().min(1).max(64).refine(value => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone.");
const settingsSchema = z.object({
  timeZone,
  weeklyHours: weeklyHoursSchema,
  noticeMinutes: z.number().int().min(0).max(14 * 1440),
  horizonDays: z.number().int().min(1).max(90),
}).strict().openapi("MeetingSettings");

const json = <T extends z.ZodType>(schema: T, example: unknown) => ({ "application/json": { schema, example } });
const failure = (code: string, message: string) => ({ description: message, content: json(errorSchema, { code, message }) });
const failures = {
  400: failure("INVALID_REQUEST", "Request validation failed."),
  401: failure("UNAUTHENTICATED", "Authentication required."),
  403: failure("FORBIDDEN", "Missing required permission."),
};
const receiptExample = { id: "6f1c2a9e-8b3d-4e5f-9a1b-2c3d4e5f6a7b", start: "2026-11-17T14:00:00Z", end: "2026-11-17T14:30:00Z" };
const meetingExample = {
  ...receiptExample, guestName: "Ada Lovelace", guestEmail: "ada@example.com", note: "Website project",
  jitsiUrl: "https://meet.example.com/meet-0f9a6c1d2e3b4a5c6d7e8f9a0b1c2d3e",
};
const settingsExample = {
  timeZone: "America/Halifax",
  weeklyHours: { mon: [["09:00", "17:00"]], wed: [["09:00", "12:00"], ["13:00", "17:00"]] },
  noticeMinutes: 720,
  horizonDays: 14,
};
const shared = { tags: ["Meetings"], security: [{ apiKeyAuth: [] }] };

export function registerOwnerMeetingRoutes(app: OpenAPIHono<Env>, options: OwnerMeetingRouteOptions = {}) {
  const store = options.store ?? prismaOwnerMeetingStore();
  const jitsiOrigin = options.jitsiOrigin ?? (() => meetingJitsiOrigin());
  const now = options.now ?? Date.now;
  const require = (permission: string) => createMiddleware<Env>(async (context, next) => {
    context.header("Cache-Control", "no-store");
    const authorization = authorizeAccessContext(context.get("accessContext"), permission);
    if (!authorization.ok) return context.json(authorization.error, authorizationFailureStatus(authorization.error));
    await next();
  });
  const read = require("meetings:read");
  const write = require("meetings:write");
  const ownerId = (context: { get(key: "accessContext"): AccessContext | null }) => context.get("accessContext")!.owner.id;

  app.openapi(createRoute({
    ...shared,
    method: "get",
    path: `${meetingsPath}/booked`,
    operationId: "listBookedMeetings",
    summary: "List booked meetings in a range",
    description: "Authentication: Owner session or X-API-Key. Required permissions: meetings:read. Inputs: from and to ISO instants, at most 62 days apart. Success response: booked meetings overlapping the range with guest details and the Jitsi room link; cancelled meetings are omitted. Failure responses: invalid range or unauthorized. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    "x-required-permissions": ["meetings:read"],
    "x-destructive": false,
    middleware: [read] as const,
    request: { query: z.object({ from: instant, to: instant }) },
    responses: { 200: { description: "Booked meetings", content: json(meetingListSchema, { meetings: [meetingExample] }) }, ...failures },
  }), async context => {
    const query = context.req.valid("query");
    const from = Date.parse(query.from), to = Date.parse(query.to);
    if (to <= from || to - from > maxRangeMs) {
      return context.json({ code: "INVALID_REQUEST", message: "Use a range of at most 62 days." }, 400);
    }
    const origin = jitsiOrigin();
    const rows = await store.booked(ownerId(context), new Date(from), new Date(to));
    return context.json({
      meetings: rows.map(row => ({
        id: row.id,
        start: iso(row.start),
        end: iso(row.end),
        guestName: row.guestName,
        guestEmail: row.guestEmail,
        note: row.note,
        jitsiUrl: origin ? `${origin}/${row.jitsiRoom}` : null,
      })),
    }, 200);
  });

  app.openapi(createRoute({
    ...shared,
    method: "post",
    path: `${meetingsPath}/{id}/cancel`,
    operationId: "cancelBookedMeeting",
    summary: "Cancel a booked meeting as the Owner",
    description: "Authentication: Owner session or X-API-Key. Required permissions: meetings:write. Inputs: meeting id. Success response: the cancelled meeting's id, start and end. Failure responses: unauthorized, unknown meeting (404), meeting already started (409). Side effects: cancels the meeting, frees its slot and emails a cancellation to the guest and the Owner. Destructive: yes. Retry safety: cancelling an already cancelled meeting returns the same result and sends no second email.",
    "x-required-permissions": ["meetings:write"],
    "x-destructive": true,
    middleware: [write] as const,
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: { description: "Meeting cancelled", content: json(receiptSchema, receiptExample) },
      ...failures,
      404: failure("MEETING_NOT_FOUND", "No such meeting."),
      409: failure("MEETING_STARTED", "This meeting has already started."),
    },
  }), async context => {
    const outcome = await store.cancel({ ownerId: ownerId(context), id: context.req.valid("param").id, now: new Date(now()) });
    if (outcome.status === 404) return context.json({ code: "MEETING_NOT_FOUND", message: "No such meeting." }, 404);
    if (outcome.status !== 200) return context.json(outcome.body, outcome.status);
    options.onChange?.();
    return context.json(outcome.body, 200);
  });

  app.openapi(createRoute({
    ...shared,
    method: "get",
    path: `${meetingsPath}/settings`,
    operationId: "getMeetingSettings",
    summary: "Read booking settings",
    description: "Authentication: Owner session or X-API-Key. Required permissions: meetings:read. Inputs: none. Success response: weekly booking hours in the Owner's time zone, minimum notice in minutes and booking horizon in days; defaults until saved. Failure responses: unauthorized. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    "x-required-permissions": ["meetings:read"],
    "x-destructive": false,
    middleware: [read] as const,
    responses: { 200: { description: "Booking settings", content: json(settingsSchema, settingsExample) }, ...failures },
  }), async context => context.json(await store.settings(ownerId(context)), 200));

  app.openapi(createRoute({
    ...shared,
    method: "put",
    path: `${meetingsPath}/settings`,
    operationId: "putMeetingSettings",
    summary: "Replace booking settings",
    description: "Authentication: Owner session or X-API-Key. Required permissions: meetings:write. Inputs: JSON timeZone (IANA), weeklyHours ({ mon: [[\"09:00\",\"17:00\"]] }, :00/:30 boundaries; missing days are closed), noticeMinutes (0–20160) and horizonDays (1–90). Success response: the saved settings. Failure responses: invalid input or unauthorized. Side effects: changes which slots visitors can book; existing meetings stay. Destructive: no. Retry safety: full replacement, safe to repeat.",
    "x-required-permissions": ["meetings:write"],
    "x-destructive": false,
    middleware: [write] as const,
    request: { body: { required: true, content: json(settingsSchema, settingsExample) } },
    responses: { 200: { description: "Saved booking settings", content: json(settingsSchema, settingsExample) }, ...failures },
  }), async context => context.json(await store.saveSettings(ownerId(context), context.req.valid("json")), 200));
}
