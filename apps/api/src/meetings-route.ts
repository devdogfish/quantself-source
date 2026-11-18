import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { authorizeAccessContext, authorizationFailureStatus, type AccessContext } from "@quantself/auth";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { bookableWindow, meetingDurationMs, openSlots, slotIso, taskBusyIntervals } from "./meetings-availability";
import { meetingEmailConfig, type MeetingEmailConfig } from "./meetings-email";
import { createRateLimiter, type RateLimit } from "./meetings-rate-limit";
import { hashCancelToken, newCancelToken, newJitsiRoom, prismaMeetingStore, type MeetingStore } from "./meetings-store";
import type { TodoReader } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };

export const meetingsPath = "/api/v1/meetings";
export const meetingsPermission = "meetings:book";
export const meetingsMaxBodyBytes = 4096;
const maxRangeMs = 31 * 86_400_000;

export type MeetingRouteOptions = {
  store?: MeetingStore;
  config?: () => MeetingEmailConfig | null;
  now?: () => number;
  /** Called after a booking or cancellation commits, to send its email without waiting for the worker tick. */
  onChange?: () => void;
  limits?: {
    /** Every booking-route request by one scoped token. */
    perToken?: RateLimit;
    /** Booking attempts by one scoped token. */
    bookingsPerToken?: RateLimit;
    /** Booking attempts for one guest email. */
    perEmail?: RateLimit;
    maxFutureMeetingsPerEmail?: number;
  };
};

const defaultLimits = {
  perToken: { limit: 300, windowMs: 10 * 60_000 },
  bookingsPerToken: { limit: 30, windowMs: 60 * 60_000 },
  perEmail: { limit: 5, windowMs: 60 * 60_000 },
  maxFutureMeetingsPerEmail: 2,
};

const noControl = /^[^\p{Cc}]*$/u;
const noControlExceptLines = /^(?:[^\p{Cc}]|[\n\r\t])*$/u;
const instant = z.iso.datetime({ offset: true });
const errorSchema = z.object({ code: z.string(), message: z.string() });
const slotsSchema = z.object({ slots: z.array(z.string()) }).openapi("MeetingSlots");
const receiptSchema = z.object({ id: z.string(), start: z.string(), end: z.string() }).openapi("MeetingReceipt");
const bookSchema = z.object({
  start: instant.describe("An open slot start from availability."),
  name: z.string().trim().min(1).max(100).regex(noControl),
  email: z.email().max(254).transform(value => value.toLowerCase()),
  note: z.string().trim().max(1000).regex(noControlExceptLines).optional(),
}).strict().openapi("MeetingBooking");
const cancelSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe("The guest cancel token from the confirmation email."),
}).strict().openapi("MeetingCancel");

const example = { id: "6f1c2a9e-8b3d-4e5f-9a1b-2c3d4e5f6a7b", start: "2026-11-17T14:00:00Z", end: "2026-11-17T14:30:00Z" };
const json = <T extends z.ZodType>(schema: T, value: unknown) => ({ "application/json": { schema, example: value } });
const failure = (code: string, message: string) => ({ description: message, content: json(errorSchema, { code, message }) });
const failures = {
  400: failure("INVALID_REQUEST", "Request validation failed."),
  401: failure("UNAUTHENTICATED", "Authentication required."),
  403: failure("FORBIDDEN", "Missing required permission."),
  429: failure("RATE_LIMITED", "Too many requests."),
  503: failure("MEETINGS_UNAVAILABLE", "Booking is not available right now."),
};
const shared = {
  tags: ["Meetings"],
  security: [{ apiKeyAuth: [] }],
  "x-required-permissions": [meetingsPermission],
};
const unavailable = { code: "MEETINGS_UNAVAILABLE", message: "Booking is not available right now." } as const;
const rateLimited = { code: "RATE_LIMITED", message: "Too many requests." } as const;

