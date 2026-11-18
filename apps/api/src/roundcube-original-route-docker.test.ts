import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { observerSocketPath } from "./roundcube-observer-wire";

const bridge = fileURLToPath(new URL("../../../agents/sam/jobs-mail/test_roundcube_observer.py", import.meta.url));
const reply = { account: "luigi@luigigirke.com", folder: "INBOX", uid: 42, uidValidity: 120,
  messageId: "<roundcube-proof@example.test>" };
const legacy = { folder: reply.folder, uid: reply.uid };
const origin = "https://qs.girke.dev";

test.skipIf(process.env.QUANTSELF_ROUNDCUBE_ROUTE_FIXTURE !== "1")(
  "normal app entry point gates, confirms, and issues original replies over real PostgreSQL and TLS IMAP",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/roundcube_route_fixture") {
      throw new Error("Use a disposable PostgreSQL Roundcube route fixture.");
    }
    const [{ prisma }, { createApp }, { todoGitHub }] = await Promise.all([
      import("@quantself/db"), import("./app"), import("./todos-github"),
    ]);
    const directory = await mkdtemp("/tmp/qs-roundcube-route-");
    const path = join(directory, "worker.sock");
    const keyPath = join(directory, "key.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const ownerProof = randomBytes(32).toString("hex");
    const previousOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
    process.env.QUANTSELF_OWNER_INGRESS_TOKEN = ownerProof;
    const ownerId = randomUUID(), otherOwnerId = randomUUID();
    const child = Bun.spawn(["python3", "-B", bridge, "--bridge", path, "--requests", "5", "--epoch-drift-last"], {
      stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      if (Buffer.from(ready.value ?? []).toString().trim() !== "ready") {
        throw new Error("TLS worker fixture failed: " + await new Response(child.stderr).text());
      }
      await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const id = randomUUID(), legacyId = randomUUID(), foreignId = randomUUID();
      const name = "Fixture Owner";
      const email = `roundcube-${ownerId}@example.test`;
      await prisma.authOwner.create({ data: { id: "singleton", user: { create: { id: ownerId, name, email } } } });
      const job = (applicationId: string, ownerId: string) => ({
        ownerId, id: applicationId, company: "Fixture Co", role: "Operator", resumeTrack: "web" as const,
        sourceKey: applicationId, sourceUrl: "https://example.test/job", sourceReply: legacy,
      });
      await prisma.jobApplication.createMany({ data: [job(id, ownerId), job(legacyId, ownerId), job(foreignId, otherOwnerId)] });
      await prisma.jobEvent.create({ data: {
        ownerId: otherOwnerId, applicationId: foreignId, kind: "roundcube_original_confirmed",
        eventKey: "roundcube-original:0000000001", payload: reply,
      } });
      const env = {
        QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "1",
        QUANTSELF_JOBS_ROUNDCUBE_URL: "https://roundcube.jobs.example.test/mail/",
        QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: path,
        QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: reply.account,
        QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE: keyPath,
      };
      let confirmationQueries = 0;
      const db = prisma.$extends({ query: { $allOperations({ operation, args, query }) {
        if (operation === "$queryRaw") confirmationQueries++;
        return query(args);
      } } }) as unknown as PrismaClient;
      const app = createApp({ todos: todoGitHub, jobsWorkers: { db }, jobsRoundcubeEnv: env, emitAccessLog() {} });
      const disabled = createApp({ todos: todoGitHub, jobsWorkers: { db }, jobsRoundcubeEnv: { ...env, QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: undefined }, emitAccessLog() {} });
      const invalidKey = createApp({ todos: todoGitHub, jobsRoundcubeEnv: { ...env, QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE: path }, emitAccessLog() {} });
      const unsafePath = join(directory, "unsafe.pem");
      await writeFile(unsafePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await chmod(unsafePath, 0o644);
      const unsafeDedicated = createApp({ todos: todoGitHub, jobsWorkers: { db }, jobsRoundcubeEnv: {
        ...env, QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE: unsafePath,
        QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_TRANSPORT: "dedicated", QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: observerSocketPath,
      }, emitAccessLog() {} });
      const endpoint = (id: string) => `/api/owner/jobs/applications/${id}/original-reply`;
      const lifecycle = (id: string) => `/api/v1/jobs/applications/${id}/lifecycle`;
      const headers = { "x-quantself-owner-proof": ownerProof };
      const request = (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => app.request(origin + path, init);
      const policy = (res: Response) => {
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      };
      const assertNoLink = (res: Response, status: number) => {
        expect(res.status).toBe(status);
        expect(res.headers.get("location")).toBeNull();
      };
      const put = (id: string, body: unknown, source = origin, appInstance = app, type = "application/json") =>
        request(appInstance, endpoint(id) + "/confirmation", {
          method: "PUT", headers: { ...headers, origin: source, "content-type": type }, body: JSON.stringify(body),
        });
      const command = { expectedRevision: 0, message: reply };

      assertNoLink(await request(app, endpoint(id)), 401);
      assertNoLink(await request(disabled, endpoint(id), { headers }), 404);
      assertNoLink(await put(id, command, origin, disabled), 404);
      const unsafeSignerQueries = confirmationQueries;
      assertNoLink(await request(unsafeDedicated, endpoint(id), { headers }), 503);
      assertNoLink(await put(id, command, origin, unsafeDedicated), 503);
      expect(confirmationQueries - unsafeSignerQueries).toBe(0);
      assertNoLink(await request(app, endpoint(legacyId), { headers }), 404);
      assertNoLink(await request(app, endpoint(foreignId), { headers }), 404);
      const metadata = await request(app, endpoint(foreignId) + "/confirmation", { headers });
      policy(metadata);
      expect(await metadata.json()).toEqual({ revision: null });
      assertNoLink(await put(foreignId, command), 404);
      assertNoLink(await put(id, { expectedRevision: 0, message: legacy }), 400);
      assertNoLink(await put(id, command, "https://other.example.test"), 403);
      assertNoLink(await put(id, command, origin, app, "text/plain"), 400);
      assertNoLink(await put(id, { ...command, padding: "x".repeat(1100) }), 413);
      assertNoLink(await request(app, endpoint(id) + "?_uid=42", { headers }), 400);

      const restricted = (client: "api-key" | "web", permissions: string[]) => createApp({
        todos: todoGitHub, jobsWorkers: { db }, jobsRoundcubeEnv: env, emitAccessLog() {},
        resolveAccessContext: async () => ({ owner: { id: ownerId, name, email }, client: { id: client, kind: client, name }, permissions }),
      });
      assertNoLink(await request(restricted("api-key", ["jobs:read", "jobs:write"]), endpoint(id)), 403);
      assertNoLink(await request(restricted("web", ["jobs:write"]), endpoint(id)), 403);
      assertNoLink(await put(id, command, origin, restricted("web", ["jobs:read"])), 403);

      const confirmed = await put(id, command);
      policy(confirmed);
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ revision: 1 });
      expect(await (await put(id, command)).json()).toEqual({ revision: 1 });
      const repliesPath = `/api/owner/jobs/applications/${legacyId}/replies`;
      const resolved = await request(app, repliesPath + "/confirmation", {
        method: "PUT", headers: { ...headers, origin, "content-type": "application/json" },
        body: JSON.stringify({ messageId: reply.messageId }),
      });
      policy(resolved);
      expect(resolved.status).toBe(200);
      const resolvedReply = await resolved.json() as { id: string };
      expect(resolvedReply).toEqual({ id: expect.any(String) });
      expect((await request(app, `${repliesPath}/${resolvedReply.id}/original`, { headers })).status).toBe(303);
      const disabledQueriesBefore = confirmationQueries;
      const disabledDetail = await request(disabled, lifecycle(id), { headers });
      expect(disabledDetail.status).toBe(200);
      expect(await disabledDetail.json()).toMatchObject({ sourceReplyLinked: true, verifiedOriginalReplyAvailable: false });
      expect(confirmationQueries - disabledQueriesBefore).toBe(0);

      const enabledQueriesBefore = confirmationQueries;
      const started = performance.now();
      const enabledDetail = await request(app, lifecycle(id), { headers });
      const detailMs = performance.now() - started;
      expect(enabledDetail.status).toBe(200);
      expect(await enabledDetail.json()).toMatchObject({ sourceReplyLinked: true, verifiedOriginalReplyAvailable: true });
      expect(confirmationQueries - enabledQueriesBefore).toBe(1);
      const restrictedQueriesBefore = confirmationQueries;
      const machineDetail = await request(restricted("api-key", ["jobs:read"]), lifecycle(id));
      expect(machineDetail.status).toBe(200);
      expect(await machineDetail.json()).toMatchObject({ sourceReplyLinked: true, verifiedOriginalReplyAvailable: false });
      expect(confirmationQueries - restrictedQueriesBefore).toBe(0);
      expect(await (await request(app, lifecycle(legacyId), { headers })).json())
        .toMatchObject({ sourceReplyLinked: true, verifiedOriginalReplyAvailable: false });
      const readStarted = performance.now();
      expect(await (await request(app, endpoint(id) + "/confirmation", { headers })).json()).toEqual({ revision: 1 });
      const readMs = performance.now() - readStarted;
      assertNoLink(await request(invalidKey, endpoint(id), { headers }), 503);
      assertNoLink(await request(app, endpoint(id), { method: "HEAD", headers }), 405);
      const issueStarted = performance.now();
      const issued = await request(app, endpoint(id), { headers });
      const issueMs = performance.now() - issueStarted;
      policy(issued);
      expect(issued.status).toBe(303);
      const destination = new URL(issued.headers.get("location")!);
      expect(destination.origin + destination.pathname).toBe(env.QUANTSELF_JOBS_ROUNDCUBE_URL);
      expect([...destination.searchParams.keys()]).toEqual(["_task", "_action", "_ref"]);
      const [version, payload, signature] = destination.searchParams.get("_ref")!.split(".");
      expect(verify(null, Buffer.from(version + "." + payload), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(JSON.parse(Buffer.from(payload, "base64url").toString()).slice(0, 7))
        .toEqual([destination.hostname, reply.account, reply.folder, reply.uid, reply.uidValidity, reply.messageId, "show"]);
      assertNoLink(await request(app, endpoint(id), { headers }), 503);
      expect(await child.exited).toBe(0);
      assertNoLink(await request(app, endpoint(id), { headers }), 503);

      const record = await prisma.jobApplication.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id } },
        select: { sourceReply: true, _count: { select: { events: true } } },
      });
      expect(record).toEqual({ sourceReply: legacy, _count: { events: 1 } });
      console.info(`Roundcube fixture warm database: lifecycle detail ${detailMs.toFixed(1)} ms, confirmation read ${readMs.toFixed(1)} ms, signed redirect with fresh TLS ${issueMs.toFixed(1)} ms.`);
    } finally {
      child.kill();
      await child.exited;
      if (previousOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = previousOrigin;
      if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
      try {
        await prisma.jobApplication.deleteMany({ where: { ownerId: { in: [ownerId, otherOwnerId] } } });
        await prisma.authOwner.deleteMany({ where: { userId: ownerId } });
        await prisma.user.deleteMany({ where: { id: ownerId } });
      } finally {
        await Promise.all([prisma.$disconnect(), rm(directory, { recursive: true, force: true })]);
      }
    }
  },
  20_000,
);
