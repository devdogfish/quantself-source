import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { hashJobWorkToken } from "./jobs-private-pause";

export const jobsRunnerKeyPattern = /^qs_runner_[A-Za-z0-9_-]{43}$/;

export async function issueJobsRunnerKey(db: Pick<PrismaClient, "jobRunner">, ownerId: string) {
  const key = `qs_runner_${randomBytes(32).toString("base64url")}`;
  const pairedKeyHash = hashJobWorkToken(key);
  await db.jobRunner.upsert({
    where: { ownerId },
    create: { ownerId, pairedKeyHash },
    update: { pairedKeyHash },
    select: { ownerId: true },
  });
  return { key };
}

export async function matchesJobsRunnerKey(db: Pick<PrismaClient, "jobRunner">, ownerId: string, key: string) {
  const runner = await db.jobRunner.findUnique({
    where: { ownerId, pairedKeyHash: hashJobWorkToken(key) },
    select: { ownerId: true },
  });
  return runner !== null;
}