export function registerMeetingRoutes(app: OpenAPIHono<Env>, tasks: TodoReader, options: MeetingRouteOptions = {}) {
  const store = options.store ?? prismaMeetingStore();
  const config = options.config ?? (() => meetingEmailConfig());
  const now = options.now ?? Date.now;
  const limits = { ...defaultLimits, ...options.limits };
  const perToken = createRateLimiter(limits.perToken);
  const bookingsPerToken = createRateLimiter(limits.bookingsPerToken);
  const perEmail = createRateLimiter(limits.perEmail);

  // Runs before validation so a token without the permission learns nothing about the inputs.
  const requireBooking = createMiddleware<Env>(async (context, next) => {
    context.header("Cache-Control", "no-store");
    const authorization = authorizeAccessContext(context.get("accessContext"), meetingsPermission);
    if (!authorization.ok) return context.json(authorization.error, authorizationFailureStatus(authorization.error));
    const retryAfter = perToken.hit(authorization.accessContext.client.id, now());
    if (retryAfter) {
      context.header("Retry-After", String(retryAfter));
      return context.json(rateLimited, 429);
    }
    await next();
  });
  const sizeLimit = bodyLimit({
    maxSize: meetingsMaxBodyBytes,
    onError: context => context.json({ code: "PAYLOAD_TOO_LARGE", message: "JSON payload exceeds 4 KiB." }, 413),
  });

  async function busyTasks(forBooking: boolean) {
    try {
      // Submission revalidates current source facts before entering the booking transaction.
      const rows = forBooking ? await tasks.list("booking")
        : await (tasks.listForBookingAvailability?.() ?? tasks.list());
      return taskBusyIntervals(rows);
    } catch {
      return null;
    }
  }

  app.openapi(createRoute({
    ...shared,
    method: "get",
    path: `${meetingsPath}/availability`,
    operationId: "getMeetingAvailability",
    summary: "List open meeting slots",
    description: "Authentication: scoped X-API-Key. Required permissions: meetings:book. Inputs: optional from and to ISO instants (at most 31 days apart). Success response: 30-minute slot start times in UTC; never what is busy or why. Failure responses: invalid range, unauthorized, rate limited, or booking temporarily unavailable. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    "x-destructive": false,
    middleware: [requireBooking] as const,
    request: { query: z.object({ from: instant.optional(), to: instant.optional() }) },
    responses: {
      200: { description: "Open slot starts", content: json(slotsSchema, { slots: ["2026-11-17T14:00:00Z", "2026-11-17T14:30:00Z"] }) },
      ...failures,
    },
  }), async context => {
    const query = context.req.valid("query");
    const from = query.from ? Date.parse(query.from) : undefined;
    const to = query.to ? Date.parse(query.to) : undefined;
    if (from !== undefined && to !== undefined && (to <= from || to - from > maxRangeMs)) {
      return context.json({ code: "INVALID_REQUEST", message: "Use a range of at most 31 days." }, 400);
    }
    if (!config()) return context.json(unavailable, 503);
    const ownerId = context.get("accessContext")!.owner.id;
    const at = now();
    async function availableWindow() {
      const settings = await store.settings(ownerId);
      const window = bookableWindow(settings, at, from, to);
      // The request bounds slot starts. The final call can end after the range.
      const calendar = window.end > window.start
        ? await store.calendarBusyBetween(ownerId, { start: window.start, end: window.end + meetingDurationMs })
        : [];
      return { settings, calendar };
    }
    try {
      const [{ settings, calendar }, busy] = await Promise.all([availableWindow(), busyTasks(false)]);
      if (!busy) return context.json(unavailable, 503);
      const slots = openSlots({ settings, now: at, busy: [...busy, ...calendar], from, to });
      return context.json({ slots: slots.map(slotIso) }, 200);
    } catch {
      return context.json(unavailable, 503);
    }
  });

  app.openapi(createRoute({
    ...shared,
    method: "post",
    path: meetingsPath,
    operationId: "bookMeeting",
    summary: "Book a meeting",
    description: "Authentication: scoped X-API-Key. Required permissions: meetings:book. Inputs: Idempotency-Key header; JSON start (an open slot), name, email and optional note, at most 4 KiB. Success response: 201 with the meeting id, start and end; confirmed instantly. Failure responses: invalid input, unauthorized, slot no longer open or key reused with other input (409), rate limited or email at its upcoming-meeting cap (429), payload too large, or booking unavailable. Side effects: creates a meeting with a random Jitsi room and emails an .ics confirmation to the guest and the Owner. Destructive: no. Retry safety: retry with the same Idempotency-Key and body returns the original result.",
    "x-destructive": false,
    middleware: [requireBooking, sizeLimit] as const,
    request: {
      headers: z.object({ "idempotency-key": z.string().trim().min(1).max(255) }),
      body: { required: true, content: json(bookSchema, { start: example.start, name: "Ada Lovelace", email: "ada@example.com", note: "Website project" }) },
    },
    responses: {
      201: { description: "Meeting booked", content: json(receiptSchema, example) },
      ...failures,
      409: failure("SLOT_UNAVAILABLE", "That time is no longer available."),
      413: failure("PAYLOAD_TOO_LARGE", "JSON payload exceeds 4 KiB."),
    },
  }), async context => {
    const body = context.req.valid("json");
    const accessContext = context.get("accessContext")!;
    if (!config()) return context.json(unavailable, 503);
    const at = now();
    for (const [limiter, key] of [[bookingsPerToken, accessContext.client.id], [perEmail, body.email]] as const) {
      const retryAfter = limiter.hit(key, at);
      if (retryAfter) {
        context.header("Retry-After", String(retryAfter));
        return context.json(rateLimited, 429);
      }
    }
    const start = Date.parse(body.start);
    const ownerId = accessContext.owner.id;
    const [settings, busy] = await Promise.all([store.settings(ownerId), busyTasks(true)]);
    if (!busy) return context.json(unavailable, 503);
    const slotAllowed = openSlots({ settings, now: at, busy, from: start, to: start + 1 }).includes(start);
    const outcome = await store.book({
      ownerId,
      clientId: accessContext.client.id,
      idempotencyKey: context.req.valid("header")["idempotency-key"],
      request: { start: body.start, name: body.name, email: body.email, ...(body.note ? { note: body.note } : {}) },
      start: new Date(start),
      end: new Date(start + meetingDurationMs),
      guestEmail: body.email,
      slotAllowed,
      maxFutureMeetingsPerEmail: limits.maxFutureMeetingsPerEmail,
      now: new Date(at),
      jitsiRoom: newJitsiRoom(),
      cancelToken: newCancelToken(),
    }).catch(() => null);
    if (!outcome) return context.json(unavailable, 503);
    if (outcome.status !== 201) return context.json(outcome.body, outcome.status);
    options.onChange?.();
    return context.json(outcome.body, 201);
  });

  app.openapi(createRoute({
    ...shared,
    method: "post",
    path: `${meetingsPath}/cancel`,
    operationId: "cancelMeeting",
    summary: "Cancel a meeting with a guest token",
    description: "Authentication: scoped X-API-Key. Required permissions: meetings:book. Inputs: JSON token from the guest's cancel link, at most 4 KiB. Success response: the cancelled meeting's id, start and end. Failure responses: invalid token format, unauthorized, unknown token (404), meeting already started (409), rate limited or payload too large. Side effects: cancels the meeting, frees its slot and emails a cancellation to the guest and the Owner. Destructive: yes. Retry safety: cancelling an already cancelled meeting returns the same result.",
    "x-destructive": true,
    middleware: [requireBooking, sizeLimit] as const,
    request: { body: { required: true, content: json(cancelSchema, { token: "q0hS2k8m3v7Yt1cXbN5rP9wE4uA6zL2jD8fG0hK3mQ7" }) } },
    responses: {
      200: { description: "Meeting cancelled", content: json(receiptSchema, example) },
      ...failures,
      404: failure("MEETING_NOT_FOUND", "No meeting matches this cancel link."),
      409: failure("MEETING_STARTED", "This meeting has already started."),
      413: failure("PAYLOAD_TOO_LARGE", "JSON payload exceeds 4 KiB."),
    },
  }), async context => {
    const outcome = await store.cancel({
      ownerId: context.get("accessContext")!.owner.id,
      cancelTokenHash: hashCancelToken(context.req.valid("json").token),
      now: new Date(now()),
    });
    if (outcome.status !== 200) return context.json(outcome.body, outcome.status);
    options.onChange?.();
    return context.json(outcome.body, 200);
  });
}
