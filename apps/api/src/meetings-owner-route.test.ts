import { describe, expect, test } from "bun:test";
import type { AccessContext } from "@quantself/auth";
import { createApp } from "./app";
import { defaultMeetingSettings, type MeetingSettingsValue } from "./meetings-availability";
import type { OwnerMeeting, OwnerMeetingStore } from "./meetings-owner-store";
import { meetingNotFound, meetingStarted, receipt } from "./meetings-store";
import type { TodoReader } from "./todos-github";

const owner = { id: "owner-1", name: "Owner", email: "owner@example.test" };
const web = { id: "quantself-web", kind: "web", name: "Quantself Web Client" } as const;
const contexts: Record<string, AccessContext> = {
  owner: { owner, client: web, permissions: ["meetings:read", "meetings:write"] },
  reader: { owner, client: web, permissions: ["meetings:read"] },
  booking: { owner, client: { id: "portfolio", kind: "api-key", name: "Portfolio" }, permissions: ["meetings:book"] },
};
const now = Date.parse("2026-11-16T12:00:00Z");
const meeting = (id: string, start: string, extra: Partial<OwnerMeeting & { status: "booked" | "cancelled" }> = {}): OwnerMeeting & { ownerId: string; status: "booked" | "cancelled" } => ({
  id, ownerId: owner.id, status: "booked", start: new Date(start), end: new Date(Date.parse(start) + 1_800_000),
  guestName: "Ada Lovelace", guestEmail: "ada@example.com", note: "Website project", jitsiRoom: `meet-${id.slice(0, 4)}`, ...extra,
});

function setup(jitsiOrigin: string | null = "https://meet.example.test") {
  const rows = [
    meeting("11111111-1111-4111-8111-111111111111", "2026-11-17T13:00:00Z"),
    meeting("22222222-2222-4222-8222-222222222222", "2026-11-18T13:00:00Z", { note: null }),
    meeting("33333333-3333-4333-8333-333333333333", "2026-11-16T11:00:00Z"),
    meeting("44444444-4444-4444-8444-444444444444", "2026-11-17T15:00:00Z", { status: "cancelled" }),
  ];
  let settings: MeetingSettingsValue = defaultMeetingSettings;
  const calls: string[] = [];
  const store: OwnerMeetingStore = {
    settings: async () => settings,
    saveSettings: async (_, value) => (settings = value),
    booked: async (ownerId, from, to) => {
      calls.push("booked");
      return rows.filter(row => row.ownerId === ownerId && row.status === "booked" && row.start < to && row.end > from);
    },
    cancel: async ({ ownerId, id, now }) => {
      const row = rows.find(candidate => candidate.id === id && candidate.ownerId === ownerId);
      if (!row) return meetingNotFound;
      if (row.status === "booked" && row.start <= now) return meetingStarted;
      row.status = "cancelled";
      return { status: 200, body: receipt(row) };
    },
  };
  const changes: string[] = [];
  const todos = { list: async () => [], detail: async () => { throw new Error("unused"); } } as unknown as TodoReader;
  const app = createApp({
    emitAccessLog: () => {},
    todos,
    resolveAccessContext: async headers => contexts[headers.get("x-api-key") ?? ""] ?? null,
    ownerMeetings: { store, now: () => now, jitsiOrigin: () => jitsiOrigin, onChange: () => changes.push("kick") },
  });
  const request = (path: string, key = "owner", init: RequestInit = {}) =>
    app.request(`/api/v1/meetings${path}`, { ...init, headers: { "X-API-Key": key, "Content-Type": "application/json", ...init.headers } });
  return { request, rows, changes, calls };
}

describe("Owner meetings", () => {
  test("lists booked meetings in a range with guest details and the room link in one store read", async () => {
    const { request, calls } = setup();
    const response = await request("/booked?from=2026-11-17T00:00:00Z&to=2026-11-19T00:00:00Z");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ meetings: [
      { id: "11111111-1111-4111-8111-111111111111", start: "2026-11-17T13:00:00Z", end: "2026-11-17T13:30:00Z", guestName: "Ada Lovelace", guestEmail: "ada@example.com", note: "Website project", jitsiUrl: "https://meet.example.test/meet-1111" },
      { id: "22222222-2222-4222-8222-222222222222", start: "2026-11-18T13:00:00Z", end: "2026-11-18T13:30:00Z", guestName: "Ada Lovelace", guestEmail: "ada@example.com", note: null, jitsiUrl: "https://meet.example.test/meet-2222" },
    ] });
    expect(calls).toEqual(["booked"]);
  });

  test("returns a null room link until the Jitsi origin is configured", async () => {
    const { request } = setup(null);
    const body = await (await request("/booked?from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z")).json() as { meetings: { jitsiUrl: string | null }[] };
    expect(body.meetings.map(row => row.jitsiUrl)).toEqual([null]);
  });

  test("rejects missing, inverted and oversized ranges", async () => {
    const { request } = setup();
    expect((await request("/booked")).status).toBe(400);
    expect((await request("/booked?from=2026-11-18T00:00:00Z&to=2026-11-17T00:00:00Z")).status).toBe(400);
    expect((await request("/booked?from=2026-11-01T00:00:00Z&to=2027-01-05T00:00:00Z")).status).toBe(400);
  });

  test("needs meetings:read and :write; the booking key cannot see guest details", async () => {
    const { request } = setup();
    expect((await request("/booked?from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z", "booking")).status).toBe(403);
    expect((await request("/settings", "booking")).status).toBe(403);
    expect((await request("/booked?from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z", "nobody")).status).toBe(401);
    expect((await request("/11111111-1111-4111-8111-111111111111/cancel", "reader", { method: "POST" })).status).toBe(403);
    expect((await request("/settings", "reader", { method: "PUT", body: JSON.stringify(defaultMeetingSettings) })).status).toBe(403);
  });

  test("cancels by id, kicks the cancellation email and repeats safely", async () => {
    const { request, rows, changes } = setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const first = await request(`/${id}/cancel`, "owner", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id, start: "2026-11-17T13:00:00Z", end: "2026-11-17T13:30:00Z" });
    expect(rows[0]!.status).toBe("cancelled");
    expect(changes).toEqual(["kick"]);
    expect((await request(`/${id}/cancel`, "owner", { method: "POST" })).status).toBe(200);
    expect((await request("/33333333-3333-4333-8333-333333333333/cancel", "owner", { method: "POST" })).status).toBe(409);
    expect((await request("/99999999-9999-4999-8999-999999999999/cancel", "owner", { method: "POST" })).status).toBe(404);
    expect((await request("/not-a-uuid/cancel", "owner", { method: "POST" })).status).toBe(400);
  });

  test("reads defaults and replaces settings after strict validation", async () => {
    const { request } = setup();
    expect(await (await request("/settings")).json()).toEqual(defaultMeetingSettings);
    const next = { timeZone: "Europe/Berlin", weeklyHours: { tue: [["10:00", "12:30"]] }, noticeMinutes: 60, horizonDays: 30 };
    const saved = await request("/settings", "owner", { method: "PUT", body: JSON.stringify(next) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(next);
    expect(await (await request("/settings")).json()).toEqual(next);
    for (const invalid of [
      { ...next, timeZone: "Mars/Olympus" },
      { ...next, weeklyHours: { tue: [["10:15", "12:00"]] } },
      { ...next, weeklyHours: { tue: [["12:00", "10:00"]] } },
      { ...next, horizonDays: 0 },
      { ...next, extra: true },
    ]) {
      expect((await request("/settings", "owner", { method: "PUT", body: JSON.stringify(invalid) })).status).toBe(400);
    }
  });
});
