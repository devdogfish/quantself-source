import type { AccessContext } from "@quantself/auth";
import { sign, type KeyObject } from "node:crypto";
import { isAttachmentPartList } from "./roundcube-original-association";

type MessageIdentity = {
  account: string;
  folder: string;
  uid: number;
  uidValidity: number;
  messageId: string;
};

type Association = {
  ownerId: string;
  applicationId: string;
  message: unknown;
};

type Evidence =
  | { kind: "unavailable" }
  | {
      kind: "complete";
      association: Association | null;
      observedAt: number;
      matches: readonly unknown[];
    };

type IssuerDependencies = {
  baseUrl: string;
  audience: string;
  mailboxAccount: string;
  signingKey: KeyObject;
  includeSource?: boolean;
  now: () => number;
  // Trusted adapter. Read the verified association and a fresh, complete set of
  // exact current matches. Report unavailable for partial results or unknown provenance.
  lookup: (request: { ownerId: string; applicationId: string }) => Promise<Evidence>;
};

type Issuance =
  | { kind: "issued"; url: string; expiresAt: number }
  | { kind: "denied" | "missing" | "ambiguous" | "stale" | "unverifiable" };

const actionLifetimeSeconds = 120;
const maxObservationAgeSeconds = 5;
const maxBundledRequestBytes = 4096;
const idPattern = /^<[!#$%&'*+\/=?^_`{|}~A-Za-z0-9-]+(?:\.[!#$%&'*+\/=?^_`{|}~A-Za-z0-9-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>$/;

function validUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4_294_967_295;
}

function validIdentity(value: unknown, account: string): value is MessageIdentity {
  if (value === null || typeof value !== "object") return false;
  const identity = value as Partial<MessageIdentity>;
  if (typeof identity.folder !== "string" || typeof identity.messageId !== "string") return false;
  const folderBytes = Buffer.from(identity.folder);
  return identity.account === account
    && folderBytes.length > 0 && folderBytes.length <= 256
    && folderBytes.toString() === identity.folder && !/\p{Cc}/u.test(identity.folder)
    && validUint32(identity.uid) && validUint32(identity.uidValidity)
    && identity.messageId.length <= 254 && idPattern.test(identity.messageId)
    && !/\s/.test(identity.messageId);
}

function sameIdentity(a: MessageIdentity, b: MessageIdentity) {
  return a.account === b.account && a.folder === b.folder && a.uid === b.uid
    && a.uidValidity === b.uidValidity && a.messageId === b.messageId;
}

export async function issueRoundcubeOriginal(
  access: AccessContext | null,
  applicationId: string,
  dependencies: IssuerDependencies,
): Promise<Issuance> {
  if (!access || access.client.kind !== "web" || !access.permissions.includes("jobs:read")) {
    return { kind: "denied" };
  }

  const { lookup, baseUrl, signingKey, audience, mailboxAccount, now } = dependencies;
  const url = URL.parse(baseUrl);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !audience || !mailboxAccount || signingKey.type !== "private" || signingKey.asymmetricKeyType !== "ed25519") {
    return { kind: "unverifiable" };
  }

  const startedAt = now();
  let evidence: Evidence;
  try {
    evidence = await lookup({ ownerId: access.owner.id, applicationId });
  } catch {
    return { kind: "unverifiable" };
  }
  if (evidence.kind === "unavailable") return { kind: "unverifiable" };
  if (!evidence.association) return { kind: "missing" };
  const { ownerId, applicationId: linkedApplication, message } = evidence.association;
  if (ownerId !== access.owner.id || linkedApplication !== applicationId
    || !validIdentity(message, mailboxAccount)) {
    return { kind: "unverifiable" };
  }

  const issuedAt = now();
  const { matches, observedAt } = evidence;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(issuedAt) || issuedAt < 1 || issuedAt > Number.MAX_SAFE_INTEGER - actionLifetimeSeconds
    || !Number.isSafeInteger(observedAt) || observedAt < startedAt || observedAt > issuedAt
    || issuedAt - observedAt > maxObservationAgeSeconds) {
    return { kind: "stale" };
  }
  if (matches.length > 1) return { kind: "ambiguous" };
  if (matches.length === 0) return { kind: "missing" };
  const current = matches[0];
  if (!validIdentity(current, mailboxAccount) || !sameIdentity(message, current)) return { kind: "stale" };

  const expiresAt = issuedAt + actionLifetimeSeconds;
  const claims = [audience, current.account, current.folder, current.uid, current.uidValidity,
    current.messageId, "show", null, issuedAt, expiresAt];
  function signedPayload(payload: unknown[]) {
    const encoded = "qs-original-v1." + Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { encoded, signature: sign(null, Buffer.from(encoded), signingKey).toString("base64url") };
  }
  const parent = signedPayload(claims);
  const token = parent.encoded + "." + parent.signature;
  if (token.length > 2048) return { kind: "unverifiable" };
  const parts = (current as MessageIdentity & { attachmentParts?: unknown }).attachmentParts;
  if (parts !== undefined && !isAttachmentPartList(parts)) return { kind: "unverifiable" };
  const query = new URLSearchParams({ _task: "mail", _action: "show", _ref: token });
  if (dependencies.includeSource) {
    const { encoded, signature } = signedPayload([...claims.slice(0, 6), "source", null, issuedAt, expiresAt]);
    if (encoded.length + 1 + signature.length > 2048) return { kind: "unverifiable" };
    query.set("_source", signature);
  }
  let search = query.toString();
  if (parts?.length) {
    const bundle = parts.map(part => {
      const { signature } = signedPayload([...claims.slice(0, 6), "attachment", part, issuedAt, expiresAt]);
      return part + "~" + signature;
    }).join("!");
    search += "&_parts=" + bundle;
  }
  url.search = search;
  if ((dependencies.includeSource || parts?.length)
    && Buffer.byteLength(url.pathname + url.search) > maxBundledRequestBytes) return { kind: "unverifiable" };
  return { kind: "issued", url: url.href, expiresAt };
}
