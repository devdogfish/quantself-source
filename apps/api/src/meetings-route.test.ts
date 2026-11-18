import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { createApp } from "./app";
import { bufferedEvent, defaultMeetingSettings, overlaps, type Interval, type MeetingSettingsValue } from "./meetings-availability";
import type { MeetingRouteOptions } from "./meetings-route";
import {
  hashCancelToken, meetingLimitReached, meetingNotFound, meetingStarted, receipt, slotUnavailable,
  type BookCommand, type BookOutcome, type MeetingStore,
} from "./meetings-store";
import type { Todo, TodoReader } from "./todos-github";

type Row = { id: string; ownerId: string; start: Date; end: Date; guestEmail: string; status: "booked" | "cancelled"; cancelTokenHash: string; pendingCancelToken: string | null; jitsiRoom: string };

/** Mirrors the Prisma store: one serialized transaction per command, idempotency keys scoped per client. */
function memoryStore(settings: MeetingSettingsValue, calendar: Interval[] = [], calendarFail = false) {
  const meetings: Row[] = [];
  const keys = new Map<string, { fingerprint: string; outcome: BookOutcome }>();
  let queue = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const run = queue.then(work);
    queue = run.then(() => {}, () => {});
    return run;
  };
  const store: MeetingStore = {
    settings: async () => settings,
    calendarBusyBetween: async (ownerId, range) => {
      if (calendarFail) throw new Error("calendar unavailable");
      return [
        ...meetings.filter(row => row.ownerId === ownerId && row.status === "booked")
          .map(row => bufferedEvent(row.start.getTime(), row.end.getTime())),
        ...calendar,
      ].filter(event => overlaps(event, range));
    },
    book: (command: BookCommand) => serial(async () => {
      await Bun.sleep(1); // Let concurrent requests interleave up to the transaction.
      const key = `${command.clientId}:${command.idempotencyKey}`;
      const fingerprint = JSON.stringify(Object.entries(command.request).sort());
      const existing = keys.get(key);
      if (existing) {
        return existing.fingerprint === fingerprint
          ? existing.outcome
          : { status: 409, body: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key was already used with different input." } };
      }
      let outcome: BookOutcome;
      const busy = await store.calendarBusyBetween(command.ownerId, {
        start: command.start.getTime(), end: command.end.getTime(),
      });
      if (!command.slotAllowed || busy.length) {
        outcome = slotUnavailable;
      } else if (meetings.filter(row => row.guestEmail === command.guestEmail && row.status === "booked" && row.start > command.now).length >= command.maxFutureMeetingsPerEmail) {
        outcome = meetingLimitReached;
      } else {
        const row: Row = {
          id: crypto.randomUUID(), ownerId: command.ownerId, start: command.start, end: command.end, guestEmail: command.guestEmail,
          status: "booked", cancelTokenHash: hashCancelToken(command.cancelToken), pendingCancelToken: command.cancelToken, jitsiRoom: command.jitsiRoom,
        };
        meetings.push(row);
        outcome = { status: 201, body: receipt(row) };
      }
      keys.set(key, { fingerprint, outcome });
      return outcome;
    }),
    cancel: async ({ ownerId, cancelTokenHash, now }) => {
      const row = meetings.find(meeting => meeting.cancelTokenHash === cancelTokenHash);
      if (!row || row.ownerId !== ownerId) return meetingNotFound;
      if (row.status === "booked" && row.start <= now) return meetingStarted;
      row.status = "cancelled";
      return { status: 200, body: receipt(row) };
    },
  };
  return { store, meetings };
}

const owner = { id: "owner-1", name: "Owner", email: "owner@example.test" };
const bookingKey = "booking-key-fixture";
const contexts: Record<string, AccessContext> = {
  [bookingKey]: { owner, client: { id: "portfolio", kind: "api-key", name: "Portfolio booking" }, permissions: ["meetings:book"] },
  "second-booking-key": { owner, client: { id: "portfolio-2", kind: "api-key", name: "Portfolio booking 2" }, permissions: ["meetings:book"] },
  "todos-key": { owner, client: { id: "todos", kind: "api-key", name: "Todo reader" }, permissions: ["todos:read", "inventory:read"] },
};
const config = { from: "Quantself Meetings <meetings@example.test>", ownerEmail: owner.email, jitsiOrigin: "https://meet.example.test", portfolioOrigin: "https://portfolio.example.test", timeZone: "America/Halifax" };
// Monday 2026-11-16 08:00 in Halifax. With the defaults the first slot is Tuesday 09:00 (13:00Z).
const now = Date.parse("2026-11-16T12:00:00Z");
const first = "2026-11-17T13:00:00Z";
const second = "2026-11-17T13:30:00Z";

