import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { jobLifecycleOutput } from "./jobs-lifecycle-contract";

test.skipIf(process.env.QUANTSELF_ROUNDCUBE_ROUTE_FIXTURE !== "1")(
  "Owner confirms, lists and opens each immutable reply over the normal app routes",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/roundcube_route_fixture") {
      throw new Error("Use a disposable PostgreSQL Roundcube route fixture.");
    }
    const [{ prisma }, { createApp }, { todoGitHub }] = await Promise.all([
      import("@quantself/db"), import("./app"), import("./todos-github"),
    ]);
    const ownerId = randomUUID(), otherOwnerId = randomUUID();
    const applicationId = randomUUID(), siblingId = randomUUID(), foreignId = randomUUID();
    const account = "fixture@mail.example.test", folder = "INBOX", uidValidity = 120;
    const replies = [42, 73].map(uid => ({ account, folder, uid, uidValidity, messageId: `<reply-${uid}@example.test>` }));
    const origin = "https://qs.example.test";
    const directory = await mkdtemp("/tmp/qs-roundcube-replies-");
    const path = join(directory, "worker.sock"), keyPath = join(directory, "key.pem");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let observations = 0, stale = false, replayChallenge = false, duplicate = false;
    const resolved: string[] = [];
    const worker = createServer(socket => {
      let frame = "";
      socket.on("data", chunk => {
        frame += chunk.toString();
        if (!frame.endsWith("\n")) return;
        observations++;
        const query = JSON.parse(frame);
        if (query.mode === "resolve" && query.uidValidity === undefined) resolved.push(query.messageId);
        const reply = replies.find(reply => reply.messageId === query.messageId);
        const matches = reply ? [{ uid: reply.uid, messageId: reply.messageId }] : [];
        if (reply && duplicate) matches.push({ uid: reply.uid + 1, messageId: reply.messageId });
        socket.end(JSON.stringify({
          challenge: replayChallenge ? randomUUID() : query.challenge,
          account, folder, uidValidity: stale ? uidValidity + 1 : uidValidity,
          observedAt: Math.floor(Date.now() / 1000),
          matches,
        }) + "\n");
      });
    });
    try {
      await once(worker.listen(path), "listening");
      await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const legacy = { folder, uid: 98 };
      const job = (id: string, ownerId: string) => ({
        ownerId, id, company: "Fixture Co", role: "Operator", resumeTrack: "web" as const, sourceKey: id,
        sourceUrl: "https://example.test/job", sourceReply: legacy,
      });
      await prisma.jobApplication.createMany({ data: [job(applicationId, ownerId), job(siblingId, ownerId), job(foreignId, otherOwnerId)] });
      await prisma.jobEvent.create({ data: {
        ownerId, applicationId, kind: "roundcube_original_confirmed", eventKey: "roundcube-original:0000000001",
        payload: { account, folder, uidValidity, uid: legacy.uid, messageId: "<legacy@example.test>" },
      } });
      const env = {
        QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: "1",
        QUANTSELF_JOBS_ROUNDCUBE_URL: "https://roundcube.example.test/",
        QUANTSELF_JOBS_ROUNDCUBE_OBSERVER_SOCKET: path,
        QUANTSELF_JOBS_ROUNDCUBE_MAILBOX_ACCOUNT: account,
        QUANTSELF_JOBS_ROUNDCUBE_SIGNING_KEY_FILE: keyPath,
      };
      let rawQueries = 0;
      const db = prisma.$extends({ query: { $allOperations({ operation, args, query }) {
        if (operation === "$queryRaw") rawQueries++;
        return query(args);
      } } }) as unknown as PrismaClient;
      const app = (kind: "web" | "api-key", permissions: string[], enabled = true) => createApp({
        todos: todoGitHub, jobsWorkers: { db }, emitAccessLog() {},
        jobsRoundcubeEnv: { ...env, QUANTSELF_JOBS_ROUNDCUBE_ORIGINALS_ENABLED: enabled ? "1" : undefined },
        resolveAccessContext: async () => ({
          owner: { id: ownerId, name: "Fixture", email: account }, client: { id: kind, kind, name: kind }, permissions,
        }),
      });
      const owner = app("web", ["jobs:read", "jobs:write"]);
      const reader = app("web", ["jobs:read"]);
      const machine = app("api-key", ["jobs:read", "jobs:write"]);
      const disabled = app("web", ["jobs:read", "jobs:write"], false);
      const base = (id: string) => `/api/owner/jobs/applications/${id}/replies`;
      const open = (id: string, replyId: string) => `${base(id)}/${replyId}/original`;
      const lifecycle = `/api/v1/jobs/applications/${applicationId}/lifecycle`;
      const confirm = (message: unknown, target = applicationId, instance = owner) =>
        instance.request(origin + base(target) + "/confirmation", {
          method: "PUT", headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(typeof message === "string" ? { messageId: message } : { message }),
        });

      expect((await confirm(replies[0], applicationId, machine)).status).toBe(403);
      expect((await confirm(replies[0], applicationId, reader)).status).toBe(403);
      expect((await confirm(replies[0], foreignId)).status).toBe(404);
      expect((await confirm(legacy)).status).toBe(400);
      expect(observations).toBe(0);
      const confirmations = await Promise.all([confirm(replies[0].messageId), confirm(replies[0]), confirm(replies[1].messageId)]);
      expect(confirmations.map(response => response.status)).toEqual([200, 200, 200]);
      const [first, replay, second] = await Promise.all(confirmations.map(response => response.json() as Promise<{ id: string }>));
      expect(replay.id).toBe(first.id);
      expect(second.id).not.toBe(first.id);
      expect(resolved.sort()).toEqual(replies.map(reply => reply.messageId).sort());
      const afterConfirm = observations;
      expect(await (await confirm(replies[0])).json()).toEqual(first);
      expect((await confirm({ ...replies[0], uid: 111 })).status).toBe(409);
      expect(observations).toBe(afterConfirm);

      const detailStart = performance.now();
      const beforeDetail = rawQueries;
      const detail = await reader.request(origin + lifecycle);
      const payload = await detail.json() as Record<string, unknown>;
      const { verifiedOriginalReplies, verifiedOriginalReplyAvailable, sourceReplyLinked } = jobLifecycleOutput.parse(payload);
      const detailMs = performance.now() - detailStart;
      expect(verifiedOriginalReplies).toHaveLength(2);
      expect(new Set(verifiedOriginalReplies?.map(reply => reply.id))).toEqual(new Set([first.id, second.id]));
      expect((payload.verifiedOriginalReplies as object[]).map(reply => Object.keys(reply).sort()))
        .toEqual([["confirmedAt", "id"], ["confirmedAt", "id"]]);
      expect(verifiedOriginalReplyAvailable).toBe(true);
      expect(sourceReplyLinked).toBe(true);
      expect(rawQueries - beforeDetail).toBe(1);
      for (const instance of [machine, disabled]) {
        const prev = rawQueries;
        expect(jobLifecycleOutput.parse(await (await instance.request(origin + lifecycle)).json()).verifiedOriginalReplies)
          .toBeUndefined();
        expect(rawQueries - prev).toBe(0);
      }
      expect(observations).toBe(afterConfirm);

      expect((await machine.request(origin + open(applicationId, first.id))).status).toBe(403);
      expect((await owner.request(origin + open(siblingId, first.id))).status).toBe(404);
      expect((await owner.request(origin + open(foreignId, first.id))).status).toBe(404);
      expect((await owner.request(origin + open(applicationId, first.id) + "?uid=73")).status).toBe(400);
      expect(observations).toBe(afterConfirm);
      const issueTimes = [];
      for (const [index, confirmation] of [first, second].entries()) {
        const start = performance.now();
        const response = await reader.request(origin + open(applicationId, confirmation.id));
        issueTimes.push((performance.now() - start).toFixed(1));
        expect(response.status).toBe(303);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const destination = new URL(response.headers.get("location")!);
        const [version, payload, signature] = destination.searchParams.get("_ref")!.split(".");
        expect(verify(null, Buffer.from(version + "." + payload), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(decoded.slice(0, 7)).toEqual([
          destination.hostname, account, folder, replies[index].uid, uidValidity, replies[index].messageId, "show",
        ]);
        expect(decoded[9] - decoded[8]).toBe(120);
      }
      expect(observations - afterConfirm).toBe(2);
      stale = true;
      const invalidated = await reader.request(origin + open(applicationId, first.id));
      expect(invalidated.status).toBe(503);
      expect(invalidated.headers.get("location")).toBeNull();
      stale = false;
      replayChallenge = true;
      const replayed = await reader.request(origin + open(applicationId, second.id));
      expect(replayed.status).toBe(503);
      expect(replayed.headers.get("location")).toBeNull();
      replayChallenge = false;
      expect((await confirm("<missing@example.test>")).status).toBe(503);
      duplicate = true;
      expect((await confirm(replies[0].messageId, siblingId)).status).toBe(503);
      duplicate = false;
      expect(await prisma.jobEvent.count({ where: { ownerId, applicationId, kind: "roundcube_reply_confirmed" } })).toBe(2);
      expect(await prisma.jobEvent.count({ where: { ownerId, applicationId: siblingId } })).toBe(0);

      const sameTime = new Date("2026-11-17T17:00:00.000Z");
      const fixtures = Array.from({ length: 41 }, (_, index) => {
        const messageId = `<paged-${index}@example.test>`;
        return { ownerId, applicationId: siblingId, id: randomUUID(), occurredAt: sameTime,
          kind: "roundcube_reply_confirmed",
          eventKey: "roundcube-reply:" + createHash("sha256").update(JSON.stringify([account, folder, messageId])).digest("hex"),
          payload: { account, folder, messageId, uidValidity, uid: 100 + index } };
      });
      await prisma.jobEvent.createMany({ data: fixtures });
      const expected = fixtures.map(reply => reply.id).sort().reverse();
      const readPage = async (before: string) => {
        const response = await reader.request(origin + base(siblingId) + "?before=" + before);
        expect(response.status).toBe(200);
        return await response.json() as { replies: { id: string; confirmedAt: string }[]; before: string | null };
      };
      const beforePaging = rawQueries, beforePagingObservations = observations;
      const paged = jobLifecycleOutput.parse(await (await reader.request(origin + lifecycle.replace(applicationId, siblingId))).json());
      expect(paged.canConfirmOriginalReply).toBe(false);
      expect(paged.verifiedOriginalReplies?.map(reply => reply.id)).toEqual(expected.slice(0, 20));
      const older = await readPage(paged.verifiedOriginalRepliesBefore!);
      expect(older.replies.map(reply => reply.id)).toEqual(expected.slice(20, 40));
      const oldest = await readPage(older.before!);
      expect(oldest).toEqual({ replies: [{ id: expected[40], confirmedAt: sameTime.toISOString() }], before: null });
      expect(rawQueries - beforePaging).toBe(3);
      expect(observations).toBe(beforePagingObservations);
      expect(await readPage(first.id)).toEqual({ replies: [], before: null });
      console.info(`Reply fixture: two replies in one availability query, ${detailMs.toFixed(1)} ms detail; fresh redirects ${issueTimes.join("/")} ms.`);
    } finally {
      if (worker.listening) await new Promise<void>(resolve => worker.close(() => resolve()));
      try {
        await prisma.jobApplication.deleteMany({ where: { ownerId: { in: [ownerId, otherOwnerId] } } });
      } finally {
        await Promise.all([prisma.$disconnect(), rm(directory, { recursive: true, force: true })]);
      }
    }
  },
  20_000,
);
