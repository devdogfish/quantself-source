import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { prisma } from "@quantself/db";
import { z } from "zod";

export type MeetingEmailKind = "confirmation" | "reminder" | "cancellation";
type MeetingEmailRecipient = "guest" | "owner";
const emailAddress = z.email();
export type OutboxMeeting = {
  id: string;
  start: Date;
  end: Date;
  guestName: string;
  guestEmail: string;
  note: string | null;
  jitsiRoom: string;
  createdAt: Date;
  /** Present only until the guest confirmation is sent. */
  pendingCancelToken: string | null;
};
export type MeetingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  calendar?: { method: "REQUEST" | "CANCEL"; content: string };
};
export type MeetingMailer = { send(email: MeetingEmail): Promise<void> };
export type MeetingEmailConfig = {
  /** RFC 5322 From on the Owner's SES-verified domain, e.g. `Name <meetings@example.com>`. */
  from: string;
  ownerEmail: string;
  /** Public Jitsi origin on the Funnel link (ADR 0045). */
  jitsiOrigin: string;
  /** Portfolio origin that serves `/book/cancel/<token>`. */
  portfolioOrigin: string;
  timeZone: string;
};

export function meetingEmailConfig(env: Record<string, string | undefined> = process.env): MeetingEmailConfig | null {
  const from = env.QUANTSELF_MEETINGS_FROM?.trim();
  const jitsiOrigin = httpsOrigin(env.QUANTSELF_MEETINGS_JITSI_ORIGIN);
  const portfolioOrigin = httpsOrigin(env.QUANTSELF_MEETINGS_PORTFOLIO_ORIGIN);
  const ownerEmail = env.QUANTSELF_MEETINGS_OWNER_EMAIL?.trim() || env.QUANTSELF_OWNER_EMAIL?.trim();
  const timeZone = env.QUANTSELF_MEETINGS_TIME_ZONE?.trim() || "America/Halifax";
  if (!from || /[\r\n]/.test(from) || !emailAddress.safeParse(mailto(from)).success ||
    !ownerEmail || !emailAddress.safeParse(ownerEmail).success || !jitsiOrigin || !portfolioOrigin) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return null;
  }
  return {
    from,
    ownerEmail,
    jitsiOrigin,
    portfolioOrigin,
    timeZone,
  };
}

/** The public Jitsi origin alone, so the Owner can open rooms even before SES is configured. */
export function meetingJitsiOrigin(env: Record<string, string | undefined> = process.env) {
  return httpsOrigin(env.QUANTSELF_MEETINGS_JITSI_ORIGIN);
}

function httpsOrigin(value: string | undefined) {
  const url = value ? URL.parse(value.trim()) : null;
  return url && url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
}

export const jitsiUrl = (config: Pick<MeetingEmailConfig, "jitsiOrigin">, room: string) => `${config.jitsiOrigin}/${room}`;
export const cancelUrl = (config: Pick<MeetingEmailConfig, "portfolioOrigin">, token: string) =>
  `${config.portfolioOrigin}/book/cancel/${token}`;

// RFC 5545 text escaping and 75-octet line folding.
function icsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|[\r\n]/g, "\\n");
}
// RFC 6868 parameter escaping; the quotes safely contain delimiters in names.
function icsParam(value: string) {
  return value.replace(/\^/g, "^^").replace(/"/g, "^'").replace(/\r\n|[\r\n]/g, "^n");
}
function fold(line: string) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const char of line) {
    const limit = parts.length ? 74 : 75;
    if (Buffer.byteLength(current + char, "utf8") > limit) { parts.push(current); current = ""; }
    current += char;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
const icsTime = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function mailto(address: string) {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1]! : address).trim();
}

