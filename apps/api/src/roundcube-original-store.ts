import type { AccessContext } from "@quantself/auth";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import {
  createRoundcubeOriginalLookup, isLookupMessageId, isRoundcubeLookupIdentity, type RoundcubeLookupIdentity, type RoundcubeMailbox,
} from "./roundcube-original-association";

type Lookup = ReturnType<typeof createRoundcubeOriginalLookup>;
type Application = Parameters<Lookup>[0];
type StoreDb = Pick<PrismaClient, "$queryRaw" | "$transaction">;
type QueryDb = Pick<Prisma.TransactionClient, "$queryRaw">;
type Confirmation = { revision: number; message: RoundcubeLookupIdentity };
type StoredEvent = { eventId: string | null; eventKey: string | null; message: unknown };
type ReplySummary = { id: string; confirmedAt: string };
type Association =
  | { kind: "missing" | "invalid" | "empty" }
  | { kind: "confirmed"; eventId: string; message: RoundcubeLookupIdentity };
type Head =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "empty"; revision: 0 }
  | ({ kind: "confirmed"; eventId: string } & Confirmation);
type SaveResult =
  | { kind: "saved"; revision: number }
  | { kind: "denied" | "missing" | "conflict" | "unverifiable" };

const eventKind = "roundcube_original_confirmed";
const keyPrefix = "roundcube-original:";
const eventKey = (revision: number) => keyPrefix + revision.toString().padStart(10, "0");
const maxRevision = 2_147_483_647;
const replyKind = "roundcube_reply_confirmed";
const replyPrefix = "roundcube-reply:";
const replyPageSize = 20;

function replyKey({ account, folder, messageId }: Pick<RoundcubeLookupIdentity, "account" | "folder" | "messageId">) {
  // A different UID or epoch for a known Message-ID requires a separate, explicit rebind flow.
  return replyPrefix + createHash("sha256").update(JSON.stringify([account, folder, messageId])).digest("hex");
}

const latestLegacy = Prisma.sql`
  SELECT id, "eventKey", payload
  FROM job_event
  WHERE "ownerId" = a."ownerId" AND "applicationId" = a.id AND kind = ${eventKind}
    AND "eventKey" BETWEEN ${eventKey(1)} AND ${eventKey(maxRevision)}
  ORDER BY "eventKey" DESC LIMIT 1
`;

function replyPageQuery(account: string, before?: string) {
  const matches = Prisma.sql`
    "ownerId" = a."ownerId" AND "applicationId" = a.id AND kind = ${replyKind}
    AND "eventKey" BETWEEN ${replyPrefix + "0".repeat(64)} AND ${replyPrefix + "f".repeat(64)}
    AND payload->>'account' = ${account}
  `;
  const cursor = before === undefined ? Prisma.empty : Prisma.sql`
    AND ("occurredAt", id) < (
      SELECT "occurredAt", id FROM job_event WHERE ${matches} AND id = ${before}
    )
  `;
  return Prisma.sql`
    COALESCE((
      SELECT json_agg(json_build_object('id', id,
        'confirmedAt', to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY "occurredAt" DESC, id DESC)
      FROM (
        SELECT id, "occurredAt" FROM job_event WHERE ${matches} ${cursor}
        ORDER BY "occurredAt" DESC, id DESC LIMIT ${replyPageSize + 1}
      ) page
    ), '[]'::json)
  `;
}

function replyPage(rows: ReplySummary[]) {
  const replies = rows.slice(0, replyPageSize);
  return { replies, before: rows.length > replyPageSize ? replies[replyPageSize - 1].id : null };
}

function legacyHead(row?: StoredEvent): Head {
  if (!row) return { kind: "missing" };
  if (row.eventId === null) return { kind: "empty", revision: 0 };
  // The padded revision lets the existing owner/application/event-key index find the latest entry.
  const revision = Number(row.eventKey?.slice(keyPrefix.length));
  if (!Number.isInteger(revision) || revision < 1 || row.eventKey !== eventKey(revision)
    || !isRoundcubeLookupIdentity(row.message)) return { kind: "invalid" };
  return { kind: "confirmed", eventId: row.eventId, revision, message: row.message };
}