function setup(input: { tasks?: Partial<Todo>[]; calendar?: Interval[]; calendarFail?: boolean; options?: MeetingRouteOptions; settings?: MeetingSettingsValue; tasksFail?: boolean } = {}) {
  const { store, meetings } = memoryStore(input.settings ?? defaultMeetingSettings, input.calendar, input.calendarFail);
  const changes: string[] = [];
  const taskReads: (Parameters<TodoReader["list"]>[0] | "projection")[] = [];
  const readTasks = () => {
    if (input.tasksFail) throw new Error("projection unavailable");
    return (input.tasks ?? []).map(task => ({ state: "open", allDay: false, start: null, end: null, ...task }) as Todo);
  };
  const todos: TodoReader = {
    list: async purpose => {
      taskReads.push(purpose);
      return readTasks();
    },
    listForBookingAvailability: async () => {
      taskReads.push("projection");
      return readTasks();
    },
    detail: async () => { throw new Error("unused"); },
  };
  const app = createApp({
    emitAccessLog: () => {},
    todos,
    resolveAccessContext: async headers => contexts[headers.get("x-api-key") ?? ""] ?? null,
    meetings: { store, config: () => config, now: () => now, onChange: () => changes.push("kick"), ...input.options },
  });
  const availability = (query = "", key = bookingKey) =>
    app.request(`/api/v1/meetings/availability${query}`, { headers: { "X-API-Key": key } });
  const book = (body: unknown, idempotencyKey: string = crypto.randomUUID(), key = bookingKey) => app.request("/api/v1/meetings", {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const cancel = (token: string, key = bookingKey) => app.request("/api/v1/meetings/cancel", {
    method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ token }),
  });
  return { app, meetings, changes, availability, book, cancel, taskReads };
}
const guest = (start = first, email = "ada@example.com") => ({ start, name: "Ada Lovelace", email, note: "Website project" });

describe("meeting availability", () => {
  test("hides and rejects slots within 15 minutes of a task, allowing exactly 15 minutes", async () => {
    const { availability, book } = setup({ tasks: [{ start: "2026-11-17T13:45:00Z", end: "2026-11-17T14:15:00Z" }] });
    const after = "2026-11-17T14:30:00Z";
    const before = await availability("?from=2026-11-17T13:00:00Z&to=2026-11-17T15:00:00Z");
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(await before.json()).toEqual({ slots: [first, after] });
    expect((await book(guest(second))).status).toBe(409);
    expect((await book(guest("2026-11-17T14:00:00Z"))).status).toBe(409);
    expect((await book(guest(first))).status).toBe(201);
    expect((await book(guest(after))).status).toBe(201);
  });

  test("rejects non-overlapping calls with only ten minutes of clearance on either side", async () => {
    const after = "2026-11-17T14:30:00Z";
    const { availability, book } = setup({ tasks: [{ start: "2026-11-17T13:40:00Z", end: "2026-11-17T14:20:00Z" }] });
    const range = `?from=${first}&to=2026-11-17T15:00:00Z`;
    expect(await (await availability(range)).json()).toEqual({ slots: [] });
    expect((await book(guest(first))).status).toBe(409);
    expect((await book(guest(after))).status).toBe(409);
  });

  test("checks the full call even when the requested range ends just after its start", async () => {
    const event = bufferedEvent(Date.parse("2026-11-17T13:35:00Z"), Date.parse("2026-11-17T13:45:00Z"));
    const { availability, book } = setup({ calendar: [event] });
    const response = await availability(`?from=${first}&to=2026-11-17T13:01:00Z`);
    expect(await response.json()).toEqual({ slots: [] });
    expect((await book(guest(first))).status).toBe(409);
  });

  test("concurrent adjacent bookings keep the buffer, and cancellation releases it", async () => {
    const { availability, book, cancel, meetings } = setup();
    const results = await Promise.all([book(guest(first)), book(guest(second, "grace@example.com"))]);
    expect(results.map(response => response.status).sort()).toEqual([201, 409]);
    const range = `?from=${first}&to=2026-11-17T14:00:00Z`;
    expect(await (await availability(range)).json()).toEqual({ slots: [] });
    expect((await cancel(meetings[0]!.pendingCancelToken!)).status).toBe(200);
    expect(await (await availability(range)).json()).toEqual({ slots: [first, second] });
  });

  test("rejects malformed and oversized ranges", async () => {
    const { availability } = setup();
    expect((await availability("?from=tomorrow")).status).toBe(400);
    expect((await availability("?from=2026-11-18T00:00:00Z&to=2026-11-17T00:00:00Z")).status).toBe(400);
    expect((await availability("?from=2026-11-01T00:00:00Z&to=2026-12-15T00:00:00Z")).status).toBe(400);
  });

  test("lists from the task projection and rechecks current timings before booking", async () => {
    const tasks: Partial<Todo>[] = [];
    const { availability, book, meetings, taskReads } = setup({ tasks });
    const range = `?from=${first}&to=2026-11-17T13:01:00Z`;
    expect(await (await availability(range)).json()).toEqual({ slots: [first] });
    tasks.push({ start: "2026-11-17T13:44:00Z", end: "2026-11-17T14:00:00Z" });
    expect((await book(guest())).status).toBe(409);
    expect(meetings).toHaveLength(0);
    expect(taskReads).toEqual(["projection", "booking"]);
  });

  test("rejects availability and booking before reading tasks when booking email is unconfigured", async () => {
    const { availability, book, taskReads } = setup({ options: { config: () => null } });
    expect((await availability()).status).toBe(503);
    expect((await book(guest())).status).toBe(503);
    expect(taskReads).toHaveLength(0);
  });

  test("fails closed when the database-backed calendar cannot be read", async () => {
    const { availability, book, meetings } = setup({ calendarFail: true });
    expect((await availability()).status).toBe(503);
    expect((await book(guest())).status).toBe(503);
    expect(meetings).toHaveLength(0);
  });

  test("fails closed when task timing cannot be read", async () => {
    const { availability, book } = setup({ tasksFail: true });
    expect((await availability()).status).toBe(503);
    expect((await book(guest())).status).toBe(503);
  });
});