export function meetingIcs(input: {
  meeting: OutboxMeeting;
  config: MeetingEmailConfig;
  method: "REQUEST" | "CANCEL";
  recipient?: MeetingEmailRecipient;
  now: Date;
}) {
  const { meeting, config, method } = input;
  const room = jitsiUrl(config, meeting.jitsiRoom);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Quantself//Meetings//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${meeting.id}@quantself`,
    `SEQUENCE:${method === "CANCEL" ? 1 : 0}`,
    `DTSTAMP:${icsTime(input.now)}`,
    `DTSTART:${icsTime(meeting.start)}`,
    `DTEND:${icsTime(meeting.end)}`,
    `SUMMARY:${icsText(`Call with ${meeting.guestName}`)}`,
    `DESCRIPTION:${icsText(`Join: ${room}${meeting.note ? `\n\n${meeting.note}` : ""}`)}`,
    `LOCATION:${icsText(room)}`,
    `URL:${room}`,
    `ORGANIZER:mailto:${mailto(config.from)}`,
    `ATTENDEE;CN="${icsParam(meeting.guestName)}";ROLE=REQ-PARTICIPANT:mailto:${meeting.guestEmail}`,
    ...(input.recipient === "owner" && config.ownerEmail !== meeting.guestEmail && config.ownerEmail !== mailto(config.from)
      ? [`ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${config.ownerEmail}`]
      : []),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

function when(meeting: OutboxMeeting, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(meeting.start);
}

function meetingEmail(input: {
  kind: MeetingEmailKind;
  recipient: MeetingEmailRecipient;
  meeting: OutboxMeeting;
  config: MeetingEmailConfig;
  now: Date;
}): MeetingEmail {
  const { kind, recipient, meeting, config } = input;
  const room = jitsiUrl(config, meeting.jitsiRoom);
  const at = when(meeting, config.timeZone);
  const signOff = "\n\nBest,\nLuigi Girke\n";
  const method = kind === "confirmation" ? "REQUEST" : "CANCEL";
  const calendar: MeetingEmail["calendar"] = kind === "reminder" ? undefined : { method, content: meetingIcs({ ...input, method }) };
  if (recipient === "owner") {
    const subject = {
      confirmation: "New call booked",
      reminder: "Call in one hour",
      cancellation: "Call cancelled",
    }[kind];
    const note = meeting.note ? `\n\nNote:\n${meeting.note}` : "";
    const closing = kind === "confirmation" ? signOff : "\n";
    return {
      to: config.ownerEmail,
      subject: `${subject}: ${meeting.guestName}`,
      text: `${meeting.guestName} <${meeting.guestEmail}>\n${at}\n${room}${note}${closing}`,
      calendar,
    };
  }

  const greeting = `Hi ${meeting.guestName},\n\n`;
  const htmlGreeting = `<p>Hi ${Bun.escapeHTML(meeting.guestName)},</p>`;
  const htmlSignOff = "<p>Best,<br>Luigi Girke</p>";
  const joinLink = `<p><a href="${Bun.escapeHTML(room)}">Join video call</a></p>`;
  if (kind === "confirmation") {
    const token = meeting.pendingCancelToken;
    const cancel = token ? cancelUrl(config, token) : null;
    const reschedule = "To reschedule, cancel and book a new time.";
    const cancelLine = cancel ? `\n\nNeed to cancel? ${cancel}\n${reschedule}` : "";
    const cancelLink = cancel ? `<p><a href="${Bun.escapeHTML(cancel)}">Cancel your call</a><br>${reschedule}</p>` : "";
    const message = `Your 30-minute call is confirmed for ${at}.`;
    return {
      to: meeting.guestEmail,
      subject: "Your call is booked",
      text: `${greeting}${message}\n\nJoin video call: ${room}${cancelLine}${signOff}`,
      html: `${htmlGreeting}<p>${Bun.escapeHTML(message)}</p>${joinLink}${cancelLink}${htmlSignOff}`,
      calendar,
    };
  }
  if (kind === "reminder") {
    const message = `Reminder: your 30-minute call starts at ${at}.`;
    return {
      to: meeting.guestEmail,
      subject: "Your call starts in one hour",
      text: `${greeting}${message}\n\nJoin video call: ${room}${signOff}`,
      html: `${htmlGreeting}<p>${Bun.escapeHTML(message)}</p>${joinLink}${htmlSignOff}`,
    };
  }
  return {
    to: meeting.guestEmail,
    subject: "Your call was cancelled",
    text: `${greeting}Your call on ${at} was cancelled.${signOff}`,
    calendar,
  };
}

/** SES API sender on the Owner's domain (ADR 0040). Use an identity with engagement tracking disabled. */
export function sesMeetingMailer(config: Pick<MeetingEmailConfig, "from">, region = process.env.QUANTSELF_MEETINGS_SES_REGION ?? "ca-central-1"): MeetingMailer {
  const client = new SESv2Client({ region, maxAttempts: 2 });
  return {
    async send(email) {
      await client.send(new SendEmailCommand({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [email.to] },
        Content: { Simple: {
          Subject: { Charset: "UTF-8", Data: email.subject },
          Body: {
            Text: { Charset: "UTF-8", Data: email.text },
            ...(email.html ? { Html: { Charset: "UTF-8", Data: email.html } } : {}),
          },
          ...(email.calendar ? { Attachments: [{
            FileName: email.calendar.method === "CANCEL" ? "cancel.ics" : "invite.ics",
            ContentType: `text/calendar; method=${email.calendar.method}; charset=UTF-8`,
            ContentDisposition: "ATTACHMENT",
            ContentTransferEncoding: "BASE64",
            RawContent: Buffer.from(email.calendar.content, "utf8"),
          }] } : {}),
        } },
      }), { abortSignal: AbortSignal.timeout(30_000) });
    },
  };
}

