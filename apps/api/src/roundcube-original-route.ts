import { createPrivateKey } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AccessContext } from "@quantself/auth";
import { getPublicOrigin } from "@quantself/auth/public-origin";
import { prisma } from "@quantself/db";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { jobIdInput } from "./jobs-contract";
import { isLookupMessageId } from "./roundcube-original-association";
import { issueRoundcubeOriginal } from "./roundcube-original-issuer";
import { configurePrivateRoundcubeOriginals } from "./roundcube-original-private";

type Env = { Variables: { accessContext: AccessContext | null } };
type PrivateEnv = Parameters<typeof configurePrivateRoundcubeOriginals>[1];
export const roundcubeOwnerPath = "/api/owner/jobs";
const original = `${roundcubeOwnerPath}/applications/:id/original-reply` as const;
const confirmation = `${original}/confirmation` as const;
const replies = `${roundcubeOwnerPath}/applications/:id/replies` as const;
const replyConfirmation = `${replies}/confirmation` as const;
const replyOriginal = `${replies}/:replyId/original` as const;
const unsignedUid = z.number().int().positive().max(4_294_967_295);
const messageInput = z.strictObject({
  account: z.string().min(1).max(254), folder: z.literal("INBOX"),
  uid: unsignedUid, uidValidity: unsignedUid, messageId: z.string().min(1).max(254),
});
const input = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  message: messageInput,
});
const replyInput = z.union([z.strictObject({ message: messageInput }),
  z.strictObject({ messageId: z.string().refine(isLookupMessageId) })]);
const replyCursor = z.strictObject({ before: z.uuid() });
const originalInput = jobIdInput.extend({ replyId: z.uuid().optional() });
const unavailable = { message: "Verified original reply unavailable." } as const;
const maxKeyBytes = 4096;

function rootOnlySigningFile(file: Stats) {
  return file.isFile() && file.uid === 0 && (file.mode & 0o077) === 0;
}

async function readSigningKey(path: string, rootOnly: boolean) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maxKeyBytes) return null;
      if (rootOnly && !rootOnlySigningFile(stat)) return null;
      const bytes = Buffer.alloc(maxKeyBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) return null;
      const key = createPrivateKey(bytes.subarray(0, bytesRead));
      return key.asymmetricKeyType === "ed25519" ? key : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

function authorize(permission: "jobs:read" | "jobs:write") {
  return createMiddleware<Env>(async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    const access = c.get("accessContext");
    if (!access) return c.json({ message: "Authentication required." }, 401);
    if (access.client.kind !== "web" || !access.permissions.includes(permission)) {
      return c.json({ message: "Missing Jobs permission." }, 403);
    }
    if (c.req.method === "PUT") {
      if (c.req.header("origin") !== (getPublicOrigin() ?? new URL(c.req.url).origin)) {
        return c.json({ message: "Invalid origin." }, 403);
      }
      if (!/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) {
        return c.json({ message: "Send a JSON request body." }, 400);
      }
    }
    await next();
  });
}

export function configureRoundcubeOriginalRoutes(db = prisma, env: PrivateEnv = process.env) {
  const now = () => Math.floor(Date.now() / 1000);
  const keyPath = env.QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE;
  if (!keyPath || !isAbsolute(keyPath) || keyPath.includes("\0")) return null;
  const configured = configurePrivateRoundcubeOriginals(db, env, now);
  if (!configured) return null;
  const { store } = configured;
  return {
    ...configured, keyPath, now,
    includeAttachmentParts: env.QUANTSELF_JOBS_ROUNDCUBE_ATTACHMENT_PARTS_ENABLED === "1",
    includeSource: env.QUANTSELF_JOBS_ROUNDCUBE_SOURCE_ENABLED === "1",
    readAvailability: (access: AccessContext, applicationId: string) => store.readAvailability(access, applicationId)
      .catch(() => ({ verifiedOriginalReplyAvailable: false })),
  };
}