describe("booking-only token scope", () => {
  test("rejects missing, unknown and differently scoped keys before reading input", async () => {
    const { app, availability, book, cancel } = setup();
    expect((await app.request("/api/v1/meetings/availability")).status).toBe(401);
    expect((await availability("", "unknown-key")).status).toBe(401);
    const forbidden = await availability("", "todos-key");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ code: "FORBIDDEN", message: "Missing required permission." });
    expect((await book("not json", undefined, "todos-key")).status).toBe(403);
    expect((await cancel("x".repeat(43), "todos-key")).status).toBe(403);
  });

  test("the booking key reaches nothing outside the three booking routes", async () => {
    const { app } = setup();
    const headers = { "X-API-Key": bookingKey };
    expect((await app.request("/api/v1/todos", { headers })).status).toBe(403);
    expect((await app.request("/api/v1/inventory-items", { headers })).status).toBe(403);
    expect((await app.request("/api/v1/habits/day", { headers })).status).toBe(403);
  });
});

describe("booking", () => {
  test("confirms instantly with exactly id, start and end", async () => {
    const { book, meetings, changes } = setup();
    const response = await book(guest());
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["end", "id", "start"]);
    expect(body).toMatchObject({ start: first, end: "2026-11-17T13:30:00Z" });
    expect(changes).toEqual(["kick"]);
    expect(meetings[0]).toMatchObject({ guestEmail: "ada@example.com", status: "booked" });
    expect(meetings[0]!.jitsiRoom).toMatch(/^meet-[0-9a-f]{32}$/);
    expect(meetings[0]!.cancelTokenHash).toBe(hashCancelToken(meetings[0]!.pendingCancelToken!));
  });

  test("accepts an offset start for the same instant and normalizes guest email case", async () => {
    const { book, meetings } = setup();
    const response = await book({ ...guest("2026-11-17T09:00:00-04:00"), email: "Ada@Example.COM" });
    expect(response.status).toBe(201);
    expect((await response.json() as { start: string }).start).toBe(first);
    expect(meetings[0]!.guestEmail).toBe("ada@example.com");
  });

  test("returns 409 for a taken slot and for times that are not open slots", async () => {
    const { book } = setup({ tasks: [{ start: "2026-11-17T14:00:00Z", end: "2026-11-17T14:30:00Z" }] });
    expect((await book(guest())).status).toBe(201);
    const taken = await book(guest(first, "grace@example.com"));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual(slotUnavailable.body);
    const closed = ["2026-11-17T14:00:00Z", "2026-11-17T13:15:00Z", "2026-11-16T14:00:00Z", "2026-12-15T14:00:00Z", "2026-11-17T22:00:00Z"];
    for (const [index, start] of closed.entries()) {
      expect((await book(guest(start, `closed${index}@example.com`))).status).toBe(409);
    }
  });

  test("concurrent requests for one slot produce exactly one meeting", async () => {
    const { book, meetings } = setup();
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      book(guest(first, `guest${index}@example.com`), undefined, index % 2 ? "second-booking-key" : bookingKey)));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(meetings).toHaveLength(1);
  });

  test("replaying an Idempotency-Key returns the original result without a second meeting", async () => {
    const { book, meetings, changes } = setup();
    const key = "booking-retry-1";
    const [original, replay] = await Promise.all([book(guest(), key), book(guest(), key)]);
    expect(original.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await original.json());
    expect(meetings).toHaveLength(1);
    // The slot is now taken, yet a late retry still sees its own success.
    expect((await book(guest(), key)).status).toBe(201);
    const reused = await book(guest(second), key);
    expect(reused.status).toBe(409);
    expect((await reused.json() as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(meetings).toHaveLength(1);
    expect(changes.length).toBeGreaterThan(0);
  });

  test("validates input strictly and caps the body", async () => {
    const { app, book } = setup();
    const invalid = [
      { ...guest(), extra: true },
      { ...guest(), email: "not-an-email" },
      { ...guest(), name: "" },
      { ...guest(), name: "Ada\u0000" },
      { ...guest(), name: "x".repeat(101) },
      { ...guest(), note: "x".repeat(1001) },
      { ...guest(), start: "next tuesday" },
      { name: "Ada", email: "ada@example.com" },
    ];
    for (const body of invalid) expect((await book(body)).status).toBe(400);
    const missingKey = await app.request("/api/v1/meetings", {
      method: "POST", headers: { "X-API-Key": bookingKey, "Content-Type": "application/json" }, body: JSON.stringify(guest()),
    });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json() as { code: string }).code).toBe("INVALID_IDEMPOTENCY_KEY");
    const large = await book({ ...guest(), note: "x".repeat(5000) });
    expect(large.status).toBe(413);
    expect((await book({ ...guest(), note: "Line one\nLine two" })).status).toBe(201);
  });

  test("returns 503 while the email sender, Jitsi or portfolio origins are unconfigured", async () => {
    const { book } = setup({ options: { config: () => null } });
    expect((await book(guest())).status).toBe(503);
  });

  test("caps upcoming meetings per email", async () => {
    const { book } = setup();
    expect((await book(guest(first))).status).toBe(201);
    expect((await book(guest("2026-11-17T14:00:00Z"))).status).toBe(201);
    const capped = await book(guest("2026-11-17T15:00:00Z"));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual(meetingLimitReached.body);
  });
});

