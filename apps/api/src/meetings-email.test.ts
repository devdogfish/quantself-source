import { describe, expect, test } from "bun:test";
import { createMeetingEmailRuntime } from "./meetings-runtime";
import {
  createMeetingEmailWorker, deliveryLeaseMs, meetingEmailConfig, meetingIcs, reminderLeadMs,
  type MeetingEmail, type MeetingOutbox, type OutboxMeeting,
} from "./meetings-email";

const config = {
  from: "Owner Name <meetings@example.test>", ownerEmail: "owner@example.test",
  jitsiOrigin: "https://meet.example.test", portfolioOrigin: "https://portfolio.example.test", timeZone: "America/Halifax",
};
const token = "q0hS2k8m3v7Yt1cXbN5rP9wE4uA6zL2jD8fG0hK3mQ7";
const meeting = (fields: Partial<OutboxMeeting> = {}): OutboxMeeting => ({
  id: "6f1c2a9e-8b3d-4e5f-9a1b-2c3d4e5f6a7b",
  start: new Date("2026-11-17T13:00:00Z"),
  end: new Date("2026-11-17T13:30:00Z"),
  guestName: "Ada Lovelace, Countess",
  guestEmail: "ada@example.com",
  note: "Website project; budget TBD",
  jitsiRoom: "meet-0123456789abcdef0123456789abcdef",
  createdAt: new Date("2026-11-16T12:00:00Z"),
  pendingCancelToken: token,
  ...fields,
});

function memoryOutbox(rows: OutboxMeeting[], status: Record<string, "booked" | "cancelled"> = {}) {
  type Delivery = Awaited<ReturnType<MeetingOutbox["due"]>>[number];
  const key = ({ kind, recipient, meeting }: Delivery) => `${kind}:${recipient}:${meeting.id}`;
  const sent = new Set<string>();
  const leases = new Map<string, Date>();
  function eligible({ kind, meeting }: Delivery, now: Date) {
    const state = status[meeting.id] ?? "booked";
    if (kind === "cancellation") return state === "cancelled";
    if (state !== "booked" || meeting.start <= now) return false;
    return kind !== "reminder" || meeting.start.getTime() - now.getTime() <= reminderLeadMs;
  }
  function due(delivery: Delivery, now: Date) {
    const id = key(delivery);
    return eligible(delivery, now) && !sent.has(id) && (leases.get(id) ?? now) <= now;
  }
  const outbox: MeetingOutbox = {
    async due(now) {
      const kinds = ["confirmation", "reminder", "cancellation"] as const;
      const recipients = ["guest", "owner"] as const;
      return kinds.flatMap(kind => rows.flatMap(meeting => recipients
        .map(recipient => ({ kind, recipient, meeting }))
        .filter(delivery => due(delivery, now))));
    },
    async claim(delivery, now) {
      if (!due(delivery, now)) return null;
      const lease = new Date(now.getTime() + deliveryLeaseMs);
      leases.set(key(delivery), lease);
      return lease;
    },
    async sent(delivery, lease) {
      if (leases.get(key(delivery)) !== lease) return;
      sent.add(key(delivery));
      leases.delete(key(delivery));
      if (delivery.kind === "confirmation" && delivery.recipient === "guest") delivery.meeting.pendingCancelToken = null;
    },
  };
  return { outbox, sent };
}

describe("ics", () => {
  test("describes the 30-minute call with the Jitsi room and escapes guest text", () => {
    const ics = meetingIcs({ meeting: meeting(), config, method: "REQUEST", now: new Date("2026-11-16T12:00:00Z") });
    expect(ics.endsWith("\r\n")).toBe(true);
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("METHOD:REQUEST");
    expect(unfolded).toContain("UID:6f1c2a9e-8b3d-4e5f-9a1b-2c3d4e5f6a7b@quantself");
    expect(unfolded).toContain("DTSTART:20261117T130000Z");
    expect(unfolded).toContain("DTEND:20261117T133000Z");
    expect(unfolded).toContain("SUMMARY:Call with Ada Lovelace\\, Countess");
    expect(unfolded).toContain("LOCATION:https://meet.example.test/meet-0123456789abcdef0123456789abcdef");
    expect(unfolded).toContain("Website project\\; budget TBD");
    expect(unfolded).toContain("ORGANIZER:mailto:meetings@example.test");
    expect(unfolded).toContain('ATTENDEE;CN="Ada Lovelace, Countess";ROLE=REQ-PARTICIPANT:mailto:ada@example.com');
    const withCr = meetingIcs({ meeting: meeting({ note: "First\rSecond" }), config, method: "REQUEST", now: new Date() });
    expect(withCr.replace(/\r\n /g, "")).toContain("First\\nSecond");
    expect(ics.split("\r\n").every(line => Buffer.byteLength(line) <= 75)).toBe(true);
    const cancel = meetingIcs({ meeting: meeting(), config, method: "CANCEL", now: new Date() });
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("STATUS:CANCELLED");
    expect(cancel).toContain("SEQUENCE:1");
  });
});

