import { expect, test } from "bun:test";
import { createAgentApiKey } from "@quantself/auth";
import { prisma } from "@quantself/db";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { createApp } from "./app";

test.skipIf(process.env.QUANTSELF_JOB_ADDRESS_FIXTURE !== "1")(
  "an Agent resolves exact Application Addresses and recorded SES reply evidence through the generated CLI",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" ||
      !database.port || database.pathname !== "/jobs_application_address_fixture") {
      throw Error("Use the disposable Docker database jobs_application_address_fixture.");
    }

    const owner = { id: crypto.randomUUID(), name: "Fixture Owner", email: "address-lookup@example.test" };
    const applicationId = crypto.randomUUID();
    const secondApplicationId = crypto.randomUUID();
    const registered = "luigi.k7mq@luigigirke.com";
    const secondAddress = "luigi.k7mt@luigigirke.com";
    const foreign = "luigi.k7mr@luigigirke.com";
    const unknown = "luigi.k7ms@luigigirke.com";
    const legacySesId = "0100010000000000-Fixture-Legacy-000000";
    const secondSesId = "0100010000000001-fixture-second-000000";
    const foreignSesId = "0100010000000002-fixture-foreign-000000";
    const unknownSesId = "0100010000000003-fixture-missing-000000";
    const path = "/api/v1/jobs/applications/by-address";
    const replyPath = "/api/v1/jobs/applications/resolve-reply";
    const replyToken = (id: string) => `<${id}@email.amazonses.com>`;
    const lookups: Prisma.JobApplicationFindUniqueArgs[] = [];
    const accessLogs: unknown[] = [];
    const db = prisma.$extends({ query: { jobApplication: {
      findUnique({ args, query }) {
        lookups.push(args);
        return query(args);
      },
    } } });
    const app = createApp({
      emitAccessLog(record) { accessLogs.push(record); },
      todos: { list: async () => [], detail: async () => { throw Error("Unexpected To-Do read."); } },
      jobsWorkers: { db: db as unknown as PrismaClient },
    });
    const requests: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      requests.push(request.method + " " + url.pathname + url.search);
      return app.fetch(request);
    } });

    try {
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const [reader, denied] = await Promise.all([
        createAgentApiKey({ name: "Jobs reader", userId: owner.id, permissionIds: ["jobs:read"] }),
        createAgentApiKey({ name: "To-Do reader", userId: owner.id, permissionIds: ["todos:read"] }),
      ]);
      const listing = {
        company: "Fixture company", role: "Fixture role", resumeTrack: "web" as const,
        description: "Fixture posting", resumeMarkdown: "Private fixture résumé", hasResumeMarkdown: true,
      };
      await prisma.jobApplication.createMany({ data: [
        { ...listing, ownerId: owner.id, id: applicationId, applicationAddress: registered, sesMessageId: legacySesId,
          status: "applied", receiptCode: "confirmation_message", appliedAt: new Date("2026-11-14T12:00:00Z"),
          sourceKey: "own", sourceUrl: "https://example.test/own" },
        { ...listing, ownerId: owner.id, id: secondApplicationId, applicationAddress: secondAddress, sesMessageId: secondSesId,
          sourceKey: "second", sourceUrl: "https://example.test/second" },
        { ...listing, ownerId: "another-owner", id: crypto.randomUUID(), applicationAddress: foreign, sesMessageId: foreignSesId,
          sourceKey: "foreign", sourceUrl: "https://example.test/foreign" },
      ] });

      async function runCli(command: string, body: Record<string, string>) {
        const child = Bun.spawn([
          Bun.which("bun")!, "--no-env-file", "packages/cli/src/index.ts", command, "--body", JSON.stringify(body),
        ], {
          env: { PATH: process.env.PATH, QUANTSELF_API_URL: server.url.origin, QUANTSELF_API_KEY: reader.secret },
          stdout: "pipe", stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        return JSON.parse(stdout);
      }
      const coldStarted = performance.now();
      const addressResult = await runCli("resolveJobApplicationByAddress", { address: registered });
      const coldMs = performance.now() - coldStarted;
      expect(addressResult).toEqual({ id: applicationId });
      expect(requests).toEqual(["POST " + path]);

      const find = (address: unknown, secret: string | null = reader.secret) => app.request(path, {
        method: "POST", headers: { "content-type": "application/json", ...(secret && { "x-api-key": secret }) },
        body: JSON.stringify({ address }),
      });
      const warmStarted = performance.now();
      const hit = await find(registered);
      const warmMs = performance.now() - warmStarted;
      expect(hit.status).toBe(200);
      expect(hit.headers.get("cache-control")).toBe("no-store");
      expect(await hit.json()).toEqual({ id: applicationId });

      const [unregistered, otherOwner] = await Promise.all([find(unknown), find(foreign)]);
      expect(unregistered.status).toBe(404);
      expect(otherOwner.status).toBe(404);
      expect(await otherOwner.json()).toEqual(await unregistered.json());
      expect((await find(registered, null)).status).toBe(401);
      expect((await find(registered, denied.secret)).status).toBe(403);
      expect((await find("luigi.k7m")).status).toBe(400);
      expect((await find(registered.toUpperCase())).status).toBe(400);
      expect((await find([registered, foreign])).status).toBe(400);
      expect(lookups.map(lookup => lookup.where.applicationAddress).sort()).toEqual([registered, registered, foreign, unknown].sort());
      for (const lookup of lookups) {
        expect(lookup.where.ownerId).toBe(owner.id);
        expect(lookup.select).toEqual({ id: true });
      }

      const firstReplyLookup = lookups.length;
      const replyStarted = performance.now();
      const replyResult = await runCli("resolveJobApplicationReply", { inReplyTo: replyToken(legacySesId) });
      const replyCliMs = performance.now() - replyStarted;
      expect(replyResult).toEqual({ id: applicationId });
      expect(requests).toEqual(["POST " + path, "POST " + replyPath]);

      const reply = (body: object, secret: string | null = reader.secret) => app.request(replyPath, {
        method: "POST", headers: { "content-type": "application/json", ...(secret && { "x-api-key": secret }) },
        body: JSON.stringify(body),
      });
      const matchingStarted = performance.now();
      const matching = await reply({ address: registered, inReplyTo: legacySesId });
      const matchingMs = performance.now() - matchingStarted;
      expect(matching.status).toBe(200);
      expect(matching.headers.get("cache-control")).toBe("no-store");
      expect(await matching.json()).toEqual({ id: applicationId });
      for (const input of [{ address: secondAddress }, { inReplyTo: secondSesId }]) {
        const response = await reply(input);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: secondApplicationId });
      }

      for (const input of [
        { inReplyTo: unknownSesId },
        { inReplyTo: foreignSesId },
        { address: registered, inReplyTo: secondSesId },
        { address: registered, inReplyTo: unknownSesId },
        { address: unknown, inReplyTo: legacySesId },
        { address: registered, inReplyTo: foreignSesId },
        { inReplyTo: legacySesId.toLowerCase() },
      ]) {
        const response = await reply(input);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ message: "Application not found." });
      }

      for (const inReplyTo of [
        "", "x".repeat(257), [legacySesId], null, `<${legacySesId}@example.test>`,
        `${replyToken(legacySesId)} ${replyToken(secondSesId)}`,
        `${replyToken(legacySesId)}\r\n`, `In-Reply-To: ${replyToken(legacySesId)}`,
      ]) {
        const response = await reply({ address: registered, inReplyTo });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ message: "Invalid Jobs request." });
      }
      expect((await reply({})).status).toBe(400);
      expect((await reply({ inReplyTo: legacySesId }, null)).status).toBe(401);
      expect((await reply({ inReplyTo: legacySesId }, denied.secret)).status).toBe(403);
      expect(lookups.slice(firstReplyLookup)).toEqual([
        { sesMessageId: legacySesId },
        { applicationAddress: registered, sesMessageId: legacySesId },
        { applicationAddress: secondAddress },
        { sesMessageId: secondSesId },
        { sesMessageId: unknownSesId },
        { sesMessageId: foreignSesId },
        { applicationAddress: registered, sesMessageId: secondSesId },
        { applicationAddress: registered, sesMessageId: unknownSesId },
        { applicationAddress: unknown, sesMessageId: legacySesId },
        { applicationAddress: registered, sesMessageId: foreignSesId },
        { sesMessageId: legacySesId.toLowerCase() },
      ].map(where => ({ where: { ...where, ownerId: owner.id }, select: { id: true } })));
      expect(accessLogs).toContainEqual(expect.objectContaining({ route: path, method: "POST", status: 200 }));
      expect(accessLogs).toContainEqual(expect.objectContaining({ route: replyPath, method: "POST", status: 200 }));
      const logs = JSON.stringify(accessLogs);
      for (const evidence of ["@luigigirke.com", "@email.amazonses.com", legacySesId, secondSesId, foreignSesId, unknownSesId]) {
        expect(logs).not.toContain(evidence);
      }
      console.info(`Cold CLI address lookup ${coldMs.toFixed(1)} ms. Separate CLI reply lookup ${replyCliMs.toFixed(1)} ms. Each made one HTTP request.`);
      console.info(`Warm API address lookup ${warmMs.toFixed(1)} ms. Warm API two-signal lookup ${matchingMs.toFixed(1)} ms. Each made one application query.`);
    } finally {
      server.stop(true);
      await prisma.$disconnect();
    }
  },
);