async function readHead(db: QueryDb, { ownerId, applicationId }: Application) {
  const [row] = await db.$queryRaw<StoredEvent[]>`
    SELECT e.id AS "eventId", e."eventKey", e.payload AS message
    FROM job_application a LEFT JOIN LATERAL (${latestLegacy}) e ON true
    WHERE a."ownerId" = ${ownerId} AND a.id = ${applicationId}
  `;
  return legacyHead(row);
}

async function readReply(db: QueryDb, { ownerId, applicationId }: Application, match: Prisma.Sql): Promise<Association> {
  const [row] = await db.$queryRaw<StoredEvent[]>`
    SELECT e.id AS "eventId", e."eventKey", e.payload AS message
    FROM job_application a LEFT JOIN LATERAL (
      SELECT id, "eventKey", payload FROM job_event
      WHERE "ownerId" = a."ownerId" AND "applicationId" = a.id AND kind = ${replyKind} AND ${match}
    ) e ON true
    WHERE a."ownerId" = ${ownerId} AND a.id = ${applicationId}
  `;
  if (!row) return { kind: "missing" };
  if (row.eventId === null) return { kind: "empty" };
  if (!isRoundcubeLookupIdentity(row.message) || row.eventKey !== replyKey(row.message)) {
    return { kind: "invalid" };
  }
  return { kind: "confirmed", eventId: row.eventId, message: row.message };
}

function canRead(access: AccessContext | null): access is AccessContext {
  return access?.client.kind === "web" && access.permissions.includes("jobs:read");
}

function sameMessage(a: RoundcubeLookupIdentity, b: RoundcubeLookupIdentity) {
  return a.account === b.account && a.folder === b.folder && a.uid === b.uid
    && a.uidValidity === b.uidValidity && a.messageId === b.messageId;
}

function alreadySavedOrBlocked(head: Head, expectedRevision: number, message: RoundcubeLookupIdentity): SaveResult | null {
  if (head.kind === "missing") return { kind: "missing" };
  if (head.kind === "invalid") return { kind: "unverifiable" };
  if (head.kind === "confirmed" && (head.revision === expectedRevision || head.revision === expectedRevision + 1)
    && sameMessage(head.message, message)) return { kind: "saved", revision: head.revision };
  if (head.revision !== expectedRevision) return { kind: "conflict" };
  return null;
}

function confirmedRecord(application: Application, message: RoundcubeLookupIdentity) {
  return { ...application, provenance: "owner-confirmed", message };
}

function freshObservation(observedAt: number, startedAt: number, now: number) {
  return Number.isSafeInteger(startedAt) && Number.isSafeInteger(now) && now > 0
    && Number.isSafeInteger(observedAt) && observedAt >= startedAt && observedAt <= now && now - observedAt <= 5;
}