describe("config", () => {
  test("requires the sender and https origins", () => {
    const env = {
      QUANTSELF_MEETINGS_FROM: config.from,
      QUANTSELF_OWNER_EMAIL: config.ownerEmail,
      QUANTSELF_MEETINGS_JITSI_ORIGIN: "https://meet.example.test/",
      QUANTSELF_MEETINGS_PORTFOLIO_ORIGIN: "https://portfolio.example.test",
    };
    expect(meetingEmailConfig(env)).toMatchObject({ jitsiOrigin: "https://meet.example.test", ownerEmail: config.ownerEmail });
    expect(meetingEmailConfig({ ...env, QUANTSELF_MEETINGS_FROM: "" })).toBeNull();
    expect(meetingEmailConfig({ ...env, QUANTSELF_OWNER_EMAIL: "" })).toBeNull();
    expect(meetingEmailConfig({ ...env, QUANTSELF_MEETINGS_TIME_ZONE: "Invalid/Zone" })).toBeNull();
    expect(meetingEmailConfig({ ...env, QUANTSELF_MEETINGS_JITSI_ORIGIN: "http://meet.example.test" })).toBeNull();
    expect(meetingEmailConfig({ ...env, QUANTSELF_MEETINGS_PORTFOLIO_ORIGIN: undefined })).toBeNull();
  });
});