type Delivery = { kind: MeetingEmailKind; recipient: MeetingEmailRecipient; meeting: OutboxMeeting };

export type MeetingOutbox = {
  due(now: Date): Promise<Delivery[]>;
  claim(delivery: Delivery, now: Date): Promise<Date | null>;
  sent(delivery: Delivery, lease: Date, now: Date): Promise<void>;
};

const deliveryFields = {
  confirmation: {
    guest: { sent: "confirmationSentAt", lease: "confirmationLeaseUntil" },
    owner: { sent: "ownerConfirmationSentAt", lease: "ownerConfirmationLeaseUntil" },
  },
  reminder: {
    guest: { sent: "reminderSentAt", lease: "reminderLeaseUntil" },
    owner: { sent: "ownerReminderSentAt", lease: "ownerReminderLeaseUntil" },
  },
  cancellation: {
    guest: { sent: "cancellationSentAt", lease: "cancellationLeaseUntil" },
    owner: { sent: "ownerCancellationSentAt", lease: "ownerCancellationLeaseUntil" },
  },
} as const;
const kinds = ["confirmation", "reminder", "cancellation"] as const;
const recipients = ["guest", "owner"] as const;
const outboxSelect = {
  id: true, start: true, end: true, guestName: true, guestEmail: true, note: true, jitsiRoom: true, createdAt: true, pendingCancelToken: true,
  confirmationSentAt: true, confirmationLeaseUntil: true,
  ownerConfirmationSentAt: true, ownerConfirmationLeaseUntil: true,
  reminderSentAt: true, reminderLeaseUntil: true,
  ownerReminderSentAt: true, ownerReminderLeaseUntil: true,
  cancellationSentAt: true, cancellationLeaseUntil: true,
  ownerCancellationSentAt: true, ownerCancellationLeaseUntil: true,
} as const;
export const reminderLeadMs = 60 * 60_000;
// Longer than the SES request timeout. Expired leases let another worker retry interrupted sends.
export const deliveryLeaseMs = 60_000;

