import { isAbsolute } from "node:path";
import { z } from "zod";
import { isAttachmentPartList, type RoundcubeMailbox } from "./roundcube-original-association";
import { createRoundcubeOriginalStore } from "./roundcube-original-store";
import { observeThroughDedicatedClient } from "./roundcube-observer-transport";
import { exchangeObserverFrame, observerSocketPath } from "./roundcube-observer-wire";

const uid = z.number().int().min(1).max(4_294_967_295);
const observation = z.object({
  challenge: z.string().uuid(),
  account: z.string().max(254),
  folder: z.literal("INBOX"),
  uidValidity: uid,
  observedAt: z.number().int().positive(),
  matches: z.array(z.object({
    uid,
    messageId: z.string().max(254),
    attachmentParts: z.custom<readonly string[]>(isAttachmentPartList).optional(),
  }).strict()).max(8),
}).strict();

function mailboxOverPrivateSocket(exchange: (request: Buffer) => Promise<Buffer | null>, mailboxAccount: string): RoundcubeMailbox {
  return {
    enabled: true,
    mailboxAccount,
    async examineMailbox(query) {
      try {
        const response = await exchange(Buffer.from(JSON.stringify(query) + "\n"));
        if (!response) return null;
        const result = observation.safeParse(JSON.parse(response.toString("utf8")));
        if (!result.success || result.data.challenge !== query.challenge
          || result.data.account !== mailboxAccount
          || (query.uidValidity !== undefined && result.data.uidValidity !== query.uidValidity)
          || result.data.matches.some(match => match.messageId !== query.messageId)) return null;
        if (query.attachmentUid === undefined
          && result.data.matches.some(match => match.attachmentParts !== undefined)) return null;
        return result.data;
      } catch {
        return null;
      }
    },
  };
}

type Db = Parameters<typeof createRoundcubeOriginalStore>[0];

export function configurePrivateRoundcubeOriginals(
  db: Db,
  env: Readonly<Record<string, string | undefined>>,
  now = () => Math.floor(Date.now() / 1000),
) {
  if (env.QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED !== "1") return null;
  const baseUrl = URL.parse(env.QUANTSELF_JOBS_ROUNDCUBE_URL ?? "");
  const socket = env.QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET;
  const transport = env.QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT ?? "direct";
  const account = env.QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT;
  if (!baseUrl || baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    || !socket || !isAbsolute(socket) || socket.includes("\0")
    || (transport !== "direct" && (transport !== "dedicated" || socket !== observerSocketPath))
    || !account || !/^[a-z0-9._+%-]{1,64}@[a-z0-9.-]{1,189}$/.test(account)) return null;

  const exchange = transport === "dedicated" ? observeThroughDedicatedClient : (request: Buffer) => exchangeObserverFrame(socket, request);
  return {
    baseUrl: baseUrl.href,
    mailboxAccount: account,
    transport,
    store: createRoundcubeOriginalStore(db, mailboxOverPrivateSocket(exchange, account), now),
  };
}