export function registerRoundcubeOriginalRoutes(
  app: OpenAPIHono<Env>,
  configured: ReturnType<typeof configureRoundcubeOriginalRoutes>,
) {

  app.get(confirmation, authorize("jobs:read"), async c => {
    if (!configured) return c.json(unavailable, 404);
    const target = jobIdInput.safeParse(c.req.param());
    if (!target.success) return c.json({ message: "Invalid application ID." }, 400);
    const current = await configured.store.read(c.get("accessContext"), target.data.id);
    return c.json({ revision: current?.revision ?? null });
  });

  const confirmationLimit = bodyLimit({
    maxSize: 1024, onError: c => c.json({ message: "Jobs request is too large." }, 413),
  });
  app.put(confirmation, authorize("jobs:write"), confirmationLimit, async c => {
    if (!configured) return c.json(unavailable, 404);
    const target = jobIdInput.safeParse(c.req.param());
    const command = input.safeParse(await c.req.json().catch(() => null));
    if (!target.success || !command.success || new URL(c.req.url).search) {
      return c.json({ message: "Invalid original reply confirmation." }, 400);
    }
    if (configured.transport === "dedicated"
      && !await stat(configured.keyPath).then(rootOnlySigningFile, () => false)) return c.json(unavailable, 503);
    // The expected revision and exact message make this PUT safe to replay through the store's compare-and-swap.
    const result = await configured.store.confirm(c.get("accessContext"), target.data.id, command.data);
    if (result.kind === "saved") return c.json({ revision: result.revision });
    if (result.kind === "conflict") return c.json({ message: "The original reply changed. Refresh before confirming it." }, 409);
    if (result.kind === "denied") return c.json({ message: "Missing Jobs permission." }, 403);
    return c.json(unavailable, result.kind === "missing" ? 404 : 503);
  });

  app.put(replyConfirmation, authorize("jobs:write"), confirmationLimit, async c => {
    if (!configured) return c.json(unavailable, 404);
    const target = jobIdInput.safeParse(c.req.param());
    const command = replyInput.safeParse(await c.req.json().catch(() => null));
    if (!target.success || !command.success || new URL(c.req.url).search) {
      return c.json({ message: "Invalid reply confirmation." }, 400);
    }
    if (configured.transport === "dedicated"
      && !await stat(configured.keyPath).then(rootOnlySigningFile, () => false)) return c.json(unavailable, 503);
    const result = await configured.store.confirmReply(c.get("accessContext"), target.data.id,
      "message" in command.data ? command.data.message : command.data.messageId);
    if (result.kind === "saved") return c.json({ id: result.id });
    if (result.kind === "conflict") return c.json({ message: "This reply already has a different verified mailbox identity." }, 409);
    if (result.kind === "denied") return c.json({ message: "Missing Jobs permission." }, 403);
    return c.json(unavailable, result.kind === "missing" ? 404 : 503);
  });

  app.get(replies, authorize("jobs:read"), async c => {
    if (!configured) return c.json(unavailable, 404);
    const target = jobIdInput.safeParse(c.req.param());
    const cursor = replyCursor.safeParse(c.req.query());
    if (!target.success || !cursor.success || new URL(c.req.url).searchParams.size !== 1) {
      return c.json({ message: "Invalid reply page cursor." }, 400);
    }
    const page = await configured.store.readReplyPage(c.get("accessContext"), target.data.id, cursor.data.before);
    return page ? c.json(page) : c.json(unavailable, 404);
  });

  const openOriginal: Handler<Env> = async c => {
    if (!configured) return c.json(unavailable, 404);
    if (c.req.method !== "GET") {
      c.header("Allow", "GET");
      return c.json(unavailable, 405);
    }
    const target = originalInput.safeParse(c.req.param());
    if (!target.success || new URL(c.req.url).search) return c.json({ message: "Invalid original reply request." }, 400);
    const signingKey = await readSigningKey(configured.keyPath, configured.transport === "dedicated");
    if (!signingKey) return c.json(unavailable, 503);
    const { id, replyId } = target.data;
    const options = configured.includeAttachmentParts ? { includeAttachmentParts: true } as const : undefined;
    const result = await issueRoundcubeOriginal(c.get("accessContext"), id, {
      baseUrl: configured.baseUrl,
      audience: new URL(configured.baseUrl).hostname,
      mailboxAccount: configured.mailboxAccount,
      lookup: application => replyId === undefined
        ? configured.store.lookup(application, options)
        : configured.store.lookupReply(application, replyId, options),
      signingKey,
      includeSource: configured.includeSource,
      now: configured.now,
    });
    if (result.kind === "issued") return c.redirect(result.url, 303);
    return c.json(unavailable, result.kind === "missing" ? 404 : 503);
  };
  app.get(original, authorize("jobs:read"), openOriginal);
  app.get(replyOriginal, authorize("jobs:read"), openOriginal);
}
