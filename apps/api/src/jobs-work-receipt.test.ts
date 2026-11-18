import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { hashJobWorkToken } from "./jobs-private-pause";
import { jobsWorkerPath } from "./jobs-work-contract";
import { registerJobsWorkerRoutes } from "./jobs-work-route";

test.each([
  ["SES receipt with an ID replays", "ses", "fixture-ses-id", 200],
  ["SES receipt requires an ID", "ses", undefined, 409],
  ["browser receipt rejects an SES ID", undefined, "fixture-ses-id", 409],
  ["browser receipt without an ID replays", undefined, undefined, 200],
] as const)("%s", async (_name, channel, sesMessageId, status) => {
  const app = new OpenAPIHono();
  const ownerId = "fixture-owner", applicationId = randomUUID(), workId = randomUUID();
  const runner = "fixture-runner".repeat(3), leaseToken = "fixture-lease-token";
  const capturedAt = "2026-11-14T19:00:00Z";
  const receipt: { code: "confirmation_message"; capturedAt: string; sesMessageId?: string } = {
    code: "confirmation_message", capturedAt, ...(sesMessageId && { sesMessageId }),
  };
  const application = { ownerId, id: applicationId, status: "submitting", revision: 2, approvedRevision: 2 };
  const work = {
    ownerId, applicationId, id: workId, kind: "submit", revision: 2, state: "claimed", attempts: 1, application,
    leaseUntil: new Date("2026-11-14T19:01:00Z"), leaseTokenHash: hashJobWorkToken(leaseToken),
  };
  const receiptEvents: unknown[] = [];
  let savedCommand: Record<string, unknown> | null = null;
  const tx = {
    $queryRaw: async () => [],
    apiIdempotencyKey: {
      findUnique: async () => savedCommand,
      create: async ({ data }: { data: Record<string, unknown> }) => { savedCommand = data; },
      update: async ({ data }: { data: Record<string, unknown> }) => { savedCommand = { ...savedCommand, ...data }; },
    },
    jobWorkItem: {
      findUnique: async () => work,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(work, data),
    },
    jobApplication: {
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(application, data),
    },
    jobEvent: {
      findFirst: async () => ({ payload: channel ? { channel } : {} }),
      create: async ({ data }: { data: unknown }) => { receiptEvents.push(data); },
    },
    trackedLink: { updateMany: async () => ({ count: 0 }) },
  };
  const db = {
    authOwner: { findUnique: async () => ({ userId: ownerId }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  registerJobsWorkerRoutes(app, { db, secrets: () => ({ codex: undefined, runner }) });
  const body = { resultId: randomUUID(), leaseToken, result: { receipt } };
  const report = (input: typeof body) => app.request(`${jobsWorkerPath}/work/${workId}/complete`, {
    method: "POST", headers: { Authorization: `Bearer ${runner}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (status !== 200) {
    expect((await report(body)).status).toBe(status);
    expect(application.status).toBe("submitting");
    expect(receiptEvents).toHaveLength(0);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await report(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
  }
  expect((await report({ ...body, result: { receipt: { ...receipt, sesMessageId: "different-ses-id" } } })).status).toBe(409);
  expect(application).toMatchObject({ status: "applied", receipt, ...(sesMessageId && { sesMessageId }) });
  expect(receiptEvents).toHaveLength(1);
  expect(receiptEvents[0]).toMatchObject({ kind: "receipt_recorded", payload: { code: receipt.code, capturedAt } });
  expect(receiptEvents[0]).not.toHaveProperty("payload.sesMessageId");
});