describe("rate limits", () => {
  test("limit every request per scoped token, with Retry-After", async () => {
    const { availability } = setup({ options: { limits: { perToken: { limit: 2, windowMs: 60_000 } } } });
    expect((await availability()).status).toBe(200);
    expect((await availability()).status).toBe(200);
    const limited = await availability();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await availability("", "second-booking-key")).status).toBe(200);
  });

  test("limit booking attempts per guest email across tokens and letter case", async () => {
    const { book } = setup({ options: { limits: { perEmail: { limit: 2, windowMs: 3_600_000 } } } });
    expect((await book(guest(first, "ada@example.com"))).status).toBe(201);
    expect((await book(guest(first, "ADA@example.com"), undefined, "second-booking-key")).status).toBe(409);
    const limited = await book(guest(second, "Ada@Example.com"));
    expect(limited.status).toBe(429);
    expect((await limited.json() as { code: string }).code).toBe("RATE_LIMITED");
    expect((await book(guest("2026-11-17T14:00:00Z", "grace@example.com"))).status).toBe(201);
  });

  test("limit booking attempts per token", async () => {
    const { book } = setup({ options: { limits: { bookingsPerToken: { limit: 1, windowMs: 3_600_000 } } } });
    expect((await book(guest(first, "a@example.com"))).status).toBe(201);
    const later = "2026-11-17T14:00:00Z";
    expect((await book(guest(later, "b@example.com"))).status).toBe(429);
    expect((await book(guest(later, "b@example.com"), undefined, "second-booking-key")).status).toBe(201);
  });
});

describe("cancel", () => {
  test("cancels by guest token, frees the slot and repeats safely", async () => {
    const { availability, book, cancel, meetings, changes } = setup();
    const booked = await (await book(guest())).json();
    const token = meetings[0]!.pendingCancelToken!;
    const cancelled = await cancel(token);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(booked);
    expect((await cancel(token)).status).toBe(200);
    expect(changes).toEqual(["kick", "kick", "kick"]);
    const slots = await (await availability("?from=2026-11-17T00:00:00Z&to=2026-11-17T14:00:00Z")).json();
    expect(slots).toEqual({ slots: [first, second] });
  });

  test("rejects unknown and malformed tokens", async () => {
    const { cancel } = setup();
    const unknown = await cancel("A".repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(meetingNotFound.body);
    expect((await cancel("short")).status).toBe(400);
  });
});