function meetingDue(kind: MeetingEmailKind, now: Date): Prisma.MeetingWhereInput {
  return {
    status: kind === "cancellation" ? "cancelled" : "booked",
    ...(kind === "cancellation" ? {} : {
      start: { gt: now, ...(kind === "reminder" ? { lte: new Date(now.getTime() + reminderLeadMs) } : {}) },
    }),
  };
}

function recipientDue(kind: MeetingEmailKind, recipient: MeetingEmailRecipient, now: Date): Prisma.MeetingWhereInput {
  const fields = deliveryFields[kind][recipient];
  return {
    [fields.sent]: null,
    OR: [{ [fields.lease]: null }, { [fields.lease]: { lte: now } }],
  };
}

export function prismaMeetingOutbox(db: PrismaClient = prisma): MeetingOutbox {
  return {
    async due(now) {
      const batches = await Promise.all(kinds.map(async kind => {
        const meetings = await db.meeting.findMany({
          where: { ...meetingDue(kind, now), OR: recipients.map(recipient => recipientDue(kind, recipient, now)) },
          orderBy: { start: "asc" },
          select: outboxSelect,
          take: 25,
        });
        return meetings.flatMap(meeting => recipients.flatMap(recipient => {
          const fields = deliveryFields[kind][recipient];
          const lease = meeting[fields.lease];
          return !meeting[fields.sent] && (!lease || lease <= now) ? [{ kind, recipient, meeting }] : [];
        }));
      }));
      return batches.flat();
    },
    async claim({ kind, recipient, meeting }, now) {
      const fields = deliveryFields[kind][recipient];
      const lease = new Date(now.getTime() + deliveryLeaseMs);
      const result = await db.meeting.updateMany({
        where: { id: meeting.id, ...meetingDue(kind, now), ...recipientDue(kind, recipient, now) },
        data: { [fields.lease]: lease },
      });
      return result.count === 1 ? lease : null;
    },
    async sent({ kind, recipient, meeting }, lease, now) {
      const fields = deliveryFields[kind][recipient];
      await db.meeting.updateMany({
        where: { id: meeting.id, [fields.lease]: lease, [fields.sent]: null },
        data: {
          [fields.sent]: now,
          [fields.lease]: null,
          ...(kind === "confirmation" && recipient === "guest" ? { pendingCancelToken: null } : {}),
        },
      });
    },
  };
}

export function createMeetingEmailWorker(input: {
  outbox: MeetingOutbox;
  mailer: MeetingMailer;
  config: MeetingEmailConfig;
  now?: () => Date;
  intervalMs?: number;
  log?: (message: string) => void;
}) {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (message => console.warn(message));
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let again = false;

  async function deliver(delivery: Delivery) {
    const { kind, meeting, recipient } = delivery;
    const at = now();
    const lease = await input.outbox.claim(delivery, at);
    if (!lease) return;

    try {
      // A confirmation already covers a meeting booked inside the reminder window.
      if (kind !== "reminder" || meeting.createdAt.getTime() <= meeting.start.getTime() - reminderLeadMs) {
        const email = meetingEmail({ kind, recipient, meeting, config: input.config, now: at });
        await input.mailer.send(email);
      }
      // SES and PostgreSQL cannot commit together. A crash after acceptance can produce a retry.
      await input.outbox.sent(delivery, lease, now());
    } catch (error) {
      log(`Meeting ${kind} ${recipient} email for ${meeting.id} failed; will retry: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  function runOnce(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (running) { again = true; return running; }
    return running = (async () => {
      try {
        do {
          again = false;
          for (const delivery of await input.outbox.due(now())) {
            if (stopping) return;
            await deliver(delivery);
          }
        } while (again && !stopping);
      } finally {
        running = undefined;
      }
    })();
  }

  function kick() {
    void runOnce().catch(error => log(`Meeting email run failed: ${error instanceof Error ? error.name : "error"}`));
  }

  return {
    runOnce,
    kick,
    start() {
      timer ??= setInterval(kick, input.intervalMs ?? 30_000);
      kick();
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await running?.catch(() => {});
    },
  };
}
