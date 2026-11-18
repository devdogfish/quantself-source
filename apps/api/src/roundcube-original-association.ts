import { randomUUID } from "node:crypto";
import type { issueRoundcubeOriginal } from "./roundcube-original-issuer";

type IssuerLookup = Parameters<typeof issueRoundcubeOriginal>[2]["lookup"];
type Application = Parameters<IssuerLookup>[0];
type Evidence = Awaited<ReturnType<IssuerLookup>>;
type Lookup = (application: Application, options?: { includeAttachmentParts: true }) => Promise<
  | Extract<Evidence, { kind: "unavailable" }>
  | (Omit<Extract<Evidence, { kind: "complete" }>, "matches"> & {
      matches: readonly (RoundcubeLookupIdentity & { attachmentParts?: readonly string[] })[];
    })
>;

type MailboxQuery = {
  challenge: string;
  folder: "INBOX";
  messageId: string;
} & ({ mode?: never; uidValidity: number; attachmentUid?: number }
  | { mode: "resolve"; uidValidity?: never; attachmentUid?: never });

type Observation = {
  challenge: string;
  account: string;
  folder: string;
  uidValidity: number;
  observedAt: number;
  matches: readonly { uid: number; messageId: string; attachmentParts?: readonly string[] }[];
};

export type RoundcubeMailbox = {
  enabled?: boolean;
  mailboxAccount: string;
  // Trusted mailbox worker. The account must come from the selected authenticated connection.
  // Return null if the lookup is incomplete, out of bounds, or changed epoch.
  examineMailbox: (query: MailboxQuery) => Promise<Observation | null>;
};

type Dependencies = RoundcubeMailbox & {
  // Trusted Owner-confirmation store. Legacy lifecycle data and mail hints are not confirmations.
  readAssociation: (application: Application) => Promise<unknown>;
};

export type RoundcubeLookupIdentity = {
  account: string;
  folder: "INBOX";
  uid: number;
  uidValidity: number;
  messageId: string;
};

function positiveUid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4_294_967_295;
}

const messageIdPattern = /^<[!#$%&'*+\/=?^_`{|}~A-Za-z0-9-]+(?:\.[!#$%&'*+\/=?^_`{|}~A-Za-z0-9-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/;
const partIdPattern = /^[1-9][0-9]{0,8}(?:\.[1-9][0-9]{0,8}){0,7}$/;

export function isAttachmentPartList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 16 && new Set(value).size === value.length
    && value.every(part => typeof part === "string" && partIdPattern.test(part));
}

export function isLookupMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && messageIdPattern.test(value)
    && !/\s/.test(value);
}

export function isRoundcubeLookupIdentity(value: unknown, mailboxAccount?: string): value is RoundcubeLookupIdentity {
  if (value === null || typeof value !== "object") return false;
  const { account, folder, uid, uidValidity, messageId } = value as Record<string, unknown>;
  return typeof account === "string" && account.length > 0
    && (mailboxAccount === undefined || account === mailboxAccount) && folder === "INBOX"
    && positiveUid(uid) && positiveUid(uidValidity) && isLookupMessageId(messageId);
}

export function createRoundcubeOriginalLookup(dependencies: Dependencies): Lookup {
  return async (application, options) => {
    if (dependencies.enabled !== true) return { kind: "unavailable" };

    const saved = await dependencies.readAssociation(application);
    if (saved === null) return { kind: "complete", association: null, observedAt: 0, matches: [] };
    if (typeof saved !== "object" || !("message" in saved)) return { kind: "unavailable" };
    const record = saved as { provenance?: unknown; ownerId?: unknown; applicationId?: unknown; message: unknown };
    if (record.provenance !== "owner-confirmed"
      || record.ownerId !== application.ownerId || record.applicationId !== application.applicationId
      || !isRoundcubeLookupIdentity(record.message, dependencies.mailboxAccount)) {
      return { kind: "unavailable" };
    }
    const { account, folder, uid, uidValidity, messageId } = record.message;

    const challenge = randomUUID();
    const attachmentUid = options?.includeAttachmentParts ? uid : undefined;
    const observation = await dependencies.examineMailbox({
      challenge, folder, uidValidity, messageId, ...(attachmentUid === undefined ? {} : { attachmentUid }),
    });
    if (!observation || observation.challenge !== challenge || observation.account !== account
      || observation.folder !== folder || observation.uidValidity !== uidValidity
      || !Array.isArray(observation.matches) || observation.matches.length > 8
      || observation.matches.some(match => !match || !positiveUid(match.uid) || match.messageId !== messageId)) {
      return { kind: "unavailable" };
    }
    if (attachmentUid !== undefined) {
      const [match] = observation.matches;
      if (observation.matches.length !== 1 || match?.uid !== attachmentUid
        || !isAttachmentPartList(match.attachmentParts)) return { kind: "unavailable" };
    }

    return {
      kind: "complete",
      association: { ...application, message: { account, folder, uid, uidValidity, messageId } },
      observedAt: observation.observedAt,
      matches: observation.matches.map(match => ({
        account, folder, uidValidity, uid: match.uid, messageId,
        ...(attachmentUid === undefined ? {} : { attachmentParts: match.attachmentParts }),
      })),
    };
  };
}