describe("email worker", () => {
  test("keeps mail delivery out of the serve-only API", () => {
    const env = {
      QUANTSELF_MEETINGS_FROM: config.from,
      QUANTSELF_MEETINGS_OWNER_EMAIL: config.ownerEmail,
      QUANTSELF_MEETINGS_JITSI_ORIGIN: config.jitsiOrigin,
      QUANTSELF_MEETINGS_PORTFOLIO_ORIGIN: config.portfolioOrigin,
    };
    expect(createMeetingEmailRuntime({ ...env, QUANTSELF_API_MODE: "serve" })).toBeNull();
    expect(createMeetingEmailRuntime({ ...env, QUANTSELF_API_MODE: "workers" })).not.toBeNull();
    expect(createMeetingEmailRuntime(env)).not.toBeNull();
  });
  test("sends the guest confirmation with the cancel link, then the Owner copy, exactly once", async () => {
    const rows = [meeting()];
    const { outbox } = memoryOutbox(rows);
    const sent: MeetingEmail[] = [];
    const worker = createMeetingEmailWorker({ outbox, mailer: { send: async email => { sent.push(email); } }, config, now: () => new Date("2026-11-16T12:00:05Z") });
    await Promise.all([worker.runOnce(), worker.runOnce()]);
    await worker.runOnce();
    expect(sent.map(email => [email.to, email.subject, email.calendar?.method])).toEqual([
      ["ada@example.com", "Your call is booked", "REQUEST"],
      ["owner@example.test", "New call booked: Ada Lovelace, Countess", "REQUEST"],
    ]);
    expect(sent[0]!.text).toContain(`https://portfolio.example.test/book/cancel/${token}`);
    expect(sent[0]!.text).toContain("https://meet.example.test/meet-0123456789abcdef0123456789abcdef");
    expect(sent[0]!.text).toContain("Tuesday, November 17, 2026");
    expect(sent[0]!.text).toEndWith("\n\nBest,\nLuigi Girke\n");
    expect(sent[0]!.html).toContain('href="https://meet.example.test/meet-0123456789abcdef0123456789abcdef">Join video call</a>');
    expect(sent[0]!.html).toEndWith("<p>Best,<br>Luigi Girke</p>");
    expect(sent[1]!.text).toEndWith("Note:\nWebsite project; budget TBD\n\nBest,\nLuigi Girke\n");
    expect(sent[1]!.text).not.toContain(token);
    expect(sent[0]!.calendar?.content).not.toContain(config.ownerEmail);
    expect(sent[1]!.calendar?.content).toContain(config.ownerEmail);
    expect(rows[0]!.pendingCancelToken).toBeNull();
  });

  test("retries only the failed recipient after the lease expires", async () => {
    const { outbox } = memoryOutbox([meeting()]);
    let failOwner = true;
    let clock = Date.parse("2026-11-16T12:00:05Z");
    const sent: MeetingEmail[] = [];
    const worker = createMeetingEmailWorker({
      outbox, config, now: () => new Date(clock), log: () => {},
      mailer: { async send(email) {
        if (failOwner && email.to === config.ownerEmail) throw new Error("throttled");
        sent.push(email);
      } },
    });
    await worker.runOnce();
    expect(sent.map(email => email.to)).toEqual(["ada@example.com"]);
    expect(sent[0]!.text).toContain(token);
    failOwner = false;
    await worker.runOnce();
    expect(sent).toHaveLength(1);
    clock += deliveryLeaseMs;
    await worker.runOnce();
    expect(sent.map(email => email.to)).toEqual(["ada@example.com", config.ownerEmail]);
  });

  test("recovers a dead worker's guest claim and preserves the token until delivery", async () => {
    const row = meeting();
    const { outbox } = memoryOutbox([row]);
    let clock = Date.parse("2026-11-16T12:00:05Z");
    const [guest] = await outbox.due(new Date(clock));
    expect(await outbox.claim(guest!, new Date(clock))).not.toBeNull();
    const sent: MeetingEmail[] = [];
    const worker = createMeetingEmailWorker({
      outbox, config, now: () => new Date(clock),
      mailer: { send: async email => { sent.push(email); } },
    });
    await worker.runOnce();
    expect(sent.map(email => email.to)).toEqual([config.ownerEmail]);
    expect(row.pendingCancelToken).toBe(token);
    clock += deliveryLeaseMs;
    await worker.runOnce();
    expect(sent.map(email => email.to)).toEqual([config.ownerEmail, "ada@example.com"]);
    expect(sent[1]!.text).toContain(token);
    expect(row.pendingCancelToken).toBeNull();
  });

  test("waits for active delivery at shutdown and leaves remaining mail pending", async () => {
    const { outbox, sent } = memoryOutbox([meeting()]);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const worker = createMeetingEmailWorker({
      outbox, config, now: () => new Date("2026-11-16T12:00:05Z"),
      mailer: { async send() { entered.resolve(); await resume.promise; } },
    });
    const run = worker.runOnce();
    await entered.promise;
    const stop = worker.stop();
    expect(sent.size).toBe(0);
    resume.resolve();
    await Promise.all([run, stop]);
    expect(sent.size).toBe(1);
  });

  test("sends a reminder one hour before and a cancellation notice", async () => {
    const rows = [meeting({ pendingCancelToken: null }), meeting({ id: "cancelled-1", pendingCancelToken: null })];
    const { outbox, sent: claims } = memoryOutbox(rows, { "cancelled-1": "cancelled" });
    claims.add(`confirmation:guest:${rows[0]!.id}`);
    claims.add(`confirmation:owner:${rows[0]!.id}`);
    const sent: MeetingEmail[] = [];
    let clock = new Date("2026-11-17T11:30:00Z");
    const worker = createMeetingEmailWorker({ outbox, config, now: () => clock, mailer: { send: async email => { sent.push(email); } } });
    await worker.runOnce();
    expect(sent.map(email => email.subject)).toEqual(["Your call was cancelled", "Call cancelled: Ada Lovelace, Countess"]);
    expect(sent[0]!.calendar?.method).toBe("CANCEL");
    expect(sent[0]!.text).toEndWith("\n\nBest,\nLuigi Girke\n");
    sent.length = 0;
    clock = new Date("2026-11-17T12:00:00Z");
    await worker.runOnce();
    expect(sent.map(email => email.subject)).toEqual(["Your call starts in one hour", "Call in one hour: Ada Lovelace, Countess"]);
    expect(sent[0]!.text).toEndWith("\n\nBest,\nLuigi Girke\n");
    expect(sent[0]!.html).toContain(">Join video call</a>");
    sent.length = 0;
    await worker.runOnce();
    expect(sent).toEqual([]);
  });

  test("skips the reminder for a meeting booked inside the reminder window", async () => {
    const rows = [meeting({ createdAt: new Date("2026-11-17T12:30:00Z"), pendingCancelToken: null })];
    const { outbox, sent: claims } = memoryOutbox(rows);
    claims.add(`confirmation:guest:${rows[0]!.id}`);
    claims.add(`confirmation:owner:${rows[0]!.id}`);
    const sent: MeetingEmail[] = [];
    const worker = createMeetingEmailWorker({ outbox, config, now: () => new Date("2026-11-17T12:31:00Z"), mailer: { send: async email => { sent.push(email); } } });
    await worker.runOnce();
    expect(sent).toEqual([]);
    expect(claims.has(`reminder:guest:${rows[0]!.id}`)).toBe(true);
    expect(claims.has(`reminder:owner:${rows[0]!.id}`)).toBe(true);
  });
});