export function createRoundcubeOriginalStore(db: StoreDb, mailbox: RoundcubeMailbox, now: () => number) {
  async function lookupAssociation(
    application: Application, readCurrent: () => Promise<Association | Head>, options?: Parameters<Lookup>[1],
  ): ReturnType<Lookup> {
    let saved: Extract<Association, { kind: "confirmed" }> | undefined;
    const observe = createRoundcubeOriginalLookup({
      ...mailbox,
      readAssociation: async () => {
        const head = await readCurrent();
        if (head.kind === "invalid") return undefined;
        if (head.kind !== "confirmed") return null;
        saved = head;
        return confirmedRecord(application, head.message);
      },
    });
    const evidence = await observe(application, options);
    if (saved && evidence.kind === "complete" && evidence.matches.length === 1) {
      const current = await readCurrent();
      if (current.kind !== "confirmed" || current.eventId !== saved.eventId || !sameMessage(current.message, saved.message)) {
        return { kind: "unavailable" };
      }
    }
    return evidence;
  }

  async function verifyMessage(application: Application, message: RoundcubeLookupIdentity) {
    const startedAt = now();
    const observe = createRoundcubeOriginalLookup({
      ...mailbox,
      readAssociation: async () => confirmedRecord(application, message),
    });
    try {
      const evidence = await observe(application);
      const match = evidence.kind === "complete" && evidence.matches.length === 1 ? evidence.matches[0] : null;
      if (evidence.kind !== "complete" || !isRoundcubeLookupIdentity(match, mailbox.mailboxAccount)
        || !sameMessage(message, match) || !freshObservation(evidence.observedAt, startedAt, now())) return null;
      return { message, observedAt: evidence.observedAt, startedAt };
    } catch {
      return null;
    }
  }

  async function discoverMessage(messageId: string) {
    const startedAt = now();
    const challenge = randomUUID();
    try {
      const observation = await mailbox.examineMailbox({ mode: "resolve", challenge, folder: "INBOX", messageId });
      if (!observation || observation.challenge !== challenge || observation.matches.length !== 1
        || !freshObservation(observation.observedAt, startedAt, now())) return null;
      const [match] = observation.matches;
      const message = { account: observation.account, folder: observation.folder, uid: match.uid,
        uidValidity: observation.uidValidity, messageId: match.messageId };
      if (!isRoundcubeLookupIdentity(message, mailbox.mailboxAccount) || message.messageId !== messageId) return null;
      return { message, observedAt: observation.observedAt, startedAt };
    } catch {
      return null;
    }
  }

  async function lockApplication(tx: QueryDb, { ownerId, applicationId }: Application) {
    const [existing] = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM job_application WHERE "ownerId" = ${ownerId} AND id = ${applicationId} FOR NO KEY UPDATE
    `;
    return Boolean(existing);
  }

  const lookup: Lookup = (application, options) => lookupAssociation(application, () => readHead(db, application), options);

  return {
    lookup,
    lookupReply(application: Application, id: string, options?: Parameters<Lookup>[1]) {
      return lookupAssociation(application, () => readReply(db, application, Prisma.sql`id = ${id}`), options);
    },
    async read(access: AccessContext | null, applicationId: string): Promise<Confirmation | null> {
      if (mailbox.enabled !== true || !canRead(access)) return null;
      const head = await readHead(db, { ownerId: access.owner.id, applicationId });
      return head.kind === "confirmed" ? { revision: head.revision, message: head.message } : null;
    },
    async readAvailability(access: AccessContext, applicationId: string) {
      if (mailbox.enabled !== true || !canRead(access)) return { verifiedOriginalReplyAvailable: false };
      const [row] = await db.$queryRaw<(StoredEvent & { replies: ReplySummary[] })[]>`
        SELECT e.id AS "eventId", e."eventKey", e.payload AS message,
          ${replyPageQuery(mailbox.mailboxAccount)} AS replies
        FROM job_application a LEFT JOIN LATERAL (${latestLegacy}) e ON true
        WHERE a."ownerId" = ${access.owner.id} AND a.id = ${applicationId}
      `;
      const head = legacyHead(row);
      const page = replyPage(row?.replies ?? []);
      return {
        verifiedOriginalReplyAvailable: head.kind === "confirmed" && head.message.account === mailbox.mailboxAccount,
        verifiedOriginalReplies: page.replies,
        verifiedOriginalRepliesBefore: page.before,
        canConfirmOriginalReply: Boolean(row) && access.permissions.includes("jobs:write"),
      };
    },
    async readReplyPage(access: AccessContext | null, applicationId: string, before: string) {
      if (mailbox.enabled !== true || !canRead(access)) return null;
      const [row] = await db.$queryRaw<{ replies: ReplySummary[] }[]>`
        SELECT ${replyPageQuery(mailbox.mailboxAccount, before)} AS replies
        FROM job_application a WHERE a."ownerId" = ${access.owner.id} AND a.id = ${applicationId}
      `;
      return row ? replyPage(row.replies) : null;
    },
    async confirmReply(access: AccessContext | null, applicationId: string, input: unknown): Promise<
      { kind: "saved"; id: string } | { kind: "denied" | "missing" | "conflict" | "unverifiable" }
    > {
      if (access?.client.kind !== "web" || !access.permissions.includes("jobs:write")) return { kind: "denied" };
      const exact = isRoundcubeLookupIdentity(input, mailbox.mailboxAccount) ? input : null;
      const messageId = exact?.messageId ?? input;
      if (mailbox.enabled !== true || !isLookupMessageId(messageId)) return { kind: "unverifiable" };
      const application = { ownerId: access.owner.id, applicationId };
      const key = replyKey({ account: mailbox.mailboxAccount, folder: "INBOX", messageId });
      const match = Prisma.sql`"eventKey" = ${key}`;
      const replay = (event: Association, message: RoundcubeLookupIdentity | null) => {
        if (event.kind === "invalid") return { kind: "unverifiable" } as const;
        if (event.kind !== "confirmed") return null;
        return (!message || sameMessage(event.message, message))
          ? { kind: "saved", id: event.eventId } as const
          : { kind: "conflict" } as const;
      };
      const current = await readReply(db, application, match);
      if (current.kind === "missing") return { kind: "missing" };
      const prior = replay(current, exact);
      if (prior) return prior;
      const evidence = exact ? await verifyMessage(application, exact) : await discoverMessage(messageId);
      if (!evidence) return { kind: "unverifiable" };

      return db.$transaction(async tx => {
        if (!await lockApplication(tx, application)) return { kind: "missing" };
        const concurrent = replay(await readReply(tx, application, match), evidence.message);
        if (concurrent) return concurrent;
        if (!freshObservation(evidence.observedAt, evidence.startedAt, now())) return { kind: "unverifiable" };
        const { id } = await tx.jobEvent.create({
          data: { ...application, kind: replyKind, eventKey: key, payload: evidence.message }, select: { id: true },
        });
        return { kind: "saved", id };
      }, { isolationLevel: "ReadCommitted" });
    },
    async confirm(
      access: AccessContext | null,
      applicationId: string,
      input: { expectedRevision: number; message: unknown },
    ): Promise<SaveResult> {
      if (access?.client.kind !== "web" || !access.permissions.includes("jobs:write")) return { kind: "denied" };
      const { expectedRevision } = input;
      if (mailbox.enabled !== true || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= maxRevision
        || !isRoundcubeLookupIdentity(input.message, mailbox.mailboxAccount)) return { kind: "unverifiable" };

      const application = { ownerId: access.owner.id, applicationId };
      const { account, folder, uid, uidValidity, messageId } = input.message;
      const message = { account, folder, uid, uidValidity, messageId };
      const prior = alreadySavedOrBlocked(await readHead(db, application), expectedRevision, message);
      if (prior) return prior;

      // The web Owner confirms the association. The trusted worker proves its exact, current identity.
      const evidence = await verifyMessage(application, message);
      if (!evidence) return { kind: "unverifiable" };

      // Hold the application lock only for the durable compare-and-swap.
      return db.$transaction(async tx => {
        if (!await lockApplication(tx, application)) return { kind: "missing" };
        const concurrent = alreadySavedOrBlocked(await readHead(tx, application), expectedRevision, message);
        if (concurrent) return concurrent;
        if (!freshObservation(evidence.observedAt, evidence.startedAt, now())) return { kind: "unverifiable" };
        const revision = expectedRevision + 1;
        await tx.jobEvent.create({ data: { ...application, kind: eventKind, eventKey: eventKey(revision), payload: message } });
        return { kind: "saved", revision };
      }, { isolationLevel: "ReadCommitted" });
    },
  };
}
